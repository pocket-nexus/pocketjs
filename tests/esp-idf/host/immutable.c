#include "quickjs.h"
#include <stdio.h>
#include <string.h>

/* Exercise the engine used by the IDF component, not the host's JS engine.
 * RAM backing keeps a failed protection test observable without a flash fault.
 */
int main(void) {
  JSRuntime *rt = JS_NewRuntime();
  JSContext *ctx = JS_NewContext(rt);
  unsigned char data[] = {1, 2, 3, 4};
  JSValue buffer =
      JS_NewArrayBuffer(ctx, data, sizeof(data), NULL, NULL, false);
  if (JS_SetImmutableArrayBuffer(buffer, true) != 0)
    return 2;
  JSValue global = JS_GetGlobalObject(ctx);
  JS_SetPropertyStr(ctx, global, "pak", buffer);
  JS_FreeValue(ctx, global);
  const char *cases[] = {
      "if(new Uint8Array(pak).slice()[1] !== 2) throw Error('read');",
      "new Uint8Array(pak)[0] = 9;",
      "new Uint8Array(pak).set([9]);",
      "new Uint8Array(pak).fill(9);",
      "new Uint8Array(pak).copyWithin(0, 1);",
      "new Uint8Array(pak).reverse();",
      "new Uint8Array(pak).sort((a,b)=>b-a);",
      "new DataView(pak).setUint8(0, 9);",
      "pak.transfer();",
      "const src = new Uint8Array([9]); src.constructor = {"
      "[Symbol.species]: function() { return new Uint8Array(pak); }}; "
      "src.slice();",
  };
  int failed = 0;
  for (unsigned i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    JSValue result = JS_Eval(ctx, cases[i], strlen(cases[i]), "immutable-test",
                             JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
      JSValue error = JS_GetException(ctx);
      if (i == 0)
        failed = 1;
      JS_FreeValue(ctx, error);
    }
    JS_FreeValue(ctx, result);
    if (memcmp(data, (unsigned char[]){1, 2, 3, 4}, sizeof(data))) {
      fprintf(stderr, "immutable backing changed in case %u\n", i);
      failed = 1;
      memcpy(data, (unsigned char[]){1, 2, 3, 4}, sizeof(data));
    }
  }
  JS_FreeContext(ctx);
  JS_FreeRuntime(rt);
  return failed;
}
