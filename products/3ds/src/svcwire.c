/*
 * SVC WIRE (PKNT) client — see svcwire.h. Byte layouts come verbatim from
 * contracts/spec/spec.ts "SVC WIRE protocol" (the Rust codec in
 * engine/modules/media/src/wire.rs is the executable reference):
 *
 *   beacon (UDP, host -> broadcast, once a second):
 *     u32 'PKDB' LE · u8 version · u8 reserved · u16 tcpPort LE ·
 *     u8 appLen · app · u8 nameLen · name
 *   hello (device -> host, before any frame):
 *     u32 'PKNT' LE · u8 version · u8 reserved · u8 appLen · app
 *   hello ack (host -> device): u32 'PKNT' LE · u8 acceptedVersion ·
 *     u8 flags · u16 reserved
 *   frame header (8 bytes): u8 type · u8 flags · u16 reserved ·
 *     u32 payloadLen LE
 *
 * Types handled: ping (echoed as pong), ctrl (one JSON line -> the poll
 * queue). Everything else — file, stream, unknown — is skipped by length,
 * the protocol's forward-compatibility rule.
 *
 * Like the Vita transport this host never blocks a frame on the network:
 * every socket is non-blocking and svcwire_pump does a bounded amount of
 * work per call. Unlike the Vita there are no threads — the devserver.c
 * discipline, because the pump already runs at 60 Hz next to it.
 *
 * Under POCKETJS_CAPTURE the whole transport is compiled out to inert
 * stubs: svcOpen reports false forever and golden runs stay deterministic
 * (the Vita3K init-fails-forever contract).
 */

#include "svcwire.h"

#ifndef POCKETJS_CAPTURE

#include <3ds.h>
#include <arpa/inet.h>
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
#include <unistd.h>

#include "dev_protocol.h"
#include "soc.h"

#define SVC_WIRE_MAGIC 0x544e4b50u /* 'PKNT' little-endian */
#define SVC_BEACON_MAGIC 0x42444b50u /* 'PKDB' little-endian */
#define SVC_WIRE_VERSION 1u
#define SVC_WIRE_HEADER_BYTES 8u
#define SVC_WIRE_MAX_PAYLOAD (256u * 1024u)
#define SVC_BEACON_PORT 8621u
#define SVC_WIRE_PORT 8622u
#define SVC_MSG_PING 0x01u
#define SVC_MSG_PONG 0x02u
#define SVC_MSG_CTRL 0x10u

/* contracts/spec/spec.ts SVC_POLL_BUF: max bytes consumed per svcPoll. */
#define SVC_POLL_BUF 8192u
/* One ctrl line is capped at SVC_POLL_BUF by the protocol; the rx buffer
 * only ever has to reassemble one frame of that size. */
#define SVC_RX_BYTES (SVC_WIRE_HEADER_BYTES + SVC_POLL_BUF)
#define SVC_LINES_BYTES (32u * 1024u)
#define SVC_TX_BYTES (16u * 1024u)
#define SVC_PING_MAX 16u

#define SVC_CONNECT_TIMEOUT_MS 3000u
#define SVC_HELLO_TIMEOUT_MS 5000u
#define SVC_SILENCE_TIMEOUT_MS 10000u
#define SVC_BACKOFF_MS 1000u
#define SVC_HOST_TXT "sdmc:/pocketjs/host.txt"

typedef enum {
  SVC_STATE_IDLE,
  SVC_STATE_DISCOVER,
  SVC_STATE_CONNECTING,
  SVC_STATE_HELLO_WAIT,
  SVC_STATE_UP,
  SVC_STATE_BACKOFF,
} SvcState;

static bool enabled;
static char app_id[65];
static SvcState state = SVC_STATE_IDLE;
static int beacon_fd = -1;
static int tcp_fd = -1;
static struct sockaddr_in target;
static bool target_from_host_txt;
static bool host_txt_failed;
static uint64_t state_since_ms;
static uint64_t last_rx_ms;

