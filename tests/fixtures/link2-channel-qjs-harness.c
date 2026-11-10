/*
 * Host harness for `globalThis.link.channel` (engine/host-services/link2_channel_qjs.c)
 * in a real QuickJS, under ASan. The client's channel calls are stubbed: a
 * request is answered by a REPLY that echoes it, a read fills the whole buffer
 * the binding passes, a write reads every byte it is given, and each call the
 * binding makes is recorded for the script to see.
 *
 *   link2-channel-qjs-harness <script.js> [--no-client]
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "link2_channel_qjs.h"

struct Link2 {
  int unused;
};
static struct Link2 the_link;
static bool no_client;
static uint32_t generation = 7;
static uint32_t next_id = 3;
static char queued[16][9000];
static size_t queued_length[16];
static uint32_t queued_id[16];
static int queue_head, queue_tail;
static volatile uint32_t sink;
static char poll_copy[9000];
static char last_call[96];
static unsigned stub_calls;

static void record(const char *name, uint32_t id, long detail) {
  stub_calls += 1;
  snprintf(last_call, sizeof last_call, "%s %lu %ld", name, (unsigned long)id, detail);
}

int link2_channel_state(const Link2 *link, int channel, const char **reason) {
  (void)link; (void)channel;
  if (reason != NULL) *reason = "";
  return LINK2_CHANNEL_OPEN;
}
uint32_t link2_channel_generation(const Link2 *link, int channel) { (void)link; (void)channel; return generation; }
bool link2_channel_poll(Link2 *link, int channel, Link2Message *message) {
  (void)link; (void)channel;
  if (queue_head == queue_tail) return false;
  int at = queue_head++ % 16;
  memset(message, 0, sizeof *message);
  message->kind = LINK2_MESSAGE_REPLY;
  message->id = queued_id[at];
  /* The real client hands out memory that is valid until the next call. */
  memcpy(poll_copy, queued[at], queued_length[at]);
  message->json = poll_copy;
  message->length = queued_length[at];
  return true;
}
int link2_channel_request(Link2 *link, int channel, const char *json, size_t length, bool body, uint32_t *id) {
  (void)link; (void)channel; (void)body;
  if (length > 8192) return LINK2_TOO_LARGE;
  if (length < 2 || json[0] != '{') return LINK2_MALFORMED;
  if (queue_tail - queue_head >= 16) return LINK2_FULL;
  int at = queue_tail++ % 16;
  memcpy(queued[at], json, length);
  queued_length[at] = length;
  queued_id[at] = next_id;
  *id = next_id++;
  record("request", *id, (long)length);
  return LINK2_OK;
}
int link2_channel_cancel(Link2 *link, int channel, uint32_t id) { (void)link; (void)channel; record("cancel", id, 0); return LINK2_OK; }
int link2_channel_emit(Link2 *link, int channel, const char *json, size_t length, uint32_t *stream) {
  (void)link; (void)channel;
  for (size_t i = 0; i < length; i += 1) sink += (uint8_t)json[i];
  if (stream != NULL) *stream = next_id++;
  record("emit", stream != NULL ? *stream : 0, (long)length);
  return LINK2_OK;
}
int link2_channel_progress(Link2 *link, int channel, uint32_t id, const char *json, size_t length) {
  (void)link; (void)channel;
  for (size_t i = 0; i < length; i += 1) sink += (uint8_t)json[i];
  record("progress", id, (long)length);
  return LINK2_OK;
}
int link2_channel_reply(Link2 *link, int channel, uint32_t id, const char *json, size_t length, bool error) {
  (void)link; (void)channel; (void)error;
  for (size_t i = 0; i < length; i += 1) sink += (uint8_t)json[i];
  record("reply", id, (long)length);
  return LINK2_OK;
}
/* As the client with a full window: every byte of the capacity is written. */
long link2_stream_read(Link2 *link, int channel, uint32_t id, uint8_t *into, size_t capacity) {
  (void)link; (void)channel;
  if (capacity == 0) return LINK2_MALFORMED;
  memset(into, 0xab, capacity);
  record("read", id, (long)capacity);
  return (long)capacity;
}
long link2_stream_write(Link2 *link, int channel, uint32_t id, const uint8_t *bytes, size_t length) {
  (void)link; (void)channel;
  for (size_t i = 0; i < length; i += 1) sink += bytes[i];
  record("write", id, (long)length);
  return (long)length;
}
int link2_stream_end(Link2 *link, int channel, uint32_t id) { (void)link; (void)channel; record("end", id, 0); return LINK2_OK; }
void link2_stream_close(Link2 *link, int channel, uint32_t id, int sides) { (void)link; (void)channel; record("close", id, sides); }

enum { OpPending = 100, OpGc, OpPrint, OpMem, OpGeneration, OpReconnect, OpLastCall, OpStubCalls };
static char scratch[LINK2_QJS_SCRATCH_BYTES];

