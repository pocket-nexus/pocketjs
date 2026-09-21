#include "pocket_runtime.h"

#include "pocket_ui_cabi.h"
#include "pocket_spec.h"
#include "quickjs.h"
#ifdef POCKET_SVC_WIRE
#include "svcwire.h"
#endif

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#ifdef POCKET_OFFLOAD_POSIX
#include "offload_qjs.h"
#endif

#ifndef POCKETJS_TARGET_ID
#error "POCKETJS_TARGET_ID must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKETJS_HOST_ABI
#error "POCKETJS_HOST_ABI must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKET_RASTER_DENSITY
#define POCKET_RASTER_DENSITY 1
#endif
#define POCKETJS_SIMULATION_HZ 60
#define POCKETJS_ACTION_NAME_CAPACITY 64

#if defined(POCKET_RUNTIME_REPORT_BOOT_STAGE)
extern void pocket_host_boot_stage(int stage);
#define REPORT_BOOT_STAGE(stage) pocket_host_boot_stage(stage)
#else
#define REPORT_BOOT_STAGE(stage) ((void)(stage))
#endif

/*
 * Harness builds provide pocket_bench_stage() and opt into exact boundaries
 * around bundle evaluation, the guest turn, the job drain and core ticks.
 */
#if defined(POCKET_RUNTIME_STAGE_HOOKS)
#define BENCH_STAGE(stage) pocket_bench_stage(stage)
#else
#define BENCH_STAGE(stage) ((void)(stage))
#endif

typedef enum {
  HostCreateNode,
  HostDestroyNode,
  HostInsertBefore,
  HostRemoveChild,
  HostSetStyle,
  HostSetProp,
  HostSetPropBatch,
  HostSetText,
  HostReplaceText,
  HostUploadTexture,
  HostSetImage,
  HostSetSprite,
  HostAnimate,
  HostCancelAnim,
  HostTakeAnimationCompletions,
  HostSetFocus,
  HostSetActive,
  HostHitTest,
  HostHitTestBounds,
  HostSetCursor,
  HostSetCursorPos,
  HostLoadStyles,
  HostLoadFontAtlas,
  HostMeasureText,
  HostFreeTexture,
  HostUploadImgEntry,
  HostDebugInspect,
  HostDebugRectXY,
  HostDebugRectWH,
  HostDebugPause,
  HostDebugStep,
  HostReportAppAction,
#ifdef POCKET_SVC_WIRE
  /* spec ops 30..32 — the host service channel over the PKNT wire
   * (svcwire.c). Present only in builds whose companion is on the network,
   * so every other legacy Apple op table stays byte-identical. */
  HostSvcOpen,
  HostSvcPoll,
  HostSvcSend,
#endif
} HostOperation;

static JSRuntime *runtime;
static JSContext *context;
static JSValue global;
static JSValue frame_function;
#if defined(POCKET_RUNTIME_HARNESS)
static JSValue harness_function;
#endif
static char last_error[512];
static char reported_action_name[POCKETJS_ACTION_NAME_CAPACITY];
static int32_t reported_action_value;
static unsigned long reported_action_sequence;
static int runtime_failed;
#ifdef POCKET_SVC_WIRE
/* spec SVC_POLL_BUF (8192) + terminator: one svcPoll batch. */
static char svc_poll_buffer[8193];
#endif

static void clear_error(void) {
  last_error[0] = '\0';
}

static void set_error(const char *message) {
  size_t length = message == 0 ? 0 : strlen(message);
  if (length >= sizeof(last_error)) length = sizeof(last_error) - 1;
  if (length > 0) memcpy(last_error, message, length);
  last_error[length] = '\0';
}

static void take_exception(JSContext *exception_context) {
  JSValue exception = JS_GetException(exception_context);
  size_t length = 0;
  const char *message = JS_ToCStringLen2(exception_context, &length, exception, 0);
  if (message != 0) {
    size_t copy_length = length < sizeof(last_error) - 1 ? length : sizeof(last_error) - 1;
    memcpy(last_error, message, copy_length);
    last_error[copy_length] = '\0';
    JS_FreeCString(exception_context, message);
  } else {
    set_error("QuickJS exception");
  }
  JS_FreeValue(exception_context, exception);
}

static int int_argument(
  JSContext *ctx,
  int argc,
  JSValueConst *argv,
  int index,
  int32_t *value
) {
  if (index >= argc) {
    JS_ThrowTypeError(ctx, "missing argument %d", index);
    return 0;
  }
  return JS_ToInt32(ctx, value, argv[index]) == 0;
}

static int uint_argument(
  JSContext *ctx,
  int argc,
  JSValueConst *argv,
  int index,
  uint32_t *value
) {
  if (index >= argc) {
    JS_ThrowTypeError(ctx, "missing argument %d", index);
    return 0;
  }
  return JS_ToUint32(ctx, value, argv[index]) == 0;
}

