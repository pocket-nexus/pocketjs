/*
 * Origin: PocketJS_for_Edgi-Talk/.../applications/pocketjs/include/pocketjs_qjs_ng_compat.h
 * Force-include for PocketJS guest sources targeting pre-resizable ArrayBuffer API.
 */
#pragma once

#include <stddef.h>

#include "quickjs.h"

/* newlib-nano provides these functions but hides their declarations at POSIX level 1. */
extern char *strdup(const char *text);
extern size_t strnlen(const char *text, size_t max_length);

static inline JSValue pocketjs_qjs_new_array_buffer_legacy(
    JSContext *context, uint8_t *buffer, size_t length,
    JSReallocArrayBufferDataFunc *realloc_function, void *opaque,
    bool is_shared)
{
    return JS_NewArrayBuffer(context, buffer, length, 0U, realloc_function,
                             opaque, is_shared);
}

/* PocketJS's ESP-IDF host targets the pre-resizable ArrayBuffer API. */
#define JS_NewArrayBuffer(context, buffer, length, realloc_function, opaque, is_shared) \
    pocketjs_qjs_new_array_buffer_legacy((context), (buffer), (length),       \
                                         (realloc_function), (opaque),         \
                                         (is_shared))
