#include "consumer.h"
#include <assert.h>
#include <string.h>
#ifdef ESP_PLATFORM
#include "driver/ppa.h"
#include "esp_err.h"
#endif

static const uint32_t formats[] = {POCKET_PIXEL_FORMAT_RGB565};
static int32_t descriptor(void *context, pocket_renderer_descriptor *out) {
  (void)context;
  *out = (pocket_renderer_descriptor){sizeof(*out), formats, 1,
      POCKET_TARGET_CPU_VISIBLE, POCKET_SYNC_IMMEDIATE, POCKET_DRAW_LIST_VERSION, 0};
  return POCKET_STATUS_OK;
}

typedef struct {
  fixture_renderer *renderer;
  pocket_surface *surface;
  const pocket_render_resources *resources;
} visit_context;

static int32_t max_i32(int32_t a, int32_t b) { return a > b ? a : b; }
static int32_t min_i32(int32_t a, int32_t b) { return a < b ? a : b; }

/* This consumer accelerates opaque RECT only. Every other operation remains
 * in DrawList order through the public per-operation software fallback. */
static int32_t visit(void *opaque, const pocket_draw_op *op) {
  visit_context *context = opaque;
  pocket_surface *surface = context->surface;
  const pocket_rect *region = surface->region;
  const uint32_t *words = op->words;
  if (words[0] != POCKET_DRAW_OP_RECT || (words[3] >> 24) != 255U) {
    context->renderer->fallbacks++;
    return pocket_raster_draw_op(surface, op, context->resources);
  }
  const int32_t scale = (int32_t)op->scale;
  int32_t x = (int16_t)words[1], y = (int16_t)(words[1] >> 16);
  int32_t right = x + (int32_t)(words[2] & 65535U);
  int32_t bottom = y + (int32_t)(words[2] >> 16);
  x = max_i32(max_i32(x, op->clip->x0) * scale, (int32_t)region->x);
  y = max_i32(max_i32(y, op->clip->y0) * scale, (int32_t)region->y);
  right = min_i32(min_i32(right, op->clip->x1) * scale, (int32_t)(region->x + region->width));
  bottom = min_i32(min_i32(bottom, op->clip->y1) * scale, (int32_t)(region->y + region->height));
  if (x >= right || y >= bottom) return POCKET_STATUS_OK;
  const uint8_t red = (uint8_t)words[3], green = (uint8_t)(words[3] >> 8), blue = (uint8_t)(words[3] >> 16);
#ifdef ESP_PLATFORM
  const ppa_fill_oper_config_t fill = {
      .out = {.buffer = surface->pixels, .buffer_size = surface->byte_length,
              .pic_w = surface->stride_bytes / 2, .pic_h = region->height,
              .block_offset_x = (uint32_t)x - region->x,
              .block_offset_y = (uint32_t)y - region->y,
              .fill_cm = PPA_FILL_COLOR_MODE_RGB565},
      .fill_block_w = (uint32_t)(right - x), .fill_block_h = (uint32_t)(bottom - y),
      .fill_argb_color = {.r = red, .g = green, .b = blue, .a = 255},
      .mode = PPA_TRANS_MODE_BLOCKING,
  };
  /* Blocking transactions finish before software touches the same strip. */
  if (ppa_do_fill(context->renderer->device, &fill) != ESP_OK)
    return POCKET_STATUS_FAILED;
#else
  /* Host-only stand-in for PPA, not evidence of hardware execution. */
  const uint16_t color = (uint16_t)(((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3));
  for (int32_t row = y; row < bottom; ++row)
    for (int32_t column = x; column < right; ++column) {
      const size_t at = ((uint32_t)row - region->y) * surface->stride_bytes + ((uint32_t)column - region->x) * 2U;
      memcpy(surface->pixels + at, &color, sizeof(color));
    }
#endif
  context->renderer->fills++;
  return POCKET_STATUS_OK;
}

static int32_t render(void *opaque, const pocket_frame_input *frame, uint64_t *submission) {
  fixture_renderer *renderer = opaque;
  if (frame->target->kind != POCKET_TARGET_CPU_VISIBLE ||
      frame->target->pixel_format != POCKET_PIXEL_FORMAT_RGB565)
    return POCKET_STATUS_UNSUPPORTED;
  pocket_surface *surface = frame->target->surface;
  for (uint32_t y = 0; y < surface->region->height; ++y)
    memset(surface->pixels + y * surface->stride_bytes, 0, surface->region->width * 2U);
  visit_context context = {renderer, surface, frame->resources};
  const int32_t result = pocket_draw_list_visit(frame->list, frame->resources, 1, visit, &context);
  if (result != POCKET_STATUS_OK) return result;
  renderer->renders++;
  *submission = ++renderer->next;
  return POCKET_STATUS_OK;
}
static int32_t wait_render(void *opaque, uint64_t submission) {
  fixture_renderer *renderer = opaque;
  assert(submission > 0 && submission <= renderer->next);
  renderer->waits++;
  return renderer->waits == renderer->fail_wait ? POCKET_STATUS_FAILED : POCKET_STATUS_OK;
}
static void retire(void *opaque, uint64_t submission) {
  fixture_renderer *renderer = opaque;
  assert(submission > 0 && submission <= renderer->next);
  renderer->retires++;
}
static const pocket_renderer_v1 table = {
    sizeof(table), descriptor, render, wait_render, retire, NULL};
const pocket_renderer_v1 *fixture_renderer_table(void) { return &table; }
void fixture_renderer_init(fixture_renderer *renderer) {
  memset(renderer, 0, sizeof(*renderer));
#ifdef ESP_PLATFORM
  ppa_client_handle_t client = NULL;
  const ppa_client_config_t config = {.oper_type = PPA_OPERATION_FILL,
      .max_pending_trans_num = 1, .data_burst_length = PPA_DATA_BURST_LENGTH_128};
  ESP_ERROR_CHECK(ppa_register_client(&config, &client));
  renderer->device = client;
#endif
}
void fixture_renderer_destroy(fixture_renderer *renderer) {
#ifdef ESP_PLATFORM
  ESP_ERROR_CHECK(ppa_unregister_client(renderer->device));
#else
  (void)renderer;
#endif
}
