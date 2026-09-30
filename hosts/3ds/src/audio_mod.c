/* The AUDIO MODULE for the 3DS host (contracts/spec/audio.ts).
 *
 * Four guest-owned source rings feed four NDSP channels. The module thread
 * copies ring data into linear, DMA-readable wave buffers and queues them;
 * NDSP consumes those buffers on its device clock without calling QuickJS.
 * Channel 0 belongs to media.playback, so the PCM module uses channels 1..4.
 *
 * The main thread owns every guest operation. A short LightLock also protects
 * the module thread while it reads the rings or changes NDSP queues. No code
 * in the audio thread allocates. `poll()` turns native state into one JSON
 * event per call, in stream order: ended, underrun, then credit.
 */
#include "audio_mod.h"
#include <3ds.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

enum {
  AUDIO_MAX_STREAMS = 4,
  AUDIO_RING_FRAMES = 16384,
  AUDIO_BLOCK_FRAMES = 1024,
  AUDIO_WAVE_BUFFERS = 3,
  AUDIO_QUEUE_TARGET = 2,
  AUDIO_CHANNEL_FIRST = 1,
  AUDIO_HANDLE_SLOT_BITS = 3,
  AUDIO_HANDLE_SLOT_MASK = (1 << AUDIO_HANDLE_SLOT_BITS) - 1,
};

_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "Audio thread requires lock-free state access");
_Static_assert(AUDIO_MAX_STREAMS <= (1 << AUDIO_HANDLE_SLOT_BITS), "Stream handle slot is too small");

typedef struct {
  uint32_t sample_rate;
  uint32_t channels;
  uint32_t generation;
  uint32_t write_pos;
  uint32_t read_pos;
  uint32_t last_free;
  float volume;
  bool live;
  bool playing;
  bool end_flagged;
  bool starved;
  bool underrun_edge;
  bool ended_edge;
  bool channel_paused;
} AudioStream;

/* Rings keep stereo frames; mono writes are duplicated into both ears. */
static int16_t rings[AUDIO_MAX_STREAMS][AUDIO_RING_FRAMES * 2];
static AudioStream streams[AUDIO_MAX_STREAMS];
static ndspWaveBuf wave_buffers[AUDIO_MAX_STREAMS][AUDIO_WAVE_BUFFERS];
static int16_t *wave_memory[AUDIO_MAX_STREAMS][AUDIO_WAVE_BUFFERS];

static LightLock audio_lock;
static Thread audio_thread;
static _Atomic int thread_running;
static bool engine_ready;

static unsigned channel_for(unsigned slot) {
  return AUDIO_CHANNEL_FIRST + slot;
}

static int32_t handle_for(unsigned slot, uint32_t generation) {
  return (int32_t)((generation << AUDIO_HANDLE_SLOT_BITS) | slot);
}

/* Handles include a generation so a destroyed stream cannot alias a later
 * stream that reuses the same slot. Call with audio_lock held. */
static int stream_for(int32_t handle) {
  if (handle < 0) return -1;
  unsigned slot = (unsigned)handle & AUDIO_HANDLE_SLOT_MASK;
  uint32_t generation = (uint32_t)handle >> AUDIO_HANDLE_SLOT_BITS;
  if (slot >= AUDIO_MAX_STREAMS) return -1;
  if (!streams[slot].live || streams[slot].generation != generation) return -1;
  return (int)slot;
}

static void set_mix(unsigned slot) {
  float mix[12] = {0};
  mix[0] = streams[slot].volume;
  mix[1] = streams[slot].volume;
  ndspChnSetMix((int)channel_for(slot), mix);
}

static void clear_channel(unsigned slot) {
  unsigned channel = channel_for(slot);
  ndspChnSetPaused((int)channel, true);
  ndspChnWaveBufClear((int)channel);
  for (unsigned i = 0; i < AUDIO_WAVE_BUFFERS; i += 1) {
    ndspWaveBuf *wave = &wave_buffers[slot][i];
    wave->nsamples = 0;
    wave->offset = 0;
    wave->looping = false;
    wave->status = NDSP_WBUF_FREE;
  }
  streams[slot].channel_paused = true;
}

static void reset_stream(unsigned slot, bool release_slot) {
  AudioStream *stream = &streams[slot];
  clear_channel(slot);
  stream->playing = false;
  stream->end_flagged = false;
  stream->starved = false;
  stream->underrun_edge = false;
  stream->ended_edge = false;
  stream->read_pos = stream->write_pos;
  if (release_slot) stream->live = false;
}

