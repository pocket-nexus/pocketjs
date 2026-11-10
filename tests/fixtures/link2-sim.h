/*
 * tests/fixtures/link2-sim.h — an in-process scaffold for the Pocket Link 2
 * C client (engine/host-services/link2.c), from the independent review of
 * the client of 2026-11-10.
 *
 * It textually includes link2.c, so a scenario reads the client's private
 * state (the send buffer's head and tail, a channel's unit counts), replaces
 * malloc, calloc and free inside it with counting wrappers that can be made
 * to fail, and supplies a platform whose socket is a pair of byte queues with
 * a scripted Hub on the other end and a clock the scenario advances. The
 * scripted Hub answers the handshake and tracks credit per id; a scenario
 * sends any frame it likes past it.
 *
 * tests/fixtures/link2-scenarios.c holds the scenarios; tests/
 * pocket-link-2-scenarios.test.ts builds and runs them.
 */
#ifndef POCKET_LINK2_SIM_H
#define POCKET_LINK2_SIM_H

#include <dirent.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "jscan.h"
#include "link2.h"
#include "link2_proto.h"
#include "sha256.h"

// ---------------------------------------------------------------------------
// rng, die, allocation wrappers
// ---------------------------------------------------------------------------

static uint64_t rng_state = 88172645463325252ull;
static uint64_t rnd(void) {
  rng_state ^= rng_state << 13;
  rng_state ^= rng_state >> 7;
  rng_state ^= rng_state << 17;
  return rng_state;
}
static uint32_t rn(uint32_t n) { return n ? (uint32_t)((rnd() >> 11) % n) : 0; }

static uint64_t sim_seed;
static uint64_t sim_step;
static bool sim_trace;
static uint64_t trace_from = ~0ull;
static bool tracker_lost_flag_unused;
static void die(const char *format, ...) {
  va_list args;
  va_start(args, format);
  fprintf(stderr, "\nFINDING seed=%llu step=%llu: ", (unsigned long long)sim_seed, (unsigned long long)sim_step);
  vfprintf(stderr, format, args);
  fprintf(stderr, "\n");
  va_end(args);
  fflush(stderr);
  abort();
}
/* A finding the run can continue past: reported at its first occurrence, counted after. */
#define NOTE_KEYS 64
static const char *note_keys[NOTE_KEYS];
static unsigned long note_counts[NOTE_KEYS];
static bool note(const char *key, const char *format, ...) {
  int at = 0;
  while (at < NOTE_KEYS && note_keys[at] != NULL && strcmp(note_keys[at], key) != 0) at += 1;
  if (at == NOTE_KEYS) return true;
  if (note_keys[at] == NULL) {
    va_list args;
    va_start(args, format);
    note_keys[at] = key;
    fprintf(stderr, "\nNOTE[%s] first at seed=%llu step=%llu: ", key, (unsigned long long)sim_seed, (unsigned long long)sim_step);
    vfprintf(stderr, format, args);
    fprintf(stderr, "\n");
    va_end(args);
    fflush(stderr);
  }
  note_counts[at] += 1;
  return true;
}
static void note_summary(void) {
  for (int at = 0; at < NOTE_KEYS && note_keys[at] != NULL; at += 1) fprintf(stderr, "NOTE[%s] x%lu\n", note_keys[at], note_counts[at]);
}
static void trace(const char *format, ...) {
  if (!sim_trace && sim_step < trace_from) return;
  va_list args;
  va_start(args, format);
  vfprintf(stderr, format, args);
  fprintf(stderr, "\n");
  va_end(args);
}

static long fz_live;
static unsigned fz_fail_rate; /* 1 in n mallocs fail; 0 never */
static void *fz_malloc(size_t n) {
  if (fz_fail_rate && rn(fz_fail_rate) == 0) return NULL;
  void *p = malloc(n);
  if (p) fz_live++;
  return p;
}
static void *fz_calloc(size_t a, size_t b) {
  void *p = calloc(a, b);
  if (p) fz_live++;
  return p;
}
static void fz_free(void *p) {
  if (p) fz_live--;
  free(p);
}

#define malloc fz_malloc
#define calloc fz_calloc
#define free fz_free
#include "link2.c"
#undef malloc
#undef calloc
#undef free

/* Reads every byte so ASan checks the range. */
static volatile unsigned touch_sink;
static void touch(const void *p, size_t n) {
  const uint8_t *b = p;
  unsigned s = 0;
  for (size_t i = 0; i < n; i += 1) s += b[i];
  touch_sink += s;
}

// ---------------------------------------------------------------------------
// the fake socket and the scripted Hub's bookkeeping
// ---------------------------------------------------------------------------

#define TO_DEV_CAP (1u << 21)
static uint8_t *to_dev;
static size_t to_dev_head, to_dev_tail;
static uint8_t hub_rx[1u << 17];
static size_t hub_rx_fill;
static uint64_t vnow = 100000;
static bool sock_open;
static bool sock_fail;        /* the next recv/send reports the connection gone */
static int accept_mode;       /* 0 everything, 1 a trickle, 2 nothing */
static uint32_t accept_trickle = 300;
static int recv_mode;         /* 0 normal, 1 one byte at a time */
static int hub_state;         /* 0 preamble, 1 hello, 2 auth, 3 linked */
static uint32_t hub_limit = 1024;
static uint32_t ready_payload = 16384;
static bool hub_mute;         /* answers no PING */
static bool hub_auto = true;  /* the scripted handshake runs */
static int hostility;         /* 0 clean, 1 mild, 2 heavy */
static bool beacon_on = true;
static uint64_t device_frames, device_bytes, hub_frames;
static uint32_t device_crc; /* over every byte the device wrote: equal runs give equal digests */
static const uint8_t HUB_KEY[32] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32};
static const char HUB_ID[] = "00000000000000aa";
static char dev_id[17], dev_nonce[40];
static const char *ready_features = "\"runtime\",\"runtime.native\",\"devtools\",\"catalog\",\"install\",\"net.http\",\"agent\",\"channel\",\"apps\"";

