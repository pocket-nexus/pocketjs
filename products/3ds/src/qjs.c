#include "pocket_spec.h"
/* Product namespaces around the generated canonical QuickJS guest. */
#include "qjs.h"
#include "agent.h"
#include "camera.h"
#include "fs.h"
#include "instance.h"
#include "launcher.h"
#include "link2_channel_qjs.h"
#include "link2_guest.h"
#include "link2_host.h"
#include "media.h"
#include "offload.h"
#include "offload_coverage.h"
#include "photos.h"
#include "pocket_guest_quickjs.h"
#include "pocket_profile.h"
#include "pocket_qjs_program.h"
#include "wifi.h"
#include "worker.h"
#include "pocket/worker.h"
#include "pocket/worker_ui.h"

#include <malloc.h>
#include <stdlib.h>
#include <string.h>

#include "devstats.h"
#include "pocket_core.h"
#include "quickjs.h"
#include "svcwire.h"
#ifdef POCKETJS_EXTENSION
#include "pocket_extension.h"
#endif

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
  HostDbgLog,
  HostDbgMemory,
  HostDbgShot,
  HostLinkStatus,
  HostLinkPair,
  HostLinkForget,
  HostLinkCatalog,
  HostLinkInstall,
  HostLinkRemove,
  HostLinkPoll,
  HostChannelState,
  HostChannelPoll,
  HostChannelRequest,
  HostChannelCancel,
  HostChannelEmit,
  HostChannelProgress,
  HostChannelReply,
  HostChannelRead,
  HostChannelWrite,
  HostChannelEnd,
  HostChannelClose,
  HostWifiStatus,
  HostWifiSetEnabled,
  HostWifiConnect,
  HostCameraOpen,
  HostCameraClose,
  HostCameraPoll,
  HostCameraInfo,
  HostCameraCapture,
  HostCameraPhotos,
  HostCameraLoad,
  HostCameraFree,
  HostCameraRemove,
  HostCameraEvents,
  HostAgentPoll,
  HostAgentSend,
  HostAgentStage,
  HostAgentListen,
  HostAgentLevel,
  HostAgentShot,
  HostAgentStatus,
  HostAgentDisplay,
  HostAgentSetDisplay,
  HostAgentHomeHint,
  HostFsRead,
  HostFsWrite,
  HostFsRemove,
  HostFsList,
  HostFsStat,
  HostFsMkdir,
  HostFsRename,
  HostFsUsage,
  HostFsLastError,
} HostOperation;

static JSRuntime *runtime;
static JSContext *context;
static JSValue global;
static pocket_guest_quickjs *guest;
/* The handle-based facade owns the native program and its runtime; this
 * realm and guest_api are its host guest. */
static PocketQjsProgram *program;
static pocket_runtime *instance;
/* compose ran for the boot in progress: a later failure is admission or
 * guest initialization, not composition. */
static bool composed;
/* Wide enough for a message plus the frames QuickJS keeps for it. */
static char last_error[1024];
static char debug_poll_buffer[32 * 1024];
/* contracts/spec/spec.ts SVC_POLL_BUF + the terminating NUL. */
static uint8_t coverage_pixels[16384 * 4];
static bool coverage_used;
static QjsInterrupt interrupt_hook;
static bool interrupted;
/* The bundle's form for the boot in progress (qjs_boot), read by
 * guest_evaluate in place of the package's source. */
static const uint8_t *boot_bytecode;
static size_t boot_bytecode_length;
static uint8_t **boot_compiled;
static size_t *boot_compiled_length;
/* The mounted tree waits for the first qjs_frame to present it. */
static bool first_present;
static bool boot_has_worker;
/* Mirrors the worker's channels into this realm; detached before either
 * the worker core or this context is destroyed. */
static pocket_worker_ui *ui_bridge;

static void set_error(const char *message) {
  size_t length = message == NULL ? 0 : strlen(message);
  if (length >= sizeof last_error)
    length = sizeof last_error - 1;
  if (length > 0)
    memcpy(last_error, message, length);
  last_error[length] = '\0';
}

