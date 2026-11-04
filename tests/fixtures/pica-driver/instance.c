#define _POSIX_C_SOURCE 200112L
#include "../../../products/3ds/src/instance.c"
#include "package_fixture.h"
#include "pocket_native_program.h"
#include <assert.h>
#include <stdlib.h>

void *memalign(size_t alignment, size_t length) {
  void *out = NULL;
  return posix_memalign(&out, alignment, length) ? NULL : out;
}
bool svcwire_open(const char *text) { return !strcmp(text, "fixture"); }
void svcwire_send_line(const char *text, size_t length) {
  (void)text;
  (void)length;
}
size_t svcwire_recv_lines(char *out, size_t size) {
  (void)out;
  (void)size;
  return 0;
}
const char *devserver_debug_stats(void) { return "{\"host\":\"3ds\"}"; }
const char *launcher_table_json(void) { return "{\"apps\":[]}"; }
bool launcher_launch(const char *text) { return !strcmp(text, "fixture"); }

typedef struct {
  uint32_t role, width;
  uint8_t pixels[400 * 240 * 4];
  pocket_rect region;
  pocket_surface surface;
  uint64_t token;
} TestDisplay;
static TestDisplay displays[2] = {{.role = 0, .width = 400},
                                  {.role = 1, .width = 320}};
static int32_t display_descriptor(void *context,
                                  pocket_display_descriptor *out) {
  TestDisplay *d = context;
  *out =
      (pocket_display_descriptor){.struct_size = sizeof *out,
                                  .role = d->role,
                                  .width = d->width,
                                  .height = 240,
                                  .pixel_format = POCKET_PIXEL_FORMAT_RGBA8888,
                                  .stride_bytes = d->width * 4,
                                  .target_kind = POCKET_TARGET_CPU_VISIBLE,
                                  .refresh_width = d->width,
                                  .refresh_height = 240,
                                  .window_x_alignment = 1,
                                  .window_y_alignment = 1};
  return 0;
}
static int32_t acquire_display(void *context, const pocket_rect *region,
                               pocket_target *out) {
  TestDisplay *d = context;
  d->region = *region;
  d->surface = (pocket_surface){
      sizeof d->surface, d->pixels,    d->width * 240 * 4,
      &d->region,        d->width * 4, POCKET_PIXEL_FORMAT_RGBA8888};
  *out = (pocket_target){sizeof *out, POCKET_TARGET_CPU_VISIBLE,
                         &d->region,  POCKET_PIXEL_FORMAT_RGBA8888,
                         &d->surface, 0};
  return 0;
}
static int32_t flush_display(void *context, const pocket_rect *regions,
                             size_t count, uint64_t *token) {
  TestDisplay *d = context;
  assert(regions && count);
  *token = ++d->token;
  return 0;
}
static int32_t wait_display(void *context, uint64_t token) {
  assert(((TestDisplay *)context)->token == token);
  return 0;
}
static const pocket_display_output_v1 display_api = {
    sizeof display_api, display_descriptor, acquire_display,
    flush_display,      wait_display,       NULL,
    NULL,               NULL,               NULL};
/* The product archive registers no software renderer in slot 0, so the
 * fixture stands in for gfx.c's PICA renderer with a CPU one of its own. */
static const uint32_t renderer_formats[] = {POCKET_PIXEL_FORMAT_RGBA8888};
static uint64_t renders;
static int32_t renderer_descriptor(void *context,
                                   pocket_renderer_descriptor *out) {
  (void)context;
  *out = (pocket_renderer_descriptor){
      sizeof *out,           renderer_formats,      1,
      POCKET_TARGET_CPU_VISIBLE, POCKET_SYNC_IMMEDIATE, POCKET_DRAW_LIST_VERSION,
      0};
  return 0;
}
static int32_t render(void *context, const pocket_frame_input *frame,
                      uint64_t *submission) {
  (void)context;
  assert(frame->target->kind == POCKET_TARGET_CPU_VISIBLE);
  *submission = ++renders;
  return 0;
}
static int32_t wait_render(void *context, uint64_t submission) {
  (void)context;
  assert(submission && submission <= renders);
  return 0;
}
static void retire_render(void *context, uint64_t submission) {
  (void)context;
  (void)submission;
}
static const pocket_renderer_v1 renderer_api = {
    sizeof renderer_api, renderer_descriptor, render, wait_render,
    retire_render,       NULL};
