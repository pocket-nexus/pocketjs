#include "pocket_spec.h"
/* Product namespaces around the generated canonical QuickJS guest. */
#include "qjs.h"
#include "agent.h"
#include "camera.h"
#include "instance.h"
#include "launcher.h"
#include "link.h"
#include "media.h"
#include "offload.h"
#include "offload_coverage.h"
#include "pocket_guest_quickjs.h"
#include "wifi.h"

#include <stdlib.h>
#include <string.h>

#include "devserver.h"
#include "pocket_core.h"
#include "quickjs.h"
#include "svcwire.h"

#ifndef POCKETJS_TARGET_ID
#error "POCKETJS_TARGET_ID must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKETJS_HOST_ABI
#error "POCKETJS_HOST_ABI must come from the verified ResolvedBuildPlan"
#elif POCKETJS_HOST_ABI != POCKET_BINDING_GENERATION
#error "POCKETJS_HOST_ABI must match POCKET_BINDING_GENERATION"
#endif

/* contracts/spec/spec.ts FIXED_DT: the core steps at exactly 1/60 s, and this
 * host presents at the same rate, so the advertised simulation rate is 60. */
#define POCKETJS_SIMULATION_HZ 60
/* QuickJS recurses; the 3DS main thread's stack is set in main.c. */
/* A QuickJS call frame is expensive and mounting a UI descends the tree, so
 * this budget is spent on JSX NESTING DEPTH rather than node count. 192 KiB
 * was not enough for an ordinary windowed app: opening one Pocket Shell
 * applet whose rows carried a wrapper view overflowed it mid-frame, and the
 * runtime rolled the whole guest back to last-good. The main thread's own
 * stack is 1 MiB (main.c) and this limit costs nothing until it is used. */
#define POCKETJS_JS_STACK_SIZE (384 * 1024)

typedef enum {
  HostMediaOpen,
  HostMediaClose,
  HostMediaPaused,
  HostMediaVolume,
  HostMediaTexture,
  HostMediaStatus,
  HostOffloadSession,
  HostOffloadSubmit,
  HostOffloadTake,
  HostOffloadCoverage,
  HostDebugFrames,
  HostDbgActive,
  HostDbgConnected,
  HostDbgPoll,
  HostDbgSend,
  HostDbgShot,
  HostLinkStatus,
  HostLinkPair,
  HostLinkForget,
  HostLinkCatalog,
  HostLinkInstall,
  HostLinkRemove,
  HostLinkPoll,
  HostNetStart,
  HostNetTake,
  HostNetCancel,
  HostNetPoll,
  HostNetLastError,
  HostWifiStatus,
  HostWifiSetEnabled,
  HostWifiConnect,
  HostCameraOpen,
  HostCameraClose,
  HostCameraPoll,
  HostCameraInfo,
  HostAgentPoll,
  HostAgentSend,
  HostAgentStage,
  HostAgentListen,
  HostAgentLevel,
  HostAgentShot,
  HostAgentStatus,
} HostOperation;

static JSRuntime *runtime;
static JSContext *context;
static JSValue global;
static pocket_guest_quickjs *guest;
static pocket_runtime *instance;
/* Wide enough for a message plus the frames QuickJS keeps for it. */
static char last_error[1024];
static char debug_poll_buffer[32 * 1024];
/* contracts/spec/spec.ts SVC_POLL_BUF + the terminating NUL. */
static uint8_t coverage_pixels[16384 * 4];
static bool coverage_used;

static void set_error(const char *message) {
  size_t length = message == NULL ? 0 : strlen(message);
  if (length >= sizeof last_error)
    length = sizeof last_error - 1;
  if (length > 0)
    memcpy(last_error, message, length);
  last_error[length] = '\0';
}

// ---------------------------------------------------------------------------
// argument helpers
// ---------------------------------------------------------------------------

static int32_t argument_int(JSContext *ctx, int argc, JSValueConst *argv,
                            int index) {
  int32_t value = 0;
  if (index < argc)
    JS_ToInt32(ctx, &value, argv[index]);
  return value;
}

