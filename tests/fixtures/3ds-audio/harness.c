#define _POSIX_C_SOURCE 200112L
#include "fake_3ds.h"
#include "audio_mod.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

struct FakeThread {
  pthread_t thread;
};

struct FakeThreadStart {
  ThreadFunc function;
  void *argument;
};

AudioTestChannel audio_test_channels[8];
int audio_test_ndsp_references;
int audio_test_ndsp_fail;
int audio_test_thread_fail;
int audio_test_allocations;
int audio_test_frees;
int audio_test_active_allocations;
int audio_test_fail_allocation_after = -1;
static bool audio_test_channel_mutexes_ready;

#define CHECK(condition) do { \
  if (!(condition)) { \
    fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__, #condition); \
    return 1; \
  } \
} while (0)

void audio_test_reset(void) {
  if (audio_test_channel_mutexes_ready) {
    for (size_t i = 0; i < sizeof(audio_test_channels) / sizeof(audio_test_channels[0]); i += 1) {
      pthread_mutex_destroy(&audio_test_channels[i].mutex);
    }
  }
  memset(audio_test_channels, 0, sizeof(audio_test_channels));
  for (size_t i = 0; i < sizeof(audio_test_channels) / sizeof(audio_test_channels[0]); i += 1) {
    pthread_mutex_init(&audio_test_channels[i].mutex, NULL);
  }
  audio_test_channel_mutexes_ready = true;
  audio_test_ndsp_references = 0;
  audio_test_ndsp_fail = 0;
  audio_test_thread_fail = 0;
  audio_test_allocations = 0;
  audio_test_frees = 0;
  audio_test_active_allocations = 0;
  audio_test_fail_allocation_after = -1;
}

static void lock_channel(int channel) {
  pthread_mutex_lock(&audio_test_channels[channel].mutex);
}

static void unlock_channel(int channel) {
  pthread_mutex_unlock(&audio_test_channels[channel].mutex);
}

void LightLock_Init(LightLock *lock) {
  if (!lock->initialized) {
    pthread_mutex_init(&lock->mutex, NULL);
    lock->initialized = true;
  }
}

void LightLock_Lock(LightLock *lock) {
  pthread_mutex_lock(&lock->mutex);
}

void LightLock_Unlock(LightLock *lock) {
  pthread_mutex_unlock(&lock->mutex);
}

static void *run_thread(void *opaque) {
  struct FakeThreadStart *entry = opaque;
  ThreadFunc function = entry->function;
  void *argument = entry->argument;
  free(entry);
  function(argument);
  return NULL;
}

Thread threadCreate(ThreadFunc function, void *argument, size_t stack_size,
                    int priority, int affinity, bool detached) {
  (void)stack_size;
  (void)priority;
  (void)affinity;
  (void)detached;
  if (audio_test_thread_fail) return NULL;
  Thread thread = malloc(sizeof(*thread));
  if (thread == NULL) return NULL;
  struct FakeThreadStart *entry = malloc(sizeof(*entry));
  if (entry == NULL) {
    free(thread);
    return NULL;
  }
  entry->function = function;
  entry->argument = argument;
  if (pthread_create(&thread->thread, NULL, run_thread, entry) != 0) {
    free(entry);
    free(thread);
    return NULL;
  }
  return thread;
}

void threadJoin(Thread thread, uint64_t timeout) {
  (void)timeout;
  if (thread != NULL) pthread_join(thread->thread, NULL);
}

void threadFree(Thread thread) {
  free(thread);
}

void svcSleepThread(int64_t nanoseconds) {
  struct timespec delay = {
    .tv_sec = nanoseconds / 1000000000,
    .tv_nsec = nanoseconds % 1000000000,
  };
  while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {}
}

Result ndspInit(void) {
  if (audio_test_ndsp_fail) return -1;
  audio_test_ndsp_references += 1;
  return 0;
}

void ndspExit(void) {
  audio_test_ndsp_references -= 1;
}

void ndspSetOutputMode(int mode) {
  (void)mode;
}

void ndspChnSetMix(int channel, const float mix[12]) {
  lock_channel(channel);
  memcpy(audio_test_channels[channel].mix, mix, sizeof(audio_test_channels[channel].mix));
  unlock_channel(channel);
}

void ndspChnSetPaused(int channel, bool paused) {
  lock_channel(channel);
  audio_test_channels[channel].paused = paused;
  unlock_channel(channel);
}

