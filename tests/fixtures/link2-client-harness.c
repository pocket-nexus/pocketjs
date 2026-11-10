/*
 * The Pocket Link 2 C client (engine/host-services/link2.c) as a program for
 * tests/pocket-client-2-client.test.ts: it runs the client over BSD sockets
 * against a Hub on loopback, takes one command per line on stdin and prints
 * one line per thing that happens. The host callbacks are stubs that count
 * bytes and CRC-32s; the "guest" answers a daemon's requests by their name.
 *
 *   link2-client-harness <link dir> <beacon port> [--payload n] [--speed n]
 *                        [--features a,b,…] [--channels n]
 */

#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "link2.h"

#define MAX_TRACKED 24
#define MAX_PENDING 512
#define SHOT_BYTES (400u * 240u * 3u + 320u * 240u * 3u)

static Link2 *client;
static unsigned speed = 1;
static uint64_t blocked_until; /* tcp_send takes nothing until then */
static uint64_t guest_paused_until;
static bool slow_http;
static bool quit;

static void say(const char *format, ...) {
  va_list args;
  va_start(args, format);
  vprintf(format, args);
  va_end(args);
  putchar('\n');
  fflush(stdout);
}

static uint8_t pattern(uint32_t index, uint32_t seed) {
  return (uint8_t)(index * 31u + seed);
}

// ---------------------------------------------------------------------------
// the platform
// ---------------------------------------------------------------------------

static uint64_t real_ms(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (uint64_t)now.tv_sec * 1000u + (uint64_t)now.tv_nsec / 1000000u;
}

static uint64_t origin;
static uint64_t host_now(void *context) {
  (void)context;
  return (real_ms() - origin) * speed + 1000000u;
}

static void host_random(void *context, uint8_t *out, size_t length) {
  (void)context;
  arc4random_buf(out, length);
}

static Link2Platform sockets;
static long blocking_send(void *context, int handle, const uint8_t *bytes, size_t length) {
  if (real_ms() < blocked_until) return 0;
  return sockets.tcp_send(context, handle, bytes, length);
}

// ---------------------------------------------------------------------------
// host stubs
// ---------------------------------------------------------------------------

static void on_linked(void *context, const char *hub, const char *why) {
  (void)context;
  if (hub != NULL) say("linked %s %u", hub, link2_limit(client));
  else say("unlinked %s", why);
}

static void on_status(void *context, Link2Json *members) {
  (void)context;
  link2_json_text(members,
                  "\"phase\":\"booted\",\"target\":\"3ds-dev\",\"hostAbi\":12,\"slot\":\"06c50ee053fdb886\",\"address\":\"127.0.0.1\",\"generation\":3,"
                  "\"active\":\"0000000000000000\",\"lastGood\":\"0000000000000000\",\"running\":\"0c264b65890d0377\",\"frame\":4242,"
                  "\"app\":{\"id\":\"dev.pocket-nexus.shell\",\"output\":\"pocket-shell\",\"title\":\"Pocket\"}");
}

static uint32_t on_generation(void *context) {
  (void)context;
  return 3;
}

static size_t app_rows;
static char app_text[LINK2_APPS_MAX_ROWS][4][140];
static size_t on_apps(void *context, Link2InstalledApp *rows, size_t capacity) {
  (void)context;
  size_t count = app_rows < capacity ? app_rows : capacity;
  for (size_t i = 0; i < count; i += 1) {
    rows[i].id = app_text[i][0];
    rows[i].output = app_text[i][1];
    rows[i].version = app_text[i][2];
    rows[i].hash = app_text[i][3];
    rows[i].home = i == 0;
  }
  return count;
}

static struct {
  uint32_t bytes;
  uint32_t crc;
  bool fail_storage;
  bool reject;
} staged;

static bool on_push_begin(void *context, uint32_t bytes, const char *hash, Link2Failure *failure) {
  (void)context;
  (void)failure;
  staged.bytes = 0;
  staged.crc = 0;
  say("push-begin %u %s", bytes, hash);
  return true;
}

static bool on_staged_data(void *context, const uint8_t *bytes, size_t length) {
  (void)context;
  if (staged.fail_storage) return false;
  staged.crc = link2_crc32(staged.crc, bytes, length);
  staged.bytes += (uint32_t)length;
  return true;
}

static bool on_push_commit(void *context, Link2Json *members, Link2Failure *failure) {
  (void)context;
  if (staged.reject) {
    snprintf(failure->code, sizeof failure->code, "rejected");
    snprintf(failure->message, sizeof failure->message, "the package's profile does not match");
    say("push-rejected %u", staged.bytes);
    return false;
  }
  say("push %u %u", staged.bytes, staged.crc);
  link2_json_text(members, "\"generation\":4,\"message\":\"\",\"app\":{\"id\":\"dev.example.pushed\",\"output\":\"pushed\",\"title\":\"Pushed\"}");
  return true;
}

