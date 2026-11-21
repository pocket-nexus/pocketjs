/* Portable host composition. UI coercion and numbered operations are owned by
 * guest-quickjs; package, input, core ticks and presentation belong to Runtime.
 * A host composition (pocket_qjs_program_host) replaces the facade's guest,
 * profile or outputs; the facade keeps the program's lifetime and error state. */
#include "pocket_qjs_program.h"
#include "pocket_guest_quickjs.h"
#include "pocket_native_program.h"
#include "pocket_spec.h"
#include <stdio.h>
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#ifdef POCKET_RUNTIME_EXTENSION
#include "pocket_native_extension.h"
#endif
#ifdef POCKET_SVC_WIRE
#include "svcwire.h"
#endif
#ifndef POCKETJS_TARGET_ID
#error "POCKETJS_TARGET_ID must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKETJS_HOST_ABI
#error "POCKETJS_HOST_ABI must come from the verified ResolvedBuildPlan"
#elif POCKETJS_HOST_ABI != POCKET_BINDING_GENERATION
#error "POCKETJS_HOST_ABI must match POCKET_BINDING_GENERATION"
#endif
#if !defined(POCKET_COMPILED_PROFILE_H) && !defined(POCKET_QJS_HOST_PROFILE)
#error "pocket_host_profile.h must come from the independent host build profile, or the host passes its profile in pocket_qjs_program_host (POCKET_QJS_HOST_PROFILE)"
#endif
#if defined(POCKET_RUNTIME_STAGE_HOOKS)
#define BENCH_STAGE(stage) pocket_bench_stage(stage)
static void profile_phase(void *unused, pocket_qjs_phase phase) {
  (void)unused;
  BENCH_STAGE((int)phase);
}
#else
#define BENCH_STAGE(stage) ((void)(stage))
#endif
#define POCKETJS_ACTION_NAME_CAPACITY 64
struct PocketQjsProgram {
  pocket_qjs_program_host host;
  /* The host's compose hook ran for the current program; release is owed. */
  int composed;
  PocketNativeProgram *program;
  pocket_guest_quickjs *guest;
  JSRuntime *runtime;
  JSContext *context;
  JSValue global;
  char last_error[512], reported_action_name[POCKETJS_ACTION_NAME_CAPACITY];
  int32_t reported_action_value;
  unsigned long reported_action_sequence;
  int runtime_failed, busy, shutdown_requested, last_touch_hit;
#ifdef POCKET_RUNTIME_EXTENSION
  const PocketNativeExtensionV1 *native_extension;
  int native_gl_current;
#endif
#ifdef POCKET_SVC_WIRE
  char svc_poll_buffer[8193];
#endif
#ifdef POCKET_OFFLOAD_POSIX
  unsigned offload_submissions, offload_deliveries, offload_uploads;
  char offload_key_path[1024];
  uint8_t offload_pixels[512 * 16 * 4];
#endif
};
/* Function data belongs to this realm; native extensions may use context opaque. */
static PocketQjsProgram *callback_program(JSContext *ctx, JSValue *data) {
  size_t length = 0;
  const uint8_t *bytes = JS_GetArrayBuffer(ctx, &length, data[0]);
  PocketQjsProgram *s = NULL;
  if (bytes && length == sizeof s) memcpy(&s, bytes, sizeof s);
  return s;
}
static JSValue program_callback(PocketQjsProgram *s, JSCFunctionData *callback, int argc, int magic) {
  JSValue data = JS_NewArrayBufferCopy(s->context, (const uint8_t *)&s, sizeof s);
  if (JS_IsException(data)) return data;
  JSValue function = JS_NewCFunctionData(s->context, callback, argc, magic, 1, &data);
  JS_FreeValue(s->context, data);
  return function;
}
#ifdef POCKET_OFFLOAD_POSIX
#include "offload_qjs.h"
#endif
PocketQjsProgram *pocket_qjs_program_create_host(const pocket_qjs_program_host *host) {
  if (host && (host->struct_size < sizeof(size_t) || (host->profile && !host->profile_hash))) return NULL;
  PocketQjsProgram *s = calloc(1, sizeof *s);
  if (!s) return NULL;
  s->global = JS_UNDEFINED;
  if (host) memcpy(&s->host, host, host->struct_size < sizeof s->host ? host->struct_size : sizeof s->host);
  s->host.struct_size = sizeof s->host;
  return s;
}
PocketQjsProgram *pocket_qjs_program_create(void) { return pocket_qjs_program_create_host(NULL); }
static void set_error(PocketQjsProgram *s, const char *message) {
  snprintf(s->last_error, sizeof s->last_error, "%s", message ? message : "");
}
static void take_exception(PocketQjsProgram *s, JSContext *ctx) {
  JSValue exception = JS_GetException(ctx);
  const char *message = JS_ToCString(ctx, exception);
  set_error(s, message ? message : "QuickJS exception");
  if (message) JS_FreeCString(ctx, message);
  JS_FreeValue(ctx, exception);
}
static void guest_error(PocketQjsProgram *s) {
  if (!s->last_error[0]) {
    const char *message = s->host.guest
      ? (s->host.guest_error ? s->host.guest_error(s->host.guest_context) : NULL)
      : (s->guest ? pocket_guest_quickjs_error(s->guest) : NULL);
    set_error(s, message && message[0] ? message : "PocketJS runtime operation failed");
  }
}
/* A program exists only after a successful boot: failures destroy it. */
static int ready(PocketQjsProgram *s) { return s && s->program && !s->runtime_failed; }
static int valid_action_name(const char *name, size_t length) {
  if (!length || length >= POCKETJS_ACTION_NAME_CAPACITY || name[0] < 'a' || name[0] > 'z') return 0;
  for (size_t i = 1; i < length; i++) {
    char value = name[i];
    if ((value < 'a' || value > 'z') && (value < '0' || value > '9') && value != '_' && value != '.' && value != '-') return 0;
  }
  return 1;
}
static JSValue report_action(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int magic, JSValue *data) {
  (void)self;
  (void)magic;
  PocketQjsProgram *s = callback_program(ctx, data);
  if (!s) return JS_ThrowInternalError(ctx, "missing program callback state");
  if (argc < 2) return JS_ThrowTypeError(ctx, "missing app action arguments");
  size_t length = 0;
  const char *name = JS_ToCStringLen(ctx, &length, argv[0]);
  if (!name) return JS_EXCEPTION;
  int32_t value;
  if (JS_ToInt32(ctx, &value, argv[1]) < 0) { JS_FreeCString(ctx, name); return JS_EXCEPTION; }
  if (!valid_action_name(name, length)) { JS_FreeCString(ctx, name); return JS_ThrowRangeError(ctx, "invalid PocketJS app action name"); }
  memcpy(s->reported_action_name, name, length); s->reported_action_name[length] = 0;
  s->reported_action_value = value; s->reported_action_sequence++;
  JS_FreeCString(ctx, name);
  return JS_UNDEFINED;
}
static int32_t guest_initialize(void *opaque, pocket_runtime *handle, const pocket_guest_environment *env) {
  PocketQjsProgram *s = opaque;
  if (env->heap_limit) JS_SetMemoryLimit(s->runtime, env->heap_limit);
  if (pocket_guest_quickjs_vtable()->initialize(s->guest, handle, env)) return -1;
  JSValue ui = JS_GetPropertyStr(s->context, s->global, "ui");
  int status = JS_SetPropertyStr(s->context, ui, "__reportAppAction", program_callback(s, report_action, 2, 0));
  JS_FreeValue(s->context, ui);
  if (status < 0) { take_exception(s, s->context); return -1; }
#ifdef POCKET_OFFLOAD_POSIX
  if (!install_offload(s, s->context, s->global)) { take_exception(s, s->context); return -1; }
#endif
#ifdef POCKET_RUNTIME_EXTENSION
  const PocketNativeExtensionV1 *candidate = pocket_native_extension_v1();
  if (!candidate || candidate->abi_version != 1 || candidate->struct_size < sizeof *candidate) {
    set_error(s, "Native extension ABI mismatch"); return -1;
  }
  s->native_extension = candidate;
  if (candidate->boot && !candidate->boot(s->context, env->pak, env->pak_length, (int32_t)env->viewport_width, (int32_t)env->viewport_height)) {
    set_error(s, "Native extension boot failed"); return -1;
  }
#endif
  return 0;
}
static int32_t guest_evaluate(void *opaque, pocket_runtime *handle, const uint8_t *code, size_t length) {
  PocketQjsProgram *s = opaque;
  if (pocket_guest_quickjs_vtable()->evaluate(s->guest, handle, code, length)) return -1;
  JSValue function = JS_GetPropertyStr(s->context, s->global, "frame");
  int valid = JS_IsFunction(s->context, function);
  if (JS_IsException(function)) take_exception(s, s->context);
  else if (!valid) set_error(s, "app.js did not install globalThis.frame");
  JS_FreeValue(s->context, function);
  if (!valid) return -1;
  return 0;
}
static int32_t guest_frame(void *opaque, const pocket_guest_frame *input) {
  PocketQjsProgram *s = opaque;
#ifdef POCKET_OFFLOAD_POSIX
  s->offload_submissions = s->offload_deliveries = s->offload_uploads = 0;
#endif
#ifdef POCKET_SVC_WIRE
  svcwire_pump();
#endif
#ifdef POCKET_RUNTIME_EXTENSION
  if (s->native_extension && s->native_extension->before_guest && !s->native_extension->before_guest(s->context, input->buttons, input->analog, 0)) {
    set_error(s, "Native extension frame failed"); return -1;
  }
#endif
  for (size_t i = 0; i < input->touch_count; i++) {
    if (!(input->touches[i] & 0x40000000U)) s->last_touch_hit = input->hits[i];
  }
  if (pocket_guest_quickjs_vtable()->frame(s->guest, input)) return -1;
  BENCH_STAGE(POCKET_BENCH_STAGE_TICK);
#ifdef POCKET_RUNTIME_EXTENSION
  if (s->native_extension && s->native_extension->after_guest && !s->native_extension->after_guest(s->context)) {
    set_error(s, "Native extension commands failed"); return -1;
  }
#endif
  return 0;
}
static int32_t guest_collect(void *opaque) { PocketQjsProgram *s = opaque; return pocket_guest_quickjs_vtable()->collect(s->guest); }
static void guest_shutdown(void *opaque) {
  PocketQjsProgram *s = opaque;
#ifdef POCKET_RUNTIME_EXTENSION
  if (s->native_extension && s->native_extension->shutdown) s->native_extension->shutdown(s->native_gl_current);
  s->native_extension = NULL;
#endif
  pocket_guest_quickjs_vtable()->shutdown(s->guest);
}
static const pocket_guest_v1 guest_table = {
  sizeof(pocket_guest_v1), guest_evaluate, guest_frame, guest_collect, guest_shutdown, guest_initialize, NULL
};
#ifdef POCKET_SVC_WIRE
static int32_t service_dispatch(void *opaque, uint16_t op, const pocket_op_arg *args, size_t length, pocket_result *out) {
  PocketQjsProgram *s = opaque;
  out->tag = POCKET_RESULT_NONE;
  if (op == 31) {
    if (length) return POCKET_STATUS_INVALID;
    size_t count = svcwire_recv_lines(s->svc_poll_buffer, sizeof s->svc_poll_buffer);
    if (count) { out->tag = POCKET_RESULT_BYTES; out->bytes = (const uint8_t *)s->svc_poll_buffer; out->byte_length = count; }
    return POCKET_STATUS_OK;
  }
  if (length != sizeof *args || args->struct_size != sizeof *args || args->tag != POCKET_ARG_BYTES) return POCKET_STATUS_INVALID;
  if (op == 30) {
    if (args->byte_length == SIZE_MAX) return POCKET_STATUS_INVALID;
    char *name = malloc(args->byte_length + 1);
    if (!name) return POCKET_STATUS_FAILED;
    if (args->byte_length) memcpy(name, args->bytes, args->byte_length);
    name[args->byte_length] = 0;
    out->tag = POCKET_RESULT_I64; out->integer = svcwire_open(name);
    free(name);
  } else if (op == 32) svcwire_send_line((const char *)args->bytes, args->byte_length);
  else return POCKET_STATUS_UNSUPPORTED;
  return POCKET_STATUS_OK;
}
static const pocket_op_provider_v1 service_table = { sizeof(pocket_op_provider_v1), service_dispatch };
#endif
static void shutdown_now(PocketQjsProgram *s) {
#ifdef POCKET_OFFLOAD_POSIX
  pocket_offload_stop();
#endif
  /* The host stops what its compose hook started while the program and its
   * outputs are still live. */
  if (s->composed) {
    s->composed = 0;
    if (s->host.release) s->host.release(s->host.context);
  }
  /* Runtime shuts the attached guest down before releasing its package. */
  if (s->program) pocket_native_program_destroy(s->program);
  s->program = NULL;
  if (s->guest) pocket_guest_quickjs_destroy(s->guest);
  s->guest = NULL;
  if (s->context) {
    if (!JS_IsUndefined(s->global)) JS_FreeValue(s->context, s->global);
    JS_FreeContext(s->context);
  }
  if (s->runtime) JS_FreeRuntime(s->runtime);
  s->context = NULL; s->runtime = NULL; s->global = JS_UNDEFINED;
#ifdef POCKET_RUNTIME_EXTENSION
  s->native_gl_current = 0; s->native_extension = NULL;
#endif
  s->runtime_failed = 0; s->shutdown_requested = 0;
}
static int leave(PocketQjsProgram *s, int success) {
  if (s->shutdown_requested) { shutdown_now(s); s->busy = 0; return 0; }
  s->busy = 0;
  return success;
}
void pocket_qjs_program_shutdown(PocketQjsProgram *s) {
  if (!s) return;
  if (s->busy) { s->shutdown_requested = 1; return; }
  s->busy = 1; shutdown_now(s); s->busy = 0;
}
/* What the program's runtime reads at boot: raw code and pak, a complete
 * package, or the host's package source. */
