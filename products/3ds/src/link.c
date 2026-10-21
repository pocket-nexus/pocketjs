/*
 * Pocket Link client — see link.h; byte layouts and the handshake come from
 * contracts/spec/link.ts (link_proto.c holds the socket-free half).
 *
 * One state machine, pumped once per frame by the main thread:
 *
 *   IDLE        nothing paired and no pairing requested: no sockets
 *   SEARCH      listen for beacons from paired companions; after
 *               LINK_SEARCH_DIRECT_MS without one, try a paired companion's
 *               last address directly (beacons may be filtered on a LAN)
 *   CONNECTING  non-blocking TCP connect in flight
 *   CHALLENGE   preamble + hello sent, waiting for the companion's proof
 *   AUTH        companion verified, our proof sent, waiting for ready/paired
 *   UP          linked: requests, pings, data streams
 *   BACKOFF     after a failure, 1 s doubling to 8 s; beacons are drained
 *               but not followed until the wait ends
 *
 * A pairing (link.pair) preempts all of this: it drops the current
 * connection and tries each host the QR code listed, in order, in mode
 * "pair". On `paired` the unmasked key is stored and the connection stays up.
 *
 * Requests. net requests (at most NET_MAX_INFLIGHT) and catalog/install
 * requests (at most LINK_MAX_REQUESTS) share one id sequence that never
 * repeats while the process lives, so a net handle is its link request id.
 * Response bodies accumulate in one malloc buffer bounded by the request's
 * maxBytes; install streams go straight to the target slot's staging file.
 * A closed connection fails every open request; nothing is replayed.
 */

#include "link.h"
#include "agent.h"
#include "link_proto.h"

#include <stdio.h>

#ifdef POCKETJS_LINK

#include <3ds.h>
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#if __has_include(<netinet/tcp.h>)
#include <netinet/tcp.h>
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include "jscan.h"
#include "launcher.h"
#include "sha256.h"
#include "soc.h"

#define LINK_DIR "sdmc:/pocketjs/link"
#define LINK_COMPANIONS_DIR LINK_DIR "/companions"
#define LINK_DEVICE_TXT LINK_DIR "/device.txt"
#define LINK_MAX_COMPANIONS 8u

/* One whole frame of the largest kind, plus its header. */
#define LINK_RX_BYTES (LINK_HEADER_BYTES + LINK_MAX_FRAME)
#define LINK_TX_BYTES (LINK_HEADER_BYTES + LINK_MAX_CTRL + 16u * 1024u)
/* Received bytes per pump; also the most this pump writes to the SD card. */
#define LINK_RX_BUDGET (64u * 1024u)
/* Request-body data frames are cut to this size so pings interleave. */
#define LINK_DATA_CHUNK (16u * 1024u)
#define LINK_SEARCH_DIRECT_MS 2500u
#define LINK_BACKOFF_MIN_MS 1000u
#define LINK_BACKOFF_MAX_MS 8000u
#define LINK_REFUSED_HOLD_MS 30000u
#define LINK_PROGRESS_MS 200u
/* Silence allowed on a catalog reply or an install stream. */
#define LINK_REQUEST_STALL_MS 30000u

/* contracts/spec/net.ts */
#define NET_MAX_INFLIGHT 2u
#define NET_MAX_REQUEST_BYTES (64u * 1024u)
#define NET_DEFAULT_RESPONSE_BYTES (128u * 1024u)
#define NET_MAX_RESPONSE_BYTES (256u * 1024u)
#define NET_DEFAULT_TIMEOUT_MS 30000u
#define NET_MAX_TIMEOUT_MS 120000u
/* The companion enforces timeoutMs; the console only fails a request the
 * companion never answered, a little later. */
#define NET_GRACE_MS 5000u

typedef struct {
  char id[LINK_ID_HEX + 1];
  char name[LINK_NAME_BYTES];
  char address[16];
  uint16_t port;
  uint8_t key[LINK_KEY_BYTES];
  uint64_t refused_until_ms;
} Companion;

typedef enum {
  PHASE_IDLE,
  PHASE_SEARCH,
  PHASE_CONNECTING,
  PHASE_CHALLENGE,
  PHASE_AUTH,
  PHASE_UP,
  PHASE_BACKOFF,
} LinkPhase;

typedef enum { NET_FREE, NET_HEAD, NET_BODY, NET_DONE } NetPhase;

typedef struct {
  NetPhase phase;
  uint32_t id;
  uint8_t *body;
  size_t body_length;
  size_t body_sent;
  uint32_t max_bytes;
  uint64_t deadline_ms;
  char *done_event;
  uint8_t *response;
  size_t response_length;
  size_t response_received;
} NetRequest;

typedef enum { REQUEST_FREE, REQUEST_CATALOG, REQUEST_INSTALL } RequestKind;

typedef struct {
  RequestKind kind;
  uint32_t id;
  /* Events reach the guest that asked; a guest switch clears this. */
  bool guest;
  char app[LAUNCHER_ID_BYTES];
  char slot[17];
  char path[96];
  FILE *file;
  bool head;
  uint64_t hash;
  uint32_t expected;
  uint32_t received;
  uint64_t progress_ms;
  /* A request the companion stopped answering fails at this time. */
  uint64_t deadline_ms;
} LinkRequest;

static bool initialized;
static PocketRuntimeState *runtime_state;

static char device_id[LINK_ID_HEX + 1];
static char device_name[LINK_NAME_BYTES];
static char device_model[32];
static bool ps_ready;

static Companion companions[LINK_MAX_COMPANIONS];
static size_t companion_count;

static LinkPhase phase = PHASE_IDLE;
static uint64_t phase_since_ms;
static uint32_t backoff_ms = LINK_BACKOFF_MIN_MS;
static size_t direct_next;
static int beacon_fd = -1;
static int tcp_fd = -1;

/* The connection being made or held. */
static struct {
  bool pair;
  char companion[LINK_ID_HEX + 1];
  char name[LINK_NAME_BYTES];
  char address[16];
  uint16_t port;
  struct sockaddr_in target;
  char device_nonce[LINK_NONCE_BYTES * 2 + 1];
  char companion_nonce[LINK_NONCE_BYTES * 2 + 1];
  uint64_t started_ms;
} attempt;

static LinkPairUri pair_uri;
static bool pair_active;
static size_t pair_host;
static const char *pairing = "idle";

static char last_error[160];
static char features_json[256] = "[]";
/* The companion's clock (link.ts `clock`): its UTC minus this console's
 * epoch at receipt, and its zone offset. Kept after the link drops. */
static bool clock_known;
static int64_t clock_skew_ms;
static int32_t clock_offset_min;
static uint32_t connect_ms;
static uint32_t rtt_ms;
/* Diagnostics: where install streams spend their time (microseconds). */
static uint64_t rx_us;
static uint64_t sd_us;
static uint64_t rx_bytes;
static uint32_t pump_max_us;

static uint8_t rx_buffer[LINK_RX_BYTES];
static size_t rx_length;
static uint8_t tx_buffer[LINK_TX_BYTES];
static size_t tx_length;
static size_t tx_offset;
static uint64_t last_rx_ms;
static uint64_t last_ping_ms;
static uint64_t ping_sent_ms;
static bool pong_pending;

static uint32_t next_id = 1;
static NetRequest net_requests[NET_MAX_INFLIGHT];
static LinkRequest requests[LINK_MAX_REQUESTS];
static JsonBuffer link_events = { .limit = 96u * 1024u };
static JsonBuffer net_events = { .limit = 32u * 1024u };
static JsonBuffer poll_out = { .limit = 100u * 1024u };
static JsonBuffer status_out = { .limit = 8u * 1024u };
static JsonBuffer scratch = { .limit = LINK_MAX_CTRL };
static char net_error[192];

static bool would_block(void) {
  return errno == EAGAIN || errno == EWOULDBLOCK;
}

static bool set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

/* Milliseconds since `then`; 0 when `then` was taken after a stale `now`. */
/* osGetTime() counts milliseconds from 1900-01-01; the epoch is 1970. */
static uint64_t console_epoch_ms(void) {
  return osGetTime() - 2208988800000ULL;
}

static uint64_t since(uint64_t then) {
  uint64_t now = osGetTime();
  return now > then ? now - then : 0;
}

static void enter(LinkPhase next) {
  phase = next;
  phase_since_ms = osGetTime();
}

static void set_error(const char *message) {
  snprintf(last_error, sizeof last_error, "%s", message == NULL ? "" : message);
}

static void random_bytes(uint8_t *out, size_t length) {
  if (ps_ready && R_SUCCEEDED(PS_GenerateRandomBytes(out, length))) return;
  /* Without ps:ps, hash the free-running tick counter: the nonces only have
   * to be fresh, and the key itself is minted by the companion. */
  static uint64_t counter;
  while (length > 0) {
    uint64_t seed[4] = { svcGetSystemTick(), osGetTime(), ++counter, (uint64_t)(uintptr_t)out };
    uint8_t digest[SHA256_BYTES];
    sha256(seed, sizeof seed, digest);
    size_t take = length < sizeof digest ? length : sizeof digest;
    memcpy(out, digest, take);
    out += take;
    length -= take;
  }
}

static bool has_feature(const char *feature) {
  char quoted[40];
  snprintf(quoted, sizeof quoted, "\"%s\"", feature);
  return strstr(features_json, quoted) != NULL;
}