static void on_push_abort(void *context) {
  (void)context;
  say("push-abort %u", staged.bytes);
}

static bool on_native_begin(void *context, const char *name, uint32_t bytes, Link2Failure *failure) {
  (void)context;
  (void)failure;
  staged.bytes = 0;
  staged.crc = 0;
  say("native-begin %s %u", name, bytes);
  return true;
}

static bool on_native_commit(void *context, const char *name, bool launch, char phase[16], char path[128], Link2Failure *failure) {
  (void)context;
  (void)failure;
  say("native %s %u %u %d", name, staged.bytes, staged.crc, launch ? 1 : 0);
  snprintf(phase, 16, "%s", launch ? "launching" : "installed");
  snprintf(path, 128, "sdmc:/3ds/%s", name);
  return true;
}

static void on_native_abort(void *context) {
  (void)context;
  say("native-abort %u", staged.bytes);
}

static bool on_launch(void *context, const char *native, const char *app, Link2Json *members, bool *launching, Link2Failure *failure) {
  (void)context;
  if (app != NULL && strcmp(app, "missing") == 0) {
    snprintf(failure->code, sizeof failure->code, "not_found");
    snprintf(failure->message, sizeof failure->message, "no such applet");
    return false;
  }
  if (native != NULL) {
    *launching = true;
    link2_json_text(members, "\"phase\":\"launching\",\"name\":");
    link2_json_cstring(members, native);
    link2_json_text(members, ",\"path\":\"sdmc:/3ds/x\"");
  } else {
    link2_json_text(members, "\"phase\":\"switching\",\"output\":");
    link2_json_cstring(members, app);
  }
  say("launch %s", native != NULL ? native : app);
  return true;
}

static void on_restart(void *context) {
  (void)context;
  say("restart");
}

static uint32_t shot_at;
static bool on_shot_begin(void *context, Link2Json *members, uint32_t *frame, uint32_t *bytes) {
  (void)context;
  shot_at = 0;
  *frame = 777;
  *bytes = SHOT_BYTES;
  link2_json_text(members,
                  "\"frame\":777,\"format\":\"bgr8-rotated\",\"surfaces\":[{\"name\":\"top\",\"width\":400,\"height\":240,\"bytes\":288000},"
                  "{\"name\":\"bottom\",\"width\":320,\"height\":240,\"bytes\":230400}]");
  return true;
}

static size_t on_shot_read(void *context, uint8_t *into, size_t capacity) {
  (void)context;
  for (size_t i = 0; i < capacity; i += 1) into[i] = pattern(shot_at + (uint32_t)i, 9);
  shot_at += (uint32_t)capacity;
  return capacity;
}

static void on_shot_end(void *context) {
  (void)context;
  say("shot-end %u", shot_at);
}

static size_t catalog_total;
static void on_catalog_page(void *context, const char *rows, size_t length, bool first) {
  (void)context;
  JsonSpan array = json_span(rows, length), row;
  size_t at = 0, count = 0;
  bool malformed = false;
  char first_id[140] = "", last_id[140] = "";
  while (link2_array_next(array, &at, &row, &malformed)) {
    json_find_string(row, "id", last_id, sizeof last_id);
    if (count == 0) snprintf(first_id, sizeof first_id, "%s", last_id);
    count += 1;
  }
  if (first) catalog_total = 0;
  catalog_total += count;
  say("catalog-page %d %zu %s %s", first ? 1 : 0, count, first_id, last_id);
}

static void on_catalog_done(void *context, const char *error) {
  (void)context;
  say("catalog-done %s %zu", error != NULL ? error : "ok", catalog_total);
}

static void on_catalog_changed(void *context) {
  (void)context;
  say("catalog-changed");
}

static struct {
  uint32_t request;
  uint32_t bytes;
  uint32_t crc;
} installs[4];

static bool on_install_begin(void *context, uint32_t request, const char *app, const char *hash, uint32_t bytes) {
  (void)context;
  for (int i = 0; i < 4; i += 1) {
    if (installs[i].request != 0) continue;
    installs[i].request = request;
    installs[i].bytes = 0;
    installs[i].crc = 0;
    say("install-begin %u %s %s %u", request, app, hash, bytes);
    return true;
  }
  return false;
}

static bool on_install_data(void *context, uint32_t request, const uint8_t *bytes, size_t length) {
  (void)context;
  for (int i = 0; i < 4; i += 1) {
    if (installs[i].request != request) continue;
    installs[i].crc = link2_crc32(installs[i].crc, bytes, length);
    installs[i].bytes += (uint32_t)length;
    return true;
  }
  return false;
}

