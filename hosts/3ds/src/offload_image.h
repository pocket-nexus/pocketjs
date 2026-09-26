#ifndef POCKET_OFFLOAD_IMAGE_H
#define POCKET_OFFLOAD_IMAGE_H
#include <stdatomic.h>
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>
#define OFFLOAD_IMAGE_BYTES (256 * 256 * 2)
#define OFFLOAD_IMAGE_SLOTS 8
#define OFFLOAD_IMAGE_HEADER 16
enum { IMAGE_FREE, IMAGE_WRITING, IMAGE_READY };
typedef struct {
  _Atomic unsigned state;
  uint32_t token, request, generation, length;
  unsigned width, height;
  uint8_t wire[OFFLOAD_IMAGE_HEADER + OFFLOAD_IMAGE_BYTES];
} OffloadImageSlot;
typedef struct { OffloadImageSlot slots[OFFLOAD_IMAGE_SLOTS]; uint32_t next_token; } OffloadImages;
static inline uint32_t image_u32(const uint8_t *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
/* Worker acquires FREE storage before reading the network. UI never waits. */
static inline OffloadImageSlot *image_reserve(OffloadImages *images) {
  for (unsigned n = 0; n < OFFLOAD_IMAGE_SLOTS; n++) {
    OffloadImageSlot *slot = &images->slots[n];
    unsigned expected = IMAGE_FREE;
    if (atomic_compare_exchange_strong_explicit(&slot->state, &expected, IMAGE_WRITING, memory_order_acquire, memory_order_relaxed)) return slot;
  }
  return NULL;
}
/* Worker validates every byte count before publishing. Tokens never reuse a
 * live allocation, including across connections and uint32 counter wrap. */
static inline bool image_publish(OffloadImages *images, OffloadImageSlot *slot, uint32_t length, uint32_t generation) {
  if (length < OFFLOAD_IMAGE_HEADER || length > sizeof slot->wire || memcmp(slot->wire, "PIMG", 4) || image_u32(slot->wire + 12)) return false;
  unsigned w = slot->wire[8] | (unsigned)slot->wire[9] << 8, h = slot->wire[10] | (unsigned)slot->wire[11] << 8;
  uint32_t request = image_u32(slot->wire + 4);
  if (!request || !generation || w < 16 || h < 16 || w > 256 || h > 256 || (w & (w - 1)) || (h & (h - 1)) || length != OFFLOAD_IMAGE_HEADER + w * h * 2) return false;
  /* Tokens combine a 29-bit sequence with the slot index. Older tokens cannot
   * release another slot; wrap requires 536 million uploads to the same slot. */
  images->next_token = (images->next_token % 0x1fffffff) + 1;
  slot->token = (images->next_token << 3) | (uint32_t)(slot - images->slots);
  slot->request = request; slot->generation = generation; slot->length = w * h * 2; slot->width = w; slot->height = h;
  atomic_store_explicit(&slot->state, IMAGE_READY, memory_order_release); return true;
}
/* Only the UI calls borrow/release after publication in the incoming queue.
 * The worker must not reset READY slots on disconnect. */
static inline OffloadImageSlot *image_borrow(OffloadImages *images, uint32_t token) {
  OffloadImageSlot *slot = &images->slots[token % OFFLOAD_IMAGE_SLOTS];
  return token && atomic_load_explicit(&slot->state, memory_order_acquire) == IMAGE_READY && slot->token == token ? slot : NULL;
}
static inline void image_release(OffloadImages *images, uint32_t token) {
  OffloadImageSlot *slot = image_borrow(images, token);
  if (slot) atomic_store_explicit(&slot->state, IMAGE_FREE, memory_order_release);
}
#endif