static int float_argument(
  JSContext *ctx,
  int argc,
  JSValueConst *argv,
  int index,
  double *value
) {
  if (index >= argc) {
    JS_ThrowTypeError(ctx, "missing argument %d", index);
    return 0;
  }
  return JS_ToFloat64(ctx, value, argv[index]) == 0;
}

static int non_negative_uint_argument(
  JSContext *ctx,
  int argc,
  JSValueConst *argv,
  int index,
  uint32_t *value
) {
  double raw = 0.0;
  if (!float_argument(ctx, argc, argv, index, &raw)) return 0;
  if (raw <= 0.0) *value = 0;
  else if (raw >= 4294967295.0) *value = 0xffffffffU;
  else *value = (uint32_t)raw;
  return 1;
}

static int string_argument(
  JSContext *ctx,
  int argc,
  JSValueConst *argv,
  int index,
  const char **text,
  size_t *length
) {
  if (index >= argc) {
    JS_ThrowTypeError(ctx, "missing argument %d", index);
    return 0;
  }
  *text = JS_ToCStringLen2(ctx, length, argv[index], 0);
  return *text != 0;
}

static int valid_action_name(const char *name, size_t length) {
  size_t index;
  if (length == 0 || length >= POCKETJS_ACTION_NAME_CAPACITY ||
      name[0] < 'a' || name[0] > 'z') return 0;
  for (index = 1; index < length; index += 1) {
    char value = name[index];
    if ((value < 'a' || value > 'z') &&
        (value < '0' || value > '9') &&
        value != '_' && value != '.' && value != '-') return 0;
  }
  return 1;
}

static int bytes_argument(
  JSContext *ctx,
  int argc,
  JSValueConst *argv,
  int index,
  const uint8_t **bytes,
  size_t *length
) {
  if (index >= argc) {
    JS_ThrowTypeError(ctx, "missing argument %d", index);
    return 0;
  }

  uint8_t *direct = JS_GetArrayBuffer(ctx, length, argv[index]);
  if (!JS_HasException(ctx)) {
    *bytes = direct;
    return 1;
  }
  JSValue direct_error = JS_GetException(ctx);
  JS_FreeValue(ctx, direct_error);

  size_t offset = 0;
  size_t byte_length = 0;
  size_t bytes_per_element = 0;
  JSValue buffer = JS_GetTypedArrayBuffer(
    ctx,
    argv[index],
    &offset,
    &byte_length,
    &bytes_per_element
  );
  if (JS_IsException(buffer)) return 0;
  size_t buffer_length = 0;
  uint8_t *base = JS_GetArrayBuffer(ctx, &buffer_length, buffer);
  if (JS_HasException(ctx)) {
    JS_FreeValue(ctx, buffer);
    return 0;
  }
  if (offset > buffer_length || byte_length > buffer_length - offset) {
    JS_FreeValue(ctx, buffer);
    JS_ThrowRangeError(ctx, "typed array is outside its backing buffer");
    return 0;
  }
  (void)bytes_per_element;
  *bytes = base == 0 ? 0 : base + offset;
  *length = byte_length;
  JS_FreeValue(ctx, buffer);
  return 1;
}