#ifdef POCKETJS_MEDIA
static double argument_float(JSContext *ctx, int argc, JSValueConst *argv,
                             int index) {
  double value = 0.0;
  if (index < argc)
    JS_ToFloat64(ctx, &value, argv[index]);
  return value;
}
#endif

/* Native typed-array access bypasses script getters and retains the backing
 * allocation until the synchronous product service has consumed the slice. */
static int argument_bytes(JSContext *ctx, int argc, JSValueConst *argv,
                          int index, const uint8_t **bytes, size_t *length,
                          JSValue *lease) {
  if (index >= argc)
    return 0;
  size_t size = 0;
  uint8_t *data = JS_GetArrayBuffer(ctx, &size, argv[index]);
  if (data) {
    *lease = JS_DupValue(ctx, argv[index]);
    *bytes = data;
    *length = size;
    return 1;
  }
  JS_FreeValue(ctx, JS_GetException(ctx));
  size_t offset = 0, view_length = 0, element = 0;
  JSValue buffer =
      JS_GetTypedArrayBuffer(ctx, argv[index], &offset, &view_length, &element);
  if (JS_IsException(buffer)) {
    JS_FreeValue(ctx, JS_GetException(ctx));
    return 0;
  }
  data = JS_GetArrayBuffer(ctx, &size, buffer);
  if (!data || offset > size || view_length > size - offset) {
    JS_FreeValue(ctx, buffer);
    return 0;
  }
  *lease = buffer;
  *bytes = data + offset;
  *length = view_length;
  return 1;
}

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

