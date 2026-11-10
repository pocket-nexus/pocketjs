/*
 * Pocket Link 2 wire facts (contracts/spec/link2.ts, docs/POCKET-LINK.md)
 * that need no sockets, no clock and no allocation: the constants, the
 * beacon, the preamble, the 12-byte frame header with a streaming reader,
 * the binary control frames, the handshake messages and their HMAC proofs,
 * the pairing files' readers, the reading of an EVENT by its header id, and
 * the credit and paging arithmetic. Portable C11: tests/pocket-link-2-c.test.ts
 * compiles it on the build machine and checks it against the conformance
 * vectors of tests/vectors/pocket-link-2/ and the reference codec.
 *
 * Version 1 (link_proto.h) stays beside this file while the 3DS program
 * speaks it.
 */

#ifndef POCKETJS_LINK2_PROTO_H
#define POCKETJS_LINK2_PROTO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "jscan.h"

// ---------------------------------------------------------------------------
// §2, §3 constants
// ---------------------------------------------------------------------------

#define LINK2_VERSION 2u
#define LINK2_BEACON_PORT 8627u
#define LINK2_PORT 8628u
#define LINK2_BEACON_MAGIC 0x424c4b50u /* 'PKLB' LE */
#define LINK2_BEACON_BYTES 64u
#define LINK2_BEACON_NAME_BYTES 40u

#define LINK2_SEARCH_DIRECT_MS 2500u
#define LINK2_CONNECT_TIMEOUT_MS 4000u
#define LINK2_HANDSHAKE_TIMEOUT_MS 6000u
#define LINK2_BACKOFF_MIN_MS 1000u
#define LINK2_BACKOFF_MAX_MS 8000u
#define LINK2_REFUSED_HOLD_MS 30000u

#define LINK2_ID_HEX 16u
#define LINK2_KEY_BYTES 32u
#define LINK2_NONCE_BYTES 16u
#define LINK2_MAX_COMPANIONS 8u
#define LINK2_LABEL_COMPANION "pocket-link/2/companion"
#define LINK2_LABEL_CONSOLE "pocket-link/2/console"

#define LINK2_NAME_BYTES 64u
#define LINK2_MODEL_BYTES 32u
#define LINK2_TARGET_BYTES 15u
#define LINK2_MAX_FEATURES 16u
#define LINK2_FEATURE_BYTES 24u

// ---------------------------------------------------------------------------
// §4 framing
// ---------------------------------------------------------------------------

#define LINK2_MAGIC 0x4b4c4b50u /* 'PKLK' LE */
#define LINK2_PREAMBLE_BYTES 8u
#define LINK2_HEADER_BYTES 12u

#define LINK2_FRAME_PING 0x01u
#define LINK2_FRAME_PONG 0x02u
#define LINK2_FRAME_CLOSE 0x03u
#define LINK2_FRAME_HANDSHAKE 0x04u
#define LINK2_FRAME_REQUEST 0x10u
#define LINK2_FRAME_REPLY 0x11u
#define LINK2_FRAME_EVENT 0x12u
#define LINK2_FRAME_CANCEL 0x13u
#define LINK2_FRAME_DATA 0x20u
#define LINK2_FRAME_CREDIT 0x21u
#define LINK2_FRAME_RESET 0x22u

#define LINK2_FLAG_ERROR 0x01u /* REPLY */
#define LINK2_FLAG_END 0x01u   /* DATA */
#define LINK2_FLAG_APP 0x02u   /* REQUEST, EVENT */
#define LINK2_FLAG_BODY 0x04u  /* REQUEST with APP */

#define LINK2_MAX_HANDSHAKE 1024u
#define LINK2_PAYLOAD_CEILING 32768u
#define LINK2_MIN_PAYLOAD 1024u
#define LINK2_TCP_PAYLOAD 16384u
#define LINK2_PING_BYTES 4u
#define LINK2_CLOSE_REASON_BYTES 120u

#define LINK2_PING_MS 3000u
#define LINK2_SILENCE_MS 10000u
#define LINK2_CLOSE_DRAIN_MS 1000u