void ndspChnWaveBufClear(int channel) {
  lock_channel(channel);
  AudioTestChannel *state = &audio_test_channels[channel];
  for (size_t i = 0; i < state->wave_count; i += 1) {
    atomic_store(&state->waves[i]->status, NDSP_WBUF_FREE);
  }
  state->wave_count = 0;
  unlock_channel(channel);
}

void ndspChnReset(int channel) {
  (void)channel;
}

void ndspChnSetInterp(int channel, int interpolation) {
  lock_channel(channel);
  audio_test_channels[channel].interpolation = interpolation;
  unlock_channel(channel);
}

void ndspChnSetRate(int channel, float rate) {
  lock_channel(channel);
  audio_test_channels[channel].rate = rate;
  unlock_channel(channel);
}

void ndspChnSetFormat(int channel, int format) {
  lock_channel(channel);
  audio_test_channels[channel].format = format;
  unlock_channel(channel);
}

void ndspChnWaveBufAdd(int channel, ndspWaveBuf *wave) {
  lock_channel(channel);
  AudioTestChannel *state = &audio_test_channels[channel];
  bool known = false;
  for (size_t i = 0; i < state->wave_count; i += 1) {
    if (state->waves[i] == wave) known = true;
  }
  if (!known && state->wave_count < sizeof(state->waves) / sizeof(state->waves[0])) {
    state->waves[state->wave_count++] = wave;
  }
  atomic_store(&wave->status, NDSP_WBUF_QUEUED);
  unlock_channel(channel);
}

void audio_test_drain(unsigned channel) {
  lock_channel((int)channel);
  AudioTestChannel *state = &audio_test_channels[channel];
  for (size_t i = 0; i < state->wave_count; i += 1) {
    uint8_t status = atomic_load(&state->waves[i]->status);
    if (status == NDSP_WBUF_QUEUED || status == NDSP_WBUF_PLAYING) {
      atomic_store(&state->waves[i]->status, NDSP_WBUF_DONE);
    }
  }
  unlock_channel((int)channel);
}

size_t audio_test_active_waves(unsigned channel) {
  lock_channel((int)channel);
  AudioTestChannel *state = &audio_test_channels[channel];
  size_t active = 0;
  for (size_t i = 0; i < state->wave_count; i += 1) {
    uint8_t status = atomic_load(&state->waves[i]->status);
    if (status == NDSP_WBUF_QUEUED || status == NDSP_WBUF_PLAYING) active += 1;
  }
  unlock_channel((int)channel);
  return active;
}

static bool audio_test_has_stereo_sample(unsigned channel, int16_t left, int16_t right) {
  bool found = false;
  lock_channel((int)channel);
  AudioTestChannel *state = &audio_test_channels[channel];
  for (size_t wave_index = 0; wave_index < state->wave_count && !found; wave_index += 1) {
    ndspWaveBuf *wave = state->waves[wave_index];
    uint8_t status = atomic_load(&wave->status);
    if (status != NDSP_WBUF_QUEUED && status != NDSP_WBUF_PLAYING) continue;
    const int16_t *samples = wave->data_vaddr;
    for (uint32_t frame = 0; frame < wave->nsamples; frame += 1) {
      if (samples[frame * 2] == left && samples[frame * 2 + 1] == right) {
        found = true;
        break;
      }
    }
  }
  unlock_channel((int)channel);
  return found;
}

void DSP_FlushDataCache(const void *address, size_t size) {
  (void)address;
  (void)size;
}

void *linearMemAlign(size_t size, size_t alignment) {
  if (audio_test_fail_allocation_after == 0) return NULL;
  if (audio_test_fail_allocation_after > 0) audio_test_fail_allocation_after -= 1;
  void *memory = NULL;
  if (posix_memalign(&memory, alignment, size) != 0) return NULL;
  audio_test_allocations += 1;
  audio_test_active_allocations += 1;
  return memory;
}

void linearFree(void *memory) {
  if (memory == NULL) return;
  audio_test_frees += 1;
  audio_test_active_allocations -= 1;
  free(memory);
}

static int wait_for_active(unsigned channel, size_t wanted) {
  for (unsigned i = 0; i < 200; i += 1) {
    if (audio_test_active_waves(channel) >= wanted) return 0;
    svcSleepThread(1000000);
  }
  return -1;
}