static uint8_t rx_buffer[SVC_RX_BYTES];
static size_t rx_length;
static uint32_t skip_remaining;
static char lines[SVC_LINES_BYTES];
static size_t lines_length;
static uint8_t tx_buffer[SVC_TX_BYTES];
static size_t tx_length;
static size_t tx_offset;
static bool pong_pending;
static uint8_t pong_payload[SVC_PING_MAX];
static uint32_t pong_length;

static bool would_block(void) {
  return errno == EAGAIN || errno == EWOULDBLOCK;
}

static bool set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static void enter_state(SvcState next) {
  state = next;
  state_since_ms = osGetTime();
}

static void close_connection(void) {
  if (tcp_fd >= 0) close(tcp_fd);
  tcp_fd = -1;
  rx_length = 0;
  skip_remaining = 0;
  tx_length = 0;
  tx_offset = 0;
  pong_pending = false;
}

static void drop_to_backoff(void) {
  bool failed_override = target_from_host_txt;
  close_connection();
  /* A stale host.txt (the Mac's DHCP lease moved on) must degrade into
   * beacon discovery instead of wedging the transport — the alternation the
   * Vita transport learned on hardware day. */
  if (failed_override) host_txt_failed = true;
  enter_state(SVC_STATE_BACKOFF);
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
  address.sin_port = htons(SVC_BEACON_PORT);
  if (bind(fd, (struct sockaddr *)&address, sizeof address) != 0 || !set_nonblocking(fd)) {
    close(fd);
    return;
  }
  beacon_fd = fd;
}

/* Drain beacon datagrams. While DISCOVERing, the first one advertising our
 * app id becomes the connect target; in every other state the datagrams are
 * discarded so the socket buffer never fills. */
static bool poll_beacon(struct sockaddr_in *out) {
  if (beacon_fd < 0) return false;
  bool found = false;
  for (uint32_t attempt = 0; attempt < 4; attempt += 1) {
    uint8_t datagram[160];
    struct sockaddr_in sender;
    socklen_t sender_length = sizeof sender;
    ssize_t length = recvfrom(
      beacon_fd,
      datagram,
      sizeof datagram,
      0,
      (struct sockaddr *)&sender,
      &sender_length
    );
    if (length <= 0) break;
    if (found || out == NULL) continue;
    if ((size_t)length < 10) continue;
    if (pocket_runtime_read_u32(datagram) != SVC_BEACON_MAGIC) continue;
    if (datagram[4] != SVC_WIRE_VERSION) continue;
    uint16_t port = pocket_runtime_read_u16(datagram + 6);
    size_t app_length = datagram[8];
    if (9 + app_length > (size_t)length) continue;
    if (app_length != strlen(app_id)) continue;
    if (memcmp(datagram + 9, app_id, app_length) != 0) continue;
    *out = sender;
    out->sin_port = htons(port);
    found = true;
  }
  return found;
}

/* `sdmc:/pocketjs/host.txt` override — one line, `a.b.c.d[:port]` — for
 * broadcast-hostile networks. */
static bool read_host_txt(struct sockaddr_in *out) {
  FILE *file = fopen(SVC_HOST_TXT, "rb");
  if (file == NULL) return false;
  char text[64] = {0};
  size_t length = fread(text, 1, sizeof text - 1, file);
  fclose(file);
  while (length > 0 && (text[length - 1] == '\n' || text[length - 1] == '\r' ||
                        text[length - 1] == ' ')) {
    text[--length] = '\0';
  }
  unsigned port = SVC_WIRE_PORT;
  char *colon = strchr(text, ':');
  if (colon != NULL) {
    *colon = '\0';
    port = (unsigned)strtoul(colon + 1, NULL, 10);
    if (port == 0 || port > 65535) return false;
  }
  struct in_addr address;
  if (inet_aton(text, &address) == 0) return false;
  memset(out, 0, sizeof *out);
  out->sin_family = AF_INET;
  out->sin_addr = address;
  out->sin_port = htons((uint16_t)port);
  return true;
}

static void start_connect(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    enter_state(SVC_STATE_BACKOFF);
    return;
  }
  if (!set_nonblocking(fd)) {
    close(fd);
    enter_state(SVC_STATE_BACKOFF);
    return;
  }
#ifdef TCP_NODELAY
  /* Input lines are latency-bound; batching is already done frame-side. */
  int nodelay = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof nodelay);