/* §4.8 close codes; 0 is "no error" in this file's return values. */
#define LINK2_CLOSE_GOING_AWAY 1u
#define LINK2_CLOSE_PROTOCOL 2u
#define LINK2_CLOSE_TOO_LARGE 3u
#define LINK2_CLOSE_SILENCE 4u
#define LINK2_CLOSE_FLOW 5u
#define LINK2_CLOSE_AUTH 6u
#define LINK2_CLOSE_REPLACED 7u
#define LINK2_CLOSE_FORGOTTEN 8u
#define LINK2_CLOSE_RESTART 9u
#define LINK2_CLOSE_HANDSHAKE_TIMEOUT 11u
/* The name of a close code; an unknown code reads as "going_away". */
const char *link2_close_name(uint32_t code);

// ---------------------------------------------------------------------------
// §5 to §9 constants
// ---------------------------------------------------------------------------

#define LINK2_ID_HUB_BIT 0x80000000u
#define LINK2_ID_DEVICE_MAX 0x7fffffffu
#define LINK2_ERROR_MESSAGE_BYTES 240u
#define LINK2_REQUEST_STALL_MS 30000u
#define LINK2_CANCEL_GRACE_MS 10000u

#define LINK2_RESET_CANCELLED 1u
#define LINK2_RESET_REFUSED 2u
#define LINK2_RESET_LENGTH 3u
#define LINK2_RESET_STORAGE 4u
#define LINK2_RESET_SUPERSEDED 5u

#define LINK2_MAX_CREDIT (16u * 1024u * 1024u)
#define LINK2_WINDOW_BULK (64u * 1024u)
#define LINK2_WINDOW_HTTP (8u * 1024u)
#define LINK2_APP_STREAM_WINDOW (32u * 1024u)
#define LINK2_APP_EVENT_UNIT 512u
#define LINK2_APP_EVENT_WINDOW 48u

#define LINK2_FEATURES_INTERVAL_MS 1000u
#define LINK2_APPS_MAX_ROWS 64u
#define LINK2_APPS_INTERVAL_MS 1000u
#define LINK2_APP_ID_BYTES 128u
#define LINK2_APP_OUTPUT_BYTES 64u
#define LINK2_APP_VERSION_BYTES 32u
#define LINK2_PUSH_MAX_BYTES (24u * 1024u * 1024u)
#define LINK2_NATIVE_MIN_BYTES 32u
#define LINK2_NATIVE_MAX_BYTES (32u * 1024u * 1024u)
#define LINK2_NATIVE_NAME_MIN 6u
#define LINK2_NATIVE_NAME_MAX 64u
#define LINK2_LOG_TEXT_BYTES 1024u
#define LINK2_LOG_OVERHEAD 96u
#define LINK2_DEVTOOLS_LINE_OUT (64u * 1024u)
#define LINK2_DEVTOOLS_LINE_IN (16u * 1024u)
#define LINK2_DEVTOOLS_RING (4u * (LINK2_DEVTOOLS_LINE_IN + 1u))
#define LINK2_CATALOG_MAX_APPS 64u
#define LINK2_MAX_CATALOG_REQUESTS 4u
#define LINK2_INSTALL_MAX_BYTES (24u * 1024u * 1024u)
#define LINK2_HTTP_MIN_PAYLOAD 12288u
#define LINK2_HTTP_URL_BYTES 2048u
#define LINK2_HTTP_HEADERS_BYTES 8192u
#define LINK2_HTTP_MAX_BODY (64u * 1024u)
#define LINK2_HTTP_MAX_OPEN 8u

#define LINK2_MAX_CHANNELS 4u
#define LINK2_CHANNEL_BUSY_RETRY_MIN_MS 2000u
#define LINK2_CHANNEL_BUSY_RETRY_MAX_MS 60000u
#define LINK2_CHANNEL_REOPEN_MS 1000u
#define LINK2_CHANNEL_REQUESTS 8u
#define LINK2_CHANNEL_STREAMS 4u
#define LINK2_APP_MSG_CEILING 8192u
#define LINK2_APP_CHANNEL_PREFIX 4u
#define LINK2_APP_NAME_BYTES 64u
#define LINK2_APP_WAITING_REQUESTS 8192u
#define LINK2_APP_FRAME_MESSAGES 16u
#define LINK2_APP_FRAME_JSON 8192u
#define LINK2_APP_FRAME_STREAM (16u * 1024u)
#define LINK2_APP_OUTBOUND (64u * 1024u)

