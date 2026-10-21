/* Bounded JSON reader/writer — see jscan.h. */

#include "jscan.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Nesting deeper than this reads as malformed; host records are shallow. */
#define JSON_MAX_DEPTH 32

static size_t skip_space(const char *text, size_t length, size_t at) {
  while (at < length && (text[at] == ' ' || text[at] == '\t' || text[at] == '\n' || text[at] == '\r')) {
    at += 1;
  }
  return at;
}

/* End of the string whose opening quote is at `at`, one past the closing
 * quote; SIZE_MAX when unterminated. */
static size_t skip_string(const char *text, size_t length, size_t at) {
  at += 1;
  while (at < length) {
    char c = text[at];
    if (c == '\\') {
      at += 2;
      continue;
    }
    if (c == '"') return at + 1;
    if ((unsigned char)c < 0x20) return SIZE_MAX;
    at += 1;
  }
  return SIZE_MAX;
}

/* End of the value starting at `at` (after whitespace); SIZE_MAX if malformed. */
static size_t skip_value(const char *text, size_t length, size_t at) {
  at = skip_space(text, length, at);
  if (at >= length) return SIZE_MAX;
  char c = text[at];
  if (c == '"') return skip_string(text, length, at);
  if (c == '{' || c == '[') {
    /* Iterative bracket matching: strings may contain brackets. */
    char stack[JSON_MAX_DEPTH];
    size_t depth = 0;
    while (at < length) {
      c = text[at];
      if (c == '"') {
        at = skip_string(text, length, at);
        if (at == SIZE_MAX) return SIZE_MAX;
        continue;
      }
      if (c == '{' || c == '[') {
        if (depth == JSON_MAX_DEPTH) return SIZE_MAX;
        stack[depth++] = c == '{' ? '}' : ']';
      } else if (c == '}' || c == ']') {
        if (depth == 0 || stack[depth - 1] != c) return SIZE_MAX;
        depth -= 1;
        if (depth == 0) return at + 1;
      }
      at += 1;
    }
    return SIZE_MAX;
  }
  /* number / true / false / null: up to the next delimiter. */
  size_t start = at;
  while (at < length && text[at] != ',' && text[at] != '}' && text[at] != ']' &&
         text[at] != ' ' && text[at] != '\n' && text[at] != '\r' && text[at] != '\t') {
    at += 1;
  }
  return at > start ? at : SIZE_MAX;
}

JsonSpan json_span(const char *text, size_t length) {
  JsonSpan span = { text, text == NULL ? 0 : length };
  return span;
}

bool json_find(JsonSpan object, const char *key, JsonSpan *value) {
  const char *text = object.start;
  size_t length = object.length;
  if (text == NULL || key == NULL) return false;
  size_t key_length = strlen(key);
  size_t at = skip_space(text, length, 0);
  if (at >= length || text[at] != '{') return false;
  at = skip_space(text, length, at + 1);
  if (at < length && text[at] == '}') return false;
  while (at < length) {
    if (text[at] != '"') return false;
    size_t key_end = skip_string(text, length, at);
    if (key_end == SIZE_MAX) return false;
    /* Keys are compared raw: host keys never need escapes. */
    bool match = key_end - at - 2 == key_length && memcmp(text + at + 1, key, key_length) == 0;
    at = skip_space(text, length, key_end);
    if (at >= length || text[at] != ':') return false;
    size_t value_start = skip_space(text, length, at + 1);
    size_t value_end = skip_value(text, length, value_start);
    if (value_end == SIZE_MAX) return false;
    if (match) {
      value->start = text + value_start;
      value->length = value_end - value_start;
      return true;
    }
    at = skip_space(text, length, value_end);
    if (at >= length) return false;
    if (text[at] == '}') return false;
    if (text[at] != ',') return false;
    at = skip_space(text, length, at + 1);
  }
  return false;
}

