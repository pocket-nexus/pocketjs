#include "quickjs.h"
#include <assert.h>
/* Fail one public allocation at a time. QuickJS's object pools can satisfy
 * these small mounts without calling malloc, so a heap limit alone does not
 * exercise every constructor and property insertion. */
static int fail_at, calls;
static int fail(void) { return calls++ == fail_at; }
static JSValue new_object(JSContext *ctx) {
  return fail() ? JS_ThrowOutOfMemory(ctx) : JS_NewObject(ctx);
}
static JSValue new_array(JSContext *ctx) {
  return fail() ? JS_ThrowOutOfMemory(ctx) : JS_NewArray(ctx);
}
static JSValue new_function(JSContext *ctx, JSCFunction *fn, const char *name, int arity) {
  return fail() ? JS_ThrowOutOfMemory(ctx) : JS_NewCFunction(ctx, fn, name, arity);
}
static JSValue new_magic(JSContext *ctx, JSCFunctionMagic *fn, const char *name,
                          int arity, JSCFunctionEnum prototype, int magic) {
  return fail() ? JS_ThrowOutOfMemory(ctx) : JS_NewCFunctionMagic(ctx, fn, name, arity, prototype, magic);
}
static JSValue new_buffer(JSContext *ctx, const uint8_t *bytes, size_t length) {
  return fail() ? JS_ThrowOutOfMemory(ctx) : JS_NewArrayBufferCopy(ctx, bytes, length);
}
static JSValue new_typed(JSContext *ctx, int argc, JSValueConst *args, JSTypedArrayEnum kind) {
  for (int i = 0; i < argc; ++i) assert(!JS_IsException(args[i]));
  return fail() ? JS_ThrowOutOfMemory(ctx) : JS_NewTypedArray(ctx, argc, args, kind);
}
static int set_string(JSContext *ctx, JSValueConst object, const char *key, JSValue value) {
  assert(!JS_IsException(object) && !JS_IsException(value));
  if (!fail()) return JS_SetPropertyStr(ctx, object, key, value);
  JS_FreeValue(ctx, value);
  JS_ThrowOutOfMemory(ctx);
  return -1;
}
static int set_index(JSContext *ctx, JSValueConst object, uint32_t key, JSValue value) {
  assert(!JS_IsException(object) && !JS_IsException(value));
  if (!fail()) return JS_SetPropertyUint32(ctx, object, key, value);
  JS_FreeValue(ctx, value);
  JS_ThrowOutOfMemory(ctx);
  return -1;
}
#define JS_NewObject new_object
#define JS_NewArray new_array
#define JS_NewCFunction new_function
#define JS_NewCFunctionMagic new_magic
#define JS_NewArrayBufferCopy new_buffer
#define JS_NewTypedArray new_typed
#define JS_SetPropertyStr set_string
#define JS_SetPropertyUint32 set_index
#include "../../../platforms/3ds/worker.c"

static void allocation_path(int operation) {
  unsigned failed = 0, succeeded = 0;
  for (int point = 0; point < 32; ++point) {
    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);
    assert(rt && ctx);
    Worker *w = calloc(1, sizeof *w);
    assert(w);
    atomic_init(&w->stopping, false);
    w->mirrors[0].count = 2;
    w->mirrors[0].lengths[0] = w->mirrors[0].lengths[1] = 1024;
    memset(w->mirrors[0].bytes, 0x42, sizeof w->mirrors[0].bytes);
    active = w;
    fail_at = point;
    calls = 0;
    JSValue value = JS_UNDEFINED;
    int status;
    if (operation == 0)
      status = mount_worker(w, ctx);
    else if (operation == 1)
      status = pocket_3ds_worker_mount_ui(ctx);
    else {
      JSValue id = JS_NewInt32(ctx, 1);
      value = ui_channel(ctx, JS_UNDEFINED, 1, &id, 2);
      status = JS_IsException(value) ? POCKET_WORKER_FAILED : POCKET_WORKER_OK;
    }
    fail_at = -1;
    if (status == POCKET_WORKER_FAILED) {
      ++failed;
      JSValue error = JS_GetException(ctx);
      assert(!JS_IsNull(error) && !JS_IsUndefined(error));
      JS_FreeValue(ctx, error);
      if (operation < 2) {
        JSValue global = JS_GetGlobalObject(ctx);
        JSValue mounted = JS_GetPropertyStr(ctx, global,
            operation ? "__pocketWorkerChannels" : "console");
        assert(JS_IsUndefined(mounted));
        JS_FreeValue(ctx, mounted);
        JS_FreeValue(ctx, global);
      }
    } else {
      assert(status == POCKET_WORKER_OK);
      ++succeeded;
    }
    JS_FreeValue(ctx, value);
    if (operation == 2) {
      /* Failed copies leave the frame mirror intact for a later read. */
      JSValue id = JS_NewInt32(ctx, 1);
      JSValue retry = ui_channel(ctx, JS_UNDEFINED, 1, &id, 2);
      if (JS_IsException(retry)) {
        JSValue error = JS_GetException(ctx);
        const char *message = JS_ToCString(ctx, error);
        fprintf(stderr, "observe retry at allocation %d: %s\n", point, message ? message : "unknown");
        JS_FreeCString(ctx, message);
        JS_FreeValue(ctx, error);
      }
      assert(!JS_IsException(retry));
      JSValue first = JS_GetPropertyUint32(ctx, retry, 0);
      size_t offset, length, element;
      JSValue buffer = JS_GetTypedArrayBuffer(ctx, first, &offset, &length, &element);
      assert(!JS_IsException(buffer) && length == 1024 && element == 1);
      size_t capacity;
      uint8_t *data = JS_GetArrayBuffer(ctx, &capacity, buffer);
      assert(data && data[offset] == 0x42);
      JS_FreeValue(ctx, buffer);
      JS_FreeValue(ctx, first);
      JS_FreeValue(ctx, retry);
    }
    active = NULL;
    free(w);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
  }
  printf("3DS QuickJS allocation path %d: %u failures, %u successes\n",
         operation, failed, succeeded);
  fflush(stdout);
  assert(failed && succeeded);
}
int main(void) {
  allocation_path(0);
  allocation_path(1);
  allocation_path(2);
  return 0;
}
