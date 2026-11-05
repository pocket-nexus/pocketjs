#ifndef POCKET_OFFLOAD_QUEUE_H
#define POCKET_OFFLOAD_QUEUE_H
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#define OFFLOAD_BYTES 4096
#define OFFLOAD_SLOTS 8
typedef struct { uint32_t generation, length; char bytes[OFFLOAD_BYTES]; } OffloadRecord;
/* Single producer, single consumer. Neither endpoint waits on the other.
 * A published slot is immutable until its consumer releases it. */
typedef struct {
  _Atomic uint32_t read, write;
  OffloadRecord slots[OFFLOAD_SLOTS];
} OffloadQueue;
static inline bool offload_push(OffloadQueue *q, const char *p, uint32_t n, uint32_t generation) {
  uint32_t w = atomic_load_explicit(&q->write, memory_order_relaxed);
  uint32_t r = atomic_load_explicit(&q->read, memory_order_acquire);
  if (n == 0 || n > OFFLOAD_BYTES || w - r >= OFFLOAD_SLOTS) return false;
  OffloadRecord *s = &q->slots[w % OFFLOAD_SLOTS];
  s->length = n; s->generation = generation; memcpy(s->bytes, p, n);
  atomic_store_explicit(&q->write, w + 1, memory_order_release);
  return true;
}
static inline bool offload_pop(OffloadQueue *q, OffloadRecord *out) {
  uint32_t r = atomic_load_explicit(&q->read, memory_order_relaxed);
  uint32_t w = atomic_load_explicit(&q->write, memory_order_acquire);
  if (r == w) return false;
  *out = q->slots[r % OFFLOAD_SLOTS];
  atomic_store_explicit(&q->read, r + 1, memory_order_release);
  return true;
}
#endif