static JSValue host_operation(JSContext *ctx, JSValueConst this_value, int argc,
                              JSValueConst *argv, int magic) {
  (void)this_value;
  const uint8_t *bytes = NULL;
  size_t byte_length = 0;
  const char *text = NULL;
  size_t text_length = 0;
  JSValue lease = JS_UNDEFINED;

  switch ((HostOperation)magic) {
#ifdef POCKETJS_MEDIA
  case HostMediaOpen: {
    if (argc < 3)
      return JS_FALSE;
    size_t host_length = 0, token_length = 0;
    const char *host = JS_ToCStringLen(ctx, &host_length, argv[0]);
    const char *token = JS_ToCStringLen(ctx, &token_length, argv[2]);
    bool ok =
        host && token && host_length <= 15 && token_length == 64 &&
        media_open(host, (unsigned)argument_int(ctx, argc, argv, 1), token);
    if (host)
      JS_FreeCString(ctx, host);
    if (token)
      JS_FreeCString(ctx, token);
    return JS_NewBool(ctx, ok);
  }
  case HostMediaClose:
    media_close();
    return JS_UNDEFINED;
  case HostMediaPaused:
    media_paused(argc > 0 && JS_ToBool(ctx, argv[0]));
    return JS_UNDEFINED;
  case HostMediaVolume:
    media_volume((float)argument_float(ctx, argc, argv, 0));
    return JS_UNDEFINED;
  case HostMediaTexture:
    return JS_NewInt32(ctx, media_texture_handle());
  case HostMediaStatus: {
    char status[640];
    media_snapshot(status, sizeof status);
    return JS_NewString(ctx, status);
  }
#endif
  case HostDebugFrames:
    return JS_NewString(ctx, devserver_debug_frames());
  case HostDbgActive:
    return JS_NewBool(ctx, devserver_active());
  case HostDbgConnected:
    return JS_NewBool(ctx, devserver_connected());
  case HostDbgPoll: {
    size_t length =
        devserver_recv_ctrl(debug_poll_buffer, sizeof debug_poll_buffer);
    return length == 0 ? JS_UNDEFINED
                       : JS_NewStringLen(ctx, debug_poll_buffer, length);
  }
  case HostDbgSend:
    if (argc < 1)
      return JS_UNDEFINED;
    text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
    if (text != NULL) {
      devserver_send_ctrl(text, text_length);
      JS_FreeCString(ctx, text);
    }
    return JS_UNDEFINED;
  case HostOffloadCoverage: {
    if (coverage_used || argc < 4 || !JS_IsString(argv[0]))
      return JS_NewInt32(ctx, -1);
    JSValue length_value = JS_GetPropertyStr(ctx, argv[0], "length");
    int32_t chars = 0;
    JS_ToInt32(ctx, &chars, length_value);
    JS_FreeValue(ctx, length_value);
    if (chars > 2732)
      return JS_NewInt32(ctx, -1);
    coverage_used = true;
    text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
    int height = argument_int(ctx, argc, argv, 2);
    int envelope =
        text ? coverage_decode(
                   text, text_length, argument_int(ctx, argc, argv, 1), height,
                   (uint32_t)argument_int(ctx, argc, argv, 3), coverage_pixels)
             : 0;
    if (text)
      JS_FreeCString(ctx, text);
    if (!envelope)
      return JS_NewInt32(ctx, -1);
    if (argc > 4 && !JS_IsUndefined(argv[4])) {
      if (argc < 6 || !JS_IsString(argv[4]) || !JS_IsString(argv[5]))
        return JS_NewInt32(ctx, -1);
      for (int i = 4; i < 6; i++) {
        JSValue size_value = JS_GetPropertyStr(ctx, argv[i], "length");
        int32_t size = 0;
        JS_ToInt32(ctx, &size, size_value);
        JS_FreeValue(ctx, size_value);
        if (size > (i == 4 ? 512 : 96))
          return JS_NewInt32(ctx, -1);
      }
      size_t columns_length = 0, palette_length = 0;
      const char *columns = JS_ToCStringLen2(ctx, &columns_length, argv[4], 0);
      const char *palette = JS_ToCStringLen2(ctx, &palette_length, argv[5], 0);
      int valid =
          columns && palette &&
          coverage_colorize(columns, columns_length, palette, palette_length,
                            argument_int(ctx, argc, argv, 1), height, envelope,
                            coverage_pixels);
      if (columns)
        JS_FreeCString(ctx, columns);
      if (palette)
        JS_FreeCString(ctx, palette);
      if (!valid)
        return JS_NewInt32(ctx, -1);
    }
    unsigned padded_height = coverage_height((unsigned)height);
    return JS_NewInt32(ctx, ui_upload_texture(coverage_pixels,
                                              envelope * padded_height * 4,
                                              envelope, padded_height, 3));
  }
  case HostOffloadSession:
    return JS_NewInt32(ctx, offload_session());
  case HostOffloadSubmit: {
    if (argc < 1 || !JS_IsString(argv[0]))
      return JS_FALSE;
    /* Reject before UTF-8 flattening: string length is a constant-time op. */
    JSValue length_value = JS_GetPropertyStr(ctx, argv[0], "length");
    int32_t chars = 0;
    JS_ToInt32(ctx, &chars, length_value);
    JS_FreeValue(ctx, length_value);
    if (chars > 4096)
      return JS_FALSE;
    text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
    bool ok = text && offload_submit(text, text_length);
    if (text)
      JS_FreeCString(ctx, text);
    return JS_NewBool(ctx, ok);
  }
  case HostOffloadTake: {
    size_t length = offload_take(debug_poll_buffer);
    return length ? JS_NewStringLen(ctx, debug_poll_buffer, length)
                  : JS_UNDEFINED;
  }
  case HostDbgShot:
    return JS_NewBool(ctx, devserver_request_screenshot());
  case HostLinkStatus:
    return JS_NewString(ctx, link_status_json());
  case HostLinkPair:
  case HostLinkForget:
  case HostLinkInstall:
  case HostLinkRemove: {
    bool is_bool = magic != HostLinkInstall;
    if (argc < 1 || !JS_IsString(argv[0]))
      return is_bool ? JS_FALSE : JS_NewInt32(ctx, -1);
    text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
    if (text == NULL)
      return is_bool ? JS_FALSE : JS_NewInt32(ctx, -1);
    JSValue result;
    if (magic == HostLinkPair)
      result = JS_NewBool(ctx, link_pair(text, text_length));
    else if (magic == HostLinkForget)
      result = JS_NewBool(ctx, link_forget(text));
    else if (magic == HostLinkRemove)
      result = JS_NewBool(ctx, link_remove(text, text_length));
    else
      result = JS_NewInt32(ctx, link_install(text, text_length));
    JS_FreeCString(ctx, text);
    return result;
  }
  case HostLinkCatalog:
    return JS_NewInt32(ctx, link_catalog());
  case HostLinkPoll:
  case HostNetPoll: {
    const char *batch = magic == HostLinkPoll ? link_poll() : link_net_poll();
    return batch == NULL ? JS_UNDEFINED : JS_NewString(ctx, batch);
  }
  case HostNetStart: {
    if (argc < 1 || !JS_IsString(argv[0]))
      return JS_NewInt32(ctx, -1);
    text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
    if (text == NULL)
      return JS_NewInt32(ctx, -1);
    /* Borrowed after the string conversion (which may allocate) and used
     * before anything else can run JS: start() copies the body. */
    if (!argument_bytes(ctx, argc, argv, 1, &bytes, &byte_length, &lease)) {
      bytes = NULL;
      byte_length = 0;
    }
    int32_t handle = link_net_start(text, text_length, bytes, byte_length);
    JS_FreeValue(ctx, lease);
    JS_FreeCString(ctx, text);
    return JS_NewInt32(ctx, handle);
  }
  case HostNetTake: {
    int32_t handle = argument_int(ctx, argc, argv, 0);
    if (!argument_bytes(ctx, argc, argv, 1, &bytes, &byte_length, &lease))
      return JS_NewInt32(ctx, -1);
    int32_t count = link_net_take(handle, (uint8_t *)bytes, byte_length);
    JS_FreeValue(ctx, lease);
    return JS_NewInt32(ctx, count);
  }
  case HostNetCancel:
    link_net_cancel(argument_int(ctx, argc, argv, 0));
    return JS_UNDEFINED;
  case HostNetLastError:
    return JS_NewString(ctx, link_net_last_error());
  case HostWifiStatus:
    return JS_NewString(ctx, wifi_status_json());
  case HostWifiSetEnabled:
    return JS_NewBool(ctx,
                      wifi_set_enabled(argc > 0 && JS_ToBool(ctx, argv[0])));
  case HostWifiConnect:
    return JS_NewBool(ctx, wifi_connect(argument_int(ctx, argc, argv, 0)));
  case HostCameraOpen:
    return JS_NewInt32(ctx, camera_open());
  case HostCameraClose:
    camera_close();
    return JS_UNDEFINED;
  case HostCameraPoll: {
    size_t length = 0;
    const char *payload = camera_poll(&length);
    return payload == NULL ? JS_UNDEFINED
                           : JS_NewStringLen(ctx, payload, length);
  }
  case HostCameraInfo:
    return JS_NewString(ctx, camera_info_json());
  case HostAgentPoll: {
    const char *batch = agent_poll();
    return batch == NULL ? JS_UNDEFINED : JS_NewString(ctx, batch);
  }
  case HostAgentSend: {
    if (argc < 1 || !JS_IsString(argv[0]))
      return JS_FALSE;
    text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
    if (text == NULL)
      return JS_FALSE;
    bool sent = agent_send(text, text_length);
    JS_FreeCString(ctx, text);
    return JS_NewBool(ctx, sent);
  }
  case HostAgentStage:
    agent_stage(argument_int(ctx, argc, argv, 0),
                argument_int(ctx, argc, argv, 1));
    return JS_UNDEFINED;
  case HostAgentListen:
    return JS_NewInt32(ctx, agent_listen(argument_int(ctx, argc, argv, 0)));
  case HostAgentLevel:
    return JS_NewInt32(ctx, agent_level());
  case HostAgentShot:
    return JS_NewInt32(ctx, agent_shot());
  case HostAgentStatus:
    return JS_NewString(ctx, agent_status_json());
  default:
    break;
  }
  return JS_UNDEFINED;
}

