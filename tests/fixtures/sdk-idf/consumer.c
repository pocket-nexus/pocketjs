#include "consumer.h"
#include "fixture_data.h"
#include <assert.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  uint8_t *allocation;
  size_t capacity;
  bool gram, pending;
  pocket_rect region;
  pocket_surface surface;
  unsigned acquires, flushes, waits, max_rows, polls, fail_wait;
  uint32_t expected_y;
  uint64_t hash;
} output_state;

static int32_t display_descriptor(void *opaque, pocket_display_descriptor *out) {
  output_state *state = opaque;
  memset(out, 0, sizeof(*out));
  out->struct_size = sizeof(*out);
  out->role = POCKET_DISPLAY_ROLE_PRIMARY;
  out->width = FIXTURE_WIDTH; out->height = FIXTURE_HEIGHT;
  out->pixel_format = POCKET_PIXEL_FORMAT_RGB565;
  out->stride_bytes = FIXTURE_STRIDE; out->target_kind = POCKET_TARGET_CPU_VISIBLE;
  out->flags = state->gram ? POCKET_DISPLAY_FRAME_STORAGE | POCKET_DISPLAY_PARTIAL_REFRESH : 0;
  out->refresh_width = out->refresh_height = 1;
  out->window_x_alignment = out->window_y_alignment = 1;
  return POCKET_STATUS_OK;
}
static void canaries(const output_state *state) {
  for (size_t i = 0; i < 64; ++i) {
    assert(state->allocation[i] == 0xa5);
    assert(state->allocation[64 + state->capacity + i] == 0xa5);
  }
}
static int32_t acquire(void *opaque, const pocket_rect *region, pocket_target *out) {
  output_state *state = opaque;
  assert(!state->pending);
  canaries(state);
  assert(region->x == 0 && region->width == FIXTURE_WIDTH);
  assert(region->height * FIXTURE_STRIDE <= state->capacity);
  if (region->y == 0) { state->hash = UINT64_C(14695981039346656037); state->expected_y = 0; }
  assert(region->y == state->expected_y);
  state->acquires++;
  if (state->max_rows < region->height) state->max_rows = region->height;
  state->region = *region;
  state->surface = (pocket_surface){sizeof(state->surface), state->allocation + 64,
      region->height * FIXTURE_STRIDE, &state->region, FIXTURE_STRIDE, POCKET_PIXEL_FORMAT_RGB565};
  *out = (pocket_target){sizeof(*out), POCKET_TARGET_CPU_VISIBLE, &state->region,
      POCKET_PIXEL_FORMAT_RGB565, &state->surface, 0};
  return POCKET_STATUS_OK;
}
static int32_t flush(void *opaque, const pocket_rect *regions, size_t count, uint64_t *token) {
  output_state *state = opaque;
  assert(!state->pending && count == 1 && regions[0].y == state->region.y);
  canaries(state);
  /* A streaming display sink consumes the strip without a full-frame copy. */
  for (size_t i = 0; i < state->surface.byte_length; ++i)
    state->hash = (state->hash ^ state->surface.pixels[i]) * UINT64_C(1099511628211);
  state->expected_y += state->region.height;
  state->pending = true; *token = ++state->flushes;
  return POCKET_STATUS_OK;
}
static int32_t wait_display(void *opaque, uint64_t token) {
  output_state *state = opaque;
  assert(state->pending && token == state->flushes);
  state->pending = false;
  state->waits++;
  return state->waits == state->fail_wait ? POCKET_STATUS_FAILED : POCKET_STATUS_OK;
}
static const pocket_display_output_v1 display_table = {
    sizeof(display_table), display_descriptor, acquire, flush, wait_display, NULL, NULL};
static uint32_t input_classes(void *opaque) { (void)opaque; return POCKET_INPUT_CLASS_BUTTONS; }
static int32_t poll(void *opaque, pocket_input_frame_builder *builder) {
  output_state *state = opaque;
  pocket_input_frame input = {0}; input.struct_size = sizeof(input);
  input.buttons = (++state->polls & 1U) ? POCKET_BTN_CROSS : 0;
  return builder->append(builder->context, &input);
}
static const pocket_input_source_v1 input_table = {sizeof(input_table), input_classes, poll};
static int32_t source_length(void *opaque, size_t *length) {
  (void)opaque; *length = sizeof(fixture_package); return POCKET_STATUS_OK;
}
static int32_t source_range(void *opaque, size_t offset, uint8_t *output, size_t capacity, size_t *length) {
  (void)opaque;
  if (offset > sizeof(fixture_package)) return POCKET_STATUS_INVALID;
  size_t remaining = sizeof(fixture_package) - offset;
  *length = capacity < remaining ? capacity : remaining;
  if (*length > 31) *length = 31; /* Exercise complete loading through short reads. */
  memcpy(output, fixture_package + offset, *length);
  return POCKET_STATUS_OK;
}
static const pocket_package_source_v1 source_table = {sizeof(source_table), source_length, NULL, source_range};
typedef struct { uint64_t boot, tick; unsigned fills, fallbacks; } run_result;

