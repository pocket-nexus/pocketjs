/* `globalThis.link.channel` for a QuickJS guest: see link2_channel_qjs.h. */

#include "link2_channel_qjs.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define GENERATION_MASK 0x1fffffu

static uint64_t handle_of(uint32_t generation, uint32_t id) {
  return id == 0 ? 0 : ((uint64_t)(generation & GENERATION_MASK) << 32) | id;
}

static JSValue handle_value(JSContext *ctx, uint32_t generation, uint32_t id) {
  return JS_NewFloat64(ctx, (double)handle_of(generation, id));
}

/* Decimal digits of a handle: at most 16, no dependency on printf's 64-bit forms. */
static size_t handle_digits(char *out, uint64_t value) {
  char reversed[24];
  size_t count = 0;
  do {
    reversed[count++] = (char)('0' + value % 10);
    value /= 10;
  } while (value != 0);
  for (size_t i = 0; i < count; i += 1) out[i] = reversed[count - 1 - i];
  return count;
}

static void clear_exception(JSContext *ctx) {
  JS_FreeValue(ctx, JS_GetException(ctx));
}

/* The id a handle names: LINK2_OK, LINK2_MALFORMED for a value that is no
 * handle, LINK2_STALE for one of another generation.
 *
 * The conversion runs the guest's own code (`valueOf`), which may detach or
 * resize a buffer passed beside the handle: every operation converts its
 * handle before it takes a buffer's address. */
static int argument_handle(JSContext *ctx, int argc, JSValueConst *argv, int index, uint32_t generation, uint32_t *id) {
  double value = 0;
  *id = 0;
  if (index >= argc) return LINK2_MALFORMED;
  if (JS_ToFloat64(ctx, &value, argv[index]) != 0) {
    clear_exception(ctx);
    return LINK2_MALFORMED;
  }
  if (!(value >= 1.0) || !(value < 9007199254740992.0)) return LINK2_MALFORMED;
  uint64_t handle = (uint64_t)value;
  if ((double)handle != value) return LINK2_MALFORMED;
  *id = (uint32_t)(handle & 0xffffffffu);
  if (*id == 0) return LINK2_MALFORMED;
  return (uint32_t)(handle >> 32) == (generation & GENERATION_MASK) ? LINK2_OK : LINK2_STALE;
}

/* A string argument; NULL (and no exception left) when it does not convert. */
static const char *argument_json(JSContext *ctx, JSValueConst value, size_t *length) {
  const char *text = JS_ToCStringLen2(ctx, length, value, 0);
  if (text == NULL) clear_exception(ctx);
  return text;
}

/* The bytes of an ArrayBuffer or of a typed array's view, with a reference
 * that keeps the object alive. Nothing that runs guest code may follow it
 * before the bytes are used. */
static bool argument_bytes(JSContext *ctx, int argc, JSValueConst *argv, int index, uint8_t **bytes, size_t *length, JSValue *lease) {
  if (index >= argc) return false;
  size_t size = 0;
  uint8_t *data = JS_GetArrayBuffer(ctx, &size, argv[index]);
  if (data != NULL) {
    *lease = JS_DupValue(ctx, argv[index]);
    *bytes = data;
    *length = size;
    return true;
  }
  clear_exception(ctx);
  size_t offset = 0, view_length = 0, element = 0;
  JSValue buffer = JS_GetTypedArrayBuffer(ctx, argv[index], &offset, &view_length, &element);
  if (JS_IsException(buffer)) {
    clear_exception(ctx);
    return false;
  }
  data = JS_GetArrayBuffer(ctx, &size, buffer);
  if (data == NULL || offset > size || view_length > size - offset) {
    if (data == NULL) clear_exception(ctx);
    JS_FreeValue(ctx, buffer);
    return false;
  }
  *lease = buffer;
  *bytes = data + offset;
  *length = view_length;
  return true;
}