static void add_operation(JSValueConst object, const char *name, int arity,
                          HostOperation operation) {
  JS_SetPropertyStr(context, object, name,
                    JS_NewCFunctionMagic(context, host_operation, name, arity,
                                         JS_CFUNC_generic_magic,
                                         (int)operation));
}

static void install_host(void) {
#ifdef POCKETJS_MEDIA
  JSValue media = JS_NewObject(context);
  add_operation(media, "open", 3, HostMediaOpen);
  add_operation(media, "close", 0, HostMediaClose);
  add_operation(media, "paused", 1, HostMediaPaused);
  add_operation(media, "volume", 1, HostMediaVolume);
  add_operation(media, "texture", 0, HostMediaTexture);
  add_operation(media, "status", 0, HostMediaStatus);
  JS_SetPropertyStr(context, global, "media", media);
#endif
#ifdef POCKETJS_OFFLOAD
  JSValue offload = JS_NewObject(context);
  add_operation(offload, "uploadCoverage", 6, HostOffloadCoverage);
  add_operation(offload, "session", 0, HostOffloadSession);
  add_operation(offload, "submit", 1, HostOffloadSubmit);
  add_operation(offload, "take", 0, HostOffloadTake);
  JS_SetPropertyStr(context, global, "offload", offload);
#endif
  JSValue ui = JS_GetPropertyStr(context, global, "ui");
  add_operation(ui, "__dbgFrames", 0, HostDebugFrames);
  add_operation(ui, "__dbgActive", 0, HostDbgActive);
  add_operation(ui, "__dbgConnected", 0, HostDbgConnected);
  add_operation(ui, "__dbgPoll", 0, HostDbgPoll);
  add_operation(ui, "__dbgSend", 1, HostDbgSend);
  add_operation(ui, "__dbgShot", 0, HostDbgShot);
  JS_FreeValue(context, ui);

  JSValue link = JS_NewObject(context);
  add_operation(link, "status", 0, HostLinkStatus);
  add_operation(link, "pair", 1, HostLinkPair);
  add_operation(link, "forget", 1, HostLinkForget);
  add_operation(link, "catalog", 0, HostLinkCatalog);
  add_operation(link, "install", 1, HostLinkInstall);
  add_operation(link, "remove", 1, HostLinkRemove);
  add_operation(link, "poll", 0, HostLinkPoll);
  JS_SetPropertyStr(context, global, "link", link);

  JSValue net = JS_NewObject(context);
  add_operation(net, "start", 2, HostNetStart);
  add_operation(net, "take", 2, HostNetTake);
  add_operation(net, "cancel", 1, HostNetCancel);
  add_operation(net, "poll", 0, HostNetPoll);
  add_operation(net, "lastError", 0, HostNetLastError);
  JS_SetPropertyStr(context, global, "net", net);

  JSValue wifi = JS_NewObject(context);
  add_operation(wifi, "status", 0, HostWifiStatus);
  add_operation(wifi, "setEnabled", 1, HostWifiSetEnabled);
  add_operation(wifi, "connect", 1, HostWifiConnect);
  JS_SetPropertyStr(context, global, "wifi", wifi);

  JSValue camera = JS_NewObject(context);
  add_operation(camera, "open", 0, HostCameraOpen);
  add_operation(camera, "close", 0, HostCameraClose);
  add_operation(camera, "poll", 0, HostCameraPoll);
  add_operation(camera, "info", 0, HostCameraInfo);
  JS_SetPropertyStr(context, global, "camera", camera);

  /* Only a guest that declared "system.agent" sees the namespace. */
  if (agent_enabled()) {
    JSValue agent = JS_NewObject(context);
    add_operation(agent, "poll", 0, HostAgentPoll);
    add_operation(agent, "send", 1, HostAgentSend);
    add_operation(agent, "stage", 2, HostAgentStage);
    add_operation(agent, "listen", 1, HostAgentListen);
    add_operation(agent, "level", 0, HostAgentLevel);
    add_operation(agent, "shot", 0, HostAgentShot);
    add_operation(agent, "status", 0, HostAgentStatus);
    JS_SetPropertyStr(context, global, "agent", agent);
  }
}

