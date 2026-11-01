#define _POSIX_C_SOURCE 200809L
#include "pocket/worker_quickjs.h"
#include "pocket/worker_runner.h"
#include "pocket/worker_ui.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
typedef struct {
  uint64_t time;
  pocket_worker_runner *runner;
  unsigned idle_waits;
} host;
/* The runner's wait on a fake clock: a deadline advances time to it; an idle
 * wait without a deadline ends the run after the work is observed. */
static void runner_wait(void *opaque, uint64_t deadline) {
  host *h = opaque;
  if (deadline != UINT64_MAX)
    h->time = deadline;
  else if (++h->idle_waits >= 2)
    pocket_worker_runner_stop(h->runner);
}
static uint64_t now(void *opaque) {
  host *h = opaque;
  return h->time;
}
static uint64_t realtime(void *opaque) {
  (void)opaque;
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000000 + (uint64_t)t.tv_nsec / 1000;
}
/* Another task's stop request reaching a turn that never returns. */
static void *interrupt_later(void *opaque) {
  struct timespec delay = {.tv_sec = 0, .tv_nsec = 20 * 1000 * 1000};
  nanosleep(&delay, NULL);
  pocket_worker_quickjs_interrupt(opaque);
  return NULL;
}
static void eval(pocket_worker_quickjs *g, const char *source) {
  int32_t result =
      pocket_worker_quickjs_eval(g, source, strlen(source), "fixture.js");
  if (result)
    fprintf(stderr, "%s\n", pocket_worker_quickjs_error(g));
  assert(result == 0);
}
static void eval_ui(JSContext *context, const char *source) {
  JSValue value =
      JS_Eval(context, source, strlen(source), "ui.js", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(value)) {
    JSValue error = JS_GetException(context);
    const char *message = JS_ToCString(context, error);
    fprintf(stderr, "UI test exception: %s\n", message ? message : "unknown");
    if (message)
      JS_FreeCString(context, message);
    JS_FreeValue(context, error);
    assert(0);
  }
  JS_FreeValue(context, value);
}
int main(void) {
  host h = {.time = 1000};
  pocket_worker_config config = {.struct_size = sizeof config,
                                 .generation = 42,
                                 .context = &h,
                                 .now_micros = now};
  pocket_worker *w = pocket_worker_create(&config);
  assert(w);
  pocket_worker_quickjs_config q = {.struct_size = sizeof q,
                                    .worker = w,
                                    .heap_limit = 1024 * 1024,
                                    .stack_limit = 64 * 1024,
                                    .max_jobs = 4,
                                    .window_micros = 1000,
                                    .quota_micros = 2,
                                    .context = &h,
                                    .now_micros = now};
  /* Exercise partial namespace construction near the context's heap floor.
   * A successful constructor must never retain an allocation exception. */
  for (size_t limit = 64 * 1024; limit <= 256 * 1024; limit += 1024) {
    q.heap_limit = limit;
    pocket_worker_quickjs *limited = pocket_worker_quickjs_create(&q);
    if (limited) {
      assert(!JS_HasException(pocket_worker_quickjs_context(limited)));
      pocket_worker_quickjs_destroy(limited);
    }
  }
  q.heap_limit = 1024 * 1024;
  pocket_worker_quickjs *g = pocket_worker_quickjs_create(&q);
  assert(g);
  /* A package bytecode section runs when its digest is this engine's;
   * another build's, or none, leaves the realm untouched. */
  {
    JSContext *ctx = pocket_worker_quickjs_context(g);
    const char *source = "globalThis.__bytecode = 6 * 7;";
    JSValue compiled = JS_Eval(ctx, source, strlen(source), "worker.js",
                               JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
    assert(!JS_IsException(compiled));
    size_t length = 0;
    uint8_t *object = JS_WriteObject(ctx, &length, compiled, JS_WRITE_OBJ_BYTECODE);
    assert(object && length);
    JS_FreeValue(ctx, compiled);
    uint8_t *section = calloc(1, 48 + length);
    assert(section);
    const uint32_t words[4] = {0x43424a51u, 1u, 48u, 0u};
    for (size_t i = 0; i < 4; i++)
      for (size_t b = 0; b < 4; b++)
        section[i * 4 + b] = (uint8_t)(words[i] >> (8 * b));
    uint8_t digest[32];
    memset(digest, 0x5a, sizeof digest);
    memcpy(section + 16, digest, sizeof digest);
    memcpy(section + 48, object, length);
    js_free(ctx, object);
    uint8_t other[32];
    memset(other, 0xa5, sizeof other);
    assert(pocket_worker_quickjs_eval_bytecode(g, section, 48 + length, NULL) == 1);
    assert(pocket_worker_quickjs_eval_bytecode(g, section, 48 + length, other) == 1);
    eval(g, "if('__bytecode' in globalThis)throw Error('ran before the digest matched')");
    assert(pocket_worker_quickjs_eval_bytecode(g, section, 48 + length, digest) == 0);
    eval(g, "if(globalThis.__bytecode!==42)throw Error('bytecode did not run')");
    free(section);
  }
  eval(g, "if(typeof ui!=='undefined')throw Error('UI leaked');let "
          "calls=0;__pocketWorker.declareChannel(1,1,16,1,1);__pocketWorker."
          "declareChannel(2,1,16,1,0);globalThis.__pocketWorkerTurn=(c,f)=>{if("
          "c.generation!==42||c.nowMicros!==1000)throw "
          "Error('clock');calls++;for(const x of "
          "f)if(x.kind===7){if(x.channel!==1||x.handle!==0)throw Error('channel "
          "id');if(x.data.length!==3)throw Error('data length "
          "'+x.data.length);__pocketWorker.publish(2,x.data);};};");
  uint8_t message[] = {1, 2, 3};
  assert(pocket_worker_receive(w, 1, message, 3) == 0);
  pocket_worker_context context = {.struct_size = sizeof context,
                                   .now_micros = 1000};
  int first_step = pocket_worker_quickjs_step(g, &context);
  if (first_step < 0)
    fprintf(stderr, "%s\n", pocket_worker_quickjs_error(g));
  assert(first_step == 1);
  uint8_t received[16];
  int32_t received_length =
      pocket_worker_channel_take(w, 2, received, sizeof received);
  assert(received_length == 3 && !memcmp(received, message, 3));
  assert(pocket_worker_quickjs_step(g, &context) == 0);
  eval(g, "if(calls!==1)throw Error('idle turn');");
  assert(pocket_worker_timer(w, 1, 1000, 1) == 0);
  assert(pocket_worker_quickjs_step(g, &context) == 1);
  assert(pocket_worker_quickjs_step(g, &context) == 0);
  assert(pocket_worker_quickjs_deadline(g) == 2000);
  assert(pocket_worker_destroy(w) == 0);
  pocket_worker_quickjs_destroy(g);
  w = pocket_worker_create(&config);
  assert(w);
  q.worker = w;
  q.quota_micros = 1000;
  g = pocket_worker_quickjs_create(&q);
  assert(g);
  eval(g, "__pocketWorker.declareChannel(1,1,16,1,1);__pocketWorker."
          "declareChannel(2,1,16,1,0);__pocketWorker.declareChannel(3,0,16,4,0)"
          ";globalThis.__pocketWorkerTurn=(c,f)=>{for(const x of "
          "f)if(x.kind===7){__pocketWorker.publish(2,x.data);__pocketWorker."
          "publish(3,x.data);}};");
  JSRuntime *ui_runtime = JS_NewRuntime();
  assert(ui_runtime);
  JSContext *ui = JS_NewContext(ui_runtime);
  assert(ui);
  pocket_worker_ui *bridge = pocket_worker_ui_attach(ui, w);
  assert(bridge);
  eval_ui(ui, "if(typeof __pocketWorker!=='undefined')throw Error('worker "
              "global leaked');let "
              "frame=0;globalThis.__pocketWorkerChannelFrame=()=>++frame;const "
              "channels=__pocketWorkerChannels;channels.configure(1,1);"
              "channels.configure(2,1);channels.configure(3,0);let out=new "
              "Uint8Array([0,42,0]);if(channels.publish(1,out.subarray(1,2))!=="
              "0)throw Error('publish');out[1]=99;");
  assert(pocket_worker_quickjs_step(g, &context) == 1);
  eval_ui(ui, "if(channels.observe(2).length)throw Error('unlatched data');");
  assert(pocket_worker_ui_latch(bridge) == 0);
  eval_ui(ui,
          "if(frame!==1||channels.observe(2)[0][0]!==42||channels.observe(3)[0]"
          "[0]!==42)throw Error('round trip');const observedFrame=frame;const "
          "old=channels.observe(2)[0];globalThis.readPrevious=()=>{if(frame!=="
          "observedFrame)throw Error('expired');return "
          "old[0];};if(readPrevious()!==42)throw Error('view');");
  assert(pocket_worker_ui_latch(bridge) == 0);
  eval_ui(ui, "if(frame!==2||channels.observe(2)[0][0]!==42||channels.observe("
              "3).length!==0)throw Error('mirror persistence');let "
              "stale=false;try{readPrevious()}catch{stale=true}if(!stale)throw "
              "Error('missing stale frame "
              "guard');globalThis.savedPublish=channels.publish;");
  pocket_worker_ui_detach(bridge);
  eval_ui(ui, "if(typeof __pocketWorkerChannels!=='undefined')throw "
              "Error('bridge leaked');let dead=false;try{savedPublish(1,new "
              "Uint8Array([1]))}catch{dead=true}if(!dead)throw Error('retained "
              "callback active');");
  JS_FreeContext(ui);
  JS_FreeRuntime(ui_runtime);
  assert(pocket_worker_destroy(w) == 0);
  pocket_worker_quickjs_destroy(g);
  config.now_micros = realtime;
  w = pocket_worker_create(&config);
  assert(w);
  q.worker = w;
  q.now_micros = realtime;
  q.quota_micros = 0;
  g = pocket_worker_quickjs_create(&q);
  assert(g);
  /* Continuations run in the step that resolved them; a chain longer than
   * max_jobs continues in the next step. */
  eval(g, "let ran=0;globalThis.__pocketWorkerTurn=(c,f)=>{if(c.sequence===1){"
          "let p=Promise.resolve();for(let i=0;i<6;i++)p=p.then(()=>{ran++;});}"
          "};");
  context.now_micros = realtime(NULL);
  assert(pocket_worker_quickjs_step(g, &context) == 1);
  eval(g, "if(ran!==4)throw Error('jobs per step '+ran);");
  assert(pocket_worker_quickjs_deadline(g) <= realtime(NULL));
  assert(pocket_worker_quickjs_step(g, &context) == 1);
  eval(g, "if(ran!==6)throw Error('spilled jobs '+ran);");
  assert(pocket_worker_quickjs_step(g, &context) == 0);
  /* No execution time limit: only an interrupt ends an unbounded turn. */
  eval(g, "globalThis.__pocketWorkerTurn=()=>{for(;;){}};");
  assert(pocket_worker_timer(w, 1, 1, 0) == 0);
  pthread_t interrupter;
  assert(pthread_create(&interrupter, NULL, interrupt_later, g) == 0);
  assert(pocket_worker_quickjs_step(g, &context) == -1);
  assert(pthread_join(interrupter, NULL) == 0);
  assert(strstr(pocket_worker_quickjs_error(g), "interrupted"));
  assert(pocket_worker_destroy(w) == 0);
  pocket_worker_quickjs_destroy(g);
  host hr = {.time = 5000};
  const char *bundle =
      "__pocketWorker.declareChannel(1,1,8,1,0);globalThis.__pocketWorkerTurn="
      "(c,f)=>{if(c.sequence===1)__pocketWorker.timer(1,c.nowMicros+500,0);for("
      "const x of f)if(x.kind===6)__pocketWorker.publish(1,new Uint8Array([x."
      "timer,x.missed]));};";
  pocket_worker_runner_config rc = {
      .struct_size = sizeof rc,
      .core = {.struct_size = sizeof rc.core,
               .generation = 7,
               .context = &hr,
               .now_micros = now},
      .realm = {.struct_size = sizeof rc.realm,
                .heap_limit = 1024 * 1024,
                .stack_limit = 64 * 1024,
                .context = &hr,
                .now_micros = now},
      .source = bundle,
      .source_size = strlen(bundle),
      .context = &hr,
      .wait = runner_wait};
  pocket_worker_runner *runner = pocket_worker_runner_create(&rc);
  assert(runner && !pocket_worker_runner_failed(runner));
  hr.runner = runner;
  pocket_worker_runner_run(runner);
  assert(!pocket_worker_runner_failed(runner) && hr.time == 5500);
  uint8_t fired[8];
  assert(pocket_worker_channel_take(pocket_worker_runner_core(runner), 1, fired,
                                    sizeof fired) == 2 &&
         fired[0] == 1 && fired[1] == 0);
  pocket_worker_runner_destroy(runner);
  const char *broken = "throw new Error('boot');";
  rc.source = broken;
  rc.source_size = strlen(broken);
  runner = pocket_worker_runner_create(&rc);
  assert(runner && pocket_worker_runner_failed(runner) &&
         strstr(pocket_worker_runner_error(runner), "boot"));
  pocket_worker_runner_run(runner);
  pocket_worker_runner_destroy(runner);
  puts("worker QuickJS: separate realm, event turns, channel copies, quota, "
       "job spill, interruption and the runner loop passed");
  return 0;
}
