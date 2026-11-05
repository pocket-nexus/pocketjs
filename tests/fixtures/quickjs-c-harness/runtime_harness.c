#include "pocket_qjs_program.h"
#include "pocket_spec.h"
#include "quickjs.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static PocketQjsProgram *program;
#ifdef POCKET_RUNTIME_EXTENSION
#include "pocket_native_extension.h"
static unsigned extension_boots, extension_before, extension_after, extension_stops;
static JSValue request_shutdown(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
  (void)ctx; (void)self; (void)argc; (void)argv;
  pocket_qjs_program_shutdown(program);
  return JS_UNDEFINED;
}
static int32_t extension_boot(JSContext *ctx, const uint8_t *pak, size_t length, int32_t width, int32_t height) {
  assert(ctx && pak && length == 4 && pak[0] == 12 && width == 32 && height == 24);
  extension_boots++;
  JS_SetContextOpaque(ctx, &extension_boots);
  JSValue global = JS_GetGlobalObject(ctx);
  int status = JS_SetPropertyStr(ctx, global, "requestShutdown", JS_NewCFunction(ctx, request_shutdown, "requestShutdown", 0));
  JS_FreeValue(ctx, global);
  return status >= 0;
}
static int32_t before_guest(JSContext *ctx, uint32_t buttons, uint32_t analog, uint32_t keys) {
  assert(ctx && analog == 0x8080 && keys == 0); (void)buttons; extension_before++; return 1;
}
static int32_t after_guest(JSContext *ctx) { assert(ctx); extension_after++; return 1; }
static void extension_stop(int32_t current) { assert(!current); extension_stops++; pocket_qjs_program_shutdown(program); }
static const PocketNativeExtensionV1 extension = {1, sizeof extension, 0, extension_boot, extension_stop, before_guest, after_guest, NULL, NULL};
const PocketNativeExtensionV1 *pocket_native_extension_v1(void) { return &extension; }
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
  int result = pocket_qjs_program_boot(program, source, strlen(source), pak, sizeof pak, 32, 24, 1);
  memset(pak, 0xff, sizeof pak);
  if (!result) fprintf(stderr, "boot: %s\n", pocket_qjs_program_error(program));
  return result;
}
static void expect_action(const char *name, int value) {
  assert(!strcmp(pocket_qjs_program_action_name(program), name));
  assert(pocket_qjs_program_action_value(program) == value);
}
int main(void) {
  program = pocket_qjs_program_create(); assert(program);
  const char *source =
    "function check(v){if(!v)throw Error('check')}"
    "check(ui.__host==='harness-test'&&__simHz===60);"
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
  /* Function form tests the canonical nine-argument wire, with hits recomputed
   * by Runtime instead of trusting a caller's stale hit id. */
  const char *frame =
    "globalThis.frame=function(buttons,analog,touches,hits,surfaces,right,deltas,motion,text){"
    "if(arguments.length!==9||analog!==0x8080||right!==0x8080||!Array.isArray(text)||text.length)throw Error('wire '+JSON.stringify([...arguments]));"
    "check(new Uint8Array(__pak)[0]===12);"
    "if(buttons===7){if(touches.length!==1||hits[0]!==1||surfaces[0]!==0)throw Error('touch '+JSON.stringify([...arguments]));check((touches[0]&255)===5)}"
    "if(buttons===8){check(touches.length===1&&touches[0]===0x400c0000&&hits[0]===0)}"
    "count++;Promise.resolve().then(()=>ui.__reportAppAction('frame',count));};";
  char bundle[4096]; snprintf(bundle, sizeof bundle, "if(ui.__hostAbi!==%u)throw Error('generation');%s%s", (unsigned)POCKET_BINDING_GENERATION, source, frame);
  assert(boot(bundle));
  assert(pocket_qjs_program_width(program)==32 && pocket_qjs_program_height(program)==24);
  assert(pocket_qjs_program_stride(program)==128 && pocket_qjs_program_length(program)==3072);
  assert(pocket_qjs_program_render(program));
  pocket_contact contact = {sizeof contact, 0, 3, 5, 6, 0};
  pocket_cancelled_contact cancelled = {sizeof cancelled, 0, 3};
  pocket_input_frame input = {0}; input.struct_size = sizeof input; input.buttons=7; input.contact_count=1; input.contacts=&contact;
  input.cancelled=&cancelled;
  if (!pocket_qjs_program_advance(program, &input, 1)) { fprintf(stderr,"frame: %s\n",pocket_qjs_program_error(program)); abort(); } expect_action("frame",1);
  input.buttons=8; input.contact_count=0; input.cancelled_count=1;
  assert(pocket_qjs_program_advance(program, &input, 2)); expect_action("frame",2);
  input.buttons=0; input.cancelled_count=0;
  assert(pocket_qjs_program_advance(program, &input,60)); expect_action("frame",3);
  assert(!pocket_qjs_program_advance(program, &input,0));
  assert(!pocket_qjs_program_advance(program, &input,61));
  assert(pocket_qjs_program_render(program));
#ifdef POCKET_RUNTIME_STAGE_HOOKS
  assert(stages[POCKET_BENCH_STAGE_EVAL]==1 && stages[POCKET_BENCH_STAGE_JS]>=3);
  assert(stages[POCKET_BENCH_STAGE_JOBS]>=4 && stages[POCKET_BENCH_STAGE_TICK]>=3);
  assert(current_stage==POCKET_BENCH_STAGE_IDLE);
#endif
#ifdef POCKET_RUNTIME_EXTENSION
  assert(extension_boots==1 && extension_before>=3 && extension_after==extension_before);
#endif
  pocket_qjs_program_shutdown(program);
  assert(!pocket_qjs_program_render(program));
  assert(!pocket_qjs_program_advance(program, &input, 1));
  assert(!boot("throw Error('eval failure')"));
  assert(strstr(pocket_qjs_program_error(program),"eval failure"));
  assert(!boot("globalThis.frame=42"));
  assert(strstr(pocket_qjs_program_error(program),"did not install"));
  assert(boot("globalThis.frame=()=>{throw Error('frame failure')};"));
  assert(!pocket_qjs_program_advance(program, &input, 1));
  assert(strstr(pocket_qjs_program_error(program),"frame failure"));
  assert(!pocket_qjs_program_advance(program, &input, 1));
#ifdef POCKET_RUNTIME_EXTENSION
  assert(boot("globalThis.frame=()=>{requestShutdown();ui.createNode(0)}"));
  assert(!pocket_qjs_program_advance(program, &input, 1));
  assert(!pocket_qjs_program_render(program));
  assert(extension_stops==extension_boots);
#endif
  assert(boot("globalThis.frame=()=>ui.__reportAppAction('reset',1)"));
  assert(pocket_qjs_program_action_sequence(program)==0);
  assert(pocket_qjs_program_advance(program, &input, 1)); expect_action("reset",1);
  pocket_qjs_program_shutdown(program);
  pocket_qjs_program_destroy(program);
#ifndef POCKET_RUNTIME_EXTENSION
  /* Both realms and retained trees must survive interleaved calls. */
  PocketQjsProgram *a = pocket_qjs_program_create(), *b = pocket_qjs_program_create();
  assert(a && b);
  const char *isolated = "let n=0;ui.createNode(0);globalThis.frame=()=>ui.__reportAppAction('isolated',++n)";
  uint8_t pak[] = {12,34,56,78};
  assert(pocket_qjs_program_boot(a, isolated, strlen(isolated), pak, sizeof pak, 32,24,1));
  assert(pocket_qjs_program_boot(b, isolated, strlen(isolated), pak, sizeof pak, 32,24,1));
  assert(pocket_qjs_program_advance(a,&input,1));
  assert(pocket_qjs_program_advance(b,&input,1));
  assert(pocket_qjs_program_advance(a,&input,1));
  assert(pocket_qjs_program_action_value(a)==2 && pocket_qjs_program_action_value(b)==1);
  assert(pocket_qjs_program_render(a) && pocket_qjs_program_render(b));
  pocket_qjs_program_destroy(a);
  assert(pocket_qjs_program_advance(b,&input,1) && pocket_qjs_program_action_value(b)==2);
  assert(pocket_qjs_program_render(b));
  pocket_qjs_program_destroy(b);
#endif
  puts("quickjs-c canonical composition: ok");
  return 0;
}