/* Per-connection maps keyed by id. */
typedef struct {
  uint32_t id;
  bool used;
  uint64_t cr_from_dev; /* bytes the device granted and Hub has not used */
  uint64_t cr_to_dev;   /* bytes Hub granted and the device has not used */
  uint32_t requests_sent, replies_seen;
  bool dev_request, dev_replied;
  uint8_t dev_kind; /* 1 catalog 2 install 3 http 4 devtools 5 channel.open 6 app */
  uint32_t chan;    /* app request: its channel id */
  bool hub_app_request;
  bool is_channel, channel_open;
  uint64_t units_to_dev, units_from_dev;
  bool dev_stream_id;
} IdInfo;
#define ID_SLOTS 65536
static bool tracker_lost; /* the id map overflowed on this connection: id checks are off */
static IdInfo ids[ID_SLOTS];
static uint32_t hub_next_id = 0x80000001u;
static uint32_t last_dev_request, last_channel, last_dev_app_request, last_hub_request, last_hub_app_request, last_dev_stream, last_http, last_install, last_devtools, last_catalog;
static bool device_sent_close;
static uint32_t device_close_code;
static uint32_t device_closes;
static bool lenient; /* untracked frames went out on this connection: reply counting is off */
static bool (*hello_hook)(void); /* true when the driver answered the hello itself */
static bool (*auth_hook)(void);

static IdInfo *info(uint32_t id) {
  uint32_t at = (id * 2654435761u) % ID_SLOTS;
  for (uint32_t i = 0; i < ID_SLOTS; i += 1) {
    IdInfo *slot = &ids[(at + i) % ID_SLOTS];
    if (slot->used && slot->id == id) return slot;
    if (!slot->used) {
      slot->used = true;
      slot->id = id;
      return slot;
    }
  }
  /* The map is full: forget everything and stop checking by id on this connection. */
  memset(ids, 0, sizeof ids);
  tracker_lost = true;
  return info(id);
}

static void connection_reset(void) {
  memset(ids, 0, sizeof ids);
  to_dev_head = to_dev_tail = 0;
  hub_rx_fill = 0;
  hub_state = 0;
  hub_limit = 1024;
  hub_next_id = 0x80000001u;
  last_dev_request = last_channel = last_dev_app_request = last_hub_request = last_hub_app_request = last_dev_stream = last_http = last_install = last_devtools = last_catalog = 0;
  device_sent_close = false;
  lenient = false;
  tracker_lost = false;
}

static void hub_bytes(const void *bytes, size_t length) {
  if (!sock_open) return;
  if (TO_DEV_CAP - (to_dev_tail - to_dev_head) < length) return; /* Hub's socket buffer is full: the frame is not written */
  if (TO_DEV_CAP - to_dev_tail < length) {
    memmove(to_dev, to_dev + to_dev_head, to_dev_tail - to_dev_head);
    to_dev_tail -= to_dev_head;
    to_dev_head = 0;
  }
  memcpy(to_dev + to_dev_tail, bytes, length);
  to_dev_tail += length;
}

static size_t hub_pending(void) { return to_dev_tail - to_dev_head; }

/* One frame toward the device; the header is written as given (no checks). */
static bool hub_frame_raw(uint8_t type, uint8_t flags, uint16_t reserved, uint32_t length_field, uint32_t id, const void *payload, size_t payload_length) {
  uint8_t header[12];
  if (!sock_open || TO_DEV_CAP - hub_pending() < 12 + payload_length) return false;
  header[0] = type;
  header[1] = flags;
  header[2] = (uint8_t)reserved;
  header[3] = (uint8_t)(reserved >> 8);
  put_u32(header + 4, length_field);
  put_u32(header + 8, id);
  hub_bytes(header, 12);
  if (payload_length > 0) hub_bytes(payload, payload_length);
  hub_frames += 1;
  if (type == LINK2_FRAME_REQUEST) {
    IdInfo *i = info(id);
    i->requests_sent += 1;
    i->hub_app_request = (flags & LINK2_FLAG_APP) != 0 && payload_length >= 4;
    if (i->hub_app_request) i->chan = link2_read_u32(payload);
  }
  if (type == LINK2_FRAME_REPLY) {
    /* Whatever sent it, a REPLY ends a request of the device; one without ERROR opens a channel. */
    IdInfo *i = info(id);
    if (i->dev_request && !i->dev_replied) {
      i->dev_replied = true;
      if (i->dev_kind == 5 && (flags & LINK2_FLAG_ERROR) == 0) {
        i->is_channel = true;
        i->channel_open = true;
        last_channel = id;
      }
    }
  }
  trace("  hub> type=%02x flags=%x len=%u id=%08x %.*s", type, flags, length_field, id, (int)(payload_length > 90 ? 90 : payload_length),
        (type == 0x10 || type == 0x11 || type == 0x12 || type == 4) ? (const char *)payload + ((flags & 2) && type != 0x11 ? 4 : 0) : "");
  return true;
}
static bool hub_frame(uint8_t type, uint8_t flags, uint32_t id, const void *payload, size_t length) {
  return hub_frame_raw(type, flags, 0, (uint32_t)length, id, payload, length);
}
static bool hub_json(uint8_t type, uint8_t flags, uint32_t id, const char *json) { return hub_frame(type, flags, id, json, strlen(json)); }
static bool hub_app_json(uint8_t type, uint8_t flags, uint32_t id, uint32_t channel, const char *json, size_t length) {
  static uint8_t buffer[40000];
  if (length > sizeof buffer - 4) length = sizeof buffer - 4;
  put_u32(buffer, channel);
  memcpy(buffer + 4, json, length);
  return hub_frame(type, flags | LINK2_FLAG_APP, id, buffer, length + 4);
}
static bool hub_credit(uint32_t id, uint32_t amount) {
  uint8_t p[4];
  put_u32(p, amount);
  if (!hub_frame(LINK2_FRAME_CREDIT, 0, id, p, 4)) return false;
  IdInfo *i = info(id);
  if (i->is_channel && i->channel_open) i->units_to_dev += amount;
  else i->cr_to_dev += amount;
  return true;
}
static bool hub_reset(uint32_t id, uint16_t code) {
  uint8_t p[4] = {(uint8_t)code, (uint8_t)(code >> 8), 0, 0};
  return hub_frame(LINK2_FRAME_RESET, 0, id, p, 4);
}
static bool hub_data(uint32_t id, const uint8_t *bytes, uint32_t length, bool end) {
  if (!hub_frame(LINK2_FRAME_DATA, end ? LINK2_FLAG_END : 0, id, bytes, length)) return false;
  IdInfo *i = info(id);
  i->cr_from_dev = i->cr_from_dev > length ? i->cr_from_dev - length : 0;
  return true;
}
static uint32_t hub_fresh_id(void) { return hub_next_id++; }
static bool hub_request(uint32_t id, const char *json) {
  if (!hub_json(LINK2_FRAME_REQUEST, 0, id, json)) return false;
  last_hub_request = id;
  return true;
}
static bool hub_app_request(uint32_t id, uint32_t channel, const char *json, size_t length, bool body) {
  if (!hub_app_json(LINK2_FRAME_REQUEST, body ? LINK2_FLAG_BODY : 0, id, channel, json, length)) return false;
  last_hub_app_request = id;
  return true;
}

