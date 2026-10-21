#ifndef POCKETJS_QUICKJS_C_RUNTIME_H
#define POCKETJS_QUICKJS_C_RUNTIME_H

#include <stddef.h>
#include <stdint.h>

/*
 * Stage ids delivered to pocket_bench_stage() when pocket_runtime.c is
 * compiled with POCKET_RUNTIME_STAGE_HOOKS. Production hosts do not define
 * that switch, so the calls compile away.
 */
#define POCKET_BENCH_STAGE_IDLE 0
#define POCKET_BENCH_STAGE_EVAL 1
#define POCKET_BENCH_STAGE_JS 2
#define POCKET_BENCH_STAGE_JOBS 3
#define POCKET_BENCH_STAGE_TICK 4

#if defined(POCKET_RUNTIME_STAGE_HOOKS)
void pocket_bench_stage(int stage);
#endif

#ifdef POCKET_OFFLOAD_POSIX
void pocket_legacy_runtime_offload_key(const char *path);
#endif

/* Raster density for the next pocket_legacy_runtime_boot (default: the build's
 * POCKET_RASTER_DENSITY). */
void pocket_legacy_runtime_set_raster_density(uint32_t density);
int pocket_legacy_runtime_boot(
  const char *java_script,
  size_t java_script_length,
  const uint8_t *pack,
  size_t pack_length,
  int width,
  int height
);
/* Code and pack bytes are copied during boot. */
/*
 * One guest turn followed by exactly one core tick — the frame contract
 * (docs/RUNTIMES.md, law 3). Hosts call it once per presented frame with the
 * portable button mask (pocket_spec.h) and the sampled touch contact in
 * logical pixels; `touch_hit` is retained for source compatibility. Runtime resolves bounds
 * hits from its own tree at the contact down edge.
 */
typedef struct {
  uint32_t buttons;
  int touch_down;
  int touch_x;
  int touch_y;
  int touch_hit;
} PocketRuntimeInput;
int pocket_legacy_runtime_tick(const PocketRuntimeInput *input);

/*
 * Multi-contact frame entry. `id` is a host-owned contact identity (0-255, stable
 * while the finger stays down, reusable after release), `x`/`y` are logical
 * pixels, and `hit` is retained for source compatibility; Runtime resolves it at the
 * contact down edge. Contacts pack into the
 * frame() wire words — legacy x:9/y:9/id:8 below 512 logical pixels, the
 * wide bit-31 form above — so a single id-0 contact is byte-identical to the
 * single-touch entry points and every existing tape. The guest snapshot caps
 * at eight active contacts, plus eight terminal cancellations (framework/src/touch.ts).
 */
#include "../../../engine/runtime/include/pocket/compat/input_types.h"
int pocket_legacy_runtime_tick_contacts(const PocketRuntimeContactsInput *input);
int pocket_legacy_runtime_frame_contacts(
  const PocketRuntimeContactsInput *input,
  unsigned int tick_count
);

/*
 * Legacy frame entry points for the original iPhone host, which presents at
 * 30 Hz and advances two core ticks per guest turn, and for the Windows CE
 * host's tick-count form. They pass an empty button mask. New hosts call
 * pocket_legacy_runtime_tick.
 */
int pocket_legacy_runtime_frame(int touch_down, int touch_x, int touch_y, int touch_hit);
int pocket_legacy_runtime_frame_ticks(
  int touch_down,
  int touch_x,
  int touch_y,
  int touch_hit,
  unsigned int tick_count
);
#if defined(POCKET_RUNTIME_HARNESS)
/*
 * Bind a global harness dispatcher function in the live guest realm, then call
 * it with two int32 arguments. The result is converted to int32 when `out` is
 * non-NULL. Neither operation drains jobs or emits a stage callback; the
 * embedding owns attribution for synchronous work and queued jobs.
 */
int pocket_legacy_runtime_harness_bind(const char *global_function);
int pocket_legacy_runtime_harness_call(int32_t opcode, int32_t argument, int32_t *out);
#endif
/* Diagnostic hit from Runtime's most recent active contact. */
int pocket_legacy_runtime_last_touch_hit(void);
int pocket_legacy_runtime_hit_test(float x, float y);
int pocket_legacy_runtime_hit_test_bounds(float x, float y);
const char *pocket_legacy_runtime_action_name(void);
int pocket_legacy_runtime_action_value(void);
unsigned long pocket_legacy_runtime_action_sequence(void);
const uint8_t *pocket_legacy_runtime_render(void);
/*
 * Rendered pixels are opaque top-left BGRA bytes (ARGB32 words). The pointer
 * remains valid only until the next render, viewport change, or shutdown.
 */

/*
 * Damage statistics for the software raster path, and the most recent plan's
 * bounds so the host can scope its composite. `bounds` receives x0,y0,x1,y1 in
 * logical pixels, top-left origin; the return is zero when nothing changed.
 */
unsigned long pocket_legacy_runtime_damage_attempts(void);
unsigned long pocket_legacy_runtime_damage_failures(void);
unsigned long pocket_legacy_runtime_damage_full_redraws(void);
unsigned long pocket_legacy_runtime_damage_pixels(void);
int pocket_legacy_runtime_damage_bounds(int *bounds);

/*
 * Hardware path. `pocket_legacy_runtime_gl_initialize` needs a current OpenGL ES
 * context matching the core backend selected at compile time and returns zero
 * if the GPU pipeline cannot be established.
 * `pocket_legacy_runtime_gl_render` draws the current retained tree into the bound
 * framebuffer; the CPU never rasterizes a pixel on this path.
 */
int pocket_legacy_runtime_gl_initialize(void);
/* Native extension flags: bit 0 requests a depth attachment. */
uint32_t pocket_legacy_runtime_native_flags(void);
void pocket_legacy_runtime_gl_set_trace(void (*callback)(uint32_t, uint32_t, uint32_t));
void pocket_legacy_runtime_gl_reset(void);
int pocket_legacy_runtime_gl_render(int width, int height);
void pocket_legacy_runtime_gl_shutdown(void);

uint32_t pocket_legacy_runtime_width(void);
uint32_t pocket_legacy_runtime_height(void);
uint32_t pocket_legacy_runtime_stride(void);
size_t pocket_legacy_runtime_length(void);
const char *pocket_legacy_runtime_error(void);
void pocket_legacy_runtime_shutdown(void);

#endif
