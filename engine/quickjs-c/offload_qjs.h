/* Included by pocket_runtime.c only on hosts with the POSIX worker. */
#include "offload_posix.h"
#include "offload_coverage.h"
#include <stdio.h>
#include <stdlib.h>
static unsigned offload_submissions, offload_deliveries, offload_uploads;
static char offload_key_path[1024];
static uint8_t offload_pixels[512 * 16 * 4];
static int offload_bounded_string(JSContext *ctx, JSValueConst value) {
  if (!JS_IsString(value)) return 0;
  JSValue count = JS_GetPropertyStr(ctx, value, "length");
  int32_t length = -1;
  int ok = JS_ToInt32(ctx, &length, count) == 0 && length >= 0 && length <= 4096;
  JS_FreeValue(ctx, count);
  return ok;
}
void pocket_runtime_offload_key(const char *path) {
  if (path && strlen(path) < sizeof offload_key_path) strcpy(offload_key_path, path);
}
static JSValue offload_operation(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int op) {
  (void)self;
  if (op == 0) return JS_NewUint32(ctx, pocket_offload_session());
  if (op == 2) {
    char bytes[4096];
    if (offload_deliveries++) return JS_UNDEFINED;
    size_t length = pocket_offload_take(bytes);
    return length ? JS_NewStringLen(ctx, bytes, length) : JS_UNDEFINED;
  }
  if (argc < 1 || !offload_bounded_string(ctx, argv[0])) return JS_UNDEFINED;
  size_t length;
  const char *text = JS_ToCStringLen(ctx, &length, argv[0]);
  if (!text) return JS_EXCEPTION;
  if (op == 1) {
    int accepted = offload_submissions < 2 && pocket_offload_submit(text, length);
    if (accepted) offload_submissions++;
    JS_FreeCString(ctx, text);
    return JS_NewBool(ctx, accepted);
  }
  uint32_t width = 0, height = 0, color = 0;
  int texture = 0;
  if (argc >= 4 && !offload_uploads && JS_ToUint32(ctx, &width, argv[1]) == 0 &&
      JS_ToUint32(ctx, &height, argv[2]) == 0 && JS_ToUint32(ctx, &color, argv[3]) == 0) {
    int envelope = coverage_decode(text, length, width, height, color, offload_pixels);
    if (envelope && argc >= 6 && (!JS_IsUndefined(argv[4]) || !JS_IsUndefined(argv[5]))) {
      size_t cn = 0, pn = 0;
      const char *columns = offload_bounded_string(ctx, argv[4]) ? JS_ToCStringLen(ctx, &cn, argv[4]) : NULL;
      const char *palette = offload_bounded_string(ctx, argv[5]) ? JS_ToCStringLen(ctx, &pn, argv[5]) : NULL;
      if (!columns || !palette || !coverage_colorize(columns, cn, palette, pn, width, height, (unsigned)envelope, offload_pixels)) envelope = 0;
      if (columns) JS_FreeCString(ctx, columns);
      if (palette) JS_FreeCString(ctx, palette);
    }
    if (envelope) {
      unsigned padded_height = coverage_height(height);
      texture = ui_upload_texture(offload_pixels, (size_t)envelope * padded_height * 4, (unsigned)envelope, padded_height, 3);
      offload_uploads++;
    }
  }
  JS_FreeCString(ctx, text);
  return JS_NewInt32(ctx, texture);
}
static int install_offload(JSContext *ctx, JSValue target) {
  JSValue ops = JS_NewObject(ctx);
  const char *names[] = {"session", "submit", "take", "uploadCoverage"};
  int arities[] = {0, 1, 0, 6};
  for (int i = 0; i < 4; i++) {
    JSValue fn = JS_NewCFunctionMagic(ctx, offload_operation, names[i], arities[i], JS_CFUNC_generic_magic, i);
    if (JS_SetPropertyStr(ctx, ops, names[i], fn) < 0) { JS_FreeValue(ctx, ops); return 0; }
  }
  if (JS_SetPropertyStr(ctx, target, "offload", ops) < 0) return 0;
  if (!offload_key_path[0]) {
    const char *directory = getenv("HOME");
    if (directory) snprintf(offload_key_path, sizeof offload_key_path, "%s/Documents/offload.key", directory);
  }
  pocket_offload_start(offload_key_path, 8741);
  return 1;
}
