/*
 * Diagnostic counters of the running program: see devstats.h.
 */

#include "devstats.h"

#include <stdio.h>

static PocketRuntimeState runtime_state;
static uint64_t running_hash;
static uint64_t variant_hash;
static uint32_t runtime_frame;

static bool link_up;
static uint32_t link_links;
static uint32_t link_pushes;
static uint32_t link_screenshots;

static uint32_t frame_commands;
static uint32_t frame_vertices;
static uint32_t frame_dropped_vertices;
static char stats_json[1280];

/* Frame phase timing: the last complete 60-frame window's means and maxima,
 * plus running counts of frame intervals above 25 ms (1.5 vblanks at 60 Hz)
 * and of frames whose GPU work outlasted a vblank. */
enum { TIMING_PHASES = 8, TIMING_WINDOW = 60 };
static uint32_t timing_sum[TIMING_PHASES];
static uint32_t timing_max[TIMING_PHASES];
static uint32_t timing_count;
static uint32_t timing_mean_out[TIMING_PHASES];
static uint32_t timing_max_out[TIMING_PHASES];
static uint32_t timing_slow_frames;
static uint32_t timing_gpu_late;
enum { FRAME_RING = 64 };
static uint32_t frame_ring[FRAME_RING][7];
static uint32_t frame_ring_next;
static char frames_text[FRAME_RING * 7 * 6];

void devstats_set_runtime(const PocketRuntimeState *state, const PocketRuntimePackage *package, uint32_t frame) {
  if (state != NULL) runtime_state = *state;
  running_hash = package == NULL ? 0 : package->guest.package_hash;
  variant_hash = package == NULL ? 0 : package->guest.variant_hash;
  runtime_frame = frame;
}

void devstats_set_link(bool linked, uint32_t links, uint32_t pushes, uint32_t screenshots) {
  link_up = linked;
  link_links = links;
  link_pushes = pushes;
  link_screenshots = screenshots;
}

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
) {
  const uint32_t values[TIMING_PHASES] = { js_us, tick_us, draw_us, gpu_us, frame_us, pre_us, wait_us, layout_us };
  if (late) timing_gpu_late += 1;
  uint32_t *ring = frame_ring[frame_ring_next % FRAME_RING];
  ring[0] = pre_us; ring[1] = js_us; ring[2] = layout_us; ring[3] = draw_us; ring[4] = gpu_us; ring[5] = wait_us;
  ring[6] = frame_us;
  frame_ring_next += 1;
  for (int i = 0; i < TIMING_PHASES; i += 1) {
    timing_sum[i] += values[i];
    if (values[i] > timing_max[i]) timing_max[i] = values[i];
  }
  /* 1.5 frames at 60 Hz: the frame missed its vblank */
  if (frame_us > 25000) timing_slow_frames += 1;
  timing_count += 1;
  if (timing_count == TIMING_WINDOW) {
    for (int i = 0; i < TIMING_PHASES; i += 1) {
      timing_mean_out[i] = timing_sum[i] / TIMING_WINDOW;
      timing_max_out[i] = timing_max[i];
      timing_sum[i] = 0;
      timing_max[i] = 0;
    }
    timing_count = 0;
  }
}

void devstats_set_frame_stats(uint32_t frame, uint32_t commands, uint32_t vertices, uint32_t dropped_vertices) {
  runtime_frame = frame;
  frame_commands = commands;
  frame_vertices = vertices;
  frame_dropped_vertices = dropped_vertices;
}

const char *devstats_json(void) {
  /* `net` keeps the member names panels read; the link fills the ones it has
   * (`connects` counts links, `uploads` pushed packages). */
  snprintf(
    stats_json,
    sizeof stats_json,
    "{\"target\":\"%s\",\"hostAbi\":%u,\"package\":\"%016llx\","
    "\"variant\":\"%016llx\",\"generation\":%lu,\"frame\":%lu,"
    "\"gfx\":{\"commands\":%lu,\"vertices\":%lu,\"droppedVertices\":%lu},"
    "\"net\":{\"connected\":%s,\"connects\":%lu,\"uploads\":%lu,\"screenshots\":%lu},"
    "\"timingUs\":{\"js\":[%lu,%lu],\"tick\":[%lu,%lu],\"draw\":[%lu,%lu],"
    "\"gpu\":[%lu,%lu],\"frame\":[%lu,%lu],\"pre\":[%lu,%lu],\"wait\":[%lu,%lu],\"layout\":[%lu,%lu],"
    "\"slowFrames\":%lu,\"gpuLate\":%lu}}",
    POCKETJS_TARGET_ID,
    (unsigned)POCKETJS_HOST_ABI,
    (unsigned long long)running_hash,
    (unsigned long long)variant_hash,
    (unsigned long)runtime_state.generation,
    (unsigned long)runtime_frame,
    (unsigned long)frame_commands,
    (unsigned long)frame_vertices,
    (unsigned long)frame_dropped_vertices,
    link_up ? "true" : "false",
    (unsigned long)link_links,
    (unsigned long)link_pushes,
    (unsigned long)link_screenshots,
    (unsigned long)timing_mean_out[0], (unsigned long)timing_max_out[0],
    (unsigned long)timing_mean_out[1], (unsigned long)timing_max_out[1],
    (unsigned long)timing_mean_out[2], (unsigned long)timing_max_out[2],
    (unsigned long)timing_mean_out[3], (unsigned long)timing_max_out[3],
    (unsigned long)timing_mean_out[4], (unsigned long)timing_max_out[4],
    (unsigned long)timing_mean_out[5], (unsigned long)timing_max_out[5],
    (unsigned long)timing_mean_out[6], (unsigned long)timing_max_out[6],
    (unsigned long)timing_mean_out[7], (unsigned long)timing_max_out[7],
    (unsigned long)timing_slow_frames,
    (unsigned long)timing_gpu_late
  );
  return stats_json;
}

const char *devstats_frames(void) {
  size_t used = 0;
  frames_text[0] = '\0';
  uint32_t count = frame_ring_next < FRAME_RING ? frame_ring_next : FRAME_RING;
  for (uint32_t i = 0; i < count; i += 1) {
    const uint32_t *f = frame_ring[(frame_ring_next - count + i) % FRAME_RING];
    int n = snprintf(frames_text + used, sizeof frames_text - used, "%s%lu,%lu,%lu,%lu,%lu,%lu,%lu", i ? ";" : "",
      (unsigned long)(f[0] / 100), (unsigned long)(f[1] / 100), (unsigned long)(f[2] / 100),
      (unsigned long)(f[3] / 100), (unsigned long)(f[4] / 100), (unsigned long)(f[5] / 100),
      (unsigned long)(f[6] / 100));
    if (n < 0 || (size_t)n >= sizeof frames_text - used) break;
    used += (size_t)n;
  }
  return frames_text;
}
