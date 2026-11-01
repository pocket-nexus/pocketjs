/* pocket-qjsc: compile one classic script to a serialized QuickJS object with
 * the engine source a target embeds (tools/quickjs-bytecode.ts builds this
 * program from that source). The output is read back before it is written,
 * so a file on disk is one the same engine build accepts. */
#include "quickjs.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint8_t *read_file(const char *path, size_t *size) {
  FILE *file = fopen(path, "rb");
  if (!file)
    return NULL;
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
  if (!file)
    return -1;
  int wrote = fwrite(bytes, 1, size, file) == size;
  int ok = fclose(file) == 0 && wrote;
  return ok ? 0 : -1;
}

static void print_exception(JSContext *ctx, const char *stage) {
  JSValue exception = JS_GetException(ctx);
  const char *message = JS_ToCString(ctx, exception);
  fprintf(stderr, "pocket-qjsc: %s: %s\n", stage, message ? message : "QuickJS failed");
  if (message)
    JS_FreeCString(ctx, message);
  JS_FreeValue(ctx, exception);
}

int main(int argc, char **argv) {
  const char *mode = argc >= 4 ? argv[3] : "";
  int strict = strcmp(mode, "strict") == 0;
  if ((argc != 4 && argc != 5) || (!strict && strcmp(mode, "sloppy") != 0) ||
      (argc == 5 && strcmp(argv[4], "strip-source") != 0)) {
    fprintf(stderr, "usage: pocket-qjsc <input.js> <output.qjbc> <strict|sloppy> [strip-source]\n");
    return 2;
  }
  int write_flags = JS_WRITE_OBJ_BYTECODE;
  if (argc == 5)
    write_flags |= JS_WRITE_OBJ_STRIP_SOURCE;

  size_t source_size = 0;
  uint8_t *source = read_file(argv[1], &source_size);
  if (!source) {
    fprintf(stderr, "pocket-qjsc: cannot read %s: %s\n", argv[1], strerror(errno));
    return 1;
  }
  JSRuntime *runtime = JS_NewRuntime();
  JSContext *context = runtime ? JS_NewContext(runtime) : NULL;
  if (!context) {
    fprintf(stderr, "pocket-qjsc: cannot create a QuickJS runtime\n");
    free(source);
    if (runtime)
      JS_FreeRuntime(runtime);
    return 1;
  }
  int eval_flags = JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY;
  if (strict)
    eval_flags |= JS_EVAL_FLAG_STRICT;
  JSValue compiled = JS_Eval(context, (const char *)source, source_size, "app.js", eval_flags);
  free(source);
  int result = 1;
  size_t bytecode_size = 0;
  uint8_t *bytecode = NULL;
  if (JS_IsException(compiled)) {
    print_exception(context, "compile");
    goto done;
  }
  bytecode = JS_WriteObject(context, &bytecode_size, compiled, write_flags);
  if (!bytecode) {
    print_exception(context, "serialize");
    goto done;
  }
  /* The same engine must read the object back; a failure here is a build
   * that cannot run the output. */
  JSValue restored = JS_ReadObject(context, bytecode, bytecode_size, JS_READ_OBJ_BYTECODE);
  if (JS_IsException(restored)) {
    print_exception(context, "read back");
    goto done;
  }
  JS_FreeValue(context, restored);
  if (write_file(argv[2], bytecode, bytecode_size) != 0) {
    fprintf(stderr, "pocket-qjsc: cannot write %s: %s\n", argv[2], strerror(errno));
    goto done;
  }
  result = 0;
done:
  JS_FreeValue(context, compiled);
  if (bytecode)
    js_free(context, bytecode);
  JS_FreeContext(context);
  JS_FreeRuntime(runtime);
  return result;
}
