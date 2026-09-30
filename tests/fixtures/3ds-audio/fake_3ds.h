#ifndef POCKETJS_TEST_FAKE_3DS_H
#define POCKETJS_TEST_FAKE_3DS_H

#include "3ds.h"

typedef struct {
  pthread_mutex_t mutex;
  bool paused;
  int format;
  int interpolation;
  float rate;
  float mix[12];
  ndspWaveBuf *waves[8];
  size_t wave_count;
} AudioTestChannel;

extern AudioTestChannel audio_test_channels[8];
extern int audio_test_ndsp_references;
extern int audio_test_ndsp_fail;
extern int audio_test_thread_fail;
extern int audio_test_allocations;
extern int audio_test_frees;
extern int audio_test_active_allocations;
extern int audio_test_fail_allocation_after;

void audio_test_reset(void);
void audio_test_drain(unsigned channel);
size_t audio_test_active_waves(unsigned channel);

#endif