#define LINK2_TX_RESERVE 64u
#define LINK2_HUB_REQUESTS 8u
/* Received bytes one pump handles (version 1's LINK_RX_BUDGET). */
#define LINK2_RX_BUDGET (64u * 1024u)

// ---------------------------------------------------------------------------
// §2.2 beacon, §4.1 preamble
// ---------------------------------------------------------------------------

typedef struct {
  uint16_t port;
  char companion[LINK2_ID_HEX + 1];
  char name[LINK2_BEACON_NAME_BYTES + 1];
} Link2Beacon;
/* False for a datagram a version-2 device drops: not 64 bytes, another magic
 * or version, port 0, or an id that is not 16 lowercase hex digits. The flags
 * byte is ignored. */
bool link2_parse_beacon(const uint8_t *datagram, size_t length, Link2Beacon *out);

/* A lowercase 16-hex-digit id. */
bool link2_valid_id(const char *text, size_t length);

/* The preamble of a device whose range is version 2 alone. */
void link2_write_preamble(uint8_t out[LINK2_PREAMBLE_BYTES]);
/* Hub's preamble as the device reads it: the version to use, or 0 to close
 * (another magic, selected 0, or a selection outside the device's range). */
uint32_t link2_accept_preamble(const uint8_t bytes[LINK2_PREAMBLE_BYTES]);

// ---------------------------------------------------------------------------
// §4.2, §4.3 frames
// ---------------------------------------------------------------------------

void link2_write_header(uint8_t out[LINK2_HEADER_BYTES], uint8_t type, uint8_t flags, uint32_t length, uint32_t id);

/* 0 for neither range (0 and 0x80000000), 1 for the device's, 2 for Hub's. */
#define LINK2_RANGE_NONE 0
#define LINK2_RANGE_DEVICE 1
#define LINK2_RANGE_HUB 2
int link2_id_range(uint32_t id);

/* The header checks of §4.2 and §4.7 for one frame: 0, or the close code.
 * An unknown type passes (it is skipped by length). */
uint32_t link2_check_frame(uint8_t type, uint8_t flags, uint32_t id, uint32_t length);

typedef struct {
  uint8_t type;
  uint8_t flags;
  uint32_t id;
  const uint8_t *payload;
  uint32_t length;
} Link2Frame;

/*
 * Streaming frame reader over the caller's buffer (capacity at least the
 * payload limit it will put in force). Before link2_reader_ready only
 * HANDSHAKE, PING, PONG and CLOSE are valid and the limit is
 * LINK2_MAX_HANDSHAKE. A header whose length is over the limit is refused
 * before a payload byte is buffered. One call consumes input up to the end
 * of one frame, so the caller decides when the next frame is read.
 */
typedef struct {
  uint8_t header[LINK2_HEADER_BYTES];
  uint32_t header_fill;
  uint8_t *buffer;
  uint32_t capacity;
  uint32_t limit;
  uint32_t fill;
  uint32_t want;
  uint32_t skip;
  bool in_payload;
  bool linked;
  bool dead;
} Link2Reader;

#define LINK2_READ_MORE 0   /* every byte consumed, no whole frame yet */
#define LINK2_READ_FRAME 1  /* *frame is one whole frame, valid until the next call */
#define LINK2_READ_ERROR 2  /* *close is the code to close with; the reader is dead */

void link2_reader_init(Link2Reader *reader, uint8_t *buffer, uint32_t capacity);
/* `ready` was read: the negotiated payload limit applies from here. False
 * when the limit is outside 1,024..32,768 or over the buffer. */
