/*
 * QuickJS bindings: the `globalThis.ui` namespace — the 3DS side of the
 * HostOps contract (contracts/spec/spec.ts OP table; JS caller in
 * framework/src/host.ts).
 *
 * hosts/psp/src/ffi.rs is the reference for op semantics, argument
 * marshalling and return values: a missing argument reads as 0 rather than
 * throwing, because native hosts are the NON-strict kind (framework/src/host.ts)
 * and a crash on hardware is worse than a missing style.
 *
 * One core instance, one JS thread. All ops are synchronous; the JS renderer
 * keeps a mirror tree so reconciler reads never cross this boundary.
 *
 * Extra (not spec ops): `ui.__textures` and `ui.__sprites`, the pak image and
 * sprite-atlas name tables built by ui_feed_pak before any JS runs
 * (framework/src/index.ts walks them so JSX `src="<name>"` resolves), and
 * `ui.__viewport`, the logical UI size the same file sizes the mounted app and
 * overlay layers from.
 */

#include "qjs.h"
#include "offload.h"
#include "media.h"
#include "offload_coverage.h"

#include <stdlib.h>
#include <string.h>

#include "devserver.h"
#include "pocket_core.h"
#include "quickjs.h"
#include "svcwire.h"

#ifndef POCKETJS_TARGET_ID
#error "POCKETJS_TARGET_ID must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKETJS_HOST_ABI
#error "POCKETJS_HOST_ABI must come from the verified ResolvedBuildPlan"
#endif

/* contracts/spec/spec.ts FIXED_DT: the core steps at exactly 1/60 s, and this
 * host presents at the same rate, so the advertised simulation rate is 60. */
#define POCKETJS_SIMULATION_HZ 60
/* QuickJS recurses; the 3DS main thread's stack is set in main.c. */
/* A QuickJS call frame is expensive and mounting a UI descends the tree, so
 * this budget is spent on JSX NESTING DEPTH rather than node count. 192 KiB
 * was not enough for an ordinary windowed app: opening one Pocket Shell
 * applet whose rows carried a wrapper view overflowed it mid-frame, and the
 * runtime rolled the whole guest back to last-good. The main thread's own
 * stack is 1 MiB (main.c) and this limit costs nothing until it is used. */
#define POCKETJS_JS_STACK_SIZE (384 * 1024)

typedef enum {
  HostMediaOpen, HostMediaClose, HostMediaPaused, HostMediaVolume, HostMediaTexture, HostMediaStatus,
  HostOffloadSession, HostOffloadSubmit, HostOffloadTake, HostOffloadCoverage,
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
  HostSetFocus,
  HostSetActive,
  HostHitTest,
  HostHitTestBounds,
  HostHitTestAuxiliary,
  HostHitTestBoundsAuxiliary,
  HostSetCursor,
  HostSetCursorPos,
  HostLoadStyles,
  HostLoadFontAtlas,
  HostMeasureText,
  HostLoadTileTexture,
  HostFreeTexture,
  HostUploadImgEntry,
  HostDebugInspect,
  HostDebugRectXY,
  HostDebugRectWH,
  HostDebugPause,
  HostDebugStep,
  HostDebugStats,
  HostDbgActive,
  HostDbgPoll,
  HostDbgSend,
  HostDbgShot,
  HostSvcOpen,
  HostSvcPoll,
  HostSvcSend,
} HostOperation;

static JSRuntime *runtime;
static JSContext *context;
static JSValue global;
static JSValue frame_function;
static const uint8_t *installed_pack;
static size_t installed_pack_length;
/* Wide enough for a message plus the frames QuickJS keeps for it. */
static char last_error[1024];
static char debug_poll_buffer[32 * 1024];
/* contracts/spec/spec.ts SVC_POLL_BUF + the terminating NUL. */
static char svc_poll_buffer[8192 + 1];
static uint8_t coverage_pixels[16384 * 4];
static bool coverage_used;

static void set_error(const char *message) {
  size_t length = message == NULL ? 0 : strlen(message);
  if (length >= sizeof last_error) length = sizeof last_error - 1;
  if (length > 0) memcpy(last_error, message, length);
  last_error[length] = '\0';
}