// ---------------------------------------------------------------------------
// identity and paired companions (sdmc:/pocketjs/link)
// ---------------------------------------------------------------------------

static void ensure_directories(void) {
  mkdir("sdmc:/pocketjs", 0777);
  mkdir(LINK_DIR, 0777);
  mkdir(LINK_COMPANIONS_DIR, 0777);
}

static bool write_atomic(const char *path, const char *text) {
  char temporary[128];
  snprintf(temporary, sizeof temporary, "%s.tmp", path);
  FILE *file = fopen(temporary, "wb");
  if (file == NULL) return false;
  bool ok = fputs(text, file) >= 0;
  if (fclose(file) != 0) ok = false;
  if (!ok) {
    remove(temporary);
    return false;
  }
  remove(path);
  return rename(temporary, path) == 0;
}

static void load_device_id(void) {
  FILE *file = fopen(LINK_DEVICE_TXT, "rb");
  if (file != NULL) {
    char text[32] = {0};
    size_t length = fread(text, 1, sizeof text - 1, file);
    fclose(file);
    while (length > 0 && (text[length - 1] == '\n' || text[length - 1] == '\r' || text[length - 1] == ' ')) {
      length -= 1;
    }
    if (link_valid_id(text, length)) {
      memcpy(device_id, text, LINK_ID_HEX);
      device_id[LINK_ID_HEX] = '\0';
      return;
    }
  }
  uint8_t bytes[LINK_ID_HEX / 2];
  random_bytes(bytes, sizeof bytes);
  hex_encode(bytes, sizeof bytes, device_id);
  char text[24];
  snprintf(text, sizeof text, "%s\n", device_id);
  write_atomic(LINK_DEVICE_TXT, text);
}

/* UTF-16LE (the CFG block) to UTF-8, stopping at NUL. */
static void utf16_to_text(const uint16_t *text, size_t units, char *out, size_t capacity) {
  size_t used = 0;
  for (size_t i = 0; i < units && text[i] != 0; i += 1) {
    uint32_t code = text[i];
    if (code >= 0xd800 && code < 0xdc00 && i + 1 < units && text[i + 1] >= 0xdc00 && text[i + 1] < 0xe000) {
      code = 0x10000 + ((code - 0xd800) << 10) + (text[i + 1] - 0xdc00);
      i += 1;
    }
    char encoded[4];
    size_t bytes;
    if (code < 0x80) {
      encoded[0] = (char)code;
      bytes = 1;
    } else if (code < 0x800) {
      encoded[0] = (char)(0xc0 | (code >> 6));
      encoded[1] = (char)(0x80 | (code & 0x3f));
      bytes = 2;
    } else if (code < 0x10000) {
      encoded[0] = (char)(0xe0 | (code >> 12));
      encoded[1] = (char)(0x80 | ((code >> 6) & 0x3f));
      encoded[2] = (char)(0x80 | (code & 0x3f));
      bytes = 3;
    } else {
      encoded[0] = (char)(0xf0 | (code >> 18));
      encoded[1] = (char)(0x80 | ((code >> 12) & 0x3f));
      encoded[2] = (char)(0x80 | ((code >> 6) & 0x3f));
      encoded[3] = (char)(0x80 | (code & 0x3f));
      bytes = 4;
    }
    if (used + bytes >= capacity) break;
    memcpy(out + used, encoded, bytes);
    used += bytes;
  }
  out[used] = '\0';
}

static void load_console_identity(void) {
  snprintf(device_name, sizeof device_name, "Nintendo 3DS");
  snprintf(device_model, sizeof device_model, "Nintendo 3DS");
  if (R_FAILED(cfguInit())) return;
  /* Block 0x000A0000: the owner's user name, 10 UTF-16 units + NUL. */
  uint16_t name[0x1c / 2] = {0};
  if (R_SUCCEEDED(CFGU_GetConfigInfoBlk2(0x1c, 0x000a0000, name))) {
    char text[LINK_NAME_BYTES];
    utf16_to_text(name, 10, text, sizeof text);
    if (text[0] != '\0') snprintf(device_name, sizeof device_name, "%s", text);
  }
  static const char *const MODELS[] = {
    "Nintendo 3DS", "Nintendo 3DS XL", "New Nintendo 3DS",
    "Nintendo 2DS", "New Nintendo 3DS XL", "New Nintendo 2DS XL",
  };
  u8 model = 0;
  if (R_SUCCEEDED(CFGU_GetSystemModel(&model)) && model < sizeof MODELS / sizeof MODELS[0]) {
    snprintf(device_model, sizeof device_model, "%s", MODELS[model]);
  }
  cfguExit();
}

static void companion_path(const char *id, char *out, size_t length) {
  snprintf(out, length, LINK_COMPANIONS_DIR "/%s.txt", id);
}

static void save_companion(const Companion *companion) {
  char key[LINK_KEY_BYTES * 2 + 1];
  hex_encode(companion->key, LINK_KEY_BYTES, key);
  char text[320];
  snprintf(
    text,
    sizeof text,
    "key=%s\nname=%s\naddress=%s\nport=%u\n",
    key,
    companion->name,
    companion->address,
    (unsigned)companion->port
  );
  char path[96];
  companion_path(companion->id, path, sizeof path);
  write_atomic(path, text);
}

static bool load_companion(const char *id, Companion *out) {
  char path[96];
  companion_path(id, path, sizeof path);
  FILE *file = fopen(path, "rb");
  if (file == NULL) return false;
  memset(out, 0, sizeof *out);
  memcpy(out->id, id, LINK_ID_HEX);
  bool have_key = false;
  char line[200];
  while (fgets(line, sizeof line, file) != NULL) {
    size_t length = strlen(line);
    while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) line[--length] = '\0';
    char *value = strchr(line, '=');
    if (value == NULL) continue;
    *value++ = '\0';
    if (strcmp(line, "key") == 0) {
      have_key = hex_decode(value, strlen(value), out->key, LINK_KEY_BYTES);
    } else if (strcmp(line, "name") == 0) {
      snprintf(out->name, sizeof out->name, "%s", value);
    } else if (strcmp(line, "address") == 0) {
      struct in_addr address;
      if (inet_aton(value, &address) != 0) snprintf(out->address, sizeof out->address, "%s", value);
    } else if (strcmp(line, "port") == 0) {
      unsigned long port = strtoul(value, NULL, 10);
      if (port > 0 && port <= 65535) out->port = (uint16_t)port;
    }
  }
  fclose(file);
  if (out->port == 0) out->port = LINK_PORT;
  return have_key;
}

static void load_companions(void) {
  companion_count = 0;
  DIR *directory = opendir(LINK_COMPANIONS_DIR);
  if (directory == NULL) return;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL && companion_count < LINK_MAX_COMPANIONS) {
    size_t length = strlen(entry->d_name);
    if (length != LINK_ID_HEX + 4 || strcmp(entry->d_name + LINK_ID_HEX, ".txt") != 0) continue;
    char id[LINK_ID_HEX + 1];
    memcpy(id, entry->d_name, LINK_ID_HEX);
    id[LINK_ID_HEX] = '\0';
    if (!link_valid_id(id, LINK_ID_HEX)) continue;
    if (load_companion(id, &companions[companion_count])) companion_count += 1;
  }
  closedir(directory);
}

