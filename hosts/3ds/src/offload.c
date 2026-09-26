/* All network service calls and key IO belong to this worker. The UI only
 * reads atomics and copies fixed-size SPSC slots. No mutex or socket on UI. */
#include "offload.h"
#include "soc.h"
#include "offload_queue.h"
#include "offload_image.h"
#include <3ds.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#if __has_include(<netinet/tcp.h>)
#include <netinet/tcp.h>
#endif
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

#ifndef POCKETJS_OFFLOAD_KEY
#define POCKETJS_OFFLOAD_KEY "sdmc:/pocketjs/offload/unpaired.key"
#endif
#ifndef POCKETJS_OFFLOAD_PORT
#define POCKETJS_OFFLOAD_PORT 8741
#endif
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "Offload requires lock-free 32-bit atomics");
static OffloadQueue outgoing, incoming;
/* Text-only companions do not reserve the 1 MiB image pool. The network
 * worker allocates it at the first binary response; shutdown joins the worker
 * before freeing it, while ticket access stays on the UI thread. */
static _Atomic(OffloadImages *) images;
static _Atomic int connection;
static _Atomic bool running;
static _Atomic bool reset_requested;
static Thread worker;
static unsigned sends, takes;
static _Atomic unsigned measured_frames, max_us, over_budget;
void offload_measure(unsigned us) {
  atomic_fetch_add_explicit(&measured_frames, 1, memory_order_relaxed);
  if (us > 16667) atomic_fetch_add_explicit(&over_budget, 1, memory_order_relaxed);
  unsigned previous = atomic_load_explicit(&max_us, memory_order_relaxed);
  if (us > previous) atomic_store_explicit(&max_us, us, memory_order_relaxed);
}
static OffloadRecord ui_record;

void offload_frame(void) { sends = takes = 0; }
int offload_session(void) { return atomic_load(&reset_requested) ? 0 : atomic_load_explicit(&connection, memory_order_acquire); }
bool offload_submit(const char *bytes, size_t length) {
  int epoch = offload_session();
  if (epoch <= 0 || sends >= 2 || length > OFFLOAD_BYTES) return false;
  sends++;
  return offload_push(&outgoing, bytes, (uint32_t)length, (uint32_t)epoch);
}
size_t offload_take(char *out) {
  if (takes++ >= 1 || !offload_pop(&incoming, &ui_record)) return 0;
  if ((int)ui_record.generation != offload_session()) {
    offload_release_image(ui_record.image_token); return 0;
  }
  memcpy(out, ui_record.bytes, ui_record.length);
  return ui_record.length;
}
const uint8_t *offload_image(uint32_t token, unsigned *width, unsigned *height) {
  OffloadImages *pool = atomic_load_explicit(&images, memory_order_acquire);
  OffloadImageSlot *slot = pool ? image_borrow(pool, token) : NULL;
  if (!slot) return NULL;
  *width = slot->width; *height = slot->height;
  /* The last eight bytes of the wire header are also an IMG entry header.
   * Set its linear filter bit only after worker validation/publication. */
  slot->wire[13] = 2;
  return slot->wire + OFFLOAD_IMAGE_HEADER;
}
void offload_release_image(uint32_t token) {
  OffloadImages *pool = atomic_load_explicit(&images, memory_order_acquire);
  if (pool) image_release(pool, token);
}
void offload_reset(void) {
  /* A new JS realm starts request IDs at one. Drop the old connection before
   * exposing transport credit, and release tickets whose JS owner was freed. */
  atomic_store(&reset_requested, true);
  OffloadImages *pool = atomic_load_explicit(&images, memory_order_acquire);
  if (!pool) return;
  for (unsigned n = 0; n < OFFLOAD_IMAGE_SLOTS; n++) {
    OffloadImageSlot *slot = &pool->slots[n];
    if (atomic_load_explicit(&slot->state, memory_order_acquire) == IMAGE_READY) image_release(pool, slot->token);
  }
}
static bool transfer(int fd, char *p, size_t n, bool send_data) {
  u64 deadline = osGetTime() + 10000;
  while (n && atomic_load(&running)) {
    int done = send_data ? send(fd, p, n, 0) : recv(fd, p, n, 0);
    if (done > 0) { n -= (size_t)done; p += done; continue; }
    if (done == 0 || (errno != EAGAIN && errno != EWOULDBLOCK) || osGetTime() > deadline) return false;
    svcSleepThread(1000000);
  }
  return n == 0;
}
static void serve(void *unused) {
  (void)unused;
  char key[64];
  FILE *file = fopen(POCKETJS_OFFLOAD_KEY, "rb");
  if (!file) return;
  size_t count = fread(key, 1, sizeof key, file);
  fclose(file);
  if (count != sizeof key) return;
  /* Retry on this worker; a competing initializer never makes the UI wait. */
  while (atomic_load(&running) && !soc_ensure(NULL, 0)) svcSleepThread(10000000);
  if (!atomic_load(&running)) return;
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  if (listener < 0) return;
  int reuse = 1;
  setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons(POCKETJS_OFFLOAD_PORT), .sin_addr.s_addr = INADDR_ANY };
  if (bind(listener, (struct sockaddr *)&address, sizeof address) || listen(listener, 1)) goto close_listener;
  fcntl(listener, F_SETFL, O_NONBLOCK);
  int generation = 0;
  while (atomic_load(&running)) {
    if (atomic_exchange(&reset_requested, false)) atomic_store(&connection, 0);
    int fd = accept(listener, NULL, NULL);
    if (fd < 0) { svcSleepThread(10000000); continue; }
    fcntl(fd, F_SETFL, O_NONBLOCK);
#ifdef TCP_NODELAY
    int no_delay = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &no_delay, sizeof no_delay);