static void queue_wave(unsigned slot, unsigned wave_index, uint32_t frames) {
  AudioStream *stream = &streams[slot];
  ndspWaveBuf *wave = &wave_buffers[slot][wave_index];
  int16_t *output = wave_memory[slot][wave_index];
  uint32_t read = stream->read_pos;

  for (uint32_t i = 0; i < frames; i += 1) {
    uint32_t source = ((read + i) % AUDIO_RING_FRAMES) * 2;
    output[i * 2] = rings[slot][source];
    output[i * 2 + 1] = rings[slot][source + 1];
  }

  DSP_FlushDataCache(output, frames * 2 * sizeof(int16_t));
  wave->nsamples = frames;
  wave->offset = 0;
  wave->looping = false;
  ndspChnWaveBufAdd((int)channel_for(slot), wave);
  stream->read_pos += frames;
  stream->starved = false;
}

/* Keep a small device queue so playback survives a late guest frame without
 * adding a full ring's worth of latency. The DSP clock drains queued buffers;
 * this thread only replenishes them and records edges for poll(). */
static void update_stream(unsigned slot) {
  AudioStream *stream = &streams[slot];
  if (!stream->live || !stream->playing) return;

  unsigned active = 0;
  for (unsigned i = 0; i < AUDIO_WAVE_BUFFERS; i += 1) {
    uint8_t status = wave_buffers[slot][i].status;
    if (status == NDSP_WBUF_QUEUED || status == NDSP_WBUF_PLAYING) active += 1;
  }

  uint32_t available = stream->write_pos - stream->read_pos;
  while (active < AUDIO_QUEUE_TARGET && available > 0) {
    int free_wave = -1;
    for (unsigned i = 0; i < AUDIO_WAVE_BUFFERS; i += 1) {
      uint8_t status = wave_buffers[slot][i].status;
      if (status == NDSP_WBUF_FREE || status == NDSP_WBUF_DONE) {
        free_wave = (int)i;
        break;
      }
    }
    if (free_wave < 0) break;
    uint32_t frames = available < AUDIO_BLOCK_FRAMES ? available : AUDIO_BLOCK_FRAMES;
    queue_wave(slot, (unsigned)free_wave, frames);
    active += 1;
    available -= frames;
  }

  if (active == 0 && available == 0) {
    if (stream->end_flagged) {
      stream->playing = false;
      stream->end_flagged = false;
      stream->ended_edge = true;
      if (!stream->channel_paused) {
        ndspChnSetPaused((int)channel_for(slot), true);
        stream->channel_paused = true;
      }
    } else if (!stream->starved) {
      stream->starved = true;
      stream->underrun_edge = true;
    }
  }
}

static void run_audio(void *unused) {
  (void)unused;
  while (atomic_load_explicit(&thread_running, memory_order_acquire)) {
    LightLock_Lock(&audio_lock);
    for (unsigned slot = 0; slot < AUDIO_MAX_STREAMS; slot += 1) {
      update_stream(slot);
    }
    LightLock_Unlock(&audio_lock);
    svcSleepThread(1000000);
  }
}

static void release_wave_memory(void) {
  for (unsigned slot = 0; slot < AUDIO_MAX_STREAMS; slot += 1) {
    for (unsigned i = 0; i < AUDIO_WAVE_BUFFERS; i += 1) {
      if (wave_memory[slot][i] != NULL) linearFree(wave_memory[slot][i]);
      wave_memory[slot][i] = NULL;
      memset(&wave_buffers[slot][i], 0, sizeof(wave_buffers[slot][i]));
    }
  }
}

/* NDSP is reference-counted by libctru, so media.playback may hold its own
 * reference while this module owns one. Setup and teardown run on the main
 * thread; the worker only uses the initialized service. */
static bool ensure_engine(void) {
  if (engine_ready) return true;
  if (R_FAILED(ndspInit())) return false;

  LightLock_Init(&audio_lock);
  ndspSetOutputMode(NDSP_OUTPUT_STEREO);
  memset(streams, 0, sizeof(streams));
  memset(rings, 0, sizeof(rings));

  for (unsigned slot = 0; slot < AUDIO_MAX_STREAMS; slot += 1) {
    for (unsigned i = 0; i < AUDIO_WAVE_BUFFERS; i += 1) {
      int16_t *memory = linearMemAlign(
        AUDIO_BLOCK_FRAMES * 2 * sizeof(int16_t),
        0x80
      );
      if (memory == NULL) {
        release_wave_memory();
        ndspExit();
        return false;
      }
      wave_memory[slot][i] = memory;
      memset(memory, 0, AUDIO_BLOCK_FRAMES * 2 * sizeof(int16_t));
      wave_buffers[slot][i].data_vaddr = memory;
      wave_buffers[slot][i].status = NDSP_WBUF_FREE;
    }
  }

  atomic_store_explicit(&thread_running, 1, memory_order_release);
  audio_thread = threadCreate(run_audio, NULL, 32 * 1024, 0x18, -2, false);
  if (audio_thread == NULL) {
    atomic_store_explicit(&thread_running, 0, memory_order_release);
    release_wave_memory();
    ndspExit();
    return false;
  }
  engine_ready = true;
  return true;
}