bool link2_reader_ready(Link2Reader *reader, uint32_t limit);
int link2_reader_push(Link2Reader *reader, const uint8_t *bytes, size_t length, size_t *consumed, Link2Frame *frame, uint32_t *close);

/* Binary control frames, whole (header and payload), into `out`. Each
 * returns the frame's size. */
#define LINK2_PING_FRAME_BYTES (LINK2_HEADER_BYTES + LINK2_PING_BYTES)
#define LINK2_CREDIT_FRAME_BYTES (LINK2_HEADER_BYTES + 4u)
#define LINK2_RESET_FRAME_BYTES (LINK2_HEADER_BYTES + 4u)
#define LINK2_CLOSE_FRAME_MAX (LINK2_HEADER_BYTES + 4u + LINK2_CLOSE_REASON_BYTES)
size_t link2_write_ping(uint8_t *out, uint32_t counter);
size_t link2_write_pong(uint8_t *out, const uint8_t ping_payload[LINK2_PING_BYTES]);
/* `reason` is cut to 120 bytes on a code point. */
size_t link2_write_close(uint8_t *out, uint32_t code, const char *reason);
size_t link2_write_credit(uint8_t *out, uint32_t id, uint32_t amount);
size_t link2_write_reset(uint8_t *out, uint32_t id, uint32_t code);
size_t link2_write_cancel(uint8_t *out, uint32_t id);

uint32_t link2_read_u32(const uint8_t *bytes);
uint16_t link2_read_u16(const uint8_t *bytes);

/* LINK_APP_MSG for a connection: min(8,192, payload limit - 4). */
uint32_t link2_app_message_limit(uint32_t payload_limit);
/* Units an applet event costs: one per started 512 bytes of JSON. */
uint32_t link2_event_units(uint32_t json_bytes);
/* The payload limit of a connection: the smaller offer, or 0 when either is
 * outside 1,024..32,768. */
uint32_t link2_payload_limit(uint64_t hello_max, uint64_t ready_max);

// ---------------------------------------------------------------------------
// A bounded JSON writer into the caller's buffer
// ---------------------------------------------------------------------------

/* Writes what JSON.stringify writes: no whitespace, strings escaped as it
 * escapes them. A write past the capacity latches `failed`. */
typedef struct {
  char *out;
  size_t capacity;
  size_t length;
  bool failed;
} Link2Json;

void link2_json_init(Link2Json *json, char *out, size_t capacity);
void link2_json_raw(Link2Json *json, const char *text, size_t length);
void link2_json_text(Link2Json *json, const char *text);
void link2_json_string(Link2Json *json, const char *text, size_t length);
void link2_json_cstring(Link2Json *json, const char *text);
void link2_json_u64(Link2Json *json, uint64_t value);
/* Bytes `text` takes inside a JSON string: its encoded form without quotes. */
size_t link2_encoded_bytes(const char *text, size_t length);
/* The longest prefix of `text`, cut on a code point, whose encoded form fits
 * `max` bytes: the prefix's length in bytes. */
size_t link2_encoded_prefix(const char *text, size_t length, size_t max);

/* One element of a JSON array per call: `*at` starts at 0; false at the end
 * or on malformed input (`*malformed` says which). */
bool link2_array_next(JsonSpan array, size_t *at, JsonSpan *element, bool *malformed);
/* The span is one JSON string, raw (with its quotes). */
bool link2_is_string(JsonSpan value);

// ---------------------------------------------------------------------------
// §3.4, §3.5 handshake
// ---------------------------------------------------------------------------

/* HMAC-SHA256(key, label "\n" nD "\n" nC "\n" device "\n" companion). */
void link2_proof(
  const uint8_t key[LINK2_KEY_BYTES],
  const char *label,
  const char *device_nonce,
  const char *companion_nonce,
  const char *device,
  const char *companion,
  uint8_t out[32]
);

