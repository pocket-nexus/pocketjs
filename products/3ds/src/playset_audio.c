/* The playset's sounds on the DSP (playset_audio.h).
 *
 * A sound's PCM is copied into linear memory the first time it plays.
 * One-shots take channels 8..23 round-robin, the oldest one giving way;
 * loops (engines, wind) hold channels 2..7 by voice. Channel 0 belongs to
 * media playback (platforms/3ds/media.c). Without the DSP firmware
 * (sdmc:/3ds/dspfirm.cdc) ndspInit fails and every call here is silent. */
#include "playset_audio.h"

#include <3ds.h>
#include <stdlib.h>
#include <string.h>

#define FIRST_SHOT 8
#define SHOT_CHANNELS 16
#define FIRST_LOOP 2
#define LOOP_CHANNELS 6
#define MAX_SOUNDS 256

typedef struct {
  int16_t *pcm;
  uint32_t samples;
  uint32_t rate;
  bool looping;
  bool ready;
} Pcm;

static bool started, available;
static Pcm sounds[MAX_SOUNDS];
static ndspWaveBuf shots[SHOT_CHANNELS];
static ndspWaveBuf loops[LOOP_CHANNELS];
static int32_t loop_voice[LOOP_CHANNELS];
static uint32_t loop_rate[LOOP_CHANNELS];
static uint32_t next_shot;

static bool ensure(void) {
  if (started) return available;
  started = true;
  available = R_SUCCEEDED(ndspInit());
  if (!available) return false;
  ndspSetOutputMode(NDSP_OUTPUT_STEREO);
  for (int i = 0; i < LOOP_CHANNELS; i++) loop_voice[i] = -1;
  return true;
}

static Pcm *pcm_of(pps *world, uint32_t id) {
  if (id >= MAX_SOUNDS) return NULL;
  Pcm *p = &sounds[id];
  if (p->ready) return p->pcm ? p : NULL;
  p->ready = true;
  const int16_t *data;
  uint32_t samples, rate, looping;
  if (pps_sound_data(world, id, &data, &samples, &rate, &looping) || samples == 0) return NULL;
  p->pcm = linearAlloc(samples * sizeof(int16_t));
  if (!p->pcm) return NULL;
  memcpy(p->pcm, data, samples * sizeof(int16_t));
  DSP_FlushDataCache(p->pcm, samples * sizeof(int16_t));
  p->samples = samples;
  p->rate = rate;
  p->looping = looping != 0;
  return p;
}

static void mix(int channel, float volume, float pan) {
  float m[12] = {0};
  float l = volume * (pan > 0 ? 1.0f - pan : 1.0f);
  float r = volume * (pan < 0 ? 1.0f + pan : 1.0f);
  m[0] = l;
  m[1] = r;
  ndspChnSetMix(channel, m);
}

static void start(int channel, ndspWaveBuf *wb, Pcm *p, float volume, float pitch,
                  float pan, bool looping) {
  ndspChnWaveBufClear(channel);
  ndspChnReset(channel);
  ndspChnSetInterp(channel, NDSP_INTERP_LINEAR);
  ndspChnSetFormat(channel, NDSP_FORMAT_MONO_PCM16);
  ndspChnSetRate(channel, (float)p->rate * pitch);
  mix(channel, volume, pan);
  memset(wb, 0, sizeof *wb);
  wb->data_vaddr = p->pcm;
  wb->nsamples = p->samples;
  wb->looping = looping;
  ndspChnWaveBufAdd(channel, wb);
}

uint32_t playset_audio_state(void) { return !started ? 0 : available ? 1 : 2; }

void playset_audio_frame(pps *world) {
  if (!world) return;
  uint32_t count = 0;
  const pps_voice_request *r = pps_audio_requests(world, &count);
  if (!count || !ensure()) return;
  for (uint32_t i = 0; i < count; i++) {
    const pps_voice_request *q = &r[i];
    if (q->kind == 1) {
      Pcm *p = pcm_of(world, q->sound);
      if (!p) continue;
      int c = (int)(next_shot++ % SHOT_CHANNELS);
      start(FIRST_SHOT + c, &shots[c], p, q->volume, q->pitch, q->pan, false);
    } else if (q->kind == 2) {
      Pcm *p = pcm_of(world, q->sound);
      if (!p) continue;
      int free_slot = -1;
      for (int c = 0; c < LOOP_CHANNELS; c++)
        if (loop_voice[c] < 0) {
          free_slot = c;
          break;
        }
      if (free_slot < 0) continue;
      loop_voice[free_slot] = q->voice;
      loop_rate[free_slot] = p->rate;
      start(FIRST_LOOP + free_slot, &loops[free_slot], p, q->volume, q->pitch, q->pan, true);
    } else {
      for (int c = 0; c < LOOP_CHANNELS; c++) {
        if (loop_voice[c] != q->voice) continue;
        if (q->kind == 3) {
          ndspChnSetRate(FIRST_LOOP + c, (float)loop_rate[c] * q->pitch);
          mix(FIRST_LOOP + c, q->volume, q->pan);
        } else {
          ndspChnWaveBufClear(FIRST_LOOP + c);
          loop_voice[c] = -1;
        }
      }
    }
  }
}

void playset_audio_shutdown(void) {
  if (available) {
    for (int c = 0; c < SHOT_CHANNELS; c++) ndspChnWaveBufClear(FIRST_SHOT + c);
    for (int c = 0; c < LOOP_CHANNELS; c++) ndspChnWaveBufClear(FIRST_LOOP + c);
  }
  for (int i = 0; i < MAX_SOUNDS; i++) {
    if (sounds[i].pcm) linearFree(sounds[i].pcm);
  }
  memset(sounds, 0, sizeof sounds);
  for (int c = 0; c < LOOP_CHANNELS; c++) loop_voice[c] = -1;
  if (available) ndspExit();
  started = available = false;
  next_shot = 0;
}