static void hub_send_ready(void) {
  char json[600];
  snprintf(json, sizeof json, "{\"t\":\"ready\",\"name\":\"Sim Hub\",\"features\":[%s],\"maxPayload\":%u,\"clock\":{\"utc\":1790000000000,\"local\":1790000000000}}", ready_features,
           (unsigned)ready_payload);
  hub_json(LINK2_FRAME_HANDSHAKE, 0, 0, json);
}

static void hub_send_challenge(bool good) {
  static const uint8_t PRE[8] = {'P', 'K', 'L', 'K', 2, 2, 2, 0};
  uint8_t proof[32];
  char proof_hex[65], json[300];
  const char *nonce = "00112233445566778899aabbccddeeff";
  link2_proof(HUB_KEY, LINK2_LABEL_COMPANION, dev_nonce, nonce, dev_id, HUB_ID, proof);
  if (!good) proof[3] ^= 1;
  hex_encode(proof, 32, proof_hex);
  snprintf(json, sizeof json, "{\"t\":\"challenge\",\"nonce\":\"%s\",\"proof\":\"%s\"}", nonce, proof_hex);
  hub_bytes(PRE, 8);
  hub_json(LINK2_FRAME_HANDSHAKE, 0, 0, json);
}

/* What the scripted Hub does with a frame of the device once linked; the driver may add to it. */
static void (*on_device_frame)(uint8_t type, uint8_t flags, uint32_t id, const uint8_t *payload, uint32_t length);

static void hub_on_frame(uint8_t type, uint8_t flags, uint32_t id, const uint8_t *payload, uint32_t length) {
  device_frames += 1;
  trace("  dev> type=%02x flags=%x len=%u id=%08x %.*s", type, flags, length, id, (int)(length > 90 ? 90 : length),
        (type == 0x10 || type == 0x11 || type == 0x12 || type == 4) ? (const char *)payload + ((flags & 2) && type != 0x11 ? 4 : 0) : "");
  if (type == LINK2_FRAME_CLOSE) {
    device_sent_close = true;
    device_close_code = link2_read_u16(payload);
    /* Counted across connections: a scenario asks whether a CLOSE ever left. */
    device_closes += 1;
    return;
  }
  if (hub_state < 3) {
    if (type != LINK2_FRAME_HANDSHAKE) die("the device sent frame type %u before ready", type);
    JsonSpan object = json_span((const char *)payload, length);
    char t[16] = "";
    json_find_string(object, "t", t, sizeof t);
    if (hub_state == 1) {
      uint64_t offer = 0;
      if (strcmp(t, "hello") != 0) die("the first handshake frame is not hello");
      if (!json_find_string(object, "nonce", dev_nonce, sizeof dev_nonce) || !json_find_string(object, "device", dev_id, sizeof dev_id) || !json_find_u64(object, "maxPayload", &offer))
        die("hello lacks a field");
      hub_limit = link2_payload_limit(offer, ready_payload);
      hub_state = 2;
      if (hello_hook != NULL && hello_hook()) return;
      if (hub_auto) hub_send_challenge(true);
    } else {
      if (strcmp(t, "auth") != 0) die("the second handshake frame is not auth");
      hub_state = 3;
      if (auth_hook != NULL && auth_hook()) return;
      if (hub_auto) hub_send_ready();
    }
    return;
  }
  IdInfo *i = info(id);
  if (tracker_lost && type != LINK2_FRAME_PING && type != LINK2_FRAME_HANDSHAKE) {
    if (on_device_frame != NULL) on_device_frame(type, flags, id, payload, length);
    return;
  }
  switch (type) {
    case LINK2_FRAME_HANDSHAKE:
      die("HANDSHAKE after ready");
      break;
    case LINK2_FRAME_PING:
      if (!hub_mute) hub_frame(LINK2_FRAME_PONG, 0, 0, payload, 4);
      break;
    case LINK2_FRAME_REQUEST: {
      bool app = (flags & LINK2_FLAG_APP) != 0;
      const char *json = (const char *)payload + (app ? 4 : 0);
      uint32_t n = length - (app ? 4 : 0);
      char t[80] = "";
      if (link2_id_range(id) != LINK2_RANGE_DEVICE) die("a device REQUEST with id %08x outside its range", id);
      if (i->dev_request || i->dev_stream_id || i->is_channel) die("the device reused id %u for a REQUEST", id);
      if (!json_is_object(json_span(json, n)) || !json_find_string(json_span(json, n), "t", t, sizeof t)) die("a device REQUEST without a string t");
      i->dev_request = true;
      last_dev_request = id;
      if (app) {
        uint32_t channel = link2_read_u32(payload);
        if (!info(channel)->is_channel && !lenient) die("a device REQUEST APP names channel %u that never opened", channel);
        if (n > link2_app_message_limit(hub_limit)) die("a device APP object of %u bytes is over LINK_APP_MSG", n);
        i->dev_kind = 6;
        i->chan = channel;
        last_dev_app_request = id;
      } else if (strcmp(t, "catalog") == 0) {
        i->dev_kind = 1;
        last_catalog = id;
      } else if (strcmp(t, "install") == 0) {
        i->dev_kind = 2;
        last_install = id;
      } else if (strcmp(t, "net.http") == 0) {
        i->dev_kind = 3;
        last_http = id;
      } else if (strcmp(t, "devtools.open") == 0) {
        i->dev_kind = 4;
        last_devtools = id;
      } else if (strcmp(t, "channel.open") == 0) {
        i->dev_kind = 5;
      } else die("an unknown device request %s", t);
      break;
    }
    case LINK2_FRAME_REPLY:
      i->replies_seen += 1;
      if (i->replies_seen > i->requests_sent && !lenient) die("REPLY %u for id %08x: %u replies for %u requests", id, id, i->replies_seen, i->requests_sent);
      break;
    case LINK2_FRAME_EVENT: {
      bool app = (flags & LINK2_FLAG_APP) != 0;
      uint32_t n = length - (app ? 4 : 0);
      if (app) {
        uint32_t channel = link2_read_u32(payload);
        IdInfo *c = info(channel);
        if (!c->is_channel && !lenient) die("a device EVENT APP names channel %u that never opened", channel);
        if (n > link2_app_message_limit(hub_limit)) die("a device APP event of %u bytes is over LINK_APP_MSG", n);
        uint32_t cost = link2_event_units(n);
        if (cost > c->units_to_dev && !lenient) die("the device spent %u event units on channel %u with %llu granted", cost, channel, (unsigned long long)c->units_to_dev);
        c->units_to_dev = c->units_to_dev > cost ? c->units_to_dev - cost : 0;
        if (id != 0) {
          if (link2_id_range(id) != LINK2_RANGE_DEVICE || i->dev_request || i->dev_stream_id || i->is_channel) die("a device stream-opening event reused id %u", id);
          i->dev_stream_id = true;
          last_dev_stream = id;
        }
      } else if (id != 0 && i->hub_app_request) {
        IdInfo *c = info(i->chan);
        uint32_t cost = link2_event_units(n);
        if (cost > c->units_to_dev && !lenient) die("the device spent %u event units (progress) on channel %u with %llu granted", cost, i->chan, (unsigned long long)c->units_to_dev);
        c->units_to_dev = c->units_to_dev > cost ? c->units_to_dev - cost : 0;
      } else if (id != 0 && i->is_channel) {
        i->channel_open = false; /* channel.close */
      } else if (id != 0 && link2_id_range(id) == LINK2_RANGE_DEVICE && !i->dev_request) {
        if (i->dev_stream_id) die("a device stream-opening event reused id %u", id);
        i->dev_stream_id = true;
        last_dev_stream = id;
      }
      break;
    }
    case LINK2_FRAME_DATA:
      if (length > i->cr_to_dev && !lenient) die("the device sent %u DATA bytes on id %08x with %llu credit", length, id, (unsigned long long)i->cr_to_dev);
      i->cr_to_dev = i->cr_to_dev > length ? i->cr_to_dev - length : 0;
      break;
    case LINK2_FRAME_CREDIT: {
      uint32_t amount = link2_read_u32(payload);
      if (amount == 0) die("the device sent CREDIT 0");
      if (i->is_channel) i->units_from_dev += amount;
      else i->cr_from_dev += amount;
      if (i->cr_from_dev > LINK2_MAX_CREDIT && !lenient) die("the device granted %llu bytes outstanding on id %08x", (unsigned long long)i->cr_from_dev, id);
      if (i->units_from_dev > LINK2_APP_EVENT_WINDOW && hostility == 0) die("the device granted %llu event units outstanding on channel %u", (unsigned long long)i->units_from_dev, id);
      break;
    }
    default:
      break;
  }
  if (on_device_frame != NULL) on_device_frame(type, flags, id, payload, length);
}

