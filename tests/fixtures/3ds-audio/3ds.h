#ifndef POCKETJS_TEST_3DS_H
#define POCKETJS_TEST_3DS_H

#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef int32_t Result;
typedef void (*ThreadFunc)(void *);
typedef struct FakeThread *Thread;

typedef struct {
  pthread_mutex_t mutex;
  bool initialized;
} LightLock;

typedef struct {
  void *data_vaddr;
  uint32_t nsamples;
  uint32_t offset;
  bool looping;
  _Atomic uint8_t status;
} ndspWaveBuf;

enum {
  NDSP_OUTPUT_STEREO = 0,
  NDSP_INTERP_LINEAR = 1,
  NDSP_FORMAT_STEREO_PCM16 = 2,
  NDSP_WBUF_FREE = 0,
  NDSP_WBUF_QUEUED = 1,
  NDSP_WBUF_PLAYING = 2,
  NDSP_WBUF_DONE = 3,
};

#define R_FAILED(result) ((result) < 0)
#define U64_MAX UINT64_MAX

void LightLock_Init(LightLock *lock);
void LightLock_Lock(LightLock *lock);
void LightLock_Unlock(LightLock *lock);
Thread threadCreate(ThreadFunc function, void *argument, size_t stack_size,
                    int priority, int affinity, bool detached);
void threadJoin(Thread thread, uint64_t timeout);
void threadFree(Thread thread);
void svcSleepThread(int64_t nanoseconds);

Result ndspInit(void);
void ndspExit(void);
void ndspSetOutputMode(int mode);
void ndspChnSetMix(int channel, const float mix[12]);
void ndspChnSetPaused(int channel, bool paused);
void ndspChnWaveBufClear(int channel);
void ndspChnReset(int channel);
void ndspChnSetInterp(int channel, int interpolation);
void ndspChnSetRate(int channel, float rate);
void ndspChnSetFormat(int channel, int format);
void ndspChnWaveBufAdd(int channel, ndspWaveBuf *wave);
void DSP_FlushDataCache(const void *address, size_t size);
void *linearMemAlign(size_t size, size_t alignment);
void linearFree(void *memory);

#endif