static int test_initialization_cleanup(void) {
  audio_test_reset();
  audio_test_ndsp_fail = 1;
  CHECK(audio_mod_create_stream(44100, 2) == -1);
  CHECK(audio_test_ndsp_references == 0);

  audio_test_ndsp_fail = 0;
  audio_test_fail_allocation_after = 2;
  CHECK(audio_mod_create_stream(44100, 2) == -1);
  CHECK(audio_test_ndsp_references == 0);
  CHECK(audio_test_active_allocations == 0);
  CHECK(audio_test_allocations == 2 && audio_test_frees == 2);

  audio_test_fail_allocation_after = -1;
  audio_test_thread_fail = 1;
  CHECK(audio_mod_create_stream(44100, 2) == -1);
  CHECK(audio_test_ndsp_references == 0);
  CHECK(audio_test_active_allocations == 0);
  CHECK(audio_test_allocations == audio_test_frees);

  audio_test_thread_fail = 0;
  int32_t handle = audio_mod_create_stream(44100, 2);
  CHECK(handle >= 0);
  audio_mod_shutdown();
  CHECK(audio_test_ndsp_references == 0);
  CHECK(audio_test_active_allocations == 0);
  CHECK(audio_test_allocations == audio_test_frees);
  return 0;
}

static int test_pcm_contract_and_lifecycle(void) {
  audio_test_reset();
  CHECK(audio_mod_create_stream(48000, 1) == -1);
  CHECK(audio_mod_create_stream(44100, 3) == -1);

  int32_t mono = audio_mod_create_stream(22050, 1);
  CHECK(mono >= 0);
  CHECK(audio_test_channels[1].rate == 22050.0f);
  CHECK(audio_test_channels[1].format == NDSP_FORMAT_STEREO_PCM16);
  CHECK(audio_test_channels[1].interpolation == NDSP_INTERP_LINEAR);
  CHECK(audio_test_channels[1].mix[0] == 1.0f && audio_test_channels[1].mix[1] == 1.0f);

  int32_t low_rate = audio_mod_create_stream(11025, 2);
  int32_t third = audio_mod_create_stream(44100, 2);
  int32_t fourth = audio_mod_create_stream(22050, 2);
  CHECK(low_rate >= 0 && third >= 0 && fourth >= 0);
  CHECK(audio_test_channels[2].rate == 11025.0f);
  CHECK(audio_mod_create_stream(44100, 2) == -1);
  audio_mod_destroy_stream(low_rate);
  audio_mod_destroy_stream(third);
  audio_mod_destroy_stream(fourth);

  const uint8_t sample[] = {0x34, 0x12, 0xff};
  CHECK(audio_mod_write_pcm(mono, sample, sizeof(sample)) == 1);
  audio_mod_set_volume(mono, 0.25);
  CHECK(audio_test_channels[1].mix[0] == 0.25f && audio_test_channels[1].mix[1] == 0.25f);
  audio_mod_play(mono);
  CHECK(wait_for_active(1, 1) == 0);
  ndspWaveBuf *wave = audio_test_channels[1].waves[0];
  int16_t *samples = wave->data_vaddr;
  CHECK(wave->nsamples == 1);
  CHECK(samples[0] == 0x1234 && samples[1] == 0x1234);

  audio_mod_pause(mono);
  CHECK(audio_test_channels[1].paused);
  CHECK(audio_test_active_waves(1) == 1);
  audio_mod_play(mono);
  CHECK(!audio_test_channels[1].paused);

  char small[4];
  CHECK(!audio_mod_poll(small, sizeof(small)));
  char event[128];
  CHECK(audio_mod_poll(event, sizeof(event)));
  CHECK(strncmp(event, "{\"t\":\"credit\"", 13) == 0);
  CHECK(strstr(event, "\"free\":16384}") != NULL);

  audio_mod_stop(mono);
  CHECK(audio_test_channels[1].paused);
  CHECK(audio_test_active_waves(1) == 0);
  CHECK(audio_mod_write_pcm(mono, sample, 2) == 1);
  audio_mod_destroy_stream(mono);
  CHECK(audio_mod_write_pcm(mono, sample, 2) == 0);

  int32_t replacement = audio_mod_create_stream(44100, 2);
  CHECK(replacement >= 0 && replacement != mono);
  audio_mod_forget_guest();
  CHECK(audio_mod_write_pcm(replacement, sample, 2) == 0);
  int32_t next_guest = audio_mod_create_stream(44100, 2);
  CHECK(next_guest >= 0 && next_guest != replacement);
  audio_mod_shutdown();
  CHECK(audio_test_ndsp_references == 0);
  CHECK(audio_test_active_allocations == 0);
  return 0;
}