static void hub_parse(void) {
  size_t at = 0;
  if (hub_state == 0) {
    if (hub_rx_fill < 8) return;
    if (link2_read_u32(hub_rx) != LINK2_MAGIC || hub_rx[4] != 2 || hub_rx[5] != 2 || hub_rx[6] != 0) die("a bad device preamble");
    at = 8;
    hub_state = 1;
  }
  while (hub_rx_fill - at >= 12) {
    uint8_t type = hub_rx[at], flags = hub_rx[at + 1];
    uint32_t length = link2_read_u32(hub_rx + at + 4), id = link2_read_u32(hub_rx + at + 8);
    uint32_t limit = hub_state == 3 ? hub_limit : LINK2_MAX_HANDSHAKE;
    if (link2_read_u16(hub_rx + at + 2) != 0) die("a device frame with a non-zero reserved field");
    if (type != 1 && type != 2 && type != 3 && type != 4 && type != 0x10 && type != 0x11 && type != 0x12 && type != 0x13 && type != 0x20 && type != 0x21 && type != 0x22)
      die("a device frame of unknown type %02x (stream desynchronised?)", type);
    if (length > limit) die("a device frame of type %02x with length %u over the limit %u", type, length, limit);
    uint32_t bad = link2_check_frame(type, flags, id, length);
    if (bad != 0) die("a device frame breaks the header rules: type %02x flags %x id %08x length %u", type, flags, id, length);
    if (hub_rx_fill - at < 12 + (size_t)length) break;
    if ((type == LINK2_FRAME_CLOSE || type == LINK2_FRAME_RESET) && link2_read_u16(hub_rx + at + 14) != 0) die("a device CLOSE/RESET with a non-zero second u16");
    if ((type == 0x10 || type == 0x11 || type == 0x12) && hub_rx[at + 12 + ((flags & LINK2_FLAG_APP) && type != 0x11 ? 4 : 0)] != '{') die("a device JSON frame that does not start with {");
    hub_on_frame(type, flags, id, hub_rx + at + 12, length);
    at += 12 + length;
  }
  memmove(hub_rx, hub_rx + at, hub_rx_fill - at);
  hub_rx_fill -= at;
}

// ---------------------------------------------------------------------------
// the platform
// ---------------------------------------------------------------------------

