/* A native program and QuickJS realm with explicit ownership. Calls run on
 * the owning thread. Shutdown requested from a guest callback is deferred
 * until that call returns; destroy must run outside callbacks. */
#pragma once
#include "pocket_native_program.h"
typedef struct PocketQjsProgram PocketQjsProgram;
PocketQjsProgram *pocket_qjs_program_create(void);
/* Code and pack bytes are copied. density must match the compiled profile. */
int pocket_qjs_program_boot(PocketQjsProgram *, const char *, size_t, const uint8_t *, size_t, int, int, uint32_t);
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
