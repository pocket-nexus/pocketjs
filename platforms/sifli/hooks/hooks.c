/* The pocket_host_* hooks of the Rust archive: one bounded rt_memheap in
 * cached PSRAM, shared with the QuickJS guest, with an alignment-preserving
 * header (Rust asks for up to 64-byte alignment; rt_memheap guarantees
 * pointer alignment). */
#include <limits.h>
#include <rtthread.h>
#include <string.h>

#include "mem_section.h"
#include "pocket/sifli.h"

#define HEAP_BYTES ((size_t)POCKETJS_HEAP_KB * 1024u)

L2_CACHE_NON_RET_BSS_SECT_BEGIN(pocketjs_heap)
// clang-format off
ALIGN(64) static uint8_t g_pool[HEAP_BYTES] L2_CACHE_NON_RET_BSS_SECT(pocketjs_heap);
// clang-format on
L2_CACHE_NON_RET_BSS_SECT_END

static struct rt_memheap g_heap;
static bool g_ready;

int32_t pocket_sifli_heap_init(void) {
  if (g_ready)
    return POCKET_STATUS_OK;
#ifdef PSRAM_DATA_START_ADDR
  const uintptr_t start = (uintptr_t)g_pool;
  if (start < PSRAM_DATA_START_ADDR ||
      start + sizeof(g_pool) > PSRAM_DATA_START_ADDR + PSRAM_DATA_SIZE) {
    rt_kprintf("[PocketJS] heap is not linked into the PSRAM data partition\n");
    return POCKET_STATUS_FAILED;
  }
#endif
  if (rt_memheap_init(&g_heap, "pocket", g_pool, sizeof(g_pool)) != RT_EOK)
    return POCKET_STATUS_FAILED;
  g_ready = true;
  return POCKET_STATUS_OK;
}

void pocket_sifli_heap_stats_get(pocket_sifli_heap_stats *out) {
  if (out == NULL)
    return;
  *out = (pocket_sifli_heap_stats){.total = sizeof(g_pool)};
  if (g_ready) {
    out->used = g_heap.pool_size - g_heap.available_size;
    out->max_used = g_heap.max_used_size;
  }
}

void *pocket_host_alloc(size_t size, size_t align) {
  if (!g_ready || align == 0U || (align & (align - 1U)) != 0U)
    return NULL;
  if (align < sizeof(void *))
    align = sizeof(void *);
  if (size == 0U)
    size = 1U;
  if (align - 1U > SIZE_MAX - sizeof(void *) || size > SIZE_MAX - sizeof(void *) - (align - 1U))
    return NULL;
  void *base = rt_memheap_alloc(&g_heap, size + sizeof(void *) + align - 1U);
  if (base == NULL)
    return NULL;
  const uintptr_t address =
      ((uintptr_t)base + sizeof(void *) + align - 1U) & ~(uintptr_t)(align - 1U);
  ((void **)address)[-1] = base;
  return (void *)address;
}

void pocket_host_free(void *pointer, size_t size, size_t align) {
  (void)size;
  (void)align;
  if (pointer != NULL)
    rt_memheap_free(((void **)pointer)[-1]);
}

void *pocket_host_realloc(void *pointer, size_t old_size, size_t align, size_t new_size) {
  void *next = pocket_host_alloc(new_size, align);
  if (next == NULL)
    return NULL;
  if (pointer != NULL) {
    memcpy(next, pointer, old_size < new_size ? old_size : new_size);
    pocket_host_free(pointer, old_size, align);
  }
  return next;
}

void pocket_host_log(int32_t level, const char *message, size_t length) {
  rt_kprintf("[PocketJS] runtime[%d] %.*s\n", (int)level,
             length > INT_MAX ? INT_MAX : (int)length, message != NULL ? message : "");
}

void pocket_host_panic(const char *message, size_t length) {
  rt_kprintf("[PocketJS] panic: %.*s\n", length > INT_MAX ? INT_MAX : (int)length,
             message != NULL ? message : "");
  RT_ASSERT(0);
  for (;;) {
  }
}

void pocket_host_boot_stage(int32_t stage) { (void)stage; }