static int connect_result = 5; /* -1 makes the connect fail */
static uint64_t p_now(void *context) {
  (void)context;
  return vnow;
}
static void p_random(void *context, uint8_t *out, size_t length) {
  (void)context;
  for (size_t i = 0; i < length; i += 1) out[i] = (uint8_t)rnd();
}
static int p_tcp_connect(void *context, const char *address, uint16_t port) {
  (void)context;
  touch(address, strlen(address));
  (void)port;
  if (connect_result < 0) return -1;
  if (sock_open) die("tcp_connect with a socket still open: a leaked handle");
  sock_open = true;
  sock_fail = false;
  connection_reset();
  trace("-- tcp connect");
  return connect_result;
}
static int p_tcp_connected(void *context, int handle) {
  (void)context;
  if (handle != connect_result || !sock_open) die("tcp_connected on a handle that is not open");
  return 1;
}
static long p_tcp_send(void *context, int handle, const uint8_t *bytes, size_t length) {
  (void)context;
  if (handle != connect_result || !sock_open) die("tcp_send on a handle that is not open");
  if (length == 0) die("tcp_send of 0 bytes");
  touch(bytes, length);
  if (sock_fail) return -1;
  size_t take = length;
  if (accept_mode == 2) take = 0;
  if (accept_mode == 1 && take > accept_trickle) take = accept_trickle;
  if (take > sizeof hub_rx - hub_rx_fill) take = sizeof hub_rx - hub_rx_fill;
  if (take == 0) return 0;
  memcpy(hub_rx + hub_rx_fill, bytes, take);
  hub_rx_fill += take;
  device_bytes += take;
  device_crc = link2_crc32(device_crc, bytes, take);
  hub_parse();
  /* A real socket reports "would block" after a partial write; one send per call keeps the loop honest. */
  return (long)take;
}
static long p_tcp_recv(void *context, int handle, uint8_t *into, size_t capacity) {
  (void)context;
  if (handle != connect_result || !sock_open) die("tcp_recv on a handle that is not open");
  if (capacity == 0) die("tcp_recv with capacity 0");
  if (sock_fail) return -1;
  size_t n = hub_pending();
  if (n > capacity) n = capacity;
  if (recv_mode == 1 && n > 1) n = 1;
  if (recv_mode == 2 && n > 1) n = 1 + rn((uint32_t)n);
  memcpy(into, to_dev + to_dev_head, n);
  to_dev_head += n;
  return (long)n;
}
static void p_tcp_close(void *context, int handle) {
  (void)context;
  if (handle != connect_result || !sock_open) die("tcp_close on a handle that is not open (double close)");
  sock_open = false;
  hub_rx_fill = 0;
  trace("-- tcp close");
}
static bool udp_open_now;
static int udp_opens;     /* sockets opened so far */
static int udp_fail_next; /* this many udp_recv calls report a failed socket */
static int p_udp_open(void *context, uint16_t port) {
  (void)context;
  (void)port;
  if (udp_open_now) die("udp_open with the socket still open");
  udp_open_now = true;
  udp_opens += 1;
  return 9;
}
static long p_udp_recv(void *context, int handle, uint8_t *into, size_t capacity, char address[16]) {
  (void)context;
  if (handle != 9 || !udp_open_now) die("udp_recv on a closed handle");
  if (udp_fail_next > 0) {
    udp_fail_next -= 1;
    return -1;
  }
  if (!beacon_on || rn(4) != 0 || capacity < 64) return 0;
  memset(into, 0, 64);
  put_u32(into, LINK2_BEACON_MAGIC);
  into[4] = 2;
  into[6] = (uint8_t)(8628 & 255);
  into[7] = (uint8_t)(8628 >> 8);
  memcpy(into + 8, HUB_ID, 16);
  memcpy(into + 24, "Sim Hub", 7);
  strcpy(address, "10.0.0.2");
  return 64;
}
static void p_udp_close(void *context, int handle) {
  (void)context;
  if (handle != 9 || !udp_open_now) die("udp_close on a closed handle");
  udp_open_now = false;
}

// ---------------------------------------------------------------------------
// host stubs with begin/end pairing checks
// ---------------------------------------------------------------------------

static Link2 *L;
static int push_open, native_open, shot_open, installs_open, https_open, sys_streams_open, linked_now;
static uint32_t ev_linked, ev_unlinked, ev_restart, ev_catalog_done, ev_http_end, ev_install_end;
static uint32_t shot_bytes = 400u * 240u * 3u;
static uint32_t status_pad;
static size_t app_rows = 3;
static bool host_fail_some;
static void (*reenter_status)(void); /* runs inside runtime_status, when set */
static void (*reenter_http_end)(void);
static char last_why[80];

