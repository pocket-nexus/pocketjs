#include <stddef.h>
#include <stdint.h>
#include <sys/time.h>
#include <time.h>

/* iPhone OS 1.1.4 predates clock_gettime; QuickJS uses it only for Atomics. */
int clock_gettime(clockid_t clock_id, struct timespec *value) {
  (void)clock_id;
  struct timeval now;
  if (gettimeofday(&now, 0) != 0) return -1;
  value->tv_sec = now.tv_sec;
  value->tv_nsec = now.tv_usec * 1000;
  return 0;
}

/* LLVM emits this Darwin memset specialization for the Rust raster core. */
void memset_pattern16(void *destination, const void *pattern, size_t length) {
  uint8_t *output = (uint8_t *)destination;
  const uint8_t *input = (const uint8_t *)pattern;
  for (size_t offset = 0; offset < length; offset += 1) {
    output[offset] = input[offset & 15];
  }
}
