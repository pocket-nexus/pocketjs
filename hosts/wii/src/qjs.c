#include "qjs.h"

#include <stdlib.h>
#include <string.h>

#include "pocket_core.h"
#include "quickjs.h"

#ifndef POCKETJS_TARGET_ID
#error "POCKETJS_TARGET_ID must come from the verified Wii build plan"
#endif
#ifndef POCKETJS_HOST_ABI
#error "POCKETJS_HOST_ABI must come from the verified Wii build plan"
#endif

#define POCKETJS_JS_STACK_SIZE (192 * 1024)
#define POCKETJS_SIMULATION_HZ 60

typedef enum {
  HostCreateNode,
  HostDestroyNode,
  HostInsertBefore,
  HostRemoveChild,
  HostSetStyle,
  HostSetProp,
  HostSetText,
  HostReplaceText,
  HostUploadTexture,
  HostSetImage,
  HostSetSprite,
  HostAnimate,
  HostCancelAnim,
  HostSetFocus,
  HostSetActive,
  HostLoadStyles,
  HostLoadFontAtlas,
  HostMeasureText,
  HostLoadTileTexture,
  HostFreeTexture,
  HostUploadImgEntry,
} HostOperation;

typedef struct {
  const char *name;
  int arity;
  HostOperation operation;
} HostOperationBinding;

static const HostOperationBinding host_operations[] = {
  { "createNode", 1, HostCreateNode },
  { "destroyNode", 1, HostDestroyNode },
  { "insertBefore", 3, HostInsertBefore },
  { "removeChild", 2, HostRemoveChild },
  { "setStyle", 2, HostSetStyle },
  { "setProp", 3, HostSetProp },
  { "setText", 2, HostSetText },
  { "replaceText", 2, HostReplaceText },
  { "uploadTexture", 4, HostUploadTexture },
  { "setImage", 2, HostSetImage },
  { "setSprite", 5, HostSetSprite },
  { "animate", 6, HostAnimate },
  { "cancelAnim", 1, HostCancelAnim },
  { "setFocus", 1, HostSetFocus },
  { "setActive", 2, HostSetActive },
  { "loadStyles", 1, HostLoadStyles },
  { "loadFontAtlas", 1, HostLoadFontAtlas },
  { "measureText", 2, HostMeasureText },
  { "loadTileTexture", 2, HostLoadTileTexture },
  { "freeTexture", 1, HostFreeTexture },
  { "uploadImgEntry", 1, HostUploadImgEntry },
};

static JSRuntime *runtime;
static JSContext *context;
static JSValue global;
static JSValue frame_function;
static const uint8_t *installed_pak;
static size_t installed_pak_length;
static char last_error[512];

static void set_error(const char *message) {
  size_t length = message == NULL ? 0 : strlen(message);
  if (length >= sizeof last_error) length = sizeof last_error - 1;
  if (length != 0) memcpy(last_error, message, length);
  last_error[length] = '\0';
}

static int take_exception(void) {
  JSValue exception = JS_GetException(context);
  if (JS_IsUndefined(exception)) return 0;
  size_t length = 0;
  const char *message = JS_ToCStringLen2(context, &length, exception, 0);
  if (message != NULL) {
    size_t copy = length < sizeof last_error - 1 ? length : sizeof last_error - 1;
    memcpy(last_error, message, copy);
    last_error[copy] = '\0';
    JS_FreeCString(context, message);
  } else {
    set_error("QuickJS exception");
  }
  JS_FreeValue(context, exception);
  return 1;
}

static int32_t argument_int(JSContext *ctx, int argc, JSValueConst *argv, int index) {
  int32_t value = 0;
  if (index < argc) JS_ToInt32(ctx, &value, argv[index]);
  return value;
}

static double argument_float(JSContext *ctx, int argc, JSValueConst *argv, int index) {
  double value = 0.0;
  if (index < argc) JS_ToFloat64(ctx, &value, argv[index]);
  return value;
}