static void h_linked(void *c, const char *hub, const char *why) {
  (void)c;
  if (hub != NULL) {
    touch(hub, strlen(hub));
    linked_now = 1;
    ev_linked += 1;
  } else {
    touch(why, strlen(why));
    snprintf(last_why, sizeof last_why, "%s", why);
    linked_now = 0;
    ev_unlinked += 1;
  }
  trace("-- host.linked %s %s", hub ? hub : "(down)", why ? why : "");
}
static void h_status(void *c, Link2Json *m) {
  (void)c;
  link2_json_text(m, "\"phase\":\"booted\",\"frame\":4242");
  if (status_pad > 0) {
    link2_json_text(m, ",\"pad\":\"");
    for (uint32_t i = 0; i < status_pad; i += 1) link2_json_text(m, "x");
    link2_json_text(m, "\"");
  }
  if (reenter_status != NULL) reenter_status();
}
static uint32_t h_generation(void *c) {
  (void)c;
  return 3;
}
static char app_text[64][4][140];
static uint32_t apps_calls;
static size_t h_apps(void *c, Link2InstalledApp *rows, size_t capacity) {
  (void)c;
  apps_calls += 1;
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
static bool h_push_begin(void *c, uint32_t bytes, const char *hash, Link2Failure *f) {
  (void)c;
  (void)bytes;
  (void)f;
  touch(hash, strlen(hash));
  if (push_open) die("push_begin while a staging file is open");
  if (host_fail_some && rn(10) == 0) return false;
  push_open = 1;
  return true;
}
static bool h_push_data(void *c, const uint8_t *bytes, size_t length) {
  (void)c;
  touch(bytes, length);
  if (!push_open) die("push_data without an open staging file");
  return !(host_fail_some && rn(40) == 0);
}
static uint32_t commit_members = 60;
static bool h_push_commit(void *c, Link2Json *m, Link2Failure *f) {
  (void)c;
  if (!push_open) die("push_commit without an open staging file");
  push_open = 0;
  if (host_fail_some && rn(6) == 0) {
    snprintf(f->code, sizeof f->code, "rejected");
    snprintf(f->message, sizeof f->message, "no");
    return false;
  }
  link2_json_text(m, "\"generation\":4,\"message\":\"\",\"app\":{\"id\":\"PUSHMEMBERS");
  for (uint32_t i = 0; i < commit_members; i += 1) link2_json_text(m, "p");
  link2_json_text(m, "\"}");
  return true;
}
static void h_push_abort(void *c) {
  (void)c;
  if (!push_open) die("push_abort without an open staging file");
  push_open = 0;
}
static bool h_native_begin(void *c, const char *name, uint32_t bytes, uint32_t crc32, bool launch, Link2Failure *f) {
  (void)c;
  (void)crc32;
  (void)launch;
  (void)bytes;
  (void)f;
  touch(name, strlen(name));
  if (native_open) die("native_begin while a staging file is open");
  if (host_fail_some && rn(10) == 0) return false;
  native_open = 1;
  return true;
}
static bool h_native_data(void *c, const uint8_t *bytes, size_t length) {
  (void)c;
  touch(bytes, length);
  if (!native_open) die("native_data without an open staging file");
  return !(host_fail_some && rn(40) == 0);
}
static bool native_launching;
static bool h_native_commit(void *c, const char *name, bool launch, char phase[16], char path[128], Link2Failure *f) {
  (void)c;
  (void)f;
  if (!native_open) die("native_commit without an open staging file");
  native_open = 0;
  snprintf(phase, 16, "%s", launch && native_launching ? "launching" : "installed");
  snprintf(path, 128, "sdmc:/3ds/%s", name);
  return !(host_fail_some && rn(6) == 0);
}
static void h_native_abort(void *c) {
  (void)c;
  if (!native_open) die("native_abort without an open staging file");
  native_open = 0;
}
static bool h_launch(void *c, const char *native, const char *app, Link2Json *m, bool *launching, Link2Failure *f) {
  (void)c;
  if (native != NULL) touch(native, strlen(native));
  if (app != NULL) touch(app, strlen(app));
  if (host_fail_some && rn(4) == 0) {
    snprintf(f->code, sizeof f->code, "not_found");
    return false;
  }
  if (native != NULL && native_launching) *launching = true;
  link2_json_text(m, "\"phase\":\"switching\",\"output\":\"x\"");
  return true;
}
static void h_restart(void *c) {
  (void)c;
  ev_restart += 1;
}
static uint32_t shot_at, shot_members = 40;
static bool h_shot_begin(void *c, Link2Json *m, uint32_t *frame, uint32_t *bytes) {
  (void)c;
  if (shot_open) note("shot-leak", "screenshot_begin while a capture is open: the previous one was never ended");
  if (host_fail_some && rn(10) == 0) return false;
  shot_open = 1;
  shot_at = 0;
  *frame = 777;
  *bytes = shot_bytes;
  link2_json_text(m, "\"frame\":777,\"format\":\"SHOTMEMBERS");
  for (uint32_t i = 0; i < shot_members; i += 1) link2_json_text(m, "s");
  link2_json_text(m, "\",\"surfaces\":[]");
  return true;
}
static bool shot_short;
static size_t h_shot_read(void *c, uint8_t *into, size_t capacity) {
  (void)c;
  if (!shot_open) die("screenshot_read without a capture");
  if (shot_short && rn(8) == 0) return 0;
  memset(into, 0x5a, capacity);
  shot_at += (uint32_t)capacity;
  return capacity;
}
static void h_shot_end(void *c) {
  (void)c;
  if (!shot_open) die("screenshot_end without a capture (double end)");
  shot_open = 0;
}
static void h_catalog_page(void *c, const char *rows, size_t length, bool first) {
  (void)c;
  (void)first;
  touch(rows, length);
}
static void h_catalog_done(void *c, const char *error) {
  (void)c;
  if (error != NULL) touch(error, strlen(error));
  ev_catalog_done += 1;
}
static void h_catalog_changed(void *c) { (void)c; }
static bool h_install_begin(void *c, uint32_t request, const char *app, const char *hash, uint32_t bytes) {
  (void)c;
  (void)request;
  (void)bytes;
  touch(app, strlen(app));
  touch(hash, strlen(hash));
  if (host_fail_some && rn(10) == 0) return false;
  installs_open += 1;
  return true;
}
static bool h_install_data(void *c, uint32_t request, const uint8_t *bytes, size_t length) {
  (void)c;
  (void)request;
  touch(bytes, length);
  return !(host_fail_some && rn(40) == 0);
}
static void h_install_end(void *c, uint32_t request, const char *error) {
  (void)c;
  (void)request;
  if (error != NULL) touch(error, strlen(error));
  ev_install_end += 1;
}
static size_t h_http_body(void *c, uint32_t request, size_t offset, uint8_t *into, size_t capacity) {
  (void)c;
  (void)request;
  (void)offset;
  memset(into, 0x42, capacity);
  return capacity;
}
static void h_http_head(void *c, uint32_t request, const char *json, size_t length) {
  (void)c;
  (void)request;
  touch(json, length);
}
static uint32_t ev_http_head_unused;
static uint32_t http_held[64];
static uint32_t http_ids[64];
static uint32_t ev_http_data, ev_http_head;
static void h_http_data(void *c, uint32_t request, const uint8_t *bytes, size_t length) {
  (void)c;
  touch(bytes, length);
  ev_http_data += 1;
  for (int i = 0; i < 64; i += 1) {
    if (http_ids[i] == request) http_held[i] += (uint32_t)length;
  }
}
static void h_http_end(void *c, uint32_t request, const char *error) {
  (void)c;
  if (error != NULL) touch(error, strlen(error));
  for (int i = 0; i < 64; i += 1) {
    if (http_ids[i] == request) http_ids[i] = 0;
  }
  ev_http_end += 1;
  if (reenter_http_end != NULL) reenter_http_end();
}
static void h_system_event(void *c, const char *t, const char *json, size_t length) {
  (void)c;
  touch(t, strlen(t));
  touch(json, length);
}
static uint32_t sys_ids[40];
static uint32_t h_stream_open(void *c, uint32_t id, const char *t, const char *json, size_t length) {
  (void)c;
  uint64_t bytes = 0;
  touch(t, strlen(t));
  touch(json, length);
  if (!json_find_u64(json_span(json, length), "bytes", &bytes) || bytes == 0 || bytes > LINK2_MAX_CREDIT) return 0;
  for (int i = 0; i < 40; i += 1) {
    if (sys_ids[i] != 0) continue;
    sys_ids[i] = id;
    sys_streams_open += 1;
    return (uint32_t)bytes;
  }
  return 0;
}
static bool h_stream_data(void *c, uint32_t id, const uint8_t *bytes, size_t length) {
  (void)c;
  bool known = false;
  touch(bytes, length);
  for (int i = 0; i < 40; i += 1) known = known || sys_ids[i] == id;
  if (!known) die("stream_data for a stream the host does not hold");
  return !(host_fail_some && rn(40) == 0);
}
static void h_stream_end(void *c, uint32_t id, bool complete) {
  (void)c;
  (void)complete;
  for (int i = 0; i < 40; i += 1) {
    if (sys_ids[i] != id) continue;
    sys_ids[i] = 0;
    sys_streams_open -= 1;
    return;
  }
  die("stream_end for a stream the host does not hold (double end)");
}

static char sim_dir[200];
static const char *sim_features[16] = {"runtime", "runtime.native", "devtools", "catalog", "install", "net.http", "agent", "channel", "apps"};
static size_t sim_feature_count = 9;

static void write_text(const char *path, const char *text) {
  FILE *f = fopen(path, "wb");
  if (f == NULL) {
    perror(path);
    exit(4);
  }
  fwrite(text, 1, strlen(text), f);
  fclose(f);
}

static void sim_files(void) {
  char path[400], text[400], key[65];
  const char *base = getenv("LINK2_SIM_DIR");
  snprintf(sim_dir, sizeof sim_dir, "%s/link2-sim-%d", base != NULL && base[0] != '\0' ? base : "/tmp", (int)getpid());
  mkdir(sim_dir, 0755);
  snprintf(path, sizeof path, "%s/companions", sim_dir);
  mkdir(path, 0755);
  snprintf(path, sizeof path, "%s/device.txt", sim_dir);
  write_text(path, "1111222233334444\n");
  hex_encode(HUB_KEY, 32, key);
  snprintf(text, sizeof text, "key=%s\nname=Sim Hub\naddress=10.0.0.2\nport=8628\n", key);
  snprintf(path, sizeof path, "%s/companions/%s.txt", sim_dir, HUB_ID);
  write_text(path, text);
}

static Link2 *sim_create(uint32_t max_payload, uint32_t channels) {
  Link2Platform platform = {NULL, p_now, p_random, p_tcp_connect, p_tcp_connected, p_tcp_send, p_tcp_recv, p_tcp_close, p_udp_open, p_udp_recv, p_udp_close};
  Link2Host host;
  memset(&host, 0, sizeof host);
  host.name = "Sim 3DS";
  host.model = "New Nintendo 3DS XL";
  host.target = "3ds-dev";
  host.host_abi = 12;
  host.directory = sim_dir;
  host.features = sim_features;
  host.feature_count = sim_feature_count;
  host.max_payload = max_payload;
  host.max_channels = channels;
  host.linked = h_linked;
  host.runtime_status = h_status;
  host.runtime_generation = h_generation;
  host.runtime_apps = h_apps;
  host.push_begin = h_push_begin;
  host.push_data = h_push_data;
  host.push_commit = h_push_commit;
  host.push_abort = h_push_abort;
  host.native_begin = h_native_begin;
  host.native_data = h_native_data;
  host.native_commit = h_native_commit;
  host.native_abort = h_native_abort;
  host.launch = h_launch;
  host.restart = h_restart;
  host.screenshot_begin = h_shot_begin;
  host.screenshot_read = h_shot_read;
  host.screenshot_end = h_shot_end;
  host.catalog_page = h_catalog_page;
  host.catalog_done = h_catalog_done;
  host.catalog_changed = h_catalog_changed;
  host.install_begin = h_install_begin;
  host.install_data = h_install_data;
  host.install_end = h_install_end;
  host.http_body = h_http_body;
  host.http_head = h_http_head;
  host.http_data = h_http_data;
  host.http_end = h_http_end;
  host.system_event = h_system_event;
  host.stream_open = h_stream_open;
  host.stream_data = h_stream_data;
  host.stream_end = h_stream_end;
  for (size_t i = 0; i < 64; i += 1) {
    snprintf(app_text[i][0], 140, "dev.example.applet-%02u", (unsigned)i);
    snprintf(app_text[i][1], 140, "applet-%02u", (unsigned)i);
    snprintf(app_text[i][2], 140, "1.0.%u", (unsigned)i);
    snprintf(app_text[i][3], 140, "%016x", (unsigned)i);
  }
  if (to_dev == NULL) to_dev = malloc(TO_DEV_CAP);
  return link2_create(&platform, &host);
}

// ---------------------------------------------------------------------------
// invariants over the client's private state
// ---------------------------------------------------------------------------

static void check_link(const Link2 *link, const char *where) {
  if (link->tx_head > link->tx_tail || link->tx_tail > link->tx_capacity) die("%s: send buffer indices head=%u tail=%u capacity=%u", where, link->tx_head, link->tx_tail, link->tx_capacity);
  if (link->rx_chunk_at > link->rx_chunk_fill || link->rx_chunk_fill > RX_CHUNK) die("%s: rx chunk indices", where);
  if (link->reader.fill > link->reader.want || link->reader.want > link->reader.limit || link->reader.limit > link->offer) die("%s: reader indices fill=%u want=%u limit=%u", where, link->reader.fill, link->reader.want, link->reader.limit);
  if (link->devtools && (link->dt_in_head > link->dt_in_tail || link->dt_in_tail > LINK2_DEVTOOLS_RING || link->dt_out_fill > LINK2_DEVTOOLS_LINE_OUT)) die("%s: devtools buffers", where);
  if (link->phase < PHASE_IDLE || link->phase > PHASE_BACKOFF) die("%s: phase %d", where, link->phase);
  if ((link->tcp >= 0) != sock_open) die("%s: the client's handle %d and the socket's state %d disagree", where, link->tcp, (int)sock_open);
  long expect = 0;
  for (size_t c = 0; c < link->channel_count; c += 1) {
    const Channel *channel = &link->channels[c];
    if (!channel->used) continue;
    if (channel->in_head > channel->in_tail || channel->in_tail > INBOX_BYTES) die("%s: inbox indices", where);
    if (channel->state != LINK2_CHANNEL_OPEN && channel->inbox != NULL) die("%s: a closed channel holds an inbox", where);
    if (channel->inbox != NULL) expect += INBOX_BYTES;
    if (channel->state == LINK2_CHANNEL_OPEN) {
      uint32_t queued = 0, waiting = 0, at = channel->in_head;
      while (at < channel->in_tail) {
        const uint8_t *e = channel->inbox + at;
        uint32_t length = link2_read_u32(e + 12);
        if (at + ENTRY_HEADER + length > channel->in_tail) die("%s: an inbox entry runs past the tail", where);
        if (e[0] == LINK2_MESSAGE_EVENT || e[0] == LINK2_MESSAGE_PROGRESS) queued += link2_read_u16(e + 2);
        if (e[0] == LINK2_MESSAGE_REQUEST) waiting += length;
        at += ENTRY_HEADER + length;
      }
      if (channel->ev_outstanding + channel->ev_owed + queued != LINK2_APP_EVENT_WINDOW)
        die("%s: event window of channel %u does not add up: outstanding %u + owed %u + queued %u != 48", where, (unsigned)c, channel->ev_outstanding, channel->ev_owed, queued);
      if (waiting != channel->waiting_requests) die("%s: waiting_requests %u but the inbox holds %u bytes of requests", where, channel->waiting_requests, waiting);
      if (count_in_streams(link, (int)c) > LINK2_CHANNEL_STREAMS || count_out_streams(link, (int)c) > LINK2_CHANNEL_STREAMS) die("%s: more than 4 streams on a channel", where);
    }
  }
  for (size_t i = 0; i < link->in_stream_count; i += 1) {
    const InStream *s = &link->in_streams[i];
    if (s->kind == IS_FREE) continue;
    if (s->buffer != NULL) {
      expect += LINK2_APP_STREAM_WINDOW;
      if (s->kind != IS_APP) die("%s: a non-applet stream holds a buffer", where);
      if ((uint64_t)s->head + s->ready + s->app.held > LINK2_APP_STREAM_WINDOW) die("%s: applet stream buffer overrun head=%u ready=%u held=%u", where, s->head, s->ready, s->app.held);
      if ((uint64_t)s->app.outstanding + s->app.held + s->ready > LINK2_APP_STREAM_WINDOW) die("%s: applet stream window exceeded outstanding=%u held=%u ready=%u", where, s->app.outstanding, s->app.held, s->ready);
    }
    if (s->kind != IS_APP && s->started && (uint64_t)s->outstanding > s->window) die("%s: stream %u outstanding %u over its window %u", where, s->id, s->outstanding, s->window);
    for (size_t j = i + 1; j < link->in_stream_count; j += 1) {
      if (link->in_streams[j].kind != IS_FREE && link->in_streams[j].id == s->id) die("%s: two inbound streams with id %08x", where, s->id);
    }
    if (s->kind == IS_APP && (s->channel < 0 || (size_t)s->channel >= link->channel_count || link->channels[s->channel].state != LINK2_CHANNEL_OPEN)) die("%s: an applet stream outlives its channel", where);
  }
  for (size_t i = 0; i < link->out_stream_count; i += 1) {
    const OutStream *s = &link->out_streams[i];
    if (s->kind == OS_FREE) continue;
    if (s->buffer != NULL) {
      expect += WRITER_BYTES;
      if (s->fill > WRITER_BYTES) die("%s: writer overrun", where);
    }
    if (s->kind == OS_APP && s->buffer == NULL) die("%s: an applet writer without a buffer", where);
    if (s->credit > LINK2_MAX_CREDIT) die("%s: credit over 16 MiB", where);
    for (size_t j = i + 1; j < link->out_stream_count; j += 1) {
      if (link->out_streams[j].kind != OS_FREE && link->out_streams[j].id == s->id) die("%s: two outbound streams with id %08x", where, s->id);
    }
    if (s->kind == OS_APP && (s->channel < 0 || (size_t)s->channel >= link->channel_count || link->channels[s->channel].state != LINK2_CHANNEL_OPEN)) die("%s: an applet writer outlives its channel", where);
  }
  for (size_t i = 0; i < link->out_count; i += 1) {
    const OutRequest *r = &link->out[i];
    if (r->kind == OR_FREE) continue;
    if (r->reply != NULL) expect += (long)r->reply_length;
    for (size_t j = i + 1; j < link->out_count; j += 1) {
      if (link->out[j].kind != OR_FREE && link->out[j].id == r->id) die("%s: two requests of this side with id %u", where, r->id);
    }
    if (link->phase != PHASE_LINKED) die("%s: a request of this side (id %u kind %u) survives outside the linked phase", where, r->id, r->kind);
    if (r->id >= link->next_id) die("%s: request id %u was never allocated on this connection (next id %u): a request of an earlier connection survived", where, r->id, link->next_id);
  }
  for (size_t i = 0; i < link->in_count; i += 1) {
    const InRequest *r = &link->in[i];
    if (r->kind == IR_FREE) continue;
    for (size_t j = i + 1; j < link->in_count; j += 1) {
      if (link->in[j].kind != IR_FREE && link->in[j].id == r->id) die("%s: two requests of Hub with id %08x", where, r->id);
    }
    if (link->phase != PHASE_LINKED) die("%s: a request of Hub survives outside the linked phase", where);
  }
  {
    int held = 0;
    for (size_t i = 0; i < link->in_stream_count; i += 1) held += link->in_streams[i].kind == IS_SYSTEM;
    if (link->phase == PHASE_LINKED && sys_streams_open > held) {
      note("sys-stream-leak-live", "%s: the host accepted %d agent streams, the client holds %d: one was dropped without stream_end", where, sys_streams_open, held);
      int extra = sys_streams_open - held;
      for (int k = 0; k < 40 && extra > 0; k += 1) {
        bool known = false;
        for (size_t i = 0; i < link->in_stream_count; i += 1) known = known || (link->in_streams[i].kind == IS_SYSTEM && link->in_streams[i].id == sys_ids[k]);
        if (sys_ids[k] != 0 && !known) {
          sys_ids[k] = 0;
          sys_streams_open -= 1;
          extra -= 1;
        }
      }
    }
  }
  if ((long)link->stats.channel_bytes != expect) {
    note("channel-bytes", "%s: stats.channel_bytes is %u, the channels hold %ld (peak %u)", where, link->stats.channel_bytes, expect, link->stats.channel_peak);
    ((Link2 *)link)->stats.channel_bytes = (uint32_t)expect;
  }
  if (link->phase != PHASE_LINKED) {
    if (push_open || native_open) die("%s: a staging file is still open after the link went down", where);
    if (shot_open) {
      note("shot-leak", "%s: a screenshot capture is still open after the link went down (screenshot_end never called)", where);
      shot_open = 0;
    }
    if (sys_streams_open != 0) {
      note("sys-stream-leak", "%s: %d agent streams the host accepted never got stream_end", where, sys_streams_open);
      sys_streams_open = 0;
      memset(sys_ids, 0, sizeof sys_ids);
    }
    if (link->catalog_running) die("%s: the catalog fetch survived the link", where);
  }
}

#endif
