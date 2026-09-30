#ifndef POCKETJS_3DS_AUDIO_MOD_H
#define POCKETJS_3DS_AUDIO_MOD_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

int32_t audio_mod_create_stream(uint32_t sample_rate, uint32_t channels);
void audio_mod_destroy_stream(int32_t handle);
int32_t audio_mod_write_pcm(int32_t handle, const uint8_t *pcm, size_t length);
void audio_mod_play(int32_t handle);
void audio_mod_pause(int32_t handle);
void audio_mod_stop(int32_t handle);
void audio_mod_set_volume(int32_t handle, double volume);
void audio_mod_end_stream(int32_t handle);
bool audio_mod_poll(char *event, size_t capacity);

/* A guest swap drops every stream but keeps the host audio service ready. */
void audio_mod_forget_guest(void);
/* Release the DSP service and the host-owned wave buffers at process exit. */
void audio_mod_shutdown(void);

#endif
