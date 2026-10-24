#pragma once
/* The Tab5's camera and speaker behind globalThis.camera and media
 * (pocket_camera, pocket_media), for the launcher firmware. */
#include <stdint.h>

#include "pocket_runtime.h"
#include "quickjs.h"

#ifndef TAB5_LAUNCHER
#define TAB5_LAUNCHER 0
#endif
#if TAB5_LAUNCHER
/* Before the runtime boots a guest whose plan `features` (the
 * POCKET_IDF_FEATURE_* bits) hold camera.qr, camera.photo or media.playback:
 * start the board's camera or speaker once and install the namespaces into
 * `realm`. */
void tab5_camera_media_install(JSContext *realm, pocket_runtime *runtime,
                               uint32_t features);
/* Before each tick: copy the newest frames into their textures. */
void tab5_camera_media_present(void);
/* Before the runtime is destroyed. */
void tab5_camera_media_teardown(void);
#else
static inline void tab5_camera_media_install(JSContext *realm,
                                             pocket_runtime *runtime,
                                             uint32_t features) {
  (void)realm;
  (void)runtime;
  (void)features;
}
static inline void tab5_camera_media_present(void) {}
static inline void tab5_camera_media_teardown(void) {}
#endif
