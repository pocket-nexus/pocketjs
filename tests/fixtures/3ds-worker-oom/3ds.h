/* Host declarations for testing the 3DS worker's QuickJS allocation paths.
 * No threads or platform I/O are run; the linker discards those functions. */
#ifndef TEST_3DS_WORKER_3DS_H
#define TEST_3DS_WORKER_3DS_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
typedef int LightLock;
typedef int LightEvent;
typedef void *Thread;
enum { RESET_ONESHOT };
void LightLock_Init(LightLock *);
void LightLock_Lock(LightLock *);
void LightLock_Unlock(LightLock *);
void LightEvent_Init(LightEvent *, int);
void LightEvent_Signal(LightEvent *);
void LightEvent_Wait(LightEvent *);
int LightEvent_WaitTimeout(LightEvent *, int64_t);
Thread threadCreate(void (*)(void *), void *, size_t, int, int, bool);
int threadJoin(Thread, uint64_t);
void threadFree(Thread);
int svcSleepThread(int64_t);
static inline int svcOutputDebugString(const char *text, int32_t length) {
  (void)text;
  (void)length;
  return 0;
}
#endif
