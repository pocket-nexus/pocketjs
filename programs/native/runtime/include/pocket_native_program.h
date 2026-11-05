/* Native program composition for C hosts.
 * This is a program API, not an additional engine or driver ABI. One instance
 * owns one canonical runtime. Call on its owning thread without overlapping
 * calls; all buffers returned below expire at the next call on this program.
 * Native GL calls require the program's context to be current. */
#pragma once
#include "pocket_runtime.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct {
  const uint8_t *javascript;
  size_t javascript_length;
  const uint8_t *pak;
  size_t pak_length;
  const uint8_t *plan;
  size_t plan_length;
  uint64_t package_hash;
  uint32_t view_width;
  uint32_t view_height;
  uint32_t raster_density;
  uint32_t features; /* POCKET_NATIVE_PACKAGE_* */
} PocketNativePackage;

#define POCKET_NATIVE_PACKAGE_PHYSICS 1u    /* features["ui.physics"] */
#define POCKET_NATIVE_PACKAGE_OFFLOAD 2u    /* features["io.offload"] */
#define POCKET_NATIVE_PACKAGE_COMPANIONS 4u /* companions is not empty */

/* Returns the POCKET_PACKAGE_OPEN_* codes of pocket_runtime.h.
 * POCKET_PACKAGE_OPEN_OK = admitted: footer hash, the first variant the
 * exported profile facts admit (binding generation, raster density,
 * animation, rate, viewport, presentation, capabilities, auxiliary surface),
 * identity, plan and NUL-terminated JS. BAD_ARGUMENT for a null or empty
 * argument; PLAN_JSON, PLAN_VIEWPORT or PLAN_AUXILIARY for a plan whose JSON,
 * viewport or auxiliary surface cannot be read after admission: one table
 * with the 3DS product's pocket_package_open and the ESP-IDF archive's
 * pocket_idf_package_open. profile_hash is null or the host profile SHA-256
 * (32 readable bytes); it only orders variants. */
int32_t pocket_native_package_open(
  const uint8_t *bytes,
  size_t length,
  const pocket_profile_facts *facts,
  uint32_t host_abi,
  const uint8_t *profile_hash,
  PocketNativePackage *out
);


typedef struct PocketNativeProgram PocketNativeProgram;
/* Constructors require host_abi == POCKET_BINDING_GENERATION; packages also
 * match the independently supplied profile hash. Each build registers its
 * outputs at create: the CPU ARGB buffer (std or software-only), the GLES 1.1
 * renderer (gles1) or the GLES 2 renderer. host-backend builds register none;
 * the host adds its renderer and displays through runtime() before boot. */
/* target is NUL-terminated. Code/pak are copied before create returns.
 * width/height are logical pixels; density controls baked resource sampling.
 * No guest or GL context is created here. Register a guest and optional op
 * providers through runtime() before boot(). This form admits the one
 * width x height viewport at 60 Hz under the all-zero profile hash. */
PocketNativeProgram *pocket_native_program_create(const char *target, uint32_t host_abi,
  const uint8_t *code, size_t code_length, const uint8_t *pak, size_t pak_length,
  uint32_t width, uint32_t height, uint32_t density, uint32_t physics);
/* Build-profile form: profile and profile_hash are pocket_profile.facts and
 * pocket_profile.profile_hash from the host build's exported profile header.
 * The facts are copied before create returns; their id must equal target and
 * their raster density must equal density. */
PocketNativeProgram *pocket_native_program_create_profile(const char *target, uint32_t host_abi,
  const uint8_t *code, size_t code_length, const uint8_t *pak, size_t pak_length,
  uint32_t width, uint32_t height, uint32_t density, uint32_t physics,
  const pocket_profile_facts *profile, const uint8_t profile_hash[32]);
/* Catalog guests retain their original .pocket bytes and plan. Identity and
 * declared viewport must match the catalog; physics is a host permission,
 * while the package plan decides whether its methods mount. Runtime performs
 * package admission against the supplied host profile before guest initialization.
 * Profile facts/hash must come from the host build, never this package. Initial viewport uses the
 * package declaration; live-window hosts resize before their first frame.
 * Builds with a built-in output reject a plan with an auxiliary surface here;
 * host-backend builds leave it to boot, which requires a registered
 * auxiliary display when the profile has one. */
PocketNativeProgram *pocket_native_program_create_package(const char *target, uint32_t host_abi,
  const uint8_t *package, size_t package_length,
  const char *output, const char *id, const char *title,
  uint32_t width, uint32_t height, uint32_t density, uint32_t physics,
  const pocket_profile_facts *profile, const uint8_t profile_hash[32]);
/* Host package source form: Runtime reads and admits the package from source
 * at boot, before guest initialization, against profile and profile_hash
 * (rules of create_profile). Native asset loading stays on, so the guest
 * receives the pak's named textures and sprites. source and context outlive
 * the program. The plan decides physics within the profile's capabilities.
 * heap_limit and frame_buffer_budget of zero keep the defaults of the other
 * forms: a 128 MiB guest heap, and width * height * 4 bytes plus 4 bytes per
 * pixel of the profile's auxiliary panel. */
PocketNativeProgram *pocket_native_program_create_source(const char *target, uint32_t host_abi,
  const pocket_package_source_v1 *source, void *context,
  uint32_t width, uint32_t height, uint32_t density,
  size_t heap_limit, size_t frame_buffer_budget,
  const pocket_profile_facts *profile, const uint8_t profile_hash[32]);
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
