#include "../../hosts/3ds/src/offload_queue.h"
#include "../../hosts/3ds/src/offload_coverage.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
static OffloadQueue queue;
static void *produce(void *unused) {
  (void)unused;
  for (uint32_t i = 0; i < 100000; i++) {
    char bytes[OFFLOAD_BYTES]; memset(bytes, i & 255, sizeof bytes);
    while (!offload_push(&queue, bytes, sizeof bytes, i)) {}
  }
  return NULL;
}
int main(void) {
  _Static_assert(ATOMIC_INT_LOCK_FREE == 2, "UI queue requires lock-free atomics");
  uint8_t rgba[16384 * 4 + 1];
  assert(coverage_decode("5OTk", 4, 12, 1, 0xff123456, rgba) == 16);
  for (unsigned i = 0; i < 12; i++) {
    assert(rgba[i * 4] == 0x56 && rgba[i * 4 + 1] == 0x34 && rgba[i * 4 + 2] == 0x12);
    assert(rgba[i * 4 + 3] == (i % 4) * 85);
  }
  assert(rgba[12 * 4] == 0);
  assert(coverage_colorize("000000111111", 12, "123456abcdef", 12, 12, 1, 16, rgba));
  assert(rgba[0] == 0x12 && rgba[1] == 0x34 && rgba[2] == 0x56);
  assert(rgba[6 * 4] == 0xab && rgba[6 * 4 + 3] == 170);
  assert(rgba[12 * 4] == 0); /* padded columns remain transparent */
  assert(!coverage_colorize("000000222222", 12, "123456abcdef", 12, 12, 1, 16, rgba));
  assert(!coverage_colorize("00000011111z", 12, "123456abcdef", 12, 12, 1, 16, rgba));
  assert(!coverage_colorize("000000111111", 11, "123456abcdef", 12, 12, 1, 16, rgba));
  assert(!coverage_colorize("000000111111", 12, "12345gabcdef", 12, 12, 1, 16, rgba));
  /* Narrow document pane: 1024 packed bytes require two base64 padding bytes. */
  char narrow[1368]; memset(narrow, 'A', sizeof narrow);
  memcpy(narrow + sizeof narrow - 4, "5A==", 4);
  assert(coverage_decode(narrow, sizeof narrow, 256, 16, 0xff123456, rgba) == 256);
  for (unsigned i = 4092; i < 4096; i++) assert(rgba[i * 4 + 3] == (i % 4) * 85);
  assert(coverage_decode("5OQ=", 4, 8, 1, 0xff123456, rgba) == 8);
  /* A multiline text block fits the same packed wire budget. */
  char tall[2304]; memset(tall, '/', sizeof tall);
  rgba[16384 * 4] = 0x5a;
  assert(coverage_decode(tall, sizeof tall, 192, 36, 0xff123456, rgba) == 256);
  assert(rgba[(35 * 256 + 191) * 4 + 3] == 255);
  assert(rgba[(35 * 256 + 192) * 4 + 3] == 0);
  assert(rgba[(63 * 256 + 255) * 4 + 3] == 0);
  assert(rgba[16384 * 4] == 0x5a);
  assert(!coverage_decode(tall, sizeof tall, 512, 64, 0, rgba));
  assert(!coverage_decode("!!!!", 4, 12, 1, 0, rgba));
  assert(!coverage_decode("5OTk", 4, 516, 1, 0, rgba));
  assert(!coverage_decode("5OTk", 4, 12, 17, 0, rgba));
  /* Whole glyphs use the same 8192-pixel scratch budget as wide text strips. */
  char glyph[684]; memset(glyph, 'A', sizeof glyph); glyph[683] = '=';
  assert(coverage_decode(glyph, sizeof glyph, 32, 64, 0xffffffff, rgba) == 32);
  assert(coverage_height(48) == 64);
  assert(!coverage_decode(glyph, sizeof glyph, 512, 64, 0xffffffff, rgba));
  assert(!coverage_decode(glyph, sizeof glyph, 64, 129, 0xffffffff, rgba));
  char byte = 0; OffloadRecord record;
  assert(!offload_pop(&queue, &record));
  assert(!offload_push(&queue, &byte, OFFLOAD_BYTES + 1, 0));
  for (int i = 0; i < OFFLOAD_SLOTS; i++) assert(offload_push(&queue, &byte, 1, i));
  assert(!offload_push(&queue, &byte, 1, 9));
  for (int i = 0; i < OFFLOAD_SLOTS; i++) { assert(offload_pop(&queue, &record)); assert(record.generation == (uint32_t)i); }
  // Exercise monotonic counters over uint32 wrap.
  atomic_store(&queue.read, UINT32_MAX - 4); atomic_store(&queue.write, UINT32_MAX - 4);
  pthread_t thread; assert(!pthread_create(&thread, NULL, produce, NULL));
  for (uint32_t i = 0; i < 100000; i++) {
    while (!offload_pop(&queue, &record)) {}
    assert(record.generation == i && record.length == OFFLOAD_BYTES);
    for (int j = 0; j < OFFLOAD_BYTES; j++) assert((unsigned char)record.bytes[j] == (i & 255));
  }
  pthread_join(thread, NULL); puts("100000 SPSC records verified, including full, empty and counter wrap");
}