static void on_install_end(void *context, uint32_t request, const char *error) {
  (void)context;
  for (int i = 0; i < 4; i += 1) {
    if (installs[i].request != request) continue;
    say("install-end %u %s %u %u", request, error != NULL ? error : "ok", installs[i].bytes, installs[i].crc);
    installs[i].request = 0;
    return;
  }
  say("install-end %u %s 0 0", request, error != NULL ? error : "ok");
}

static struct {
  uint32_t request;
  uint32_t body;
  uint32_t bytes;
  uint32_t crc;
  uint32_t held; /* bytes the "worker" has not consumed yet */
} https[8];

static size_t on_http_body(void *context, uint32_t request, size_t offset, uint8_t *into, size_t capacity) {
  (void)context;
  (void)request;
  for (size_t i = 0; i < capacity; i += 1) into[i] = pattern((uint32_t)(offset + i), 5);
  return capacity;
}

static void on_http_head(void *context, uint32_t request, const char *json, size_t length) {
  (void)context;
  say("http-head %u %.*s", request, (int)(length > 300 ? 300 : length), json);
}

static void on_http_data(void *context, uint32_t request, const uint8_t *bytes, size_t length) {
  (void)context;
  for (int i = 0; i < 8; i += 1) {
    if (https[i].request != request) continue;
    https[i].crc = link2_crc32(https[i].crc, bytes, length);
    https[i].bytes += (uint32_t)length;
    https[i].held += (uint32_t)length;
  }
}

static void on_http_end(void *context, uint32_t request, const char *error) {
  (void)context;
  for (int i = 0; i < 8; i += 1) {
    if (https[i].request != request) continue;
    say("http-end %u %s %u %u", request, error != NULL ? error : "ok", https[i].bytes, https[i].crc);
    https[i].request = 0;
  }
}

static void on_system_event(void *context, const char *t, const char *json, size_t length) {
  (void)context;
  say("sys-event %s %.*s", t, (int)length, json);
}

static struct {
  uint32_t id;
  uint32_t bytes;
  uint32_t crc;
  char t[32];
} system_streams[4];

static uint32_t on_stream_open(void *context, uint32_t id, const char *t, const char *json, size_t length) {
  (void)context;
  uint64_t bytes = 0;
  if (!json_find_u64(json_span(json, length), "bytes", &bytes) || bytes == 0) return 0;
  for (int i = 0; i < 4; i += 1) {
    if (system_streams[i].id != 0) continue;
    system_streams[i].id = id;
    system_streams[i].bytes = 0;
    system_streams[i].crc = 0;
    snprintf(system_streams[i].t, sizeof system_streams[i].t, "%s", t);
    return (uint32_t)bytes;
  }
  return 0;
}

static bool on_stream_data(void *context, uint32_t id, const uint8_t *bytes, size_t length) {
  (void)context;
  for (int i = 0; i < 4; i += 1) {
    if (system_streams[i].id != id) continue;
    system_streams[i].crc = link2_crc32(system_streams[i].crc, bytes, length);
    system_streams[i].bytes += (uint32_t)length;
  }
  return true;
}

static void on_stream_end(void *context, uint32_t id, bool complete) {
  (void)context;
  for (int i = 0; i < 4; i += 1) {
    if (system_streams[i].id != id) continue;
    say("sys-stream %s %u %u %d", system_streams[i].t, system_streams[i].bytes, system_streams[i].crc, complete ? 1 : 0);
    system_streams[i].id = 0;
  }
}

// ---------------------------------------------------------------------------
// the guest: what an applet's binding does with the calls of §7.3
// ---------------------------------------------------------------------------

/* An inbound stream the guest reads to its end. */
static struct {
  int channel;
  uint32_t id;
  uint32_t bytes;
  uint32_t crc;
  bool hold; /* registered and never read: a stream the applet ignores */
} readers[MAX_TRACKED];

/* An outbound stream the guest fills with pattern bytes. */
static struct {
  int channel;
  uint32_t id;
  uint32_t total;
  uint32_t sent;
  bool ended;
} writers[MAX_TRACKED];

/* A request of the daemon the guest is answering. */
static struct {
  int channel;
  uint32_t id;
  char t[32];
  uint32_t bytes; /* response bytes to send */
  uint32_t body;  /* body bytes read */
  uint32_t body_crc;
  bool has_body;
  bool body_done;
  bool head_sent;
  bool stream_started;
} answers[MAX_TRACKED];

static int last_state[LINK2_MAX_CHANNELS] = {-1, -1, -1, -1};
static bool channel_used[LINK2_MAX_CHANNELS];
static bool hold_streams;

