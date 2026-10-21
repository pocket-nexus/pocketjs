#include "esp_heap_caps.h"
#include "esp_log.h"
#include <limits.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
static const char *TAG = "pocket_runtime";

void *pocket_host_alloc(size_t size, size_t alignment) {
  if (size == 0U || alignment == 0U || (alignment & (alignment - 1U)) != 0U) {
    return NULL;
  }
  if (alignment < sizeof(void *))
    alignment = sizeof(void *);
  void *memory = heap_caps_aligned_alloc(alignment, size,
                                         MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (memory == NULL) {
    memory = heap_caps_aligned_alloc(alignment, size,
                                     MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  }
  return memory;
}

void *pocket_host_realloc(void *pointer, size_t old_size, size_t alignment,
                          size_t new_size) {
  void *memory = pocket_host_alloc(new_size, alignment);
  if (memory == NULL)
    return NULL;
  if (pointer != NULL) {
    memcpy(memory, pointer, old_size < new_size ? old_size : new_size);
    heap_caps_free(pointer);
  }
  return memory;
}

void pocket_host_free(void *pointer, size_t size, size_t alignment) {
  (void)size;
  (void)alignment;
  heap_caps_free(pointer);
}

void pocket_host_panic(const char *message, size_t length) {
  ESP_LOGE(TAG, "PocketJS panic: %.*s",
           length > INT_MAX ? INT_MAX : (int)length,
           message != NULL ? message : "");
  abort();
}

void pocket_host_log(int level, const char *message, size_t length) {
  ESP_LOGI(TAG, "runtime[%d] %.*s", level,
           length > INT_MAX ? INT_MAX : (int)length,
           message != NULL ? message : "");
}

void pocket_host_boot_stage(int stage) {
  ESP_LOGD(TAG, "PocketJS boot stage %d", stage);
}
