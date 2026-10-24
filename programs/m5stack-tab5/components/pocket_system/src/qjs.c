/*
 * The guest namespaces of the system services, the same shapes the 3DS
 * product publishes (products/3ds/src/qjs.c):
 *
 *   globalThis.link    contracts/spec/link.ts (link.c)
 *   globalThis.net     contracts/spec/net.ts over the link
 *   globalThis.wifi    contracts/spec/wifi.ts (wifi.c)
 *   globalThis.fs      contracts/spec/fs.ts, when the guest's plan declares
 *                      data.fs (fs.c)
 *
 * The launcher operations (appTable, appLaunch, appShot) are ui operations
 * the program registers as a runtime operation provider. Each function here
 * reads its arguments on the guest's task and makes its C call on the system
 * task (system_run).
 */

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "fs.h"
#include "link.h"
#include "system_internal.h"

enum {
  OP_LINK_STATUS,
  OP_LINK_PAIR,
  OP_LINK_FORGET,
  OP_LINK_CATALOG,
  OP_LINK_INSTALL,
  OP_LINK_REMOVE,
  OP_LINK_POLL,
  OP_NET_START,
  OP_NET_TAKE,
  OP_NET_CANCEL,
  OP_NET_POLL,
  OP_NET_LAST_ERROR,
  OP_WIFI_STATUS,
  OP_WIFI_SET_ENABLED,
  OP_WIFI_CONNECT,
  OP_WIFI_SCAN,
  OP_WIFI_JOIN,
  OP_WIFI_FORGET,
  OP_FS_READ,
  OP_FS_WRITE,
  OP_FS_REMOVE,
  OP_FS_LIST,
  OP_FS_STAT,
  OP_FS_MKDIR,
  OP_FS_RENAME,
  OP_FS_USAGE,
  OP_FS_LAST_ERROR,
};

static int32_t argument_int(JSContext *ctx, int argc, JSValueConst *argv, int index) {
  int32_t value = 0;
  if (index < argc) JS_ToInt32(ctx, &value, argv[index]);
  return value;
}

static double argument_float(JSContext *ctx, int argc, JSValueConst *argv, int index) {
  double value = 0;
  if (index < argc) JS_ToFloat64(ctx, &value, argv[index]);
  return value;
}

/* A string argument, NULL with length 0 when absent; free with free_text. */
static const char *argument_text(JSContext *ctx, int argc, JSValueConst *argv, int index, size_t *length) {
  *length = 0;
  if (index >= argc || !JS_IsString(argv[index])) return NULL;
  return JS_ToCStringLen(ctx, length, argv[index]);
}

static void free_text(JSContext *ctx, const char *text) {
  if (text != NULL) JS_FreeCString(ctx, text);
}

/* An ArrayBuffer or a view of one, borrowed until JS runs again. */
static bool argument_bytes(JSContext *ctx, int argc, JSValueConst *argv, int index, uint8_t **bytes,
                           size_t *length) {
  if (index >= argc) return false;
  size_t direct_length = 0;
  uint8_t *direct = JS_GetArrayBuffer(ctx, &direct_length, argv[index]);
  if (direct != NULL) {
    *bytes = direct;
    *length = direct_length;
    return true;
  }
  JS_FreeValue(ctx, JS_GetException(ctx));
  size_t offset = 0;
  size_t view_length = 0;
  size_t element = 0;
  JSValue buffer = JS_GetTypedArrayBuffer(ctx, argv[index], &offset, &view_length, &element);
  if (JS_IsException(buffer)) {
    JS_FreeValue(ctx, JS_GetException(ctx));
    return false;
  }
  size_t base_length = 0;
  uint8_t *base = JS_GetArrayBuffer(ctx, &base_length, buffer);
  JS_FreeValue(ctx, buffer);
  if (base == NULL || offset + view_length > base_length) {
    JS_FreeValue(ctx, JS_GetException(ctx));
    return false;
  }
  *bytes = base + offset;
  *length = view_length;
  return true;
}

/* One call's arguments and result. The C call runs on the system task
 * (system_run): storage and NVS are flash, which a PSRAM stack cannot touch. */
typedef enum { RESULT_UNDEFINED, RESULT_TEXT, RESULT_TEXT_OR_UNDEFINED, RESULT_INT, RESULT_BOOL } ResultKind;

typedef struct {
  int magic;
  const char *text;
  size_t length;
  const char *second;
  size_t second_length;
  uint8_t *bytes;
  size_t byte_length;
  int32_t number;
  double first_float;
  double second_float;
  ResultKind kind;
  const char *out_text;
  int32_t out_int;
  bool out_bool;
} Request;

static void text_result(Request *request, const char *text) {
  request->kind = RESULT_TEXT;
  request->out_text = text;
}

static void fs_result(Request *request, const char *line) {
  text_result(request, line != NULL ? line : "{\"error\":\"out of memory\"}");
}

