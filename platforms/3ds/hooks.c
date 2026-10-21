#include <pocket_runtime.h>
#include <malloc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void *pocket_host_alloc(size_t size, size_t alignment) {
  return alignment <= 8 ? malloc(size ? size : 1)
                        : memalign(alignment, size ? size : 1);
}
void *pocket_host_realloc(void *pointer, size_t old_size, size_t alignment,
                          size_t new_size) {
  if (alignment <= 8)
    return realloc(pointer, new_size ? new_size : 1);
  void *out = pocket_host_alloc(new_size, alignment);
  if (!out)
    return NULL;
  if (pointer)
    memcpy(out, pointer, old_size < new_size ? old_size : new_size);
  free(pointer);
  return out;
}
void pocket_host_free(void *pointer, size_t size, size_t alignment) {
  (void)size;
  (void)alignment;
  free(pointer);
}
void pocket_host_panic(const char *message, size_t length) {
  fwrite(message, 1, length, stderr);
  abort();
}
void pocket_host_log(int32_t level, const char *message, size_t length) {
  (void)level;
  fwrite(message, 1, length, stderr);
}
void pocket_host_boot_stage(int32_t stage) { (void)stage; }