int32_t audio_mod_create_stream(uint32_t sample_rate, uint32_t channels) {
  if (sample_rate != 44100 && sample_rate != 22050 && sample_rate != 11025) return -1;
  if (channels < 1 || channels > 2 || !ensure_engine()) return -1;

  LightLock_Lock(&audio_lock);
  unsigned slot = AUDIO_MAX_STREAMS;
  for (unsigned i = 0; i < AUDIO_MAX_STREAMS; i += 1) {
    if (!streams[i].live) {
      slot = i;
      break;
    }
  }
  if (slot == AUDIO_MAX_STREAMS) {
    LightLock_Unlock(&audio_lock);
    return -1;
  }

  AudioStream *stream = &streams[slot];
  clear_channel(slot);
  uint32_t generation = (stream->generation + 1) & 0x0fffffffu;
  if (generation == 0) generation = 1;
  memset(stream, 0, sizeof(*stream));
  stream->sample_rate = sample_rate;
  stream->channels = channels;
  stream->generation = generation;
  stream->last_free = AUDIO_RING_FRAMES;
  stream->volume = 1.0f;
  stream->channel_paused = true;

  unsigned channel = channel_for(slot);
  ndspChnReset((int)channel);
  ndspChnSetInterp((int)channel, NDSP_INTERP_LINEAR);
  ndspChnSetRate((int)channel, (float)sample_rate);
  ndspChnSetFormat((int)channel, NDSP_FORMAT_STEREO_PCM16);
  ndspChnSetPaused((int)channel, true);
  set_mix(slot);
  stream->live = true;
  int32_t handle = handle_for(slot, generation);
  LightLock_Unlock(&audio_lock);
  return handle;
}

void audio_mod_destroy_stream(int32_t handle) {
  if (!engine_ready) return;
  LightLock_Lock(&audio_lock);
  int slot = stream_for(handle);
  if (slot >= 0) reset_stream((unsigned)slot, true);
  LightLock_Unlock(&audio_lock);
}

static int16_t read_s16_le(const uint8_t *bytes) {
  uint16_t sample = (uint16_t)bytes[0] | ((uint16_t)bytes[1] << 8);
  return (int16_t)sample;
}

int32_t audio_mod_write_pcm(int32_t handle, const uint8_t *pcm, size_t length) {
  if (!engine_ready || pcm == NULL) return 0;
  LightLock_Lock(&audio_lock);
  int slot = stream_for(handle);
  if (slot < 0) {
    LightLock_Unlock(&audio_lock);
    return 0;
  }

  AudioStream *stream = &streams[slot];
  size_t bytes_per_frame = stream->channels * sizeof(int16_t);
  uint32_t frames = (uint32_t)(length / bytes_per_frame);
  uint32_t queued = stream->write_pos - stream->read_pos;
  if (queued > AUDIO_RING_FRAMES) queued = AUDIO_RING_FRAMES;
  uint32_t free_frames = AUDIO_RING_FRAMES - queued;
  uint32_t accepted = frames < free_frames ? frames : free_frames;

  for (uint32_t i = 0; i < accepted; i += 1) {
    uint32_t dst = ((stream->write_pos + i) % AUDIO_RING_FRAMES) * 2;
    if (stream->channels == 1) {
      int16_t sample = read_s16_le(pcm + i * 2);
      rings[slot][dst] = sample;
      rings[slot][dst + 1] = sample;
    } else {
      rings[slot][dst] = read_s16_le(pcm + i * 4);
      rings[slot][dst + 1] = read_s16_le(pcm + i * 4 + 2);
    }
  }
  stream->write_pos += accepted;
  stream->last_free = accepted > stream->last_free ? 0 : stream->last_free - accepted;
  LightLock_Unlock(&audio_lock);
  return (int32_t)accepted;
}