static int hex_value(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static bool read_hex4(const char *text, size_t length, size_t at, uint32_t *out) {
  if (at + 4 > length) return false;
  uint32_t value = 0;
  for (size_t i = 0; i < 4; i += 1) {
    int digit = hex_value(text[at + i]);
    if (digit < 0) return false;
    value = (value << 4) | (uint32_t)digit;
  }
  *out = value;
  return true;
}

bool json_string(JsonSpan value, char *out, size_t capacity) {
  const char *text = value.start;
  size_t length = value.length;
  if (text == NULL || capacity == 0 || length < 2 || text[0] != '"' || text[length - 1] != '"') {
    return false;
  }
  size_t used = 0;
  for (size_t at = 1; at + 1 < length;) {
    uint32_t code = (unsigned char)text[at];
    if (code != '\\') {
      if (used + 1 >= capacity) return false;
      out[used++] = (char)code;
      at += 1;
      continue;
    }
    if (at + 2 >= length) return false;
    char escape = text[at + 1];
    at += 2;
    switch (escape) {
      case '"': code = '"'; break;
      case '\\': code = '\\'; break;
      case '/': code = '/'; break;
      case 'b': code = '\b'; break;
      case 'f': code = '\f'; break;
      case 'n': code = '\n'; break;
      case 'r': code = '\r'; break;
      case 't': code = '\t'; break;
      case 'u': {
        if (!read_hex4(text, length - 1, at, &code)) return false;
        at += 4;
        if (code >= 0xd800 && code < 0xdc00) {
          uint32_t low = 0;
          if (at + 6 <= length - 1 && text[at] == '\\' && text[at + 1] == 'u' &&
              read_hex4(text, length - 1, at + 2, &low) && low >= 0xdc00 && low < 0xe000) {
            code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
            at += 6;
          } else {
            code = 0xfffd;
          }
        } else if (code >= 0xdc00 && code < 0xe000) {
          code = 0xfffd;
        }
        break;
      }
      default:
        return false;
    }
    char encoded[4];
    size_t bytes;
    if (code < 0x80) {
      encoded[0] = (char)code;
      bytes = 1;
    } else if (code < 0x800) {
      encoded[0] = (char)(0xc0 | (code >> 6));
      encoded[1] = (char)(0x80 | (code & 0x3f));
      bytes = 2;
    } else if (code < 0x10000) {
      encoded[0] = (char)(0xe0 | (code >> 12));
      encoded[1] = (char)(0x80 | ((code >> 6) & 0x3f));
      encoded[2] = (char)(0x80 | (code & 0x3f));
      bytes = 3;
    } else {
      encoded[0] = (char)(0xf0 | (code >> 18));
      encoded[1] = (char)(0x80 | ((code >> 12) & 0x3f));
      encoded[2] = (char)(0x80 | ((code >> 6) & 0x3f));
      encoded[3] = (char)(0x80 | (code & 0x3f));
      bytes = 4;
    }
    if (used + bytes >= capacity) return false;
    memcpy(out + used, encoded, bytes);
    used += bytes;
  }
  out[used] = '\0';
  return true;
}

bool json_u64(JsonSpan value, uint64_t *out) {
  if (value.start == NULL || value.length == 0 || value.length > 20) return false;
  uint64_t result = 0;
  for (size_t i = 0; i < value.length; i += 1) {
    char c = value.start[i];
    if (c < '0' || c > '9') return false;
    uint64_t next = result * 10u + (uint64_t)(c - '0');
    if (next / 10u != result) return false;
    result = next;
  }
  *out = result;
  return true;
}

bool json_is_object(JsonSpan value) {
  return value.start != NULL && value.length >= 2 && value.start[0] == '{';
}

bool json_is_array(JsonSpan value) {
  return value.start != NULL && value.length >= 2 && value.start[0] == '[';
}

bool json_find_string(JsonSpan object, const char *key, char *out, size_t capacity) {
  JsonSpan value;
  return json_find(object, key, &value) && json_string(value, out, capacity);
}

bool json_find_u64(JsonSpan object, const char *key, uint64_t *out) {
  JsonSpan value;
  return json_find(object, key, &value) && json_u64(value, out);
}

// ---------------------------------------------------------------------------
// writer
// ---------------------------------------------------------------------------

void jbuf_reset(JsonBuffer *buffer) {
  buffer->length = 0;
  buffer->failed = false;
  if (buffer->data != NULL) buffer->data[0] = '\0';
}

void jbuf_free(JsonBuffer *buffer) {
  free(buffer->data);
  buffer->data = NULL;
  buffer->length = 0;
  buffer->capacity = 0;
  buffer->failed = false;
}

static bool reserve(JsonBuffer *buffer, size_t extra) {
  if (buffer->failed) return false;
  size_t needed = buffer->length + extra + 1;
  if (buffer->limit != 0 && needed > buffer->limit) {
    buffer->failed = true;
    return false;
  }
  if (needed <= buffer->capacity) return true;
  size_t capacity = buffer->capacity == 0 ? 256 : buffer->capacity;
  while (capacity < needed) capacity *= 2;
  if (buffer->limit != 0 && capacity > buffer->limit) capacity = buffer->limit;
  char *grown = realloc(buffer->data, capacity);
  if (grown == NULL) {
    buffer->failed = true;
    return false;
  }
  buffer->data = grown;
  buffer->capacity = capacity;
  return true;
}

void jbuf_raw(JsonBuffer *buffer, const char *text, size_t length) {
  if (!reserve(buffer, length)) return;
  memcpy(buffer->data + buffer->length, text, length);
  buffer->length += length;
  buffer->data[buffer->length] = '\0';
}

void jbuf_text(JsonBuffer *buffer, const char *text) {
  jbuf_raw(buffer, text, strlen(text));
}

void jbuf_string(JsonBuffer *buffer, const char *text, size_t length) {
  jbuf_raw(buffer, "\"", 1);
  size_t run = 0;
  for (size_t i = 0; i < length; i += 1) {
    unsigned char c = (unsigned char)text[i];
    if (c >= 0x20 && c != '"' && c != '\\') continue;
    jbuf_raw(buffer, text + run, i - run);
    run = i + 1;
    char escape[8];
    switch (c) {
      case '"': jbuf_raw(buffer, "\\\"", 2); break;
      case '\\': jbuf_raw(buffer, "\\\\", 2); break;
      case '\n': jbuf_raw(buffer, "\\n", 2); break;
      case '\r': jbuf_raw(buffer, "\\r", 2); break;
      case '\t': jbuf_raw(buffer, "\\t", 2); break;
      default:
        snprintf(escape, sizeof escape, "\\u%04x", (unsigned)c);
        jbuf_raw(buffer, escape, 6);
        break;
    }
  }
  jbuf_raw(buffer, text + run, length - run);
  jbuf_raw(buffer, "\"", 1);
}

void jbuf_cstring(JsonBuffer *buffer, const char *text) {
  jbuf_string(buffer, text == NULL ? "" : text, text == NULL ? 0 : strlen(text));
}

void jbuf_u64(JsonBuffer *buffer, uint64_t value) {
  char digits[24];
  snprintf(digits, sizeof digits, "%llu", (unsigned long long)value);
  jbuf_text(buffer, digits);
}

void jbuf_i64(JsonBuffer *buffer, int64_t value) {
  char digits[24];
  snprintf(digits, sizeof digits, "%lld", (long long)value);
  jbuf_text(buffer, digits);
}

const char *jbuf_cstr(JsonBuffer *buffer) {
  if (buffer->failed) return NULL;
  if (buffer->data == NULL && !reserve(buffer, 0)) return NULL;
  buffer->data[buffer->length] = '\0';
  return buffer->data;
}