#endif
    char offered[64]; unsigned mismatch = 0;
    if (!transfer(fd, offered, sizeof offered, false)) { close(fd); continue; }
    for (unsigned i = 0; i < sizeof key; i++) mismatch |= key[i] ^ offered[i];
    if (mismatch) { close(fd); continue; }
    generation++;
    atomic_store_explicit(&connection, generation, memory_order_release);
    OffloadRecord record;
    char rx[OFFLOAD_BYTES + 4]; size_t have = 0, want = 4;
    u64 last_progress = osGetTime();
    bool alive = true, ready = false;
    OffloadImageSlot *image = NULL;
    bool binary = false;
    uint32_t image_length = 0, image_token = 0;
    u64 metrics_at = osGetTime();
    while (alive && atomic_load(&running) && !atomic_load(&reset_requested)) {
      if (osGetTime() - metrics_at >= 2000) {
        metrics_at = osGetTime();
        char metrics[256];
        int size = snprintf(metrics, sizeof metrics,
          "{\"v\":1,\"id\":0,\"method\":\"offload.metrics\",\"payload\":\"frames=%u maxCpuUs=%u over16ms=%u\"}",
          atomic_load(&measured_frames), atomic_load(&max_us), atomic_load(&over_budget));
        uint32_t length = htonl((uint32_t)size);
        alive = transfer(fd, (char *)&length, 4, true) && transfer(fd, metrics, size, true);
        if (!alive) break;
      }
      if (offload_pop(&outgoing, &record) && record.generation == (uint32_t)generation) {
        uint32_t length = htonl(record.length);
        alive = transfer(fd, (char *)&length, 4, true) && transfer(fd, record.bytes, record.length, true);
      }
      if (ready) {
        if (offload_push_ticket(&incoming, rx + 4, (uint32_t)(want - 4), (uint32_t)generation, image_token)) {
          ready = false; have = 0; want = 4; image_token = 0; image = NULL; binary = false;
        }
      } else {
        if (binary && !image) {
          OffloadImages *pool = atomic_load_explicit(&images, memory_order_acquire);
          if (!pool) {
            pool = calloc(1, sizeof *pool);
            if (!pool) { alive = false; continue; }
            for (unsigned i = 0; i < OFFLOAD_IMAGE_SLOTS; i++)
              atomic_init(&pool->slots[i].state, IMAGE_FREE);
            atomic_store_explicit(&images, pool, memory_order_release);
          }
          image = image_reserve(pool);
          if (!image) { svcSleepThread(1000000); continue; }
        }
        int n = recv(fd, binary ? (char *)image->wire + have : rx + have, want - have, 0);
        if (n > 0) {
          have += (size_t)n; last_progress = osGetTime();
          if (!binary && have == 4 && want == 4) {
            uint32_t length; memcpy(&length, rx, 4); length = ntohl(length);
            binary = (length & 0x80000000u) != 0;
            if (binary) {
              image_length = length & 0x7fffffffu;
              if (image_length < OFFLOAD_IMAGE_HEADER || image_length > OFFLOAD_IMAGE_HEADER + OFFLOAD_IMAGE_BYTES) { alive = false; continue; }
              have = 0; want = image_length;
            } else {
              if (!length || length > OFFLOAD_BYTES) { alive = false; continue; }
              want = 4 + length;
            }
          } else if (have == want) {
            if (binary) {
              if (!image_publish(atomic_load_explicit(&images, memory_order_acquire), image, image_length, (uint32_t)generation)) { alive = false; continue; }
              image_token = image->token;
              int size = snprintf(rx + 4, OFFLOAD_BYTES,
                "{\"id\":%u,\"image\":{\"token\":%u,\"width\":%u,\"height\":%u}}",
                image->request, image_token, image->width, image->height);
              want = (size_t)size + 4;
            }
            ready = true;
          }
        } else if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) alive = false;
        if (have && osGetTime() - last_progress > 10000) alive = false;
      }
      svcSleepThread(1000000);
    }
    /* This allocation was not published to the UI queue; no consumer knows it. */
    if (image) atomic_store_explicit(&image->state, IMAGE_FREE, memory_order_release);
    atomic_store_explicit(&connection, -generation, memory_order_release);
    close(fd);
  }
close_listener:
  close(listener);
  /* Process-wide SOC stays alive until every transport has stopped. */
}
bool offload_start(void) {
  atomic_store(&running, true);
  /* Lower priority than rendering; core -2 supports Old and New 3DS. */
  worker = threadCreate(serve, NULL, 32 * 1024, 0x3f, -2, false);
  return worker != NULL;
}
void offload_stop(void) {
  atomic_store(&running, false);
  if (worker) { threadJoin(worker, U64_MAX); threadFree(worker); worker = NULL; }
  free(atomic_exchange_explicit(&images, NULL, memory_order_acq_rel));
}
