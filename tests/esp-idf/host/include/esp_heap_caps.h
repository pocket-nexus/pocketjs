#pragma once
#include <stddef.h>
#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_INTERNAL 2
#define MALLOC_CAP_8BIT 4
#define MALLOC_CAP_DMA 8
void *heap_caps_malloc(size_t size, unsigned caps);
void *heap_caps_aligned_alloc(size_t alignment, size_t size, unsigned caps);
void heap_caps_free(void *pointer);
