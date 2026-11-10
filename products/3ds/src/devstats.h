#ifndef POCKETJS_3DS_DEVSTATS_H
#define POCKETJS_3DS_DEVSTATS_H

/*
 * Diagnostic counters of the running program, for the DevTools shim
 * (`OP.debugStats`, `ui.__dbgFrames`): the build's identity, the running
 * package, the last frame's draw counts and the frame phases' timing. They
 * travel to a panel as DevTools lines over the Pocket Link's stream
 * (docs/POCKET-LINK.md §6.3); nothing here opens a socket.
 */

#include <stdbool.h>
#include <stdint.h>

#include "runtime.h"

/* The runtime's facts at each lifecycle step (main.c report_runtime). */
void devstats_set_runtime(const PocketRuntimeState *state, const PocketRuntimePackage *package, uint32_t frame);
/* One frame's CPU phases in microseconds: guest JS, core tick (animation and
 * physics), DrawList builds, PICA200 preparation and submission, the
 * interval since the previous frame began, the loop's system work before the
 * guest runs (sockets, link, input), the wait for the vblank and the GPU, and
 * layout. `late` is true when the previous frame's GPU work outlasted a
 * vblank. Aggregated per 60-frame window. */
void devstats_set_frame_timing(
  uint32_t js_us,
  uint32_t tick_us,
  uint32_t draw_us,
  uint32_t gpu_us,
  uint32_t frame_us,
  uint32_t pre_us,
  uint32_t wait_us,
  uint32_t layout_us,
  bool late
);
void devstats_set_frame_stats(uint32_t frame, uint32_t commands, uint32_t vertices, uint32_t dropped_vertices);
/* The link's part of the snapshot: whether it is up, how often it came up,
 * and how many packages and screenshots it carried. */
void devstats_set_link(bool linked, uint32_t links, uint32_t pushes, uint32_t screenshots);

/* OP.debugStats: one JSON object. The pointer stays valid until the next call. */
const char *devstats_json(void);
/* ui.__dbgFrames: the last 64 frames, oldest first, one
 * "pre,js,layout,draw,gpu,wait,frame" group of 0.1 ms units per frame
 * separated by ";". */
const char *devstats_frames(void);

#endif
