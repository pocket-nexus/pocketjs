/* Native Pocket Relay L0 for 3DS. Only this worker touches the TCP socket;
 * the QuickJS thread copies whole records through two fixed SPSC rings. */
#include "relay.h"
#include "soc.h"

#include <3ds.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#if __has_include(<netinet/tcp.h>)
#include <netinet/tcp.h>
#endif
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#ifndef POCKETJS_RELAY_KEY
#define POCKETJS_RELAY_KEY "sdmc:/pocketjs/offload/unpaired.key"
#endif
#ifndef POCKETJS_RELAY_HOST
#define POCKETJS_RELAY_HOST "sdmc:/pocketjs/relay/unpaired.host"
#endif

enum { RELAY_RECORD_BYTES = 16384, RELAY_SLOTS = 8, RELAY_WINDOW_BYTES = 65536,
       RELAY_SUBMISSIONS_PER_FRAME = 2, RELAY_DELIVERIES_PER_FRAME = 2,
       RELAY_PORT = 8742, RELAY_CONNECT_MS = 3000, RELAY_AUTH_MS = 5000,
       RELAY_RECORD_MS = 30000, RELAY_IDLE_MS = 60000, RELAY_RETRY_MS = 500 };
#ifdef MSG_NOSIGNAL
#define RELAY_SEND_FLAGS MSG_NOSIGNAL
#else
#define RELAY_SEND_FLAGS 0
#endif
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "Relay needs lock-free 32-bit atomics");

typedef struct {
  uint32_t length, generation;
  uint8_t bytes[RELAY_RECORD_BYTES];
} RelayRecord;
typedef struct {
  RelayRecord slots[RELAY_SLOTS];
  _Atomic uint32_t read, write, bytes;
} RelayQueue;

static RelayQueue outgoing, incoming;
static _Atomic int connection;
static _Atomic bool running, reset_requested;
static _Atomic unsigned sent, received, refused, stale, malformed, reconnects;
static Thread worker;
static bool configured;
static unsigned frame_sends, frame_takes;
static char pairing_key[64];
static struct sockaddr_in companion;
/* The worker never keeps more than one partially received record. */
static uint8_t receive_buffer[RELAY_RECORD_BYTES];

static uint32_t le32(const uint8_t *bytes) {
  return (uint32_t)bytes[0] | (uint32_t)bytes[1] << 8 |
         (uint32_t)bytes[2] << 16 | (uint32_t)bytes[3] << 24;
}

static bool framed(const uint8_t *bytes, size_t length) {
  return bytes && length >= 48 && length <= RELAY_RECORD_BYTES &&
         le32(bytes) == length - 4;
}

/* One producer and one consumer per ring. Charge bytes before publishing a
 * slot; release both byte and slot credit only after its consumer is done. */
static bool push(RelayQueue *queue, const uint8_t *bytes, uint32_t length, uint32_t generation) {
  uint32_t write = atomic_load_explicit(&queue->write, memory_order_relaxed);
  uint32_t read = atomic_load_explicit(&queue->read, memory_order_acquire);
  if (write - read >= RELAY_SLOTS ||
      atomic_load_explicit(&queue->bytes, memory_order_acquire) + length > RELAY_WINDOW_BYTES)
    return false;
  RelayRecord *slot = &queue->slots[write % RELAY_SLOTS];
  slot->length = length;
  slot->generation = generation;
  memcpy(slot->bytes, bytes, length);
  atomic_fetch_add_explicit(&queue->bytes, length, memory_order_release);
  atomic_store_explicit(&queue->write, write + 1, memory_order_release);
  return true;
}

static RelayRecord *peek(RelayQueue *queue) {
  uint32_t read = atomic_load_explicit(&queue->read, memory_order_relaxed);
  if (read == atomic_load_explicit(&queue->write, memory_order_acquire)) return NULL;
  return &queue->slots[read % RELAY_SLOTS];
}

static void release(RelayQueue *queue, const RelayRecord *slot) {
  atomic_fetch_sub_explicit(&queue->bytes, slot->length, memory_order_release);
  atomic_fetch_add_explicit(&queue->read, 1, memory_order_release);
}

