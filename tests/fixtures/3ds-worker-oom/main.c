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
static JSValue new_function(JSContext *ctx, JSCFunction *fn, const char *name, int arity) {
  return fail() ? JS_ThrowOutOfMemory(ctx) : JS_NewCFunction(ctx, fn, name, arity);
}
static int set_string(JSContext *ctx, JSValueConst object, const char *key, JSValue value) {
  assert(!JS_IsException(object) && !JS_IsException(value));
  if (!fail()) return JS_SetPropertyStr(ctx, object, key, value);
  JS_FreeValue(ctx, value);
  JS_ThrowOutOfMemory(ctx);
  return -1;
}
#define JS_NewObject new_object
#define JS_NewCFunction new_function
#define JS_SetPropertyStr set_string
#include "../../../platforms/3ds/worker.c"

/* The UI channel bridge is engine/worker/src/quickjs_ui.c; its allocation
 * paths run in engine/worker/tests/quickjs.c. */
static void console_mount_path(void) {
  unsigned failed = 0, succeeded = 0;
  for (int point = 0; point < 32; ++point) {
    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);
    assert(rt && ctx);
    Worker *w = calloc(1, sizeof *w);
    assert(w);
    atomic_init(&w->stopping, false);
    active = w;
    fail_at = point;
    calls = 0;
    int status = mount_worker(w, ctx);
    fail_at = -1;
    if (status == POCKET_WORKER_FAILED) {
      ++failed;
      JSValue error = JS_GetException(ctx);
      assert(!JS_IsNull(error) && !JS_IsUndefined(error));
      JS_FreeValue(ctx, error);
      /* A failed mount leaves no half-built console behind. */
      JSValue global = JS_GetGlobalObject(ctx);
      JSValue mounted = JS_GetPropertyStr(ctx, global, "console");
      assert(JS_IsUndefined(mounted));
      JS_FreeValue(ctx, mounted);
      JS_FreeValue(ctx, global);
    } else {
      assert(status == POCKET_WORKER_OK);
      ++succeeded;
    }
    active = NULL;
    free(w);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
  }
  printf("3DS worker console mount: %u failures, %u successes\n", failed, succeeded);
  fflush(stdout);
  assert(failed && succeeded);
}
int main(void) {
  console_mount_path();
  return 0;
}