static JSValue host_operation(
  JSContext *ctx,
  JSValueConst this_value,
  int argc,
  JSValueConst *argv,
  int magic
) {
  (void)this_value;
  int32_t a = 0;
  int32_t b = 0;
  int32_t c = 0;
  uint32_t ua = 0;
  uint32_t ub = 0;
  uint32_t uc = 0;
  uint32_t ud = 0;
  double da = 0.0;
  double db = 0.0;
  double dc = 0.0;
  double dd = 0.0;
  const uint8_t *bytes = 0;
  size_t byte_length = 0;
  const char *text = 0;
  size_t text_length = 0;

  switch ((HostOperation)magic) {
    case HostCreateNode:
      if (!uint_argument(ctx, argc, argv, 0, &ua)) return JS_EXCEPTION;
      return JS_NewInt32(ctx, ui_create_node(ua));
    case HostDestroyNode:
      if (!int_argument(ctx, argc, argv, 0, &a)) return JS_EXCEPTION;
      ui_destroy_node(a);
      return JS_UNDEFINED;
    case HostInsertBefore:
      if (!int_argument(ctx, argc, argv, 0, &a) ||
          !int_argument(ctx, argc, argv, 1, &b) ||
          !int_argument(ctx, argc, argv, 2, &c)) return JS_EXCEPTION;
      ui_insert_before(a, b, c);
      return JS_UNDEFINED;
    case HostRemoveChild:
      if (!int_argument(ctx, argc, argv, 0, &a) ||
          !int_argument(ctx, argc, argv, 1, &b)) return JS_EXCEPTION;
      ui_remove_child(a, b);
      return JS_UNDEFINED;
    case HostSetStyle:
      if (!int_argument(ctx, argc, argv, 0, &a) ||
          !int_argument(ctx, argc, argv, 1, &b)) return JS_EXCEPTION;
      ui_set_style(a, b);
      return JS_UNDEFINED;
    case HostSetProp:
      if (!int_argument(ctx, argc, argv, 0, &a) ||
          !uint_argument(ctx, argc, argv, 1, &ua) ||
          !float_argument(ctx, argc, argv, 2, &da)) return JS_EXCEPTION;
      ui_set_prop(a, ua, da);
      return JS_UNDEFINED;
    case HostSetPropBatch:
      if (!bytes_argument(ctx, argc, argv, 0, &bytes, &byte_length)) return JS_EXCEPTION;
      ui_set_prop_batch(bytes, byte_length);
      return JS_UNDEFINED;
    case HostSetText:
    case HostReplaceText:
      if (!int_argument(ctx, argc, argv, 0, &a) ||
          !string_argument(ctx, argc, argv, 1, &text, &text_length)) return JS_EXCEPTION;
      if (magic == HostSetText) ui_set_text(a, (const uint8_t *)text, text_length);
      else ui_replace_text(a, (const uint8_t *)text, text_length);
      JS_FreeCString(ctx, text);
      return JS_UNDEFINED;
    case HostUploadTexture:
      if (!bytes_argument(ctx, argc, argv, 0, &bytes, &byte_length) ||
          !uint_argument(ctx, argc, argv, 1, &ua) ||
          !uint_argument(ctx, argc, argv, 2, &ub) ||
          !uint_argument(ctx, argc, argv, 3, &uc)) return JS_EXCEPTION;
      return JS_NewInt32(ctx, ui_upload_texture(bytes, byte_length, ua, ub, uc));
    case HostSetImage:
      if (!int_argument(ctx, argc, argv, 0, &a) ||
          !int_argument(ctx, argc, argv, 1, &b)) return JS_EXCEPTION;
      ui_set_image(a, b);
      return JS_UNDEFINED;
    case HostSetSprite:
      if (!int_argument(ctx, argc, argv, 0, &a) ||
          !int_argument(ctx, argc, argv, 1, &b) ||
          !non_negative_uint_argument(ctx, argc, argv, 2, &ua) ||
          !non_negative_uint_argument(ctx, argc, argv, 3, &ub) ||
          !non_negative_uint_argument(ctx, argc, argv, 4, &uc)) return JS_EXCEPTION;
      ui_set_sprite(a, b, ua, ub, uc);
      return JS_UNDEFINED;
    case HostAnimate:
      if (!int_argument(ctx, argc, argv, 0, &a) ||
          !uint_argument(ctx, argc, argv, 1, &ua) ||
          !float_argument(ctx, argc, argv, 2, &da) ||
          !non_negative_uint_argument(ctx, argc, argv, 3, &ub) ||
          !uint_argument(ctx, argc, argv, 4, &uc) ||
          !non_negative_uint_argument(ctx, argc, argv, 5, &ud)) return JS_EXCEPTION;
      return JS_NewInt32(ctx, ui_animate(a, ua, da, ub, uc, ud));
    case HostCancelAnim:
      if (!int_argument(ctx, argc, argv, 0, &a)) return JS_EXCEPTION;
      ui_cancel_anim(a);
      return JS_UNDEFINED;
    case HostTakeAnimationCompletions:
      bytes = ui_take_animation_completions_json(&byte_length);
      return JS_NewStringLen(ctx, (const char *)bytes, byte_length);
    case HostSetFocus:
      if (!int_argument(ctx, argc, argv, 0, &a)) return JS_EXCEPTION;
      ui_set_focus(a);
      return JS_UNDEFINED;
    case HostSetActive:
      if (!int_argument(ctx, argc, argv, 0, &a) ||
          !int_argument(ctx, argc, argv, 1, &b)) return JS_EXCEPTION;
      ui_set_active(a, b);
      return JS_UNDEFINED;
    case HostHitTest:
    case HostHitTestBounds:
      if (!float_argument(ctx, argc, argv, 0, &da) ||
          !float_argument(ctx, argc, argv, 1, &db)) return JS_EXCEPTION;
      return JS_NewInt32(
        ctx,
        magic == HostHitTest
          ? ui_hit_test((float)da, (float)db)
          : ui_hit_test_bounds((float)da, (float)db)
      );
    case HostSetCursor:
      if (!int_argument(ctx, argc, argv, 0, &a) ||
          !float_argument(ctx, argc, argv, 1, &da) ||
          !float_argument(ctx, argc, argv, 2, &db) ||
          !float_argument(ctx, argc, argv, 3, &dc) ||
          !float_argument(ctx, argc, argv, 4, &dd)) return JS_EXCEPTION;
      ui_set_cursor(a, (float)da, (float)db, (float)dc, (float)dd);
      return JS_UNDEFINED;
    case HostSetCursorPos:
      if (!float_argument(ctx, argc, argv, 0, &da) ||
          !float_argument(ctx, argc, argv, 1, &db)) return JS_EXCEPTION;
      ui_set_cursor_pos((float)da, (float)db);
      return JS_UNDEFINED;
    case HostLoadStyles:
    case HostLoadFontAtlas:
      if (!bytes_argument(ctx, argc, argv, 0, &bytes, &byte_length)) return JS_EXCEPTION;
      return JS_NewBool(
        ctx,
        magic == HostLoadStyles
          ? ui_load_styles(bytes, byte_length)
          : ui_load_font_atlas(bytes, byte_length)
      );
    case HostMeasureText:
      if (!string_argument(ctx, argc, argv, 0, &text, &text_length)) return JS_EXCEPTION;
      if (!uint_argument(ctx, argc, argv, 1, &ua)) {
        JS_FreeCString(ctx, text);
        return JS_EXCEPTION;
      }
      da = ui_measure_text((const uint8_t *)text, text_length, ua);
      JS_FreeCString(ctx, text);
      return JS_NewFloat64(ctx, da);
    case HostFreeTexture:
      if (!int_argument(ctx, argc, argv, 0, &a)) return JS_EXCEPTION;
      ui_free_texture(a);
      return JS_UNDEFINED;
    case HostUploadImgEntry:
      if (!bytes_argument(ctx, argc, argv, 0, &bytes, &byte_length)) return JS_EXCEPTION;
      return JS_NewInt32(ctx, ui_upload_img_entry(bytes, byte_length));
    case HostDebugInspect:
      if (!int_argument(ctx, argc, argv, 0, &a)) return JS_EXCEPTION;
      ui_debug_inspect(a);
      return JS_UNDEFINED;
    case HostDebugRectXY:
      return JS_NewInt32(ctx, ui_debug_rect_xy());
    case HostDebugRectWH:
      return JS_NewInt32(ctx, ui_debug_rect_wh());
    case HostDebugPause:
      if (!int_argument(ctx, argc, argv, 0, &a)) return JS_EXCEPTION;
      ui_debug_pause(a);
      return JS_UNDEFINED;
    case HostDebugStep:
      ui_debug_step();
      return JS_UNDEFINED;
    case HostReportAppAction:
      if (!string_argument(ctx, argc, argv, 0, &text, &text_length)) return JS_EXCEPTION;
      if (!int_argument(ctx, argc, argv, 1, &a)) {
        JS_FreeCString(ctx, text);
        return JS_EXCEPTION;
      }
      if (!valid_action_name(text, text_length)) {
        JS_FreeCString(ctx, text);
        return JS_ThrowRangeError(ctx, "invalid PocketJS app action name");
      }
      memcpy(reported_action_name, text, text_length);
      reported_action_name[text_length] = '\0';
      reported_action_value = a;
      reported_action_sequence += 1;
      JS_FreeCString(ctx, text);
      return JS_UNDEFINED;
#ifdef POCKET_SVC_WIRE
    case HostSvcOpen: {
      int open;
      if (!string_argument(ctx, argc, argv, 0, &text, &text_length)) return JS_NewBool(ctx, 0);
      open = svcwire_open(text);
      JS_FreeCString(ctx, text);
      return JS_NewBool(ctx, open);
    }
    case HostSvcPoll: {
      size_t length = svcwire_recv_lines(svc_poll_buffer, sizeof svc_poll_buffer);
      return length == 0 ? JS_UNDEFINED : JS_NewStringLen(ctx, svc_poll_buffer, length);
    }
    case HostSvcSend:
      if (!string_argument(ctx, argc, argv, 0, &text, &text_length)) return JS_UNDEFINED;
      svcwire_send_line(text, text_length);
      JS_FreeCString(ctx, text);
      return JS_UNDEFINED;
#endif
  }
  return JS_ThrowInternalError(ctx, "unknown PocketJS HostOp");
}

