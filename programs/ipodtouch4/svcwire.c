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
 * Discovery order: a host override file (one line, `a.b.c.d[:port]`, at
 * POCKET_SVC_HOST_PATH — writable over the deployment SSH tunnel, for
 * broadcast-hostile networks), then the compile-time POCKET_SVC_HOST string
 * when the tool bakes one, then the LAN beacon. A failing override degrades
 * into beacon discovery instead of wedging the transport.
 *
 * The wire also LISTENS on POCKET_SVC_LISTEN_PORT: a companion on the
 * machine the device is plugged into reaches it through usbmuxd (iproxy
 * forwards a host port to this one), which needs no WiFi, no beacon and no
 * firewall rule. An accepted connection is the same wire with the roles of
 * connect() reversed — the device still speaks the hello first — and it
 * wins over any outbound attempt in flight.
 *
 * Like the 3DS transport this host never blocks a frame on the network:
 * every socket is non-blocking and svcwire_pump does a bounded amount of
 * work per call from the frame runner.
 */

#include "svcwire.h"

#ifdef POCKET_SVC_WIRE

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

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

#ifndef POCKET_SVC_HOST_PATH
#define POCKET_SVC_HOST_PATH "/private/var/tmp/pocketjs-svc-host.txt"
#endif
#ifndef POCKET_SVC_LISTEN_PORT
#define POCKET_SVC_LISTEN_PORT 8624
#endif

typedef enum {
  SVC_STATE_IDLE,
  SVC_STATE_DISCOVER,
  SVC_STATE_CONNECTING,
  SVC_STATE_HELLO_WAIT,
  SVC_STATE_UP,
  SVC_STATE_BACKOFF
} SvcState;

static int enabled;
static char app_id[65];
static SvcState state = SVC_STATE_IDLE;
static int beacon_fd = -1;
static int listen_fd = -1;
static int tcp_fd = -1;
/* The live connection came in over the listener (usbmuxd), not out to a
 * beacon: reported in the acceptance record as "up-usb". */
static int inbound;
static struct sockaddr_in target;
static int target_from_override;
static int override_failed;
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
static int pong_pending;
static uint8_t pong_payload[SVC_PING_MAX];
static uint32_t pong_length;

static void queue_hello(void);

static uint64_t now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (uint64_t)tv.tv_sec * 1000u + (uint64_t)tv.tv_usec / 1000u;
}

static uint32_t rd_u32(const uint8_t *at) {
  return (uint32_t)at[0] | ((uint32_t)at[1] << 8) | ((uint32_t)at[2] << 16) |
    ((uint32_t)at[3] << 24);
}

static uint16_t rd_u16(const uint8_t *at) {
  return (uint16_t)((uint16_t)at[0] | ((uint16_t)at[1] << 8));
}

static void wr_u32(uint8_t *at, uint32_t value) {
  at[0] = (uint8_t)(value & 0xffu);
  at[1] = (uint8_t)((value >> 8) & 0xffu);
  at[2] = (uint8_t)((value >> 16) & 0xffu);
  at[3] = (uint8_t)((value >> 24) & 0xffu);
}

static int would_block(void) {
  return errno == EAGAIN || errno == EWOULDBLOCK;
}

static int set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static int disable_sigpipe(int fd) {
  int enabled = 1;
  return setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof enabled) == 0;
}

static void enter_state(SvcState next) {
  state = next;
  state_since_ms = now_ms();
}

static void close_connection(void) {
  if (tcp_fd >= 0) close(tcp_fd);
  tcp_fd = -1;
  inbound = 0;
  rx_length = 0;
  skip_remaining = 0;
  tx_length = 0;
  tx_offset = 0;
  pong_pending = 0;
}

static void drop_to_backoff(void) {
  int failed_override = target_from_override;
  close_connection();
  /* A stale override (the companion's DHCP lease moved on) must degrade into
   * beacon discovery instead of wedging the transport. */
  if (failed_override) override_failed = 1;
  enter_state(SVC_STATE_BACKOFF);
}

