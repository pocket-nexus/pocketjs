#include "pocket/worker_ui.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  uint8_t *bytes;
  uint32_t lengths[POCKET_WORKER_MAX_EVENTS];
  uint32_t snapshot, count;
} ui_mirror;
struct pocket_worker_ui {
  JSContext *context;
  pocket_worker *worker;
  JSValue token, namespace;
  ui_mirror mirrors[POCKET_WORKER_MAX_CHANNELS];
};
enum { UI_CONFIGURE, UI_PUBLISH, UI_OBSERVE };
static int uint_arg(JSContext *c, JSValueConst arg, uint32_t *out) {
  double value;
  if (JS_ToFloat64(c, &value, arg) < 0)
    return -1;
  if (!isfinite(value) || value < 0 || value > UINT32_MAX ||
      floor(value) != value) {
    JS_ThrowRangeError(c, "invalid channel integer");
    return -1;
  }
  *out = (uint32_t)value;
  return 0;
}
static JSValue array_copy(JSContext *c, const uint8_t *bytes, size_t length) {
  JSValue buffer = JS_NewArrayBufferCopy(c, bytes, length);
  if (JS_IsException(buffer))
    return buffer;
  JSValue args[3] = {buffer, JS_UNDEFINED, JS_UNDEFINED};
  JSValue result = JS_NewTypedArray(c, 3, args, JS_TYPED_ARRAY_UINT8);
  JS_FreeValue(c, buffer);
  return result;
}
static JSValue channel_op(JSContext *c, JSValueConst self, int argc,
                          JSValueConst *args, int op, JSValue *data) {
  (void)self;
  size_t size = 0;
  uint8_t *bytes = JS_GetArrayBuffer(c, &size, data[0]);
  pocket_worker_ui *bridge = NULL;
  if (bytes && size == sizeof bridge)
    memcpy(&bridge, bytes, sizeof bridge);
  if (!bridge)
    return JS_ThrowInternalError(c, "inactive worker channel bridge");
  if (argc < (op == UI_OBSERVE ? 1 : 2))
    return JS_ThrowTypeError(c, "missing channel argument");
  uint32_t id;
  if (uint_arg(c, args[0], &id) < 0)
    return JS_EXCEPTION;
  if (!id || id > POCKET_WORKER_MAX_CHANNELS)
    return JS_ThrowRangeError(c, "channel id out of range");
  ui_mirror *mirror = &bridge->mirrors[id - 1];
  if (op == UI_CONFIGURE) {
    uint32_t snapshot;
    if (uint_arg(c, args[1], &snapshot) < 0)
      return JS_EXCEPTION;
    if (snapshot > 1)
      return JS_NewInt32(c, POCKET_WORKER_INVALID);
    if (mirror->bytes)
      return JS_NewInt32(c, mirror->snapshot == snapshot
                                ? POCKET_WORKER_OK
                                : POCKET_WORKER_INVALID);
    mirror->bytes = calloc(snapshot ? 1 : POCKET_WORKER_MAX_EVENTS,
                           POCKET_WORKER_MAX_PAYLOAD);
    if (!mirror->bytes)
      return JS_ThrowOutOfMemory(c);
    mirror->snapshot = snapshot;
    return JS_NewInt32(c, POCKET_WORKER_OK);
  }
  if (!mirror->bytes)
    return JS_ThrowTypeError(c, "channel is not configured");
  if (op == UI_PUBLISH) {
    size_t offset = 0, length = 0, element = 0, backing = 0;
    JSValue buffer =
        JS_GetTypedArrayBuffer(c, args[1], &offset, &length, &element);
    if (JS_IsException(buffer))
      return buffer;
    uint8_t *payload = JS_GetArrayBuffer(c, &backing, buffer);
    if (element != 1 || offset > backing || length > backing - offset ||
        (length && !payload)) {
      JS_FreeValue(c, buffer);
      return JS_ThrowTypeError(c, "expected channel byte array");
    }
    int32_t result = pocket_worker_receive(
        bridge->worker, id, payload ? payload + offset : NULL, length);
    JS_FreeValue(c, buffer);
    return JS_NewInt32(c, result);
  }
  JSValue result = JS_NewArray(c);
  if (JS_IsException(result))
    return result;
  for (uint32_t i = 0; i < mirror->count; i++) {
    JSValue value =
        array_copy(c, mirror->bytes + (size_t)i * POCKET_WORKER_MAX_PAYLOAD,
                   mirror->lengths[i]);
    if (JS_IsException(value)) {
      JS_FreeValue(c, result);
      return value;
    }
    if (JS_SetPropertyUint32(c, result, i, value) < 0) {
      JS_FreeValue(c, result);
      return JS_EXCEPTION;
    }
  }
  return result;
}
pocket_worker_ui *pocket_worker_ui_attach(JSContext *c, pocket_worker *worker) {
  if (!c || !worker)
    return NULL;
  pocket_worker_ui *bridge = calloc(1, sizeof *bridge);
  if (!bridge)
    return NULL;
  bridge->context = c;
  bridge->worker = worker;
  bridge->token = JS_UNDEFINED;
  bridge->namespace = JS_UNDEFINED;
  JSValue global = JS_GetGlobalObject(c);
  JSValue previous = JS_GetPropertyStr(c, global, "__pocketWorkerChannels");
  if (JS_IsException(previous) || !JS_IsUndefined(previous)) {
    JS_FreeValue(c, previous);
    JS_FreeValue(c, global);
    free(bridge);
    return NULL;
  }
  JS_FreeValue(c, previous);
  bridge->token =
      JS_NewArrayBufferCopy(c, (const uint8_t *)&bridge, sizeof bridge);
  bridge->namespace = JS_NewObject(c);
  if (JS_IsException(bridge->token) || JS_IsException(bridge->namespace))
    goto failed;
  const char *names[] = {"configure", "publish", "observe"};
  for (int i = 0; i < 3; i++) {
    JSValue fn = JS_NewCFunctionData(c, channel_op, i == UI_OBSERVE ? 1 : 2, i,
                                     1, &bridge->token);
    if (JS_IsException(fn) ||
        JS_SetPropertyStr(c, bridge->namespace, names[i], fn) < 0)
      goto failed;
  }
  if (JS_SetPropertyStr(c, global, "__pocketWorkerChannels",
                        JS_DupValue(c, bridge->namespace)) < 0)
    goto failed;
  JS_FreeValue(c, global);
  return bridge;
failed:
  JS_FreeValue(c, global);
  pocket_worker_ui_detach(bridge);
  return NULL;
}
int32_t pocket_worker_ui_latch(pocket_worker_ui *bridge) {
  if (!bridge)
    return POCKET_WORKER_INVALID;
  for (uint32_t i = 0; i < POCKET_WORKER_MAX_CHANNELS; i++) {
    ui_mirror *mirror = &bridge->mirrors[i];
    if (!mirror->bytes)
      continue;
    if (!mirror->snapshot)
      mirror->count = 0;
    uint32_t limit = mirror->snapshot ? 1 : POCKET_WORKER_MAX_EVENTS;
    for (uint32_t n = 0; n < limit; n++) {
      int32_t length = pocket_worker_channel_take(
          bridge->worker, i + 1,
          mirror->bytes + (size_t)n * POCKET_WORKER_MAX_PAYLOAD,
          POCKET_WORKER_MAX_PAYLOAD);
      if (length < 0)
        break;
      mirror->lengths[n] = (uint32_t)length;
      mirror->count = n + 1;
    }
  }
  JSContext *c = bridge->context;
  JSValue global = JS_GetGlobalObject(c);
  JSValue hook = JS_GetPropertyStr(c, global, "__pocketWorkerChannelFrame");
  JS_FreeValue(c, global);
  if (JS_IsException(hook))
    return POCKET_WORKER_FAILED;
  if (JS_IsFunction(c, hook)) {
    JSValue result = JS_Call(c, hook, JS_UNDEFINED, 0, NULL);
    JS_FreeValue(c, hook);
    if (JS_IsException(result))
      return POCKET_WORKER_FAILED;
    JS_FreeValue(c, result);
  } else
    JS_FreeValue(c, hook);
  return POCKET_WORKER_OK;
}
void pocket_worker_ui_detach(pocket_worker_ui *bridge) {
  if (!bridge)
    return;
  JSContext *c = bridge->context;
  if (!JS_IsUndefined(bridge->token) && !JS_IsException(bridge->token))
    JS_DetachArrayBuffer(c, bridge->token);
  JSValue global = JS_GetGlobalObject(c),
          current = JS_GetPropertyStr(c, global, "__pocketWorkerChannels");
  if (JS_IsObject(current) && JS_IsObject(bridge->namespace) &&
      JS_VALUE_GET_PTR(current) == JS_VALUE_GET_PTR(bridge->namespace)) {
    JSAtom name = JS_NewAtom(c, "__pocketWorkerChannels");
    JS_DeleteProperty(c, global, name, 0);
    JS_FreeAtom(c, name);
  }
  JS_FreeValue(c, current);
  JS_FreeValue(c, global);
  JS_FreeValue(c, bridge->namespace);
  JS_FreeValue(c, bridge->token);
  for (size_t i = 0; i < POCKET_WORKER_MAX_CHANNELS; i++)
    free(bridge->mirrors[i].bytes);
  free(bridge);
}