void audio_mod_play(int32_t handle) {
  if (!engine_ready) return;
  LightLock_Lock(&audio_lock);
  int slot = stream_for(handle);
  if (slot >= 0) {
    AudioStream *stream = &streams[slot];
    stream->starved = false;
    stream->playing = true;
    if (stream->channel_paused) {
      ndspChnSetPaused((int)channel_for((unsigned)slot), false);
      stream->channel_paused = false;
    }
  }
  LightLock_Unlock(&audio_lock);
}

void audio_mod_pause(int32_t handle) {
  if (!engine_ready) return;
  LightLock_Lock(&audio_lock);
  int slot = stream_for(handle);
  if (slot >= 0) {
    streams[slot].playing = false;
    if (!streams[slot].channel_paused) {
      ndspChnSetPaused((int)channel_for((unsigned)slot), true);
      streams[slot].channel_paused = true;
    }
  }
  LightLock_Unlock(&audio_lock);
}

void audio_mod_stop(int32_t handle) {
  if (!engine_ready) return;
  LightLock_Lock(&audio_lock);
  int slot = stream_for(handle);
  if (slot >= 0) reset_stream((unsigned)slot, false);
  LightLock_Unlock(&audio_lock);
}

void audio_mod_set_volume(int32_t handle, double volume) {
  if (!engine_ready) return;
  if (!(volume >= 0.0)) volume = 0.0;
  if (volume > 1.0) volume = 1.0;
  LightLock_Lock(&audio_lock);
  int slot = stream_for(handle);
  if (slot >= 0) {
    streams[slot].volume = (float)volume;
    set_mix((unsigned)slot);
  }
  LightLock_Unlock(&audio_lock);
}

void audio_mod_end_stream(int32_t handle) {
  if (!engine_ready) return;
  LightLock_Lock(&audio_lock);
  int slot = stream_for(handle);
  if (slot >= 0) streams[slot].end_flagged = true;
  LightLock_Unlock(&audio_lock);
}

bool audio_mod_poll(char *event, size_t capacity) {
  if (!engine_ready || event == NULL || capacity == 0) return false;
  bool found = false;
  LightLock_Lock(&audio_lock);
  for (unsigned slot = 0; slot < AUDIO_MAX_STREAMS && !found; slot += 1) {
    AudioStream *stream = &streams[slot];
    if (!stream->live) continue;
    int32_t handle = handle_for(slot, stream->generation);
    int written = 0;
    bool clear_ended = false;
    bool clear_underrun = false;
    bool update_credit = false;
    uint32_t free_frames = 0;
    if (stream->ended_edge) {
      written = snprintf(event, capacity, "{\"t\":\"ended\",\"h\":%ld}", (long)handle);
      clear_ended = true;
    } else if (stream->underrun_edge) {
      written = snprintf(event, capacity, "{\"t\":\"underrun\",\"h\":%ld}", (long)handle);
      clear_underrun = true;
    } else {
      uint32_t queued = stream->write_pos - stream->read_pos;
      if (queued > AUDIO_RING_FRAMES) queued = AUDIO_RING_FRAMES;
      free_frames = AUDIO_RING_FRAMES - queued;
      if (free_frames != stream->last_free) {
        written = snprintf(
          event,
          capacity,
          "{\"t\":\"credit\",\"h\":%ld,\"free\":%lu}",
          (long)handle,
          (unsigned long)free_frames
        );
        update_credit = true;
      }
    }
    if (written > 0 && (size_t)written < capacity) {
      if (clear_ended) stream->ended_edge = false;
      if (clear_underrun) stream->underrun_edge = false;
      if (update_credit) stream->last_free = free_frames;
      found = true;
    } else if (written > 0) {
      /* Preserve the pending event so a later poll with enough room can
       * deliver it. Keep the slot-order contract by stopping here. */
      break;
    }
  }
  LightLock_Unlock(&audio_lock);
  return found;
}

void audio_mod_forget_guest(void) {
  if (!engine_ready) return;
  LightLock_Lock(&audio_lock);
  for (unsigned slot = 0; slot < AUDIO_MAX_STREAMS; slot += 1) {
    if (streams[slot].live) reset_stream(slot, true);
  }
  LightLock_Unlock(&audio_lock);
}

void audio_mod_shutdown(void) {
  if (!engine_ready) return;
  atomic_store_explicit(&thread_running, 0, memory_order_release);
  threadJoin(audio_thread, U64_MAX);
  threadFree(audio_thread);
  audio_thread = NULL;

  LightLock_Lock(&audio_lock);
  for (unsigned slot = 0; slot < AUDIO_MAX_STREAMS; slot += 1) {
    clear_channel(slot);
    streams[slot].live = false;
  }
  LightLock_Unlock(&audio_lock);

  release_wave_memory();
  ndspExit();
  engine_ready = false;
}