/* The pending exception as one line: its message, then its stack. */
static void take_exception(void) {
  JSValue exception = JS_GetException(context);
  size_t length = 0;
  const char *message = JS_ToCStringLen2(context, &length, exception, 0);
  size_t used = 0;
  if (message != NULL) {
    used = length < sizeof last_error - 1 ? length : sizeof last_error - 1;
    memcpy(last_error, message, used);
    JS_FreeCString(context, message);
  } else {
    const char *fallback = "QuickJS exception";
    used = strlen(fallback);
    memcpy(last_error, fallback, used);
  }
  last_error[used] = '\0';
  if (JS_IsObject(exception) && used + 2 < sizeof last_error - 1) {
    JSValue stack = JS_GetPropertyStr(context, exception, "stack");
    size_t stack_length = 0;
    const char *frames = JS_IsException(stack)
                             ? NULL
                             : JS_ToCStringLen2(context, &stack_length, stack, 0);
    if (frames != NULL) {
      size_t room = sizeof last_error - 1 - used - 1;
      size_t copy = stack_length < room ? stack_length : room;
      last_error[used] = ' ';
      /* Flattened: the error travels as one line, over the link and into
       * error.txt alike. */
      for (size_t i = 0; i < copy; i += 1)
        last_error[used + 1 + i] = frames[i] == '\n' ? ' ' : frames[i];
      last_error[used + 1 + copy] = '\0';
      JS_FreeCString(context, frames);
    }
    JS_FreeValue(context, stack);
  }
  JS_FreeValue(context, exception);
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

static double argument_float(JSContext *ctx, int argc, JSValueConst *argv,
                             int index) {
  double value = 0.0;
  if (index < argc)
    JS_ToFloat64(ctx, &value, argv[index]);
  return value;
}

/* A string argument as UTF-8 for fs.c; NO_TEXT when absent. Release with
 * free_text. */
static const char NO_TEXT[] = "";

static const char *argument_text(JSContext *ctx, int argc, JSValueConst *argv,
                                 int index, size_t *length) {
  *length = 0;
  if (index >= argc)
    return NO_TEXT;
  const char *text = JS_ToCStringLen2(ctx, length, argv[index], 0);
  return text != NULL ? text : NO_TEXT;
}

static void free_text(JSContext *ctx, const char *text) {
  if (text != NO_TEXT)
    JS_FreeCString(ctx, text);
}

// ---------------------------------------------------------------------------
// link.channel
// ---------------------------------------------------------------------------

/* The bindings are link2_channel_qjs.c, which the host tests compile too. */
static JSValue channel_operation(JSContext *ctx, int argc, JSValueConst *argv, HostOperation operation) {
  Link2QjsOperation call;
  switch (operation) {
  case HostChannelState: call = LINK2_QJS_STATE; break;
  case HostChannelPoll: call = LINK2_QJS_POLL; break;
  case HostChannelRequest: call = LINK2_QJS_REQUEST; break;
  case HostChannelCancel: call = LINK2_QJS_CANCEL; break;
  case HostChannelEmit: call = LINK2_QJS_EMIT; break;
  case HostChannelProgress: call = LINK2_QJS_PROGRESS; break;
  case HostChannelReply: call = LINK2_QJS_REPLY; break;
  case HostChannelRead: call = LINK2_QJS_READ; break;
  case HostChannelWrite: call = LINK2_QJS_WRITE; break;
  case HostChannelEnd: call = LINK2_QJS_END; break;
  case HostChannelClose: call = LINK2_QJS_CLOSE; break;
  default: return JS_UNDEFINED;
  }
  return link2_channel_qjs(ctx, link2_host_client(), link2_host_channel(), call, argc, argv, debug_poll_buffer, sizeof debug_poll_buffer);
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
    return JS_NewString(ctx, devstats_frames());
  /* DevTools reaches the shim over the link's stream
   * (docs/POCKET-LINK.md §6.3). The shim asks `active` once as it installs,
   * which is how the program learns this guest has one. */
  case HostDbgActive:
    return JS_NewBool(ctx, link2_host_devtools_active());
  case HostDbgConnected:
    return JS_NewBool(ctx, link2_host_devtools_listening());
  case HostDbgPoll: {
    size_t length = link2_host_devtools_poll(debug_poll_buffer, sizeof debug_poll_buffer);
    return length == 0 ? JS_UNDEFINED
                       : JS_NewStringLen(ctx, debug_poll_buffer, length);
  }
  case HostDbgSend:
    if (argc < 1)
      return JS_UNDEFINED;
    text = JS_ToCStringLen2(ctx, &text_length, argv[0], 0);
    if (text != NULL) {
      link2_host_devtools_send(text, text_length);
      JS_FreeCString(ctx, text);
    } else {
      JS_FreeValue(ctx, JS_GetException(ctx));
    }
    return JS_UNDEFINED;
  /* A console line of the guest, for runtime.logs: it travels as a `log`
   * event whether a DevTools panel listens or not. */
  case HostDbgLog: {
    if (argc < 2)
      return JS_UNDEFINED;
    const char *level = JS_ToCString(ctx, argv[0]);
    text = JS_ToCStringLen2(ctx, &text_length, argv[1], 0);
    /* A value that does not convert leaves no exception behind this call. */
    if (level == NULL || text == NULL)
      JS_FreeValue(ctx, JS_GetException(ctx));
    if (level != NULL && text != NULL)
      link2_host_report_guest_log(level, text, text_length);
    if (level != NULL)
      JS_FreeCString(ctx, level);
    if (text != NULL)
      JS_FreeCString(ctx, text);
    return JS_UNDEFINED;
  }
  /* The process's memory, for a soak: newlib's heap in use and free, and the
   * linear heap's free bytes. */
  case HostDbgMemory: {
    struct mallinfo heap = mallinfo();
    char memory[360];
    uint32_t pumps = 0, pump_mean = 0, pump_max = 0;
    link2_host_pump_cost(&pumps, &pump_mean, &pump_max);
    /* The guest's own heap as QuickJS counts it. With a true argument the
     * cycle collector runs first and both figures are given: what falls
     * between them was garbage waiting for a collection, not a leak. */
    JSMemoryUsage usage;
    JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &usage);
    unsigned long js = (unsigned long)usage.malloc_size, js_objects = (unsigned long)usage.obj_count;
    unsigned long js_collected = js, js_objects_collected = js_objects;
    if (argc > 0 && JS_ToBool(ctx, argv[0])) {
      JS_RunGC(JS_GetRuntime(ctx));
      JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &usage);
      js_collected = (unsigned long)usage.malloc_size;
      js_objects_collected = (unsigned long)usage.obj_count;
      heap = mallinfo();
    }
    snprintf(memory, sizeof memory,
             "{\"heapUsed\":%lu,\"heapFree\":%lu,\"heapArena\":%lu,\"linearFree\":%lu,\"pumps\":%lu,\"pumpUs\":%lu,\"pumpMaxUs\":%lu,"
             "\"js\":%lu,\"jsObjects\":%lu,\"jsAfterGc\":%lu,\"jsObjectsAfterGc\":%lu}",
             (unsigned long)heap.uordblks, (unsigned long)heap.fordblks, (unsigned long)heap.arena, (unsigned long)linearSpaceFree(),
             (unsigned long)pumps, (unsigned long)pump_mean, (unsigned long)pump_max, js, js_objects, js_collected, js_objects_collected);
    return JS_NewString(ctx, memory);
  }
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
    return JS_NewBool(ctx, link2_host_request_screenshot());
  case HostLinkStatus:
    return JS_NewString(ctx, link2_guest_status_json());
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
    /* Pairing is written at the first install (docs/POCKET-LINK.md §3):
     * `pair` stays for packages that call it and starts nothing. */
    if (magic == HostLinkPair)
      result = JS_FALSE;
    else if (magic == HostLinkForget)
      result = JS_NewBool(ctx, link2_guest_forget(text));
    else if (magic == HostLinkRemove)
      result = JS_NewBool(ctx, link2_guest_remove(text, text_length));
    else
      result = JS_NewInt32(ctx, link2_guest_install(text, text_length));
    JS_FreeCString(ctx, text);
    return result;
  }
  case HostLinkCatalog:
    return JS_NewInt32(ctx, link2_guest_catalog());
  case HostLinkPoll: {
    const char *batch = link2_guest_poll();
    return batch == NULL ? JS_UNDEFINED : JS_NewString(ctx, batch);
  }
  /* `link.channel`: the running applet's channel to its daemon
   * (docs/POCKET-LINK.md §7.3). The client keeps the ids, the windows and the
   * per-frame budgets; these calls move whole JSON objects and byte chunks. */
  case HostChannelState:
  case HostChannelPoll:
  case HostChannelRequest:
  case HostChannelCancel:
  case HostChannelEmit:
  case HostChannelProgress:
  case HostChannelReply:
  case HostChannelRead:
  case HostChannelWrite:
  case HostChannelEnd:
  case HostChannelClose:
    return channel_operation(ctx, argc, argv, (HostOperation)magic);
  case HostWifiStatus:
    return JS_NewString(ctx, wifi_status_json());
  case HostWifiSetEnabled:
    return JS_NewBool(ctx,
                      wifi_set_enabled(argc > 0 && JS_ToBool(ctx, argv[0])));
  case HostWifiConnect:
    return JS_NewBool(ctx, wifi_connect(argument_int(ctx, argc, argv, 0)));
  case HostCameraOpen:
    return JS_NewInt32(ctx, camera_open(argc > 0 && JS_IsNumber(argv[0])
                                            ? argument_int(ctx, argc, argv, 0)
                                            : 0));
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
  case HostCameraCapture:
    return JS_NewInt32(ctx, camera_capture());
  case HostCameraPhotos:
    return JS_NewString(ctx, photos_list_json());
  case HostCameraLoad:
  case HostCameraRemove: {
    const char *name = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    JSValue out =
        magic == HostCameraLoad
            ? JS_NewInt32(ctx, photos_load(name, argument_int(ctx, argc, argv, 1)))
            : JS_NewBool(ctx, photos_remove(name));
    if (name != NULL)
      JS_FreeCString(ctx, name);
    return out;
  }
  case HostCameraFree:
    photos_free(argument_int(ctx, argc, argv, 0));
    return JS_UNDEFINED;
  case HostCameraEvents: {
    const char *events = photos_events_json();
    return events == NULL ? JS_UNDEFINED : JS_NewString(ctx, events);
  }
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
  case HostAgentDisplay:
    return JS_NewString(ctx, agent_display_mode() == AGENT_DISPLAY_SINGLE
                                 ? "single"
                                 : "dual");
  case HostAgentSetDisplay: {
    if (argc < 1 || !JS_IsString(argv[0]))
      return JS_FALSE;
    const char *mode = JS_ToCString(ctx, argv[0]);
    if (mode == NULL)
      return JS_FALSE;
    int value = strcmp(mode, "single") == 0   ? AGENT_DISPLAY_SINGLE
                : strcmp(mode, "dual") == 0 ? AGENT_DISPLAY_DUAL
                                            : -1;
    JS_FreeCString(ctx, mode);
    return JS_NewBool(ctx, agent_set_display_mode(value));
  }
  case HostAgentHomeHint:
    agent_set_home_hint(argc > 0 && JS_ToBool(ctx, argv[0]));
    return JS_UNDEFINED;
  case HostFsRead:
  case HostFsList:
  case HostFsStat: {
    size_t length = 0;
    const char *path = argument_text(ctx, argc, argv, 0, &length);
    const char *line =
        magic == HostFsRead
            ? fs_read(path, length, argument_float(ctx, argc, argv, 1),
                      argument_float(ctx, argc, argv, 2))
        : magic == HostFsList
            ? fs_list(path, length, argument_float(ctx, argc, argv, 1))
            : fs_stat(path, length);
    JSValue out =
        JS_NewString(ctx, line != NULL ? line : "{\"error\":\"out of memory\"}");
    free_text(ctx, path);
    return out;
  }
  case HostFsWrite: {
    size_t path_length = 0;
    size_t data_length = 0;
    const char *path = argument_text(ctx, argc, argv, 0, &path_length);
    const char *data = argument_text(ctx, argc, argv, 1, &data_length);
    int result = fs_write(path, path_length, data, data_length,
                          argument_int(ctx, argc, argv, 2));
    free_text(ctx, path);
    free_text(ctx, data);
    return JS_NewInt32(ctx, result);
  }
  case HostFsRemove:
  case HostFsMkdir: {
    size_t length = 0;
    const char *path = argument_text(ctx, argc, argv, 0, &length);
    int result = magic == HostFsRemove
                     ? fs_remove(path, length, argument_int(ctx, argc, argv, 1))
                     : fs_mkdir(path, length);
    free_text(ctx, path);
    return JS_NewInt32(ctx, result);
  }
  case HostFsRename: {
    size_t from_length = 0;
    size_t to_length = 0;
    const char *from = argument_text(ctx, argc, argv, 0, &from_length);
    const char *to = argument_text(ctx, argc, argv, 1, &to_length);
    int result = fs_rename(from, from_length, to, to_length);
    free_text(ctx, from);
    free_text(ctx, to);
    return JS_NewInt32(ctx, result);
  }
  case HostFsUsage: {
    const char *line = fs_usage();
    return JS_NewString(ctx, line != NULL ? line : "{\"error\":\"out of memory\"}");
  }
  case HostFsLastError:
    return JS_NewString(ctx, fs_last_error());
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

