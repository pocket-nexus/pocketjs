#include "pocket_legacy_runtime.h"
#include "pocket_spec.h"
#include "quickjs.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef POCKET_RUNTIME_EXTENSION
#include "pocketjs_symbian_extension.h"
static unsigned extension_boots, extension_before, extension_after, extension_stops;
static JSValue request_shutdown(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
  (void)ctx; (void)self; (void)argc; (void)argv;
  pocket_legacy_runtime_shutdown();
  return JS_UNDEFINED;
}
static int32_t extension_boot(JSContext *ctx, const uint8_t *pak, size_t length, int32_t width, int32_t height) {
  assert(ctx && pak && length == 4 && pak[0] == 12 && width == 32 && height == 24);
  extension_boots++;
  JSValue global = JS_GetGlobalObject(ctx);
  int status = JS_SetPropertyStr(ctx, global, "requestShutdown", JS_NewCFunction(ctx, request_shutdown, "requestShutdown", 0));
  JS_FreeValue(ctx, global);
  return status >= 0;
}
static int32_t before_guest(JSContext *ctx, uint32_t buttons, uint32_t analog, uint32_t keys) {
  assert(ctx && analog == 0x8080 && keys == 0); (void)buttons; extension_before++; return 1;
}
static int32_t after_guest(JSContext *ctx) { assert(ctx); extension_after++; return 1; }
static void extension_stop(int32_t current) { assert(!current); extension_stops++; pocket_legacy_runtime_shutdown(); }
static const PocketJsSymbianExtensionV1 extension = {1, sizeof extension, 0, extension_boot, extension_stop, before_guest, after_guest, NULL, NULL};
const PocketJsSymbianExtensionV1 *pocketjs_symbian_extension_v1(void) { return &extension; }
#endif
#ifdef POCKET_RUNTIME_STAGE_HOOKS
static unsigned stages[5];
static int current_stage;
void pocket_bench_stage(int stage) { assert(stage >= 0 && stage < 5); stages[stage]++; current_stage = stage; }
#endif
#ifdef POCKET_SVC_WIRE
#include "svcwire.h"
static unsigned pumps;
void svcwire_pump(void) { pumps++; }
int svcwire_open(const char *name) { return strcmp(name, "fixture") == 0; }
size_t svcwire_recv_lines(char *out, size_t cap) { assert(cap >= 3); memcpy(out, "ok", 2); return 2; }
void svcwire_send_line(const char *bytes, size_t length) { assert(length == 4 && !memcmp(bytes, "ping", 4)); }
#endif
static int boot(const char *source) {
  uint8_t pak[4] = {12, 34, 56, 78};
  int result = pocket_legacy_runtime_boot(source, strlen(source), pak, sizeof pak, 32, 24);
  memset(pak, 0xff, sizeof pak);
  if (!result) fprintf(stderr, "boot: %s\n", pocket_legacy_runtime_error());
  return result;
}
static void expect_action(const char *name, int value) {
  assert(!strcmp(pocket_legacy_runtime_action_name(), name));
  assert(pocket_legacy_runtime_action_value() == value);
}
int main(void) {
  const char *source =
    "function check(v){if(!v)throw Error('check')}"
    "check(ui.__host==='harness-test'&&ui.__hostAbi===1&&__simHz===60);"
    "check(ui.__viewport.w===32&&ui.__viewport.h===24&&!('__textures' in ui));"
    "check(new Uint8Array(__pak)[0]===12);"
    "check(typeof ui.setPropBatch==='function'&&typeof ui.takeAnimationCompletions==='function');"
#ifdef POCKET_PHYSICS
    "check(typeof ui.physicsCreate==='function'&&typeof ui.physicsQuery==='function');"
#else
    "check(!('physicsCreate' in ui));"
#endif
#ifdef POCKET_SVC_WIRE
    "check(ui.svcOpen('fixture')===true&&ui.svcPoll()==='ok');ui.svcSend('ping');"
#else
    "check(!('svcOpen' in ui));"
#endif
    "globalThis.count=0;";
  /* Function form tests the canonical eight-argument wire, with hits recomputed
   * by Runtime instead of trusting a caller's stale hit id. */
  const char *frame =
    "globalThis.frame=function(buttons,analog,touches,hits,surfaces,right,deltas,motion){"
    "if(arguments.length!==8||analog!==0x8080||right!==0x8080)throw Error('wire '+JSON.stringify([...arguments]));"
    "check(new Uint8Array(__pak)[0]===12);"
    "if(buttons===7){if(touches.length!==1||hits[0]!==1||surfaces[0]!==0)throw Error('touch '+JSON.stringify([...arguments]));check((touches[0]&255)===5)}"
    "if(buttons===8){check(touches.length===1&&touches[0]===0x400c0000&&hits[0]===0)}"
    "count++;Promise.resolve().then(()=>ui.__reportAppAction('frame',count));};"
    "globalThis.dispatch=function(a,b){if(a===99){Promise.resolve().then(()=>ui.__reportAppAction('jobs',77));return 9;}return a+b;};";
  char bundle[4096]; snprintf(bundle, sizeof bundle, "%s%s", source, frame);
  assert(boot(bundle));
  assert(pocket_legacy_runtime_width()==32 && pocket_legacy_runtime_height()==24);
  assert(pocket_legacy_runtime_stride()==128 && pocket_legacy_runtime_length()==3072);
  assert(pocket_legacy_runtime_render());
  PocketRuntimeContactsInput input = {0}; input.buttons=7; input.contact_count=1;
  input.contacts[0]=(PocketRuntimeContact){3,5,6,9999};
  if (!pocket_legacy_runtime_tick_contacts(&input)) { fprintf(stderr,"frame: %s\n",pocket_legacy_runtime_error()); abort(); } expect_action("frame",1);
  input.buttons=8; input.contact_count=0; input.cancelled_count=1; input.cancelled[0]=3;
  assert(pocket_legacy_runtime_frame_contacts(&input, 2)); expect_action("frame",2);
  input.buttons=0; input.cancelled_count=0;
  assert(pocket_legacy_runtime_frame_contacts(&input,60)); expect_action("frame",3);
  assert(!pocket_legacy_runtime_frame_contacts(&input,0));
  assert(!pocket_legacy_runtime_frame_contacts(&input,61));
  assert(pocket_legacy_runtime_render());
#if defined(POCKET_RUNTIME_HARNESS)
  int32_t value=0;
  assert(!pocket_legacy_runtime_harness_bind("missing"));
  assert(pocket_legacy_runtime_harness_bind("dispatch"));
  assert(pocket_legacy_runtime_harness_call(4,5,&value) && value==9);
  assert(pocket_legacy_runtime_harness_call(99,0,&value) && value==9);
  expect_action("frame",3);
  assert(pocket_legacy_runtime_tick_contacts(&input)); expect_action("frame",4);
#endif
#ifdef POCKET_RUNTIME_STAGE_HOOKS
  assert(stages[POCKET_BENCH_STAGE_EVAL]==1 && stages[POCKET_BENCH_STAGE_JS]>=3);
  assert(stages[POCKET_BENCH_STAGE_JOBS]>=4 && stages[POCKET_BENCH_STAGE_TICK]>=3);
  assert(current_stage==POCKET_BENCH_STAGE_IDLE);
#endif
#ifdef POCKET_RUNTIME_EXTENSION
  assert(extension_boots==1 && extension_before>=3 && extension_after==extension_before);
#endif
  pocket_legacy_runtime_shutdown();
  assert(!pocket_legacy_runtime_render());
  assert(!pocket_legacy_runtime_tick_contacts(&input));
  assert(!boot("throw Error('eval failure')"));
  assert(strstr(pocket_legacy_runtime_error(),"eval failure"));
  assert(!boot("globalThis.frame=42"));
  assert(strstr(pocket_legacy_runtime_error(),"did not install"));
  assert(boot("globalThis.frame=()=>{throw Error('frame failure')};"));
  assert(!pocket_legacy_runtime_tick_contacts(&input));
  assert(strstr(pocket_legacy_runtime_error(),"frame failure"));
  assert(!pocket_legacy_runtime_tick_contacts(&input));
#ifdef POCKET_RUNTIME_EXTENSION
  assert(boot("globalThis.frame=()=>{requestShutdown();ui.createNode(0)}"));
  assert(!pocket_legacy_runtime_tick_contacts(&input));
  assert(!pocket_legacy_runtime_render());
  assert(extension_stops==extension_boots);
#endif
  assert(boot("globalThis.frame=()=>ui.__reportAppAction('reset',1)"));
  assert(pocket_legacy_runtime_action_sequence()==0);
  assert(pocket_legacy_runtime_tick_contacts(&input)); expect_action("reset",1);
  pocket_legacy_runtime_shutdown();
  puts("quickjs-c canonical composition: ok");
  return 0;
}
