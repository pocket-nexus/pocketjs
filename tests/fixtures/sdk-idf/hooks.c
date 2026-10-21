#define _POSIX_C_SOURCE 200112L
#include "consumer.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef ESP_PLATFORM
#include "esp_heap_caps.h"
#endif
void *pocket_host_alloc(size_t size, size_t alignment) {
  if (alignment < sizeof(void *)) alignment = sizeof(void *);
#ifdef ESP_PLATFORM
  return heap_caps_aligned_alloc(alignment, size, MALLOC_CAP_8BIT);
#else
  void *result = NULL;
  return posix_memalign(&result, alignment, size) == 0 ? result : NULL;
#endif
}
void pocket_host_free(void *pointer, size_t size, size_t alignment) {
  (void)size; (void)alignment; free(pointer);
}
void *pocket_host_realloc(void *pointer, size_t old_size, size_t alignment, size_t new_size) {
  void *next = pocket_host_alloc(new_size, alignment);
  if (!next) return NULL;
  if (pointer) memcpy(next, pointer, old_size < new_size ? old_size : new_size);
  pocket_host_free(pointer, old_size, alignment); return next;
}
void pocket_host_panic(const char *message, size_t length) { fwrite(message, 1, length, stderr); abort(); }
void pocket_host_log(int32_t level, const char *message, size_t length) { (void)level; fwrite(message, 1, length, stderr); }
void pocket_host_boot_stage(int32_t stage) { (void)stage; }
