/* Compatibility program composition for the existing portable C hosts.
 * This is a program API, not an additional engine or driver ABI. One instance
 * owns one canonical runtime. Call on its owning thread without overlapping
 * calls; all buffers returned below expire at the next call on this program.
 * Native GL calls require the program's context to be current. */
#pragma once
#include "pocket_runtime.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct PocketNativeProgram PocketNativeProgram;
/* target is NUL-terminated. Code/pak are copied before create returns.
 * width/height are logical pixels; density controls baked resource sampling.
 * No guest or GL context is created here. Register a guest and optional op
 * providers through runtime() before boot(). */
PocketNativeProgram *pocket_native_program_create(const char *target, uint32_t host_abi,
  const uint8_t *code, size_t code_length, const uint8_t *pak, size_t pak_length,
  uint32_t width, uint32_t height, uint32_t density, uint32_t physics);
/* Catalog guests retain their original .pocket bytes and plan. Identity and
 * declared viewport must match the catalog; physics is a host permission,
 * while the package plan decides whether its methods mount. Runtime performs
 * package admission before guest initialization. Initial viewport uses the
 * package declaration; live-window hosts resize before their first frame. */
PocketNativeProgram *pocket_native_program_create_package(const char *target, uint32_t host_abi,
  const uint8_t *package, size_t package_length,
  const char *output, const char *id, const char *title,
  uint32_t width, uint32_t height, uint32_t density, uint32_t physics);
pocket_runtime *pocket_native_program_runtime(PocketNativeProgram *program);
/* Status codes are canonical POCKET_STATUS_* values (zero is success).
 * boot evaluates without submitting a presentation. advance copies canonical
 * input facts, invokes the guest once, then advances 1..60 core ticks. A prior
 * unpresented turn can be abandoned by the program's next advance. */
int32_t pocket_native_program_boot(PocketNativeProgram *program);
int32_t pocket_native_program_advance(PocketNativeProgram *program,
  const pocket_input_frame *input, uint32_t core_ticks);
int32_t pocket_native_program_collect(PocketNativeProgram *program);
/* GPU programs can change logical viewport between turns. The host updates
 * script metadata in its guest collect callback after this succeeds. */
int32_t pocket_native_program_resize_viewport(PocketNativeProgram *program,
  uint32_t width, uint32_t height);
/* Software builds expose an ARGB8888 word buffer after a synchronous frame. */
const uint8_t *pocket_native_program_render_argb(PocketNativeProgram *program);
uint32_t pocket_native_program_width(const PocketNativeProgram *program);
uint32_t pocket_native_program_height(const PocketNativeProgram *program);
uint32_t pocket_native_program_stride(const PocketNativeProgram *program);
size_t pocket_native_program_length(const PocketNativeProgram *program);
/* GL instances are initialized after guest boot, when the host context exists.
 * over != 0 preserves native geometry recorded before the UI submission.
 * Each render returns only after the GPU reaches a terminal state. */
void pocket_native_program_set_gl_trace(PocketNativeProgram *program,
  void (*trace)(uint32_t stage, uint32_t commands, uint32_t vertices));
int32_t pocket_native_program_gl_initialize(PocketNativeProgram *program);
int32_t pocket_native_program_gl_render(PocketNativeProgram *program,
  uint32_t width, uint32_t height, uint32_t over);
int32_t pocket_native_program_gl_render_rect(PocketNativeProgram *program,
  int32_t x, int32_t y, uint32_t target_width, uint32_t target_height,
  uint32_t window_width, uint32_t window_height, uint32_t over);
void pocket_native_program_gl_reset(PocketNativeProgram *program);
void pocket_native_program_gl_shutdown(PocketNativeProgram *program);
uint64_t pocket_native_program_damage_attempts(const PocketNativeProgram *program);
uint64_t pocket_native_program_damage_failures(const PocketNativeProgram *program);
uint64_t pocket_native_program_damage_full_redraws(const PocketNativeProgram *program);
uint64_t pocket_native_program_damage_pixels(const PocketNativeProgram *program);
int32_t pocket_native_program_damage_bounds(const PocketNativeProgram *program, int32_t *bounds_xyxy);
/* Destroy with a current GL context, or after gl_shutdown already retired it. */
void pocket_native_program_destroy(PocketNativeProgram *program);
#ifdef __cplusplus
}
#endif
