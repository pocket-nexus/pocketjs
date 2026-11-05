#include "pocket/zephyr.h"
#include "pocket_profile.h"
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>
#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(pocketjs, LOG_LEVEL_INF);
#include <string.h>
#include <limits.h>

K_HEAP_DEFINE(pocket_heap, CONFIG_POCKETJS_HEAP_SIZE);
#if defined(CONFIG_POCKETJS_DISPLAY) && DT_HAS_CHOSEN(zephyr_display)
#define POCKET_DISPLAY_NODE DT_CHOSEN(zephyr_display)
#if DT_NODE_HAS_PROP(POCKET_DISPLAY_NODE, width) && DT_NODE_HAS_PROP(POCKET_DISPLAY_NODE, height)
BUILD_ASSERT(DT_PROP(POCKET_DISPLAY_NODE, width) == POCKET_PROFILE_WIDTH,
             "Profile width disagrees with zephyr,display devicetree");
BUILD_ASSERT(DT_PROP(POCKET_DISPLAY_NODE, height) == POCKET_PROFILE_HEIGHT,
             "Profile height disagrees with zephyr,display devicetree");
#endif
#endif
void *pocket_host_alloc(size_t size, size_t align) {
  if (!align || (align & (align - 1))) return NULL;
  if (align < sizeof(void *)) align = sizeof(void *);
  if (!size) size = 1;
  if (align - 1 > SIZE_MAX - sizeof(void *) || size > SIZE_MAX - sizeof(void *) - (align - 1)) return NULL;
  void *base = k_heap_alloc(&pocket_heap, size + sizeof(void *) + align - 1, K_NO_WAIT);
  if (!base) return NULL;
  uintptr_t address = ((uintptr_t)base + sizeof(void *) + align - 1) & ~(uintptr_t)(align - 1);
  ((void **)address)[-1] = base;
  return (void *)address;
}
void pocket_host_free(void *p, size_t size, size_t align) {
  (void)size; (void)align;
  if (p) k_heap_free(&pocket_heap, ((void **)p)[-1]);
}
void *pocket_host_realloc(void *p, size_t old_size, size_t align, size_t size) {
  void *next = pocket_host_alloc(size, align);
  if (!next) return NULL;
  if (p) memcpy(next, p, old_size < size ? old_size : size);
  pocket_host_free(p, old_size, align);
  return next;
}
void pocket_host_log(int32_t level, const char *message, size_t length) {
  printk("PocketJS[%d]: ", (int)level);
  if (message) for (size_t i = 0; i < length; i++) printk("%c", message[i]);
  printk("\n");
}
void pocket_host_panic(const char *message, size_t length) {
  LOG_ERR("Runtime panic");
  pocket_host_log(-1, message, length); k_panic(); CODE_UNREACHABLE;
}
void pocket_host_boot_stage(int32_t stage) { (void)stage; }
static uint64_t now(void *context) {
  (void)context; return k_ticks_to_us_floor64(k_uptime_ticks());
}
static void sleep_until(void *context, uint64_t deadline) {
  uint64_t current;
  while ((current = now(context)) < deadline) {
    uint64_t remaining = deadline - current;
    k_usleep((int32_t)(remaining > INT32_MAX ? INT32_MAX : remaining));
  }
}
static const pocket_clock_v1 CLOCK = {.struct_size=sizeof(CLOCK), .now=now, .sleep_until=sleep_until};
const pocket_clock_v1 *pocket_zephyr_clock(void) { return &CLOCK; }
