/* DIAGNOSTIC: the steps of a runtime.push, timed (push_timing.h). */

#include "push_timing.h"

#ifdef POCKETJS_PUSH_TIMING

#include <3ds.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "link2.h"
#include "link2_host.h"

#define LINE_BYTES 256
#define MAX_LINES 96
#define TIMING_FILE "sdmc:/pocketjs/runtime/push-timing.txt"

static bool active;
static uint64_t hash;
static uint32_t total_bytes;
static uint64_t began;
static uint64_t received_at;
static uint64_t last_pump_end;
static uint64_t max_gap;
static uint64_t max_gap_end;
static uint64_t max_pump;
static uint64_t max_pump_end;
static uint32_t writes;
static uint64_t write_ticks;
static uint64_t write_max;
static size_t write_bytes;
static char lines[MAX_LINES][LINE_BYTES];
static size_t line_count;
static size_t lines_dropped;
static bool lost;
static bool replay_due;
static size_t replay_next;
/* The client's count of links when the push ended. */
static uint32_t links_at_finish;

static unsigned long ms(uint64_t ticks) {
  return (unsigned long)(ticks * 1000 / SYSCLOCK_ARM11);
}

uint64_t push_timing_now(void) {
  return svcGetSystemTick();
}

int push_timing_active(void) {
  return active ? 1 : 0;
}

static bool send(const char *text) {
  Link2 *client = link2_host_client();
  return client != NULL && link2_log(client, "info", "host", text, strlen(text), 0);
}

static void keep(const char *text) {
  if (line_count < MAX_LINES) snprintf(lines[line_count++], LINE_BYTES, "%s", text);
  else lines_dropped += 1;
  if (!send(text)) lost = true;
}

void push_timing_begin(uint64_t package_hash, uint32_t bytes) {
  active = true;
  hash = package_hash;
  total_bytes = bytes;
  began = svcGetSystemTick();
  received_at = 0;
  last_pump_end = began;
  max_gap = max_gap_end = max_pump = max_pump_end = 0;
  writes = 0;
  write_ticks = write_max = 0;
  write_bytes = 0;
  line_count = 0;
  lines_dropped = 0;
  lost = false;
  replay_due = false;
  char text[LINE_BYTES];
  snprintf(text, sizeof text, "push-timing %016llx begin: %lu bytes declared", (unsigned long long)hash, (unsigned long)bytes);
  keep(text);
}

void push_timing_received(void) {
  if (!active) return;
  uint64_t now = svcGetSystemTick();
  received_at = now;
  char text[LINE_BYTES];
  snprintf(text, sizeof text,
           "push-timing %016llx transfer %lu ms | %lu bytes in %lu staging writes, %lu ms writing, longest write %lu ms; longest pump gap so far %lu ms, longest pump %lu ms",
           (unsigned long long)hash, ms(now - began), (unsigned long)write_bytes, (unsigned long)writes, ms(write_ticks), ms(write_max), ms(max_gap), ms(max_pump));
  keep(text);
}

void push_timing_step(const char *step, uint64_t since, const char *format, ...) {
  if (!active) return;
  uint64_t now = svcGetSystemTick();
  char detail[160] = "";
  if (format != NULL) {
    va_list arguments;
    va_start(arguments, format);
    vsnprintf(detail, sizeof detail, format, arguments);
    va_end(arguments);
  }
  char rx[24] = "-";
  if (received_at != 0) snprintf(rx, sizeof rx, "%lu", ms(now - received_at));
  char text[LINE_BYTES];
  snprintf(text, sizeof text, "push-timing %016llx %s %lu ms | t=%lu rx=%s gap=%lu | %s",
           (unsigned long long)hash, step, ms(now - since), ms(now - began), rx, ms(now - last_pump_end), detail);
  keep(text);
}

void push_timing_write(uint64_t since, size_t bytes) {
  if (!active) return;
  uint64_t took = svcGetSystemTick() - since;
  writes += 1;
  write_bytes += bytes;
  write_ticks += took;
  if (took > write_max) write_max = took;
}

void push_timing_pumped(uint64_t start, uint64_t end) {
  if (!active) return;
  if (start > last_pump_end && start - last_pump_end > max_gap) {
    max_gap = start - last_pump_end;
    max_gap_end = start;
  }
  if (end - start > max_pump) {
    max_pump = end - start;
    max_pump_end = end;
  }
  last_pump_end = end;
}

void push_timing_finish(const char *outcome) {
  if (!active) return;
  uint64_t now = svcGetSystemTick();
  char after[24] = "-";
  if (received_at != 0) snprintf(after, sizeof after, "%lu", ms(now - received_at));
  char text[LINE_BYTES];
  snprintf(text, sizeof text,
           "push-timing %016llx end %s | total %lu ms, rx=%s; longest pump gap %lu ms ending at t=%lu, longest pump %lu ms ending at t=%lu; %lu lines not kept",
           (unsigned long long)hash, outcome, ms(now - began), after, ms(max_gap), ms(max_gap_end > began ? max_gap_end - began : 0),
           ms(max_pump), ms(max_pump_end > began ? max_pump_end - began : 0), (unsigned long)lines_dropped);
  keep(text);
  active = false;
  FILE *file = fopen(TIMING_FILE, "a");
  if (file != NULL) {
    fprintf(file, "== push %016llx, %lu bytes ==\n", (unsigned long long)hash, (unsigned long)total_bytes);
    for (size_t i = 0; i < line_count; i += 1) fprintf(file, "%s\n", lines[i]);
    fclose(file);
  }
  /* A line queued while the link was about to drop is lost too: the lines go
   * again when one was refused, or once the link has come up again. */
  Link2 *client = link2_host_client();
  links_at_finish = client != NULL ? link2_stats(client)->links : 0;
  replay_due = true;
  replay_next = 0;
}

/* A few lines a pump, so the send buffer has room for them (§8.2). */
#define REPLAY_PER_PUMP 8

void push_timing_service(void) {
  if (!replay_due || active) return;
  Link2 *client = link2_host_client();
  if (client == NULL || !link2_linked(client)) return;
  if (!lost && link2_stats(client)->links == links_at_finish) return;
  if (replay_next == 0) {
    char text[LINE_BYTES];
    snprintf(text, sizeof text, "push-timing %016llx again: the %lu lines of the last push, kept while the link was down or logs were off", (unsigned long long)hash, (unsigned long)line_count);
    if (!send(text)) return;
  }
  for (int sent = 0; sent < REPLAY_PER_PUMP && replay_next < line_count; sent += 1) {
    if (!send(lines[replay_next])) return;
    replay_next += 1;
  }
  if (replay_next >= line_count) replay_due = false;
}

#endif