/* The worker owns the bound filesystem for worker packages. These callbacks
 * use their argument context and never touch the UI realm's global values. */
static int32_t mount_worker_services(JSContext *ctx) {
  if (!fs_bound()) return POCKET_WORKER_OK;
  const char *names[]={"read","write","remove","list","stat","mkdir","rename","usage","lastError"};
  const int arities[]={3,3,2,2,1,1,2,0,0};
  const HostOperation operations[]={HostFsRead,HostFsWrite,HostFsRemove,HostFsList,HostFsStat,HostFsMkdir,HostFsRename,HostFsUsage,HostFsLastError};
  JSValue fs=JS_NewObject(ctx),root=JS_GetGlobalObject(ctx);
  if (JS_IsException(fs)) { JS_FreeValue(ctx,root); return POCKET_WORKER_FAILED; }
  for (size_t i=0;i<sizeof names/sizeof names[0];++i) {
    JSValue fn=JS_NewCFunctionMagic(ctx,host_operation,names[i],arities[i],JS_CFUNC_generic_magic,operations[i]);
    if (JS_IsException(fn) || JS_SetPropertyStr(ctx,fs,names[i],fn)<0) {
      JS_FreeValue(ctx,fs);JS_FreeValue(ctx,root);return POCKET_WORKER_FAILED;
    }
  }
  int result=JS_SetPropertyStr(ctx,root,"fs",fs);JS_FreeValue(ctx,root);
  return result<0?POCKET_WORKER_FAILED:POCKET_WORKER_OK;
}