static void add_reader(int channel, uint32_t id) {
  for (int i = 0; i < MAX_TRACKED; i += 1) {
    if (readers[i].id != 0) continue;
    readers[i].channel = channel;
    readers[i].id = id;
    readers[i].bytes = 0;
    readers[i].crc = 0;
    readers[i].hold = hold_streams;
    return;
  }
}

static void add_writer(int channel, uint32_t id, uint32_t total) {
  for (int i = 0; i < MAX_TRACKED; i += 1) {
    if (writers[i].id != 0) continue;
    writers[i].channel = channel;
    writers[i].id = id;
    writers[i].total = total;
    writers[i].sent = 0;
    writers[i].ended = false;
    return;
  }
}

static void guest_message(int channel, const Link2Message *message) {
  static const char *const KINDS[] = {"?", "event", "progress", "reply", "request", "cancel"};
  say("message %d %s %u %u %d %.*s", channel, KINDS[message->kind], message->id, message->stream, message->error ? 1 : 0,
      (int)(message->length > 200 ? 200 : message->length), message->json != NULL ? message->json : "");
  if (message->kind == LINK2_MESSAGE_EVENT || message->kind == LINK2_MESSAGE_PROGRESS) {
    if (message->stream != 0) add_reader(channel, message->stream);
    return;
  }
  if (message->kind == LINK2_MESSAGE_CANCEL) {
    for (int i = 0; i < MAX_TRACKED; i += 1) {
      if (answers[i].id == message->id) answers[i].id = 0;
    }
    return;
  }
  if (message->kind != LINK2_MESSAGE_REQUEST) return;
  for (int i = 0; i < MAX_TRACKED; i += 1) {
    if (answers[i].id != 0) continue;
    uint64_t bytes = 0;
    JsonSpan object = json_span(message->json, message->length);
    memset(&answers[i], 0, sizeof answers[i]);
    answers[i].channel = channel;
    answers[i].id = message->id;
    json_find_string(object, "t", answers[i].t, sizeof answers[i].t);
    json_find_u64(object, "bytes", &bytes);
    answers[i].bytes = (uint32_t)bytes;
    answers[i].has_body = message->stream != 0;
    return;
  }
}

/* One step of every answer in flight; each call that returns LINK2_FULL is made again next frame. */
static void guest_answers(void) {
  char json[160];
  uint8_t chunk[2048];
  for (int i = 0; i < MAX_TRACKED; i += 1) {
    if (answers[i].id == 0) continue;
    int channel = answers[i].channel;
    uint32_t id = answers[i].id;
    if (strcmp(answers[i].t, "slow") == 0) continue; /* never answered: its requester cancels it */
    if (answers[i].has_body && !answers[i].body_done) {
      long n = link2_stream_read(client, channel, id, chunk, sizeof chunk);
      if (n > 0) {
        answers[i].body_crc = link2_crc32(answers[i].body_crc, chunk, (size_t)n);
        answers[i].body += (uint32_t)n;
      } else if (n == LINK2_STREAM_END || n == LINK2_STREAM_FAILED || n == LINK2_MALFORMED) {
        answers[i].body_done = true;
      }
      continue;
    }
    if (strcmp(answers[i].t, "big") == 0) {
      if (!answers[i].head_sent) {
        snprintf(json, sizeof json, "{\"t\":\"big.head\",\"bytes\":%u}", answers[i].bytes);
        if (link2_channel_progress(client, channel, id, json, strlen(json)) != LINK2_OK) continue;
        answers[i].head_sent = true;
        add_writer(channel, id, answers[i].bytes);
      }
      bool done = false;
      for (int w = 0; w < MAX_TRACKED; w += 1) {
        if (writers[w].id == id && writers[w].sent == writers[w].total) done = true;
      }
      if (!done) continue;
      snprintf(json, sizeof json, "{\"bytes\":%u}", answers[i].bytes);
    } else if (strcmp(answers[i].t, "unhandled") == 0) {
      snprintf(json, sizeof json, "{\"code\":\"unknown_message\",\"message\":\"no handler\"}");
      if (link2_channel_reply(client, channel, id, json, strlen(json), true) == LINK2_OK) answers[i].id = 0;
      continue;
    } else {
      snprintf(json, sizeof json, "{\"t\":\"%s\",\"body\":%u,\"crc\":%u}", answers[i].t, answers[i].body, answers[i].body_crc);
    }
    int result = link2_channel_reply(client, channel, id, json, strlen(json), false);
    if (result == LINK2_FULL) continue;
    for (int w = 0; w < MAX_TRACKED; w += 1) {
      if (writers[w].id == id) writers[w].id = 0;
    }
    answers[i].id = 0;
  }
}

