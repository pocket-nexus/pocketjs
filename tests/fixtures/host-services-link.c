/* Native harness for engine/host-services/link.c and launcher.c
 * (tests/host-services-link.test.ts): a POSIX host_services.h over a
 * temporary store, driving the shared Pocket Link client against an
 * in-process companion.
 *
 *   host-services-link <store> <pair-uri> <app-id> <url>
 *
 * pairs, requests the catalog, installs <app-id>, fetches <url> through the
 * companion and prints one line per step:
 *
 *   linked <0|1>              status <state>
 *   catalog <events json>     installed <slot> <bytes> <footer match 0|1>
 *   install <events json>     net <status> <body> */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include "host_services.h"
#include "launcher.h"
#include "link.h"

static char apps[512];
static char link_directory[512];

uint64_t services_host_us(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (uint64_t)now.tv_sec * 1000000u + (uint64_t)now.tv_nsec / 1000u;
}

uint64_t services_host_ms(void) {
  return services_host_us() / 1000u;
}

uint64_t services_host_epoch_ms(void) {
  struct timeval now;
  gettimeofday(&now, NULL);
  return (uint64_t)now.tv_sec * 1000u + (uint64_t)now.tv_usec / 1000u;
}

void services_host_random(uint8_t *out, size_t length) {
  for (size_t i = 0; i < length; i += 1) out[i] = (uint8_t)rand();
}

const char *launcher_host_apps_directory(void) {
  return apps;
}

bool launcher_host_slot_path(const char *slot, const char *name, char *out, size_t capacity) {
  int written = name == NULL ? snprintf(out, capacity, "%s/%s", apps, slot)
                             : snprintf(out, capacity, "%s/%s/%s", apps, slot, name);
  return written > 0 && (size_t)written < capacity;
}

/* The slot link_host_install committed, as the table finds it. */
static char installed_slot[17];
static uint64_t installed_hash;

bool launcher_host_active_hash(const char *slot, uint64_t *hash) {
  if (strcmp(slot, installed_slot) != 0) return false;
  *hash = installed_hash;
  return true;
}

bool launcher_host_load(const char *slot, uint64_t hash, LauncherPackage *out, void **held) {
  (void)slot;
  (void)hash;
  (void)out;
  (void)held;
  return false;
}

void services_host_release(void *held) {
  (void)held;
}

const char *link_host_target(void) {
  return "3ds-dev";
}

void link_host_identity(char *name, size_t name_capacity, char *model, size_t model_capacity) {
  snprintf(name, name_capacity, "Harness");
  snprintf(model, model_capacity, "Build machine");
}

const char *link_host_directory(void) {
  return link_directory;
}

bool link_host_net_ready(void) {
  return true;
}

void link_host_address(char *out, size_t capacity) {
  snprintf(out, capacity, "127.0.0.1");
}

bool link_host_staging_path(const char *slot, char *out, size_t capacity) {
  char directory[600];
  snprintf(directory, sizeof directory, "%s/%s", apps, slot);
  mkdir(apps, 0777);
  mkdir(directory, 0777);
  return launcher_host_slot_path(slot, "link-upload.pocket", out, capacity);
}

bool link_host_install(const char *slot, const char *path, uint64_t hash, LauncherPackage *out, void **held,
                       char *error, size_t error_capacity) {
  FILE *file = fopen(path, "rb");
  uint8_t footer[8] = {0};
  long size = 0;
  if (file != NULL) {
    fseek(file, -8, SEEK_END);
    if (fread(footer, 1, sizeof footer, file) != sizeof footer) memset(footer, 0, sizeof footer);
    size = ftell(file);
    fclose(file);
  }
  uint64_t stored = 0;
  for (int i = 7; i >= 0; i -= 1) stored = (stored << 8) | footer[i];
  printf("installed %s %ld %d\n", slot, size, stored == hash);
  if (stored != hash) {
    snprintf(error, error_capacity, "footer mismatch");
    return false;
  }
  static const char plan[] = "{\"app\":{\"output\":\"hn\",\"id\":\"dev.pocket-nexus.hn\"}}";
  /* An icon set stands in as opaque bytes: the launcher stores, never parses it. */
  static uint8_t icon[3000];
  for (size_t i = 0; i < sizeof icon; i += 1) icon[i] = (uint8_t)(i * 13 + 5);
  *out = (LauncherPackage){ .plan = plan, .plan_length = sizeof plan - 1, .icon = icon, .icon_length = sizeof icon,
                            .hash = hash, .bytes = (uint64_t)size };
  snprintf(installed_slot, sizeof installed_slot, "%s", slot);
  installed_hash = hash;
  *held = NULL;
  return true;
}

