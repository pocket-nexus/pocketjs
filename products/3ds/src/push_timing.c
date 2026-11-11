/* The steps of a runtime.push, timed (push_timing.h). */

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
#ifdef POCKETJS_PUSH_TRACE
#define MAX_LINES 96
#define TIMING_FILE "sdmc:/pocketjs/runtime/push-timing.txt"
#else
#define MAX_LINES 1
#endif
/* The longest steps the summary names. */
#define TOP_STEPS 4

static bool active;
static uint64_t hash;
static uint32_t total_bytes;
static uint64_t began;
static uint64_t received_at;
static uint64_t transfer_ticks;
static uint64_t last_pump_end;
static uint64_t max_gap;
static uint64_t max_gap_end;
static uint32_t writes;
static uint64_t write_ticks;
static size_t write_bytes;
static struct {
  char name[40];
  uint64_t ticks;
} top[TOP_STEPS];
/* The trace's lines (POCKETJS_PUSH_TRACE), or the summary alone. */
static char lines[MAX_LINES][LINE_BYTES];
static size_t line_count;
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

/* With the runtime's frame number, as every other host line. */
static bool send_line(const char *text) {
  return link2_host_report_log("info", text);
}

/* A line kept for the replay, and sent now. */
static void keep(const char *text) {
  if (line_count < MAX_LINES) snprintf(lines[line_count++], LINE_BYTES, "%s", text);
  if (!send_line(text)) lost = true;
}

void push_timing_begin(uint64_t package_hash, uint32_t bytes) {
  active = true;
  hash = package_hash;
  total_bytes = bytes;
  began = svcGetSystemTick();
  received_at = 0;
  transfer_ticks = 0;
  last_pump_end = began;
  max_gap = max_gap_end = 0;
  writes = 0;
  write_ticks = 0;
  write_bytes = 0;
  memset(top, 0, sizeof top);
  line_count = 0;
  lost = false;
  replay_due = false;
}

void push_timing_received(void) {
  if (!active) return;
  received_at = svcGetSystemTick();
  transfer_ticks = received_at - began;
#ifdef POCKETJS_PUSH_TRACE
  char text[LINE_BYTES];
  snprintf(text, sizeof text, "push-timing %016llx transfer %lu ms | %lu bytes in %lu staging writes, %lu ms writing; longest pump gap so far %lu ms",
           (unsigned long long)hash, ms(transfer_ticks), (unsigned long)write_bytes, (unsigned long)writes, ms(write_ticks), ms(max_gap));
  keep(text);
#endif
}

void push_timing_step(const char *step, uint64_t since, const char *format, ...) {
  if (!active) return;
  uint64_t now = svcGetSystemTick();
  uint64_t took = now - since;
  /* The umbrella steps contain the others; the summary names what is inside them. */
  if (strcmp(step, "switch-guest") != 0 && strcmp(step, "slot-install") != 0 && strcmp(step, "boot-guest") != 0 &&
      strcmp(step, "run-bundle") != 0 && strcmp(step, "route-peek") != 0 && strcmp(step, "qjs-program-boot-source") != 0) {
    for (size_t i = 0; i < TOP_STEPS; i += 1) {
      if (took <= top[i].ticks) continue;
      memmove(&top[i + 1], &top[i], (TOP_STEPS - i - 1) * sizeof top[0]);
      snprintf(top[i].name, sizeof top[i].name, "%s", step);
      top[i].ticks = took;
      break;
    }
  }
#ifdef POCKETJS_PUSH_TRACE
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
           (unsigned long long)hash, step, ms(took), ms(now - began), rx, ms(now - last_pump_end), detail);
  keep(text);
#else
  (void)format;
#endif
}

void push_timing_write(uint64_t since, size_t bytes) {
  if (!active) return;
  writes += 1;
  write_bytes += bytes;
  write_ticks += svcGetSystemTick() - since;
}

void push_timing_pumped(uint64_t start, uint64_t end) {
  if (!active) return;
  if (start > last_pump_end && start - last_pump_end > max_gap) {
    max_gap = start - last_pump_end;
    max_gap_end = start;
  }
  last_pump_end = end;
}

void push_timing_finish(const char *outcome) {
  if (!active) return;
  uint64_t now = svcGetSystemTick();
  char after[24] = "-";
  if (received_at != 0) snprintf(after, sizeof after, "%lu", ms(now - received_at));
  char text[LINE_BYTES];
  size_t used = (size_t)snprintf(text, sizeof text,
                                 "push %016llx %s: %lu bytes, transfer %lu ms, %s ms after received, longest pump gap %lu ms at t=%lu; longest steps",
                                 (unsigned long long)hash, outcome, (unsigned long)total_bytes, ms(transfer_ticks), after, ms(max_gap),
                                 ms(max_gap_end > began ? max_gap_end - began : 0));
  for (size_t i = 0; i < TOP_STEPS && top[i].ticks != 0 && used < sizeof text; i += 1) {
    used += (size_t)snprintf(text + used, sizeof text - used, "%s %s %lu ms", i == 0 ? "" : ",", top[i].name, ms(top[i].ticks));
  }
#ifndef POCKETJS_PUSH_TRACE
  line_count = 0;
#endif
  keep(text);
  active = false;
#ifdef POCKETJS_PUSH_TRACE
  FILE *file = fopen(TIMING_FILE, "a");
  if (file != NULL) {
    fprintf(file, "== push %016llx, %lu bytes ==\n", (unsigned long long)hash, (unsigned long)total_bytes);
    for (size_t i = 0; i < line_count; i += 1) fprintf(file, "%s\n", lines[i]);
    fclose(file);
  }
#endif
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
  for (int sent = 0; sent < REPLAY_PER_PUMP && replay_next < line_count; sent += 1) {
    if (!send_line(lines[replay_next])) return;
    replay_next += 1;
  }
  if (replay_next >= line_count) replay_due = false;
}

#endif