/* ------------------------------------------------------------------------ */
/* discovery                                                                */
/* ------------------------------------------------------------------------ */

static void ensure_beacon_socket(void) {
  int fd;
  int reuse = 1;
  struct sockaddr_in address;
  if (beacon_fd >= 0) return;
  fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_ANY);
  address.sin_port = htons(SVC_BEACON_PORT);
  if (bind(fd, (struct sockaddr *)&address, sizeof address) != 0 || !set_nonblocking(fd)) {
    close(fd);
    return;
  }
  beacon_fd = fd;
}

static void ensure_listen_socket(void) {
  int fd;
  int reuse = 1;
  struct sockaddr_in address;
  if (listen_fd >= 0 || POCKET_SVC_LISTEN_PORT == 0) return;
  fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_ANY);
  address.sin_port = htons(POCKET_SVC_LISTEN_PORT);
  if (bind(fd, (struct sockaddr *)&address, sizeof address) != 0 || listen(fd, 1) != 0 ||
      !set_nonblocking(fd)) {
    close(fd);
    return;
  }
  listen_fd = fd;
}

/* Take one inbound connection if a companion reached the listener. While an
 * inbound connection is up, extra arrivals are refused (closed) so the wire
 * stays one connection; an inbound arrival while a WiFi connection is up
 * replaces it. Returns 1 when a new connection was adopted. */
static int poll_listener(int adopt) {
  int fd;
  int nodelay = 1;
  struct sockaddr_in peer;
  socklen_t peer_length = sizeof peer;
  if (listen_fd < 0) return 0;
  fd = accept(listen_fd, (struct sockaddr *)&peer, &peer_length);
  if (fd < 0) return 0;
  if (!adopt || !set_nonblocking(fd) || !disable_sigpipe(fd)) {
    close(fd);
    return 0;
  }
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof nodelay);
  close_connection();
  tcp_fd = fd;
  inbound = 1;
  queue_hello();
  last_rx_ms = now_ms();
  enter_state(SVC_STATE_HELLO_WAIT);
  return 1;
}

/* Drain beacon datagrams. While DISCOVERing, the first one advertising our
 * app id becomes the connect target; in every other state the datagrams are
 * discarded so the socket buffer never fills. */
static int poll_beacon(struct sockaddr_in *out) {
  int found = 0;
  uint32_t attempt;
  if (beacon_fd < 0) return 0;
  for (attempt = 0; attempt < 4; attempt += 1) {
    uint8_t datagram[160];
    struct sockaddr_in sender;
    socklen_t sender_length = sizeof sender;
    uint16_t port;
    size_t app_length;
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
    if (rd_u32(datagram) != SVC_BEACON_MAGIC) continue;
    if (datagram[4] != SVC_WIRE_VERSION) continue;
    port = rd_u16(datagram + 6);
    app_length = datagram[8];
    if (9 + app_length > (size_t)length) continue;
    if (app_length != strlen(app_id)) continue;
    if (memcmp(datagram + 9, app_id, app_length) != 0) continue;
    *out = sender;
    out->sin_port = htons(port);
    found = 1;
  }
  return found;
}

static int parse_host(const char *text_in, struct sockaddr_in *out) {
  char text[64];
  size_t length;
  unsigned long port = SVC_WIRE_PORT;
  char *colon;
  struct in_addr address;
  snprintf(text, sizeof text, "%s", text_in);
  length = strlen(text);
  while (length > 0 && (text[length - 1] == '\n' || text[length - 1] == '\r' ||
                        text[length - 1] == ' ')) {
    text[--length] = '\0';
  }
  if (length == 0) return 0;
  colon = strchr(text, ':');
  if (colon != NULL) {
    *colon = '\0';
    port = strtoul(colon + 1, NULL, 10);
    if (port == 0 || port > 65535) return 0;
  }
  if (inet_aton(text, &address) == 0) return 0;
  memset(out, 0, sizeof *out);
  out->sin_family = AF_INET;
  out->sin_addr = address;
  out->sin_port = htons((uint16_t)port);
  return 1;
}

