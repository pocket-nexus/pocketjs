/* A native program and QuickJS realm with explicit ownership. Calls run on
 * the owning thread. Shutdown requested from a guest callback is deferred
 * until that call returns; destroy must run outside callbacks. */
#pragma once
#include "pocket_native_program.h"
typedef struct PocketQjsProgram PocketQjsProgram;
/* Host composition of one facade instance, copied at create. Zero-initialize
 * and set struct_size; a NULL member keeps the facade's own part. */
typedef struct {
  size_t struct_size;
  /* Profile facts and their 32-byte hash from the host build. NULL selects
   * the compiled pocket_host_profile.h; a build without that header defines
   * POCKET_QJS_HOST_PROFILE and supplies both. */
  const pocket_profile_facts *profile;
  const uint8_t *profile_hash;
  /* A host guest with its own context replaces the facade's QuickJS realm.
   * Its JSRuntime and JSContext belong to the host and outlive every program
   * the facade boots with it; app actions, native extensions and offload
   * belong to the facade's realm only. guest_error returns the guest's last
   * error text or NULL. */
  const pocket_guest_v1 *guest;
  void *guest_context;
  const char *(*guest_error)(void *guest_context);
  /* compose runs on each boot after the guest is attached and before Runtime
   * admits the package: it registers renderers, displays, input sources and
   * op providers through runtime and starts host services. Nonzero fails the
   * boot. release runs once before the facade destroys a program whose
   * compose ran, including after a failed compose or boot. */
  int32_t (*compose)(void *context, pocket_runtime *runtime);
  void (*release)(void *context);
  void *context;
} pocket_qjs_program_host;
PocketQjsProgram *pocket_qjs_program_create(void);
PocketQjsProgram *pocket_qjs_program_create_host(const pocket_qjs_program_host *host);
/* Each boot shuts the previous program down first. Admission failures return
 * 0 before the guest initializes; pocket_qjs_program_error names the cause.
 * Raw form: code and pack bytes are copied; density must match the profile. */
int pocket_qjs_program_boot(PocketQjsProgram *, const char *, size_t, const uint8_t *, size_t, int, int, uint32_t);
/* Complete package form (pocket_native_program_create_package): the bytes are
 * copied; output, id and title name the catalog identity. */
int pocket_qjs_program_boot_package(PocketQjsProgram *, const uint8_t *package, size_t length,
  const char *output, const char *id, const char *title, int width, int height, uint32_t density);
/* Host package source form (pocket_native_program_create_source): Runtime
 * reads the package at boot and installs its assets natively. */
int pocket_qjs_program_boot_source(PocketQjsProgram *, const pocket_package_source_v1 *source, void *source_context,
  int width, int height, uint32_t density, size_t heap_limit, size_t frame_buffer_budget);
/* The booted program's runtime for host presentation and op calls; NULL
 * before a successful boot and after shutdown. */
pocket_runtime *pocket_qjs_program_runtime(PocketQjsProgram *);
int pocket_qjs_program_advance(PocketQjsProgram *, const pocket_input_frame *, uint32_t);
void pocket_qjs_program_shutdown(PocketQjsProgram *);
void pocket_qjs_program_destroy(PocketQjsProgram *);
int pocket_qjs_program_last_touch_hit(PocketQjsProgram *);
const char *pocket_qjs_program_action_name(PocketQjsProgram *);
int pocket_qjs_program_action_value(PocketQjsProgram *);
unsigned long pocket_qjs_program_action_sequence(PocketQjsProgram *);
const char *pocket_qjs_program_error(PocketQjsProgram *);
/* Opaque top-left BGRA bytes, borrowed until the next call. */
const uint8_t *pocket_qjs_program_render(PocketQjsProgram *);
/* GL calls require the program's context to be current. */
int pocket_qjs_program_gl_initialize(PocketQjsProgram *);
uint32_t pocket_qjs_program_native_flags(PocketQjsProgram *);
int pocket_qjs_program_gl_render(PocketQjsProgram *, int, int);
void pocket_qjs_program_gl_shutdown(PocketQjsProgram *);
uint32_t pocket_qjs_program_width(PocketQjsProgram *);
uint32_t pocket_qjs_program_height(PocketQjsProgram *);
uint32_t pocket_qjs_program_stride(PocketQjsProgram *);
size_t pocket_qjs_program_length(PocketQjsProgram *);
#ifdef POCKET_OFFLOAD_POSIX
void pocket_qjs_program_offload_key(PocketQjsProgram *, const char *);
#endif
#define POCKET_BENCH_STAGE_IDLE 0
#define POCKET_BENCH_STAGE_EVAL 1
#define POCKET_BENCH_STAGE_JS 2
#define POCKET_BENCH_STAGE_JOBS 3
#define POCKET_BENCH_STAGE_TICK 4
#ifdef POCKET_RUNTIME_STAGE_HOOKS
void pocket_bench_stage(int stage);
#endif