static Companion *find_companion(const char *id) {
  for (size_t i = 0; i < companion_count; i += 1) {
    if (strcmp(companions[i].id, id) == 0) return &companions[i];
  }
  return NULL;
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

static void event_begin(JsonBuffer *events) {
  if (events->length > 0) jbuf_text(events, ",");
}

/* An event that did not fit is dropped whole, never torn. */
static void event_end(JsonBuffer *events, size_t mark) {
  if (events->failed) {
    events->failed = false;
    events->length = mark;
    if (events->data != NULL) events->data[mark] = '\0';
  }
}

static void request_error_event(const LinkRequest *request, const char *message) {
  if (!request->guest) return;
  size_t mark = link_events.length;
  event_begin(&link_events);
  jbuf_text(&link_events, "{\"t\":\"error\",\"id\":");
  jbuf_u64(&link_events, request->id);
  jbuf_text(&link_events, ",\"message\":");
  jbuf_cstring(&link_events, message);
  jbuf_text(&link_events, "}");
  event_end(&link_events, mark);
}

static void net_error_event(uint32_t handle, const char *code, const char *message) {
  size_t mark = net_events.length;
  event_begin(&net_events);
  jbuf_text(&net_events, "{\"t\":\"error\",\"h\":");
  jbuf_u64(&net_events, handle);
  jbuf_text(&net_events, ",\"code\":");
  jbuf_cstring(&net_events, code);
  jbuf_text(&net_events, ",\"message\":");
  jbuf_cstring(&net_events, message);
  jbuf_text(&net_events, "}");
  event_end(&net_events, mark);
}

// ---------------------------------------------------------------------------
// outbound frames
// ---------------------------------------------------------------------------

static size_t tx_space(void) {
  if (tx_offset > 0 && tx_offset == tx_length) {
    tx_offset = 0;
    tx_length = 0;
  }
  if (tx_offset > 0) {
    memmove(tx_buffer, tx_buffer + tx_offset, tx_length - tx_offset);
    tx_length -= tx_offset;
    tx_offset = 0;
  }
  return sizeof tx_buffer - tx_length;
}

static bool queue_frame(uint8_t type, const uint8_t *prefix, size_t prefix_length, const void *payload, size_t length) {
  if (tcp_fd < 0) return false;
  size_t total = LINK_HEADER_BYTES + prefix_length + length;
  if (total > tx_space()) return false;
  link_write_header(tx_buffer + tx_length, type, (uint32_t)(prefix_length + length));
  tx_length += LINK_HEADER_BYTES;
  if (prefix_length > 0) memcpy(tx_buffer + tx_length, prefix, prefix_length);
  tx_length += prefix_length;
  if (length > 0) memcpy(tx_buffer + tx_length, payload, length);
  tx_length += length;
  return true;
}

static bool queue_ctrl(const char *json, size_t length) {
  if (length == 0 || length > LINK_MAX_CTRL) return false;
  return queue_frame(LINK_FRAME_CTRL, NULL, 0, json, length);
}

static bool queue_scratch(void) {
  const char *text = jbuf_cstr(&scratch);
  return text != NULL && queue_ctrl(text, scratch.length);
}

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------

static uint32_t take_id(void) {
  uint32_t id = next_id;
  next_id = next_id >= 0x7fffffffu ? 1 : next_id + 1;
  return id;
}

static void net_free(NetRequest *request) {
  free(request->body);
  free(request->done_event);
  free(request->response);
  memset(request, 0, sizeof *request);
}

static NetRequest *find_net(uint32_t id) {
  for (size_t i = 0; i < NET_MAX_INFLIGHT; i += 1) {
    if (net_requests[i].phase != NET_FREE && net_requests[i].id == id) return &net_requests[i];
  }
  return NULL;
}

static LinkRequest *find_request(uint32_t id) {
  for (size_t i = 0; i < LINK_MAX_REQUESTS; i += 1) {
    if (requests[i].kind != REQUEST_FREE && requests[i].id == id) return &requests[i];
  }
  return NULL;
}

static void request_free(LinkRequest *request, bool remove_staging) {
  if (request->file != NULL) fclose(request->file);
  if (remove_staging && request->path[0] != '\0') remove(request->path);
  memset(request, 0, sizeof *request);
}

static void send_net_cancel(uint32_t id) {
  if (phase != PHASE_UP) return;
  jbuf_reset(&scratch);
  jbuf_text(&scratch, "{\"t\":\"net.cancel\",\"id\":");
  jbuf_u64(&scratch, id);
  jbuf_text(&scratch, "}");
  queue_scratch();
}

/* Every open request fails with the connection. */
static void fail_requests(const char *message) {
  for (size_t i = 0; i < NET_MAX_INFLIGHT; i += 1) {
    NetRequest *request = &net_requests[i];
    if (request->phase == NET_HEAD || request->phase == NET_BODY) {
      net_error_event(request->id, "unavailable", message);
      net_free(request);
    }
  }
  for (size_t i = 0; i < LINK_MAX_REQUESTS; i += 1) {
    if (requests[i].kind == REQUEST_FREE) continue;
    request_error_event(&requests[i], message);
    request_free(&requests[i], true);
  }
}

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

static void close_connection(void) {
  if (tcp_fd >= 0) close(tcp_fd);
  tcp_fd = -1;
  rx_length = 0;
  tx_length = 0;
  tx_offset = 0;
  pong_pending = false;
}

static void start_next_pair_host(void);

static void finish_pairing(bool paired, const char *message) {
  pair_active = false;
  pairing = paired ? "paired" : "failed";
  if (!paired) set_error(message);
}

/* Drop the connection (or the attempt) and decide what comes next. */
static void drop(const char *reason) {
  bool was_up = phase == PHASE_UP;
  close_connection();
  if (was_up) agent_link_changed(false);
  if (was_up || phase == PHASE_AUTH || phase == PHASE_CHALLENGE) fail_requests(reason);
  set_error(reason);
  if (attempt.pair && pair_active) {
    pair_host += 1;
    if (pair_host < pair_uri.host_count) {
      start_next_pair_host();
      return;
    }
    finish_pairing(false, reason);
  }
  attempt.pair = false;
  enter(companion_count == 0 && !pair_active ? PHASE_IDLE : PHASE_BACKOFF);
}

static void start_connect(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0 || !set_nonblocking(fd)) {
    if (fd >= 0) close(fd);
    drop("socket unavailable");
    return;
  }
#ifdef TCP_NODELAY
  int nodelay = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof nodelay);
#endif
  tcp_fd = fd;
  attempt.started_ms = osGetTime();
  int rc = connect(tcp_fd, (struct sockaddr *)&attempt.target, sizeof attempt.target);
  if (rc == 0 || errno == EINPROGRESS || errno == EWOULDBLOCK || errno == EALREADY) {
    enter(PHASE_CONNECTING);
    return;
  }
  char message[96];
  snprintf(message, sizeof message, "connect %s:%u failed (%d)", attempt.address, (unsigned)attempt.port, errno);
  drop(message);
}

static bool set_target(const char *address, uint16_t port) {
  struct in_addr parsed;
  if (inet_aton(address, &parsed) == 0) return false;
  memset(&attempt.target, 0, sizeof attempt.target);
  attempt.target.sin_family = AF_INET;
  attempt.target.sin_addr = parsed;
  attempt.target.sin_port = htons(port);
  snprintf(attempt.address, sizeof attempt.address, "%s", address);
  attempt.port = port;
  return true;
}

static void connect_companion(const Companion *companion, const char *address, uint16_t port) {
  memset(&attempt, 0, sizeof attempt);
  attempt.pair = false;
  memcpy(attempt.companion, companion->id, sizeof attempt.companion);
  snprintf(attempt.name, sizeof attempt.name, "%s", companion->name);
  if (!set_target(address, port)) {
    enter(PHASE_BACKOFF);
    return;
  }
  start_connect();
}

static void start_next_pair_host(void) {
  memset(&attempt, 0, sizeof attempt);
  attempt.pair = true;
  memcpy(attempt.companion, pair_uri.companion, sizeof attempt.companion);
  snprintf(attempt.name, sizeof attempt.name, "%s", pair_uri.name);
  if (!set_target(pair_uri.hosts[pair_host], pair_uri.port)) {
    finish_pairing(false, "pairing address is not IPv4");
    enter(companion_count == 0 ? PHASE_IDLE : PHASE_BACKOFF);
    return;
  }
  pairing = "connecting";
  start_connect();
}

static void send_hello(void) {
  uint8_t nonce[LINK_NONCE_BYTES];
  random_bytes(nonce, sizeof nonce);
  hex_encode(nonce, sizeof nonce, attempt.device_nonce);
  link_write_preamble(tx_buffer);
  tx_length = LINK_PREAMBLE_BYTES;
  tx_offset = 0;
  jbuf_reset(&scratch);
  jbuf_text(&scratch, "{\"t\":\"hello\",\"v\":1,\"mode\":");
  jbuf_text(&scratch, attempt.pair ? "\"pair\"" : "\"connect\"");
  jbuf_text(&scratch, ",\"device\":");
  jbuf_cstring(&scratch, device_id);
  jbuf_text(&scratch, ",\"companion\":");
  jbuf_cstring(&scratch, attempt.companion);
  jbuf_text(&scratch, ",\"nonce\":");
  jbuf_cstring(&scratch, attempt.device_nonce);
  jbuf_text(&scratch, ",\"name\":");
  jbuf_cstring(&scratch, device_name);
  jbuf_text(&scratch, ",\"model\":");
  jbuf_cstring(&scratch, device_model);
  jbuf_text(&scratch, ",\"target\":");
  jbuf_cstring(&scratch, POCKETJS_TARGET_ID);
  jbuf_text(&scratch, "}");
  queue_scratch();
  last_rx_ms = osGetTime();
  enter(PHASE_CHALLENGE);
}

static void pump_connecting(void) {
  int rc = connect(tcp_fd, (struct sockaddr *)&attempt.target, sizeof attempt.target);
  if (rc == 0 || errno == EISCONN) {
    send_hello();
    return;
  }
  if (errno == EALREADY || errno == EINPROGRESS || errno == EWOULDBLOCK) {
    if (since(phase_since_ms) > LINK_CONNECT_TIMEOUT_MS) {
      char message[96];
      snprintf(message, sizeof message, "no answer from %s:%u", attempt.address, (unsigned)attempt.port);
      drop(message);
    }
    return;
  }
  char message[96];
  snprintf(message, sizeof message, "connect %s:%u refused (%d)", attempt.address, (unsigned)attempt.port, errno);
  drop(message);
}

static const uint8_t *attempt_secret(size_t *length) {
  if (attempt.pair) {
    *length = LINK_PAIR_SECRET_BYTES;
    return pair_uri.secret;
  }
  Companion *companion = find_companion(attempt.companion);
  if (companion == NULL) {
    *length = 0;
    return NULL;
  }
  *length = LINK_KEY_BYTES;
  return companion->key;
}

