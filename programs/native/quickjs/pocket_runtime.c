/* Portable host composition. UI coercion and numbered operations are owned by
 * guest-quickjs; package, input, core ticks and presentation belong to Runtime. */
#include "pocket_legacy_runtime.h"
#include "pocket_native_program.h"
#include "pocket_guest_quickjs.h"
#include "pocket_ui_cabi.h"
#include "pocket_spec.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef POCKET_RUNTIME_EXTENSION
#include "pocketjs_symbian_extension.h"
static const PocketJsSymbianExtensionV1 *native_extension;
static int native_gl_current;
#endif
#ifdef POCKET_SVC_WIRE
#include "svcwire.h"
static char svc_poll_buffer[8193];
#endif
#ifdef POCKET_OFFLOAD_POSIX
#include "offload_qjs.h"
#endif
#ifndef POCKETJS_TARGET_ID
#error "POCKETJS_TARGET_ID must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKETJS_HOST_ABI
#error "POCKETJS_HOST_ABI must come from the verified ResolvedBuildPlan"
#elif POCKETJS_HOST_ABI != POCKET_BINDING_GENERATION
#error "POCKETJS_HOST_ABI must match POCKET_BINDING_GENERATION"
#endif
#ifndef POCKET_COMPILED_PROFILE_H
#error "pocket_host_profile.h must come from the independent host build profile"
#endif
#ifndef POCKET_RASTER_DENSITY
#define POCKET_RASTER_DENSITY 1
#endif
#if defined(POCKET_RUNTIME_REPORT_BOOT_STAGE)
extern void pocket_host_boot_stage(int stage);
#define REPORT_BOOT_STAGE(stage) pocket_host_boot_stage(stage)
#else
#define REPORT_BOOT_STAGE(stage) ((void)(stage))
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
static PocketNativeProgram *program;
static pocket_guest_quickjs *guest;
static JSRuntime *runtime;
static JSContext *context;
static JSValue global;
#if defined(POCKET_RUNTIME_HARNESS)
static JSValue harness_function;
#endif
static char last_error[512];
static char reported_action_name[POCKETJS_ACTION_NAME_CAPACITY];
static int32_t reported_action_value;
static unsigned long reported_action_sequence;
static int runtime_failed, busy, shutdown_requested;
static int last_touch_hit;
static uint32_t boot_raster_density = POCKET_RASTER_DENSITY;