/* Take the pending exception as the reported error. The message is what the
 * capture path writes to error.txt, so a JS throw surfaces as itself instead
 * of as a timeout.
 *
 * The frames follow the message when the exception carries a `stack`, filling
 * whatever room is left. A bare message names the failure but not the code —
 * "InternalError: stack overflow" is the same string wherever it is thrown —
 * and the frames are the only part that says which function to look at. */
static void take_exception(void) {
  JSValue exception = JS_GetException(context);
  size_t length = 0;
  const char *message = JS_ToCStringLen2(context, &length, exception, 0);
  size_t used = 0;
  if (message != NULL) {
    used = length < sizeof last_error - 1 ? length : sizeof last_error - 1;
    memcpy(last_error, message, used);
    JS_FreeCString(context, message);
  } else {
    const char *fallback = "QuickJS exception";
    used = strlen(fallback);
    memcpy(last_error, fallback, used);
  }
  last_error[used] = '\0';
  if (JS_IsObject(exception) && used + 2 < sizeof last_error - 1) {
    JSValue stack = JS_GetPropertyStr(context, exception, "stack");
    size_t stack_length = 0;
    const char *frames = JS_IsException(stack) ? NULL : JS_ToCStringLen2(context, &stack_length, stack, 0);
    if (frames != NULL) {
      size_t room = sizeof last_error - 1 - used - 1;
      size_t copy = stack_length < room ? stack_length : room;
      last_error[used] = ' ';
      /* Flattened: the error travels as one line, over the dev wire and into
       * error.txt alike. */
      for (size_t i = 0; i < copy; i += 1) {
        last_error[used + 1 + i] = frames[i] == '\n' ? ' ' : frames[i];
      }
      last_error[used + 1 + copy] = '\0';
      JS_FreeCString(context, frames);
    }
    JS_FreeValue(context, stack);
  }
  JS_FreeValue(context, exception);
}

// ---------------------------------------------------------------------------
// argument helpers
// ---------------------------------------------------------------------------

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

/*
 * Borrow the bytes behind an ArrayBuffer OR a typed-array view (host.ts passes
 * Uint8Arrays). The pointer is only valid until the next JS allocation, so
 * callers consume it before returning to JS.
 */
static int argument_bytes(
  JSContext *ctx,
  int argc,
  JSValueConst *argv,
  int index,
  const uint8_t **bytes,
  size_t *length
) {
  if (index >= argc) return 0;
  size_t direct_length = 0;
  uint8_t *direct = JS_GetArrayBuffer(ctx, &direct_length, argv[index]);
  if (direct != NULL) {
    *bytes = direct;
    *length = direct_length;
    return 1;
  }
  /* Not an ArrayBuffer: clear the pending TypeError and try the view's
   * `buffer` + `byteOffset`/`byteLength`. */
  JS_FreeValue(ctx, JS_GetException(ctx));
  JSValue buffer = JS_GetPropertyStr(ctx, argv[index], "buffer");
  size_t base_length = 0;
  uint8_t *base = JS_GetArrayBuffer(ctx, &base_length, buffer);
  JS_FreeValue(ctx, buffer);
  if (base == NULL) {
    JS_FreeValue(ctx, JS_GetException(ctx));
    return 0;
  }
  JSValue offset_value = JS_GetPropertyStr(ctx, argv[index], "byteOffset");
  int32_t offset = 0;
  JS_ToInt32(ctx, &offset, offset_value);
  JS_FreeValue(ctx, offset_value);
  JSValue length_value = JS_GetPropertyStr(ctx, argv[index], "byteLength");
  int32_t view_length = 0;
  JS_ToInt32(ctx, &view_length, length_value);
  JS_FreeValue(ctx, length_value);
  if (offset < 0 || view_length < 0 || (size_t)offset + (size_t)view_length > base_length) {
    return 0;
  }
  *bytes = base + offset;
  *length = (size_t)view_length;
  return 1;
}

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

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
#ifdef POCKETJS_MEDIA
    case HostMediaOpen: {
      if(argc<3) return JS_FALSE;
      size_t host_length=0,token_length=0;
      const char *host=JS_ToCStringLen(ctx,&host_length,argv[0]);
      const char *token=JS_ToCStringLen(ctx,&token_length,argv[2]);
      bool ok=host && token && host_length<=15 && token_length==64 &&
        media_open(host,(unsigned)argument_int(ctx,argc,argv,1),token);
      if(host) JS_FreeCString(ctx,host);
      if(token) JS_FreeCString(ctx,token);
      return JS_NewBool(ctx,ok);
    }
    case HostMediaClose: media_close(); return JS_UNDEFINED;
    case HostMediaPaused: media_paused(argc>0 && JS_ToBool(ctx,argv[0])); return JS_UNDEFINED;
    case HostMediaVolume: media_volume((float)argument_float(ctx,argc,argv,0)); return JS_UNDEFINED;
    case HostMediaTexture: return JS_NewInt32(ctx,media_texture_handle());
    case HostMediaStatus: {
      char status[640]; media_snapshot(status,sizeof status); return JS_NewString(ctx,status);
    }
