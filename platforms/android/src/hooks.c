#include "pocket/android_hooks.h"
#include <android/log.h>
#include <limits.h>
#include <time.h>
uint64_t pocket_android_monotonic_us(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now)) return 0;
  return (uint64_t)now.tv_sec * 1000000u + (uint64_t)now.tv_nsec / 1000u;
}
void pocket_android_log(int priority, const char *tag, const char *message, size_t length) {
  if (!message) return;
  while (length) {
    int chunk = length > INT_MAX ? INT_MAX : (int)length;
    __android_log_print(priority, tag ? tag : "PocketJS", "%.*s", chunk, message);
    message += chunk; length -= (size_t)chunk;
  }
}
