/*
 * Origin: PocketJS_for_Edgi-Talk/.../applications/pocketjs/include/esp_heap_caps.h
 * Capability-tagged heap API; MALLOC_CAP_SPIRAM maps to HyperRAM in pocketjs_rt_compat.c.
 */
#pragma once

#include <stddef.h>

#define MALLOC_CAP_8BIT     (1U << 0)
#define MALLOC_CAP_INTERNAL (1U << 1)
#define MALLOC_CAP_SPIRAM   (1U << 2)

void *heap_caps_malloc(size_t size, unsigned int caps);
void *heap_caps_aligned_alloc(size_t alignment, size_t size, unsigned int caps);
void heap_caps_free(void *pointer);