static void handle_challenge(JsonSpan message) {
  char type[24];
  if (!json_find_string(message, "t", type, sizeof type)) {
    drop("handshake: malformed reply");
    return;
  }
  if (strcmp(type, "refused") == 0) {
    char code[48] = {0}, text[96] = {0}, reason[160];
    json_find_string(message, "code", code, sizeof code);
    json_find_string(message, "message", text, sizeof text);
    snprintf(reason, sizeof reason, "refused: %s%s%s", code, text[0] ? ": " : "", text);
    Companion *companion = attempt.pair ? NULL : find_companion(attempt.companion);
    if (companion != NULL) companion->refused_until_ms = osGetTime() + LINK_REFUSED_HOLD_MS;
    /* A refusal is an answer: the next host would refuse the same secret. */
    if (attempt.pair) {
      finish_pairing(false, reason);
      attempt.pair = false;
    }
    drop(reason);
    return;
  }
  if (strcmp(type, "challenge") != 0) {
    drop("handshake: expected a challenge");
    return;
  }
  char proof_hex[SHA256_BYTES * 2 + 1];
  uint8_t proof[SHA256_BYTES];
  if (!json_find_string(message, "nonce", attempt.companion_nonce, sizeof attempt.companion_nonce) ||
      strlen(attempt.companion_nonce) != LINK_NONCE_BYTES * 2 ||
      !json_find_string(message, "proof", proof_hex, sizeof proof_hex) ||
      !hex_decode(proof_hex, strlen(proof_hex), proof, sizeof proof)) {
    drop("handshake: malformed challenge");
    return;
  }
  size_t secret_length = 0;
  const uint8_t *secret = attempt_secret(&secret_length);
  if (secret == NULL) {
    drop("handshake: companion was forgotten");
    return;
  }
  uint8_t expected[SHA256_BYTES];
  link_proof(secret, secret_length, LINK_LABEL_COMPANION, attempt.device_nonce, attempt.companion_nonce,
    device_id, attempt.companion, expected);
  /* The companion proves itself before this console answers. */
  if (!constant_time_equal(expected, proof, sizeof proof)) {
    if (attempt.pair) {
      finish_pairing(false, "the companion did not prove the pairing secret");
      attempt.pair = false;
    }
    drop("the companion did not prove the shared key");
    return;
  }
  uint8_t answer[SHA256_BYTES];
  link_proof(secret, secret_length, LINK_LABEL_CONSOLE, attempt.device_nonce, attempt.companion_nonce,
    device_id, attempt.companion, answer);
  hex_encode(answer, sizeof answer, proof_hex);
  jbuf_reset(&scratch);
  jbuf_text(&scratch, "{\"t\":\"auth\",\"proof\":\"");
  jbuf_text(&scratch, proof_hex);
  jbuf_text(&scratch, "\"}");
  queue_scratch();
  enter(PHASE_AUTH);
}

static void become_linked(JsonSpan message, Companion *companion) {
  uint64_t now = osGetTime();
  connect_ms = (uint32_t)(now - attempt.started_ms);
  backoff_ms = LINK_BACKOFF_MIN_MS;
  set_error("");
  JsonSpan features;
  if (json_find(message, "features", &features) && json_is_array(features) &&
      features.length < sizeof features_json) {
    memcpy(features_json, features.start, features.length);
    features_json[features.length] = '\0';
  } else {
    snprintf(features_json, sizeof features_json, "[]");
  }
  JsonSpan clock;
  uint64_t utc = 0, local = 0;
  if (json_find(message, "clock", &clock) && json_is_object(clock) &&
      json_find_u64(clock, "utc", &utc) && json_find_u64(clock, "local", &local) && utc > 0) {
    clock_skew_ms = (int64_t)utc - (int64_t)console_epoch_ms();
    clock_offset_min = (int32_t)(((int64_t)local - (int64_t)utc) / 60000);
    clock_known = true;
  }
  char name[LINK_NAME_BYTES];
  if (json_find_string(message, "name", name, sizeof name) && name[0] != '\0') {
    snprintf(attempt.name, sizeof attempt.name, "%s", name);
  }
  bool changed = strcmp(companion->address, attempt.address) != 0 || companion->port != attempt.port ||
                 strcmp(companion->name, attempt.name) != 0;
  snprintf(companion->address, sizeof companion->address, "%s", attempt.address);
  companion->port = attempt.port;
  snprintf(companion->name, sizeof companion->name, "%s", attempt.name);
  companion->refused_until_ms = 0;
  if (changed) save_companion(companion);
  last_rx_ms = now;
  last_ping_ms = now;
  ping_sent_ms = 0;
  enter(PHASE_UP);
  agent_link_changed(true);
}

static void handle_auth_reply(JsonSpan message) {
  char type[24];
  if (!json_find_string(message, "t", type, sizeof type)) {
    drop("handshake: malformed reply");
    return;
  }
  if (strcmp(type, "refused") == 0) {
    handle_challenge(message);
    return;
  }
  if (!attempt.pair && strcmp(type, "ready") == 0) {
    Companion *companion = find_companion(attempt.companion);
    if (companion == NULL) {
      drop("handshake: companion was forgotten");
      return;
    }
    become_linked(message, companion);
    return;
  }
  if (attempt.pair && strcmp(type, "paired") == 0) {
    char key_hex[LINK_KEY_BYTES * 2 + 1];
    uint8_t key[LINK_KEY_BYTES];
    if (!json_find_string(message, "key", key_hex, sizeof key_hex) ||
        !hex_decode(key_hex, strlen(key_hex), key, sizeof key)) {
      finish_pairing(false, "pairing: malformed key");
      attempt.pair = false;
      drop("pairing: malformed key");
      return;
    }
    uint8_t mask[SHA256_BYTES];
    link_key_mask(pair_uri.secret, LINK_PAIR_SECRET_BYTES, attempt.device_nonce, attempt.companion_nonce, mask);
    for (size_t i = 0; i < LINK_KEY_BYTES; i += 1) key[i] ^= mask[i];
    Companion *companion = find_companion(attempt.companion);
    if (companion == NULL) {
      if (companion_count == LINK_MAX_COMPANIONS) {
        /* The oldest pairing gives way; its file goes with it. */
        char path[96];
        companion_path(companions[0].id, path, sizeof path);
        remove(path);
        memmove(companions, companions + 1, (LINK_MAX_COMPANIONS - 1) * sizeof companions[0]);
        companion_count -= 1;
      }
      companion = &companions[companion_count++];
      memset(companion, 0, sizeof *companion);
      memcpy(companion->id, attempt.companion, sizeof companion->id);
    }
    memcpy(companion->key, key, LINK_KEY_BYTES);
    /* Force a save even when name/address match a stale entry. */
    companion->address[0] = '\0';
    attempt.pair = false;
    finish_pairing(true, "");
    become_linked(message, companion);
    return;
  }
  drop("handshake: unexpected reply");
}

// ---------------------------------------------------------------------------
// linked: inbound ctrl and data
// ---------------------------------------------------------------------------

static void handle_net_head(JsonSpan message, uint32_t id) {
  NetRequest *request = find_net(id);
  if (request == NULL || request->phase != NET_HEAD) return;
  uint64_t status = 0, bytes = 0;
  JsonSpan url, headers;
  if (!json_find_u64(message, "status", &status) || status < 100 || status > 599 ||
      !json_find_u64(message, "bytes", &bytes) ||
      !json_find(message, "url", &url) || url.length < 2 || url.start[0] != '"' ||
      !json_find(message, "headers", &headers) || !json_is_object(headers)) {
    net_error_event(id, "protocol", "net: malformed response head");
    send_net_cancel(id);
    net_free(request);
    return;
  }
  if (bytes > request->max_bytes) {
    net_error_event(id, "response_too_large", "net: response exceeds maxBytes");
    send_net_cancel(id);
    net_free(request);
    return;
  }
  JsonBuffer done = { .limit = LINK_MAX_CTRL + 128 };
  jbuf_text(&done, "{\"t\":\"done\",\"h\":");
  jbuf_u64(&done, id);
  jbuf_text(&done, ",\"status\":");
  jbuf_u64(&done, status);
  jbuf_text(&done, ",\"url\":");
  jbuf_raw(&done, url.start, url.length);
  jbuf_text(&done, ",\"headers\":");
  jbuf_raw(&done, headers.start, headers.length);
  jbuf_text(&done, ",\"bytes\":");
  jbuf_u64(&done, bytes);
  jbuf_text(&done, "}");
  if (jbuf_cstr(&done) == NULL) {
    jbuf_free(&done);
    net_error_event(id, "other", "net: out of memory");
    send_net_cancel(id);
    net_free(request);
    return;
  }
  request->done_event = done.data;
  request->response_length = (size_t)bytes;
  request->response_received = 0;
  if (bytes > 0) {
    request->response = malloc((size_t)bytes);
    if (request->response == NULL) {
      net_error_event(id, "other", "net: response buffer allocation failed");
      send_net_cancel(id);
      net_free(request);
      return;
    }
  }
  request->phase = NET_BODY;
  if (bytes == 0) {
    size_t mark = net_events.length;
    event_begin(&net_events);
    jbuf_text(&net_events, request->done_event);
    event_end(&net_events, mark);
    request->phase = NET_DONE;
  }
}

static void handle_net_error(JsonSpan message, uint32_t id) {
  NetRequest *request = find_net(id);
  if (request == NULL || (request->phase != NET_HEAD && request->phase != NET_BODY)) return;
  char code[32] = "other", text[160] = "";
  json_find_string(message, "code", code, sizeof code);
  json_find_string(message, "message", text, sizeof text);
  net_error_event(id, code, text[0] ? text : code);
  net_free(request);
}