bool gfx_register(pocket_runtime *runtime) {
  uint32_t renderer = pocket_runtime_add_renderer(runtime, &renderer_api, NULL);
  return renderer != POCKET_RENDERER_INVALID &&
         renderer != POCKET_RENDERER_SOFTWARE &&
         !pocket_runtime_add_display(runtime, &display_api, &displays[0],
                                     renderer) &&
         !pocket_runtime_add_display(runtime, &display_api, &displays[1],
                                     renderer);
}
static unsigned initialized, evaluated, framed, shut_down;
static uint32_t expected_touch;
static int32_t initialize_guest(void *self, pocket_runtime *runtime,
                                const pocket_guest_environment *env) {
  (void)self;
  initialized++;
  assert(env->viewport_width == 400 && env->viewport_height == 240);
  assert(env->auxiliary_width == 320 && env->auxiliary_height == 240 &&
         env->auxiliary_root > 0);
  assert(env->host_length == 7 && !memcmp(env->host, "3ds-dev", 7));
  assert(env->host_abi == POCKET_BINDING_GENERATION && env->raster_density == 1);
  /* This would fail if POCKETJS_LINK were not visible in instance.c. */
  assert(pocket_runtime_supports_op(runtime, POCKET_3DS_OP_appTable));
  assert(pocket_runtime_supports_op(runtime, POCKET_3DS_OP_appLaunch));
  pocket_result result = {.struct_size = sizeof result};
  assert(!pocket_runtime_op(runtime, POCKET_3DS_OP_appTable, NULL, 0, &result));
  assert(result.tag == POCKET_RESULT_BYTES && result.byte_length == 11 &&
         !memcmp(result.bytes, "{\"apps\":[]}", 11));
  pocket_op_arg arg = bytes((const uint8_t *)"fixture", 7);
  assert(!pocket_runtime_op(runtime, POCKET_3DS_OP_svcOpen, &arg, sizeof arg,
                            &result));
  assert(result.integer == 1);
  return 0;
}
static int32_t evaluate_guest(void *self, pocket_runtime *runtime,
                              const uint8_t *code, size_t length) {
  (void)self;
  (void)runtime;
  evaluated++;
  assert(length == 5 && !memcmp(code, "test\0", 5));
  return 0;
}
static int32_t frame_guest(void *self, const pocket_guest_frame *frame) {
  (void)self;
  assert(frame->buttons == 0x4000 && frame->analog == 0x00ff &&
         frame->right_analog == 0xff00);
  if (expected_touch) {
    assert(frame->touch_count == 1 && frame->touch_surfaces[0] == 1);
    assert(frame->touches[0] == expected_touch);
  } else
    assert(frame->touch_count == 0);
  framed++;
  return 0;
}
static void shutdown_guest(void *self) {
  (void)self;
  shut_down++;
}
/* The program products/3ds/src/qjs.c boots through the facade: no built-in
 * output, the 3DS package source, then instance_attach before boot. */
static PocketNativeProgram *create(PocketRuntimePackage *package) {
  return pocket_native_program_create_source(
      "3ds-dev", POCKETJS_HOST_ABI, instance_package_source(), package, 400,
      240, 1, INSTANCE_HEAP_LIMIT, INSTANCE_FRAME_BUFFER_BUDGET,
      &pocket_3ds_profile, pocket_3ds_profile_hash);
}
int main(void) {
  PocketRuntimePackage package = {.bytes = (uint8_t *)package_bytes,
                                  .length = sizeof package_bytes};
  PocketNativeProgram *program = create(&package);
  assert(program);
  pocket_runtime *runtime = pocket_native_program_runtime(program);
  pocket_guest_v1 guest_api = {sizeof guest_api, evaluate_guest,
                               frame_guest,      NULL,
                               shutdown_guest,   initialize_guest,
                               NULL};
  assert(!pocket_runtime_set_guest(runtime, &guest_api, NULL));
  assert(instance_attach(runtime) && !instance_attach(runtime));
  assert(!pocket_native_program_boot(program));
  uint32_t contact = (5 << 18) | (87 << 9) | 159;
  expected_touch = contact;
  instance_input(0x4000, 0x00ff, &contact, 1, 0xff00);
  assert(!pocket_runtime_tick(runtime));
  uint32_t cancelled = contact | (1u << 30);
  expected_touch = (5 << 18) | (1u << 30);
  instance_input(0x4000, 0x00ff, &cancelled, 1, 0xff00);
  assert(!pocket_runtime_tick(runtime));
  expected_touch = 0;
  instance_input(0x4000, 0x00ff, NULL, 0, 0xff00);
  assert(!pocket_runtime_tick(runtime));
  assert(initialized == 1 && evaluated == 1 && framed == 3);
  instance_detach();
  pocket_native_program_destroy(program);
  assert(shut_down == 1);
  program = create(&package);
  assert(program); /* An app switch constructs a fresh program from the same
                      source. */
  assert(instance_attach(pocket_native_program_runtime(program)));
  instance_detach();
  pocket_native_program_destroy(program);
  puts("3DS runtime composition: package, auxiliary metadata, providers and "
       "exact input passed");
}