/* The generated guest owns Ui metadata, pak storage and all numbered ops.
 * This wrapper only installs product namespaces and performs frame-local I/O.
 */
static int32_t guest_initialize(void *self, pocket_runtime *owner,
                                const pocket_guest_environment *environment) {
  (void)self;
  int32_t status =
      pocket_guest_quickjs_vtable()->initialize(guest, owner, environment);
  if (status)
    return status;
  global = JS_GetGlobalObject(context);
  install_host();
  return 0;
}
static int32_t guest_evaluate(void *self, pocket_runtime *owner,
                              const uint8_t *code, size_t length) {
  (void)self;
  return pocket_guest_quickjs_vtable()->evaluate(guest, owner, code, length);
}
static int32_t guest_frame(void *self, const pocket_guest_frame *frame) {
  (void)self;
  offload_frame();
  coverage_used = false;
  return pocket_guest_quickjs_vtable()->frame(guest, frame);
}
static int32_t guest_collect(void *self) {
  (void)self;
  return pocket_guest_quickjs_vtable()->collect(guest);
}
static void guest_shutdown(void *self) {
  (void)self;
  pocket_guest_quickjs_vtable()->shutdown(guest);
}
static const pocket_guest_v1 guest_api = {sizeof guest_api, guest_evaluate,
                                          guest_frame,      guest_collect,
                                          guest_shutdown,   guest_initialize};