static int test_partial_write_credits_and_end(void) {
  audio_test_reset();
  int32_t handle = audio_mod_create_stream(44100, 2);
  CHECK(handle >= 0);

  const size_t full_bytes = 16384u * 2u * sizeof(int16_t);
  int16_t *pcm = malloc(full_bytes);
  CHECK(pcm != NULL);
  for (size_t i = 0; i < full_bytes / sizeof(int16_t); i += 1) {
    pcm[i] = (int16_t)(i % 30000);
  }
  CHECK(audio_mod_write_pcm(handle, (const uint8_t *)pcm, full_bytes) == 16384);
  CHECK(audio_mod_write_pcm(handle, (const uint8_t *)pcm, 32u * 4u) == 0);
  audio_mod_play(handle);
  CHECK(wait_for_active(1, 2) == 0);

  char event[128];
  CHECK(audio_mod_poll(event, sizeof(event)));
  CHECK(strncmp(event, "{\"t\":\"credit\"", 13) == 0);
  CHECK(strstr(event, "\"free\":2048}") != NULL);

  int16_t *wrapped_pcm = malloc(4096u * 2u * sizeof(int16_t));
  CHECK(wrapped_pcm != NULL);
  for (size_t frame = 0; frame < 4096; frame += 1) {
    wrapped_pcm[frame * 2] = 0x5a5a;
    wrapped_pcm[frame * 2 + 1] = 0x2d2d;
  }
  CHECK(audio_mod_write_pcm(handle, (const uint8_t *)wrapped_pcm,
                            4096u * 2u * sizeof(int16_t)) == 2048);
  CHECK(!audio_mod_poll(event, sizeof(event)));

  bool wrapped_audio_played = false;
  for (unsigned i = 0; i < 12 && !wrapped_audio_played; i += 1) {
    audio_test_drain(1);
    CHECK(wait_for_active(1, 2) == 0);
    wrapped_audio_played = audio_test_has_stereo_sample(1, 0x5a5a, 0x2d2d);
  }
  CHECK(wrapped_audio_played);
  free(wrapped_pcm);

  audio_mod_stop(handle);
  CHECK(audio_test_active_waves(1) == 0);
  memset(pcm, 0x2a, 1024u * 4u);
  CHECK(audio_mod_write_pcm(handle, (const uint8_t *)pcm, 1024u * 4u) == 1024);
  audio_mod_play(handle);
  CHECK(wait_for_active(1, 1) == 0);
  audio_test_drain(1);
  bool underrun = false;
  for (unsigned i = 0; i < 200; i += 1) {
    if (audio_mod_poll(event, sizeof(event)) &&
        strncmp(event, "{\"t\":\"underrun\"", 15) == 0) {
      underrun = true;
      break;
    }
    svcSleepThread(1000000);
  }
  CHECK(underrun);

  audio_mod_stop(handle);
  CHECK(audio_test_active_waves(1) == 0);
  memset(pcm, 0x2a, 1024u * 4u);
  CHECK(audio_mod_write_pcm(handle, (const uint8_t *)pcm, 1024u * 4u) == 1024);
  audio_mod_play(handle);
  CHECK(wait_for_active(1, 1) == 0);
  audio_mod_end_stream(handle);
  CHECK(!audio_mod_poll(event, sizeof(event)) || strstr(event, "\"t\":\"ended\"") == NULL);
  audio_test_drain(1);
  bool ended = false;
  for (unsigned i = 0; i < 200; i += 1) {
    if (audio_mod_poll(event, sizeof(event))) {
      if (strstr(event, "\"t\":\"ended\"") != NULL) {
        ended = true;
        break;
      }
    }
    svcSleepThread(1000000);
  }
  CHECK(ended);

  audio_mod_destroy_stream(handle);
  CHECK(audio_mod_write_pcm(handle, (const uint8_t *)pcm, 4) == 0);
  int32_t reused = audio_mod_create_stream(44100, 2);
  CHECK(reused >= 0 && reused != handle);
  free(pcm);
  audio_mod_shutdown();
  CHECK(audio_test_ndsp_references == 0);
  CHECK(audio_test_active_allocations == 0);
  return 0;
}

int main(void) {
  if (test_initialization_cleanup() != 0) return 1;
  if (test_pcm_contract_and_lifecycle() != 0) return 1;
  if (test_partial_write_credits_and_end() != 0) return 1;
  puts("3DS PCM formats, partial writes, ring wrap, credits, events, handles and cleanup verified");
  return 0;
}
