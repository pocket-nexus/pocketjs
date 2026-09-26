#ifndef POCKET_PACK_TEST_3DS_H
#define POCKET_PACK_TEST_3DS_H
#include "../offload-native/3ds.h"
#define SYSCLOCK_ARM11 1000000000ULL
static inline u64 svcGetSystemTick(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (u64)t.tv_sec * 1000000000 + t.tv_nsec;
}
#endif
