#include "../../hosts/3ds/src/offload_image.h"
#include "../../hosts/3ds/src/offload_queue.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
static OffloadImages images;
static OffloadQueue queue;
static void prepare(OffloadImageSlot *s, uint32_t id) {
  memcpy(s->wire, "PIMG", 4);
  for (int i = 0; i < 4; i++) s->wire[4 + i] = id >> (i * 8);
  s->wire[8] = s->wire[10] = 0; s->wire[9] = s->wire[11] = 1;
  memset(s->wire + 12, 0, 4); memset(s->wire + 16, id & 255, OFFLOAD_IMAGE_BYTES);
}
static void *produce(void *unused) {
  (void)unused;
  for (uint32_t id = 1; id <= 4000; id++) {
    OffloadImageSlot *s; while (!(s = image_reserve(&images))) {}
    prepare(s, id); assert(image_publish(&images, s, sizeof s->wire, 7));
    uint32_t token = s->token; while (!offload_push_ticket(&queue, "x", 1, 7, token)) {}
  }
  return NULL;
}
int main(void) {
  _Static_assert(ATOMIC_INT_LOCK_FREE == 2, "image credit requires lock-free atomics");
  OffloadImageSlot *s = image_reserve(&images); assert(s); prepare(s, 1);
  assert(!image_publish(&images, s, sizeof s->wire - 1, 1));
  s->wire[9] = 2; assert(!image_publish(&images, s, sizeof s->wire, 1));
  prepare(s, 1); s->wire[12] = 1; assert(!image_publish(&images, s, sizeof s->wire, 1));
  prepare(s, 0); assert(!image_publish(&images, s, sizeof s->wire, 1));
  prepare(s, 1); assert(image_publish(&images, s, sizeof s->wire, 1));
  uint32_t old = s->token; image_release(&images, old); image_release(&images, old);
  s = image_reserve(&images); prepare(s, 2); assert(image_publish(&images, s, sizeof s->wire, 2));
  image_release(&images, old); assert(image_borrow(&images, s->token) == s); assert(!image_borrow(&images, old));
  for (int n = 1; n < OFFLOAD_IMAGE_SLOTS; n++) { OffloadImageSlot *p = image_reserve(&images); assert(p); prepare(p, n + 2); assert(image_publish(&images, p, sizeof p->wire, 2)); }
  assert(!image_reserve(&images));
  for (int n = 0; n < OFFLOAD_IMAGE_SLOTS; n++) image_release(&images, images.slots[n].token);
  images.next_token = 0x1ffffffe; /* cross the sequence wrap */
  pthread_t thread; assert(!pthread_create(&thread, NULL, produce, NULL));
  for (uint32_t id = 1; id <= 4000; id++) {
    OffloadRecord r; while (!offload_pop(&queue, &r)) {}
    OffloadImageSlot *p = image_borrow(&images, r.image_token); assert(p && p->request == id && p->generation == 7 && p->width == 256 && p->height == 256);
    for (unsigned n = 0; n < OFFLOAD_IMAGE_BYTES; n++) assert(p->wire[16 + n] == (id & 255));
    image_release(&images, r.image_token); assert(!image_borrow(&images, r.image_token));
  }
  pthread_join(thread, NULL); puts("4000 binary images verified with bounded credit and token ownership");
}
