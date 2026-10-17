#include "quickjs.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint8_t *read_file(const char *path, size_t *size) {
  FILE *file = fopen(path, "rb");
  if (!file) return NULL;
  if (fseek(file, 0, SEEK_END) != 0) {
    fclose(file);
    return NULL;
  }
  long length = ftell(file);
  if (length < 0 || fseek(file, 0, SEEK_SET) != 0) {
    fclose(file);
    return NULL;
  }
  uint8_t *bytes = malloc((size_t)length + 1);
  if (!bytes) {
    fclose(file);
    return NULL;
  }
  if (fread(bytes, 1, (size_t)length, file) != (size_t)length) {
    free(bytes);
    fclose(file);
    return NULL;
  }
  fclose(file);
  bytes[length] = 0;
  *size = (size_t)length;
  return bytes;
}

static int write_file(const char *path, const uint8_t *bytes, size_t size) {
  FILE *file = fopen(path, "wb");
  if (!file) return -1;
  int wrote = fwrite(bytes, 1, size, file) == size;
  int ok = fclose(file) == 0 && wrote;
  return ok ? 0 : -1;
}

static void print_exception(JSContext *ctx) {
  JSValue exception = JS_GetException(ctx);
  const char *message = JS_ToCString(ctx, exception);
  if (message) {
    fprintf(stderr, "pocket-qjsc: %s\n", message);
    JS_FreeCString(ctx, message);
  } else {
    fprintf(stderr, "pocket-qjsc: QuickJS compilation failed\n");
  }
  JS_FreeValue(ctx, exception);
}

int main(int argc, char **argv) {
  if (argc != 4 || (strcmp(argv[3], "strict") != 0 && strcmp(argv[3], "sloppy") != 0)) {
    fprintf(stderr, "usage: pocket-qjsc <input.js> <output.qjbc> <strict|sloppy>\n");
    return 2;
  }

  size_t source_size = 0;
  uint8_t *source = read_file(argv[1], &source_size);
  if (!source) {
    fprintf(stderr, "pocket-qjsc: cannot read %s: %s\n", argv[1], strerror(errno));
    return 1;
  }

  JSRuntime *runtime = JS_NewRuntime();
  JSContext *context = runtime ? JS_NewContext(runtime) : NULL;
  if (!context) {
    fprintf(stderr, "pocket-qjsc: cannot create QuickJS runtime\n");
    free(source);
    if (runtime) JS_FreeRuntime(runtime);
    return 1;
  }

  int eval_flags = JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY;
  if (strcmp(argv[3], "strict") == 0) eval_flags |= JS_EVAL_FLAG_STRICT;
  JSValue compiled = JS_Eval(
      context,
      (const char *)source,
      source_size,
      "app.js",
      eval_flags);
  free(source);
  if (JS_IsException(compiled)) {
    print_exception(context);
    JS_FreeValue(context, compiled);
    JS_FreeContext(context);
    JS_FreeRuntime(runtime);
    return 1;
  }

  size_t bytecode_size = 0;
  uint8_t *bytecode = JS_WriteObject(
      context, &bytecode_size, compiled, JS_WRITE_OBJ_BYTECODE);
  JS_FreeValue(context, compiled);
  if (!bytecode) {
    print_exception(context);
    JS_FreeContext(context);
    JS_FreeRuntime(runtime);
    return 1;
  }
  int result = write_file(argv[2], bytecode, bytecode_size);
  js_free(context, bytecode);
  JS_FreeContext(context);
  JS_FreeRuntime(runtime);
  if (result != 0) {
    fprintf(stderr, "pocket-qjsc: cannot write %s: %s\n", argv[2], strerror(errno));
    return 1;
  }
  return 0;
}