#endif
  tcp_fd = fd;
  int rc = connect(tcp_fd, (struct sockaddr *)&target, sizeof target);
  if (rc == 0) {
    enter_state(SVC_STATE_CONNECTING); /* hello goes out on the next pump */
    return;
  }
  if (errno == EINPROGRESS || errno == EWOULDBLOCK) {
    enter_state(SVC_STATE_CONNECTING);
    return;
  }
  drop_to_backoff();
}

static void pump_discover(void) {
  ensure_beacon_socket();
  struct sockaddr_in candidate;
  if (!host_txt_failed && read_host_txt(&candidate)) {
    target = candidate;
    target_from_host_txt = true;
    start_connect();
    return;
  }
  if (poll_beacon(&candidate)) {
    target = candidate;
    target_from_host_txt = false;
    host_txt_failed = false; /* a fresh beacon re-arms the override for later */
    start_connect();
  }
}

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

/* Queue the device hello. The tx buffer is empty on a fresh connection, so
 * this cannot fail for space. */
static void queue_hello(void) {
  size_t app_length = strlen(app_id);
  uint8_t hello[7 + sizeof app_id];
  pocket_runtime_write_u32(hello, SVC_WIRE_MAGIC);
  hello[4] = SVC_WIRE_VERSION;
  hello[5] = 0;
  hello[6] = (uint8_t)app_length;
  memcpy(hello + 7, app_id, app_length);
  memcpy(tx_buffer, hello, 7 + app_length);
  tx_length = 7 + app_length;
  tx_offset = 0;
}

static void pump_connecting(void) {
  /* Re-issuing connect() on a non-blocking socket reports progress without
   * select(): EALREADY while in flight, EISCONN (or 0) once established. */
  int rc = connect(tcp_fd, (struct sockaddr *)&target, sizeof target);
  if (rc == 0 || errno == EISCONN) {
    queue_hello();
    last_rx_ms = osGetTime();
    enter_state(SVC_STATE_HELLO_WAIT);
    return;
  }
  if (errno == EALREADY || errno == EINPROGRESS || errno == EWOULDBLOCK) {
    if (osGetTime() - state_since_ms > SVC_CONNECT_TIMEOUT_MS) drop_to_backoff();
    return;
  }
  drop_to_backoff();
}

static bool queue_frame(uint8_t type, const uint8_t *payload, size_t length) {
  if (SVC_WIRE_HEADER_BYTES + length > sizeof tx_buffer - tx_length) {
    if (tx_offset > 0) {
      memmove(tx_buffer, tx_buffer + tx_offset, tx_length - tx_offset);
      tx_length -= tx_offset;
      tx_offset = 0;
    }
    if (SVC_WIRE_HEADER_BYTES + length > sizeof tx_buffer - tx_length) return false;
  }
  uint8_t *at = tx_buffer + tx_length;
  at[0] = type;
  at[1] = 0;
  at[2] = 0;
  at[3] = 0;
  pocket_runtime_write_u32(at + 4, (uint32_t)length);
  if (length > 0) memcpy(at + SVC_WIRE_HEADER_BYTES, payload, length);
  tx_length += SVC_WIRE_HEADER_BYTES + length;
  return true;
}

/* Append one host line to the poll queue (newline-terminated), dropping the
 * oldest queued lines when full — the Vita transport's bounded-queue rule. */
static void append_line(const uint8_t *bytes, size_t length) {
  if (length == 0 || length + 1 > sizeof lines) return;
  if (memchr(bytes, '\n', length) != NULL || memchr(bytes, '\r', length) != NULL) return;
  while (length + 1 > sizeof lines - lines_length) {
    char *oldest_end = memchr(lines, '\n', lines_length);
    if (oldest_end == NULL) {
      lines_length = 0;
      break;
    }
    size_t drop = (size_t)(oldest_end - lines) + 1;
    memmove(lines, lines + drop, lines_length - drop);
    lines_length -= drop;
  }
  memcpy(lines + lines_length, bytes, length);
  lines_length += length;
  lines[lines_length++] = '\n';
}

