#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "pocket_runtime.h"
#include "quickjs.h"

#ifdef __cplusplus
extern "C" {
#endif

/** The board's speaker for `globalThis.media` (contracts/spec/media.ts). */
typedef struct {
  size_t struct_size;
  /** Open the speaker for interleaved 16-bit stereo PCM at `rate` Hz. A
   * failure plays streams muted. */
  esp_err_t (*audio_open)(void *context, uint32_t rate);
  /** Play `frames` stereo frames; blocks while the output is full. */
  esp_err_t (*audio_write)(void *context, const int16_t *pcm, size_t frames);
  /** Output volume, 0 to 100. */
  void (*audio_volume)(void *context, uint32_t percent);
  void (*audio_close)(void *context);
  void *context;
  /** Core for the stream and audio tasks. */
  int worker_core;
} pocketjs_media_config_t;

void pocketjs_media_config_defaults(pocketjs_media_config_t *config);

/** Start the stream and audio tasks. They outlive guests. */
esp_err_t pocketjs_media_setup(const pocketjs_media_config_t *config);

/** Install `globalThis.media` (media.playback) into `realm` before the
 * runtime boots the guest; its texture lives in `runtime`'s guest. */
esp_err_t pocketjs_media_install(JSContext *realm, pocket_runtime *runtime);

/** The owner task between ticks: copy the frame due now into the texture. */
void pocketjs_media_present(void);

/** Guest teardown: stop the stream; the guest's runtime and texture go. */
void pocketjs_media_teardown(void);

#ifdef __cplusplus
}
#endif