static JSValue operation(JSContext *ctx, JSValueConst this_value, int argc, JSValueConst *argv, int magic) {
  (void)this_value;
  switch (magic) {
  case OpPending: {
    /* Whether a call left an exception pending without returning one. */
    bool pending = JS_HasException(ctx);
    if (pending) JS_FreeValue(ctx, JS_GetException(ctx));
    return JS_NewBool(ctx, pending);
  }
  case OpGc:
    JS_RunGC(JS_GetRuntime(ctx));
    return JS_UNDEFINED;
  case OpMem: {
    JSMemoryUsage usage;
    JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &usage);
    return JS_NewInt64(ctx, usage.malloc_size);
  }
  case OpGeneration: {
    int32_t value = 0;
    if (argc > 0) JS_ToInt32(ctx, &value, argv[0]);
    generation = (uint32_t)value;
    return JS_UNDEFINED;
  }
  case OpReconnect:
    /* The next connection: ids from the start, a new generation. */
    next_id = 3;
    generation += 1;
    queue_head = queue_tail = 0;
    return JS_UNDEFINED;
  case OpLastCall:
    return JS_NewString(ctx, last_call);
  case OpStubCalls:
    return JS_NewInt32(ctx, (int32_t)stub_calls);
  case OpPrint: {
    for (int i = 0; i < argc; i += 1) {
      const char *text = JS_ToCString(ctx, argv[i]);
      if (text == NULL) return JS_EXCEPTION;
      fputs(text, stdout);
      fputc(i + 1 < argc ? ' ' : '\n', stdout);
      JS_FreeCString(ctx, text);
    }
    return JS_UNDEFINED;
  }
  default:
    return link2_channel_qjs(ctx, no_client ? NULL : &the_link, 0, (Link2QjsOperation)magic, argc, argv, scratch, sizeof scratch);
  }
}

static void add(JSContext *ctx, JSValueConst object, const char *name, int arity, int magic) {
  JS_SetPropertyStr(ctx, object, name, JS_NewCFunctionMagic(ctx, operation, name, arity, JS_CFUNC_generic_magic, magic));
}

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (argc > 2 && strcmp(argv[2], "--no-client") == 0) no_client = true;
  FILE *file = fopen(argv[1], "rb");
  if (file == NULL) return 2;
  static char source[1 << 20];
  size_t length = fread(source, 1, sizeof source - 1, file);
  fclose(file);
  source[length] = '\0';

  JSRuntime *runtime = JS_NewRuntime();
  JSContext *ctx = JS_NewContext(runtime);
  JSValue global = JS_GetGlobalObject(ctx);
  JSValue link = JS_NewObject(ctx);
  JSValue channel = JS_NewObject(ctx);
  add(ctx, channel, "state", 0, LINK2_QJS_STATE);
  add(ctx, channel, "poll", 0, LINK2_QJS_POLL);
  add(ctx, channel, "request", 2, LINK2_QJS_REQUEST);
  add(ctx, channel, "cancel", 1, LINK2_QJS_CANCEL);
  add(ctx, channel, "emit", 2, LINK2_QJS_EMIT);
  add(ctx, channel, "progress", 2, LINK2_QJS_PROGRESS);
  add(ctx, channel, "reply", 3, LINK2_QJS_REPLY);
  add(ctx, channel, "read", 2, LINK2_QJS_READ);
  add(ctx, channel, "write", 2, LINK2_QJS_WRITE);
  add(ctx, channel, "end", 1, LINK2_QJS_END);
  add(ctx, channel, "close", 2, LINK2_QJS_CLOSE);
  JS_SetPropertyStr(ctx, link, "channel", channel);
  JS_SetPropertyStr(ctx, global, "link", link);
  add(ctx, global, "pending", 0, OpPending);
  add(ctx, global, "gc", 0, OpGc);
  add(ctx, global, "print", 1, OpPrint);
  add(ctx, global, "mem", 0, OpMem);
  add(ctx, global, "setGeneration", 1, OpGeneration);
  add(ctx, global, "reconnect", 0, OpReconnect);
  add(ctx, global, "lastCall", 0, OpLastCall);
  add(ctx, global, "stubCalls", 0, OpStubCalls);
  JS_FreeValue(ctx, global);

  int status = 0;
  JSValue result = JS_Eval(ctx, source, length, argv[1], JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(result)) {
    JSValue exception = JS_GetException(ctx);
    const char *text = JS_ToCString(ctx, exception);
    printf("EXCEPTION: %s\n", text != NULL ? text : "?");
    if (text != NULL) JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, exception);
    status = 1;
  }
  JS_FreeValue(ctx, result);
  if (JS_HasException(ctx)) {
    printf("an exception is still pending at the end of the script\n");
    JS_FreeValue(ctx, JS_GetException(ctx));
    status = 1;
  }
  JS_FreeContext(ctx);
  JS_FreeRuntime(runtime);
  printf("runtime freed\n");
  return status;
}