/* The view bytes are borrowed only for this synchronous operation. */
static int argument_bytes(
  JSContext *ctx,
  int argc,
  JSValueConst *argv,
  int index,
  const uint8_t **bytes,
  size_t *length
) {
  if (index >= argc) return 0;

  size_t offset = 0, view_length = 0, bytes_per_element = 0;
  JSValue buffer = JS_GetTypedArrayBuffer(ctx, argv[index], &offset, &view_length, &bytes_per_element);
  if (!JS_IsException(buffer)) {
    size_t buffer_length = 0;
    uint8_t *base = JS_GetArrayBuffer(ctx, &buffer_length, buffer);
    JS_FreeValue(ctx, buffer);
    if (base == NULL || offset > buffer_length || view_length > buffer_length - offset) return 0;
    *bytes = base + offset;
    *length = view_length;
    return 1;
  }
  JS_FreeValue(ctx, JS_GetException(ctx));

  size_t array_length = 0;
  uint8_t *array = JS_GetArrayBuffer(ctx, &array_length, argv[index]);
  if (array == NULL) {
    JS_FreeValue(ctx, JS_GetException(ctx));
    return 0;
  }
  *bytes = array;
  *length = array_length;
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
  const uint8_t *bytes = NULL;
  size_t byte_length = 0;
  const char *text = NULL;
  size_t text_length = 0;

  switch ((HostOperation)magic) {
    case HostCreateNode:
      return JS_NewInt32(ctx, ui_create_node((uint32_t)argument_int(ctx, argc, argv, 0)));
    case HostDestroyNode:
      ui_destroy_node(argument_int(ctx, argc, argv, 0));
      return JS_UNDEFINED;
    case HostInsertBefore:
      ui_insert_before(argument_int(ctx, argc, argv, 0), argument_int(ctx, argc, argv, 1), argument_int(ctx, argc, argv, 2));
      return JS_UNDEFINED;
    case HostRemoveChild:
      ui_remove_child(argument_int(ctx, argc, argv, 0), argument_int(ctx, argc, argv, 1));
      return JS_UNDEFINED;
    case HostSetStyle:
      ui_set_style(argument_int(ctx, argc, argv, 0), argument_int(ctx, argc, argv, 1));
      return JS_UNDEFINED;
    case HostSetProp:
      ui_set_prop(argument_int(ctx, argc, argv, 0), (uint32_t)argument_int(ctx, argc, argv, 1), argument_float(ctx, argc, argv, 2));
      return JS_UNDEFINED;
    case HostSetText:
    case HostReplaceText:
      if (argc < 2) return JS_UNDEFINED;
      text = JS_ToCStringLen2(ctx, &text_length, argv[1], 0);
      if (text == NULL) return JS_UNDEFINED;
      if (magic == HostSetText) ui_set_text(argument_int(ctx, argc, argv, 0), (const uint8_t *)text, text_length);
      else ui_replace_text(argument_int(ctx, argc, argv, 0), (const uint8_t *)text, text_length);
      JS_FreeCString(ctx, text);
      return JS_UNDEFINED;
    case HostUploadTexture:
      if (argc < 4 || !argument_bytes(ctx, argc, argv, 0, &bytes, &byte_length)) return JS_NewInt32(ctx, -1);
      return JS_NewInt32(ctx, ui_upload_texture(bytes, byte_length,
        (uint32_t)argument_int(ctx, argc, argv, 1),
        (uint32_t)argument_int(ctx, argc, argv, 2),
        (uint32_t)argument_int(ctx, argc, argv, 3)));
    case HostSetImage:
      ui_set_image(argument_int(ctx, argc, argv, 0), argument_int(ctx, argc, argv, 1));
      return JS_UNDEFINED;
    case HostSetSprite:
      ui_set_sprite(argument_int(ctx, argc, argv, 0), argument_int(ctx, argc, argv, 1),
        (uint32_t)argument_int(ctx, argc, argv, 2),
        (uint32_t)argument_int(ctx, argc, argv, 3),
        (uint32_t)argument_int(ctx, argc, argv, 4));
      return JS_UNDEFINED;
    case HostAnimate: {
      int32_t duration = argument_int(ctx, argc, argv, 3);
      int32_t delay = argument_int(ctx, argc, argv, 5);
      return JS_NewInt32(ctx, ui_animate(
        argument_int(ctx, argc, argv, 0),
        (uint32_t)argument_int(ctx, argc, argv, 1),
        argument_float(ctx, argc, argv, 2),
        (uint32_t)(duration < 0 ? 0 : duration),
        (uint32_t)argument_int(ctx, argc, argv, 4),
        (uint32_t)(delay < 0 ? 0 : delay)));
    }
    case HostCancelAnim:
      ui_cancel_anim(argument_int(ctx, argc, argv, 0));
      return JS_UNDEFINED;
    case HostSetFocus:
      ui_set_focus(argument_int(ctx, argc, argv, 0));
      return JS_UNDEFINED;
    case HostSetActive:
      ui_set_active(argument_int(ctx, argc, argv, 0), argument_int(ctx, argc, argv, 1));
      return JS_UNDEFINED;
    case HostLoadStyles:
    case HostLoadFontAtlas:
      if (!argument_bytes(ctx, argc, argv, 0, &bytes, &byte_length)) return JS_NewBool(ctx, 0);
      return JS_NewBool(ctx, magic == HostLoadStyles
        ? ui_load_styles(bytes, byte_length)
        : ui_load_font_atlas(bytes, byte_length));
    case HostMeasureText:
      if (argc < 1) return JS_NewFloat64(ctx, 0.0);
      text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
      if (text == NULL) return JS_NewFloat64(ctx, 0.0);
      {
        float width = ui_measure_text((const uint8_t *)text, text_length,
          (uint32_t)argument_int(ctx, argc, argv, 1));
        JS_FreeCString(ctx, text);
        return JS_NewFloat64(ctx, (double)width);
      }
    case HostLoadTileTexture: {
      if (argc < 2) return JS_NewInt32(ctx, -1);
      text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
      if (text == NULL) return JS_NewInt32(ctx, -1);
      const uint8_t *blob = NULL;
      size_t blob_length = ui_pak_find(installed_pak, installed_pak_length,
        (const uint8_t *)text, text_length, &blob);
      JS_FreeCString(ctx, text);
      return blob_length == 0 ? JS_NewInt32(ctx, -1)
        : JS_NewInt32(ctx, ui_upload_tileset_tile(blob, blob_length, (uint32_t)argument_int(ctx, argc, argv, 1)));
    }
    case HostFreeTexture:
      ui_free_texture(argument_int(ctx, argc, argv, 0));
      return JS_UNDEFINED;
    case HostUploadImgEntry:
      if (!argument_bytes(ctx, argc, argv, 0, &bytes, &byte_length)) return JS_NewInt32(ctx, -1);
      return JS_NewInt32(ctx, ui_upload_img_entry(bytes, byte_length));
  }
  return JS_UNDEFINED;
}