static void int_result(Request *request, int32_t value) {
  request->kind = RESULT_INT;
  request->out_int = value;
}

static void bool_result(Request *request, bool value) {
  request->kind = RESULT_BOOL;
  request->out_bool = value;
}

static void perform(void *argument) {
  Request *r = argument;
  r->kind = RESULT_UNDEFINED;
  switch (r->magic) {
    case OP_LINK_STATUS:
      text_result(r, link_status_json());
      break;
    case OP_LINK_PAIR:
      bool_result(r, r->text != NULL && link_pair(r->text, r->length));
      break;
    case OP_LINK_FORGET:
      bool_result(r, r->text != NULL && link_forget(r->text));
      break;
    case OP_LINK_REMOVE:
      bool_result(r, r->text != NULL && link_remove(r->text, r->length));
      break;
    case OP_LINK_INSTALL:
      int_result(r, r->text == NULL ? -1 : link_install(r->text, r->length));
      break;
    case OP_LINK_CATALOG:
      int_result(r, link_catalog());
      break;
    case OP_LINK_POLL:
      r->kind = RESULT_TEXT_OR_UNDEFINED;
      r->out_text = link_poll();
      break;
    case OP_NET_START:
      int_result(r, r->text == NULL ? -1 : link_net_start(r->text, r->length, r->bytes, r->byte_length));
      break;
    case OP_NET_TAKE:
      int_result(r, r->bytes == NULL ? -1 : link_net_take(r->number, r->bytes, r->byte_length));
      break;
    case OP_NET_CANCEL:
      link_net_cancel(r->number);
      break;
    case OP_NET_POLL:
      r->kind = RESULT_TEXT_OR_UNDEFINED;
      r->out_text = link_net_poll();
      break;
    case OP_NET_LAST_ERROR:
      text_result(r, link_net_last_error());
      break;
    case OP_WIFI_STATUS:
      text_result(r, wifi_status_json());
      break;
    case OP_WIFI_SET_ENABLED:
      bool_result(r, wifi_set_enabled(r->number != 0));
      break;
    case OP_WIFI_CONNECT:
      bool_result(r, wifi_connect(r->number));
      break;
    case OP_WIFI_SCAN:
      bool_result(r, wifi_scan());
      break;
    case OP_WIFI_JOIN:
      bool_result(r, r->text != NULL &&
                         wifi_join(r->text, r->length, r->second != NULL ? r->second : "", r->second_length));
      break;
    case OP_WIFI_FORGET:
      bool_result(r, wifi_forget(r->number));
      break;
    case OP_FS_READ:
      fs_result(r, fs_read(r->text, r->length, r->first_float, r->second_float));
      break;
    case OP_FS_LIST:
      fs_result(r, fs_list(r->text, r->length, r->first_float));
      break;
    case OP_FS_STAT:
      fs_result(r, fs_stat(r->text, r->length));
      break;
    case OP_FS_WRITE:
      int_result(r, fs_write(r->text, r->length, r->second, r->second_length, r->number));
      break;
    case OP_FS_REMOVE:
      int_result(r, fs_remove(r->text, r->length, r->number));
      break;
    case OP_FS_MKDIR:
      int_result(r, fs_mkdir(r->text, r->length));
      break;
    case OP_FS_RENAME:
      int_result(r, fs_rename(r->text, r->length, r->second, r->second_length));
      break;
    case OP_FS_USAGE:
      fs_result(r, fs_usage());
      break;
    case OP_FS_LAST_ERROR:
      text_result(r, fs_last_error());
      break;
    default:
      break;
  }
}

