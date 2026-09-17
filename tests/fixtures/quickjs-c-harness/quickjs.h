#ifndef POCKETJS_TEST_QUICKJS_H
#define POCKETJS_TEST_QUICKJS_H

#include <stddef.h>
#include <stdint.h>

typedef struct JSRuntime JSRuntime;
typedef struct JSContext JSContext;
typedef int64_t JSValue;
typedef JSValue JSValueConst;
typedef JSValue JSCFunctionMagic(JSContext *ctx, JSValueConst this_value,
                                 int argc, JSValueConst *argv, int magic);

typedef enum {
  JS_CFUNC_generic_magic = 0,
} JSCFunctionEnum;

#define JS_UNDEFINED ((JSValue)0)
#define JS_EXCEPTION ((JSValue) - 1)
#define JS_EVAL_TYPE_GLOBAL 0

JSRuntime *JS_NewRuntime(void);
void JS_FreeRuntime(JSRuntime *runtime);
void JS_SetMaxStackSize(JSRuntime *runtime, size_t size);
JSContext *JS_NewContext(JSRuntime *runtime);
void JS_FreeContext(JSContext *context);
JSValue JS_GetGlobalObject(JSContext *context);
JSValue JS_GetException(JSContext *context);
int JS_HasException(JSContext *context);
int JS_IsException(JSValueConst value);
int JS_IsUndefined(JSValueConst value);
int JS_IsFunction(JSContext *context, JSValueConst value);
void JS_FreeValue(JSContext *context, JSValue value);
const char *JS_ToCStringLen2(JSContext *context, size_t *length,
                             JSValueConst value, int cesu8);
void JS_FreeCString(JSContext *context, const char *value);
int JS_ToInt32(JSContext *context, int32_t *out, JSValueConst value);
int JS_ToUint32(JSContext *context, uint32_t *out, JSValueConst value);
int JS_ToFloat64(JSContext *context, double *out, JSValueConst value);
JSValue JS_NewInt32(JSContext *context, int32_t value);
JSValue JS_NewUint32(JSContext *context, uint32_t value);
JSValue JS_NewFloat64(JSContext *context, double value);
JSValue JS_NewBool(JSContext *context, int value);
JSValue JS_NewString(JSContext *context, const char *value);
JSValue JS_NewStringLen(JSContext *context, const char *value, size_t length);
JSValue JS_NewObject(JSContext *context);
JSValue JS_NewArray(JSContext *context);
JSValue JS_NewArrayBuffer(JSContext *context, uint8_t *buffer, size_t length,
                          void (*free_func)(JSRuntime *runtime, void *opaque,
                                            void *pointer),
                          void *opaque, int shared);
uint8_t *JS_GetArrayBuffer(JSContext *context, size_t *length,
                           JSValueConst value);
JSValue JS_GetTypedArrayBuffer(JSContext *context, JSValueConst value,
                               size_t *offset, size_t *length,
                               size_t *bytes_per_element);
JSValue JS_NewCFunctionMagic(JSContext *context, JSCFunctionMagic *function,
                             const char *name, int length, JSCFunctionEnum kind,
                             int magic);
int JS_SetPropertyStr(JSContext *context, JSValueConst object, const char *name,
                      JSValue value);
int JS_SetPropertyUint32(JSContext *context, JSValueConst object,
                         uint32_t index, JSValue value);
JSValue JS_GetPropertyStr(JSContext *context, JSValueConst object,
                          const char *name);
JSValue JS_Eval(JSContext *context, const char *source, size_t length,
                const char *filename, int flags);
JSValue JS_Call(JSContext *context, JSValueConst function,
                JSValueConst this_value, int argc, JSValueConst *argv);
int JS_ExecutePendingJob(JSRuntime *runtime, JSContext **context);
JSValue JS_ThrowTypeError(JSContext *context, const char *format, ...);
JSValue JS_ThrowRangeError(JSContext *context, const char *format, ...);
JSValue JS_ThrowInternalError(JSContext *context, const char *format, ...);

#endif