static int set_property(JSValueConst object, const char *name, JSValue value) {
  return JS_IsException(value) ? 0 : JS_SetPropertyStr(context, object, name, value) >= 0;
}

static int add_operation(JSValueConst object, const HostOperationBinding *binding) {
  JSValue function = JS_NewCFunctionMagic(context, host_operation, binding->name,
    binding->arity, JS_CFUNC_generic_magic, (int)binding->operation);
  return set_property(object, binding->name, function);
}

static int set_named_property(JSValueConst object, const uint8_t *name, size_t length, JSValue value) {
  if (name == NULL || length == SIZE_MAX) {
    JS_FreeValue(context, value);
    return 0;
  }
  char *key = malloc(length + 1);
  if (key == NULL) {
    JS_FreeValue(context, value);
    return 0;
  }
  memcpy(key, name, length);
  key[length] = '\0';
  int ok = set_property(object, key, value);
  free(key);
  return ok;
}

static int install_host(void) {
  JSValue ui = JS_NewObject(context);
  if (JS_IsException(ui)) return 0;

  for (size_t i = 0; i < sizeof host_operations / sizeof host_operations[0]; ++i) {
    if (!add_operation(ui, &host_operations[i])) goto failed;
  }
  if (!set_property(ui, "__host", JS_NewString(context, POCKETJS_TARGET_ID)) ||
      !set_property(ui, "__hostAbi", JS_NewInt32(context, POCKETJS_HOST_ABI))) goto failed;

  JSValue viewport = JS_NewObject(context);
  if (JS_IsException(viewport) ||
      !set_property(viewport, "w", JS_NewInt32(context, 480)) ||
      !set_property(viewport, "h", JS_NewInt32(context, 272)) ||
      !set_property(ui, "__viewport", viewport)) goto failed;

  JSValue textures = JS_NewObject(context);
  if (JS_IsException(textures)) goto failed;
  for (size_t i = 0; i < ui_pak_texture_count(); ++i) {
    if (!set_named_property(textures, ui_pak_texture_name(i), ui_pak_texture_name_len(i),
        JS_NewInt32(context, ui_pak_texture_handle(i)))) {
      JS_FreeValue(context, textures);
      goto failed;
    }
  }
  if (!set_property(ui, "__textures", textures)) goto failed;

  JSValue sprites = JS_NewObject(context);
  if (JS_IsException(sprites)) goto failed;
  for (size_t i = 0; i < ui_pak_sprite_count(); ++i) {
    JSValue meta = JS_NewObject(context);
    if (JS_IsException(meta) ||
        !set_property(meta, "handle", JS_NewInt32(context, ui_pak_sprite_handle(i))) ||
        !set_property(meta, "frames", JS_NewInt32(context, (int32_t)ui_pak_sprite_frames(i))) ||
        !set_property(meta, "cols", JS_NewInt32(context, (int32_t)ui_pak_sprite_columns(i))) ||
        !set_property(meta, "step", JS_NewInt32(context, (int32_t)ui_pak_sprite_step(i)))) {
      JS_FreeValue(context, meta);
      JS_FreeValue(context, sprites);
      goto failed;
    }
    if (!set_named_property(sprites, ui_pak_sprite_name(i), ui_pak_sprite_name_len(i), meta)) {
      JS_FreeValue(context, sprites);
      goto failed;
    }
  }
  if (!set_property(ui, "__sprites", sprites)) goto failed;
  {
    JSValue owned_ui = ui;
    ui = JS_UNDEFINED;
    if (!set_property(global, "ui", owned_ui)) goto failed;
  }
  return 1;

failed:
  JS_FreeValue(context, ui);
  return 0;
}