static int add_host_operation(
  JSContext *ctx,
  JSValueConst object,
  const char *name,
  int arity,
  HostOperation operation
) {
  JSValue function = JS_NewCFunctionMagic(
    ctx,
    host_operation,
    name,
    arity,
    JS_CFUNC_generic_magic,
    (int)operation
  );
  if (JS_IsException(function)) return 0;
  return JS_SetPropertyStr(ctx, object, name, function) >= 0;
}

static int install_host(int width, int height) {
#ifdef POCKET_OFFLOAD_POSIX
  if (!install_offload(context, global)) return 0;
#endif
  JSValue ui = JS_NewObject(context);
  if (JS_IsException(ui)) return 0;
  if (!add_host_operation(context, ui, "createNode", 1, HostCreateNode) ||
      !add_host_operation(context, ui, "destroyNode", 1, HostDestroyNode) ||
      !add_host_operation(context, ui, "insertBefore", 3, HostInsertBefore) ||
      !add_host_operation(context, ui, "removeChild", 2, HostRemoveChild) ||
      !add_host_operation(context, ui, "setStyle", 2, HostSetStyle) ||
      !add_host_operation(context, ui, "setProp", 3, HostSetProp) ||
      !add_host_operation(context, ui, "setPropBatch", 1, HostSetPropBatch) ||
      !add_host_operation(context, ui, "setText", 2, HostSetText) ||
      !add_host_operation(context, ui, "replaceText", 2, HostReplaceText) ||
      !add_host_operation(context, ui, "uploadTexture", 4, HostUploadTexture) ||
      !add_host_operation(context, ui, "setImage", 2, HostSetImage) ||
      !add_host_operation(context, ui, "setSprite", 5, HostSetSprite) ||
      !add_host_operation(context, ui, "animate", 6, HostAnimate) ||
      !add_host_operation(context, ui, "cancelAnim", 1, HostCancelAnim) ||
      !add_host_operation(context, ui, "takeAnimationCompletions", 0, HostTakeAnimationCompletions) ||
      !add_host_operation(context, ui, "setFocus", 1, HostSetFocus) ||
      !add_host_operation(context, ui, "setActive", 2, HostSetActive) ||
      !add_host_operation(context, ui, "hitTest", 2, HostHitTest) ||
      !add_host_operation(context, ui, "hitTestBounds", 2, HostHitTestBounds) ||
      !add_host_operation(context, ui, "setCursor", 5, HostSetCursor) ||
      !add_host_operation(context, ui, "setCursorPos", 2, HostSetCursorPos) ||
      !add_host_operation(context, ui, "loadStyles", 1, HostLoadStyles) ||
      !add_host_operation(context, ui, "loadFontAtlas", 1, HostLoadFontAtlas) ||
      !add_host_operation(context, ui, "measureText", 2, HostMeasureText) ||
      !add_host_operation(context, ui, "freeTexture", 1, HostFreeTexture) ||
      !add_host_operation(context, ui, "uploadImgEntry", 1, HostUploadImgEntry) ||
      !add_host_operation(context, ui, "debugInspect", 1, HostDebugInspect) ||
      !add_host_operation(context, ui, "debugRectXY", 0, HostDebugRectXY) ||
      !add_host_operation(context, ui, "debugRectWH", 0, HostDebugRectWH) ||
      !add_host_operation(context, ui, "debugPause", 1, HostDebugPause) ||
      !add_host_operation(context, ui, "debugStep", 0, HostDebugStep) ||
      !add_host_operation(context, ui, "__reportAppAction", 2, HostReportAppAction)) {
    JS_FreeValue(context, ui);
    return 0;
  }
#ifdef POCKET_SVC_WIRE
  if (!add_host_operation(context, ui, "svcOpen", 1, HostSvcOpen) ||
      !add_host_operation(context, ui, "svcPoll", 0, HostSvcPoll) ||
      !add_host_operation(context, ui, "svcSend", 1, HostSvcSend)) {
    JS_FreeValue(context, ui);
    return 0;
  }
#endif

  JSValue viewport = JS_NewObject(context);
  if (JS_IsException(viewport)) {
    JS_FreeValue(context, ui);
    return 0;
  }
  if (JS_SetPropertyStr(context, viewport, "w", JS_NewInt32(context, width)) < 0 ||
      JS_SetPropertyStr(context, viewport, "h", JS_NewInt32(context, height)) < 0) {
    JS_FreeValue(context, viewport);
    JS_FreeValue(context, ui);
    return 0;
  }
  if (JS_SetPropertyStr(context, ui, "__viewport", viewport) < 0) {
    JS_FreeValue(context, ui);
    return 0;
  }
  if (JS_SetPropertyStr(context, ui, "__host", JS_NewString(context, POCKETJS_TARGET_ID)) < 0 ||
      JS_SetPropertyStr(
        context,
        ui,
        "__hostAbi",
        JS_NewInt32(context, POCKETJS_HOST_ABI)
      ) < 0) {
    JS_FreeValue(context, ui);
    return 0;
  }
  return JS_SetPropertyStr(context, global, "ui", ui) >= 0;
}

