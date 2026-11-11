/* tests/3ds-bundle-compile.test.ts: products/3ds/src/bundle_compile.c against
 * the QuickJS the 3DS program links, built for the build machine.
 *
 *   harness compile <source file>   compile on a thread of its own with the
 *                                   3DS stack limit; print whether the bytes
 *                                   equal qjs_boot's own compile, then run
 *                                   them in a third runtime and print
 *                                   globalThis.result
 *   harness raw <source file>       the same bytes without a terminal NUL
 *
 * One line per fact on stdout; exit status 0 unless the harness itself broke.
 */

#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "bundle_compile.h"
#include "quickjs.h"

#define STACK_BYTES (384 * 1024)
#define HEAP_LIMIT (64u * 1024u * 1024u)

typedef struct {
  const uint8_t *code;
  size_t length;
  uint8_t *bytecode;
  size_t bytecode_length;
  char error[512];
  atomic_bool done;
} Job;

static void *run(void *opaque) {
  Job *job = opaque;
  job->bytecode = bundle_compile(job->code, job->length, STACK_BYTES, HEAP_LIMIT, &job->bytecode_length, job->error, sizeof job->error);
  atomic_store(&job->done, true);
  return NULL;
}

/* What qjs_boot's compile wrote to bundle.qbc before this change: the
 * guest's own runtime, with globals of the host already installed. */
static uint8_t *compile_in_place(const uint8_t *code, size_t length, size_t *size) {
  JSRuntime *runtime = JS_NewRuntime();
  JS_SetMaxStackSize(runtime, STACK_BYTES);
  JS_SetMemoryLimit(runtime, HEAP_LIMIT);
  JS_SetStripInfo(runtime, JS_STRIP_SOURCE);
  JSContext *context = JS_NewContext(runtime);
  JSValue global = JS_GetGlobalObject(context);
  JS_SetPropertyStr(context, global, "ui", JS_NewObject(context));
  JS_SetPropertyStr(context, global, "link", JS_NewObject(context));
  JS_FreeValue(context, global);
  JSValue function = JS_Eval(context, (const char *)code, length - 1, "pocket:guest", JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
  uint8_t *out = NULL;
  *size = 0;
  if (!JS_IsException(function)) {
    uint8_t *written = JS_WriteObject(context, size, function, JS_WRITE_OBJ_BYTECODE);
    out = malloc(*size);
    memcpy(out, written, *size);
    js_free(context, written);
    JS_FreeValue(context, function);
  }
  JS_FreeContext(context);
  JS_FreeRuntime(runtime);
  return out;
}

/* qjs_boot's cached path: read the bytecode into a fresh realm and run it. */
static void run_bytecode(const uint8_t *bytecode, size_t length) {
  JSRuntime *runtime = JS_NewRuntime();
  JS_SetMaxStackSize(runtime, STACK_BYTES);
  JS_SetStripInfo(runtime, JS_STRIP_SOURCE);
  JSContext *context = JS_NewContext(runtime);
  JSValue function = JS_ReadObject(context, bytecode, length, JS_READ_OBJ_BYTECODE);
  JSValue result = JS_IsException(function) ? function : JS_EvalFunction(context, function);
  if (JS_IsException(result)) {
    JSValue exception = JS_GetException(context);
    const char *text = JS_ToCString(context, exception);
    printf("run threw %s\n", text ? text : "?");
    JS_FreeCString(context, text);
    JS_FreeValue(context, exception);
  } else {
    JS_FreeValue(context, result);
    JSValue global = JS_GetGlobalObject(context);
    JSValue value = JS_GetPropertyStr(context, global, "result");
    const char *text = JS_ToCString(context, value);
    printf("result %s\n", text ? text : "?");
    JS_FreeCString(context, text);
    JS_FreeValue(context, value);
    JS_FreeValue(context, global);
  }
  JS_FreeContext(context);
  JS_FreeRuntime(runtime);
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  FILE *file = fopen(argv[2], "rb");
  if (file == NULL) return 2;
  fseek(file, 0, SEEK_END);
  long size = ftell(file);
  fseek(file, 0, SEEK_SET);
  uint8_t *code = malloc((size_t)size + 1);
  if (code == NULL || fread(code, 1, (size_t)size, file) != (size_t)size) return 2;
  fclose(file);
  /* A package's JavaScript section ends with its NUL; `raw` leaves it off. */
  bool raw = strcmp(argv[1], "raw") == 0;
  code[size] = 0;
  size_t length = raw ? (size_t)size : (size_t)size + 1;

  Job job;
  memset(&job, 0, sizeof job);
  job.code = code;
  job.length = length;
  atomic_init(&job.done, false);
  pthread_attr_t attributes;
  pthread_attr_init(&attributes);
  /* As on the 3DS: QuickJS's limit and room above it (main.c COMPILE_STACK). */
  pthread_attr_setstacksize(&attributes, STACK_BYTES + 64 * 1024);
  pthread_t thread;
  if (pthread_create(&thread, &attributes, run, &job) != 0) return 2;
  /* The caller keeps running while the compile does: here it only counts. */
  unsigned long turns = 0;
  while (!atomic_load(&job.done)) {
    struct timespec pause = {0, 1000000};
    nanosleep(&pause, NULL);
    turns += 1;
  }
  pthread_join(thread, NULL);
  printf("turns %lu\n", turns);

  if (job.bytecode == NULL) {
    if (job.error[0] == '\0') printf("unavailable\n");
    else printf("error %s\n", job.error);
    free(code);
    return 0;
  }
  size_t in_place_length = 0;
  uint8_t *in_place = compile_in_place(code, length, &in_place_length);
  printf("bytes %zu\n", job.bytecode_length);
  printf("same %s\n", in_place != NULL && in_place_length == job.bytecode_length && memcmp(in_place, job.bytecode, in_place_length) == 0 ? "yes" : "no");
  run_bytecode(job.bytecode, job.bytecode_length);
  free(in_place);
  free(job.bytecode);
  free(code);
  return 0;
}