static void set_error(const char *message) {
  snprintf(last_error, sizeof last_error, "%s", message ? message : "");
}
static void take_exception(JSContext *ctx) {
  JSValue exception = JS_GetException(ctx);
  const char *message = JS_ToCString(ctx, exception);
  set_error(message ? message : "QuickJS exception");
  if (message) JS_FreeCString(ctx, message);
  JS_FreeValue(ctx, exception);
}
static void guest_error(void) {
  if (!last_error[0]) {
    const char *message = pocket_guest_quickjs_error(guest);
    set_error(message && message[0] ? message : "PocketJS runtime operation failed");
  }
}
static int ready(void) { return program && context && !runtime_failed; }
static int valid_action_name(const char *name, size_t length) {
  if (!length || length >= POCKETJS_ACTION_NAME_CAPACITY || name[0] < 'a' || name[0] > 'z') return 0;
  for (size_t i = 1; i < length; i++) {
    char value = name[i];
    if ((value < 'a' || value > 'z') && (value < '0' || value > '9') && value != '_' && value != '.' && value != '-') return 0;
  }
  return 1;
}
static JSValue report_action(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
  (void)self;
  if (argc < 2) return JS_ThrowTypeError(ctx, "missing app action arguments");
  size_t length = 0;
  const char *name = JS_ToCStringLen(ctx, &length, argv[0]);
  if (!name) return JS_EXCEPTION;
  int32_t value;
  if (JS_ToInt32(ctx, &value, argv[1]) < 0) { JS_FreeCString(ctx, name); return JS_EXCEPTION; }
  if (!valid_action_name(name, length)) { JS_FreeCString(ctx, name); return JS_ThrowRangeError(ctx, "invalid PocketJS app action name"); }
  memcpy(reported_action_name, name, length); reported_action_name[length] = 0;
  reported_action_value = value; reported_action_sequence++;
  JS_FreeCString(ctx, name);
  return JS_UNDEFINED;
}
static int32_t guest_initialize(void *opaque, pocket_runtime *handle, const pocket_guest_environment *env) {
  (void)opaque;
  if (env->heap_limit) JS_SetMemoryLimit(runtime, env->heap_limit);
  if (pocket_guest_quickjs_vtable()->initialize(guest, handle, env)) return -1;
  JSValue ui = JS_GetPropertyStr(context, global, "ui");
  int status = JS_SetPropertyStr(context, ui, "__reportAppAction", JS_NewCFunction(context, report_action, "__reportAppAction", 2));
  JS_FreeValue(context, ui);
  if (status < 0) { take_exception(context); return -1; }
#ifdef POCKET_OFFLOAD_POSIX
  if (!install_offload(context, global)) { take_exception(context); return -1; }
#endif
#ifdef POCKET_RUNTIME_EXTENSION
  const PocketJsSymbianExtensionV1 *candidate = pocketjs_symbian_extension_v1();
  if (!candidate || candidate->abi_version != 1 || candidate->struct_size < sizeof *candidate) {
    set_error("Native extension ABI mismatch"); return -1;
  }
  native_extension = candidate;
  if (candidate->boot && !candidate->boot(context, env->pak, env->pak_length, (int32_t)env->viewport_width, (int32_t)env->viewport_height)) {
    set_error("Native extension boot failed"); return -1;
  }
#endif
  REPORT_BOOT_STAGE(6); REPORT_BOOT_STAGE(7);
  return 0;
}
static int32_t guest_evaluate(void *opaque, pocket_runtime *handle, const uint8_t *code, size_t length) {
  (void)opaque;
  if (pocket_guest_quickjs_vtable()->evaluate(guest, handle, code, length)) return -1;
  REPORT_BOOT_STAGE(8);
  JSValue function = JS_GetPropertyStr(context, global, "frame");
  int valid = JS_IsFunction(context, function);
  if (JS_IsException(function)) take_exception(context);
  else if (!valid) set_error("app.js did not install globalThis.frame");
  JS_FreeValue(context, function);
  if (!valid) return -1;
  REPORT_BOOT_STAGE(9); REPORT_BOOT_STAGE(10);
  return 0;
}
static int32_t guest_frame(void *opaque, const pocket_guest_frame *input) {
  (void)opaque;
#ifdef POCKET_OFFLOAD_POSIX
  offload_submissions = offload_deliveries = offload_uploads = 0;
#endif
#ifdef POCKET_SVC_WIRE
  svcwire_pump();
#endif
#ifdef POCKET_RUNTIME_EXTENSION
  if (native_extension && native_extension->before_guest && !native_extension->before_guest(context, input->buttons, input->analog, 0)) {
    set_error("Native extension frame failed"); return -1;
  }
#endif
  for (size_t i = 0; i < input->touch_count; i++) {
    if (!(input->touches[i] & POCKET_TOUCH_CANCEL_WORD)) last_touch_hit = input->hits[i];
  }
  if (pocket_guest_quickjs_vtable()->frame(guest, input)) return -1;
  BENCH_STAGE(POCKET_BENCH_STAGE_TICK);
#ifdef POCKET_RUNTIME_EXTENSION
  if (native_extension && native_extension->after_guest && !native_extension->after_guest(context)) {
    set_error("Native extension commands failed"); return -1;
  }
#endif
  return 0;
}
static int32_t guest_collect(void *opaque) { (void)opaque; return pocket_guest_quickjs_vtable()->collect(guest); }
static void guest_shutdown(void *opaque) {
  (void)opaque;
#ifdef POCKET_RUNTIME_EXTENSION
  if (native_extension && native_extension->shutdown) native_extension->shutdown(native_gl_current);
  native_extension = NULL;
#endif
  pocket_guest_quickjs_vtable()->shutdown(guest);
}
static const pocket_guest_v1 guest_table = {
  sizeof(pocket_guest_v1), guest_evaluate, guest_frame, guest_collect, guest_shutdown, guest_initialize, NULL
};
#ifdef POCKET_SVC_WIRE
static int32_t service_dispatch(void *opaque, uint16_t op, const pocket_op_arg *args, size_t length, pocket_result *out) {
  (void)opaque;
  out->tag = POCKET_RESULT_NONE;
  if (op == 31) {
    if (length) return POCKET_STATUS_INVALID;
    size_t count = svcwire_recv_lines(svc_poll_buffer, sizeof svc_poll_buffer);
    if (count) { out->tag = POCKET_RESULT_BYTES; out->bytes = (const uint8_t *)svc_poll_buffer; out->byte_length = count; }
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
static void shutdown_now(void) {
#ifdef POCKET_OFFLOAD_POSIX
  pocket_offload_stop();
#endif
  /* Runtime shuts the attached guest down before releasing its package. */
  if (program) pocket_native_program_destroy(program);
  program = NULL;
  if (guest) pocket_guest_quickjs_destroy(guest);
  guest = NULL;
  if (context) {
#if defined(POCKET_RUNTIME_HARNESS)
    if (!JS_IsUndefined(harness_function)) JS_FreeValue(context, harness_function);
#endif
    if (!JS_IsUndefined(global)) JS_FreeValue(context, global);
    JS_FreeContext(context);
  }
  if (runtime) JS_FreeRuntime(runtime);
  context = NULL; runtime = NULL; global = JS_UNDEFINED;
#if defined(POCKET_RUNTIME_HARNESS)
  harness_function = JS_UNDEFINED;
#endif
#ifdef POCKET_RUNTIME_EXTENSION
  native_gl_current = 0; native_extension = NULL;
#endif
  runtime_failed = 0; shutdown_requested = 0;
}
static int leave(int success) {
  if (shutdown_requested) { shutdown_now(); busy = 0; return 0; }
  busy = 0;
  return success;
}
void pocket_legacy_runtime_shutdown(void) {
  if (busy) { shutdown_requested = 1; return; }
  busy = 1; shutdown_now(); busy = 0;
}
void pocket_legacy_runtime_set_raster_density(uint32_t density) {
  if (!busy) boot_raster_density = density ? density : 1;
}
int pocket_legacy_runtime_boot(const char *code, size_t length, const uint8_t *pak, size_t pak_length, int width, int height) {
  if (busy) return 0;
  busy = 1; shutdown_now(); last_error[0] = 0;
  reported_action_name[0] = 0; reported_action_value = 0; reported_action_sequence = 0; last_touch_hit = 0;
  REPORT_BOOT_STAGE(1);
  if (width <= 0 || height <= 0) { set_error("invalid viewport"); goto failed; }
  program = pocket_native_program_create_profile(POCKETJS_TARGET_ID, POCKETJS_HOST_ABI, (const uint8_t *)code, length, pak, pak_length,
    (uint32_t)width, (uint32_t)height, boot_raster_density,
#ifdef POCKET_PHYSICS
    1,
#else
    0,
#endif
    pocket_profile.facts, pocket_profile.profile_hash
  );
  if (!program) { set_error("PocketJS program allocation or configuration failed"); goto failed; }
  REPORT_BOOT_STAGE(2); REPORT_BOOT_STAGE(3);
  runtime = JS_NewRuntime();
  if (!runtime) { set_error("QuickJS runtime allocation failed"); goto failed; }
  JS_SetMaxStackSize(runtime, 256 * 1024);
  REPORT_BOOT_STAGE(4);
  context = JS_NewContext(runtime);
  if (!context) { set_error("QuickJS context allocation failed"); goto failed; }
  global = JS_GetGlobalObject(context);
#if defined(POCKET_RUNTIME_HARNESS)
  harness_function = JS_UNDEFINED;
#endif
  REPORT_BOOT_STAGE(5);
  guest = pocket_guest_quickjs_attach(context, POCKET_QJS_LEGACY_C);
  if (!guest) { set_error("QuickJS adapter allocation failed"); goto failed; }
#if defined(POCKET_RUNTIME_STAGE_HOOKS)
  if (pocket_guest_quickjs_set_phase_hook(guest, profile_phase, NULL)) goto failed;
#endif
  pocket_runtime *handle = pocket_native_program_runtime(program);
#ifdef POCKET_SVC_WIRE
  const uint16_t service_ops[] = {30, 31, 32};
  if (pocket_runtime_add_op_provider(handle, &service_table, NULL, service_ops, 3)) goto failed;
#endif
  if (pocket_runtime_set_guest(handle, &guest_table, NULL) || pocket_native_program_boot(program)) {
    guest_error(); goto failed;
  }
  return leave(1);
failed:
  if (!last_error[0]) set_error("PocketJS boot failed");
  shutdown_now(); BENCH_STAGE(POCKET_BENCH_STAGE_IDLE); return leave(0);
}
static int run_frame(uint32_t buttons, const PocketRuntimeContact *contacts, unsigned int count,
  const int *cancelled, unsigned int cancelled_count, unsigned int ticks) {
  if (busy || !ready() || !ticks || ticks > 60) return 0;
  pocket_contact active[POCKET_RUNTIME_MAX_CONTACTS];
  pocket_cancelled_contact ended[POCKET_RUNTIME_MAX_CONTACTS];
  if (count > POCKET_RUNTIME_MAX_CONTACTS) count = POCKET_RUNTIME_MAX_CONTACTS;
  if (cancelled_count > POCKET_RUNTIME_MAX_CONTACTS) cancelled_count = POCKET_RUNTIME_MAX_CONTACTS;
  for (unsigned i = 0; i < count; i++) {
    active[i] = (pocket_contact){sizeof(pocket_contact), 0, (uint32_t)(contacts[i].id & 255), (float)contacts[i].x, (float)contacts[i].y, 0};
  }
  for (unsigned i = 0; i < cancelled_count; i++) ended[i] = (pocket_cancelled_contact){sizeof(pocket_cancelled_contact), 0, (uint32_t)(cancelled[i] & 255)};
  pocket_input_frame input = {0}; input.struct_size = sizeof input; input.buttons = buttons;
  input.contacts = active; input.contact_count = count; input.cancelled = ended; input.cancelled_count = cancelled_count;
  busy = 1;
  last_error[0] = 0;
  int status = pocket_native_program_advance(program, &input, ticks);
  BENCH_STAGE(POCKET_BENCH_STAGE_IDLE);
  if (status) { guest_error(); runtime_failed = 1; }
  return leave(status == 0);
}
/* The single-touch entries pack one id-0 contact, byte-identical on the wire. */
static unsigned int single_contact(
  PocketRuntimeContact *contact,
  int touch_down,
  int touch_x,
  int touch_y,
  int touch_hit
) {
  if (!touch_down) return 0;
  contact->id = 0;
  contact->x = touch_x;
  contact->y = touch_y;
  contact->hit = touch_hit;
  return 1;
}

int pocket_legacy_runtime_tick(const PocketRuntimeInput *input) {
  PocketRuntimeContact contact;
  unsigned int count;
  if (input == 0) return 0;
  count = single_contact(
    &contact,
    input->touch_down,
    input->touch_x,
    input->touch_y,
    input->touch_hit
  );
  return run_frame(input->buttons, &contact, count, NULL, 0, 1);
}

int pocket_legacy_runtime_tick_contacts(const PocketRuntimeContactsInput *input) {
  if (input == 0) return 0;
  return run_frame(input->buttons, input->contacts, input->contact_count, input->cancelled, input->cancelled_count, 1);
}

int pocket_legacy_runtime_frame_contacts(
  const PocketRuntimeContactsInput *input,
  unsigned int tick_count
) {
  if (input == 0) return 0;
  return run_frame(input->buttons, input->contacts, input->contact_count, input->cancelled, input->cancelled_count, tick_count);
}

int pocket_legacy_runtime_frame_ticks(
  int touch_down,
  int touch_x,
  int touch_y,
  int touch_hit,
  unsigned int tick_count
) {
  PocketRuntimeContact contact;
  unsigned int count = single_contact(&contact, touch_down, touch_x, touch_y, touch_hit);
  return run_frame(0, &contact, count, NULL, 0, tick_count);
}

int pocket_legacy_runtime_frame(int touch_down, int touch_x, int touch_y, int touch_hit) {
  /* The original iPhone host presents at 30 Hz and advances two 60 Hz ticks. */
  return pocket_legacy_runtime_frame_ticks(touch_down, touch_x, touch_y, touch_hit, 2);
}

#if defined(POCKET_RUNTIME_HARNESS)
int pocket_legacy_runtime_harness_bind(const char *global_function) {
  JSValue function;
  if (busy || !ready() || global_function == 0 ||
      global_function[0] == '\0') return 0;
  busy = 1;
  function = JS_GetPropertyStr(context, global, global_function);
  if (JS_IsException(function)) {
    take_exception(context);
    return leave(0);
  }
  if (!JS_IsFunction(context, function)) {
    JS_FreeValue(context, function);
    set_error("harness dispatcher is not a function");
    return leave(0);
  }
  if (!JS_IsUndefined(harness_function)) JS_FreeValue(context, harness_function);
  harness_function = function;
  return leave(1);
}

int pocket_legacy_runtime_harness_call(int32_t opcode, int32_t argument, int32_t *out) {
  JSValue arguments[2];
  JSValue value;
  int32_t number = 0;
  if (busy || !ready() || JS_IsUndefined(harness_function)) return 0;
  busy = 1;
  arguments[0] = JS_NewInt32(context, opcode);
  arguments[1] = JS_NewInt32(context, argument);
  value = JS_Call(context, harness_function, global, 2, arguments);
  JS_FreeValue(context, arguments[1]);
  JS_FreeValue(context, arguments[0]);
  if (JS_IsException(value)) {
    take_exception(context);
    return leave(0);
  }
  if (out != 0 && JS_ToInt32(context, &number, value) < 0) {
    JS_FreeValue(context, value);
    take_exception(context);
    return leave(0);
  }
  JS_FreeValue(context, value);
  if (out != 0) *out = number;
  return leave(1);
}
#endif

int pocket_legacy_runtime_last_touch_hit(void) { return last_touch_hit; }
int pocket_legacy_runtime_hit_test(float x, float y) { return !busy && ready() ? ui_hit_test(x, y) : 0; }
int pocket_legacy_runtime_hit_test_bounds(float x, float y) { return !busy && ready() ? ui_hit_test_bounds(x, y) : 0; }
const char *pocket_legacy_runtime_action_name(void) { return reported_action_name; }
int pocket_legacy_runtime_action_value(void) { return reported_action_value; }
unsigned long pocket_legacy_runtime_action_sequence(void) { return reported_action_sequence; }
const char *pocket_legacy_runtime_error(void) { return last_error; }
const uint8_t *pocket_legacy_runtime_render(void) {
  if (busy || !ready()) return NULL;
  busy = 1;
  const uint8_t *pixels = pocket_native_program_render_argb(program);
  if (!pixels) guest_error();
  return leave(pixels != NULL) ? pixels : NULL;
}
#define DAMAGE_GETTER(name) unsigned long pocket_legacy_runtime_damage_##name(void) { return ready() ? (unsigned long)pocket_native_program_damage_##name(program) : 0; }
DAMAGE_GETTER(attempts)
DAMAGE_GETTER(failures)
DAMAGE_GETTER(full_redraws)
DAMAGE_GETTER(pixels)
int pocket_legacy_runtime_damage_bounds(int *bounds) {
  if (!ready() || !bounds) return 0;
  int32_t values[4];
  if (!pocket_native_program_damage_bounds(program, values)) return 0;
  for (unsigned i = 0; i < 4; i++) bounds[i] = values[i];
  return 1;
}
int pocket_legacy_runtime_gl_initialize(void) {
  if (busy || !ready()) return 0;
  busy = 1;
#ifdef POCKET_RUNTIME_EXTENSION
  native_gl_current = 1;
#endif
  return leave(pocket_native_program_gl_initialize(program) == 0);
}
void pocket_legacy_runtime_gl_set_trace(void (*callback)(uint32_t, uint32_t, uint32_t)) {
  if (!busy && program) pocket_native_program_set_gl_trace(program, callback);
}
void pocket_legacy_runtime_gl_reset(void) {
  if (busy || !program) return;
  busy = 1; pocket_native_program_gl_reset(program); (void)leave(1);
}
int pocket_legacy_runtime_gl_render(int width, int height) {
  if (busy || !ready() || width <= 0 || height <= 0) return 0;
  busy = 1; uint32_t over = 0;
#ifdef POCKET_RUNTIME_EXTENSION
  if (native_extension && native_extension->render) {
    if (!native_extension->render(0, 0, width, height, width, height)) return leave(0);
    over = 1;
  }
#endif
  return leave(pocket_native_program_gl_render(program, (uint32_t)width, (uint32_t)height, over) == 0);
}
void pocket_legacy_runtime_gl_shutdown(void) {
  if (busy || !program) return;
  busy = 1;
#ifdef POCKET_RUNTIME_EXTENSION
  if (native_extension && native_extension->struct_size >= sizeof(PocketJsSymbianGraphicsExtensionV1)) {
    const PocketJsSymbianGraphicsExtensionV1 *graphics = (const PocketJsSymbianGraphicsExtensionV1 *)native_extension;
    if (graphics->release_graphics) graphics->release_graphics(native_gl_current);
  }
  native_gl_current = 0;
#endif
  pocket_native_program_gl_shutdown(program); (void)leave(1);
}
uint32_t pocket_legacy_runtime_native_flags(void) {
#ifdef POCKET_RUNTIME_EXTENSION
  return native_extension ? native_extension->flags : 0;
#else
  return 0;
#endif
}
uint32_t pocket_legacy_runtime_width(void) { return ready() ? pocket_native_program_width(program) : 0; }
uint32_t pocket_legacy_runtime_height(void) { return ready() ? pocket_native_program_height(program) : 0; }
uint32_t pocket_legacy_runtime_stride(void) { return ready() ? pocket_native_program_stride(program) : 0; }
size_t pocket_legacy_runtime_length(void) { return ready() ? pocket_native_program_length(program) : 0; }
