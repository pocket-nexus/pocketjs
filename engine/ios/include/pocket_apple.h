// pocket-apple C ABI — UIKit composition over the canonical PocketJS runtime
// (engine/ios/src/lib.rs). Single-threaded: create, drive, and destroy a
// handle from one thread (in practice the main thread, with CADisplayLink).
//
// Call order per handle:
//   create -> load_pak* -> [set_identity] -> [set_tick_rate] -> eval_bundle
//   -> per tick: frame, render -> destroy
// load_pak/set_identity/set_tick_rate are all rejected after eval_bundle:
// the surface publishes them to the guest when `ui` is mounted (the rate as
// ui.__tickHz), and the bundle's mount-time animate() calls convert ms to
// frames at the rate in force while it evaluates.

#ifndef POCKET_APPLE_H
#define POCKET_APPLE_H

#include <stddef.h>
#include <stdint.h>
#include "pocket_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif

#define POCKET_APPLE_MAX_DAMAGE_REGIONS 8

typedef struct PocketApple PocketApple;

// One rendered frame. `pixels` is ARGB32 words — BGRA byte order in memory on
// little-endian, i.e. kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst.
// The pointer stays valid until the next frame/destroy on the same handle.
typedef struct PocketAppleFrame {
  const uint8_t *pixels;
  uint32_t width_px;
  uint32_t height_px;
  uint32_t stride_bytes;
  // Repaint rects in pixel coordinates as x, y, w, h. region_count == 0 means
  // nothing changed this frame; previous contents are still current.
  int32_t regions[POCKET_APPLE_MAX_DAMAGE_REGIONS][4];
  uint32_t region_count;
  int32_t full_redraw;
} PocketAppleFrame;

uint32_t pocket_apple_abi_version(void);

// Last failure message for this thread; valid until the next failing call.
const char *pocket_apple_last_error(void);

// density is the raster scale (1..4); logical viewport is in pocketjs units
// (hero is 480x272). Returns NULL on failure.
PocketApple *pocket_apple_create(uint32_t density, uint32_t logical_width,
                                 uint32_t logical_height);

int32_t pocket_apple_set_identity(PocketApple *handle, const char *host_id,
                                  uint32_t host_abi);

// Ticks per second of guest virtual time (1..240, default 60); rejected
// after eval_bundle — the mount publishes it as ui.__tickHz and bundles
// refuse a rate other than the one they were built for. The display link
// must be driven at the same rate.
int32_t pocket_apple_set_tick_rate(PocketApple *handle, uint32_t hz);

/* Declare the exact companion service names this host serves (comma-
 * separated svcOpen names). Deny-by-default: never calling this means
 * svcOpen answers false for every service. Before eval_bundle. */
int32_t pocket_apple_set_svc_allowlist(PocketApple *handle,
                                       const char *comma_separated);

int32_t pocket_apple_load_pak(PocketApple *handle, const uint8_t *bytes,
                              size_t length);

// Mounts `ui` on first call, evaluates the bundle, and requires it to install
// globalThis.frame. `label` may be NULL ("app").
int32_t pocket_apple_eval_bundle(PocketApple *handle, const uint8_t *source,
                                 size_t length, const char *label);

// touches: up to 8 packed words in logical coordinates. Legacy words carry
// x:9, y:9, id:8 with bit 31 clear. Wide words set bit 31 and carry x:10,
// y:10, id:8. A contact present this tick means down/move, absent means
// released. Bit 30 marks a cancellation. The canonical runtime resolves and carries the committed-frame hit fact
// for each contact and delivers it as frame() argument 4. analog 0 means
// centered (0x8080).
int32_t pocket_apple_frame(PocketApple *handle, uint32_t buttons,
                           uint32_t analog, const uint32_t *touches,
                           size_t touch_count);

int32_t pocket_apple_render(PocketApple *handle, PocketAppleFrame *out);

// Logical coordinates; returns the hit node id or 0.
int32_t pocket_apple_hit_test_bounds(PocketApple *handle, float x, float y);

// Guest -> host effect sink: lines the guest's effect driver svcSend()s
// (JSON by convention), delivered synchronously during pocket_apple_frame on
// the calling thread. context must outlive the registration.
typedef void (*PocketAppleEffectCallback)(const char *line, void *context);
int32_t pocket_apple_set_effect_callback(PocketApple *handle,
                                         PocketAppleEffectCallback callback,
                                         void *context);

// Host -> guest: queue one line for the guest's next svcPoll (delivered at a
// frame boundary, never mid-tick).
int32_t pocket_apple_post_event(PocketApple *handle, const char *line);

// Reentrant destruction during a frame/guest callback is rejected; callers
// defer destruction until the outer call returns.
void pocket_apple_destroy(PocketApple *handle);

// External engines implement the generated guest lifecycle; operations share
// the canonical instance that owns package admission and presentation.
int32_t pocket_apple_set_guest(PocketApple *handle, const pocket_guest_v1 *guest, void *context);
int32_t pocket_apple_op(PocketApple *handle, uint16_t op, const void *args, size_t length, pocket_result *out);
uint32_t pocket_apple_supports_op(PocketApple *handle, uint16_t op);

#ifdef __cplusplus
}
#endif
#endif