static int32_t install_host(void) {
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
  add_operation(ui, "__dbgLog", 2, HostDbgLog);
  add_operation(ui, "__dbgMemory", 0, HostDbgMemory);
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
  /* Only a guest that declared "link.channel" has its applet channel. */
  if (link2_host_channel_declared()) {
    JSValue channel = JS_NewObject(context);
    add_operation(channel, "state", 0, HostChannelState);
    add_operation(channel, "poll", 0, HostChannelPoll);
    add_operation(channel, "request", 2, HostChannelRequest);
    add_operation(channel, "cancel", 1, HostChannelCancel);
    add_operation(channel, "emit", 2, HostChannelEmit);
    add_operation(channel, "progress", 2, HostChannelProgress);
    add_operation(channel, "reply", 3, HostChannelReply);
    add_operation(channel, "read", 2, HostChannelRead);
    add_operation(channel, "write", 2, HostChannelWrite);
    add_operation(channel, "end", 1, HostChannelEnd);
    add_operation(channel, "close", 1, HostChannelClose);
    JS_SetPropertyStr(context, link, "channel", channel);
  }
  JS_SetPropertyStr(context, global, "link", link);

  /* The worker declared its channels during bootstrap, before this realm
   * evaluates its bundle. */
  if (boot_has_worker) {
    ui_bridge = pocket_worker_ui_attach(context, pocket_3ds_worker_core());
    if (!ui_bridge) {
      set_error("worker channel bridge attachment failed");
      return POCKET_WORKER_FAILED;
    }
  }

  JSValue wifi = JS_NewObject(context);
  add_operation(wifi, "status", 0, HostWifiStatus);
  add_operation(wifi, "setEnabled", 1, HostWifiSetEnabled);
  add_operation(wifi, "connect", 1, HostWifiConnect);
  JS_SetPropertyStr(context, global, "wifi", wifi);

  /* camera.qr publishes the viewfinder; camera.photo adds capture and the
   * photo store. A guest with neither has no namespace (main.c). */
  if (camera_viewfinder_admitted()) {
    JSValue camera = JS_NewObject(context);
    add_operation(camera, "open", 0, HostCameraOpen);
    add_operation(camera, "close", 0, HostCameraClose);
    add_operation(camera, "poll", 0, HostCameraPoll);
    add_operation(camera, "info", 0, HostCameraInfo);
    if (camera_photos_admitted()) {
      add_operation(camera, "capture", 0, HostCameraCapture);
      add_operation(camera, "photos", 0, HostCameraPhotos);
      add_operation(camera, "load", 2, HostCameraLoad);
      add_operation(camera, "free", 1, HostCameraFree);
      add_operation(camera, "remove", 1, HostCameraRemove);
      add_operation(camera, "events", 0, HostCameraEvents);
    }
    JS_SetPropertyStr(context, global, "camera", camera);
  }

  /* Only a guest that declared "data.fs" has a bound tree (main.c). */
  if (fs_bound() && !boot_has_worker) {
    JSValue fs = JS_NewObject(context);
    add_operation(fs, "read", 3, HostFsRead);
    add_operation(fs, "write", 3, HostFsWrite);
    add_operation(fs, "remove", 2, HostFsRemove);
    add_operation(fs, "list", 2, HostFsList);
    add_operation(fs, "stat", 1, HostFsStat);
    add_operation(fs, "mkdir", 1, HostFsMkdir);
    add_operation(fs, "rename", 2, HostFsRename);
    add_operation(fs, "usage", 0, HostFsUsage);
    add_operation(fs, "lastError", 0, HostFsLastError);
    JS_SetPropertyStr(context, global, "fs", fs);
  }

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
    add_operation(agent, "display", 0, HostAgentDisplay);
    add_operation(agent, "setDisplay", 1, HostAgentSetDisplay);
    add_operation(agent, "homeHint", 1, HostAgentHomeHint);
    JS_SetPropertyStr(context, global, "agent", agent);
  }
