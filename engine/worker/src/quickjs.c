#include "pocket/worker_quickjs.h"
#include <inttypes.h>
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { OPEN, SUBMIT, CANCEL, CLOSE, WRITE, PUBLISH, TIMER, DECLARE_CHANNEL };
struct pocket_worker_quickjs {
  pocket_worker_quickjs_config config;
  JSRuntime *runtime;
  JSContext *context;
  JSValue token;
  pocket_worker_fact *facts;
  uint8_t *bytes;
  uint32_t sequence, booted, fault;
  uint32_t rejection_count, rejection_overflow;
  JSValue rejected_promises[8], rejected_reasons[8];
  uint64_t interrupt_at, window_start, spent, resume_at;
  uint64_t host_micros[DECLARE_CHANNEL + 1];
  char error[256];
};
static uint64_t now(pocket_worker_quickjs *g) {
  return g->config.now_micros(g->config.context);
}
static int interrupt(JSRuntime *rt, void *opaque) {
  (void)rt;
  pocket_worker_quickjs *g = opaque;
  return g->fault || (g->interrupt_at && now(g) >= g->interrupt_at);
}
static int32_t failed(pocket_worker_quickjs *g) {
  g->fault = 1;
  g->interrupt_at = 0;
  pocket_worker_shutdown(g->config.worker);
  JSValue e = JS_GetException(g->context);
  const char *message = JS_ToCString(g->context, e);
  snprintf(g->error, sizeof g->error, "%s",
           message ? message : "worker realm fault");
  if (message)
    JS_FreeCString(g->context, message);
  JS_FreeValue(g->context, e);
  return -1;
}
static void rejection(JSContext *c, JSValueConst promise, JSValueConst reason,
#if defined(POCKET_QJS_BELLARD)
                      JS_BOOL handled,
#else
                      bool handled,
#endif
                      void *opaque) {
  pocket_worker_quickjs *g = opaque;
  for (uint32_t i = 0; i < g->rejection_count; i++)
    if (JS_VALUE_GET_PTR(g->rejected_promises[i]) ==
        JS_VALUE_GET_PTR(promise)) {
      if (handled) {
        JS_FreeValue(c, g->rejected_promises[i]);
        JS_FreeValue(c, g->rejected_reasons[i]);
        --g->rejection_count;
        g->rejected_promises[i] = g->rejected_promises[g->rejection_count];
        g->rejected_reasons[i] = g->rejected_reasons[g->rejection_count];
      }
      return;
    }
  if (handled)
    return;
  if (g->rejection_count == 8) {
    g->rejection_overflow = 1;
    return;
  }
  g->rejected_promises[g->rejection_count] = JS_DupValue(c, promise);
  g->rejected_reasons[g->rejection_count++] = JS_DupValue(c, reason);
}
static int set(JSContext *c, JSValueConst obj, const char *name,
               JSValue value) {
  /* Constructors can return the exception sentinel on heap exhaustion. Do
   * not store that sentinel as a property and return a half-mounted realm. */
  if (JS_IsException(value))
    return -1;
  if (JS_IsException(obj)) {
    JS_FreeValue(c, value);
    return -1;
  }
  return JS_SetPropertyStr(c, obj, name, value);
}
static JSValue byte_array(JSContext *c, const uint8_t *bytes, size_t length) {
  JSValue buffer = JS_NewArrayBufferCopy(c, bytes, length);
  if (JS_IsException(buffer))
    return buffer;
  JSValue args[3] = {buffer, JS_UNDEFINED, JS_UNDEFINED};
  JSValue result = JS_NewTypedArray(c, 3, args, JS_TYPED_ARRAY_UINT8);
  JS_FreeValue(c, buffer);
  return result;
}
static int bytes_arg(JSContext *c, JSValueConst value, JSValue *buffer,
                     const uint8_t **bytes, size_t *length) {
  size_t offset = 0, element = 0, backing = 0;
  *buffer = JS_GetTypedArrayBuffer(c, value, &offset, length, &element);
  if (JS_IsException(*buffer))
    return -1;
  if (element != 1) {
    JS_ThrowTypeError(c, "expected byte array");
    return -1;
  }
  uint8_t *data = JS_GetArrayBuffer(c, &backing, *buffer);
  if (offset > backing || *length > backing - offset || (*length && !data)) {
    JS_ThrowTypeError(c, "invalid byte array");
    return -1;
  }
  *bytes = data ? data + offset : NULL;
  return 0;
}
static int u32_arg(JSContext *c, JSValueConst value, uint32_t *out) {
  double n;
  if (JS_ToFloat64(c, &n, value) < 0)
    return -1;
  if (!isfinite(n) || n < 0 || n > UINT32_MAX || floor(n) != n) {
    JS_ThrowRangeError(c, "expected unsigned integer");
    return -1;
  }
  *out = (uint32_t)n;
  return 0;
}
static int time_arg(JSContext *c, JSValueConst value, uint64_t *out) {
  double n;
  if (JS_ToFloat64(c, &n, value) < 0)
    return -1;
  if (!isfinite(n) || n < 0 || n > 9007199254740991.0 || floor(n) != n) {
    JS_ThrowRangeError(c, "expected safe microsecond integer");
    return -1;
  }
  *out = (uint64_t)n;
  return 0;
}
static JSValue operation(JSContext *c, JSValueConst self, int argc,
                         JSValueConst *args, int op, JSValue *data) {
  (void)self;
  size_t token_size = 0;
  uint8_t *token = JS_GetArrayBuffer(c, &token_size, data[0]);
  pocket_worker_quickjs *g = NULL;
  if (token && token_size == sizeof g)
    memcpy(&g, token, sizeof g);
  if (!g || g->fault)
    return JS_ThrowInternalError(c, "inactive worker realm");
  int required = op == OPEN                     ? 3
                 : op == SUBMIT                 ? 4
                 : op == WRITE || op == PUBLISH ? 2
                 : op == TIMER                  ? 3
                 : op == DECLARE_CHANNEL        ? 5
                                                : 1;
  if (argc < required)
    return JS_ThrowTypeError(c, "missing worker operation argument");
  uint32_t id = 0, code = 0, capacity = 0, snapshot = 0, limit = 0,
           direction = 0;
  if (u32_arg(c, args[0], &id) < 0)
    return JS_EXCEPTION;
  uint64_t began = now(g);
  JSValue buffer = JS_UNDEFINED, result = JS_EXCEPTION;
  const uint8_t *bytes = NULL;
  size_t length = 0;
  int32_t status;
  if (op == OPEN) {
    const char *name = JS_ToCString(c, args[1]);
    if (!name)
      return JS_EXCEPTION;
    if (bytes_arg(c, args[2], &buffer, &bytes, &length) < 0) {
      JS_FreeCString(c, name);
      goto done;
    }
    status = pocket_worker_open(g->config.worker, id, name, bytes, length);
    JS_FreeCString(c, name);
  } else if (op == SUBMIT) {
    if (u32_arg(c, args[1], &code) < 0 || u32_arg(c, args[3], &capacity) < 0 ||
        bytes_arg(c, args[2], &buffer, &bytes, &length) < 0)
      goto done;
    status = pocket_worker_submit(g->config.worker, id, code, bytes, length,
                                  capacity);
  } else if (op == WRITE || op == PUBLISH) {
    if (bytes_arg(c, args[1], &buffer, &bytes, &length) < 0)
      goto done;
    status = op == WRITE
                 ? pocket_worker_write(g->config.worker, id, bytes, length)
                 : pocket_worker_publish(g->config.worker, id, bytes, length);
  } else if (op == TIMER) {
    uint64_t deadline = 0, period = 0;
    if (time_arg(c, args[1], &deadline) < 0 ||
        time_arg(c, args[2], &period) < 0)
      goto done;
    status = pocket_worker_timer(g->config.worker, id, deadline, period);
  } else if (op == DECLARE_CHANNEL) {
    if (u32_arg(c, args[1], &snapshot) < 0 || u32_arg(c, args[2], &limit) < 0 ||
        u32_arg(c, args[3], &capacity) < 0 ||
        u32_arg(c, args[4], &direction) < 0)
      goto done;
    status = direction > 1 ? POCKET_WORKER_INVALID
                           : pocket_worker_channel(g->config.worker, id,
                                                   snapshot, limit, capacity);
    if (status == POCKET_WORKER_OK)
      status =
          pocket_worker_channel_direction(g->config.worker, id, (int)direction);
  } else
    status = op == CANCEL ? pocket_worker_cancel(g->config.worker, id)
                          : pocket_worker_close(g->config.worker, id);
  result = JS_NewInt32(c, status);
done:
  JS_FreeValue(c, buffer);
  g->host_micros[op] += now(g) - began;
  return result;
}
pocket_worker_quickjs *
pocket_worker_quickjs_create(const pocket_worker_quickjs_config *config) {
  if (!config || config->struct_size < sizeof *config || !config->worker ||
      !config->now_micros || !config->heap_limit || !config->stack_limit)
    return NULL;
  pocket_worker_quickjs *g = calloc(1, sizeof *g);
  if (!g)
    return NULL;
  g->config = *config;
  g->token = JS_UNDEFINED;
  if (!g->config.max_turn_micros)
    g->config.max_turn_micros = 10000;
  if (!g->config.max_boot_micros)
    g->config.max_boot_micros = 250000;
  if (!g->config.max_jobs)
    g->config.max_jobs = 64;
  if (!g->config.max_facts)
    g->config.max_facts = 16;
  if (!g->config.max_bytes)
    g->config.max_bytes = 8192;
  if (!g->config.window_micros)
    g->config.window_micros = 100000;
  if (!g->config.quota_micros)
    g->config.quota_micros = 50000;
  if (g->config.max_facts > 64 || g->config.max_bytes > 65536 ||
      g->config.max_bytes < POCKET_WORKER_MAX_PAYLOAD ||
      g->config.quota_micros > g->config.window_micros)
    goto fail;
  g->facts = calloc(g->config.max_facts, sizeof *g->facts);
  g->bytes = malloc(g->config.max_bytes);
  if (!g->facts || !g->bytes)
    goto fail;
  g->runtime = config->allocator ? JS_NewRuntime2(config->allocator,
                                                  config->allocator_context)
                                 : JS_NewRuntime();
  if (!g->runtime)
    goto fail;
  JS_SetMemoryLimit(g->runtime, config->heap_limit);
  JS_SetMaxStackSize(g->runtime, config->stack_limit);
  JS_SetGCThreshold(g->runtime, (size_t)-1);
  JS_SetInterruptHandler(g->runtime, interrupt, g);
  JS_SetHostPromiseRejectionTracker(g->runtime, rejection, g);
  g->context = JS_NewContext(g->runtime);
  if (!g->context)
    goto fail;
  g->token = JS_NewArrayBufferCopy(g->context, (const uint8_t *)&g, sizeof g);
  if (JS_IsException(g->token))
    goto fail;
  JSValue global = JS_GetGlobalObject(g->context),
          host = JS_NewObject(g->context);
  const char *names[] = {"open",  "submit",  "cancel", "close",
                         "write", "publish", "timer",  "declareChannel"};
  for (int i = 0; i <= DECLARE_CHANNEL; i++)
    if (set(g->context, host, names[i],
            JS_NewCFunctionData(g->context, operation, 1, i, 1, &g->token)) <
        0) {
      JS_FreeValue(g->context, host);
      JS_FreeValue(g->context, global);
      goto fail;
    }
  if (set(g->context, global, "__pocketWorker", host) < 0) {
    JS_FreeValue(g->context, global);
    goto fail;
  }
  JS_FreeValue(g->context, global);
  if (config->mount && config->mount(config->context, g->context) != 0)
    goto fail;
  g->window_start = now(g);
  return g;
fail:
  pocket_worker_quickjs_destroy(g);
  return NULL;
}
int32_t pocket_worker_quickjs_eval(pocket_worker_quickjs *g, const char *source,
                                   size_t length, const char *filename) {
  if (!g || g->fault || !source)
    return -1;
  /* QuickJS requires a terminator beyond source length. */
  char *copy = malloc(length + 1);
  if (!copy)
    return -1;
  memcpy(copy, source, length);
  copy[length] = 0;
  uint64_t began = now(g);
  g->interrupt_at = began + g->config.max_boot_micros;
  JSValue result =
      JS_Eval(g->context, copy, length, filename ? filename : "worker.js",
              JS_EVAL_TYPE_GLOBAL);
  free(copy);
  g->interrupt_at = 0;
  if (JS_IsException(result))
    return failed(g);
  JS_FreeValue(g->context, result);
  if (!g->booted) {
    g->window_start = now(g);
    g->spent = 0;
  }
  return 0;
}
static JSValue context_value(pocket_worker_quickjs *g,
                             const pocket_worker_context *input) {
  JSContext *c = g->context;
  JSValue value = JS_NewObject(c);
  if (set(c, value, "generation",
          JS_NewUint32(c, pocket_worker_generation(g->config.worker))) < 0 ||
      set(c, value, "sequence", JS_NewUint32(c, ++g->sequence)) < 0 ||
      set(c, value, "nowMicros", JS_NewFloat64(c, (double)input->now_micros)) <
          0)
    goto fail;
  if (input->wall_generation) {
    JSValue wall = JS_NewObject(c);
    if (set(c, wall, "utcMicros", JS_NewFloat64(c, (double)input->utc_micros)) <
            0 ||
        set(c, wall, "generation", JS_NewUint32(c, input->wall_generation)) <
            0 ||
        set(c, wall, "errorMicros", JS_NewUint32(c, input->wall_error_micros)) <
            0 ||
        set(c, wall, "source",
            JS_NewString(c, input->wall_source ? input->wall_source : "host")) <
            0) {
      JS_FreeValue(c, wall);
      goto fail;
    }
    if (set(c, value, "wallClock", wall) < 0)
      goto fail;
  }
  return value;
fail:
  JS_FreeValue(c, value);
  return JS_EXCEPTION;
}
int32_t pocket_worker_quickjs_step(pocket_worker_quickjs *g,
                                   const pocket_worker_context *input) {
  if (!g || g->fault || !input || input->struct_size < sizeof *input)
    return -1;
  uint64_t began = now(g);
  if (began < g->window_start ||
      began - g->window_start >= g->config.window_micros) {
    g->window_start = began;
    g->spent = 0;
    g->resume_at = 0;
  }
  if (g->spent >= g->config.quota_micros) {
    g->resume_at = g->window_start + g->config.window_micros;
    return 0;
  }
  pocket_worker_dispatch(g->config.worker);
  size_t count =
      pocket_worker_observe(g->config.worker, g->facts, g->config.max_facts,
                            g->bytes, g->config.max_bytes);
  uint64_t collected = now(g);
  if (g->booted && !count && !JS_IsJobPending(g->runtime)) {
    JS_RunGC(g->runtime);
    g->spent += now(g) - began;
    return 0;
  }
  g->booted = 1;
  memset(g->host_micros, 0, sizeof g->host_micros);
  g->interrupt_at = began + g->config.max_turn_micros;
  JSContext *c = g->context;
  JSValue global = JS_GetGlobalObject(c),
          callback = JS_GetPropertyStr(c, global, "__pocketWorkerTurn");
  JS_FreeValue(c, global);
  if (!JS_IsFunction(c, callback)) {
    JS_FreeValue(c, callback);
    JS_ThrowTypeError(c, "worker bundle must install __pocketWorkerTurn");
    return failed(g);
  }
  JSValue args[2] = {context_value(g, input), JS_NewArray(c)};
  if (JS_IsException(args[0]) || JS_IsException(args[1]))
    goto failed_turn;
  for (size_t i = 0; i < count; i++) {
    pocket_worker_fact *f = &g->facts[i];
    JSValue fact = JS_NewObject(c);
    if (set(c, fact, "kind", JS_NewUint32(c, f->kind)) < 0 ||
        set(c, fact, "handle", JS_NewUint32(c, f->handle)) < 0 ||
        set(c, fact, "request", JS_NewUint32(c, f->request)) < 0 ||
        set(c, fact, "status", JS_NewInt32(c, f->status)) < 0 ||
        set(c, fact, "offset", JS_NewFloat64(c, (double)f->offset)) < 0 ||
        set(c, fact, "data", byte_array(c, f->data, f->length)) < 0) {
      JS_FreeValue(c, fact);
      goto failed_turn;
    }
    if (JS_SetPropertyUint32(c, args[1], (uint32_t)i, fact) < 0)
      goto failed_turn;
  }
  uint64_t packed = now(g);
  JSValue result = JS_Call(c, callback, JS_UNDEFINED, 2, args);
  JS_FreeValue(c, callback);
  JS_FreeValue(c, args[0]);
  JS_FreeValue(c, args[1]);
  if (JS_IsException(result))
    return failed(g);
  JS_FreeValue(c, result);
  uint64_t called = now(g);
  for (uint32_t i = 0; i < g->config.max_jobs && JS_IsJobPending(g->runtime);
       i++) {
    if (now(g) >= g->interrupt_at)
      break;
    JSContext *job_context = NULL;
    if (JS_ExecutePendingJob(g->runtime, &job_context) < 0)
      return failed(g);
  }
  g->interrupt_at = 0;
  if (g->rejection_overflow ||
      (!JS_IsJobPending(g->runtime) && g->rejection_count)) {
    if (g->rejection_overflow)
      JS_ThrowInternalError(c, "worker rejection capacity exceeded");
    else
      JS_Throw(c, JS_DupValue(c, g->rejected_reasons[0]));
    return failed(g);
  }
  uint64_t finished = now(g);
  uint64_t elapsed = finished - began;
  g->spent += elapsed ? elapsed : 1;
  if (elapsed >= g->config.max_turn_micros) {
    snprintf(g->error, sizeof g->error,
             "worker turn exceeded %" PRIu32 " microseconds "
             "(total=%" PRIu64 " native=%" PRIu64 " pack=%" PRIu64
             " callback=%" PRIu64 " jobs=%" PRIu64 " facts=%zu "
             "open=%" PRIu64 " submit=%" PRIu64 " write=%" PRIu64
             " publish=%" PRIu64 " timer=%" PRIu64 ")",
             g->config.max_turn_micros, elapsed, collected - began,
             packed - collected, called - packed, finished - called, count,
             g->host_micros[OPEN], g->host_micros[SUBMIT],
             g->host_micros[WRITE], g->host_micros[PUBLISH],
             g->host_micros[TIMER]);
    g->fault = 1;
    pocket_worker_shutdown(g->config.worker);
    return -1;
  }
  return 1;
failed_turn:
  JS_FreeValue(c, callback);
  JS_FreeValue(c, args[0]);
  JS_FreeValue(c, args[1]);
  return failed(g);
}
uint64_t pocket_worker_quickjs_deadline(pocket_worker_quickjs *g) {
  if (!g || g->fault)
    return UINT64_MAX;
  if (g->resume_at && now(g) < g->resume_at)
    return g->resume_at;
  if (!g->booted || JS_IsJobPending(g->runtime) ||
      pocket_worker_pending(g->config.worker))
    return now(g);
  return pocket_worker_deadline(g->config.worker);
}
const char *pocket_worker_quickjs_error(const pocket_worker_quickjs *g) {
  return g ? g->error : "missing worker";
}
JSContext *pocket_worker_quickjs_context(pocket_worker_quickjs *g) {
  return g ? g->context : NULL;
}
void pocket_worker_quickjs_destroy(pocket_worker_quickjs *g) {
  if (!g)
    return;
  if (g->context) {
    for (uint32_t i = 0; i < g->rejection_count; i++) {
      JS_FreeValue(g->context, g->rejected_promises[i]);
      JS_FreeValue(g->context, g->rejected_reasons[i]);
    }
    if (!JS_IsUndefined(g->token)) {
      JS_DetachArrayBuffer(g->context, g->token);
      JS_FreeValue(g->context, g->token);
    }
    JS_FreeContext(g->context);
  }
  if (g->runtime)
    JS_FreeRuntime(g->runtime);
  free(g->facts);
  free(g->bytes);
  free(g);
}