#endif
    case HostCreateNode:
      return JS_NewInt32(ctx, ui_create_node((uint32_t)argument_int(ctx, argc, argv, 0)));
    case HostDestroyNode:
      ui_destroy_node(argument_int(ctx, argc, argv, 0));
      return JS_UNDEFINED;
    case HostInsertBefore:
      ui_insert_before(
        argument_int(ctx, argc, argv, 0),
        argument_int(ctx, argc, argv, 1),
        argument_int(ctx, argc, argv, 2)
      );
      return JS_UNDEFINED;
    case HostRemoveChild:
      ui_remove_child(argument_int(ctx, argc, argv, 0), argument_int(ctx, argc, argv, 1));
      return JS_UNDEFINED;
    case HostSetStyle:
      ui_set_style(argument_int(ctx, argc, argv, 0), argument_int(ctx, argc, argv, 1));
      return JS_UNDEFINED;
    case HostSetProp:
      ui_set_prop(
        argument_int(ctx, argc, argv, 0),
        (uint32_t)argument_int(ctx, argc, argv, 1),
        argument_float(ctx, argc, argv, 2)
      );
      return JS_UNDEFINED;
    case HostSetPropBatch:
      if (argument_bytes(ctx, argc, argv, 0, &bytes, &byte_length)) {
        ui_set_prop_batch(bytes, byte_length);
      }
      return JS_UNDEFINED;
    case HostSetText:
    case HostReplaceText: {
      if (argc < 2) return JS_UNDEFINED;
      int32_t id = argument_int(ctx, argc, argv, 0);
      text = JS_ToCStringLen2(ctx, &text_length, argv[1], 0);
      if (text == NULL) return JS_UNDEFINED;
      if (magic == HostSetText) ui_set_text(id, (const uint8_t *)text, text_length);
      else ui_replace_text(id, (const uint8_t *)text, text_length);
      JS_FreeCString(ctx, text);
      return JS_UNDEFINED;
    }
    case HostUploadTexture:
      if (argc < 4 || !argument_bytes(ctx, argc, argv, 0, &bytes, &byte_length)) {
        return JS_NewInt32(ctx, -1);
      }
      return JS_NewInt32(
        ctx,
        ui_upload_texture(
          bytes,
          byte_length,
          (uint32_t)argument_int(ctx, argc, argv, 1),
          (uint32_t)argument_int(ctx, argc, argv, 2),
          (uint32_t)argument_int(ctx, argc, argv, 3)
        )
      );
    case HostSetImage:
      ui_set_image(argument_int(ctx, argc, argv, 0), argument_int(ctx, argc, argv, 1));
      return JS_UNDEFINED;
    case HostSetSprite:
      ui_set_sprite(
        argument_int(ctx, argc, argv, 0),
        argument_int(ctx, argc, argv, 1),
        (uint32_t)argument_int(ctx, argc, argv, 2),
        (uint32_t)argument_int(ctx, argc, argv, 3),
        (uint32_t)argument_int(ctx, argc, argv, 4)
      );
      return JS_UNDEFINED;
    case HostAnimate: {
      int32_t duration = argument_int(ctx, argc, argv, 3);
      int32_t delay = argument_int(ctx, argc, argv, 5);
      return JS_NewInt32(
        ctx,
        ui_animate(
          argument_int(ctx, argc, argv, 0),
          (uint32_t)argument_int(ctx, argc, argv, 1),
          argument_float(ctx, argc, argv, 2),
          (uint32_t)(duration < 0 ? 0 : duration),
          (uint32_t)argument_int(ctx, argc, argv, 4),
          (uint32_t)(delay < 0 ? 0 : delay)
        )
      );
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
    case HostHitTest:
      return JS_NewInt32(
        ctx,
        ui_hit_test(
          (float)argument_float(ctx, argc, argv, 0),
          (float)argument_float(ctx, argc, argv, 1)
        )
      );
    case HostHitTestBounds:
      return JS_NewInt32(
        ctx,
        ui_hit_test_bounds(
          (float)argument_float(ctx, argc, argv, 0),
          (float)argument_float(ctx, argc, argv, 1)
        )
      );
    case HostHitTestAuxiliary:
      return JS_NewInt32(
        ctx,
        ui_hit_test_auxiliary(
          (float)argument_float(ctx, argc, argv, 0),
          (float)argument_float(ctx, argc, argv, 1)
        )
      );
    case HostHitTestBoundsAuxiliary:
      return JS_NewInt32(
        ctx,
        ui_hit_test_bounds_auxiliary(
          (float)argument_float(ctx, argc, argv, 0),
          (float)argument_float(ctx, argc, argv, 1)
        )
      );
    case HostSetCursor:
      ui_set_cursor(
        argument_int(ctx, argc, argv, 0),
        (float)argument_float(ctx, argc, argv, 1),
        (float)argument_float(ctx, argc, argv, 2),
        (float)argument_float(ctx, argc, argv, 3),
        (float)argument_float(ctx, argc, argv, 4)
      );
      return JS_UNDEFINED;
    case HostSetCursorPos:
      ui_set_cursor_pos(
        (float)argument_float(ctx, argc, argv, 0),
        (float)argument_float(ctx, argc, argv, 1)
      );
      return JS_UNDEFINED;
    case HostLoadStyles:
    case HostLoadFontAtlas:
      if (!argument_bytes(ctx, argc, argv, 0, &bytes, &byte_length)) {
        return JS_NewBool(ctx, 0);
      }
      return JS_NewBool(
        ctx,
        magic == HostLoadStyles
          ? ui_load_styles(bytes, byte_length)
          : ui_load_font_atlas(bytes, byte_length)
      );
    case HostMeasureText: {
      if (argc < 1) return JS_NewFloat64(ctx, 0.0);
      text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
      if (text == NULL) return JS_NewFloat64(ctx, 0.0);
      float width = ui_measure_text(
        (const uint8_t *)text,
        text_length,
        (uint32_t)argument_int(ctx, argc, argv, 1)
      );
      JS_FreeCString(ctx, text);
      return JS_NewFloat64(ctx, (double)width);
    }
    case HostLoadTileTexture: {
      /* spec op 23: decode ONE tile of a TILESET pak entry, looked up by key
       * in the installed pak (ui_feed_pak skips `ui:tile.*` — tiles stream on
       * demand). Missing pak, missing key and malformed entries are all -1. */
      if (argc < 2) return JS_NewInt32(ctx, -1);
      text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
      if (text == NULL) return JS_NewInt32(ctx, -1);
      const uint8_t *blob = NULL;
      size_t blob_length = ui_pak_find(
        installed_pack,
        installed_pack_length,
        (const uint8_t *)text,
        text_length,
        &blob
      );
      JS_FreeCString(ctx, text);
      if (blob_length == 0) return JS_NewInt32(ctx, -1);
      return JS_NewInt32(
        ctx,
        ui_upload_tileset_tile(blob, blob_length, (uint32_t)argument_int(ctx, argc, argv, 1))
      );
    }
    case HostFreeTexture:
      ui_free_texture(argument_int(ctx, argc, argv, 0));
      return JS_UNDEFINED;
    case HostUploadImgEntry:
      if (!argument_bytes(ctx, argc, argv, 0, &bytes, &byte_length)) {
        return JS_NewInt32(ctx, -1);
      }
      return JS_NewInt32(ctx, ui_upload_img_entry(bytes, byte_length));
    case HostDebugInspect:
      ui_debug_inspect(argument_int(ctx, argc, argv, 0));
      return JS_UNDEFINED;
    case HostDebugRectXY:
      return JS_NewInt32(ctx, ui_debug_rect_xy());
    case HostDebugRectWH:
      return JS_NewInt32(ctx, ui_debug_rect_wh());
    case HostDebugPause:
      ui_debug_pause(argument_int(ctx, argc, argv, 0));
      return JS_UNDEFINED;
    case HostDebugStep:
      ui_debug_step();
      return JS_UNDEFINED;
    case HostDebugStats:
      return JS_NewString(ctx, devserver_debug_stats());
    case HostDbgActive:
      return JS_NewBool(ctx, devserver_active());
    case HostDbgPoll: {
      size_t length = devserver_recv_ctrl(debug_poll_buffer, sizeof debug_poll_buffer);
      return length == 0
        ? JS_UNDEFINED
        : JS_NewStringLen(ctx, debug_poll_buffer, length);
    }
    case HostDbgSend:
      if (argc < 1) return JS_UNDEFINED;
      text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
      if (text != NULL) {
        devserver_send_ctrl(text, text_length);
        JS_FreeCString(ctx, text);
      }
      return JS_UNDEFINED;
    case HostOffloadCoverage: {
      if (coverage_used || argc < 4 || !JS_IsString(argv[0])) return JS_NewInt32(ctx, -1);
      JSValue length_value = JS_GetPropertyStr(ctx, argv[0], "length");
      int32_t chars = 0; JS_ToInt32(ctx, &chars, length_value); JS_FreeValue(ctx, length_value);
      if (chars > 2732) return JS_NewInt32(ctx, -1);
      coverage_used = true;
      text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
      int height = argument_int(ctx, argc, argv, 2);
      int envelope = text ? coverage_decode(text, text_length, argument_int(ctx, argc, argv, 1), height,
          (uint32_t)argument_int(ctx, argc, argv, 3), coverage_pixels) : 0;
      if (text) JS_FreeCString(ctx, text);
      if (!envelope) return JS_NewInt32(ctx, -1);
      if (argc > 4 && !JS_IsUndefined(argv[4])) {
        if (argc < 6 || !JS_IsString(argv[4]) || !JS_IsString(argv[5])) return JS_NewInt32(ctx, -1);
        for (int i = 4; i < 6; i++) {
          JSValue size_value = JS_GetPropertyStr(ctx, argv[i], "length");
          int32_t size = 0; JS_ToInt32(ctx, &size, size_value); JS_FreeValue(ctx, size_value);
          if (size > (i == 4 ? 512 : 96)) return JS_NewInt32(ctx, -1);
        }
        size_t columns_length = 0, palette_length = 0;
        const char *columns = JS_ToCStringLen2(ctx, &columns_length, argv[4], 0);
        const char *palette = JS_ToCStringLen2(ctx, &palette_length, argv[5], 0);
        int valid = columns && palette && coverage_colorize(columns, columns_length, palette, palette_length,
          argument_int(ctx, argc, argv, 1), height, envelope, coverage_pixels);
        if (columns) JS_FreeCString(ctx, columns); if (palette) JS_FreeCString(ctx, palette);
        if (!valid) return JS_NewInt32(ctx, -1);
      }
      unsigned padded_height = 8; while (padded_height < (unsigned)height) padded_height *= 2;
      return JS_NewInt32(ctx, ui_upload_texture(coverage_pixels, envelope * padded_height * 4, envelope, padded_height, 3));
    }
    case HostOffloadSession: return JS_NewInt32(ctx, offload_session());
    case HostOffloadSubmit: {
      if (argc < 1 || !JS_IsString(argv[0])) return JS_FALSE;
      /* Reject before UTF-8 flattening: string length is a constant-time op. */
      JSValue length_value = JS_GetPropertyStr(ctx, argv[0], "length");
      int32_t chars = 0; JS_ToInt32(ctx, &chars, length_value); JS_FreeValue(ctx, length_value);
      if (chars > 4096) return JS_FALSE;
      text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
      bool ok = text && offload_submit(text, text_length);
      if (text) JS_FreeCString(ctx, text);
      return JS_NewBool(ctx, ok);
    }
    case HostOffloadTake: {
      size_t length = offload_take(debug_poll_buffer);
      return length ? JS_NewStringLen(ctx, debug_poll_buffer, length) : JS_UNDEFINED;
    }
    case HostDbgShot:
      return JS_NewBool(ctx, devserver_request_screenshot());
    case HostSvcOpen: {
      if (argc < 1) return JS_NewBool(ctx, 0);
      text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
      if (text == NULL) return JS_NewBool(ctx, 0);
      bool open = svcwire_open(text);
      JS_FreeCString(ctx, text);
      return JS_NewBool(ctx, open);
    }
    case HostSvcPoll: {
      size_t length = svcwire_recv_lines(svc_poll_buffer, sizeof svc_poll_buffer);
      return length == 0 ? JS_UNDEFINED : JS_NewStringLen(ctx, svc_poll_buffer, length);
    }
    case HostSvcSend:
      if (argc < 1) return JS_UNDEFINED;
      text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
      if (text != NULL) {
        svcwire_send_line(text, text_length);
        JS_FreeCString(ctx, text);
      }
      return JS_UNDEFINED;
  }
  return JS_UNDEFINED;
}