#ifdef POCKETJS_EXTENSION
  /* Only a guest that declared "system.extension" sees its global. */
  if (pocket_extension_enabled()) pocket_extension_install(context, global);
#endif
  return 0;
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
  return install_host();
}
/* The bundle into the realm: from the cached bytecode when the boot carries
 * it, else compiled once and handed back for bytecode.c. The generated
 * guest's own evaluate serves a boot without either. */
static int32_t guest_evaluate(void *self, pocket_runtime *owner,
                              const uint8_t *code, size_t length) {
  (void)self;
  if (boot_bytecode == NULL &&
      (boot_compiled == NULL || length == 0 || code[length - 1] != 0))
    return pocket_guest_quickjs_vtable()->evaluate(guest, owner, code, length);
  JSValue function;
  if (boot_bytecode != NULL) {
    function = JS_ReadObject(context, boot_bytecode, boot_bytecode_length,
                             JS_READ_OBJ_BYTECODE);
  } else {
    /* Package sections carry their terminal NUL; JS_Eval takes the length
     * without it. */
    size_t source_length = length && code[length - 1] == 0 ? length - 1 : length;
    function = JS_Eval(context, (const char *)code, source_length,
                       "pocket:guest",
                       JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
    if (!JS_IsException(function)) {
      size_t size = 0;
      uint8_t *written =
          JS_WriteObject(context, &size, function, JS_WRITE_OBJ_BYTECODE);
      if (written != NULL) {
        *boot_compiled = malloc(size);
        if (*boot_compiled != NULL) {
          memcpy(*boot_compiled, written, size);
          *boot_compiled_length = size;
        }
        js_free(context, written);
      }
    }
  }
  if (JS_IsException(function)) {
    take_exception();
    return -1;
  }
  /* JS_EvalFunction takes ownership of the function. */
  JSValue result = JS_EvalFunction(context, function);
  if (JS_IsException(result)) {
    take_exception();
    return -1;
  }
  JS_FreeValue(context, result);
  return pocket_guest_quickjs_vtable()->collect(guest);
}
static int32_t guest_frame(void *self, const pocket_guest_frame *frame) {
  (void)self;
  interrupted = false;
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
                                          guest_shutdown,   guest_initialize,
                                          NULL};
static const char *guest_error(void *self) {
  (void)self;
  return pocket_guest_quickjs_error(guest);
}

/* After the facade attaches guest_api and before Runtime admits the package:
 * the 3DS drivers, then the worker, whose channels the guest's initialize
 * mirrors into this realm. */
static int32_t compose(void *context, pocket_runtime *runtime) {
  const PocketRuntimePackage *package = context;
  composed = true;
  instance = runtime;
  if (!instance_attach(runtime)) {
    set_error("3DS runtime composition failed");
    return -1;
  }
  if (package->guest.worker_javascript_length && !pocket_3ds_worker_start(
        package->guest.worker_javascript, package->guest.worker_javascript_length, mount_worker_services)) {
    set_error(pocket_3ds_worker_error());
    return -1;
  }
  return 0;
}
/* Before the facade destroys the program: the bridge detaches before the
 * worker core stops, and both stop before the runtime shuts the guest down.
 * Repeating it after a release does nothing. */
static void release(void *context) {
  (void)context;
  if (ui_bridge) {
    pocket_worker_ui_detach(ui_bridge);
    ui_bridge = NULL;
  }
  pocket_3ds_worker_stop();
  instance_detach();
  instance = NULL;
}

/* QuickJS calls this every few thousand bytecode steps; a true from the hook
 * ends the running code with an uncatchable InternalError. */
static int on_interrupt(JSRuntime *rt, void *opaque) {
  (void)rt;
  (void)opaque;
  if (interrupt_hook == NULL || !interrupt_hook())
    return 0;
  interrupted = true;
  return 1;
}

void qjs_set_interrupt(QjsInterrupt hook) { interrupt_hook = hook; }

bool qjs_interrupted(void) { return interrupted; }

bool qjs_boot(PocketRuntimePackage *package, const uint8_t *bytecode,
              size_t bytecode_length, uint8_t **compiled,
              size_t *compiled_length) {
  last_error[0] = 0;
  interrupted = false;
  first_present = false;
  boot_has_worker = package->guest.worker_javascript_length != 0;
  boot_bytecode = bytecode;
  boot_bytecode_length = bytecode_length;
  boot_compiled = compiled;
  boot_compiled_length = compiled_length;
  if (compiled != NULL) {
    *compiled = NULL;
    *compiled_length = 0;
  }
  global = JS_UNDEFINED;
  runtime = JS_NewRuntime();
  if (!runtime) {
    set_error("JS_NewRuntime returned null");
    return false;
  }
  JS_SetMaxStackSize(runtime, POCKETJS_JS_STACK_SIZE);
  JS_SetInterruptHandler(runtime, on_interrupt, NULL);
  /* Functions keep their line tables, so a stack still names its lines, and
   * drop their source text, which Function.prototype.toString alone reads:
   * the heap and the bundle's bytecode lose a copy of the bundle. */
  JS_SetStripInfo(runtime, JS_STRIP_SOURCE);
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
  pocket_qjs_program_host host = {.struct_size = sizeof host,
                                  .profile = &pocket_3ds_profile,
                                  .profile_hash = pocket_3ds_profile_hash,
                                  .guest = &guest_api,
                                  .guest_error = guest_error,
                                  .compose = compose,
                                  .release = release,
                                  .context = package};
  composed = false;
  program = pocket_qjs_program_create_host(&host);
  if (!program) {
    set_error("3DS runtime composition failed");
    return false;
  }
  /* Runtime reads and admits the package from the source at boot and loads
   * its assets natively, as the archive's default does. */
  int booted = pocket_qjs_program_boot_source(
      program, instance_package_source(), package, package->guest.view_width,
      package->guest.view_height, package->guest.raster_density,
      INSTANCE_HEAP_LIMIT, INSTANCE_FRAME_BUFFER_BUDGET);
  boot_bytecode = NULL;
  boot_compiled = NULL;
  boot_compiled_length = NULL;
  if (!booted) {
    if (last_error[0] == 0) {
      const char *message = composed ? pocket_guest_quickjs_error(guest) : NULL;
      set_error(message && *message ? message
                : composed       ? "3DS runtime admission or guest initialization failed"
                                 : "3DS runtime composition failed");
    }
    return false;
  }
  first_present = true;
  return true;
}
bool qjs_present(void) {
  if (!instance)
    return false;
  first_present = false;
  if (pocket_runtime_present(instance)) {
    set_error("3DS runtime presentation failed");
    return false;
  }
  return true;
}
bool qjs_frame(int32_t buttons, int32_t analog, const uint32_t *touches,
               size_t count, int32_t right) {
  if (!instance)
    return false;
  if (boot_has_worker) {
    if (pocket_3ds_worker_error()[0]) { set_error(pocket_3ds_worker_error()); return false; }
    if (pocket_worker_ui_latch(ui_bridge) < 0) { take_exception(); return false; }
  }
  /* The frame after boot shows the mounted tree; the guest's first turn
   * follows at the next one. */
  if (first_present)
    return qjs_present();
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
  /* release runs inside when compose ran; otherwise it runs here. */
  if (program) {
    pocket_qjs_program_destroy(program);
    program = NULL;
  }
  release(NULL);
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
