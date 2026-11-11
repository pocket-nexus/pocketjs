/* A guest bundle compiled in a QuickJS runtime of its own (bundle_compile.h). */

#include "bundle_compile.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"

/* The pending exception as one line: its message, then its stack, as qjs.c
 * reports a boot's exception. */
static void exception_text(JSContext *context, char *error, size_t error_length) {
  if (error_length == 0) return;
  JSValue exception = JS_GetException(context);
  size_t length = 0;
  const char *message = JS_ToCStringLen2(context, &length, exception, 0);
  size_t used = 0;
  if (message != NULL) {
    used = length < error_length - 1 ? length : error_length - 1;
    memcpy(error, message, used);
    JS_FreeCString(context, message);
  } else {
    used = (size_t)snprintf(error, error_length, "QuickJS exception");
    if (used >= error_length) used = error_length - 1;
  }
  error[used] = '\0';
  if (JS_IsObject(exception) && used + 2 < error_length) {
    JSValue stack = JS_GetPropertyStr(context, exception, "stack");
    size_t stack_length = 0;
    const char *frames = JS_IsException(stack) ? NULL : JS_ToCStringLen2(context, &stack_length, stack, 0);
    if (frames != NULL) {
      size_t room = error_length - 1 - used - 1;
      size_t copy = stack_length < room ? stack_length : room;
      error[used] = ' ';
      for (size_t i = 0; i < copy; i += 1) error[used + 1 + i] = frames[i] == '\n' ? ' ' : frames[i];
      error[used + 1 + copy] = '\0';
      JS_FreeCString(context, frames);
    }
    JS_FreeValue(context, stack);
  }
  JS_FreeValue(context, exception);
}

uint8_t *bundle_compile(const uint8_t *code, size_t length, size_t stack_bytes, size_t memory_limit, size_t *bytecode_length, char *error, size_t error_length) {
  if (error_length > 0) error[0] = '\0';
  *bytecode_length = 0;
  /* JS_Eval reads the source up to its NUL: a section without one is
   * evaluated by the guest's own evaluate, which copies it. */
  if (code == NULL || length < 2 || code[length - 1] != 0) return NULL;
  JSRuntime *runtime = JS_NewRuntime();
  if (runtime == NULL) return NULL;
  /* The settings qjs_boot gives the guest's runtime that shape the bytecode
   * or bound the compile: the same bundle gives the same bytes. */
  JS_SetMaxStackSize(runtime, stack_bytes);
  if (memory_limit > 0) JS_SetMemoryLimit(runtime, memory_limit);
  JS_SetStripInfo(runtime, JS_STRIP_SOURCE);
  JSContext *context = JS_NewContext(runtime);
  if (context == NULL) {
    JS_FreeRuntime(runtime);
    return NULL;
  }
  uint8_t *out = NULL;
  JSValue function = JS_Eval(context, (const char *)code, length - 1, "pocket:guest", JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
  if (JS_IsException(function)) {
    exception_text(context, error, error_length);
  } else {
    size_t size = 0;
    uint8_t *written = JS_WriteObject(context, &size, function, JS_WRITE_OBJ_BYTECODE);
    if (written != NULL) {
      out = malloc(size);
      if (out != NULL) {
        memcpy(out, written, size);
        *bytecode_length = size;
      }
      js_free(context, written);
    }
    JS_FreeValue(context, function);
  }
  JS_FreeContext(context);
  JS_FreeRuntime(runtime);
  return out;
}