static void guest_streams(void) {
  uint8_t chunk[4096];
  for (int i = 0; i < MAX_TRACKED; i += 1) {
    if (readers[i].id == 0 || readers[i].hold) continue;
    for (;;) {
      long n = link2_stream_read(client, readers[i].channel, readers[i].id, chunk, sizeof chunk);
      if (n > 0) {
        readers[i].crc = link2_crc32(readers[i].crc, chunk, (size_t)n);
        readers[i].bytes += (uint32_t)n;
        continue;
      }
      if (n == LINK2_STREAM_END) say("stream-end %d %u %u %u", readers[i].channel, readers[i].id, readers[i].bytes, readers[i].crc);
      if (n == LINK2_STREAM_FAILED || n == LINK2_MALFORMED) say("stream-failed %d %u %u", readers[i].channel, readers[i].id, readers[i].bytes);
      if (n != 0) readers[i].id = 0;
      break;
    }
  }
  for (int i = 0; i < MAX_TRACKED; i += 1) {
    if (writers[i].id == 0 || writers[i].ended) continue;
    while (writers[i].sent < writers[i].total) {
      uint32_t want = writers[i].total - writers[i].sent;
      if (want > sizeof chunk) want = sizeof chunk;
      for (uint32_t b = 0; b < want; b += 1) chunk[b] = pattern(writers[i].sent + b, 3);
      long n = link2_stream_write(client, writers[i].channel, writers[i].id, chunk, want);
      if (n < 0) {
        say("write-failed %d %u %ld", writers[i].channel, writers[i].id, n);
        writers[i].id = 0;
        break;
      }
      if (n == 0) break;
      writers[i].sent += (uint32_t)n;
    }
    if (writers[i].id != 0 && writers[i].sent == writers[i].total) {
      bool response = false;
      for (int a = 0; a < MAX_TRACKED; a += 1) {
        if (answers[a].id == writers[i].id) response = true;
      }
      /* A response's stream ends with its REPLY; a body or an event's stream is ended here. */
      if (!response) {
        link2_stream_end(client, writers[i].channel, writers[i].id);
        say("stream-sent %d %u %u", writers[i].channel, writers[i].id, writers[i].sent);
        writers[i].id = 0;
      } else {
        writers[i].ended = true;
      }
    }
  }
}