bool qjs_boot(PocketRuntimePackage *package) {
  last_error[0] = 0;
  global = JS_UNDEFINED;
  runtime = JS_NewRuntime();
  if (!runtime) {
    set_error("JS_NewRuntime returned null");
    return false;
  }
  JS_SetMaxStackSize(runtime, POCKETJS_JS_STACK_SIZE);
  context = JS_NewContext(runtime);
  if (!context) {
    set_error("JS_NewContext returned null");
    return false;
  }
  guest = pocket_guest_quickjs_attach(context, POCKET_QJS_CANONICAL);
  if (!guest) {
    set_error("QuickJS guest attachment failed");
    return false;
  }
  instance = instance_create(package);
  if (!instance || pocket_runtime_set_guest(instance, &guest_api, NULL)) {
    set_error("3DS runtime composition failed");
    return false;
  }
  if (pocket_runtime_boot(instance)) {
    const char *message = pocket_guest_quickjs_error(guest);
    set_error(message && *message
                  ? message
                  : "3DS runtime admission or guest initialization failed");
    return false;
  }
  return true;
}
bool qjs_frame(int32_t buttons, int32_t analog, const uint32_t *touches,
               size_t count, int32_t right) {
  if (!instance)
    return false;
  instance_input(buttons, analog, touches, count, right);
  if (pocket_runtime_tick(instance)) {
    const char *message = pocket_guest_quickjs_error(guest);
    set_error(message && *message ? message
                                  : "3DS runtime frame or presentation failed");
    return false;
  }
  return true;
}
const char *qjs_last_error(void) { return last_error; }
void qjs_shutdown(void) {
  instance_destroy();
  instance = NULL;
#ifdef POCKETJS_MEDIA
  media_forget_guest();
#endif
  if (guest) {
    pocket_guest_quickjs_destroy(guest);
    guest = NULL;
  }
  if (context) {
    JS_FreeValue(context, global);
    JS_FreeContext(context);
    context = NULL;
  }
  if (runtime) {
    JS_FreeRuntime(runtime);
    runtime = NULL;
  }
  global = JS_UNDEFINED;
}
