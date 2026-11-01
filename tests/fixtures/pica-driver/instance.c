#define _POSIX_C_SOURCE 200112L
#include "../../../products/3ds/src/instance.c"
#include "package_fixture.h"
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
bool gfx_register(pocket_runtime *runtime) {
  pocket_display_output_v1 api = {
      sizeof api,    display_descriptor, acquire_display,
      flush_display, wait_display,       NULL,
      NULL,          NULL,               NULL};
  return !pocket_runtime_add_display(runtime, &api, &displays[0],
                                     POCKET_RENDERER_SOFTWARE) &&
         !pocket_runtime_add_display(runtime, &api, &displays[1],
                                     POCKET_RENDERER_SOFTWARE);
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
int main(void) {
  PocketRuntimePackage package = {.bytes = (uint8_t *)package_bytes,
                                  .length = sizeof package_bytes};
  pocket_runtime *runtime = instance_create(&package);
  assert(runtime && !instance_create(&package));
  pocket_guest_v1 guest_api = {sizeof guest_api, evaluate_guest,
                               frame_guest,      NULL,
                               shutdown_guest,   initialize_guest,
                               NULL};
  assert(!pocket_runtime_set_guest(runtime, &guest_api, NULL));
  assert(!pocket_runtime_boot(runtime));
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
  instance_destroy();
  assert(shut_down == 1);
  runtime = instance_create(&package);
  assert(runtime); /* An app switch constructs a fresh instance from the same
                      source. */
  instance_destroy();
  puts("3DS runtime composition: package, auxiliary metadata, providers and "
       "exact input passed");
}
