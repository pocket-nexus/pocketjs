/*
 * The 3DS app table — see launcher.h.
 *
 * A slot's display facts (output, id, title, version) come from the `app`
 * object of its active package's plan. Reading a whole package to learn them
 * costs a full SD read and hash, so the first read writes them beside the
 * slot's state as app.txt, keyed by the package hash; later scans read that
 * file alone and fall back to the package only when the hash moved on.
 */

#include "launcher.h"

#include <3ds.h>
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "jscan.h"

#define LAUNCHER_MAX_APPS 64
#define LAUNCHER_TITLE_BYTES 96
#define LAUNCHER_VERSION_BYTES 32
#define LAUNCHER_ERROR_BYTES 256

typedef struct {
  char slot[17];
  char output[LAUNCHER_OUTPUT_BYTES];
  char id[LAUNCHER_ID_BYTES];
  char title[LAUNCHER_TITLE_BYTES];
  char version[LAUNCHER_VERSION_BYTES];
  uint64_t hash;
  uint64_t bytes;
  /* osGetTime() when an install committed it; 0 when unknown. */
  uint64_t installed;
} LauncherApp;

static LauncherApp apps[LAUNCHER_MAX_APPS];
static size_t app_count;
static bool table_dirty = true;

static char home_slot[17];
static char home_output[LAUNCHER_OUTPUT_BYTES];
static char current_slot[17];
static char current_output[LAUNCHER_OUTPUT_BYTES];
static char current_id[LAUNCHER_ID_BYTES];
static char resume_output[LAUNCHER_OUTPUT_BYTES];
static char error_output[LAUNCHER_OUTPUT_BYTES];
static char error_message[LAUNCHER_ERROR_BYTES];
static bool error_pending;

static bool request_pending;
static bool request_summon;
static LauncherTarget request;

static JsonBuffer table_json = { .limit = 32 * 1024 };

/* Read the plan's app object fields; any may be missing in old packages. */
static void read_plan(const PocketRuntimePackage *package, LauncherApp *out) {
  JsonSpan plan = json_span((const char *)package->guest.plan, package->guest.plan_length);
  JsonSpan app;
  if (!json_find(plan, "app", &app) || !json_is_object(app)) return;
  json_find_string(app, "output", out->output, sizeof out->output);
  json_find_string(app, "id", out->id, sizeof out->id);
  json_find_string(app, "title", out->title, sizeof out->title);
  json_find_string(app, "version", out->version, sizeof out->version);
}

bool launcher_package_output(const PocketRuntimePackage *package, char *out, size_t capacity) {
  LauncherApp facts;
  memset(&facts, 0, sizeof facts);
  if (package == NULL) return false;
  read_plan(package, &facts);
  if (facts.output[0] == '\0') return false;
  snprintf(out, capacity, "%s", facts.output);
  return true;
}

static void package_app_id(const PocketRuntimePackage *package, char *out, size_t capacity) {
  LauncherApp facts;
  memset(&facts, 0, sizeof facts);
  read_plan(package, &facts);
  snprintf(out, capacity, "%s", facts.id);
}

// ---------------------------------------------------------------------------
// app.txt cache
// ---------------------------------------------------------------------------

/* One `key=value` line; values never contain a newline. */
static void write_line(FILE *file, const char *key, const char *value) {
  fputs(key, file);
  fputc('=', file);
  for (const char *at = value; *at != '\0'; at += 1) {
    fputc(*at == '\n' || *at == '\r' ? ' ' : *at, file);
  }
  fputc('\n', file);
}

static void write_cache(const LauncherApp *app) {
  char path[128];
  char temporary[128];
  if (!runtime_slot_path(app->slot, "app.txt", path, sizeof path) ||
      !runtime_slot_path(app->slot, ".app.txt.tmp", temporary, sizeof temporary)) {
    return;
  }
  FILE *file = fopen(temporary, "wb");
  if (file == NULL) return;
  char number[24];
  snprintf(number, sizeof number, "%016llx", (unsigned long long)app->hash);
  write_line(file, "hash", number);
  snprintf(number, sizeof number, "%llu", (unsigned long long)app->bytes);
  write_line(file, "bytes", number);
  snprintf(number, sizeof number, "%llu", (unsigned long long)app->installed);
  write_line(file, "installed", number);
  write_line(file, "output", app->output);
  write_line(file, "id", app->id);
  write_line(file, "title", app->title);
  write_line(file, "version", app->version);
  if (fclose(file) != 0) {
    remove(temporary);
    return;
  }
  remove(path);
  rename(temporary, path);
}

