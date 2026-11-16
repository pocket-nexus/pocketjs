/*
 * `globalThis.link` on Pocket Link 2: see link2_guest.h. The client
 * (link2.c) owns the connection, the request ids and the paging; this file
 * owns what the guest sees, where an install's bytes go, and which removals
 * it refuses, for the guest and for Hub's runtime.remove alike.
 */

#include "link2_guest.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "host_services.h"
#include "jscan.h"
#include "launcher.h"
#include "sha256.h"

#define GUEST_INSTALLS 4u
#define GUEST_CATALOG_WAITERS 4u
#define GUEST_PROGRESS_MS 200u
/* A catalog request's id comes from a range the client's request ids (1 and
 * up, in order) do not reach, so an `error` event names one request. */
#define GUEST_CATALOG_ID_BASE 0x40000000

typedef struct {
  uint32_t request;
  /* Events reach the guest that asked; a guest switch clears this. */
  bool guest;
  bool head;
  char app[LAUNCHER_ID_BYTES];
  char slot[17];
  char path[128];
  FILE *file;
  uint64_t hash;
  uint32_t expected;
  uint32_t received;
  uint64_t progress_ms;
  /* The last byte arrived and the slot's folders do not exist yet: they are
   * made off the main thread (link_host_slot_ready), after the transfer so
   * no staging write waits behind them, and the install finishes at a later
   * pump (link2_guest_service). */
  bool finish_due;
} GuestInstall;

typedef struct {
  int32_t id;
  /* Fetches that have to end before this request is answered: 2 when one
   * was running at the call, whose rows may predate it. */
  uint8_t waits;
} CatalogWaiter;

static Link2 *bound;
static GuestInstall installs[GUEST_INSTALLS];
static CatalogWaiter waiters[GUEST_CATALOG_WAITERS];
static int32_t next_catalog_id = GUEST_CATALOG_ID_BASE;
static bool fetching;
static bool rows_failed;
static JsonBuffer rows = { .limit = 64u * 1024u };
static JsonBuffer events = { .limit = 96u * 1024u };
static JsonBuffer poll_out = { .limit = 100u * 1024u };
static JsonBuffer status_out = { .limit = 8u * 1024u };

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

static void event_begin(void) {
  if (events.length > 0) jbuf_text(&events, ",");
}

/* An event that did not fit is dropped whole, never torn. */
static void event_end(size_t mark) {
  if (events.failed) {
    events.failed = false;
    events.length = mark;
    if (events.data != NULL) events.data[mark] = '\0';
  }
}

static void error_event(uint32_t id, const char *message) {
  size_t mark = events.length;
  event_begin();
  jbuf_text(&events, "{\"t\":\"error\",\"id\":");
  jbuf_u64(&events, id);
  jbuf_text(&events, ",\"message\":");
  jbuf_cstring(&events, message);
  jbuf_text(&events, "}");
  event_end(mark);
}

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

static void on_catalog_page(void *context, const char *page, size_t length, bool first) {
  (void)context;
  if (first) {
    jbuf_reset(&rows);
    rows_failed = false;
  }
  /* `page` is one JSON array: its rows join the ones held. */
  while (length > 0 && (page[0] == ' ' || page[0] == '\n' || page[0] == '\t' || page[0] == '\r')) {
    page += 1;
    length -= 1;
  }
  while (length > 0 && (page[length - 1] == ' ' || page[length - 1] == '\n' || page[length - 1] == '\t' || page[length - 1] == '\r')) length -= 1;
  if (length < 2 || page[0] != '[' || page[length - 1] != ']') {
    rows_failed = true;
    return;
  }
  if (length == 2) return;
  if (rows.length > 0) jbuf_text(&rows, ",");
  jbuf_raw(&rows, page + 1, length - 2);
  if (rows.failed) rows_failed = true;
}

