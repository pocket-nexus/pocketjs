#include "pocket_ui_cabi.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

/* The no_std archive uses panic=abort. Prebuilt liballoc can still reference
 * this symbol; an unexpected attempt to unwind must fail the C executable. */
void rust_eh_personality(void) { abort(); }

#ifdef TEST_HOST_ALLOCATOR
static size_t allocations;
static size_t reallocations;
static size_t live_allocations;

static void *aligned(void *pointer) {
  if (pointer == NULL || (uintptr_t)pointer % 16 != 0) {
    fputs("host allocator did not return 16-byte-aligned storage\n", stderr);
    abort();
  }
  return pointer;
}

void *pocket_legacy_host_alloc(size_t size) {
  allocations++;
  live_allocations++;
  return aligned(malloc(size));
}

void *pocket_legacy_host_realloc(void *pointer, size_t size) {
  reallocations++;
  if (pointer == NULL) live_allocations++;
  return aligned(realloc(pointer, size));
}

void pocket_legacy_host_free(void *pointer) {
  if (pointer != NULL) live_allocations--;
  free(pointer);
}
#endif

int main(void) {
  /* RGBA8888 is pixel-storage value 3 in contracts/spec/spec.ts. Holding
   * textures of different sizes also exercises growth of the texture table. */
  enum { TEXTURES = 100, PSM_8888 = 3 };
  uint8_t pixels[64 * 4];
  int32_t handles[TEXTURES];
  for (size_t i = 0; i < sizeof(pixels); i++) pixels[i] = (uint8_t)i;

  for (int cycle = 0; cycle < 2; cycle++) {
    ui_init(1);
    for (int i = 0; i < TEXTURES; i++) {
      const uint32_t width = 1U << (i % 7);
      handles[i] = ui_upload_texture(pixels, (size_t)width * 4,
                                     width, 1, PSM_8888);
      if (handles[i] < 0) {
        fprintf(stderr, "texture upload failed: cycle=%d texture=%d\n", cycle, i);
        return 1;
      }
    }
    /* Release half through the public API; shutdown must release the rest. */
    for (int i = 0; i < TEXTURES; i += 2) ui_free_texture(handles[i]);
    ui_shutdown();
#ifdef TEST_HOST_ALLOCATOR
    if (allocations < TEXTURES || reallocations == 0 || live_allocations != 0) {
      fprintf(stderr, "allocator calls: alloc=%zu realloc=%zu live=%zu\n",
              allocations, reallocations, live_allocations);
      return 1;
    }
#endif
  }
  puts("ui-cabi C allocator: 200 texture uploads and shutdown cleanup passed");
  return 0;
}