static void guest_frame(void) {
  for (int channel = 0; channel < (int)LINK2_MAX_CHANNELS; channel += 1) {
    if (!channel_used[channel]) continue;
    const char *reason = "";
    int state = link2_channel_state(client, channel, &reason);
    if (state != last_state[channel]) {
      static const char *const STATES[] = {"closed", "opening", "open"};
      say("channel-state %d %s %s %u", channel, STATES[state], reason[0] != '\0' ? reason : "-", link2_channel_generation(client, channel));
      last_state[channel] = state;
      if (state != LINK2_CHANNEL_OPEN) {
        /* The channel's streams and requests ended with it. */
        for (int i = 0; i < MAX_TRACKED; i += 1) {
          if (readers[i].channel == channel) readers[i].id = 0;
          if (writers[i].channel == channel) writers[i].id = 0;
          if (answers[i].channel == channel) answers[i].id = 0;
        }
      }
    }
    if (state != LINK2_CHANNEL_OPEN) continue;
    Link2Message message;
    link2_channel_frame(client, channel);
    while (link2_channel_poll(client, channel, &message)) guest_message(channel, &message);
  }
  guest_answers();
  guest_streams();
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

static char *pending[MAX_PENDING];
static size_t pending_head, pending_tail;

static char *field(char **cursor) {
  char *start = *cursor;
  if (start == NULL) return "";
  char *space = strchr(start, ' ');
  if (space == NULL) {
    *cursor = NULL;
    return start;
  }
  *space = '\0';
  *cursor = space + 1;
  return start;
}

/* True when the command ran; false when it found no room and runs again next frame. */
static bool command(char *line) {
  static char copy[70000];
  snprintf(copy, sizeof copy, "%s", line);
  char *cursor = copy;
  const char *name = field(&cursor);
  if (strcmp(name, "quit") == 0) {
    quit = true;
  } else if (strcmp(name, "status") == 0) {
    char text[2048];
    Link2Json json;
    link2_json_init(&json, text, sizeof text);
    link2_status_json(client, &json);
    say("status %.*s", (int)json.length, text);
  } else if (strcmp(name, "stats") == 0) {
    const Link2Stats *stats = link2_stats(client);
    say("stats links=%u late=%u dropped=%u pauses=%u txpeak=%u fixed=%u channel=%u peak=%u", stats->links, stats->late_events, stats->logs_dropped, stats->read_pauses,
        stats->tx_peak, stats->fixed_bytes, stats->channel_bytes, stats->channel_peak);
  } else if (strcmp(name, "reload") == 0) {
    link2_reload(client);
  } else if (strcmp(name, "forget") == 0) {
    say("forget %d", link2_forget(client, field(&cursor)) ? 1 : 0);
  } else if (strcmp(name, "features") == 0) {
    const char *list[LINK2_MAX_FEATURES];
    size_t count = 0;
    while (cursor != NULL && count < LINK2_MAX_FEATURES) list[count++] = field(&cursor);
    link2_set_features(client, list, count);
  } else if (strcmp(name, "block-send") == 0) {
    blocked_until = real_ms() + strtoul(field(&cursor), NULL, 10);
  } else if (strcmp(name, "guest-pause") == 0) {
    guest_paused_until = real_ms() + strtoul(field(&cursor), NULL, 10);
  } else if (strcmp(name, "hold-streams") == 0) {
    hold_streams = field(&cursor)[0] == '1';
  } else if (strcmp(name, "catalog") == 0) {
    say("catalog %d", link2_catalog(client) ? 1 : 0);
  } else if (strcmp(name, "install") == 0) {
    uint32_t id = link2_install(client, field(&cursor));
    if (id == 0 && link2_in_use(client, "install")) return false;
    say("install %u", id);
  } else if (strcmp(name, "http") == 0) {
    /* http <app> <url> <method> <body bytes> [headers json] */
    Link2HttpRequest request = {0};
    request.app = field(&cursor);
    request.url = field(&cursor);
    request.method = field(&cursor);
    request.body_bytes = (uint32_t)strtoul(field(&cursor), NULL, 10);
    request.headers = cursor;
    request.headers_length = cursor != NULL ? strlen(cursor) : 0;
    request.max_bytes = 262144;
    uint32_t id = link2_http(client, &request);
    if (id != 0) {
      for (int i = 0; i < 8; i += 1) {
        if (https[i].request != 0) continue;
        memset(&https[i], 0, sizeof https[i]);
        https[i].request = id;
        break;
      }
    }
    say("http %u", id);
  } else if (strcmp(name, "http-slow") == 0) {
    slow_http = field(&cursor)[0] == '1';
  } else if (strcmp(name, "http-cancel") == 0) {
    link2_http_cancel(client, (uint32_t)strtoul(field(&cursor), NULL, 10));
  } else if (strcmp(name, "apps") == 0) {
    app_rows = strtoul(field(&cursor), NULL, 10);
    const char *long_rows = field(&cursor);
    for (size_t i = 0; i < app_rows && i < LINK2_APPS_MAX_ROWS; i += 1) {
      if (long_rows[0] == '1') {
        snprintf(app_text[i][0], 140, "%02zu%0126d", i, 0);
        snprintf(app_text[i][1], 140, "%064d", 0);
        snprintf(app_text[i][2], 140, "%032d", 0);
      } else {
        snprintf(app_text[i][0], 140, "dev.example.applet-%02zu", i);
        snprintf(app_text[i][1], 140, "applet-%02zu", i);
        snprintf(app_text[i][2], 140, "1.0.%zu", i);
      }
      snprintf(app_text[i][3], 140, "%016zx", i);
    }
    link2_apps_changed(client);
  } else if (strcmp(name, "status-changed") == 0) {
    link2_status_changed(client);
  } else if (strcmp(name, "log") == 0) {
    say("log %d", link2_log(client, "info", "guest", cursor != NULL ? cursor : "", cursor != NULL ? strlen(cursor) : 0, 12) ? 1 : 0);
  } else if (strcmp(name, "stage") == 0) {
    const char *how = field(&cursor);
    staged.fail_storage = strcmp(how, "storage") == 0;
    staged.reject = strcmp(how, "reject") == 0;
  } else if (strcmp(name, "devtools-send") == 0) {
    if (!link2_devtools_send(client, cursor != NULL ? cursor : "", cursor != NULL ? strlen(cursor) : 0)) return false;
  } else if (strcmp(name, "guest-switch") == 0) {
    const char *app = field(&cursor);
    link2_guest_switch(client, app, field(&cursor));
  } else if (strcmp(name, "event") == 0) {
    if (!link2_event(client, cursor, strlen(cursor))) return false;
  } else if (strcmp(name, "event-stream") == 0) {
    /* event-stream <bytes> <json>: an event that opens a stream toward Hub, then its bytes. */
    uint32_t total = (uint32_t)strtoul(field(&cursor), NULL, 10);
    uint32_t id = link2_event_stream(client, cursor, strlen(cursor));
    if (id == 0) return false;
    uint8_t chunk[4096];
    uint32_t sent = 0;
    uint64_t deadline = real_ms() + 10000;
    while (sent < total && real_ms() < deadline) {
      uint32_t want = total - sent > sizeof chunk ? (uint32_t)sizeof chunk : total - sent;
      for (uint32_t b = 0; b < want; b += 1) chunk[b] = pattern(sent + b, 7);
      size_t n = link2_event_stream_send(client, id, chunk, want, sent + want == total);
      sent += (uint32_t)n;
      link2_pump(client);
      if (n == 0) usleep(500);
    }
    say("event-stream %u %u", id, sent);
  } else if (strcmp(name, "channel-open") == 0) {
    const char *app = field(&cursor);
    int channel = link2_channel_open(client, app, field(&cursor));
    if (channel >= 0) {
      channel_used[channel] = true;
      last_state[channel] = -1;
    }
    say("channel %d", channel);
  } else if (strcmp(name, "exit") == 0) {
    int channel = atoi(field(&cursor));
    link2_channel_exit(client, channel);
    channel_used[channel] = false;
    say("exited %d", channel);
  } else if (strcmp(name, "reset") == 0) {
    link2_channel_reset(client, atoi(field(&cursor)));
  } else if (strcmp(name, "request") == 0) {
    /* request <channel> <body bytes> <json> */
    int channel = atoi(field(&cursor));
    uint32_t body = (uint32_t)strtoul(field(&cursor), NULL, 10);
    uint32_t id = 0;
    int result = link2_channel_request(client, channel, cursor, strlen(cursor), body > 0, &id);
    if (result == LINK2_FULL) return false;
    if (result != LINK2_OK) {
      say("request-error %d %d", channel, result);
    } else {
      say("request %d %u", channel, id);
      if (body > 0) add_writer(channel, id, body);
    }
  } else if (strcmp(name, "cancel") == 0) {
    int channel = atoi(field(&cursor));
    link2_channel_cancel(client, channel, (uint32_t)strtoul(field(&cursor), NULL, 10));
  } else if (strcmp(name, "emit") == 0) {
    /* emit <channel> <stream bytes> <json> */
    int channel = atoi(field(&cursor));
    uint32_t bytes = (uint32_t)strtoul(field(&cursor), NULL, 10);
    uint32_t stream = 0;
    int result = link2_channel_emit(client, channel, cursor, strlen(cursor), bytes > 0 ? &stream : NULL);
    if (result == LINK2_FULL) return false;
    if (result != LINK2_OK) say("emit-error %d %d", channel, result);
    else if (bytes > 0) add_writer(channel, stream, bytes);
  } else if (strcmp(name, "emit-count") == 0) {
    /* emit-count <channel> <count>: as many small events as the window takes now; the count sent. */
    int channel = atoi(field(&cursor));
    unsigned count = (unsigned)strtoul(field(&cursor), NULL, 10), sent = 0;
    for (unsigned i = 0; i < count; i += 1) {
      char json[64];
      snprintf(json, sizeof json, "{\"t\":\"tick\",\"n\":%u}", i);
      if (link2_channel_emit(client, channel, json, strlen(json), NULL) != LINK2_OK) break;
      sent += 1;
    }
    say("emitted %d %u", channel, sent);
  } else if (strcmp(name, "close-stream") == 0) {
    int channel = atoi(field(&cursor));
    link2_stream_close(client, channel, (uint32_t)strtoul(field(&cursor), NULL, 10));
  } else {
    say("unknown-command %s", name);
  }
  return true;
}

static char input[65536];
static size_t input_fill;

static void read_commands(void) {
  ssize_t n = read(0, input + input_fill, sizeof input - input_fill - 1);
  if (n == 0) quit = true;
  if (n > 0) input_fill += (size_t)n;
  char *start = input;
  for (;;) {
    char *newline = memchr(start, '\n', input_fill - (size_t)(start - input));
    if (newline == NULL) break;
    *newline = '\0';
    if (pending_tail - pending_head < MAX_PENDING) pending[pending_tail++ % MAX_PENDING] = strdup(start);
    start = newline + 1;
  }
  input_fill -= (size_t)(start - input);
  memmove(input, start, input_fill);
  while (pending_head < pending_tail) {
    char *line = pending[pending_head % MAX_PENDING];
    if (!command(line)) break;
    free(line);
    pending_head += 1;
  }
}

int main(int argc, char **argv) {
  static const char *features[LINK2_MAX_FEATURES] = {"runtime", "runtime.native", "devtools", "catalog", "install", "net.http", "agent", "channel", "apps"};
  size_t feature_count = 9;
  Link2Platform platform = {0};
  Link2Host host = {0};
  if (argc < 3) return 2;
  host.directory = argv[1];
  host.beacon_port = (uint16_t)atoi(argv[2]);
  host.max_channels = 1;
  for (int i = 3; i + 1 < argc; i += 2) {
    if (strcmp(argv[i], "--payload") == 0) host.max_payload = (uint32_t)atoi(argv[i + 1]);
    if (strcmp(argv[i], "--speed") == 0) speed = (unsigned)atoi(argv[i + 1]);
    if (strcmp(argv[i], "--channels") == 0) host.max_channels = (uint32_t)atoi(argv[i + 1]);
    if (strcmp(argv[i], "--features") == 0) {
      feature_count = 0;
      for (char *name = strtok(argv[i + 1], ","); name != NULL && feature_count < LINK2_MAX_FEATURES; name = strtok(NULL, ",")) features[feature_count++] = name;
    }
  }
  origin = real_ms();
  link2_bsd_sockets(&sockets);
  platform = sockets;
  platform.now_ms = host_now;
  platform.random = host_random;
  platform.tcp_send = blocking_send;

  host.name = "Harness 3DS";
  host.model = "New Nintendo 3DS XL";
  host.target = "3ds-dev";
  host.host_abi = 12;
  host.features = features;
  host.feature_count = feature_count;
  host.linked = on_linked;
  host.runtime_status = on_status;
  host.runtime_generation = on_generation;
  host.runtime_apps = on_apps;
  host.push_begin = on_push_begin;
  host.push_data = on_staged_data;
  host.push_commit = on_push_commit;
  host.push_abort = on_push_abort;
  host.native_begin = on_native_begin;
  host.native_data = on_staged_data;
  host.native_commit = on_native_commit;
  host.native_abort = on_native_abort;
  host.launch = on_launch;
  host.restart = on_restart;
  host.screenshot_begin = on_shot_begin;
  host.screenshot_read = on_shot_read;
  host.screenshot_end = on_shot_end;
  host.catalog_page = on_catalog_page;
  host.catalog_done = on_catalog_done;
  host.catalog_changed = on_catalog_changed;
  host.install_begin = on_install_begin;
  host.install_data = on_install_data;
  host.install_end = on_install_end;
  host.http_body = on_http_body;
  host.http_head = on_http_head;
  host.http_data = on_http_data;
  host.http_end = on_http_end;
  host.system_event = on_system_event;
  host.stream_open = on_stream_open;
  host.stream_data = on_stream_data;
  host.stream_end = on_stream_end;

  client = link2_create(&platform, &host);
  if (client == NULL) return 3;
  say("device %s", link2_device_id(client));
  fcntl(0, F_SETFL, fcntl(0, F_GETFL, 0) | O_NONBLOCK);

  while (!quit) {
    read_commands();
    link2_pump(client);
    size_t length = 0;
    for (const char *line = link2_devtools_poll(client, &length); line != NULL; line = link2_devtools_poll(client, &length)) {
      char t[16] = "", id[40] = "";
      JsonSpan object = json_span(line, length);
      say("devtools-line %.*s", (int)(length > 120 ? 120 : length), line);
      if (json_find_string(object, "t", t, sizeof t) && strcmp(t, "eval") == 0 && json_find_string(object, "id", id, sizeof id)) {
        char answer[160];
        snprintf(answer, sizeof answer, "{\"t\":\"evalResult\",\"id\":\"%s\",\"ok\":true,\"value\":%zu}", id, length);
        char queued[200];
        snprintf(queued, sizeof queued, "devtools-send %s", answer);
        if (pending_tail - pending_head < MAX_PENDING) pending[pending_tail++ % MAX_PENDING] = strdup(queued);
      }
    }
    if (!slow_http) {
      for (int i = 0; i < 8; i += 1) {
        if (https[i].request == 0 || https[i].held == 0) continue;
        link2_http_consumed(client, https[i].request, https[i].held);
        https[i].held = 0;
      }
    }
    if (real_ms() >= guest_paused_until) guest_frame();
    usleep(300);
  }
  link2_stop(client);
  for (int i = 0; i < 200 && link2_stats(client) != NULL; i += 1) {
    link2_pump(client);
    usleep(1000);
    char text[2048];
    Link2Json json;
    link2_json_init(&json, text, sizeof text);
    link2_status_json(client, &json);
    if (strstr(text, "\"phase\":\"idle\"") != NULL) break;
  }
  const Link2Stats *stats = link2_stats(client);
  say("stats links=%u late=%u dropped=%u pauses=%u txpeak=%u fixed=%u channel=%u peak=%u", stats->links, stats->late_events, stats->logs_dropped, stats->read_pauses,
      stats->tx_peak, stats->fixed_bytes, stats->channel_bytes, stats->channel_peak);
  link2_destroy(client);
  while (pending_head < pending_tail) free(pending[pending_head++ % MAX_PENDING]);
  say("bye");
  return 0;
}