bool link_host_remove(const char *slot) {
  (void)slot;
  return false;
}

void link_host_linked(bool up) {
  printf("linked %d\n", up);
}

bool link_host_ctrl(const char *json, size_t length) {
  (void)json;
  (void)length;
  return false;
}

bool link_host_data(uint32_t stream, const uint8_t *bytes, size_t length) {
  (void)stream;
  (void)bytes;
  (void)length;
  return false;
}

/* Pump until an event batch holds `needle`; that batch, or NULL. */
static const char *await_event(const char *(*poll)(void), const char *needle) {
  for (int i = 0; i < 3000; i += 1) {
    link_pump();
    const char *events = poll();
    if (events != NULL && strstr(events, needle) != NULL) return events;
    if (events != NULL) printf("event %s\n", events);
    usleep(2000);
  }
  return NULL;
}

int main(int argc, char **argv) {
  if (argc != 5) return 2;
  mkdir(argv[1], 0777);
  snprintf(apps, sizeof apps, "%s/apps", argv[1]);
  snprintf(link_directory, sizeof link_directory, "%s/link", argv[1]);
  static const char home_plan[] = "{\"app\":{\"output\":\"home-main\",\"id\":\"dev.pocket-nexus.home\"}}";
  const LauncherPackage home = { .plan = home_plan, .plan_length = sizeof home_plan - 1 };
  launcher_init("0123456789abcdef", &home);
  launcher_set_current("0123456789abcdef", &home);
  link_init();
  if (!link_pair(argv[2], strlen(argv[2]))) return 3;
  const char *status = link_status_json();
  for (int i = 0; i < 3000 && strstr(status, "\"state\":\"linked\"") == NULL; i += 1) {
    link_pump();
    usleep(2000);
    status = link_status_json();
  }
  printf("status %s\n", strstr(status, "\"state\":\"linked\"") != NULL ? "linked" : "not linked");
  if (link_catalog() < 0) return 4;
  const char *catalog = await_event(link_poll, "\"catalog\"");
  printf("catalog %s\n", catalog != NULL ? catalog : "none");
  if (link_install(argv[3], strlen(argv[3])) < 0) return 5;
  const char *install = await_event(link_poll, "install.done");
  printf("install %s\n", install != NULL ? install : "none");
  size_t icon_length = 0;
  const uint8_t *icon = launcher_app_icon("hn", &icon_length);
  bool icon_intact = icon != NULL;
  for (size_t i = 0; icon_intact && i < icon_length; i += 1) icon_intact = icon[i] == (uint8_t)(i * 13 + 5);
  printf("icon %zu %d %d\n", icon_length, icon_intact, launcher_app_icon("nope", &icon_length) == NULL);
  char meta[512];
  snprintf(meta, sizeof meta, "{\"url\":\"%s\",\"method\":\"GET\",\"headers\":{}}", argv[4]);
  int32_t handle = link_net_start(meta, strlen(meta), NULL, 0);
  const char *done = handle > 0 ? await_event(link_net_poll, "\"done\"") : NULL;
  if (done == NULL) {
    printf("net none %s\n", link_net_last_error());
  } else {
    const char *bytes = strstr(done, "\"bytes\":");
    const char *code = strstr(done, "\"status\":");
    size_t length = bytes != NULL ? strtoul(bytes + 8, NULL, 10) : 0;
    char *body = calloc(1, length + 1);
    link_net_take(handle, (uint8_t *)body, length);
    printf("net %lu %s\n", code != NULL ? strtoul(code + 9, NULL, 10) : 0ul, body);
    free(body);
  }
  link_shutdown();
  return 0;
}
