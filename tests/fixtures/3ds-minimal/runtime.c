#define _POSIX_C_SOURCE 200112L
/* Host contract runner for the minimal 3DS program: the same file source,
 * input source and QuickJS facade composition as main.c, with a counting CPU
 * renderer and two CPU displays in place of PICA. */
#include <pocket_guest_quickjs.h>
#include <pocket_qjs_program.h>
#include "pocket_profile.h"
#include "package_source.h"
#include "input_source.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static size_t live_allocations;
void *pocket_host_alloc(size_t size, size_t alignment) {
  void *p = NULL;
  if (alignment < sizeof(void *)) alignment = sizeof(void *);
  if (posix_memalign(&p, alignment, size ? size : 1)) return NULL;
  live_allocations++;
  return p;
}
void pocket_host_free(void *p, size_t size, size_t alignment) {
  (void)size; (void)alignment;
  if (p) { assert(live_allocations); live_allocations--; free(p); }
}
void *pocket_host_realloc(void *p, size_t old_size, size_t alignment, size_t size) {
  void *next = pocket_host_alloc(size, alignment);
  if (!next) return NULL;
  if (p) memcpy(next, p, old_size < size ? old_size : size);
  pocket_host_free(p, old_size, alignment);
  return next;
}
void pocket_host_panic(const char *s, size_t n) { fwrite(s, 1, n, stderr); abort(); }
void pocket_host_log(int32_t level, const char *s, size_t n) { (void)level; fwrite(s, 1, n, stderr); }
void pocket_host_boot_stage(int32_t stage) { (void)stage; }

typedef struct {
  uint32_t role, width;
  uint8_t pixels[400 * 240 * 4];
  pocket_rect region;
  pocket_surface surface;
  uint64_t flushes, waits;
} Display;
static Display displays[2] = {{.role=0, .width=400}, {.role=1, .width=320}};
static int32_t describe(void *context, pocket_display_descriptor *out) {
  Display *d = context;
  *out = (pocket_display_descriptor){.struct_size=sizeof *out, .role=d->role,
    .width=d->width, .height=240, .pixel_format=POCKET_PIXEL_FORMAT_RGBA8888,
    .stride_bytes=d->width*4, .target_kind=POCKET_TARGET_CPU_VISIBLE,
    .refresh_width=1, .refresh_height=1, .window_x_alignment=1, .window_y_alignment=1};
  return 0;
}
static int32_t acquire(void *context, const pocket_rect *region, pocket_target *out) {
  Display *d = context;
  d->region = *region;
  d->surface = (pocket_surface){sizeof d->surface, d->pixels, sizeof d->pixels,
    &d->region, d->width*4, POCKET_PIXEL_FORMAT_RGBA8888};
  *out = (pocket_target){sizeof *out, POCKET_TARGET_CPU_VISIBLE, &d->region,
    POCKET_PIXEL_FORMAT_RGBA8888, &d->surface, 0};
  return 0;
}
static int32_t flush(void *context, const pocket_rect *regions, size_t count, uint64_t *token) {
  Display *d = context;
  assert(regions && count);
  *token = ++d->flushes;
  return 0;
}
static int32_t display_wait(void *context, uint64_t token) {
  Display *d = context;
  assert(token == d->flushes); d->waits++;
  return 0;
}
static const pocket_display_output_v1 display_api = {
  sizeof display_api, describe, acquire, flush, display_wait, NULL, NULL, NULL, NULL
};
/* The facade's program registers no renderer; this one walks each frame's
 * DrawList through pocket_draw_list_visit and writes no pixels. */