/* Override file first, then the compile-time host, else nothing. */
static int read_host_override(struct sockaddr_in *out) {
  FILE *file = fopen(POCKET_SVC_HOST_PATH, "rb");
  if (file != NULL) {
    char text[64] = {0};
    size_t length = fread(text, 1, sizeof text - 1, file);
    fclose(file);
    text[length] = '\0';
    if (parse_host(text, out)) return 1;
  }
#ifdef POCKET_SVC_HOST
  return parse_host(POCKET_SVC_HOST, out);
#else
  return 0;
#endif
}

static void start_connect(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  int rc;
  int nodelay = 1;
  if (fd < 0) {
    enter_state(SVC_STATE_BACKOFF);
    return;
  }
  if (!set_nonblocking(fd) || !disable_sigpipe(fd)) {
    close(fd);
    enter_state(SVC_STATE_BACKOFF);
    return;
  }
  /* Input lines are latency-bound; batching is already done frame-side. */
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof nodelay);
  tcp_fd = fd;
  rc = connect(tcp_fd, (struct sockaddr *)&target, sizeof target);
  if (rc == 0 || errno == EINPROGRESS || errno == EWOULDBLOCK) {
    enter_state(SVC_STATE_CONNECTING); /* hello goes out on the next pump */
    return;
  }
  drop_to_backoff();
}

static void pump_discover(void) {
  struct sockaddr_in candidate;
  ensure_beacon_socket();
  ensure_listen_socket();
  if (poll_listener(1)) return;
  if (!override_failed && read_host_override(&candidate)) {
    target = candidate;
    target_from_override = 1;
    start_connect();
    return;
  }
  if (poll_beacon(&candidate)) {
    target = candidate;
    target_from_override = 0;
    override_failed = 0; /* a fresh beacon re-arms the override for later */
    start_connect();
  }
}

/* ------------------------------------------------------------------------ */
/* connection                                                               */
/* ------------------------------------------------------------------------ */

/* Queue the device hello. The tx buffer is empty on a fresh connection, so
 * this cannot fail for space. */
static void queue_hello(void) {
  size_t app_length = strlen(app_id);
  wr_u32(tx_buffer, SVC_WIRE_MAGIC);
  tx_buffer[4] = SVC_WIRE_VERSION;
  tx_buffer[5] = 0;
  tx_buffer[6] = (uint8_t)app_length;
  memcpy(tx_buffer + 7, app_id, app_length);
  tx_length = 7 + app_length;
  tx_offset = 0;
}

static void pump_connecting(void) {
  /* Re-issuing connect() on a non-blocking socket reports progress without
   * select(): EALREADY while in flight, EISCONN (or 0) once established. */
  int rc = connect(tcp_fd, (struct sockaddr *)&target, sizeof target);
  if (rc == 0 || errno == EISCONN) {
    queue_hello();
    last_rx_ms = now_ms();
    enter_state(SVC_STATE_HELLO_WAIT);
    return;
  }
  if (errno == EALREADY || errno == EINPROGRESS || errno == EWOULDBLOCK) {
    if (now_ms() - state_since_ms > SVC_CONNECT_TIMEOUT_MS) drop_to_backoff();
    return;
  }
  drop_to_backoff();
}

static int queue_frame(uint8_t type, const uint8_t *payload, size_t length) {
  uint8_t *at;
  if (SVC_WIRE_HEADER_BYTES + length > sizeof tx_buffer - tx_length) {
    if (tx_offset > 0) {
      memmove(tx_buffer, tx_buffer + tx_offset, tx_length - tx_offset);
      tx_length -= tx_offset;
      tx_offset = 0;
    }
    if (SVC_WIRE_HEADER_BYTES + length > sizeof tx_buffer - tx_length) return 0;
  }
  at = tx_buffer + tx_length;
  at[0] = type;
  at[1] = 0;
  at[2] = 0;
  at[3] = 0;
  wr_u32(at + 4, (uint32_t)length);
  if (length > 0) memcpy(at + SVC_WIRE_HEADER_BYTES, payload, length);
  tx_length += SVC_WIRE_HEADER_BYTES + length;
  return 1;
}