static void on_catalog_done(void *context, const char *error) {
  (void)context;
  bool more = false;
  for (size_t i = 0; i < GUEST_CATALOG_WAITERS; i += 1) {
    CatalogWaiter *waiter = &waiters[i];
    if (waiter->id == 0) continue;
    if (waiter->waits > 1 && (error == NULL || strcmp(error, "closed") != 0)) {
      /* The fetch that ended began before this request, whether it gave rows
       * or failed: the client starts the next one now, and that one answers
       * it. `fetching` stays set, so a call during that fetch waits for one
       * of its own. Only a link that dropped ends them all: no fetch follows. */
      waiter->waits -= 1;
      more = true;
      continue;
    }
    if (error != NULL || rows_failed) {
      char message[96];
      snprintf(message, sizeof message, "catalog: %s", error != NULL ? error : "the offer does not fit");
      error_event((uint32_t)waiter->id, message);
    } else {
      size_t mark = events.length;
      event_begin();
      jbuf_text(&events, "{\"t\":\"catalog\",\"id\":");
      jbuf_u64(&events, (uint32_t)waiter->id);
      jbuf_text(&events, ",\"apps\":[");
      if (rows.length > 0) jbuf_raw(&events, rows.data, rows.length);
      jbuf_text(&events, "]}");
      event_end(mark);
    }
    waiter->id = 0;
  }
  /* The client starts the fetch a call asked for while this one ran. */
  fetching = more;
}

static void on_catalog_changed(void *context) {
  (void)context;
  size_t mark = events.length;
  event_begin();
  jbuf_text(&events, "{\"t\":\"catalog.changed\"}");
  event_end(mark);
}

