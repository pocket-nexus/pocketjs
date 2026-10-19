/*
 * A bounded JSON reader and writer for the host's own records: the link's
 * ctrl frames, the package plan's `app` object, the guest's net metadata.
 *
 * The reader never builds a tree. json_find walks ONE object's top-level
 * members and returns the raw span of a member's value; nested objects are
 * read by finding inside that span. Malformed input reads as "not found".
 * The writer appends to a growable buffer that latches failure instead of
 * returning an error from every call.
 */

#ifndef POCKETJS_3DS_JSCAN_H
#define POCKETJS_3DS_JSCAN_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
  const char *start;
  size_t length;
} JsonSpan;

/* `object` must span one JSON object (leading whitespace allowed). */
bool json_find(JsonSpan object, const char *key, JsonSpan *value);
/* Unescape a string value into `out` as UTF-8 + NUL; false when the value is
 * not a string or does not fit. */
bool json_string(JsonSpan value, char *out, size_t capacity);
/* A non-negative integer value (no fraction, no exponent). */
bool json_u64(JsonSpan value, uint64_t *out);
bool json_is_object(JsonSpan value);
bool json_is_array(JsonSpan value);
/* Convenience: find + json_string / json_u64. */
bool json_find_string(JsonSpan object, const char *key, char *out, size_t capacity);
bool json_find_u64(JsonSpan object, const char *key, uint64_t *out);
JsonSpan json_span(const char *text, size_t length);

typedef struct {
  char *data;
  size_t length;
  size_t capacity;
  /* Hard cap on growth; 0 means unbounded. */
  size_t limit;
  bool failed;
} JsonBuffer;

void jbuf_reset(JsonBuffer *buffer);
void jbuf_free(JsonBuffer *buffer);
void jbuf_raw(JsonBuffer *buffer, const char *text, size_t length);
void jbuf_text(JsonBuffer *buffer, const char *text);
/* A quoted, escaped JSON string from UTF-8 bytes. */
void jbuf_string(JsonBuffer *buffer, const char *text, size_t length);
void jbuf_cstring(JsonBuffer *buffer, const char *text);
void jbuf_u64(JsonBuffer *buffer, uint64_t value);
void jbuf_i64(JsonBuffer *buffer, int64_t value);
/* NUL-terminated view; NULL when the buffer failed. */
const char *jbuf_cstr(JsonBuffer *buffer);

#endif
