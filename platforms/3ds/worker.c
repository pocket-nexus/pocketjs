#include "worker.h"
#include "host_services.h"
#include "link_http.h"
#include "pocket/worker.h"
#include "pocket/worker_runner.h"
#include <3ds.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  uint32_t handle, request, link_id;
  uint8_t config[POCKET_WORKER_MAX_PAYLOAD];
  size_t length;
  uint64_t delivered;
  bool submit, closing, finished;
} HttpResource;
typedef struct {
  LightLock core_lock, mail_lock;
  LightEvent wake, boot;
  Thread thread;
  atomic_bool finished, shutdown;
  const uint8_t *source;
  size_t length;
  uint32_t generation;
  pocket_worker_runner *runner;
  pocket_worker_driver driver;
  pocket_worker_node node;
  int32_t (*mount)(JSContext *);
  HttpResource resources[LINK_HTTP_SLOTS];
  char error[512];
} Worker;
static Worker *active;
static uint32_t generation;
static char last_error[512];
static uint64_t now(void *opaque) {
  (void)opaque;
  return services_host_us();
}
static void lock(void *opaque) {
  LightLock_Lock(&((Worker *)opaque)->core_lock);
}
static void unlock(void *opaque) {
  LightLock_Unlock(&((Worker *)opaque)->core_lock);
}
static void wake(void *opaque) { LightEvent_Signal(&((Worker *)opaque)->wake); }
/* The runner's idle wait: the owner thread sleeps until a wake or the
 * absolute deadline. A signal that arrived earlier returns at once. */