static void handle_frame(uint8_t type, const uint8_t *payload, uint32_t length) {
  switch (type) {
    case SVC_MSG_PING:
      if (length <= SVC_PING_MAX) {
        memcpy(pong_payload, payload, length);
        pong_length = length;
        pong_pending = true;
      }
      break;
    case SVC_MSG_CTRL:
      append_line(payload, length);
      break;
    default:
      /* file/stream/unknown types are skipped for forward compatibility. */
      break;
  }
}

static void pump_rx(void) {
  for (;;) {
    /* An oversized (or unwanted-bulk) payload is drained without buffering. */
    if (skip_remaining > 0) {
      uint8_t sink[1024];
      size_t want = skip_remaining < sizeof sink ? skip_remaining : sizeof sink;
      ssize_t got = recv(tcp_fd, sink, want, 0);
      if (got > 0) {
        skip_remaining -= (uint32_t)got;
        last_rx_ms = osGetTime();
        continue;
      }
      if (got == 0 || !would_block()) drop_to_backoff();
      return;
    }

    if (rx_length < sizeof rx_buffer) {
      ssize_t got = recv(tcp_fd, rx_buffer + rx_length, sizeof rx_buffer - rx_length, 0);
      if (got > 0) {
        rx_length += (size_t)got;
        last_rx_ms = osGetTime();
      } else if (got == 0 || !would_block()) {
        drop_to_backoff();
        return;
      }
    }

    if (state == SVC_STATE_HELLO_WAIT) {
      if (rx_length < 8) return;
      if (pocket_runtime_read_u32(rx_buffer) != SVC_WIRE_MAGIC ||
          rx_buffer[4] != SVC_WIRE_VERSION) {
        drop_to_backoff();
        return;
      }
      memmove(rx_buffer, rx_buffer + 8, rx_length - 8);
      rx_length -= 8;
      enter_state(SVC_STATE_UP);
    }

    bool progressed = false;
    while (rx_length >= SVC_WIRE_HEADER_BYTES) {
      uint32_t payload_length = pocket_runtime_read_u32(rx_buffer + 4);
      if (rx_buffer[2] != 0 || rx_buffer[3] != 0 || payload_length > SVC_WIRE_MAX_PAYLOAD) {
        drop_to_backoff();
        return;
      }
      if (SVC_WIRE_HEADER_BYTES + payload_length > sizeof rx_buffer) {
        /* Consume the header and whatever payload is already buffered, then
         * drain the rest in skip mode. */
        uint8_t type = rx_buffer[0];
        (void)type;
        size_t buffered = rx_length - SVC_WIRE_HEADER_BYTES;
        size_t consumed = buffered < payload_length ? buffered : payload_length;
        skip_remaining = payload_length - (uint32_t)consumed;
        memmove(
          rx_buffer,
          rx_buffer + SVC_WIRE_HEADER_BYTES + consumed,
          rx_length - SVC_WIRE_HEADER_BYTES - consumed
        );
        rx_length -= SVC_WIRE_HEADER_BYTES + consumed;
        progressed = true;
        break;
      }
      size_t total = SVC_WIRE_HEADER_BYTES + payload_length;
      if (rx_length < total) break;
      handle_frame(rx_buffer[0], rx_buffer + SVC_WIRE_HEADER_BYTES, payload_length);
      if (tcp_fd < 0) return; /* handle_frame path dropped the connection */
      memmove(rx_buffer, rx_buffer + total, rx_length - total);
      rx_length -= total;
      progressed = true;
    }
    if (!progressed && rx_length < sizeof rx_buffer && skip_remaining == 0) return;
  }
}

static void pump_tx(void) {
  if (tcp_fd < 0) return;
  if (state == SVC_STATE_UP && pong_pending &&
      queue_frame(SVC_MSG_PONG, pong_payload, pong_length)) {
    pong_pending = false;
  }
  if (tx_offset >= tx_length) return;
  ssize_t sent = send(tcp_fd, tx_buffer + tx_offset, tx_length - tx_offset, 0);
  if (sent > 0) {
    tx_offset += (size_t)sent;
    if (tx_offset == tx_length) {
      tx_offset = 0;
      tx_length = 0;
    }
    return;
  }
  if (sent < 0 && would_block()) return;
  drop_to_backoff();
}