static JSValue operation(JSContext *ctx, JSValueConst this_value, int argc, JSValueConst *argv, int magic) {
  (void)this_value;
  Request request = { .magic = magic };
  switch (magic) {
    case OP_LINK_PAIR:
    case OP_LINK_FORGET:
    case OP_LINK_REMOVE:
    case OP_LINK_INSTALL:
    case OP_FS_STAT:
    case OP_FS_MKDIR:
      request.text = argument_text(ctx, argc, argv, 0, &request.length);
      break;
    case OP_NET_START:
      request.text = argument_text(ctx, argc, argv, 0, &request.length);
      /* Borrowed after the string conversion and used before JS runs again:
       * start() copies the body. */
      if (!argument_bytes(ctx, argc, argv, 1, &request.bytes, &request.byte_length)) {
        request.bytes = NULL;
        request.byte_length = 0;
      }
      break;
    case OP_NET_TAKE:
      request.number = argument_int(ctx, argc, argv, 0);
      if (!argument_bytes(ctx, argc, argv, 1, &request.bytes, &request.byte_length)) request.bytes = NULL;
      break;
    case OP_NET_CANCEL:
    case OP_WIFI_CONNECT:
    case OP_WIFI_FORGET:
      request.number = argument_int(ctx, argc, argv, 0);
      break;
    case OP_WIFI_SET_ENABLED:
      request.number = argc > 0 && JS_ToBool(ctx, argv[0]) ? 1 : 0;
      break;
    case OP_WIFI_JOIN:
    case OP_FS_RENAME:
      request.text = argument_text(ctx, argc, argv, 0, &request.length);
      request.second = argument_text(ctx, argc, argv, 1, &request.second_length);
      break;
    case OP_FS_READ:
    case OP_FS_LIST:
      request.text = argument_text(ctx, argc, argv, 0, &request.length);
      request.first_float = argument_float(ctx, argc, argv, 1);
      request.second_float = argument_float(ctx, argc, argv, 2);
      break;
    case OP_FS_WRITE:
      request.text = argument_text(ctx, argc, argv, 0, &request.length);
      request.second = argument_text(ctx, argc, argv, 1, &request.second_length);
      request.number = argument_int(ctx, argc, argv, 2);
      break;
    case OP_FS_REMOVE:
      request.text = argument_text(ctx, argc, argv, 0, &request.length);
      request.number = argument_int(ctx, argc, argv, 1);
      break;
    default:
      break;
  }
  system_run(perform, &request);
  free_text(ctx, request.text);
  free_text(ctx, request.second);
  switch (request.kind) {
    case RESULT_TEXT:
      return JS_NewString(ctx, request.out_text);
    case RESULT_TEXT_OR_UNDEFINED:
      return request.out_text == NULL ? JS_UNDEFINED : JS_NewString(ctx, request.out_text);
    case RESULT_INT:
      return JS_NewInt32(ctx, request.out_int);
    case RESULT_BOOL:
      return JS_NewBool(ctx, request.out_bool);
    default:
      return JS_UNDEFINED;
  }
}

static void add(JSContext *ctx, JSValue object, const char *name, int arity, int magic) {
  JS_SetPropertyStr(ctx, object, name,
                    JS_NewCFunctionMagic(ctx, operation, name, arity, JS_CFUNC_generic_magic, magic));
}

esp_err_t system_qjs_install(JSContext *ctx) {
  JSValue global = JS_GetGlobalObject(ctx);

  JSValue link = JS_NewObject(ctx);
  add(ctx, link, "status", 0, OP_LINK_STATUS);
  add(ctx, link, "pair", 1, OP_LINK_PAIR);
  add(ctx, link, "forget", 1, OP_LINK_FORGET);
  add(ctx, link, "catalog", 0, OP_LINK_CATALOG);
  add(ctx, link, "install", 1, OP_LINK_INSTALL);
  add(ctx, link, "remove", 1, OP_LINK_REMOVE);
  add(ctx, link, "poll", 0, OP_LINK_POLL);
  JS_SetPropertyStr(ctx, global, "link", link);

  JSValue net = JS_NewObject(ctx);
  add(ctx, net, "start", 2, OP_NET_START);
  add(ctx, net, "take", 2, OP_NET_TAKE);
  add(ctx, net, "cancel", 1, OP_NET_CANCEL);
  add(ctx, net, "poll", 0, OP_NET_POLL);
  add(ctx, net, "lastError", 0, OP_NET_LAST_ERROR);
  JS_SetPropertyStr(ctx, global, "net", net);

  JSValue wifi = JS_NewObject(ctx);
  add(ctx, wifi, "status", 0, OP_WIFI_STATUS);
  add(ctx, wifi, "setEnabled", 1, OP_WIFI_SET_ENABLED);
  add(ctx, wifi, "connect", 1, OP_WIFI_CONNECT);
  add(ctx, wifi, "scan", 0, OP_WIFI_SCAN);
  add(ctx, wifi, "join", 2, OP_WIFI_JOIN);
  add(ctx, wifi, "forget", 1, OP_WIFI_FORGET);
  JS_SetPropertyStr(ctx, global, "wifi", wifi);

  /* Only a guest whose plan declares data.fs has a bound tree. */
  if (fs_bound()) {
    JSValue fs = JS_NewObject(ctx);
    add(ctx, fs, "read", 3, OP_FS_READ);
    add(ctx, fs, "write", 3, OP_FS_WRITE);
    add(ctx, fs, "remove", 2, OP_FS_REMOVE);
    add(ctx, fs, "list", 2, OP_FS_LIST);
    add(ctx, fs, "stat", 1, OP_FS_STAT);
    add(ctx, fs, "mkdir", 1, OP_FS_MKDIR);
    add(ctx, fs, "rename", 2, OP_FS_RENAME);
    add(ctx, fs, "usage", 0, OP_FS_USAGE);
    add(ctx, fs, "lastError", 0, OP_FS_LAST_ERROR);
    JS_SetPropertyStr(ctx, global, "fs", fs);
  }
  bool failed = JS_HasException(ctx);
  JS_FreeValue(ctx, global);
  return failed ? ESP_ERR_NO_MEM : ESP_OK;
}