static bool drain_jobs(void) {
  for (;;) {
    JSContext *pending = NULL;
    int result = JS_ExecutePendingJob(runtime, &pending);
    if (result > 0) continue;
    if (result < 0) {
      take_exception();
      return false;
    }
    return true;
  }
}

bool qjs_boot(const char *source, size_t source_length, const uint8_t *pak, size_t pak_length) {
  qjs_shutdown();
  last_error[0] = '\0';
  installed_pak = pak;
  installed_pak_length = pak_length;
  global = JS_UNDEFINED;
  frame_function = JS_UNDEFINED;

  runtime = JS_NewRuntime();
  if (runtime == NULL) {
    set_error("JS_NewRuntime returned null");
    return false;
  }
  JS_SetMaxStackSize(runtime, POCKETJS_JS_STACK_SIZE);
  context = JS_NewContext(runtime);
  if (context == NULL) {
    set_error("JS_NewContext returned null");
    qjs_shutdown();
    return false;
  }
  global = JS_GetGlobalObject(context);
  if (!install_host()) {
    if (!take_exception()) set_error("QuickJS host binding allocation failed");
    qjs_shutdown();
    return false;
  }
  if (!set_property(global, "__simHz", JS_NewInt32(context, POCKETJS_SIMULATION_HZ))) {
    if (!take_exception()) set_error("QuickJS simulation clock binding failed");
    qjs_shutdown();
    return false;
  }
  if (pak != NULL && pak_length > 0 &&
      !set_property(global, "__pak", JS_NewArrayBuffer(context, (uint8_t *)pak, pak_length, NULL, NULL, 0))) {
    if (!take_exception()) set_error("QuickJS pak binding allocation failed");
    qjs_shutdown();
    return false;
  }

  JSValue result = JS_Eval(context, source, source_length, "app.js", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(result)) {
    take_exception();
    JS_FreeValue(context, result);
    qjs_shutdown();
    return false;
  }
  JS_FreeValue(context, result);
  frame_function = JS_GetPropertyStr(context, global, "frame");
  if (JS_IsException(frame_function)) {
    take_exception();
    qjs_shutdown();
    return false;
  }
  if (!JS_IsFunction(context, frame_function)) {
    set_error("app.js did not install globalThis.frame");
    qjs_shutdown();
    return false;
  }
  if (!drain_jobs()) {
    qjs_shutdown();
    return false;
  }
  return true;
}

bool qjs_frame(uint32_t buttons, uint32_t analog) {
  if (context == NULL) {
    set_error("QuickJS context is not running");
    return false;
  }
  JSValue arguments[2] = {
    JS_NewUint32(context, buttons),
    JS_NewUint32(context, analog),
  };
  JSValue result = JS_Call(context, frame_function, global, 2, arguments);
  JS_FreeValue(context, arguments[0]);
  JS_FreeValue(context, arguments[1]);
  if (JS_IsException(result)) {
    take_exception();
    JS_FreeValue(context, result);
    return false;
  }
  JS_FreeValue(context, result);
  return drain_jobs();
}

const char *qjs_last_error(void) {
  return last_error;
}

void qjs_shutdown(void) {
  if (context != NULL) {
    JS_FreeValue(context, frame_function);
    JS_FreeValue(context, global);
    JS_FreeContext(context);
    context = NULL;
  }
  if (runtime != NULL) {
    JS_FreeRuntime(runtime);
    runtime = NULL;
  }
  frame_function = JS_UNDEFINED;
  global = JS_UNDEFINED;
  installed_pak = NULL;
  installed_pak_length = 0;
}