typedef struct {
  const char *device;
  const char *companion;
  const char *nonce; /* 32 hex digits */
  const char *name;  /* cut to 64 encoded bytes */
  const char *model; /* cut to 32 encoded bytes */
  const char *target;
  uint32_t host_abi;
  const char *const *features;
  size_t feature_count;
  uint32_t max_payload;
} Link2Hello;
/* The `hello` object into `json`. */
void link2_write_hello(Link2Json *json, const Link2Hello *hello);
void link2_write_auth(Link2Json *json, const char proof_hex[65]);

typedef struct {
  char nonce[2 * LINK2_NONCE_BYTES + 1];
  uint8_t proof[32];
} Link2Challenge;
bool link2_parse_challenge(JsonSpan object, Link2Challenge *out);

typedef struct {
  char features[LINK2_MAX_FEATURES][LINK2_FEATURE_BYTES + 1];
  size_t count;
} Link2Features;
/* A `features` list within its limits (§6.1): at most 16 non-empty strings
 * of at most 24 encoded bytes. */
bool link2_parse_features(JsonSpan array, Link2Features *out);
bool link2_features_has(const Link2Features *list, const char *name);

typedef struct {
  char name[LINK2_NAME_BYTES * 2 + 1];
  Link2Features features;
  uint32_t max_payload;
  uint64_t clock_utc;
  int64_t clock_local;
} Link2Ready;
/* The device's reading of `ready`: false closes with `protocol` (§3.4). */
bool link2_parse_ready(JsonSpan object, Link2Ready *out);
/* The `code` of a `refused` message into `code` (at most 24 bytes); false
 * when the object is not a refusal with a known code. */
bool link2_parse_refused(JsonSpan object, char *code, size_t capacity);

// ---------------------------------------------------------------------------
// §3.1, §3.6 pairing files
// ---------------------------------------------------------------------------

/* `device.txt`: 16 lowercase hex digits followed by nothing or by a run of
 * newline, carriage return and space. */
bool link2_parse_device_file(const char *text, size_t length, char id[LINK2_ID_HEX + 1]);

typedef struct {
  char id[LINK2_ID_HEX + 1];
  uint8_t key[LINK2_KEY_BYTES];
  char name[LINK2_NAME_BYTES + 1];
  char address[16];
  uint16_t port;
} Link2Companion;

/* The id a file name of `companions/` names when it is a key file
 * (16 lowercase hex digits and ".txt"). */
bool link2_key_file_id(const char *name, char id[LINK2_ID_HEX + 1]);
/* A key file: lines in any order, a final newline optional, unknown lines
 * skipped. False without a `key=` of 64 lowercase hex digits. A missing or
 * bad port reads as LINK2_PORT, a bad address as "". */
bool link2_parse_companion_file(const char *text, size_t length, Link2Companion *out);
/* A `.last` file parses when it holds an IPv4 address and a port; its name,
 * address and port then replace the key file's. */
bool link2_parse_last_file(const char *text, size_t length, Link2Companion *into);
/* The device's load of `companions/` (§3.6): key files in directory order, at
 * most 8, then each one's `.last` file over its name, address and port. */
typedef struct {
  Link2Companion list[LINK2_MAX_COMPANIONS];
  size_t count;
  /* A ninth loadable key file was found and ignored: a setup error. */
  bool overflow;
} Link2Companions;
/* One directory entry in directory order; files that are not loadable key
 * files are skipped. */
void link2_companions_add(Link2Companions *set, const char *file_name, const char *text, size_t length);
/* The text of `<id>.last` for a loaded companion. */
void link2_companions_last(Link2Companions *set, const char *id, const char *text, size_t length);

/* "name=…\naddress=…\nport=…\n", newlines in the name written as spaces. */
size_t link2_format_last_file(char *out, size_t capacity, const char *name, const char *address, uint16_t port);

// ---------------------------------------------------------------------------
// §5.3 reading an EVENT by its header id
// ---------------------------------------------------------------------------

typedef struct {
  /* An open request an APP frame started, in either direction, with no REPLY yet. */
  bool (*channel_request)(void *context, uint32_t id);
  /* An open request this side sent with no REPLY yet. */
  bool (*own_request)(void *context, uint32_t id);
  bool (*channel)(void *context, uint32_t id);
  /* Any id in use on the connection: a request, a stream or a channel. */
  bool (*in_use)(void *context, uint32_t id);
  void *context;
} Link2Holdings;