void relay_frame(void) { frame_sends = frame_takes = 0; }
int relay_session(void) {
  return atomic_load_explicit(&reset_requested, memory_order_acquire) ? 0 :
         atomic_load_explicit(&connection, memory_order_acquire);
}
bool relay_send(const uint8_t *record, size_t length) {
  int generation = relay_session();
  if (generation <= 0 || frame_sends >= RELAY_SUBMISSIONS_PER_FRAME) return false;
  if (!framed(record, length)) {
    atomic_fetch_add(&malformed, 1);
    return false;
  }
  if (!push(&outgoing, record, (uint32_t)length, (uint32_t)generation)) {
    atomic_fetch_add(&refused, 1);
    return false;
  }
  frame_sends++;
  atomic_fetch_add(&sent, 1);
  return true;
}
size_t relay_take(uint8_t *into, size_t capacity) {
  if (frame_takes >= RELAY_DELIVERIES_PER_FRAME) return 0;
  int generation = relay_session();
  for (unsigned n = 0; n < RELAY_SLOTS; n++) {
    if (generation <= 0 || generation != relay_session()) return 0;
    RelayRecord *slot = peek(&incoming);
    if (!slot) return 0;
    bool valid = generation > 0 && slot->generation == (uint32_t)generation;
    size_t length = slot->length;
    if (valid && length <= capacity && into) memcpy(into, slot->bytes, length);
    release(&incoming, slot);
    if (generation != relay_session()) return 0;
    if (!valid) {
      atomic_fetch_add(&stale, 1);
      continue;
    }
    if (length > capacity || !into) {
      atomic_fetch_add(&malformed, 1);
      continue;
    }
    frame_takes++;
    atomic_fetch_add(&received, 1);
    return length;
  }
  return 0;
}
void relay_reset(void) {
  /* A new JS realm must never reuse the old Relay session or its request IDs. */
  atomic_store_explicit(&reset_requested, true, memory_order_release);
}
void relay_stats(char *into, size_t capacity) {
  if (!capacity) return;
  snprintf(into, capacity,
    "session=%d out=%u/%u in=%u/%u sent=%u received=%u refused=%u stale=%u malformed=%u reconnects=%u",
    relay_session(), (unsigned)atomic_load(&outgoing.bytes),
    (unsigned)(atomic_load(&outgoing.write) - atomic_load(&outgoing.read)),
    (unsigned)atomic_load(&incoming.bytes),
    (unsigned)(atomic_load(&incoming.write) - atomic_load(&incoming.read)),
    atomic_load(&sent), atomic_load(&received), atomic_load(&refused),
    atomic_load(&stale), atomic_load(&malformed), atomic_load(&reconnects));
}

static bool read_configuration(void) {
  FILE *file = fopen(POCKETJS_RELAY_KEY, "rb");
  if (!file) return false;
  char key[67];
  size_t length = fread(key, 1, sizeof key, file);
  fclose(file);
  if (length == sizeof key) return false;
  while (length > 64 && (key[length - 1] == '\n' || key[length - 1] == '\r')) length--;
  if (length != 64) return false;
  for (unsigned i = 0; i < 64; i++)
    if (!((key[i] >= '0' && key[i] <= '9') || (key[i] >= 'a' && key[i] <= 'f') ||
          (key[i] >= 'A' && key[i] <= 'F'))) return false;

  file = fopen(POCKETJS_RELAY_HOST, "rb");
  if (!file) return false;
  char host[64] = {0};
  length = fread(host, 1, sizeof host, file);
  fclose(file);
  if (!length || length >= sizeof host) return false;
  while (length && (host[length - 1] == '\n' || host[length - 1] == '\r')) host[--length] = 0;
  if (!length) return false;
  unsigned port = RELAY_PORT;
  char *colon = strchr(host, ':');
  if (colon) {
    *colon++ = 0;
    if (!*colon) return false;
    char *end;
    unsigned long parsed = strtoul(colon, &end, 10);
    if (*end || parsed == 0 || parsed > 65535) return false;
    port = (unsigned)parsed;
  }
  struct in_addr address;
  if (!inet_aton(host, &address)) return false;
  memcpy(pairing_key, key, sizeof pairing_key);
  memset(&companion, 0, sizeof companion);
  companion.sin_family = AF_INET;
  companion.sin_addr = address;
  companion.sin_port = htons((uint16_t)port);
  return true;
}

static bool would_block(void) { return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR; }
static bool dial(int fd) {
  int rc = connect(fd, (const struct sockaddr *)&companion, sizeof companion);
  if (rc == 0 || errno == EISCONN) return true;
  if (errno != EINPROGRESS && errno != EWOULDBLOCK && errno != EALREADY) return false;
  u64 started = osGetTime();
  while (atomic_load(&running) && !atomic_load(&reset_requested) && osGetTime() - started < RELAY_CONNECT_MS) {
    svcSleepThread(1000000);
    rc = connect(fd, (const struct sockaddr *)&companion, sizeof companion);
    if (rc == 0 || errno == EISCONN) return true;
    if (errno != EINPROGRESS && errno != EWOULDBLOCK && errno != EALREADY) return false;
  }
  return false;
}
static bool send_key(int fd) {
  size_t offset = 0;
  u64 started = osGetTime();
  while (offset < sizeof pairing_key && atomic_load(&running) && !atomic_load(&reset_requested) &&
         osGetTime() - started < RELAY_AUTH_MS) {
    int n = send(fd, pairing_key + offset, sizeof pairing_key - offset, RELAY_SEND_FLAGS);
    if (n > 0) { offset += (size_t)n; continue; }
    if (n == 0 || !would_block()) return false;
    svcSleepThread(1000000);
  }
  return offset == sizeof pairing_key;
}