static void add_operation(
  JSValueConst object,
  const char *name,
  int arity,
  HostOperation operation
) {
  JS_SetPropertyStr(
    context,
    object,
    name,
    JS_NewCFunctionMagic(
      context,
      host_operation,
      name,
      arity,
      JS_CFUNC_generic_magic,
      (int)operation
    )
  );
}

/* Pak names are borrowed length-delimited slices; JS_SetPropertyStr needs a
 * NUL-terminated key. */
static void set_named_property(JSValueConst object, const uint8_t *name, size_t length, JSValue value) {
  char *key = malloc(length + 1);
  if (key == NULL) {
    JS_FreeValue(context, value);
    return;
  }
  memcpy(key, name, length);
  key[length] = '\0';
  JS_SetPropertyStr(context, object, key, value);
  free(key);
}

static void install_host(void) {
#ifdef POCKETJS_MEDIA
  JSValue media=JS_NewObject(context);
  add_operation(media,"open",3,HostMediaOpen);
  add_operation(media,"close",0,HostMediaClose);
  add_operation(media,"paused",1,HostMediaPaused);
  add_operation(media,"volume",1,HostMediaVolume);
  add_operation(media,"texture",0,HostMediaTexture);
  add_operation(media,"status",0,HostMediaStatus);
  JS_SetPropertyStr(context,global,"media",media);
#endif
#ifdef POCKETJS_OFFLOAD
  JSValue offload = JS_NewObject(context);
  add_operation(offload, "uploadCoverage", 6, HostOffloadCoverage);
  add_operation(offload, "session", 0, HostOffloadSession);
  add_operation(offload, "submit", 1, HostOffloadSubmit);
  add_operation(offload, "take", 0, HostOffloadTake);
  JS_SetPropertyStr(context, global, "offload", offload);
#endif
  JSValue ui = JS_NewObject(context);

  add_operation(ui, "createNode", 1, HostCreateNode);
  add_operation(ui, "destroyNode", 1, HostDestroyNode);
  add_operation(ui, "insertBefore", 3, HostInsertBefore);
  add_operation(ui, "removeChild", 2, HostRemoveChild);
  add_operation(ui, "setStyle", 2, HostSetStyle);
  add_operation(ui, "setProp", 3, HostSetProp);
  add_operation(ui, "setPropBatch", 1, HostSetPropBatch);
  add_operation(ui, "setText", 2, HostSetText);
  add_operation(ui, "replaceText", 2, HostReplaceText);
  add_operation(ui, "uploadTexture", 4, HostUploadTexture);
  add_operation(ui, "setImage", 2, HostSetImage);
  add_operation(ui, "setSprite", 5, HostSetSprite);
  add_operation(ui, "animate", 6, HostAnimate);
  add_operation(ui, "cancelAnim", 1, HostCancelAnim);
  add_operation(ui, "setFocus", 1, HostSetFocus);
  add_operation(ui, "setActive", 2, HostSetActive);
  /* Virtual cursor ops (spec ops 27..29, 42; input.cursor). */
  add_operation(ui, "hitTest", 2, HostHitTest);
  add_operation(ui, "hitTestBounds", 2, HostHitTestBounds);
  add_operation(ui, "hitTestAuxiliary", 2, HostHitTestAuxiliary);
  add_operation(ui, "hitTestBoundsAuxiliary", 2, HostHitTestBoundsAuxiliary);
  add_operation(ui, "setCursor", 5, HostSetCursor);
  add_operation(ui, "setCursorPos", 2, HostSetCursorPos);
  add_operation(ui, "loadStyles", 1, HostLoadStyles);
  add_operation(ui, "loadFontAtlas", 1, HostLoadFontAtlas);
  add_operation(ui, "measureText", 2, HostMeasureText);
  /* Texture streaming ops (spec ops 23..25: deep-zoom tiles + dynamic IMGs). */
  add_operation(ui, "loadTileTexture", 2, HostLoadTileTexture);
  add_operation(ui, "freeTexture", 1, HostFreeTexture);
  add_operation(ui, "uploadImgEntry", 1, HostUploadImgEntry);
  /* DevTools ops (docs/DEVTOOLS.md; debug-only, default-off). */
  add_operation(ui, "debugInspect", 1, HostDebugInspect);
  add_operation(ui, "debugRectXY", 0, HostDebugRectXY);
  add_operation(ui, "debugRectWH", 0, HostDebugRectWH);
  add_operation(ui, "debugPause", 1, HostDebugPause);
  add_operation(ui, "debugStep", 0, HostDebugStep);
  add_operation(ui, "debugStats", 0, HostDebugStats);
  add_operation(ui, "__dbgActive", 0, HostDbgActive);
  add_operation(ui, "__dbgPoll", 0, HostDbgPoll);
  add_operation(ui, "__dbgSend", 1, HostDbgSend);
  add_operation(ui, "__dbgShot", 0, HostDbgShot);
  /* Host service channel (spec ops 30..32) over the SVC WIRE transport. */
  add_operation(ui, "svcOpen", 1, HostSvcOpen);
  add_operation(ui, "svcPoll", 0, HostSvcPoll);
  add_operation(ui, "svcSend", 1, HostSvcSend);

  /* Framework-owned host identity, from the build's -D defines rather than
   * literals that can drift. Bundles refuse to mount when they disagree. */
  JS_SetPropertyStr(context, ui, "__host", JS_NewString(context, POCKETJS_TARGET_ID));
  JS_SetPropertyStr(context, ui, "__hostAbi", JS_NewInt32(context, POCKETJS_HOST_ABI));

  /*
   * The logical UI size. framework/src/index.ts sizes the mounted app and
   * overlay layers from this and falls back to the 480x272 spec screen when a
   * host omits it, which lays a 400x240 app out 80 px too wide and carries
   * every right-anchored element off the panel. Read back from the core —
   * main.c calls ui_set_viewport before qjs_boot — so the JS layers and the
   * native root cannot drift apart. A size, not a live-resize capability:
   * that needs installResizeViewportHook, which a takeover host never calls.
   */
  JSValue viewport = JS_NewObject(context);
  JS_SetPropertyStr(context, viewport, "w", JS_NewInt32(context, (int32_t)ui_viewport_width()));
  JS_SetPropertyStr(context, viewport, "h", JS_NewInt32(context, (int32_t)ui_viewport_height()));
  JS_SetPropertyStr(context, ui, "__viewport", viewport);

  JSValue auxiliary = JS_NewObject(context);
  JS_SetPropertyStr(
    context,
    auxiliary,
    "root",
    JS_NewInt32(context, ui_auxiliary_surface_root())
  );
  JS_SetPropertyStr(
    context,
    auxiliary,
    "w",
    JS_NewInt32(context, (int32_t)ui_auxiliary_viewport_width())
  );
  JS_SetPropertyStr(
    context,
    auxiliary,
    "h",
    JS_NewInt32(context, (int32_t)ui_auxiliary_viewport_height())
  );
  JS_SetPropertyStr(context, ui, "__auxiliarySurface", auxiliary);

  JSValue textures = JS_NewObject(context);
  for (size_t index = 0; index < ui_pak_texture_count(); index += 1) {
    set_named_property(
      textures,
      ui_pak_texture_name(index),
      ui_pak_texture_name_len(index),
      JS_NewInt32(context, ui_pak_texture_handle(index))
    );
  }
  JS_SetPropertyStr(context, ui, "__textures", textures);

  JSValue sprites = JS_NewObject(context);
  for (size_t index = 0; index < ui_pak_sprite_count(); index += 1) {
    JSValue meta = JS_NewObject(context);
    JS_SetPropertyStr(context, meta, "handle", JS_NewInt32(context, ui_pak_sprite_handle(index)));
    JS_SetPropertyStr(
      context,
      meta,
      "frames",
      JS_NewInt32(context, (int32_t)ui_pak_sprite_frames(index))
    );
    JS_SetPropertyStr(
      context,
      meta,
      "cols",
      JS_NewInt32(context, (int32_t)ui_pak_sprite_columns(index))
    );
    JS_SetPropertyStr(
      context,
      meta,
      "step",
      JS_NewInt32(context, (int32_t)ui_pak_sprite_step(index))
    );
    set_named_property(sprites, ui_pak_sprite_name(index), ui_pak_sprite_name_len(index), meta);
  }
  JS_SetPropertyStr(context, ui, "__sprites", sprites);

  /* JS_SetPropertyStr consumes ownership of `ui`. */
  JS_SetPropertyStr(context, global, "ui", ui);
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

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

bool qjs_boot(
  const char *source,
  size_t source_length,
  const uint8_t *pack,
  size_t pack_length
) {
  last_error[0] = '\0';
  installed_pack = pack;
  installed_pack_length = pack_length;
  frame_function = JS_UNDEFINED;
  global = JS_UNDEFINED;

  runtime = JS_NewRuntime();
  if (runtime == NULL) {
    set_error("JS_NewRuntime returned null");
    return false;
  }
  JS_SetMaxStackSize(runtime, POCKETJS_JS_STACK_SIZE);
  context = JS_NewContext(runtime);
  if (context == NULL) {
    set_error("JS_NewContext returned null");
    return false;
  }
  global = JS_GetGlobalObject(context);
  install_host();

  /* The pak is exposed read-only and zero-copy (free_func 0): it lives in the
   * host's own allocation for the process lifetime. The core was already fed
   * from it natively, so this is only for the framework paths that read pak
   * entries themselves (framework/src/tiles.ts). */
  if (pack != NULL && pack_length > 0) {
    JS_SetPropertyStr(
      context,
      global,
      "__pak",
      JS_NewArrayBuffer(context, (uint8_t *)pack, pack_length, NULL, NULL, 0)
    );
  }
  /* The bundle mounts synchronously during JS_Eval and resetClock() latches
   * this at mount, so install it beforehand. */
  JS_SetPropertyStr(context, global, "__simHz", JS_NewInt32(context, POCKETJS_SIMULATION_HZ));

  JSValue result = JS_Eval(context, source, source_length, "app.js", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(result)) {
    take_exception();
    return false;
  }
  JS_FreeValue(context, result);

  frame_function = JS_GetPropertyStr(context, global, "frame");
  if (!JS_IsFunction(context, frame_function)) {
    set_error("app.js did not install globalThis.frame");
    return false;
  }
  return drain_jobs();
}

bool qjs_frame(
  int32_t buttons,
  int32_t analog,
  const uint32_t *touches,
  const int32_t *hits,
  size_t touch_count,
  int32_t right_analog
) {
  if (context == NULL) return false;
  offload_frame();
  coverage_used = false;
  JSValue arguments[6] = {
    JS_NewInt32(context, buttons),
    JS_NewInt32(context, analog),
    JS_NewArray(context),
    JS_NewArray(context),
    JS_NewArray(context),
    JS_NewInt32(context, right_analog),
  };
  for (size_t index = 0; index < touch_count && index < 8; index += 1) {
    JS_SetPropertyUint32(
      context,
      arguments[2],
      (uint32_t)index,
      JS_NewUint32(context, touches[index])
    );
    JS_SetPropertyUint32(
      context,
      arguments[3],
      (uint32_t)index,
      JS_NewInt32(context, hits[index])
    );
    /* 1 = auxiliary output; the 3DS touch panel is the bottom screen. */
    JS_SetPropertyUint32(context, arguments[4], (uint32_t)index, JS_NewInt32(context, 1));
  }
  JSValue result = JS_Call(context, frame_function, global, 6, arguments);
  for (size_t index = 0; index < 6; index += 1) JS_FreeValue(context, arguments[index]);
  if (JS_IsException(result)) {
    take_exception();
    JS_FreeValue(context, result);
    return false;
  }
  /* Leak guard: the return value is freed every frame. */
  JS_FreeValue(context, result);
  return drain_jobs();
}

const char *qjs_last_error(void) {
  return last_error;
}

void qjs_shutdown(void) {
#ifdef POCKETJS_MEDIA
  media_forget_guest();
#endif
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
  installed_pack = NULL;
  installed_pack_length = 0;
}
