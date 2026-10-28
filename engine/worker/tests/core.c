#include "pocket/worker.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  pthread_mutex_t mutex;
  uint64_t now;
  uint32_t running;
  int busy, starts, cancels, wakes;
} host;
static void lock(void *p) { assert(!pthread_mutex_lock(&((host *)p)->mutex)); }
static void unlock(void *p) {
  assert(!pthread_mutex_unlock(&((host *)p)->mutex));
}
static void wake(void *p) { (void)p; }
static uint64_t now(void *p) { return ((host *)p)->now; }
static int32_t open_device(void *p, pocket_worker *w, uint32_t h,
                           const uint8_t *b, size_t n) {
  (void)p;
  (void)w;
  (void)h;
  (void)b;
  (void)n;
  return 0;
}
static int32_t start(void *p, pocket_worker *w, uint32_t h, uint32_t id,
                     uint32_t op, const uint8_t *b, size_t n, size_t cap) {
  (void)w;
  (void)h;
  (void)op;
  (void)b;
  (void)n;
  (void)cap;
  host *s = p;
  s->starts++;
  s->running = id;
  return 0;
}
static void cancel(void *p, pocket_worker *w, uint32_t h, uint32_t id) {
  (void)w;
  (void)h;
  (void)id;
  ((host *)p)->cancels++;
}
static int32_t close_device(void *p, pocket_worker *w, uint32_t h) {
  (void)w;
  (void)h;
  return ((host *)p)->busy ? POCKET_WORKER_BUSY : 0;
}
static pocket_worker *create(host *h, pocket_worker_driver *d,
                             pocket_worker_node *node) {
  *d = (pocket_worker_driver){.struct_size = sizeof *d,
                              .context = h,
                              .open = open_device,
                              .start = start,
                              .cancel = cancel,
                              .close = close_device};
  *node = (pocket_worker_node){sizeof *node, POCKET_WORKER_I2C, "i2c0", d};
  pocket_worker_config c = {.struct_size = sizeof c,
                            .generation = 1,
                            .nodes = node,
                            .node_count = 1,
                            .context = h,
                            .lock = lock,
                            .unlock = unlock,
                            .wake = wake,
                            .now_micros = now};
  return pocket_worker_create(&c);
}
static size_t observe(pocket_worker *w, pocket_worker_fact *facts,
                      uint8_t *bytes) {
  return pocket_worker_observe(w, facts, 32, bytes, 8192);
}
typedef struct {
  pocket_worker *worker;
} producer;
static void *snapshots(void *opaque) {
  producer *p = opaque;
  uint8_t bytes[128];
  for (unsigned i = 0; i < 20000; i++) {
    memset(bytes, (int)(i & 255), sizeof bytes);
    assert(pocket_worker_publish(p->worker, 1, bytes, sizeof bytes) == 0);
  }
  return NULL;
}
int main(void) {
  host h = {.mutex = PTHREAD_MUTEX_INITIALIZER};
  pocket_worker_driver d;
  pocket_worker_node node;
  pocket_worker *w = create(&h, &d, &node);
  assert(w);
  int32_t handle = pocket_worker_open(w, 1, "i2c0", NULL, 0);
  assert(handle > 0);
  assert(pocket_worker_open(w, 1, "missing", NULL, 0) ==
         POCKET_WORKER_UNSUPPORTED);
  pocket_worker_fact f[32];
  uint8_t bytes[8192];
  assert(observe(w, f, bytes) == 1 && f[0].kind == POCKET_WORKER_READY);
  uint8_t payload[] = {1, 2, 3};
  int32_t requests[POCKET_WORKER_MAX_REQUESTS];
  for (size_t i = 0; i < POCKET_WORKER_MAX_REQUESTS; i++) {
    requests[i] = pocket_worker_submit(w, (uint32_t)handle, 1, payload, 3, 3);
    assert(requests[i] > 0);
  }
  assert(pocket_worker_submit(w, (uint32_t)handle, 1, NULL, 0, 0) ==
         POCKET_WORKER_BUSY);
  assert(pocket_worker_cancel(w, (uint32_t)requests[0]) == 0);
  pocket_worker_dispatch(w);
  assert(h.starts == POCKET_WORKER_MAX_REQUESTS - 1);
  assert(pocket_worker_cancel(w, (uint32_t)requests[1]) == 0);
  pocket_worker_dispatch(w);
  assert(h.cancels == 1);
  for (size_t i = 2; i < POCKET_WORKER_MAX_REQUESTS; i++)
    assert(pocket_worker_complete(w, (uint32_t)requests[i], 0, payload, 3) ==
           0);
  for (size_t i = 0; i < POCKET_WORKER_MAX_EVENTS; i++)
    assert(pocket_worker_emit(w, (uint32_t)handle, POCKET_WORKER_DATA, 0, i * 3,
                              payload, 3) == 0);
  assert(pocket_worker_emit(w, (uint32_t)handle, POCKET_WORKER_DATA, 0, 24,
                            payload, 3) == POCKET_WORKER_BUSY);
  assert(pocket_worker_end(w, (uint32_t)handle, 0, 24) == 0);
  size_t count = observe(w, f, bytes);
  assert(count == POCKET_WORKER_MAX_REQUESTS + POCKET_WORKER_MAX_EVENTS + 1);
  int saw_cancelled = 0, saw_unknown = 0;
  for (size_t i = 0; i < count; i++) {
    if (f[i].request == (uint32_t)requests[0] &&
        f[i].status == POCKET_WORKER_CANCELLED)
      saw_cancelled = 1;
    if (f[i].request == (uint32_t)requests[1] &&
        f[i].status == POCKET_WORKER_UNKNOWN)
      saw_unknown = 1;
  }
  assert(saw_cancelled && saw_unknown);
  assert(f[count - 1].kind == POCKET_WORKER_END && f[count - 1].offset == 24);
  assert(pocket_worker_complete(w, (uint32_t)requests[1], 0, payload, 3) == 0);
  assert(pocket_worker_complete(w, (uint32_t)requests[1], 0, payload, 3) ==
         POCKET_WORKER_INVALID);
  assert(observe(w, f, bytes) == 0); /* Late completion cannot settle twice. */
  for (size_t i = 0; i < POCKET_WORKER_MAX_REQUESTS; i++)
    assert(pocket_worker_submit(w, (uint32_t)handle, 1, NULL, 0, 0) > 0);
  h.busy = 1;
  assert(pocket_worker_destroy(w) == POCKET_WORKER_BUSY);
  h.busy = 0;
  assert(pocket_worker_destroy(w) == 0);

  w = create(&h, &d, &node);
  assert(w);
  int32_t replacement = pocket_worker_open(w, 1, "i2c0", NULL, 0);
  assert(replacement > handle);
  assert(pocket_worker_complete(w, (uint32_t)requests[1], 0, NULL, 0) ==
         POCKET_WORKER_INVALID);
  assert(pocket_worker_timer(w, 7, 1000, 100) == 0);
  h.now = 1350;
  count = observe(w, f, bytes);
  assert(count == 2 && f[1].kind == POCKET_WORKER_TIMER && f[1].timer == 7 &&
         f[1].deadline == 1000 && f[1].missed == 3 && f[1].handle == 0);
  assert(pocket_worker_deadline(w) == 1400);
  assert(pocket_worker_timer(w, 7, 0, 0) == 0);
  assert(pocket_worker_channel(w, 1, 1, 128, 1) == 0);
  producer p = {w};
  pthread_t thread;
  assert(!pthread_create(&thread, NULL, snapshots, &p));
  for (unsigned i = 0; i < 20000; i++) {
    uint8_t snapshot[128];
    int32_t n = pocket_worker_channel_take(w, 1, snapshot, sizeof snapshot);
    if (n >= 0) {
      assert(n == 128);
      for (size_t j = 1; j < sizeof snapshot; j++)
        assert(snapshot[j] == snapshot[0]);
    }
  }
  assert(!pthread_join(thread, NULL));
  assert(pocket_worker_receive(w, 1, payload, 3) == POCKET_WORKER_INVALID);
  assert(pocket_worker_channel(w, 2, 0, 4, 2) == 0);
  assert(pocket_worker_channel_direction(w, 2, 1) == 0);
  assert(pocket_worker_receive(w, 2, payload, 3) == 0);
  assert(pocket_worker_receive(w, 2, payload, 3) == 0);
  assert(pocket_worker_receive(w, 2, payload, 3) == POCKET_WORKER_BUSY);
  assert(pocket_worker_publish(w, 2, payload, 3) == POCKET_WORKER_INVALID);
  count = observe(w, f, bytes);
  assert(count == 2 && f[0].kind == POCKET_WORKER_CHANNEL && f[1].channel == 2 &&
         f[1].handle == 0);
  assert(pocket_worker_destroy(w) == 0);

  w = create(&h, &d, &node);
  assert(w);
  handle = pocket_worker_open(w, 1, "i2c0", NULL, 0);
  assert(handle > 0);
  assert(observe(w, f, bytes) == 1);
  int32_t stream_request =
      pocket_worker_submit(w, (uint32_t)handle, 1, NULL, 0, 0);
  assert(stream_request > 0);
  pocket_worker_dispatch(w);
  assert(pocket_worker_emit(w, (uint32_t)handle, POCKET_WORKER_HEADERS, 200, 0,
                            payload, 3) == 0);
  assert(pocket_worker_emit(w, (uint32_t)handle, POCKET_WORKER_DATA, 0, 0,
                            payload, 3) == 0);
  assert(pocket_worker_finish(w, (uint32_t)handle, (uint32_t)stream_request, 0,
                              3) == 0);
  const uint32_t order[] = {POCKET_WORKER_HEADERS, POCKET_WORKER_DATA,
                            POCKET_WORKER_END, POCKET_WORKER_COMPLETE};
  for (size_t i = 0; i < 4; i++) {
    assert(pocket_worker_observe(w, f, 1, bytes, sizeof bytes) == 1);
    assert(f[0].kind == order[i]);
  }
  assert(pocket_worker_close(w, (uint32_t)handle) == 0);
  pocket_worker_dispatch(w);
  observe(w, f, bytes);
  handle = pocket_worker_open(w, 1, "i2c0", NULL, 0);
  assert(handle > 0);
  observe(w, f, bytes);
  assert(pocket_worker_emit(w, (uint32_t)handle, POCKET_WORKER_DATA, 0, 0,
                            payload, 3) == 0);
  assert(pocket_worker_gap(w, (uint32_t)handle, 3, 2) == 0);
  assert(pocket_worker_emit(w, (uint32_t)handle, POCKET_WORKER_DATA, 0, 5,
                            payload, 3) == POCKET_WORKER_BUSY);
  assert(pocket_worker_observe(w, f, 1, bytes, sizeof bytes) == 1 &&
         f[0].kind == POCKET_WORKER_DATA);
  assert(pocket_worker_observe(w, f, 1, bytes, sizeof bytes) == 1 &&
         f[0].kind == POCKET_WORKER_GAP && f[0].offset == 3 &&
         f[0].request == 2);
  assert(pocket_worker_emit(w, (uint32_t)handle, POCKET_WORKER_DATA, 0, 5,
                            payload, 3) == 0);
  assert(pocket_worker_observe(w, f, 1, bytes, sizeof bytes) == 1 &&
         f[0].kind == POCKET_WORKER_DATA && f[0].offset == 5);
  assert(pocket_worker_channel(w, 3, 0, 4, 2) == 0);
  assert(pocket_worker_channel_direction(w, 3, 1) == 0);
  assert(pocket_worker_receive(w, 3, payload, 3) == 0);
  assert(pocket_worker_timer(w, 8, h.now, 0) == 0);
  int saw_timer = 0, saw_channel = 0;
  for (unsigned turn = 0; turn < 6; turn++) {
    while (pocket_worker_emit(w, (uint32_t)handle, POCKET_WORKER_DATA, 0, 8,
                              payload, 3) == 0) {
    }
    assert(pocket_worker_observe(w, f, 1, bytes, sizeof bytes) == 1);
    if (f[0].kind == POCKET_WORKER_TIMER)
      saw_timer = 1;
    if (f[0].kind == POCKET_WORKER_CHANNEL)
      saw_channel = 1;
  }
  assert(saw_timer && saw_channel);
  h.busy = 1;
  assert(pocket_worker_close(w, (uint32_t)handle) == 0);
  pocket_worker_dispatch(w);
  assert(pocket_worker_deadline(w) == h.now + 1000);
  h.busy = 0;
  assert(pocket_worker_destroy(w) == 0);
  struct extended_node {
    pocket_worker_node node;
    uint64_t extension;
  } extended[2] = {
      {{sizeof(struct extended_node), POCKET_WORKER_I2C, "first", &d}, 1},
      {{sizeof(struct extended_node), POCKET_WORKER_I2C, "second", &d}, 2}};
  pocket_worker_config extended_config = {.struct_size = sizeof extended_config,
                                          .generation = 2,
                                          .nodes = &extended[0].node,
                                          .node_count = 2,
                                          .context = &h,
                                          .lock = lock,
                                          .unlock = unlock,
                                          .now_micros = now};
  w = pocket_worker_create(&extended_config);
  assert(w);
  assert(pocket_worker_open(w, POCKET_WORKER_I2C, "second", NULL, 0) > 0);
  assert(pocket_worker_destroy(w) == 0);

  w = create(&h, &d, &node);
  assert(w);
  handle = pocket_worker_open(w, POCKET_WORKER_I2C, "i2c0", NULL, 0);
  assert(handle > 0);
  observe(w, f, bytes);
  int32_t cancelled_stream =
      pocket_worker_submit(w, (uint32_t)handle, 1, NULL, 0, 0);
  assert(cancelled_stream > 0);
  pocket_worker_dispatch(w);
  assert(pocket_worker_emit(w, (uint32_t)handle, POCKET_WORKER_DATA, 0, 0,
                            payload, 3) == 0);
  assert(pocket_worker_cancel(w, (uint32_t)cancelled_stream) == 0);
  pocket_worker_dispatch(w);
  count = observe(w, f, bytes);
  assert(count == 2);
  saw_unknown = 0;
  for (size_t i = 0; i < count; i++) {
    assert(f[i].kind != POCKET_WORKER_END);
    if (f[i].kind == POCKET_WORKER_COMPLETE &&
        f[i].request == (uint32_t)cancelled_stream &&
        f[i].status == POCKET_WORKER_UNKNOWN)
      saw_unknown = 1;
  }
  assert(saw_unknown);
  for (unsigned i = 0; i < POCKET_WORKER_MAX_REQUESTS - 1; i++)
    assert(pocket_worker_submit(w, (uint32_t)handle, 1, NULL, 0, 0) > 0);
  assert(pocket_worker_submit(w, (uint32_t)handle, 1, NULL, 0, 0) ==
         POCKET_WORKER_BUSY);
  assert(pocket_worker_finish(w, (uint32_t)handle, (uint32_t)cancelled_stream,
                              POCKET_WORKER_UNKNOWN, 3) == 0);
  count = observe(w, f, bytes);
  assert(count == 1 && f[0].kind == POCKET_WORKER_END && f[0].offset == 3);
  assert(pocket_worker_submit(w, (uint32_t)handle, 1, NULL, 0, 0) > 0);
  assert(pocket_worker_destroy(w) == 0);
  assert(!pthread_mutex_destroy(&h.mutex));
  puts("worker core: admission, cancellation, streams, generations, timers, "
       "concurrent channels passed");
  return 0;
}