static void exchange_records(int fd, int generation) {
  size_t tx_offset = 0, rx_have = 0, rx_want = 4;
  u64 last_rx = osGetTime(), rx_started = last_rx;
  while (atomic_load(&running) && !atomic_load(&reset_requested)) {
    RelayRecord *next = peek(&outgoing);
    if (next && next->generation != (uint32_t)generation) {
      release(&outgoing, next);
      tx_offset = 0;
      atomic_fetch_add(&stale, 1);
    } else if (next) {
      int n = send(fd, next->bytes + tx_offset, next->length - tx_offset, RELAY_SEND_FLAGS);
      if (n > 0) {
        tx_offset += (size_t)n;
        if (tx_offset == next->length) { release(&outgoing, next); tx_offset = 0; }
      } else if (n == 0 || !would_block()) break;
    }

    if (rx_have == 4 && rx_want == 4) {
      uint32_t body = le32(receive_buffer);
      if (body < 44 || body > RELAY_RECORD_BYTES - 4) {
        atomic_fetch_add(&malformed, 1);
        break;
      }
      rx_want = (size_t)body + 4;
    }
    /* Do not read the body until its complete slot and byte credit exist. */
    bool credit = rx_want == 4 ||
      (atomic_load_explicit(&incoming.write, memory_order_acquire) -
       atomic_load_explicit(&incoming.read, memory_order_acquire) < RELAY_SLOTS &&
       atomic_load_explicit(&incoming.bytes, memory_order_acquire) + rx_want <= RELAY_WINDOW_BYTES);
    if (rx_have < rx_want && credit) {
      int n = recv(fd, receive_buffer + rx_have, rx_want - rx_have, 0);
      if (n > 0) {
        if (!rx_have) rx_started = osGetTime();
        rx_have += (size_t)n;
        last_rx = osGetTime();
      } else if (n == 0 || !would_block()) break;
    }
    if (rx_have == rx_want && rx_want > 4) {
      if (!push(&incoming, receive_buffer, (uint32_t)rx_want, (uint32_t)generation)) break;
      rx_have = 0;
      rx_want = 4;
    }
    u64 now = osGetTime();
    if ((rx_have && (credit || rx_have < 4) && now - rx_started > RELAY_RECORD_MS) ||
        now - last_rx > RELAY_IDLE_MS) break;
    svcSleepThread(1000000);
  }
}

static void serve(void *unused) {
  (void)unused;
  int generation = 0;
  while (atomic_load(&running)) {
    atomic_store_explicit(&connection, 0, memory_order_release);
    atomic_store_explicit(&reset_requested, false, memory_order_release);
    if (!soc_ensure(NULL, 0)) { svcSleepThread(100000000); continue; }
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd >= 0) {
      int flags = fcntl(fd, F_GETFL, 0);
      if (flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0) {
        /* Large image records otherwise fill the 3DS socket's small default
         * receive window before the Relay worker can drain them. */
        int receive_bytes = RELAY_WINDOW_BYTES;
        setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &receive_bytes, sizeof receive_bytes);
#ifdef TCP_NODELAY
        int enabled = 1;
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof enabled);
#endif
        if (dial(fd) && send_key(fd) && atomic_load(&running) && !atomic_load(&reset_requested)) {
          generation = generation == INT_MAX ? 1 : generation + 1;
          atomic_fetch_add(&reconnects, 1);
          atomic_store_explicit(&connection, generation, memory_order_release);
          exchange_records(fd, generation);
        }
      }
      atomic_store_explicit(&connection, 0, memory_order_release);
      close(fd);
    }
    for (unsigned n = 0; n < RELAY_RETRY_MS && atomic_load(&running); n += 10)
      svcSleepThread(10000000);
  }
  atomic_store_explicit(&connection, 0, memory_order_release);
}

bool relay_start(void) {
  if (worker) return configured;
  configured = read_configuration();
  if (!configured) return false;
  atomic_store(&running, true);
  worker = threadCreate(serve, NULL, 32 * 1024, 0x3f, -2, false);
  if (!worker) { atomic_store(&running, false); configured = false; }
  return configured;
}
bool relay_available(void) { return configured; }
void relay_stop(void) {
  atomic_store(&running, false);
  atomic_store(&connection, 0);
  if (worker) { threadJoin(worker, U64_MAX); threadFree(worker); worker = NULL; }
  configured = false;
}