static void ensure_slot_directory(const char *slot) {
  char path[96];
  mkdir("sdmc:/pocketjs", 0777);
  mkdir(POCKET_RUNTIME_ROOT, 0777);
  mkdir(POCKET_RUNTIME_APPS, 0777);
  if (runtime_slot_path(slot, NULL, path, sizeof path)) mkdir(path, 0777);
}

static void handle_install_head(JsonSpan message, LinkRequest *request) {
  char app[LAUNCHER_ID_BYTES], hash_hex[24];
  uint64_t bytes = 0;
  if (request->head || !json_find_string(message, "app", app, sizeof app) || strcmp(app, request->app) != 0 ||
      !json_find_string(message, "hash", hash_hex, sizeof hash_hex) || strlen(hash_hex) != 16 ||
      !json_find_u64(message, "bytes", &bytes) || bytes == 0 || bytes > LINK_INSTALL_MAX_BYTES) {
    request_error_event(request, "install: malformed head");
    request_free(request, true);
    return;
  }
  uint8_t hash_bytes[8];
  if (!hex_decode(hash_hex, 16, hash_bytes, sizeof hash_bytes)) {
    request_error_event(request, "install: malformed hash");
    request_free(request, true);
    return;
  }
  request->hash = 0;
  for (size_t i = 0; i < 8; i += 1) request->hash = (request->hash << 8) | hash_bytes[i];
  ensure_slot_directory(request->slot);
  if (!runtime_slot_path(request->slot, "link-upload.pocket", request->path, sizeof request->path)) {
    request_error_event(request, "install: bad slot");
    request_free(request, false);
    return;
  }
  request->file = fopen(request->path, "wb");
  if (request->file == NULL) {
    request_error_event(request, "install: cannot open the staging file");
    request_free(request, false);
    return;
  }
  request->head = true;
  request->expected = (uint32_t)bytes;
  request->received = 0;
  request->progress_ms = 0;
}

static void install_progress(LinkRequest *request, bool force) {
  uint64_t now = osGetTime();
  if (!request->guest || (!force && since(request->progress_ms) < LINK_PROGRESS_MS)) return;
  request->progress_ms = now;
  size_t mark = link_events.length;
  event_begin(&link_events);
  jbuf_text(&link_events, "{\"t\":\"install.progress\",\"id\":");
  jbuf_u64(&link_events, request->id);
  jbuf_text(&link_events, ",\"app\":");
  jbuf_cstring(&link_events, request->app);
  jbuf_text(&link_events, ",\"received\":");
  jbuf_u64(&link_events, request->received);
  jbuf_text(&link_events, ",\"bytes\":");
  jbuf_u64(&link_events, request->expected);
  jbuf_text(&link_events, "}");
  event_end(&link_events, mark);
}

/* The last byte arrived: flush, admit, commit, refresh the app table. This is
 * the one step that reads the whole package back (runtime_prepare_file
 * verifies its footer and admits it), so it costs one frame per install. */
static void finish_install(LinkRequest *request) {
  bool written = fflush(request->file) == 0 && fsync(fileno(request->file)) == 0;
  if (fclose(request->file) != 0) written = false;
  request->file = NULL;
  if (!written) {
    request_error_event(request, "install: SD write failed");
    request_free(request, true);
    return;
  }
  install_progress(request, true);
  char error[256] = {0};
  PocketRuntimePackage *package = runtime_slot_install(
    request->slot,
    request->path,
    request->hash,
    runtime_state,
    error,
    sizeof error
  );
  if (package == NULL) {
    runtime_slot_write_error(request->slot, "link-install", error);
    request_error_event(request, error);
    request_free(request, true);
    return;
  }
  launcher_note_installed(request->slot, package);
  char output[LAUNCHER_OUTPUT_BYTES] = {0};
  launcher_package_output(package, output, sizeof output);
  runtime_package_free(package);
  if (request->guest) {
    char hash[17];
    snprintf(hash, sizeof hash, "%016llx", (unsigned long long)request->hash);
    size_t mark = link_events.length;
    event_begin(&link_events);
    jbuf_text(&link_events, "{\"t\":\"install.done\",\"id\":");
    jbuf_u64(&link_events, request->id);
    jbuf_text(&link_events, ",\"app\":");
    jbuf_cstring(&link_events, request->app);
    jbuf_text(&link_events, ",\"output\":");
    jbuf_cstring(&link_events, output);
    jbuf_text(&link_events, ",\"hash\":\"");
    jbuf_text(&link_events, hash);
    jbuf_text(&link_events, "\"}");
    event_end(&link_events, mark);
  }
  /* The staging file was renamed into packages/; nothing to remove. */
  request->path[0] = '\0';
  request_free(request, false);
}

static void handle_data(const uint8_t *payload, uint32_t length) {
  if (length < 4) {
    drop("protocol: short data frame");
    return;
  }
  uint32_t id = link_read_u32(payload);
  const uint8_t *bytes = payload + 4;
  size_t count = length - 4;
  if (agent_link_data(id, bytes, count)) return;
  NetRequest *net = find_net(id);
  if (net != NULL) {
    if (net->phase != NET_BODY || count > net->response_length - net->response_received) {
      net_error_event(id, "protocol", "net: response body overran its declared length");
      send_net_cancel(id);
      net_free(net);
      return;
    }
    memcpy(net->response + net->response_received, bytes, count);
    net->response_received += count;
    if (net->response_received == net->response_length) {
      size_t mark = net_events.length;
      event_begin(&net_events);
      jbuf_text(&net_events, net->done_event);
      event_end(&net_events, mark);
      net->phase = NET_DONE;
    }
    return;
  }
  LinkRequest *request = find_request(id);
  if (request == NULL || request->kind != REQUEST_INSTALL) return; /* cancelled: skip */
  if (!request->head || request->file == NULL || count > request->expected - request->received) {
    request_error_event(request, "install: stream overran its declared length");
    request_free(request, true);
    return;
  }
  u64 started = svcGetSystemTick();
  size_t written = count > 0 ? fwrite(bytes, 1, count, request->file) : 0;
  sd_us += (svcGetSystemTick() - started) * 1000000u / SYSCLOCK_ARM11;
  if (written != count) {
    request_error_event(request, "install: SD write failed");
    request_free(request, true);
    return;
  }
  request->received += (uint32_t)count;
  request->deadline_ms = osGetTime() + LINK_REQUEST_STALL_MS;
  if (request->received == request->expected) finish_install(request);
  else install_progress(request, false);
}

static void handle_ctrl(const uint8_t *payload, uint32_t length) {
  JsonSpan message = json_span((const char *)payload, length);
  if (phase == PHASE_CHALLENGE) {
    handle_challenge(message);
    return;
  }
  if (phase == PHASE_AUTH) {
    handle_auth_reply(message);
    return;
  }
  if (agent_link_ctrl((const char *)payload, length)) return;
  char type[24];
  if (!json_find_string(message, "t", type, sizeof type)) return;
  uint64_t id = 0;
  bool has_id = json_find_u64(message, "id", &id) && id <= 0xffffffffu;
  if (strcmp(type, "net.head") == 0 && has_id) {
    handle_net_head(message, (uint32_t)id);
  } else if (strcmp(type, "net.error") == 0 && has_id) {
    handle_net_error(message, (uint32_t)id);
  } else if (strcmp(type, "catalog") == 0 && has_id) {
    LinkRequest *request = find_request((uint32_t)id);
    if (request == NULL || request->kind != REQUEST_CATALOG) return;
    JsonSpan apps;
    if (!json_find(message, "apps", &apps) || !json_is_array(apps)) {
      request_error_event(request, "catalog: malformed reply");
    } else if (request->guest) {
      size_t mark = link_events.length;
      event_begin(&link_events);
      jbuf_text(&link_events, "{\"t\":\"catalog\",\"id\":");
      jbuf_u64(&link_events, id);
      jbuf_text(&link_events, ",\"apps\":");
      jbuf_raw(&link_events, apps.start, apps.length);
      jbuf_text(&link_events, "}");
      event_end(&link_events, mark);
    }
    request_free(request, false);
  } else if (strcmp(type, "catalog.changed") == 0) {
    size_t mark = link_events.length;
    event_begin(&link_events);
    jbuf_text(&link_events, "{\"t\":\"catalog.changed\"}");
    event_end(&link_events, mark);
  } else if (strcmp(type, "install.head") == 0 && has_id) {
    LinkRequest *request = find_request((uint32_t)id);
    if (request != NULL && request->kind == REQUEST_INSTALL) handle_install_head(message, request);
  } else if (strcmp(type, "install.error") == 0 && has_id) {
    LinkRequest *request = find_request((uint32_t)id);
    if (request == NULL || request->kind != REQUEST_INSTALL) return;
    char text[160] = "install failed";
    json_find_string(message, "message", text, sizeof text);
    request_error_event(request, text);
    request_free(request, true);
  }
  /* Unknown `t` values are ignored (link.ts forward compatibility). */
}