#define LINK2_EVENT_APP_PROGRESS 1 /* step 1: progress of an applet channel's request */
#define LINK2_EVENT_APP 2          /* step 2: an APP event */
#define LINK2_EVENT_IGNORE 3       /* step 3, or a late frame of step 4 */
#define LINK2_EVENT_SYSTEM 4       /* step 4: a system event to deliver */
#define LINK2_EVENT_RESET_REFUSED 5
#define LINK2_EVENT_CLOSE 6        /* CLOSE `protocol` */

/* The four steps for the device as receiver. `t` is the object's `t`, or
 * NULL when the payload is not a JSON object with a string `t`.
 * `*opens_stream` is set for LINK2_EVENT_APP and LINK2_EVENT_SYSTEM. */
int link2_read_event(uint32_t id, bool app, const char *t, const Link2Holdings *holds, bool *opens_stream);

// ---------------------------------------------------------------------------
// §4.6 keepalive, §5.6 credit
// ---------------------------------------------------------------------------

typedef struct {
  uint64_t last_received;
  uint64_t last_ping;
} Link2Keepalive;
#define LINK2_ALIVE_OK 0
#define LINK2_ALIVE_PING 1
#define LINK2_ALIVE_SILENCE 2
void link2_keepalive_init(Link2Keepalive *alive, uint64_t now);
void link2_keepalive_received(Link2Keepalive *alive, uint64_t now);
int link2_keepalive_tick(Link2Keepalive *alive, uint64_t now);

/* A CREDIT frame for a stream this side sends on: false when the grant
 * raises the outstanding credit over 16 MiB (CLOSE `flow`). */
bool link2_credit_grant(uint32_t *available, uint32_t bytes);
/* DATA on a stream this side receives: false for bytes past the credit it
 * granted (CLOSE `flow`). */
bool link2_credit_received(uint32_t *outstanding, uint32_t bytes);

/* One inbound stream of an applet channel (§5.6): granted and not yet
 * received plus held for the guest never exceed the window, and credit is
 * granted only against a pending read. */
typedef struct {
  uint32_t window;
  uint32_t outstanding;
  uint32_t held;
  uint32_t wanted;
} Link2AppWindow;
/* Bytes to grant now with a CREDIT frame; 0 when nothing is due. */
uint32_t link2_app_window_grant(Link2AppWindow *window);
/* Bytes the pending read gets, at most `budget`; the read is then complete. */
uint32_t link2_app_window_take(Link2AppWindow *window, uint32_t budget);

// ---------------------------------------------------------------------------
// §6.2 runtime.apps pages, §6.2 log
// ---------------------------------------------------------------------------

typedef struct {
  const char *id;
  const char *output;
  const char *version;
  const char *hash; /* 16 hex digits */
  bool home;
} Link2InstalledApp;

/* One page of a report into `json`: rows from `*at` on, as many whole rows
 * as fit `payload_limit`, at least one. Advances `*at`; the page says `more`
 * when rows remain. False when a row does not fit the limit. */
bool link2_write_apps_page(Link2Json *json, const Link2InstalledApp *rows, size_t count, size_t *at, uint32_t set, uint32_t payload_limit);

/* A `log` event: `text` cut to 1 KiB and to the payload limit minus 96, on a
 * code point. `dropped` is written when it is not 0. */
void link2_write_log(Link2Json *json, const char *level, const char *source, const char *text, size_t length, uint32_t frame, uint32_t dropped, uint32_t payload_limit);

/* 6 to 64 bytes of [A-Za-z0-9._-], ending in ".3dsx", not starting with ".". */
bool link2_valid_native_name(const char *name, size_t length);
/* 1 to 64 bytes of [a-z0-9._-]: an applet's operation or event name. */
bool link2_valid_app_name(const char *name, size_t length);

/* CRC-32 (IEEE), continued from `crc` (0 to start). */
uint32_t link2_crc32(uint32_t crc, const uint8_t *bytes, size_t length);

#endif