JSValue link2_channel_qjs(JSContext *ctx, Link2 *client, int channel, Link2QjsOperation operation,
                          int argc, JSValueConst *argv, char *scratch, size_t scratch_bytes) {
  bool usable = client != NULL && channel >= 0;
  uint32_t generation = usable ? link2_channel_generation(client, channel) : 0;
  uint32_t id = 0;
  size_t text_length = 0;
  const char *text = NULL;
  int status = LINK2_OK;

  switch (operation) {
  case LINK2_QJS_STATE: {
    const char *reason = "";
    int state = usable ? link2_channel_state(client, channel, &reason) : LINK2_CHANNEL_CLOSED;
    char json[160];
    /* A close reason is a name of §7.5: letters, digits, "_", "." and "-". */
    char name[48];
    size_t used = 0;
    for (const char *at = usable && reason != NULL ? reason : client != NULL ? "" : "no_link"; *at != '\0' && used + 1 < sizeof name; at += 1) {
      char c = *at;
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-') name[used++] = c;
    }
    name[used] = '\0';
    snprintf(json, sizeof json, "{\"state\":\"%s\",\"reason\":\"%s\",\"generation\":%lu}",
             state == LINK2_CHANNEL_OPEN ? "open" : state == LINK2_CHANNEL_OPENING ? "opening" : "closed", name,
             (unsigned long)(state == LINK2_CHANNEL_OPEN ? generation : 0));
    return JS_NewString(ctx, json);
  }
  case LINK2_QJS_POLL: {
    Link2Message message;
    if (!usable || !link2_channel_poll(client, channel, &message)) return JS_UNDEFINED;
    /* {"k":kind,"id":handle,"s":stream handle,"e":error,"m":<the object>}: one parse in the guest. */
    char head[96];
    size_t used = (size_t)snprintf(head, sizeof head, "{\"k\":%d,\"id\":", message.kind);
    used += handle_digits(head + used, handle_of(generation, message.id));
    memcpy(head + used, ",\"s\":", 5);
    used += 5;
    used += handle_digits(head + used, handle_of(generation, message.stream));
    used += (size_t)snprintf(head + used, sizeof head - used, ",\"e\":%s,\"m\":", message.error ? "true" : "false");
    bool has_json = message.json != NULL && message.length > 0;
    size_t body = has_json ? message.length : 4;
    if (used + body + 1 > scratch_bytes) return JS_UNDEFINED;
    memcpy(scratch, head, used);
    memcpy(scratch + used, has_json ? message.json : "null", body);
    scratch[used + body] = '}';
    return JS_NewStringLen(ctx, scratch, used + body + 1);
  }
  case LINK2_QJS_REQUEST: {
    if (argc < 1 || !usable) return JS_NewInt32(ctx, LINK2_NO_CHANNEL);
    text = argument_json(ctx, argv[0], &text_length);
    if (text == NULL) return JS_NewInt32(ctx, LINK2_MALFORMED);
    status = link2_channel_request(client, channel, text, text_length, argc > 1 && JS_ToBool(ctx, argv[1]), &id);
    JS_FreeCString(ctx, text);
    return status == LINK2_OK ? handle_value(ctx, generation, id) : JS_NewInt32(ctx, status);
  }
  case LINK2_QJS_CANCEL:
    if (!usable) return JS_NewInt32(ctx, LINK2_NO_CHANNEL);
    status = argument_handle(ctx, argc, argv, 0, generation, &id);
    return JS_NewInt32(ctx, status == LINK2_OK ? link2_channel_cancel(client, channel, id) : status);
  case LINK2_QJS_EMIT: {
    if (argc < 1 || !usable) return JS_NewInt32(ctx, LINK2_NO_CHANNEL);
    text = argument_json(ctx, argv[0], &text_length);
    if (text == NULL) return JS_NewInt32(ctx, LINK2_MALFORMED);
    bool opens = argc > 1 && JS_ToBool(ctx, argv[1]);
    status = link2_channel_emit(client, channel, text, text_length, opens ? &id : NULL);
    JS_FreeCString(ctx, text);
    return status == LINK2_OK && opens ? handle_value(ctx, generation, id) : JS_NewInt32(ctx, status);
  }
  case LINK2_QJS_PROGRESS:
  case LINK2_QJS_REPLY: {
    if (argc < 2 || !usable) return JS_NewInt32(ctx, LINK2_NO_CHANNEL);
    status = argument_handle(ctx, argc, argv, 0, generation, &id);
    if (status != LINK2_OK) return JS_NewInt32(ctx, status);
    text = argument_json(ctx, argv[1], &text_length);
    if (text == NULL) return JS_NewInt32(ctx, LINK2_MALFORMED);
    status = operation == LINK2_QJS_PROGRESS
                 ? link2_channel_progress(client, channel, id, text, text_length)
                 : link2_channel_reply(client, channel, id, text, text_length, argc > 2 && JS_ToBool(ctx, argv[2]));
    JS_FreeCString(ctx, text);
    return JS_NewInt32(ctx, status);
  }
  case LINK2_QJS_READ:
  case LINK2_QJS_WRITE: {
    uint8_t *bytes = NULL;
    size_t byte_length = 0;
    JSValue lease = JS_UNDEFINED;
    if (!usable) return JS_NewInt32(ctx, LINK2_NO_CHANNEL);
    /* The handle first: its conversion can run guest code that frees the buffer. */
    status = argument_handle(ctx, argc, argv, 0, generation, &id);
    if (status != LINK2_OK) return JS_NewInt32(ctx, status);
    if (!argument_bytes(ctx, argc, argv, 1, &bytes, &byte_length, &lease)) return JS_NewInt32(ctx, LINK2_MALFORMED);
    /* A read fills the guest's own buffer: the lease keeps it alive here. */
    long count = operation == LINK2_QJS_READ
                     ? link2_stream_read(client, channel, id, bytes, byte_length)
                     : link2_stream_write(client, channel, id, bytes, byte_length);
    JS_FreeValue(ctx, lease);
    return JS_NewInt32(ctx, (int32_t)count);
  }
  case LINK2_QJS_END:
    if (!usable) return JS_NewInt32(ctx, LINK2_NO_CHANNEL);
    status = argument_handle(ctx, argc, argv, 0, generation, &id);
    return JS_NewInt32(ctx, status == LINK2_OK ? link2_stream_end(client, channel, id) : status);
  case LINK2_QJS_CLOSE:
    if (usable && argument_handle(ctx, argc, argv, 0, generation, &id) == LINK2_OK) {
      link2_stream_close(client, channel, id, argc > 1 && JS_ToBool(ctx, argv[1]) ? LINK2_STREAM_OUT : LINK2_STREAM_IN);
    }
    return JS_UNDEFINED;
  }
  return JS_UNDEFINED;
}
