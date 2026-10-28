#define _POSIX_C_SOURCE 200112L
#include <pocket_guest_quickjs.h>
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
  pocket_3ds_file_source source = {0};
  assert(!pocket_3ds_file_source_open(&source, path));
  pocket_runtime_config config = {.struct_size=sizeof config,
    .host_abi=pocket_profile.host_abi, .tick_hz=pocket_profile.tick_hz,
    .heap_limit=64u*1024u*1024u, .frame_buffer_budget=400u*240u*4u+320u*240u*4u,
    .profile=pocket_profile.facts};
  memcpy(config.profile_hash, pocket_profile.profile_hash, sizeof config.profile_hash);
  pocket_runtime *runtime = pocket_runtime_create(&config); assert(runtime);
  JSRuntime *engine = JS_NewRuntime(); assert(engine);
  JSContext *ctx = JS_NewContext(engine); assert(ctx);
  pocket_guest_quickjs *guest = pocket_guest_quickjs_attach(ctx, POCKET_QJS_CANONICAL); assert(guest);
  pocket_3ds_input_source input = {0};
  pocket_3ds_input_source_set(&input, POCKET_BUTTON_CIRCLE, 0x00ff, NULL, 0, 0xff00);
  assert(!pocket_runtime_set_package_source(runtime, pocket_3ds_file_source_vtable(), &source));
  assert(!pocket_runtime_set_guest(runtime, pocket_guest_quickjs_vtable(), guest));
  assert(!pocket_runtime_add_input_source(runtime, pocket_3ds_input_source_vtable(), &input));
  for (unsigned i=0; i<2; i++)
    assert(!pocket_runtime_add_display(runtime, &display_api, &displays[i], POCKET_RENDERER_SOFTWARE));
  int status = pocket_runtime_boot(runtime);
  if (valid) {
    if (status) fprintf(stderr, "boot failed: %s\n", pocket_guest_quickjs_error(guest));
    assert(status == POCKET_STATUS_OK);
    assert(!pocket_runtime_tick(runtime)); assert(!pocket_runtime_tick(runtime));
    assert(displays[0].flushes && displays[1].flushes);
    if (fixture) evaluate(ctx, "if(__turns!==2)throw new Error('frame count');globalThis.saved=ui.createNode");
    printf("file runtime: primary=%llu auxiliary=%llu frames=2\n",
      (unsigned long long)displays[0].flushes, (unsigned long long)displays[1].flushes);
  } else {
    assert(status != POCKET_STATUS_OK);
    assert(!displays[0].flushes && !displays[1].flushes);
    evaluate(ctx, "if('__turns' in globalThis)throw new Error('rejected package ran guest')");
  }
  pocket_runtime_destroy(runtime);
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
  puts("3DS minimal Runtime: file boot, generated guest, profile rejection, truncation, terminal teardown and zero leaks passed");
  return 0;
}