static void handle_frame(uint8_t type, const uint8_t *payload, uint32_t length) {
  switch (type) {
    case LINK_FRAME_PING:
      pong_pending = true;
      break;
    case LINK_FRAME_PONG:
      if (ping_sent_ms != 0) rtt_ms = (uint32_t)(osGetTime() - ping_sent_ms);
      ping_sent_ms = 0;
      break;
    case LINK_FRAME_CTRL:
      if (length <= LINK_MAX_CTRL) handle_ctrl(payload, length);
      break;
    case LINK_FRAME_DATA:
      if (phase == PHASE_UP) handle_data(payload, length);
      break;
    default:
      break; /* skipped by length */
  }
}

static void pump_rx(void) {
  size_t budget = LINK_RX_BUDGET;
  while (tcp_fd >= 0) {
    while (rx_length >= LINK_HEADER_BYTES) {
      uint32_t length = link_read_u32(rx_buffer + 4);
      if (length > LINK_MAX_FRAME) {
        drop("protocol: frame too long");
        return;
      }
      size_t total = LINK_HEADER_BYTES + length;
      if (rx_length < total) break;
      handle_frame(rx_buffer[0], rx_buffer + LINK_HEADER_BYTES, length);
      if (tcp_fd < 0) return;
      memmove(rx_buffer, rx_buffer + total, rx_length - total);
      rx_length -= total;
    }
    /* The buffer holds one whole frame of the largest kind, so a partial
     * frame always leaves room to read into. */
    size_t want = sizeof rx_buffer - rx_length;
    if (want > budget) want = budget;
    if (want == 0) return;
    u64 started = svcGetSystemTick();
    ssize_t got = recv(tcp_fd, rx_buffer + rx_length, want, 0);
    rx_us += (svcGetSystemTick() - started) * 1000000u / SYSCLOCK_ARM11;
    if (got > 0) {
      rx_bytes += (uint64_t)got;
      rx_length += (size_t)got;
      budget -= (size_t)got;
      last_rx_ms = osGetTime();
      continue;
    }
    if (got == 0) drop("the companion closed the link");
    else if (!would_block()) drop("link connection lost");
    return;
  }
}

static void feed_request_bodies(void) {
  for (size_t i = 0; i < NET_MAX_INFLIGHT; i += 1) {
    NetRequest *request = &net_requests[i];
    while (request->phase == NET_HEAD && request->body_sent < request->body_length) {
      size_t chunk = request->body_length - request->body_sent;
      if (chunk > LINK_DATA_CHUNK) chunk = LINK_DATA_CHUNK;
      uint8_t stream[4];
      link_write_u32(stream, request->id);
      if (!queue_frame(LINK_FRAME_DATA, stream, 4, request->body + request->body_sent, chunk)) return;
      request->body_sent += chunk;
    }
    if (request->phase != NET_FREE && request->body_sent == request->body_length && request->body != NULL) {
      free(request->body);
      request->body = NULL;
    }
  }
}

static void pump_tx(void) {
  if (tcp_fd < 0) return;
  if (phase == PHASE_UP) {
    if (pong_pending && queue_frame(LINK_FRAME_PONG, NULL, 0, NULL, 0)) pong_pending = false;
    uint64_t now = osGetTime();
    if (since(last_ping_ms) >= LINK_PING_MS && queue_frame(LINK_FRAME_PING, NULL, 0, NULL, 0)) {
      last_ping_ms = now;
      if (ping_sent_ms == 0) ping_sent_ms = now;
    }
    feed_request_bodies();
  }
  while (tx_offset < tx_length) {
    ssize_t sent = send(tcp_fd, tx_buffer + tx_offset, tx_length - tx_offset, 0);
    if (sent > 0) {
      tx_offset += (size_t)sent;
      continue;
    }
    if (sent < 0 && would_block()) return;
    drop("link connection lost while sending");
    return;
  }
  tx_offset = 0;
  tx_length = 0;
}