static bool read_cache(LauncherApp *app, uint64_t expected_hash) {
  char path[128];
  if (!runtime_slot_path(app->slot, "app.txt", path, sizeof path)) return false;
  FILE *file = fopen(path, "rb");
  if (file == NULL) return false;
  char line[256];
  uint64_t hash = 0;
  while (fgets(line, sizeof line, file) != NULL) {
    size_t length = strlen(line);
    while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) line[--length] = '\0';
    char *value = strchr(line, '=');
    if (value == NULL) continue;
    *value++ = '\0';
    if (strcmp(line, "hash") == 0) hash = strtoull(value, NULL, 16);
    else if (strcmp(line, "bytes") == 0) app->bytes = strtoull(value, NULL, 10);
    else if (strcmp(line, "installed") == 0) app->installed = strtoull(value, NULL, 10);
    else if (strcmp(line, "output") == 0) snprintf(app->output, sizeof app->output, "%s", value);
    else if (strcmp(line, "id") == 0) snprintf(app->id, sizeof app->id, "%s", value);
    else if (strcmp(line, "title") == 0) snprintf(app->title, sizeof app->title, "%s", value);
    else if (strcmp(line, "version") == 0) snprintf(app->version, sizeof app->version, "%s", value);
  }
  fclose(file);
  return hash == expected_hash && app->output[0] != '\0';
}

static void facts_from_package(LauncherApp *app, const char *slot, const PocketRuntimePackage *package) {
  memset(app, 0, sizeof *app);
  memcpy(app->slot, slot, 17);
  app->hash = package->guest.package_hash;
  app->bytes = package->length;
  read_plan(package, app);
  if (app->title[0] == '\0') snprintf(app->title, sizeof app->title, "%s", app->output);
}

// ---------------------------------------------------------------------------
// table
// ---------------------------------------------------------------------------