typedef struct { uint64_t renders, waits, retires, operations, next; } Renderer;
static Renderer renderer;
static const uint32_t renderer_formats[] = {POCKET_PIXEL_FORMAT_RGBA8888};
static int32_t renderer_describe(void *context, pocket_renderer_descriptor *out) {
  (void)context;
  *out = (pocket_renderer_descriptor){sizeof *out, renderer_formats, 1,
    POCKET_TARGET_CPU_VISIBLE, POCKET_SYNC_IMMEDIATE, POCKET_DRAW_LIST_VERSION, 0};
  return 0;
}
static int32_t count_operation(void *context, const pocket_draw_op *operation) {
  (void)operation; ((Renderer *)context)->operations++;
  return 0;
}
static int32_t render(void *context, const pocket_frame_input *frame, uint64_t *submission) {
  Renderer *r = context;
  assert(frame->target->kind == POCKET_TARGET_CPU_VISIBLE);
  int32_t status = pocket_draw_list_visit(frame->list, frame->resources, 1, count_operation, r);
  if (status) return status;
  r->renders++;
  *submission = ++r->next;
  return 0;
}
static int32_t render_wait(void *context, uint64_t submission) {
  Renderer *r = context;
  assert(submission && submission <= r->next); r->waits++;
  return 0;
}
static void render_retire(void *context, uint64_t submission) {
  Renderer *r = context;
  assert(submission && submission <= r->next); r->retires++;
}
static const pocket_renderer_v1 renderer_api = {
  sizeof renderer_api, renderer_describe, render, render_wait, render_retire, NULL
};
typedef struct { pocket_3ds_input_source *input; pocket_runtime *runtime; unsigned composed, released; } Composition;
static int32_t compose(void *context, pocket_runtime *runtime) {
  Composition *c = context;
  c->composed++;
  pocket_renderer_id id = pocket_runtime_add_renderer(runtime, &renderer_api, &renderer);
  if (id == POCKET_RENDERER_INVALID) return -1;
  for (unsigned i=0; i<2; i++)
    if (pocket_runtime_add_display(runtime, &display_api, &displays[i], id)) return -1;
  if (pocket_runtime_add_input_source(runtime, pocket_3ds_input_source_vtable(), c->input)) return -1;
  c->runtime = runtime;
  return 0;
}
static void release(void *context) { Composition *c = context; c->released++; c->runtime = NULL; }
static const char *guest_error(void *guest) { return pocket_guest_quickjs_error(guest); }
static void evaluate(JSContext *ctx, const char *code) {
  JSValue value = JS_Eval(ctx, code, strlen(code), "fixture", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(value)) {
    JSValue error = JS_GetException(ctx);
    const char *text = JS_ToCString(ctx, error);
    fprintf(stderr, "guest assertion: %s\n", text ? text : "exception");
    JS_FreeCString(ctx, text); JS_FreeValue(ctx, error); abort();
  }
  JS_FreeValue(ctx, value);
}
static void exercise(const char *path, int valid, int fixture) {
  size_t baseline = live_allocations;
  memset(displays[0].pixels, 0, sizeof displays[0].pixels);
  memset(displays[1].pixels, 0, sizeof displays[1].pixels);
  displays[0].flushes = displays[0].waits = displays[1].flushes = displays[1].waits = 0;
  renderer = (Renderer){0};
  pocket_3ds_file_source source = {0};
  assert(!pocket_3ds_file_source_open(&source, path));
  JSRuntime *engine = JS_NewRuntime(); assert(engine);
  JSContext *ctx = JS_NewContext(engine); assert(ctx);
  pocket_guest_quickjs *guest = pocket_guest_quickjs_attach(ctx, POCKET_QJS_CANONICAL); assert(guest);
  pocket_3ds_input_source input = {0};
  pocket_3ds_input_source_set(&input, POCKET_BUTTON_CIRCLE, 0x00ff, NULL, 0, 0xff00);
  Composition parts = {.input=&input};
  const pocket_qjs_program_host host = {.struct_size=sizeof host,
    .profile=pocket_profile.facts, .profile_hash=pocket_profile.profile_hash,
    .guest=pocket_guest_quickjs_vtable(), .guest_context=guest, .guest_error=guest_error,
    .compose=compose, .release=release, .context=&parts};
  PocketQjsProgram *program = pocket_qjs_program_create_host(&host); assert(program);
  const pocket_profile_display *view = pocket_profile.facts->display;
  int booted = pocket_qjs_program_boot_source(program, pocket_3ds_file_source_vtable(), &source,
    (int)view->logical[0], (int)view->logical[1], view->raster_density,
    64u*1024u*1024u, 400u*240u*4u+320u*240u*4u);
  if (valid) {
    if (!booted) fprintf(stderr, "boot failed: %s\n", pocket_qjs_program_error(program));
    assert(booted && parts.runtime == pocket_qjs_program_runtime(program));
    assert(!pocket_runtime_tick(parts.runtime)); assert(!pocket_runtime_tick(parts.runtime));
    assert(displays[0].flushes && displays[1].flushes);
    if (fixture) evaluate(ctx, "if(__turns!==2)throw new Error('frame count');globalThis.saved=ui.createNode");
    printf("file runtime: primary=%llu auxiliary=%llu frames=2\n",
      (unsigned long long)displays[0].flushes, (unsigned long long)displays[1].flushes);
  } else {
    /* A rejected boot shuts its program down and releases the composition. */
    assert(!booted && pocket_qjs_program_error(program)[0]);
    assert(parts.released == 1 && !pocket_qjs_program_runtime(program));
    assert(!displays[0].flushes && !displays[1].flushes);
    evaluate(ctx, "if('__turns' in globalThis)throw new Error('rejected package ran guest')");
  }
  pocket_qjs_program_destroy(program);
  assert(parts.released == 1 && !parts.runtime);
  for (unsigned i=0; i<2; i++) assert(displays[i].flushes == displays[i].waits);
  if (valid && fixture)
    evaluate(ctx, "let rejected=false;try{saved(0)}catch(e){rejected=true}if(!rejected||'ui' in globalThis)throw new Error('shutdown lifetime')");
  /* Runtime borrows the source: its FILE and JSContext remain owned by us. */
  assert(source.file && ftell(source.file) >= 0);
  pocket_guest_quickjs_destroy(guest);
  JS_FreeContext(ctx); JS_FreeRuntime(engine);
  pocket_3ds_file_source_close(&source); assert(!source.file);
  assert(live_allocations == baseline);
}
int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "--smoke")) { exercise(argv[2], 1, 0); return 0; }
  assert(argc == 4);
  for (unsigned i=0; i<3; i++) exercise(argv[1], 1, 1);
  exercise(argv[2], 0, 1); exercise(argv[3], 0, 1);
  puts("3DS minimal Runtime through the QuickJS facade: file boot, generated guest, profile rejection, truncation, terminal teardown and zero leaks passed");
  return 0;
}