static void expire_requests(void) {
  uint64_t now = osGetTime();
  for (size_t i = 0; i < NET_MAX_INFLIGHT; i += 1) {
    NetRequest *request = &net_requests[i];
    if ((request->phase == NET_HEAD || request->phase == NET_BODY) && now > request->deadline_ms) {
      net_error_event(request->id, "timeout", "net: the companion did not answer in time");
      send_net_cancel(request->id);
      net_free(request);
    }
  }
  for (size_t i = 0; i < LINK_MAX_REQUESTS; i += 1) {
    LinkRequest *request = &requests[i];
    if (request->kind != REQUEST_FREE && now > request->deadline_ms) {
      request_error_event(request, "the companion stopped answering");
      request_free(request, true);
    }
  }
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

static void ensure_beacon_socket(void) {
  if (beacon_fd >= 0) return;
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return;
  int reuse = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = INADDR_ANY;
  address.sin_port = htons(LINK_BEACON_PORT);
  if (bind(fd, (struct sockaddr *)&address, sizeof address) != 0 || !set_nonblocking(fd)) {
    close(fd);
    return;
  }
  beacon_fd = fd;
}

/* Drain datagrams; when `connect_now`, the first beacon of a paired
 * companion becomes the connect target. */
static bool poll_beacons(bool connect_now) {
  if (beacon_fd < 0) return false;
  for (uint32_t attempt_index = 0; attempt_index < 8; attempt_index += 1) {
    uint8_t datagram[128];
    struct sockaddr_in sender;
    socklen_t sender_length = sizeof sender;
    ssize_t length = recvfrom(beacon_fd, datagram, sizeof datagram, 0, (struct sockaddr *)&sender, &sender_length);
    if (length <= 0) break;
    if (!connect_now) continue;
    LinkBeacon beacon;
    if (!link_parse_beacon(datagram, (size_t)length, &beacon)) continue;
    Companion *companion = find_companion(beacon.companion);
    if (companion == NULL || osGetTime() < companion->refused_until_ms) continue;
    if (beacon.name[0] != '\0') snprintf(companion->name, sizeof companion->name, "%s", beacon.name);
    char address[16];
    snprintf(address, sizeof address, "%s", inet_ntoa(sender.sin_addr));
    connect_companion(companion, address, beacon.port);
    return true;
  }
  return false;
}

static void try_direct(void) {
  for (size_t tried = 0; tried < companion_count; tried += 1) {
    Companion *companion = &companions[direct_next % companion_count];
    direct_next += 1;
    if (companion->address[0] == '\0' || osGetTime() < companion->refused_until_ms) continue;
    connect_companion(companion, companion->address, companion->port);
    return;
  }
  /* Nothing to try directly: keep listening. */
  enter(PHASE_SEARCH);
}

// ---------------------------------------------------------------------------
// public surface
// ---------------------------------------------------------------------------

void link_init(PocketRuntimeState *state) {
  runtime_state = state;
  if (initialized) return;
  ps_ready = R_SUCCEEDED(psInit());
  ensure_directories();
  load_device_id();
  load_console_identity();
  load_companions();
  initialized = true;
  enter(companion_count == 0 ? PHASE_IDLE : PHASE_SEARCH);
}

static void pump(void);

void link_pump(void) {
  u64 started = svcGetSystemTick();
  pump();
  uint32_t us = (uint32_t)((svcGetSystemTick() - started) * 1000000u / SYSCLOCK_ARM11);
  if (us > pump_max_us) pump_max_us = us;
}

/* Beacons only matter while searching. In the other phases they are drained
 * every 30 frames (a beacon comes once a second) instead of costing a
 * socket call (an IPC round trip) on every frame. */
static void drain_beacons(void) {
  static uint32_t drains;
  if (drains++ % 30 == 0) poll_beacons(false);
}

static void pump(void) {
  if (!initialized) return;
  if (companion_count == 0 && !pair_active) {
    if (phase != PHASE_IDLE) drop("no companion is paired");
    phase = PHASE_IDLE;
    return;
  }
  if (!soc_active() && !soc_ensure(NULL, 0)) return;
  ensure_beacon_socket();
  switch (phase) {
    case PHASE_IDLE:
      enter(PHASE_SEARCH);
      break;
    case PHASE_SEARCH:
      if (pair_active) {
        drain_beacons();
        pair_host = 0;
        start_next_pair_host();
      } else if (!poll_beacons(true) && since(phase_since_ms) > LINK_SEARCH_DIRECT_MS) {
        try_direct();
      }
      break;
    case PHASE_CONNECTING:
      drain_beacons();
      pump_connecting();
      break;
    case PHASE_CHALLENGE:
    case PHASE_AUTH:
      drain_beacons();
      pump_tx();
      pump_rx();
      if ((phase == PHASE_CHALLENGE || phase == PHASE_AUTH) && since(phase_since_ms) > LINK_HANDSHAKE_TIMEOUT_MS) {
        drop("handshake timed out");
      }
      break;
    case PHASE_UP:
      drain_beacons();
      pump_rx();
      expire_requests();
      pump_tx();
      if (phase == PHASE_UP && since(last_rx_ms) > LINK_SILENCE_MS) drop("the companion went silent");
      break;
    case PHASE_BACKOFF:
      if (pair_active) {
        drain_beacons();
        pair_host = 0;
        start_next_pair_host();
      } else if (!poll_beacons(false) && since(phase_since_ms) > backoff_ms) {
        backoff_ms = backoff_ms * 2 > LINK_BACKOFF_MAX_MS ? LINK_BACKOFF_MAX_MS : backoff_ms * 2;
        enter(PHASE_SEARCH);
      }
      break;
  }
}

void link_shutdown(void) {
  if (!initialized) return;
  close_connection();
  fail_requests("the console is shutting down");
  for (size_t i = 0; i < NET_MAX_INFLIGHT; i += 1) net_free(&net_requests[i]);
  if (beacon_fd >= 0) close(beacon_fd);
  beacon_fd = -1;
  jbuf_free(&link_events);
  jbuf_free(&net_events);
  jbuf_free(&poll_out);
  jbuf_free(&status_out);
  jbuf_free(&scratch);
  if (ps_ready) psExit();
  ps_ready = false;
  initialized = false;
  phase = PHASE_IDLE;
}

void link_reset_guest(void) {
  for (size_t i = 0; i < NET_MAX_INFLIGHT; i += 1) {
    NetRequest *request = &net_requests[i];
    if (request->phase == NET_HEAD || request->phase == NET_BODY) send_net_cancel(request->id);
    net_free(request);
  }
  for (size_t i = 0; i < LINK_MAX_REQUESTS; i += 1) {
    LinkRequest *request = &requests[i];
    if (request->kind == REQUEST_CATALOG) request_free(request, false);
    /* An install keeps streaming into storage; only its events stop. */
    else if (request->kind == REQUEST_INSTALL) request->guest = false;
  }
  jbuf_reset(&link_events);
  jbuf_reset(&net_events);
  net_error[0] = '\0';
}

static void status_companion(JsonBuffer *out, const char *id, const char *name, const char *address, uint16_t port) {
  jbuf_text(out, "{\"id\":");
  jbuf_cstring(out, id);
  jbuf_text(out, ",\"name\":");
  jbuf_cstring(out, name);
  jbuf_text(out, ",\"address\":");
  jbuf_cstring(out, address);
  jbuf_text(out, ",\"port\":");
  jbuf_u64(out, port);
  jbuf_text(out, "}");
}

static const char *state_name(void) {
  if (companion_count == 0 && !pair_active && phase != PHASE_UP) return "unpaired";
  switch (phase) {
    case PHASE_UP: return "linked";
    case PHASE_CONNECTING:
    case PHASE_CHALLENGE:
    case PHASE_AUTH: return "connecting";
    default: return "searching";
  }
}

static void console_address(char *out, size_t capacity) {
  out[0] = '\0';
  if (!soc_active()) return;
  struct in_addr address;
  address.s_addr = (in_addr_t)gethostid();
  if (address.s_addr != 0) snprintf(out, capacity, "%s", inet_ntoa(address));
}

const char *link_status_json(void) {
  JsonBuffer *out = &status_out;
  jbuf_reset(out);
  jbuf_text(out, "{\"state\":\"");
  jbuf_text(out, state_name());
  jbuf_text(out, "\",\"companion\":");
  bool engaged = phase == PHASE_UP || phase == PHASE_CONNECTING || phase == PHASE_CHALLENGE || phase == PHASE_AUTH;
  if (engaged) status_companion(out, attempt.companion, attempt.name, attempt.address, attempt.port);
  else jbuf_text(out, "null");
  jbuf_text(out, ",\"paired\":[");
  for (size_t i = 0; i < companion_count; i += 1) {
    if (i > 0) jbuf_text(out, ",");
    status_companion(out, companions[i].id, companions[i].name, companions[i].address, companions[i].port);
  }
  char address[16];
  console_address(address, sizeof address);
  jbuf_text(out, "],\"device\":{\"id\":");
  jbuf_cstring(out, device_id);
  jbuf_text(out, ",\"name\":");
  jbuf_cstring(out, device_name);
  jbuf_text(out, ",\"model\":");
  jbuf_cstring(out, device_model);
  jbuf_text(out, ",\"address\":");
  jbuf_cstring(out, address);
  jbuf_text(out, "},\"pairing\":\"");
  jbuf_text(out, pairing);
  jbuf_text(out, "\",\"error\":");
  jbuf_cstring(out, last_error);
  jbuf_text(out, ",\"features\":");
  jbuf_text(out, phase == PHASE_UP ? features_json : "[]");
  jbuf_text(out, ",\"clock\":");
  if (clock_known) {
    jbuf_text(out, "{\"utc\":");
    jbuf_i64(out, (int64_t)console_epoch_ms() + clock_skew_ms);
    jbuf_text(out, ",\"offsetMinutes\":");
    jbuf_i64(out, clock_offset_min);
    jbuf_text(out, "}");
  } else {
    jbuf_text(out, "null");
  }
  /* Host diagnostics beyond LinkStatus: the last handshake's duration and
   * the last ping round trip, both in milliseconds. */
  jbuf_text(out, ",\"connectMs\":");
  jbuf_u64(out, connect_ms);
  jbuf_text(out, ",\"rttMs\":");
  jbuf_u64(out, rtt_ms);
  /* Stream diagnostics since the last status read: received bytes, time in
   * recv(), time writing installs to the SD card, the slowest pump. */
  jbuf_text(out, ",\"rxBytes\":");
  jbuf_u64(out, rx_bytes);
  jbuf_text(out, ",\"rxUs\":");
  jbuf_u64(out, rx_us);
  jbuf_text(out, ",\"sdUs\":");
  jbuf_u64(out, sd_us);
  jbuf_text(out, ",\"pumpMaxUs\":");
  jbuf_u64(out, pump_max_us);
  rx_bytes = 0;
  rx_us = 0;
  sd_us = 0;
  pump_max_us = 0;
  jbuf_text(out, "}");
  const char *text = jbuf_cstr(out);
  return text == NULL ? "{\"state\":\"unpaired\",\"error\":\"link: status overflow\"}" : text;
}

bool link_pair(const char *uri, size_t length) {
  if (!initialized) return false;
  LinkPairUri parsed;
  if (!link_parse_pair_uri(uri, length, &parsed)) return false;
  /* One link at a time: the pairing replaces whatever was up. */
  if (tcp_fd >= 0) {
    close_connection();
    fail_requests("the link was replaced by a pairing");
  }
  pair_uri = parsed;
  pair_active = true;
  pair_host = 0;
  pairing = "connecting";
  set_error("");
  enter(PHASE_SEARCH);
  return true;
}

bool link_forget(const char *companion) {
  if (!initialized || companion == NULL) return false;
  for (size_t i = 0; i < companion_count; i += 1) {
    if (strcmp(companions[i].id, companion) != 0) continue;
    bool engaged = strcmp(attempt.companion, companion) == 0 && phase != PHASE_SEARCH && phase != PHASE_BACKOFF &&
                   phase != PHASE_IDLE;
    char path[96];
    companion_path(companion, path, sizeof path);
    remove(path);
    memset(&companions[i], 0, sizeof companions[i]);
    memmove(companions + i, companions + i + 1, (companion_count - i - 1) * sizeof companions[0]);
    companion_count -= 1;
    if (engaged) {
      close_connection();
      fail_requests("the companion was forgotten");
      enter(companion_count == 0 && !pair_active ? PHASE_IDLE : PHASE_BACKOFF);
    }
    return true;
  }
  return false;
}

static LinkRequest *open_request(RequestKind kind) {
  if (phase != PHASE_UP) return NULL;
  for (size_t i = 0; i < LINK_MAX_REQUESTS; i += 1) {
    if (requests[i].kind != REQUEST_FREE) continue;
    LinkRequest *request = &requests[i];
    memset(request, 0, sizeof *request);
    request->kind = kind;
    request->id = take_id();
    request->guest = true;
    request->deadline_ms = osGetTime() + LINK_REQUEST_STALL_MS;
    return request;
  }
  return NULL;
}

int32_t link_catalog(void) {
  if (!has_feature("catalog")) return -1;
  LinkRequest *request = open_request(REQUEST_CATALOG);
  if (request == NULL) return -1;
  jbuf_reset(&scratch);
  jbuf_text(&scratch, "{\"t\":\"catalog\",\"id\":");
  jbuf_u64(&scratch, request->id);
  jbuf_text(&scratch, "}");
  if (!queue_scratch()) {
    request_free(request, false);
    return -1;
  }
  return (int32_t)request->id;
}

int32_t link_install(const char *app_id, size_t length) {
  if (app_id == NULL || length == 0 || length >= LAUNCHER_ID_BYTES || !has_feature("install")) return -1;
  char slot[17];
  sha256_slot(app_id, length, slot);
  for (size_t i = 0; i < LINK_MAX_REQUESTS; i += 1) {
    if (requests[i].kind == REQUEST_INSTALL && strcmp(requests[i].slot, slot) == 0) return -1;
  }
  LinkRequest *request = open_request(REQUEST_INSTALL);
  if (request == NULL) return -1;
  memcpy(request->app, app_id, length);
  request->app[length] = '\0';
  memcpy(request->slot, slot, sizeof request->slot);
  jbuf_reset(&scratch);
  jbuf_text(&scratch, "{\"t\":\"install\",\"id\":");
  jbuf_u64(&scratch, request->id);
  jbuf_text(&scratch, ",\"app\":");
  jbuf_string(&scratch, app_id, length);
  jbuf_text(&scratch, "}");
  if (!queue_scratch()) {
    request_free(request, false);
    return -1;
  }
  return (int32_t)request->id;
}

bool link_remove(const char *app_id, size_t length) {
  if (app_id == NULL || length == 0 || length >= LAUNCHER_ID_BYTES) return false;
  char slot[17];
  sha256_slot(app_id, length, slot);
  if (strcmp(slot, runtime_slot()) == 0 || strcmp(slot, launcher_home_slot()) == 0) return false;
  for (size_t i = 0; i < LINK_MAX_REQUESTS; i += 1) {
    if (requests[i].kind == REQUEST_INSTALL && strcmp(requests[i].slot, slot) == 0) return false;
  }
  char error[160];
  char root[96];
  struct stat info;
  if (!runtime_slot_path(slot, NULL, root, sizeof root) || stat(root, &info) != 0) return false;
  bool removed = runtime_slot_remove(slot, error, sizeof error);
  launcher_invalidate();
  return removed;
}

static const char *drain(JsonBuffer *events) {
  if (events->length == 0) return NULL;
  jbuf_reset(&poll_out);
  jbuf_text(&poll_out, "[");
  jbuf_raw(&poll_out, events->data, events->length);
  jbuf_text(&poll_out, "]");
  jbuf_reset(events);
  return jbuf_cstr(&poll_out);
}

const char *link_poll(void) {
  return drain(&link_events);
}

int32_t link_net_start(const char *meta, size_t meta_length, const uint8_t *body, size_t body_length) {
  net_error[0] = '\0';
  if (!initialized || phase != PHASE_UP) {
    snprintf(net_error, sizeof net_error, "unavailable: no companion linked");
    return -1;
  }
  if (!has_feature("net")) {
    snprintf(net_error, sizeof net_error, "unavailable: the linked companion does not serve net requests");
    return -1;
  }
  NetRequest *request = NULL;
  for (size_t i = 0; i < NET_MAX_INFLIGHT; i += 1) {
    if (net_requests[i].phase == NET_FREE) {
      request = &net_requests[i];
      break;
    }
  }
  if (request == NULL) {
    snprintf(net_error, sizeof net_error, "busy: %u requests are already in flight", NET_MAX_INFLIGHT);
    return -1;
  }
  if (body_length > NET_MAX_REQUEST_BYTES) {
    snprintf(net_error, sizeof net_error, "invalid_request: request body exceeds 64 KiB");
    return -1;
  }
  JsonSpan object = json_span(meta, meta_length);
  JsonSpan url;
  size_t open = 0;
  while (open < meta_length && (meta[open] == ' ' || meta[open] == '\n' || meta[open] == '\t' || meta[open] == '\r')) {
    open += 1;
  }
  if (meta == NULL || open >= meta_length || meta[open] != '{' || !json_find(object, "url", &url) ||
      meta_length > LINK_MAX_CTRL - 512) {
    snprintf(net_error, sizeof net_error, "invalid_request: malformed request metadata");
    return -1;
  }
  uint64_t max_bytes = NET_DEFAULT_RESPONSE_BYTES;
  uint64_t timeout_ms = NET_DEFAULT_TIMEOUT_MS;
  json_find_u64(object, "maxBytes", &max_bytes);
  json_find_u64(object, "timeoutMs", &timeout_ms);
  if (max_bytes == 0 || max_bytes > NET_MAX_RESPONSE_BYTES) max_bytes = NET_MAX_RESPONSE_BYTES;
  if (timeout_ms == 0 || timeout_ms > NET_MAX_TIMEOUT_MS) timeout_ms = NET_MAX_TIMEOUT_MS;

  uint32_t id = take_id();
  /* The guest's metadata object, extended with the link fields:
   * {"t":"net","id":n,"app":"…","bytes":k, <meta members>} */
  jbuf_reset(&scratch);
  jbuf_text(&scratch, "{\"t\":\"net\",\"id\":");
  jbuf_u64(&scratch, id);
  jbuf_text(&scratch, ",\"app\":");
  jbuf_cstring(&scratch, launcher_current_app_id());
  jbuf_text(&scratch, ",\"bytes\":");
  jbuf_u64(&scratch, body_length);
  size_t rest = open + 1;
  while (rest < meta_length && (meta[rest] == ' ' || meta[rest] == '\n' || meta[rest] == '\t' || meta[rest] == '\r')) {
    rest += 1;
  }
  if (rest < meta_length && meta[rest] != '}') jbuf_text(&scratch, ",");
  jbuf_raw(&scratch, meta + rest, meta_length - rest);
  if (!queue_scratch()) {
    snprintf(net_error, sizeof net_error, "busy: the link outbox is full");
    return -1;
  }
  memset(request, 0, sizeof *request);
  request->phase = NET_HEAD;
  request->id = id;
  request->max_bytes = (uint32_t)max_bytes;
  request->deadline_ms = osGetTime() + timeout_ms + NET_GRACE_MS;
  if (body_length > 0) {
    request->body = malloc(body_length);
    if (request->body == NULL) {
      /* The ctrl already left: cancel it rather than stall the companion. */
      send_net_cancel(id);
      memset(request, 0, sizeof *request);
      snprintf(net_error, sizeof net_error, "other: request body allocation failed");
      return -1;
    }
    memcpy(request->body, body, body_length);
    request->body_length = body_length;
  }
  return (int32_t)id;
}

int32_t link_net_take(int32_t handle, uint8_t *into, size_t length) {
  if (handle <= 0) return -1;
  NetRequest *request = find_net((uint32_t)handle);
  if (request == NULL || request->phase != NET_DONE || length != request->response_length) return -1;
  if (length > 0) memcpy(into, request->response, length);
  net_free(request);
  return (int32_t)length;
}

void link_net_cancel(int32_t handle) {
  if (handle <= 0) return;
  NetRequest *request = find_net((uint32_t)handle);
  if (request == NULL) return;
  if (request->phase == NET_HEAD || request->phase == NET_BODY) send_net_cancel(request->id);
  net_free(request);
}

const char *link_net_poll(void) {
  return drain(&net_events);
}

const char *link_net_last_error(void) {
  return net_error;
}

bool link_agent_ready(void) {
  return phase == PHASE_UP && has_feature("agent");
}

bool link_send_ctrl(const char *json, size_t length) {
  return phase == PHASE_UP && queue_ctrl(json, length);
}

bool link_send_data(uint32_t stream, const uint8_t *bytes, size_t length) {
  if (phase != PHASE_UP || length > LINK_MAX_DATA) return false;
  uint8_t prefix[4];
  link_write_u32(prefix, stream);
  return queue_frame(LINK_FRAME_DATA, prefix, 4, bytes, length);
}

uint32_t link_new_stream(void) {
  return take_id();
}

bool link_clock_now(int64_t *utc_ms, int32_t *offset_min) {
  if (!clock_known) return false;
  *utc_ms = (int64_t)console_epoch_ms() + clock_skew_ms;
  *offset_min = clock_offset_min;
  return true;
}

void link_describe(char *out, size_t capacity) {
  const char *state = state_name();
  if (strcmp(state, "linked") == 0) snprintf(out, capacity, "LINKED %s", attempt.name);
  else if (strcmp(state, "connecting") == 0) snprintf(out, capacity, "CONNECTING %s", attempt.address);
  else if (strcmp(state, "searching") == 0) snprintf(out, capacity, "SEARCHING %u PAIRED", (unsigned)companion_count);
  else snprintf(out, capacity, "NOT PAIRED");
}

#else /* capture and offload builds: an unpaired console with no link */

void link_init(PocketRuntimeState *state) { (void)state; }
void link_pump(void) {}
void link_shutdown(void) {}
void link_reset_guest(void) {}

const char *link_status_json(void) {
  return "{\"state\":\"unpaired\",\"companion\":null,\"paired\":[],"
         "\"device\":{\"id\":\"\",\"name\":\"\",\"model\":\"\",\"address\":\"\"},"
         "\"pairing\":\"idle\",\"error\":\"this build has no Pocket Link\",\"features\":[]}";
}

bool link_pair(const char *uri, size_t length) {
  (void)uri;
  (void)length;
  return false;
}

bool link_forget(const char *companion) {
  (void)companion;
  return false;
}

int32_t link_catalog(void) { return -1; }

int32_t link_install(const char *app_id, size_t length) {
  (void)app_id;
  (void)length;
  return -1;
}

bool link_remove(const char *app_id, size_t length) {
  (void)app_id;
  (void)length;
  return false;
}

const char *link_poll(void) { return NULL; }

int32_t link_net_start(const char *meta, size_t meta_length, const uint8_t *body, size_t body_length) {
  (void)meta;
  (void)meta_length;
  (void)body;
  (void)body_length;
  return -1;
}

int32_t link_net_take(int32_t handle, uint8_t *into, size_t length) {
  (void)handle;
  (void)into;
  (void)length;
  return -1;
}

void link_net_cancel(int32_t handle) { (void)handle; }
const char *link_net_poll(void) { return NULL; }
const char *link_net_last_error(void) { return "unavailable: this build has no Pocket Link"; }
bool link_agent_ready(void) { return false; }
bool link_send_ctrl(const char *json, size_t length) {
  (void)json;
  (void)length;
  return false;
}
bool link_send_data(uint32_t stream, const uint8_t *bytes, size_t length) {
  (void)stream;
  (void)bytes;
  (void)length;
  return false;
}
uint32_t link_new_stream(void) { return 0; }
bool link_clock_now(int64_t *utc_ms, int32_t *offset_min) {
  (void)utc_ms;
  (void)offset_min;
  return false;
}

void link_describe(char *out, size_t capacity) {
  snprintf(out, capacity, "NO LINK");
}

#endif /* POCKETJS_LINK */
