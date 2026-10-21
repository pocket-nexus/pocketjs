#include "esp_heap_caps.h"
#include <stdlib.h>
#include <string.h>
/* Host sysroot alloc can reference this symbol even with panic=abort. */
void rust_eh_personality(void) { abort(); }
long pocketjs_test_fail_after = -1;
long pocketjs_test_heap_fail_after = -1;
static int fail(void) {
  if (pocketjs_test_fail_after < 0)
    return 0;
  if (pocketjs_test_fail_after == 0)
    return 1;
  --pocketjs_test_fail_after;
  return 0;
}
void *pocketjs_test_malloc(size_t size) { return fail() ? NULL : malloc(size); }
void *pocketjs_test_calloc(size_t count, size_t size) {
  return fail() ? NULL : calloc(count, size);
}
void *pocketjs_test_realloc(void *p, size_t size) {
  return fail() ? NULL : realloc(p, size);
}
char *pocketjs_test_strdup(const char *value) {
  return fail() ? NULL : strdup(value);
}
void *heap_caps_malloc(size_t size, unsigned caps) {
  (void)caps;
  return malloc(size);
}
void *heap_caps_aligned_alloc(size_t alignment, size_t size, unsigned caps) {
  (void)caps;
  if (pocketjs_test_heap_fail_after == 0)
    return NULL;
  if (pocketjs_test_heap_fail_after > 0)
    --pocketjs_test_heap_fail_after;
  void *p = NULL;
  return posix_memalign(&p, alignment, size) == 0 ? p : NULL;
}
void heap_caps_free(void *p) { free(p); }