// ---------------------------------------------------------------------------
// public surface
// ---------------------------------------------------------------------------

bool svcwire_open(const char *app) {
  if (app == NULL || app[0] == '\0' || strlen(app) > 64) return false;
  if (!soc_active() && !soc_ensure(NULL, 0)) {
    /* soc.c retries behind a cooldown: a boot-time WiFi hiccup recovers on a
     * later frame instead of latching the process offline, while a stackless
     * environment costs one cheap check per cooldown window. */
    return false;
  }
  if (enabled && strcmp(app_id, app) != 0) {
    /* One companion per guest: a new app id restarts discovery. */
    close_connection();
    lines_length = 0;
    enter_state(SVC_STATE_DISCOVER);
  }
  snprintf(app_id, sizeof app_id, "%s", app);
  if (!enabled) {
    enabled = true;
    enter_state(SVC_STATE_DISCOVER);
  }
  return state == SVC_STATE_UP;
}

void svcwire_pump(void) {
  if (!enabled) return;
  switch (state) {
    case SVC_STATE_IDLE:
      break;
    case SVC_STATE_DISCOVER:
      pump_discover();
      break;
    case SVC_STATE_CONNECTING:
      poll_beacon(NULL);
      pump_connecting();
      break;
    case SVC_STATE_HELLO_WAIT:
      poll_beacon(NULL);
      pump_tx();
      if (tcp_fd < 0) break;
      pump_rx();
      if (state == SVC_STATE_HELLO_WAIT &&
          osGetTime() - state_since_ms > SVC_HELLO_TIMEOUT_MS) {
        drop_to_backoff();
      }
      break;
    case SVC_STATE_UP:
      poll_beacon(NULL);
      pump_rx();
      if (tcp_fd < 0) break;
      pump_tx();
      if (tcp_fd >= 0 && osGetTime() - last_rx_ms > SVC_SILENCE_TIMEOUT_MS) {
        drop_to_backoff();
      }
      break;
    case SVC_STATE_BACKOFF:
      poll_beacon(NULL);
      if (osGetTime() - state_since_ms > SVC_BACKOFF_MS) enter_state(SVC_STATE_DISCOVER);
      break;
  }
}

size_t svcwire_recv_lines(char *out, size_t capacity) {
  if (out == NULL || capacity <= 1 || lines_length == 0) return 0;
  size_t cap = capacity - 1 < SVC_POLL_BUF ? capacity - 1 : SVC_POLL_BUF;
  size_t length = lines_length < cap ? lines_length : cap;
  /* Whole lines only — QuickJS must never see a torn JSON record. */
  while (length > 0 && lines[length - 1] != '\n') length -= 1;
  if (length == 0) return 0;
  memcpy(out, lines, length);
  out[length] = '\0';
  memmove(lines, lines + length, lines_length - length);
  lines_length -= length;
  return length;
}

void svcwire_send_line(const char *line, size_t length) {
  if (state != SVC_STATE_UP || line == NULL || length == 0 || length > SVC_POLL_BUF) return;
  queue_frame(SVC_MSG_CTRL, (const uint8_t *)line, length);
}

void svcwire_reset(void) {
  /* Guest switch: drop guest-visible state. Queued outbound frames still
   * flush — they are whole frames, and truncating mid-frame would desync the
   * stream for the next guest. */
  lines_length = 0;
}

void svcwire_shutdown(void) {
  close_connection();
  if (beacon_fd >= 0) close(beacon_fd);
  beacon_fd = -1;
  enabled = false;
  state = SVC_STATE_IDLE;
  lines_length = 0;
}

#else /* POCKETJS_CAPTURE */

bool svcwire_open(const char *app) {
  (void)app;
  return false;
}

void svcwire_pump(void) {}

size_t svcwire_recv_lines(char *out, size_t capacity) {
  (void)out;
  (void)capacity;
  return 0;
}

void svcwire_send_line(const char *line, size_t length) {
  (void)line;
  (void)length;
}

void svcwire_reset(void) {}

void svcwire_shutdown(void) {}

#endif /* POCKETJS_CAPTURE */