static void wait_until(void *opaque, uint64_t deadline) {
  Worker *w = opaque;
  uint64_t current = now(w);
  int64_t timeout = deadline == UINT64_MAX ? INT64_MAX
                    : deadline > current ? (int64_t)(deadline - current) * 1000
                                         : 0;
  LightEvent_WaitTimeout(&w->wake, timeout);
}
static HttpResource *resource(Worker *w, uint32_t handle) {
  for (size_t i = 0; i < LINK_HTTP_SLOTS; ++i)
    if (w->resources[i].handle == handle && handle)
      return &w->resources[i];
  return NULL;
}
static int32_t open_http(void *opaque, pocket_worker *core, uint32_t handle,
                         const uint8_t *config, size_t length) {
  (void)core;
  Worker *w = opaque;
  if (!link_http_validate(config, length))
    return POCKET_WORKER_INVALID;
  LightLock_Lock(&w->mail_lock);
  HttpResource *r = NULL;
  for (size_t i = 0; i < LINK_HTTP_SLOTS; ++i)
    if (!w->resources[i].handle) {
      r = &w->resources[i];
      break;
    }
  if (r) {
    memset(r, 0, sizeof *r);
    r->handle = handle;
    memcpy(r->config, config, length);
    r->length = length;
  }
  LightLock_Unlock(&w->mail_lock);
  return r ? POCKET_WORKER_OK : POCKET_WORKER_BUSY;
}
static int32_t start_http(void *opaque, pocket_worker *core, uint32_t handle,
                          uint32_t request, uint32_t opcode,
                          const uint8_t *payload, size_t length,
                          size_t result_capacity) {
  (void)core;
  (void)payload;
  (void)result_capacity;
  Worker *w = opaque;
  if (opcode != 1 || length)
    return POCKET_WORKER_INVALID;
  LightLock_Lock(&w->mail_lock);
  HttpResource *r = resource(w, handle);
  int32_t status = POCKET_WORKER_INVALID;
  if (r && !r->request && !r->closing) {
    r->request = request;
    r->submit = true;
    status = POCKET_WORKER_OK;
  }
  LightLock_Unlock(&w->mail_lock);
  return status;
}
static void cancel_http(void *opaque, pocket_worker *core, uint32_t handle,
                        uint32_t request) {
  (void)core;
  (void)request;
  Worker *w = opaque;
  LightLock_Lock(&w->mail_lock);
  HttpResource *r = resource(w, handle);
  if (r)
    r->closing = true;
  LightLock_Unlock(&w->mail_lock);
}
static int32_t close_http(void *opaque, pocket_worker *core, uint32_t handle) {
  (void)core;
  Worker *w = opaque;
  LightLock_Lock(&w->mail_lock);
  HttpResource *r = resource(w, handle);
  int32_t status = POCKET_WORKER_OK;
  if (r) {
    if (r->finished || (!r->link_id && !r->submit))
      memset(r, 0, sizeof *r);
    else {
      r->closing = true;
      status = POCKET_WORKER_BUSY;
    }
  }
  LightLock_Unlock(&w->mail_lock);
  return status;
}
void pocket_3ds_worker_service(void) {
  Worker *w = active;
  pocket_worker *core = w ? pocket_worker_runner_core(w->runner) : NULL;
  if (!core)
    return;
  LightLock_Lock(&w->mail_lock);
  for (size_t i = 0; i < LINK_HTTP_SLOTS; ++i) {
    HttpResource *r = &w->resources[i];
    if (!r->handle || r->finished)
      continue;
    if (r->closing) {
      if (r->link_id)
        link_http_close(r->link_id);
      if (r->request)
        pocket_worker_finish(core, r->handle, r->request,
                             r->link_id ? POCKET_WORKER_UNKNOWN
                                        : POCKET_WORKER_CANCELLED,
                             r->delivered);
      r->finished = true;
      r->submit = false;
      continue;
    }
    if (r->submit) {
      r->submit = false;
      int32_t id = link_http_start(r->config, r->length);
      if (id < 0) {
        pocket_worker_finish(core, r->handle, r->request,
                             POCKET_WORKER_FAILED, 0);
        r->finished = true;
        continue;
      }
      r->link_id = (uint32_t)id;
    }
    LinkHttpFact fact;
    while (r->link_id && link_http_peek(r->link_id, &fact)) {
      if (fact.kind == POCKET_WORKER_END) {
        pocket_worker_finish(core, r->handle, r->request, fact.status,
                             fact.offset);
        link_http_consume(r->link_id);
        r->finished = true;
        break;
      }
      if (pocket_worker_emit(core, r->handle, fact.kind, fact.status,
                             fact.offset, fact.bytes,
                             fact.length) != POCKET_WORKER_OK)
        break;
      if (fact.kind == POCKET_WORKER_DATA)
        r->delivered = fact.offset + fact.length;
      link_http_consume(r->link_id);
    }
  }
  LightLock_Unlock(&w->mail_lock);
}
static JSValue worker_log(JSContext *ctx, JSValueConst self, int argc,
                          JSValueConst *argv) {
  (void)self;
  char line[512] = "PocketJS worker: ";
  size_t used = strlen(line);
  for (int i = 0; i < argc && used + 1 < sizeof line; ++i) {
    size_t length = 0;
    const char *text = JS_ToCStringLen(ctx, &length, argv[i]);
    if (!text)
      return JS_EXCEPTION;
    if (i && used + 1 < sizeof line)
      line[used++] = ' ';
    size_t take =
        length < sizeof line - used - 1 ? length : sizeof line - used - 1;
    memcpy(line + used, text, take);
    used += take;
    JS_FreeCString(ctx, text);
  }
  line[used++] = '\n';
  svcOutputDebugString(line, (int32_t)used);
  return JS_UNDEFINED;
}
static int32_t mount_worker(void *opaque, JSContext *ctx) {
  Worker *w = opaque;
  JSValue global = JS_GetGlobalObject(ctx), console = JS_NewObject(ctx);
  if (JS_IsException(console)) {
    JS_FreeValue(ctx, global);
    return POCKET_WORKER_FAILED;
  }
  const char *names[] = {"log", "info", "warn", "error", "debug"};
  for (size_t i = 0; i < sizeof names / sizeof names[0]; ++i) {
    JSValue fn = JS_NewCFunction(ctx, worker_log, names[i], 1);
    if (JS_IsException(fn) ||
        JS_SetPropertyStr(ctx, console, names[i], fn) < 0) {
      JS_FreeValue(ctx, console);
      JS_FreeValue(ctx, global);
      return POCKET_WORKER_FAILED;
    }
  }
  int result = JS_SetPropertyStr(ctx, global, "console", console);
  JS_FreeValue(ctx, global);
  return result < 0 ? POCKET_WORKER_FAILED
         : w->mount ? w->mount(ctx)
                    : POCKET_WORKER_OK;
}
static void run(void *opaque) {
  Worker *w = opaque;
  pocket_worker_runner_config config = {
      .struct_size = sizeof config,
      .core = {.struct_size = sizeof config.core,
               .generation = w->generation,
               .nodes = &w->node,
               .node_count = 1,
               .context = w,
               .lock = lock,
               .unlock = unlock,
               .wake = wake,
               .now_micros = now},
      .realm = {.struct_size = sizeof config.realm,
                .heap_limit = 512u * 1024u,
                .stack_limit = 128u * 1024u,
                .max_jobs = 64,
                .max_facts = 8,
                .max_bytes = 8192,
                .window_micros = 20000,
                .quota_micros = 10000,
                .context = w,
                .now_micros = now,
                .mount = mount_worker},
      .source = (const char *)w->source,
      .source_size = w->length - 1,
      .context = w,
      .wait = wait_until};
  w->runner = pocket_worker_runner_create(&config);
  if (!w->runner)
    snprintf(w->error, sizeof w->error, "worker runner allocation failed");
  LightEvent_Signal(&w->boot);
  /* run returns once stop was requested; after a fault it keeps the core
   * alive until then, and the main thread reads the fault through
   * pocket_3ds_worker_error. */
  pocket_worker_runner_run(w->runner);
  while (!atomic_load(&w->shutdown))
    LightEvent_Wait(&w->wake);
  /* The main thread only services the mailbox while destroy waits for native
   * users; it cannot touch the runner after finished is published. */
  pocket_worker_runner_destroy(w->runner);
  w->runner = NULL;
  atomic_store(&w->finished, true);
}
bool pocket_3ds_worker_start(const uint8_t *source, size_t length,
                             int32_t (*mount)(JSContext *)) {
  pocket_3ds_worker_stop();
  last_error[0] = 0;
  if (!source || !length || source[length - 1])
    return false;
  Worker *w = calloc(1, sizeof *w);
  if (!w)
    return false;
  LightLock_Init(&w->core_lock);
  LightLock_Init(&w->mail_lock);
  LightEvent_Init(&w->wake, RESET_ONESHOT);
  LightEvent_Init(&w->boot, RESET_ONESHOT);
  atomic_init(&w->finished, false);
  atomic_init(&w->shutdown, false);
  w->mount = mount;
  w->source = source;
  w->length = length;
  w->generation = ++generation;
  w->driver = (pocket_worker_driver){.struct_size = sizeof w->driver,
                                     .context = w,
                                     .open = open_http,
                                     .start = start_http,
                                     .cancel = cancel_http,
                                     .close = close_http};
  w->node = (pocket_worker_node){.struct_size = sizeof w->node,
                                 .kind = POCKET_WORKER_HTTP,
                                 .name = "http",
                                 .driver = &w->driver};
  active = w;
  w->thread = threadCreate(run, w, 192u * 1024u, 0x30, -2, false);
  if (!w->thread) {
    free(w);
    active = NULL;
    return false;
  }
  LightEvent_Wait(&w->boot);
  if (pocket_3ds_worker_error()[0]) {
    pocket_3ds_worker_stop();
    return false;
  }
  return true;
}
void pocket_3ds_worker_stop(void) {
  Worker *w = active;
  if (!w)
    return;
  snprintf(last_error, sizeof last_error, "%s", pocket_3ds_worker_error());
  atomic_store(&w->shutdown, true);
  pocket_worker_runner_stop(w->runner);
  wake(w);
  while (!atomic_load(&w->finished)) {
    pocket_3ds_worker_service();
    svcSleepThread(1000000);
  }
  threadJoin(w->thread, UINT64_MAX);
  threadFree(w->thread);
  free(w);
  active = NULL;
}
/* A bootstrap failure is copied before boot is signalled; a fault is read
 * from the runner, whose message is complete once its failed flag is set. */
const char *pocket_3ds_worker_error(void) {
  Worker *w = active;
  if (!w)
    return last_error;
  if (w->error[0])
    return w->error;
  return w->runner && pocket_worker_runner_failed(w->runner)
             ? pocket_worker_runner_error(w->runner)
             : "";
}
pocket_worker *pocket_3ds_worker_core(void) {
  return active ? pocket_worker_runner_core(active->runner) : NULL;
}
