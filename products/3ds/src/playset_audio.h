#ifndef POCKETJS_3DS_PLAYSET_AUDIO_H
#define POCKETJS_3DS_PLAYSET_AUDIO_H

#include <pocket_playset.h>
#include <stdbool.h>

/* The frame's sound requests (pps_audio_requests) onto DSP channels; call
 * after pps_prepare. */
void playset_audio_frame(pps *world);
/* Stops every voice and frees the PCM copies (the playset is going). */
void playset_audio_shutdown(void);
/* 0 not started, 1 playing through the DSP, 2 no DSP (no dspfirm.cdc) */
uint32_t playset_audio_state(void);

#endif