static run_result run(bool accelerated, bool gram, bool fail_render, bool fail_display, bool reject_budget) {
  const size_t capacity = FIXTURE_STRIDE * (gram || reject_budget ? FIXTURE_STRIP_ROWS : FIXTURE_HEIGHT);
  output_state output = {0}; output.capacity = capacity; output.gram = gram;
  output.fail_wait = fail_display ? 2 : 0;
  output.allocation = pocket_host_alloc(capacity + 128, 64);
  assert(output.allocation); memset(output.allocation, 0xa5, capacity + 128);
  pocket_runtime_config config = {0}; config.struct_size = sizeof(config);
  memcpy(config.profile_hash, fixture_profile_hash, sizeof(config.profile_hash));
  config.host_abi = POCKET_BINDING_GENERATION; config.tick_hz = 60; config.heap_limit = 512 * 1024;
  config.frame_buffer_budget = capacity; config.profile_json = fixture_profile;
  config.profile_json_length = sizeof(fixture_profile) - 1;
  pocket_runtime *runtime = pocket_runtime_create(&config); assert(runtime);
  fixture_renderer renderer; uint32_t renderer_id = POCKET_RENDERER_SOFTWARE;
  if (accelerated) {
    fixture_renderer_init(&renderer); renderer.fail_wait = fail_render ? 2 : 0;
    renderer_id = pocket_runtime_add_renderer(runtime, fixture_renderer_table(), &renderer);
    assert(renderer_id != POCKET_RENDERER_INVALID);
  }
  const int32_t registered = pocket_runtime_add_display(runtime, &display_table, &output, renderer_id);
  if (reject_budget) {
    assert(registered != POCKET_STATUS_OK && output.acquires == 0);
    pocket_runtime_destroy(runtime); pocket_host_free(output.allocation, capacity + 128, 64);
    return (run_result){0};
  }
  assert(registered == POCKET_STATUS_OK);
  assert(pocket_runtime_add_input_source(runtime, &input_table, &output) == POCKET_STATUS_OK);
  assert(pocket_runtime_set_package_source(runtime, &source_table, NULL) == POCKET_STATUS_OK);
  pocket_guest_quickjs *guest = pocket_guest_quickjs_create(POCKET_QJS_CANONICAL); assert(guest);
  assert(pocket_runtime_set_guest(runtime, pocket_guest_quickjs_vtable(), guest) == POCKET_STATUS_OK);
  const int32_t booted = pocket_runtime_boot(runtime);
  if (booted != POCKET_STATUS_OK && !fail_render && !fail_display)
    fprintf(stderr, "guest boot status=%d acquires=%u: %s\n", (int)booted, output.acquires, pocket_guest_quickjs_error(guest));
  assert((booted != POCKET_STATUS_OK) == (fail_render || fail_display));
  assert(!output.pending);
  if (fail_render) assert(output.flushes == 1 && renderer.retires == 2);
  if (fail_display) assert(output.flushes == 2 && output.waits == 2);
  run_result result = {.boot = output.hash};
  assert(pocket_runtime_tick(runtime) == POCKET_STATUS_OK);
  assert(output.expected_y == FIXTURE_HEIGHT && output.polls == 1 && !output.pending);
  result.tick = output.hash;
  assert(output.max_rows == (gram ? FIXTURE_STRIP_ROWS : FIXTURE_HEIGHT));
  canaries(&output);
  pocket_runtime_destroy(runtime); pocket_guest_quickjs_destroy(guest);
  if (accelerated) {
    assert(renderer.renders == renderer.waits && renderer.waits == renderer.retires);
    result.fills = renderer.fills; result.fallbacks = renderer.fallbacks;
    fixture_renderer_destroy(&renderer);
  }
  pocket_host_free(output.allocation, capacity + 128, 64);
  return result;
}

void fixture_run(void) {
  const run_result whole = run(false, false, false, false, false);
  const run_result strip = run(false, true, false, false, false);
  const run_result ppa = run(true, true, false, false, false);
  const run_result render_failure = run(true, true, true, false, false);
  const run_result display_failure = run(true, true, false, true, false);
  (void)run(false, false, false, false, true);
  assert(whole.boot == strip.boot && whole.tick == strip.tick && whole.boot != whole.tick);
  assert(ppa.boot == strip.boot && ppa.tick == strip.tick && ppa.fills > 0 && ppa.fallbacks > 0);
  assert(render_failure.tick == strip.tick && display_failure.tick == strip.tick);
  printf("SDK consumer passed: boot=%016" PRIx64 " tick=%016" PRIx64
         " strip_bytes=%u full_bytes=%u fills=%u fallbacks=%u failures=2\n",
         strip.boot, strip.tick, FIXTURE_STRIDE * FIXTURE_STRIP_ROWS,
         FIXTURE_STRIDE * FIXTURE_HEIGHT, ppa.fills, ppa.fallbacks);
}