/* Append one host line to the poll queue (newline-terminated), dropping the
 * oldest queued lines when full — the Vita transport's bounded-queue rule. */
static void append_line(const uint8_t *bytes, size_t length) {
  if (length == 0 || length + 1 > sizeof lines) return;
  if (memchr(bytes, '\n', length) != NULL || memchr(bytes, '\r', length) != NULL) return;
  while (length + 1 > sizeof lines - lines_length) {
    char *oldest_end = memchr(lines, '\n', lines_length);
    size_t drop;
    if (oldest_end == NULL) {
      lines_length = 0;
      break;
    }
    drop = (size_t)(oldest_end - lines) + 1;
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
        pong_pending = 1;
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
  /* A continuously readable peer must still yield to the next UI frame. */
  for (unsigned reads = 0; reads < 4; ++reads) {
    int progressed;
    /* An oversized (or unwanted-bulk) payload is drained without buffering. */
    if (skip_remaining > 0) {
      uint8_t sink[1024];
      size_t want = skip_remaining < sizeof sink ? skip_remaining : sizeof sink;
      ssize_t got = recv(tcp_fd, sink, want, 0);
      if (got > 0) {
        skip_remaining -= (uint32_t)got;
        last_rx_ms = now_ms();
        continue;
      }
      if (got == 0 || !would_block()) drop_to_backoff();
      return;
    }

    if (rx_length < sizeof rx_buffer) {
      ssize_t got = recv(tcp_fd, rx_buffer + rx_length, sizeof rx_buffer - rx_length, 0);
      if (got > 0) {
        rx_length += (size_t)got;
        last_rx_ms = now_ms();
      } else if (got == 0 || !would_block()) {
        drop_to_backoff();
        return;
      }
    }

    if (state == SVC_STATE_HELLO_WAIT) {
      if (rx_length < 8) return;
      if (rd_u32(rx_buffer) != SVC_WIRE_MAGIC || rx_buffer[4] != SVC_WIRE_VERSION) {
        drop_to_backoff();
        return;
      }
      memmove(rx_buffer, rx_buffer + 8, rx_length - 8);
      rx_length -= 8;
      enter_state(SVC_STATE_UP);
    }

    progressed = 0;
    while (rx_length >= SVC_WIRE_HEADER_BYTES) {
      uint32_t payload_length = rd_u32(rx_buffer + 4);
      size_t total;
      if (rx_buffer[2] != 0 || rx_buffer[3] != 0 || payload_length > SVC_WIRE_MAX_PAYLOAD) {
        drop_to_backoff();
        return;
      }
      if (SVC_WIRE_HEADER_BYTES + payload_length > sizeof rx_buffer) {
        /* Consume the header and whatever payload is already buffered, then
         * drain the rest in skip mode. */
        size_t buffered = rx_length - SVC_WIRE_HEADER_BYTES;
        size_t consumed = buffered < payload_length ? buffered : payload_length;
        skip_remaining = payload_length - (uint32_t)consumed;
        memmove(
          rx_buffer,
          rx_buffer + SVC_WIRE_HEADER_BYTES + consumed,
          rx_length - SVC_WIRE_HEADER_BYTES - consumed
        );
        rx_length -= SVC_WIRE_HEADER_BYTES + consumed;
        progressed = 1;
        break;
      }
      total = SVC_WIRE_HEADER_BYTES + payload_length;
      if (rx_length < total) break;
      handle_frame(rx_buffer[0], rx_buffer + SVC_WIRE_HEADER_BYTES, payload_length);
      if (tcp_fd < 0) return; /* handle_frame path dropped the connection */
      memmove(rx_buffer, rx_buffer + total, rx_length - total);
      rx_length -= total;
      progressed = 1;
    }
    if (!progressed && rx_length < sizeof rx_buffer && skip_remaining == 0) return;
  }
}

static void pump_tx(void) {
  ssize_t sent;
  if (tcp_fd < 0) return;
  if (state == SVC_STATE_UP && pong_pending &&
      queue_frame(SVC_MSG_PONG, pong_payload, pong_length)) {
    pong_pending = 0;
  }
  if (tx_offset >= tx_length) return;
  sent = send(tcp_fd, tx_buffer + tx_offset, tx_length - tx_offset, 0);
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

/* ------------------------------------------------------------------------ */
/* public surface                                                           */
/* ------------------------------------------------------------------------ */

int svcwire_open(const char *app) {
  if (app == NULL || app[0] == '\0' || strlen(app) > 64) return 0;
  if (enabled && strcmp(app_id, app) != 0) {
    /* One companion per guest: a new app id restarts discovery. */
    close_connection();
    lines_length = 0;
    enter_state(SVC_STATE_DISCOVER);
  }
  snprintf(app_id, sizeof app_id, "%s", app);
  if (!enabled) {
    enabled = 1;
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
      if (poll_listener(1)) break; /* the wire in the cable beats the one in the air */
      pump_connecting();
      break;
    case SVC_STATE_HELLO_WAIT:
      poll_beacon(NULL);
      poll_listener(0);
      pump_tx();
      if (tcp_fd < 0) break;
      pump_rx();
      if (state == SVC_STATE_HELLO_WAIT &&
          now_ms() - state_since_ms > SVC_HELLO_TIMEOUT_MS) {
        drop_to_backoff();
      }
      break;
    case SVC_STATE_UP:
      poll_beacon(NULL);
      /* The cable beats the air: an inbound (usbmuxd) connection replaces a
       * WiFi one; a second inbound while one is up is refused. */
      if (poll_listener(!inbound)) break;
      pump_rx();
      if (tcp_fd < 0) break;
      pump_tx();
      if (tcp_fd >= 0 && now_ms() - last_rx_ms > SVC_SILENCE_TIMEOUT_MS) {
        drop_to_backoff();
      }
      break;
    case SVC_STATE_BACKOFF:
      poll_beacon(NULL);
      if (poll_listener(1)) break;
      if (now_ms() - state_since_ms > SVC_BACKOFF_MS) enter_state(SVC_STATE_DISCOVER);
      break;
  }
}

size_t svcwire_recv_lines(char *out, size_t capacity) {
  size_t cap;
  size_t length;
  if (out == NULL || capacity <= 1 || lines_length == 0) return 0;
  cap = capacity - 1 < SVC_POLL_BUF ? capacity - 1 : SVC_POLL_BUF;
  length = lines_length < cap ? lines_length : cap;
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

const char *svcwire_state_name(void) {
  switch (state) {
    case SVC_STATE_DISCOVER:
      return "discover";
    case SVC_STATE_CONNECTING:
      return "connecting";
    case SVC_STATE_HELLO_WAIT:
      return "hello";
    case SVC_STATE_UP:
      return inbound ? "up-usb" : "up";
    case SVC_STATE_BACKOFF:
      return "backoff";
    case SVC_STATE_IDLE:
    default:
      return "idle";
  }
}

void svcwire_shutdown(void) {
  close_connection();
  if (beacon_fd >= 0) close(beacon_fd);
  beacon_fd = -1;
  if (listen_fd >= 0) close(listen_fd);
  listen_fd = -1;
  enabled = 0;
  state = SVC_STATE_IDLE;
  lines_length = 0;
}

#else /* !POCKET_SVC_WIRE */

int svcwire_open(const char *app) {
  (void)app;
  return 0;
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

const char *svcwire_state_name(void) {
  return "absent";
}

void svcwire_shutdown(void) {}

#endif /* POCKET_SVC_WIRE */