static int drain_jobs(void) {
  for (;;) {
    JSContext *pending_context = 0;
    int result = JS_ExecutePendingJob(runtime, &pending_context);
    if (result > 0) continue;
    if (result < 0) {
      take_exception(pending_context == 0 ? context : pending_context);
      return 0;
    }
    return 1;
  }
}

void pocket_runtime_shutdown(void) {
#ifdef POCKET_OFFLOAD_POSIX
  pocket_offload_stop();
#endif
  if (context != 0) {
#if defined(POCKET_RUNTIME_HARNESS)
    if (!JS_IsUndefined(harness_function)) JS_FreeValue(context, harness_function);
#endif
    if (!JS_IsUndefined(frame_function)) JS_FreeValue(context, frame_function);
    if (!JS_IsUndefined(global)) JS_FreeValue(context, global);
    JS_FreeContext(context);
  }
  if (runtime != 0) JS_FreeRuntime(runtime);
  context = 0;
  runtime = 0;
  runtime_failed = 0;
  frame_function = JS_UNDEFINED;
  global = JS_UNDEFINED;
#if defined(POCKET_RUNTIME_HARNESS)
  harness_function = JS_UNDEFINED;
#endif
  ui_shutdown();
}

int pocket_runtime_boot(
  const char *java_script,
  size_t java_script_length,
  const uint8_t *pack,
  size_t pack_length,
  int width,
  int height
) {
  clear_error();
  pocket_runtime_shutdown();
  REPORT_BOOT_STAGE(1);
  reported_action_name[0] = '\0';
  reported_action_value = 0;
  reported_action_sequence = 0;
  ui_init(POCKET_RASTER_DENSITY);
  REPORT_BOOT_STAGE(2);
  ui_set_viewport((float)width, (float)height);
  REPORT_BOOT_STAGE(3);

  runtime = JS_NewRuntime();
  if (runtime == 0) {
    set_error("QuickJS runtime allocation failed");
    pocket_runtime_shutdown();
    return 0;
  }
  REPORT_BOOT_STAGE(4);
  JS_SetMaxStackSize(runtime, 256 * 1024);
  context = JS_NewContext(runtime);
  if (context == 0) {
    set_error("QuickJS context allocation failed");
    pocket_runtime_shutdown();
    return 0;
  }
  REPORT_BOOT_STAGE(5);
  global = JS_GetGlobalObject(context);
  if (!install_host(width, height)) {
    take_exception(context);
    pocket_runtime_shutdown();
    return 0;
  }
  REPORT_BOOT_STAGE(6);

  JSValue pack_value = JS_NewArrayBuffer(
    context,
    (uint8_t *)pack,
    pack_length,
    0,
    0,
    0
  );
  if (JS_IsException(pack_value) ||
      JS_SetPropertyStr(context, global, "__pak", pack_value) < 0 ||
      JS_SetPropertyStr(
        context,
        global,
        "__simHz",
        JS_NewInt32(context, POCKETJS_SIMULATION_HZ)
      ) < 0) {
    take_exception(context);
    pocket_runtime_shutdown();
    return 0;
  }
  REPORT_BOOT_STAGE(7);

  BENCH_STAGE(POCKET_BENCH_STAGE_EVAL);
  JSValue result = JS_Eval(
    context,
    java_script,
    java_script_length,
    "app.js",
    JS_EVAL_TYPE_GLOBAL
  );
  BENCH_STAGE(POCKET_BENCH_STAGE_IDLE);
  if (JS_IsException(result)) {
    take_exception(context);
    pocket_runtime_shutdown();
    return 0;
  }
  REPORT_BOOT_STAGE(8);
  JS_FreeValue(context, result);
  frame_function = JS_GetPropertyStr(context, global, "frame");
  if (JS_IsException(frame_function) || !JS_IsFunction(context, frame_function)) {
    if (JS_IsException(frame_function)) take_exception(context);
    else set_error("app.js did not install globalThis.frame");
    pocket_runtime_shutdown();
    return 0;
  }
  REPORT_BOOT_STAGE(9);
  BENCH_STAGE(POCKET_BENCH_STAGE_JOBS);
  int jobs_ok = drain_jobs();
  BENCH_STAGE(POCKET_BENCH_STAGE_IDLE);
  if (!jobs_ok) {
    pocket_runtime_shutdown();
    return 0;
  }
  REPORT_BOOT_STAGE(10);
  return 1;
}