static bool hex_slot_name(const char *name) {
  if (strlen(name) != 16) return false;
  for (size_t i = 0; i < 16; i += 1) {
    char c = name[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

static int compare_apps(const void *left, const void *right) {
  const LauncherApp *a = left;
  const LauncherApp *b = right;
  int order = strcasecmp(a->title, b->title);
  return order != 0 ? order : strcmp(a->output, b->output);
}

static LauncherApp *listed_output(const char *output) {
  for (size_t i = 0; i < app_count; i += 1) {
    if (strcmp(apps[i].output, output) == 0) return &apps[i];
  }
  return NULL;
}

static void rebuild_table(void) {
  app_count = 0;
  table_dirty = false;
  DIR *directory = opendir(POCKET_RUNTIME_APPS);
  if (directory == NULL) return;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL && app_count < LAUNCHER_MAX_APPS) {
    if (!hex_slot_name(entry->d_name) || strcmp(entry->d_name, home_slot) == 0) continue;
    PocketRuntimeState state;
    if (!runtime_slot_state(entry->d_name, &state) || state.active_hash == 0) continue;
    LauncherApp app;
    memset(&app, 0, sizeof app);
    memcpy(app.slot, entry->d_name, 17);
    if (!read_cache(&app, state.active_hash)) {
      char error[192] = {0};
      PocketRuntimePackage *package = runtime_slot_package_load(entry->d_name, state.active_hash, error, sizeof error);
      if (package == NULL) continue;
      facts_from_package(&app, entry->d_name, package);
      runtime_package_free(package);
      if (app.output[0] == '\0') continue;
      write_cache(&app);
    }
    app.hash = state.active_hash;
    if (strcmp(app.output, home_output) == 0) continue;
    /* Two slots claiming one output (an app id renamed between versions)
     * would make appLaunch ambiguous: the later install wins. */
    LauncherApp *existing = listed_output(app.output);
    if (existing != NULL) {
      if (app.installed > existing->installed) *existing = app;
      continue;
    }
    apps[app_count++] = app;
  }
  closedir(directory);
  qsort(apps, app_count, sizeof apps[0], compare_apps);
}

static const LauncherApp *find_output(const char *output) {
  if (table_dirty) rebuild_table();
  for (size_t i = 0; i < app_count; i += 1) {
    if (strcmp(apps[i].output, output) == 0) return &apps[i];
  }
  return NULL;
}

void launcher_init(const PocketRuntimePackage *embedded) {
  memcpy(home_slot, embedded->guest.slot, sizeof home_slot);
  if (!launcher_package_output(embedded, home_output, sizeof home_output)) home_output[0] = '\0';
  table_dirty = true;
}

void launcher_invalidate(void) {
  table_dirty = true;
}

const char *launcher_table_json(void) {
  if (table_dirty) rebuild_table();
  JsonBuffer *out = &table_json;
  jbuf_reset(out);
  jbuf_text(out, "{\"apps\":[");
  for (size_t i = 0; i < app_count; i += 1) {
    const LauncherApp *app = &apps[i];
    if (i > 0) jbuf_text(out, ",");
    jbuf_text(out, "{\"output\":");
    jbuf_cstring(out, app->output);
    jbuf_text(out, ",\"id\":");
    jbuf_cstring(out, app->id);
    jbuf_text(out, ",\"title\":");
    jbuf_cstring(out, app->title);
    jbuf_text(out, ",\"version\":");
    jbuf_cstring(out, app->version);
    jbuf_text(out, ",\"bytes\":");
    jbuf_u64(out, app->bytes);
    jbuf_text(out, "}");
  }
  jbuf_text(out, "],\"current\":");
  jbuf_cstring(out, current_output);
  jbuf_text(out, ",\"resume\":");
  if (resume_output[0] != '\0') jbuf_cstring(out, resume_output);
  else jbuf_text(out, "null");
  jbuf_text(out, ",\"launcher\":");
  jbuf_cstring(out, home_output);
  jbuf_text(out, ",\"lastError\":");
  if (error_pending) {
    jbuf_text(out, "{\"output\":");
    jbuf_cstring(out, error_output);
    jbuf_text(out, ",\"message\":");
    jbuf_cstring(out, error_message);
    jbuf_text(out, "}");
    error_pending = false;
  } else {
    jbuf_text(out, "null");
  }
  jbuf_text(out, "}");
  const char *text = jbuf_cstr(out);
  return text == NULL ? "{\"apps\":[],\"current\":\"\",\"resume\":null,\"launcher\":\"\",\"lastError\":null}" : text;
}

bool launcher_launch(const char *output) {
  if (output == NULL || output[0] == '\0') return false;
  if (strcmp(output, home_output) == 0) {
    memset(&request, 0, sizeof request);
    memcpy(request.slot, home_slot, sizeof request.slot);
    snprintf(request.output, sizeof request.output, "%s", home_output);
    request.home = true;
  } else {
    const LauncherApp *app = find_output(output);
    if (app == NULL) return false;
    memset(&request, 0, sizeof request);
    memcpy(request.slot, app->slot, sizeof request.slot);
    snprintf(request.output, sizeof request.output, "%s", app->output);
    request.home = false;
  }
  request_pending = true;
  request_summon = false;
  return true;
}

void launcher_summon(void) {
  if (launcher_home_running()) return;
  memset(&request, 0, sizeof request);
  memcpy(request.slot, home_slot, sizeof request.slot);
  snprintf(request.output, sizeof request.output, "%s", home_output);
  request.home = true;
  request_pending = true;
  request_summon = true;
}

bool launcher_take_request(LauncherTarget *out) {
  if (!request_pending) return false;
  request_pending = false;
  *out = request;
  if (request_summon) snprintf(resume_output, sizeof resume_output, "%s", current_output);
  else resume_output[0] = '\0';
  /* A new launch starts a new story: an unread failure is dropped. */
  if (!request_summon) error_pending = false;
  request_summon = false;
  return true;
}

void launcher_set_current(const char *slot, const PocketRuntimePackage *package) {
  snprintf(current_slot, sizeof current_slot, "%s", slot == NULL ? "" : slot);
  current_output[0] = '\0';
  current_id[0] = '\0';
  if (package != NULL) {
    if (!launcher_package_output(package, current_output, sizeof current_output)) current_output[0] = '\0';
    package_app_id(package, current_id, sizeof current_id);
  }
  if (launcher_home_running() && current_output[0] == '\0') {
    snprintf(current_output, sizeof current_output, "%s", home_output);
  }
}

bool launcher_home_running(void) {
  return current_slot[0] == '\0' || strcmp(current_slot, home_slot) == 0;
}

const char *launcher_home_slot(void) {
  return home_slot;
}

const char *launcher_current_output(void) {
  return current_output;
}

const char *launcher_current_app_id(void) {
  return current_id;
}

void launcher_report_failure(const char *output, const char *message) {
  snprintf(error_output, sizeof error_output, "%s", output == NULL ? "" : output);
  snprintf(error_message, sizeof error_message, "%s", message == NULL ? "unknown failure" : message);
  error_pending = true;
}

void launcher_note_installed(const char *slot, const PocketRuntimePackage *package) {
  if (slot != NULL && package != NULL) {
    LauncherApp app;
    facts_from_package(&app, slot, package);
    app.installed = osGetTime();
    if (app.output[0] != '\0') write_cache(&app);
  }
  table_dirty = true;
}