typedef struct {
  enum { PAYLOAD_CODE, PAYLOAD_PACKAGE, PAYLOAD_SOURCE } kind;
  const uint8_t *code, *pak, *package;
  size_t code_length, pak_length, package_length;
  const char *output, *id, *title;
  const pocket_package_source_v1 *source;
  void *source_context;
  size_t heap_limit, frame_buffer_budget;
} payload;
static PocketNativeProgram *create_program(PocketQjsProgram *s, const payload *p, uint32_t width, uint32_t height, uint32_t density) {
  const pocket_profile_facts *facts = s->host.profile;
  const uint8_t *hash = s->host.profile_hash;
#ifdef POCKET_COMPILED_PROFILE_H
  if (!facts) { facts = pocket_profile.facts; hash = pocket_profile.profile_hash; }
#endif
  if (!facts || !hash) { set_error(s, "PocketJS host profile is missing"); return NULL; }
  const uint32_t physics =
#ifdef POCKET_PHYSICS
    1;
#else
    0;
#endif
  if (p->kind == PAYLOAD_SOURCE)
    return pocket_native_program_create_source(POCKETJS_TARGET_ID, POCKETJS_HOST_ABI, p->source, p->source_context,
      width, height, density, p->heap_limit, p->frame_buffer_budget, facts, hash);
  if (p->kind == PAYLOAD_PACKAGE)
    return pocket_native_program_create_package(POCKETJS_TARGET_ID, POCKETJS_HOST_ABI, p->package, p->package_length,
      p->output, p->id, p->title, width, height, density, physics, facts, hash);
  return pocket_native_program_create_profile(POCKETJS_TARGET_ID, POCKETJS_HOST_ABI, p->code, p->code_length, p->pak, p->pak_length,
    width, height, density, physics, facts, hash);
}
static int boot(PocketQjsProgram *s, const payload *p, int width, int height, uint32_t density) {
  if (!s || s->busy) return 0;
  s->busy = 1; shutdown_now(s); s->last_error[0] = 0;
  s->reported_action_name[0] = 0; s->reported_action_value = 0; s->reported_action_sequence = 0; s->last_touch_hit = 0;
  if (width <= 0 || height <= 0) { set_error(s, "invalid viewport"); goto failed; }
  s->program = create_program(s, p, (uint32_t)width, (uint32_t)height, density);
  if (!s->program) {
    if (!s->last_error[0]) set_error(s, "PocketJS program allocation or configuration failed");
    goto failed;
  }
  /* A host guest owns its realm; the facade's guest gets one of its own. */
  if (!s->host.guest) {
    s->runtime = JS_NewRuntime();
    if (!s->runtime) { set_error(s, "QuickJS runtime allocation failed"); goto failed; }
    JS_SetMaxStackSize(s->runtime, 256 * 1024);
    s->context = JS_NewContext(s->runtime);
    if (!s->context) { set_error(s, "QuickJS context allocation failed"); goto failed; }
    s->global = JS_GetGlobalObject(s->context);
    s->guest = pocket_guest_quickjs_attach(s->context, POCKET_QJS_CANONICAL);
    if (!s->guest) { set_error(s, "QuickJS adapter allocation failed"); goto failed; }
#if defined(POCKET_RUNTIME_STAGE_HOOKS)
    if (pocket_guest_quickjs_set_phase_hook(s->guest, profile_phase, NULL)) goto failed;
#endif
  }
  pocket_runtime *handle = pocket_native_program_runtime(s->program);
#ifdef POCKET_SVC_WIRE
  const uint16_t service_ops[] = {30, 31, 32};
  if (pocket_runtime_add_op_provider(handle, &service_table, s, service_ops, 3)) goto failed;
#endif
  if (s->host.guest ? pocket_runtime_set_guest(handle, s->host.guest, s->host.guest_context)
                    : pocket_runtime_set_guest(handle, &guest_table, s)) {
    guest_error(s); goto failed;
  }
  if (s->host.compose) {
    s->composed = 1;
    if (s->host.compose(s->host.context, handle)) { set_error(s, "PocketJS host composition failed"); goto failed; }
  }
  if (pocket_native_program_boot(s->program)) { guest_error(s); goto failed; }
  return leave(s, 1);
failed:
  if (!s->last_error[0]) set_error(s, "PocketJS boot failed");
  shutdown_now(s); BENCH_STAGE(POCKET_BENCH_STAGE_IDLE); return leave(s, 0);
}
int pocket_qjs_program_boot(PocketQjsProgram *s, const char *code, size_t length, const uint8_t *pak, size_t pak_length, int width, int height, uint32_t density) {
  payload p = {0};
  p.kind = PAYLOAD_CODE;
  p.code = (const uint8_t *)code; p.code_length = length; p.pak = pak; p.pak_length = pak_length;
  return boot(s, &p, width, height, density);
}
int pocket_qjs_program_boot_package(PocketQjsProgram *s, const uint8_t *package, size_t length, const char *output, const char *id, const char *title, int width, int height, uint32_t density) {
  payload p = {0};
  p.kind = PAYLOAD_PACKAGE;
  p.package = package; p.package_length = length; p.output = output; p.id = id; p.title = title;
  return boot(s, &p, width, height, density);
}
int pocket_qjs_program_boot_source(PocketQjsProgram *s, const pocket_package_source_v1 *source, void *source_context, int width, int height, uint32_t density, size_t heap_limit, size_t frame_buffer_budget) {
  payload p = {0};
  p.kind = PAYLOAD_SOURCE;
  p.source = source; p.source_context = source_context; p.heap_limit = heap_limit; p.frame_buffer_budget = frame_buffer_budget;
  return boot(s, &p, width, height, density);
}
pocket_runtime *pocket_qjs_program_runtime(PocketQjsProgram *s) { return s && s->program ? pocket_native_program_runtime(s->program) : NULL; }
int pocket_qjs_program_advance(PocketQjsProgram *s, const pocket_input_frame *input, uint32_t ticks) {
  if (!s || s->busy || !ready(s) || !input || !ticks || ticks > 60) return 0;
  s->busy = 1;
  s->last_error[0] = 0;
  int status = pocket_native_program_advance(s->program, input, ticks);
  BENCH_STAGE(POCKET_BENCH_STAGE_IDLE);
  if (status) { guest_error(s); s->runtime_failed = 1; }
  return leave(s, status == 0);
}
int pocket_qjs_program_last_touch_hit(PocketQjsProgram *s) { return s ? s->last_touch_hit : 0; }
const char *pocket_qjs_program_action_name(PocketQjsProgram *s) { return s ? s->reported_action_name : ""; }
int pocket_qjs_program_action_value(PocketQjsProgram *s) { return s ? s->reported_action_value : 0; }
unsigned long pocket_qjs_program_action_sequence(PocketQjsProgram *s) { return s ? s->reported_action_sequence : 0; }
const char *pocket_qjs_program_error(PocketQjsProgram *s) { return s ? s->last_error : "program is not allocated"; }
const uint8_t *pocket_qjs_program_render(PocketQjsProgram *s) {
  if (!s || s->busy || !ready(s)) return NULL;
  s->busy = 1;
  const uint8_t *pixels = pocket_native_program_render_argb(s->program);
  if (!pixels) guest_error(s);
  return leave(s, pixels != NULL) ? pixels : NULL;
}
int pocket_qjs_program_gl_initialize(PocketQjsProgram *s) {
  if (!s || s->busy || !ready(s)) return 0;
  s->busy = 1;
#ifdef POCKET_RUNTIME_EXTENSION
  s->native_gl_current = 1;
#endif
  return leave(s, pocket_native_program_gl_initialize(s->program) == 0);
}
int pocket_qjs_program_gl_render(PocketQjsProgram *s, int width, int height) {
  if (!s || s->busy || !ready(s) || width <= 0 || height <= 0) return 0;
  s->busy = 1; uint32_t over = 0;
#ifdef POCKET_RUNTIME_EXTENSION
  if (s->native_extension && s->native_extension->render) {
    if (!s->native_extension->render(0, 0, width, height, width, height)) return leave(s, 0);
    over = 1;
  }
#endif
  return leave(s, pocket_native_program_gl_render(s->program, (uint32_t)width, (uint32_t)height, over) == 0);
}
void pocket_qjs_program_gl_shutdown(PocketQjsProgram *s) {
  if (!s || s->busy || !s->program) return;
  s->busy = 1;
#ifdef POCKET_RUNTIME_EXTENSION
  if (s->native_extension && s->native_extension->struct_size >= sizeof(PocketNativeGraphicsExtensionV1)) {
    const PocketNativeGraphicsExtensionV1 *graphics = (const PocketNativeGraphicsExtensionV1 *)s->native_extension;
    if (graphics->release_graphics) graphics->release_graphics(s->native_gl_current);
  }
  s->native_gl_current = 0;
#endif
  pocket_native_program_gl_shutdown(s->program); (void)leave(s, 1);
}
uint32_t pocket_qjs_program_native_flags(PocketQjsProgram *s) {
#ifdef POCKET_RUNTIME_EXTENSION
  return s && s->native_extension ? s->native_extension->flags : 0;
#else
  (void)s;
  return 0;
#endif
}
uint32_t pocket_qjs_program_width(PocketQjsProgram *s) { return ready(s) ? pocket_native_program_width(s->program) : 0; }
uint32_t pocket_qjs_program_height(PocketQjsProgram *s) { return ready(s) ? pocket_native_program_height(s->program) : 0; }
uint32_t pocket_qjs_program_stride(PocketQjsProgram *s) { return ready(s) ? pocket_native_program_stride(s->program) : 0; }
size_t pocket_qjs_program_length(PocketQjsProgram *s) { return ready(s) ? pocket_native_program_length(s->program) : 0; }

void pocket_qjs_program_destroy(PocketQjsProgram *s) {
  if (!s) return;
  /* Destruction, like creation, runs outside callbacks on the owning thread. */
  assert(!s->busy);
  pocket_qjs_program_shutdown(s);
  free(s);
}