/* One guest turn (frame call + job drain), then `tick_count` core ticks. */
static int run_frame(
  uint32_t buttons,
  const PocketRuntimeContact *contacts,
  unsigned int contact_count,
  const int *cancelled, unsigned int cancelled_count,
  unsigned int tick_count
) {
  unsigned int tick;
  unsigned int index;
#ifdef POCKET_OFFLOAD_POSIX
  offload_submissions = offload_deliveries = offload_uploads = 0;
#endif
  if (runtime == 0 || context == 0 || runtime_failed) return 0;
#ifdef POCKET_SVC_WIRE
  /* Bounded, non-blocking: discovery, connect, rx and tx progress once per
   * guest turn, before the guest polls. */
  svcwire_pump();
#endif
  JSValue touch_array = JS_NewArray(context);
  JSValue hit_array = JS_NewArray(context);
  if (JS_IsException(touch_array) || JS_IsException(hit_array)) {
    if (!JS_IsException(touch_array)) JS_FreeValue(context, touch_array);
    if (!JS_IsException(hit_array)) JS_FreeValue(context, hit_array);
    take_exception(context);
    runtime_failed = 1;
    return 0;
  }
  if (contact_count > POCKET_RUNTIME_MAX_CONTACTS) {
    contact_count = POCKET_RUNTIME_MAX_CONTACTS;
  }
  for (index = 0; index < contact_count; index += 1) {
    const PocketRuntimeContact *contact = &contacts[index];
    uint32_t packed = pocket_runtime_pack_contact(contact);
    if (JS_SetPropertyUint32(
          context,
          touch_array,
          index,
          JS_NewInt32(context, (int32_t)packed)
        ) < 0 ||
        JS_SetPropertyUint32(
          context,
          hit_array,
          index,
          JS_NewInt32(context, contact->hit)
        ) < 0) {
      JS_FreeValue(context, hit_array);
      JS_FreeValue(context, touch_array);
      take_exception(context);
      runtime_failed = 1;
      return 0;
    }
  }
  for (index = 0; index < cancelled_count && index < POCKET_RUNTIME_MAX_CONTACTS; index++) {
    if (JS_SetPropertyUint32(context, touch_array, contact_count + index,
          JS_NewInt32(context, (int32_t)pocket_runtime_pack_cancel(cancelled[index]))) < 0) {
      JS_FreeValue(context, hit_array); JS_FreeValue(context, touch_array);
      take_exception(context); runtime_failed = 1; return 0;
    }
  }
  JSValue arguments[4] = {
    JS_NewUint32(context, buttons),
    JS_NewInt32(context, POCKET_ANALOG_CENTER),
    touch_array,
    hit_array,
  };
  BENCH_STAGE(POCKET_BENCH_STAGE_JS);
  JSValue result = JS_Call(context, frame_function, global, 4, arguments);
  JS_FreeValue(context, hit_array);
  JS_FreeValue(context, touch_array);
  if (JS_IsException(result)) {
    take_exception(context);
    runtime_failed = 1;
    BENCH_STAGE(POCKET_BENCH_STAGE_IDLE);
    return 0;
  }
  JS_FreeValue(context, result);
  BENCH_STAGE(POCKET_BENCH_STAGE_JOBS);
  if (!drain_jobs()) {
    runtime_failed = 1;
    BENCH_STAGE(POCKET_BENCH_STAGE_IDLE);
    return 0;
  }
  BENCH_STAGE(POCKET_BENCH_STAGE_TICK);
  for (tick = 0; tick < tick_count; ++tick) ui_tick();
  BENCH_STAGE(POCKET_BENCH_STAGE_IDLE);
  return 1;
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

int pocket_runtime_tick(const PocketRuntimeInput *input) {
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

int pocket_runtime_tick_contacts(const PocketRuntimeContactsInput *input) {
  if (input == 0) return 0;
  return run_frame(input->buttons, input->contacts, input->contact_count, input->cancelled, input->cancelled_count, 1);
}

int pocket_runtime_frame_contacts(
  const PocketRuntimeContactsInput *input,
  unsigned int tick_count
) {
  if (input == 0) return 0;
  return run_frame(input->buttons, input->contacts, input->contact_count, input->cancelled, input->cancelled_count, tick_count);
}

int pocket_runtime_frame_ticks(
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

int pocket_runtime_frame(int touch_down, int touch_x, int touch_y, int touch_hit) {
  /* The original iPhone host presents at 30 Hz and advances two 60 Hz ticks. */
  return pocket_runtime_frame_ticks(touch_down, touch_x, touch_y, touch_hit, 2);
}

#if defined(POCKET_RUNTIME_HARNESS)
int pocket_runtime_harness_bind(const char *global_function) {
  JSValue function;
  if (runtime == 0 || context == 0 || runtime_failed || global_function == 0 ||
      global_function[0] == '\0') return 0;
  function = JS_GetPropertyStr(context, global, global_function);
  if (JS_IsException(function)) {
    take_exception(context);
    return 0;
  }
  if (!JS_IsFunction(context, function)) {
    JS_FreeValue(context, function);
    set_error("harness dispatcher is not a function");
    return 0;
  }
  if (!JS_IsUndefined(harness_function)) JS_FreeValue(context, harness_function);
  harness_function = function;
  return 1;
}

int pocket_runtime_harness_call(int32_t opcode, int32_t argument, int32_t *out) {
  JSValue arguments[2];
  JSValue value;
  int32_t number = 0;
  if (runtime == 0 || context == 0 || runtime_failed ||
      JS_IsUndefined(harness_function)) return 0;
  arguments[0] = JS_NewInt32(context, opcode);
  arguments[1] = JS_NewInt32(context, argument);
  value = JS_Call(context, harness_function, global, 2, arguments);
  JS_FreeValue(context, arguments[1]);
  JS_FreeValue(context, arguments[0]);
  if (JS_IsException(value)) {
    take_exception(context);
    return 0;
  }
  if (out != 0 && JS_ToInt32(context, &number, value) < 0) {
    JS_FreeValue(context, value);
    take_exception(context);
    return 0;
  }
  JS_FreeValue(context, value);
  if (out != 0) *out = number;
  return 1;
}
#endif

int pocket_runtime_hit_test(float x, float y) {
  if (runtime == 0 || context == 0 || runtime_failed) return 0;
  return ui_hit_test(x, y);
}

int pocket_runtime_hit_test_bounds(float x, float y) {
  if (runtime == 0 || context == 0 || runtime_failed) return 0;
  return ui_hit_test_bounds(x, y);
}

const char *pocket_runtime_action_name(void) {
  return reported_action_name;
}

int pocket_runtime_action_value(void) {
  return (int)reported_action_value;
}

unsigned long pocket_runtime_action_sequence(void) {
  return reported_action_sequence;
}

const uint8_t *pocket_runtime_render(void) {
  if (runtime == 0 || context == 0 || runtime_failed) return 0;
  return ui_render_incremental();
}

unsigned long pocket_runtime_damage_attempts(void) {
  if (runtime == 0 || context == 0 || runtime_failed) return 0;
  return (unsigned long)ui_damage_attempts();
}

unsigned long pocket_runtime_damage_failures(void) {
  if (runtime == 0 || context == 0 || runtime_failed) return 0;
  return (unsigned long)ui_damage_failures();
}

unsigned long pocket_runtime_damage_full_redraws(void) {
  if (runtime == 0 || context == 0 || runtime_failed) return 0;
  return (unsigned long)ui_damage_full_redraws();
}

unsigned long pocket_runtime_damage_pixels(void) {
  if (runtime == 0 || context == 0 || runtime_failed) return 0;
  return (unsigned long)ui_damage_pixels();
}

int pocket_runtime_damage_bounds(int *bounds) {
  int32_t packed[4];
  if (runtime == 0 || context == 0 || runtime_failed || bounds == 0) return 0;
  if (!ui_damage_bounds(packed)) return 0;
  bounds[0] = (int)packed[0];
  bounds[1] = (int)packed[1];
  bounds[2] = (int)packed[2];
  bounds[3] = (int)packed[3];
  return 1;
}

int pocket_runtime_gl_initialize(void) {
  if (runtime == 0 || context == 0 || runtime_failed) return 0;
  return ui_gl_initialize() != 0;
}

void pocket_runtime_gl_reset(void) {
  if (runtime == 0 || context == 0) return;
  ui_gl_reset_resources();
}

int pocket_runtime_gl_render(int width, int height) {
  if (runtime == 0 || context == 0 || runtime_failed) return 0;
  if (width <= 0 || height <= 0) return 0;
  /*
   * The drawable is exactly the app's logical viewport, so the target
   * rectangle is the whole window and no letterboxing arithmetic applies.
   */
  return ui_gl_render(0, 0, width, height, width, height) != 0;
}

void pocket_runtime_gl_shutdown(void) {
  if (runtime == 0 || context == 0) return;
  ui_gl_shutdown();
}

uint32_t pocket_runtime_width(void) {
  if (runtime == 0 || context == 0 || runtime_failed) return 0;
  return ui_framebuffer_width();
}

uint32_t pocket_runtime_height(void) {
  if (runtime == 0 || context == 0 || runtime_failed) return 0;
  return ui_framebuffer_height();
}

uint32_t pocket_runtime_stride(void) {
  if (runtime == 0 || context == 0 || runtime_failed) return 0;
  return ui_framebuffer_stride();
}

size_t pocket_runtime_length(void) {
  if (runtime == 0 || context == 0 || runtime_failed) return 0;
  return ui_framebuffer_len();
}

const char *pocket_runtime_error(void) {
  return last_error;
}