int32_t link2_guest_catalog(void) {
  if (bound == NULL || !link2_linked(bound)) return -1;
  CatalogWaiter *waiter = NULL;
  for (size_t i = 0; i < GUEST_CATALOG_WAITERS && waiter == NULL; i += 1) {
    if (waiters[i].id == 0) waiter = &waiters[i];
  }
  if (waiter == NULL || !link2_catalog(bound)) return -1;
  waiter->id = next_catalog_id;
  waiter->waits = fetching ? 2 : 1;
  fetching = true;
  next_catalog_id = next_catalog_id == INT32_MAX ? GUEST_CATALOG_ID_BASE : next_catalog_id + 1;
  return waiter->id;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

static GuestInstall *find_install(uint32_t request) {
  for (size_t i = 0; i < GUEST_INSTALLS; i += 1) {
    if (installs[i].request == request && request != 0) return &installs[i];
  }
  return NULL;
}

static void free_install(GuestInstall *install, bool remove_staging) {
  if (install->file != NULL) fclose(install->file);
  if (remove_staging && install->path[0] != '\0') remove(install->path);
  memset(install, 0, sizeof *install);
}

static void install_failed(GuestInstall *install, const char *message, bool remove_staging) {
  if (install->guest) error_event(install->request, message);
  free_install(install, remove_staging);
}

static void install_progress(GuestInstall *install, bool force) {
  uint64_t now = services_host_ms();
  if (!install->guest || (!force && now - install->progress_ms < GUEST_PROGRESS_MS)) return;
  install->progress_ms = now;
  size_t mark = events.length;
  event_begin();
  jbuf_text(&events, "{\"t\":\"install.progress\",\"id\":");
  jbuf_u64(&events, install->request);
  jbuf_text(&events, ",\"app\":");
  jbuf_cstring(&events, install->app);
  jbuf_text(&events, ",\"received\":");
  jbuf_u64(&events, install->received);
  jbuf_text(&events, ",\"bytes\":");
  jbuf_u64(&events, install->expected);
  jbuf_text(&events, "}");
  event_end(mark);
}

static bool on_install_begin(void *context, uint32_t request, const char *app, const char *hash, uint32_t bytes) {
  (void)context;
  GuestInstall *install = find_install(request);
  uint8_t hash_bytes[8];
  if (install == NULL || install->head) return false;
  if (strcmp(app, install->app) != 0 || strlen(hash) != 16 || !hex_decode(hash, 16, hash_bytes, sizeof hash_bytes) || bytes == 0) {
    install_failed(install, "install: malformed head", false);
    return false;
  }
  install->hash = 0;
  for (size_t i = 0; i < 8; i += 1) install->hash = (install->hash << 8) | hash_bytes[i];
  if (!link_host_staging_path(install->slot, install->path, sizeof install->path)) {
    install->path[0] = '\0';
    install_failed(install, "install: bad slot", false);
    return false;
  }
  install->file = fopen(install->path, "wb");
  if (install->file == NULL) {
    install_failed(install, "install: cannot open the staging file", false);
    return false;
  }
  install->head = true;
  install->expected = bytes;
  install->received = 0;
  install->progress_ms = 0;
  return true;
}

static bool on_install_data(void *context, uint32_t request, const uint8_t *bytes, size_t length) {
  (void)context;
  GuestInstall *install = find_install(request);
  if (install == NULL || install->file == NULL) return false;
  if (length > install->expected - install->received) {
    install_failed(install, "install: stream overran its declared length", true);
    return false;
  }
  if (length > 0 && fwrite(bytes, 1, length, install->file) != length) {
    install_failed(install, "install: storage write failed", true);
    return false;
  }
  install->received += (uint32_t)length;
  if (install->received < install->expected) install_progress(install, false);
  return true;
}

/* The last byte arrived: flush, admit, commit, refresh the app table. This is
 * the one step that reads the whole package back (link_host_install verifies
 * its footer and admits it), so it costs one frame per install. */
static void finish_install(GuestInstall *install) {
  bool written = install->received == install->expected && fflush(install->file) == 0 && fsync(fileno(install->file)) == 0;
  if (fclose(install->file) != 0) written = false;
  install->file = NULL;
  if (!written) {
    install_failed(install, "install: storage write failed", true);
    return;
  }
  install_progress(install, true);
  char error[256] = {0};
  LauncherPackage package;
  void *held = NULL;
  if (!link_host_install(install->slot, install->path, install->hash, &package, &held, error, sizeof error)) {
    install_failed(install, error, true);
    return;
  }
  launcher_note_installed(install->slot, &package);
  char output[LAUNCHER_OUTPUT_BYTES] = {0};
  launcher_package_output(&package, output, sizeof output);
  services_host_release(held);
  if (bound != NULL) link2_apps_changed(bound);
  if (install->guest) {
    char hash[17];
    snprintf(hash, sizeof hash, "%016llx", (unsigned long long)install->hash);
    size_t mark = events.length;
    event_begin();
    jbuf_text(&events, "{\"t\":\"install.done\",\"id\":");
    jbuf_u64(&events, install->request);
    jbuf_text(&events, ",\"app\":");
    jbuf_cstring(&events, install->app);
    jbuf_text(&events, ",\"output\":");
    jbuf_cstring(&events, output);
    jbuf_text(&events, ",\"hash\":\"");
    jbuf_text(&events, hash);
    jbuf_text(&events, "\"}");
    event_end(mark);
  }
  /* The staging file was renamed into packages/; nothing to remove. */
  install->path[0] = '\0';
  free_install(install, false);
}

static void on_install_end(void *context, uint32_t request, const char *error) {
  (void)context;
  GuestInstall *install = find_install(request);
  if (install == NULL) return;
  if (error != NULL) {
    char message[96];
    snprintf(message, sizeof message, "install: %s", error);
    install_failed(install, message, true);
  } else if (install->file == NULL) {
    install_failed(install, "install: no package arrived", true);
  } else if (!link_host_slot_ready(install->slot)) {
    install->finish_due = true;
  } else {
    finish_install(install);
  }
}

void link2_guest_service(void) {
  for (size_t i = 0; i < GUEST_INSTALLS; i += 1) {
    GuestInstall *install = &installs[i];
    if (install->request == 0 || !install->finish_due || !link_host_slot_ready(install->slot)) continue;
    install->finish_due = false;
    finish_install(install);
  }
}

int32_t link2_guest_install(const char *app_id, size_t length) {
  if (bound == NULL || app_id == NULL || length == 0 || length >= LAUNCHER_ID_BYTES || memchr(app_id, 0, length) != NULL) return -1;
  char slot[17];
  char app[LAUNCHER_ID_BYTES];
  GuestInstall *install = NULL;
  sha256_slot(app_id, length, slot);
  for (size_t i = 0; i < GUEST_INSTALLS; i += 1) {
    if (installs[i].request != 0 && strcmp(installs[i].slot, slot) == 0) return -1;
    if (installs[i].request == 0 && install == NULL) install = &installs[i];
  }
  if (install == NULL) return -1;
  memcpy(app, app_id, length);
  app[length] = '\0';
  uint32_t request = link2_install(bound, app);
  if (request == 0 || request > INT32_MAX) return -1;
  memset(install, 0, sizeof *install);
  install->request = request;
  install->guest = true;
  memcpy(install->app, app, length + 1);
  memcpy(install->slot, slot, sizeof install->slot);
  return (int32_t)request;
}

/* A package's slot is the hash of its manifest id (sha256_slot; the slot
 * install refuses a package whose id names another slot), so the checks below
 * compare slots. The launcher is not a row of its own table: its slot is
 * checked first. Whether the id is installed is read from the table, the set
 * runtime.apps reports, so an id Hub never saw is `not_found` and a failed
 * delete is `storage`. */
Link2RemoveOutcome link2_guest_remove_app(const char *app_id, size_t length) {
  if (app_id == NULL || length == 0 || length >= LAUNCHER_ID_BYTES || memchr(app_id, 0, length) != NULL) return LINK2_REMOVE_NOT_FOUND;
  char slot[17];
  sha256_slot(app_id, length, slot);
  if (strcmp(slot, launcher_home_slot()) == 0) return LINK2_REMOVE_HOME;
  if (strcmp(slot, launcher_current_slot()) == 0) return LINK2_REMOVE_RUNNING;
  bool listed = false;
  LauncherRow row;
  for (size_t index = 0; !listed && launcher_row(index, &row); index += 1) listed = strcmp(row.slot, slot) == 0;
  if (!listed) return LINK2_REMOVE_NOT_FOUND;
  for (size_t i = 0; i < GUEST_INSTALLS; i += 1) {
    if (installs[i].request != 0 && strcmp(installs[i].slot, slot) == 0) return LINK2_REMOVE_INSTALLING;
  }
  bool removed = link_host_remove(slot);
  launcher_invalidate();
  if (removed && bound != NULL) link2_apps_changed(bound);
  return removed ? LINK2_REMOVED : LINK2_REMOVE_STORAGE;
}

bool link2_guest_remove(const char *app_id, size_t length) {
  return link2_guest_remove_app(app_id, length) == LINK2_REMOVED;
}

/* Hub's runtime.remove (§6.2): the outcome as the error the request answers. */
static bool on_remove(void *context, const char *id, Link2Failure *failure) {
  (void)context;
  const char *code = "storage";
  const char *message = "the applet's slot could not be deleted";
  const char *members = "";
  switch (link2_guest_remove_app(id, strlen(id))) {
    case LINK2_REMOVED:
      return true;
    case LINK2_REMOVE_HOME:
      code = "rejected";
      message = "the launcher is never removed";
      members = "\"reason\":\"home\"";
      break;
    case LINK2_REMOVE_RUNNING:
      code = "rejected";
      message = "the applet is running; switch to another one first";
      members = "\"reason\":\"running\"";
      break;
    case LINK2_REMOVE_NOT_FOUND:
      code = "not_found";
      message = "no installed applet has this id";
      break;
    case LINK2_REMOVE_INSTALLING:
      code = "busy";
      message = "an install of this applet is under way";
      break;
    case LINK2_REMOVE_STORAGE:
      break;
  }
  snprintf(failure->code, sizeof failure->code, "%s", code);
  snprintf(failure->message, sizeof failure->message, "%s", message);
  snprintf(failure->members, sizeof failure->members, "%s", members);
  return false;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

static const char *const GROUPS[] = {
  "apps", "runtime", "runtime.native", "runtime.remove", "devtools", "catalog", "install", "net.http", "agent", "channel",
};

/* The client's phase as a LinkStatus state. */
static const char *state_name(const char *phase, size_t paired) {
  if (strcmp(phase, "linked") == 0) return "linked";
  if (paired == 0) return "unpaired";
  if (strcmp(phase, "connecting") == 0 || strcmp(phase, "handshake") == 0) return "connecting";
  return "searching";
}

typedef struct {
  char phase[16];
  char hub_id[LINK2_ID_HEX + 1];
  char hub_name[LINK2_NAME_BYTES * 2 + 1];
  char error[96];
  JsonSpan paired;
  size_t paired_count;
  bool known;
} ClientStatus;

/* Reads the client's own status object into `raw`, whose bytes `out` points into. */
static void client_status(char *raw, size_t capacity, ClientStatus *out) {
  memset(out, 0, sizeof *out);
  snprintf(out->phase, sizeof out->phase, "idle");
  if (bound == NULL) return;
  Link2Json writer;
  link2_json_init(&writer, raw, capacity);
  link2_status_json(bound, &writer);
  if (writer.failed) return;
  JsonSpan object = json_span(raw, writer.length), hub, element;
  json_find_string(object, "phase", out->phase, sizeof out->phase);
  json_find_string(object, "error", out->error, sizeof out->error);
  if (json_find(object, "hub", &hub) && json_is_object(hub)) {
    json_find_string(hub, "id", out->hub_id, sizeof out->hub_id);
    json_find_string(hub, "name", out->hub_name, sizeof out->hub_name);
  }
  if (json_find(object, "paired", &out->paired) && json_is_array(out->paired)) {
    size_t at = 0;
    bool malformed = false;
    while (link2_array_next(out->paired, &at, &element, &malformed)) out->paired_count += 1;
    out->known = !malformed;
  }
}

const char *link2_guest_status_json(void) {
  if (bound == NULL) {
    return "{\"state\":\"unpaired\",\"companion\":null,\"paired\":[],"
           "\"device\":{\"id\":\"\",\"name\":\"\",\"model\":\"\",\"address\":\"\"},"
           "\"pairing\":\"idle\",\"error\":\"this build has no Pocket Link\",\"features\":[]}";
  }
  static char raw[2048];
  ClientStatus client;
  client_status(raw, sizeof raw, &client);
  bool linked = strcmp(client.phase, "linked") == 0;
  JsonBuffer *out = &status_out;
  jbuf_reset(out);
  jbuf_text(out, "{\"state\":\"");
  jbuf_text(out, state_name(client.phase, client.paired_count));
  jbuf_text(out, "\",\"companion\":");
  bool wrote = false;
  if (linked && client.known) {
    /* The linked Hub's row of `paired` carries its address and port. */
    JsonSpan element;
    size_t at = 0;
    bool malformed = false;
    while (!wrote && link2_array_next(client.paired, &at, &element, &malformed)) {
      char id[LINK2_ID_HEX + 1] = "";
      char address[16] = "";
      uint64_t port = 0;
      if (!json_find_string(element, "id", id, sizeof id) || strcmp(id, client.hub_id) != 0) continue;
      json_find_string(element, "address", address, sizeof address);
      json_find_u64(element, "port", &port);
      jbuf_text(out, "{\"id\":");
      jbuf_cstring(out, id);
      jbuf_text(out, ",\"name\":");
      jbuf_cstring(out, client.hub_name);
      jbuf_text(out, ",\"address\":");
      jbuf_cstring(out, address);
      jbuf_text(out, ",\"port\":");
      jbuf_u64(out, port);
      jbuf_text(out, "}");
      wrote = true;
    }
  }
  if (!wrote) jbuf_text(out, "null");
  jbuf_text(out, ",\"paired\":");
  if (client.known) jbuf_raw(out, client.paired.start, client.paired.length);
  else jbuf_text(out, "[]");
  char name[LINK2_NAME_BYTES] = "";
  char model[32] = "";
  char address[16] = "";
  link_host_identity(name, sizeof name, model, sizeof model);
  link_host_address(address, sizeof address);
  jbuf_text(out, ",\"device\":{\"id\":");
  jbuf_cstring(out, link2_device_id(bound));
  jbuf_text(out, ",\"name\":");
  jbuf_cstring(out, name);
  jbuf_text(out, ",\"model\":");
  jbuf_cstring(out, model);
  jbuf_text(out, ",\"address\":");
  jbuf_cstring(out, address);
  jbuf_text(out, "},\"pairing\":\"idle\",\"error\":");
  jbuf_cstring(out, client.error);
  jbuf_text(out, ",\"features\":[");
  bool first = true;
  for (size_t i = 0; linked && i < sizeof GROUPS / sizeof GROUPS[0]; i += 1) {
    if (!link2_in_use(bound, GROUPS[i])) continue;
    if (!first) jbuf_text(out, ",");
    jbuf_cstring(out, GROUPS[i]);
    first = false;
  }
  jbuf_text(out, "],\"clock\":");
  int64_t utc = 0;
  int32_t offset_min = 0;
  if (link2_clock(bound, &utc, &offset_min)) {
    jbuf_text(out, "{\"utc\":");
    jbuf_i64(out, utc);
    jbuf_text(out, ",\"offsetMinutes\":");
    jbuf_i64(out, offset_min);
    jbuf_text(out, "}");
  } else {
    jbuf_text(out, "null");
  }
  /* Pairing by a code (§3.11): the code to show and the Hubs to ask. */
  static const char *const PAIR_STATES[] = {"idle", "open", "asking", "paired", "failed"};
  static Link2PairStatus pair;
  link2_pair_status(bound, &pair);
  jbuf_text(out, ",\"pair\":{\"state\":");
  jbuf_cstring(out, PAIR_STATES[pair.state]);
  jbuf_text(out, ",\"code\":");
  jbuf_cstring(out, pair.code);
  jbuf_text(out, ",\"leftMs\":");
  jbuf_u64(out, pair.left_ms);
  jbuf_text(out, ",\"tries\":");
  jbuf_u64(out, pair.tries);
  jbuf_text(out, ",\"hub\":");
  jbuf_cstring(out, pair.hub);
  jbuf_text(out, ",\"hubName\":");
  jbuf_cstring(out, pair.hub_name);
  jbuf_text(out, ",\"error\":");
  jbuf_cstring(out, pair.error);
  jbuf_text(out, ",\"hubs\":[");
  for (size_t i = 0; i < pair.hub_count; i += 1) {
    if (i > 0) jbuf_text(out, ",");
    jbuf_text(out, "{\"id\":");
    jbuf_cstring(out, pair.hubs[i].id);
    jbuf_text(out, ",\"name\":");
    jbuf_cstring(out, pair.hubs[i].name);
    jbuf_text(out, "}");
  }
  jbuf_text(out, "]}");
  /* Host diagnostics beyond LinkStatus. */
  const Link2Stats *stats = link2_stats(bound);
  jbuf_text(out, ",\"limit\":");
  jbuf_u64(out, link2_limit(bound));
  jbuf_text(out, ",\"rttMs\":");
  jbuf_u64(out, stats->rtt_ms);
  jbuf_text(out, ",\"links\":");
  jbuf_u64(out, stats->links);
  jbuf_text(out, ",\"stats\":{\"txPeak\":");
  jbuf_u64(out, stats->tx_peak);
  jbuf_text(out, ",\"readPauses\":");
  jbuf_u64(out, stats->read_pauses);
  jbuf_text(out, ",\"lateEvents\":");
  jbuf_u64(out, stats->late_events);
  jbuf_text(out, ",\"logsDropped\":");
  jbuf_u64(out, stats->logs_dropped);
  jbuf_text(out, ",\"fixedBytes\":");
  jbuf_u64(out, stats->fixed_bytes);
  jbuf_text(out, ",\"channelBytes\":");
  jbuf_u64(out, stats->channel_bytes);
  jbuf_text(out, ",\"channelPeak\":");
  jbuf_u64(out, stats->channel_peak);
  jbuf_text(out, "}}");
  const char *text = jbuf_cstr(out);
  return text == NULL ? "{\"state\":\"unpaired\",\"error\":\"link: status overflow\"}" : text;
}

void link2_guest_describe(char *out, size_t capacity) {
  if (bound == NULL) {
    snprintf(out, capacity, "NO LINK");
    return;
  }
  char raw[2048];
  ClientStatus client;
  client_status(raw, sizeof raw, &client);
  const char *state = state_name(client.phase, client.paired_count);
  if (strcmp(state, "linked") == 0) snprintf(out, capacity, "LINKED %s", client.hub_name);
  else if (strcmp(state, "connecting") == 0) snprintf(out, capacity, "CONNECTING");
  else if (strcmp(state, "searching") == 0) snprintf(out, capacity, "SEARCHING %u PAIRED", (unsigned)client.paired_count);
  else snprintf(out, capacity, "NOT PAIRED");
}

bool link2_guest_pair_open(void) {
  return bound != NULL && link2_pair_open(bound);
}

bool link2_guest_pair_ask(const char *hub) {
  return bound != NULL && hub != NULL && link2_pair_ask(bound, hub);
}

void link2_guest_pair_close(void) {
  if (bound != NULL) link2_pair_close(bound);
}

bool link2_guest_forget(const char *companion) {
  return bound != NULL && companion != NULL && link2_forget(bound, companion);
}

// ---------------------------------------------------------------------------
// poll, lifecycle
// ---------------------------------------------------------------------------

const char *link2_guest_poll(void) {
  if (events.length == 0) return NULL;
  jbuf_reset(&poll_out);
  jbuf_text(&poll_out, "[");
  jbuf_raw(&poll_out, events.data, events.length);
  jbuf_text(&poll_out, "]");
  jbuf_reset(&events);
  return jbuf_cstr(&poll_out);
}

void link2_guest_host(Link2Host *host) {
  host->catalog_page = on_catalog_page;
  host->catalog_done = on_catalog_done;
  host->catalog_changed = on_catalog_changed;
  host->install_begin = on_install_begin;
  host->install_data = on_install_data;
  host->install_end = on_install_end;
  host->remove = on_remove;
}

void link2_guest_bind(Link2 *link) {
  bound = link;
}

void link2_guest_reset(void) {
  /* A catalog fetch that is under way ends at the client; its result has no
   * guest to go to. */
  memset(waiters, 0, sizeof waiters);
  for (size_t i = 0; i < GUEST_INSTALLS; i += 1) {
    /* An install keeps streaming into storage; only its events stop. */
    if (installs[i].request != 0) installs[i].guest = false;
  }
  jbuf_reset(&events);
}

void link2_guest_shutdown(void) {
  for (size_t i = 0; i < GUEST_INSTALLS; i += 1) {
    if (installs[i].request != 0) free_install(&installs[i], true);
  }
  memset(waiters, 0, sizeof waiters);
  fetching = false;
  bound = NULL;
  jbuf_free(&rows);
  jbuf_free(&events);
  jbuf_free(&poll_out);
  jbuf_free(&status_out);
}
