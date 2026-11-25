#include "driver/ppa.h"
#include "esp_attr.h"
#include "esp_cache.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "pocket/display_esp_dpi.h"
#include <inttypes.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
static const char *TAG = "pocket_display_esp_dpi";
/* A present takes milliseconds; a wait past this bound fails and keeps the
 * buffer reserved. */
#define WAIT_TIMEOUT_MS 1000
/* Presents queued on the PPA client at once: every rectangle of one strip. */
#define MAX_PENDING_PRESENTS 8U
/* Copies queued on the move channel at once, and panel rows per copy: each
 * copy allocates DMA descriptors for its bytes in internal RAM. */
#define MOVE_BACKLOG 8U
#define MOVE_ROWS 48U
/* Panel rows a move down must reach to copy rows in place: shorter moves
 * would need one copy per few rows and bounce through the staging buffers
 * instead. */
#define MIN_DIRECT_ROWS 32U
/* Rectangles one host_damage call may report (pocket_display_host_damage_fn
 * capacity): the overlay's old and new place, and where a move carried it. */
#define PENDING_RECTS 4U
typedef struct {
  uint16_t *pixels;
  bool pending, timed_out;
  uint64_t token;
  /* Presents submitted for this buffer, and the completions they signal. */
  uint32_t submitted;
  SemaphoreHandle_t done;
  pocket_rect region;
  pocket_surface surface;
} buffer;
struct pocket_display_esp_dpi {
  pocket_display_esp_dpi_config config;
  size_t capacity;
  uint32_t active;
  uint64_t next, generation;
  /* The panel's framebuffers. Moves and presents write `target`: the only
   * framebuffer, or of two the one the panel does not scan. */
  uint16_t *framebuffers[2];
  uint32_t framebuffer_count, target;
  /* Two framebuffers: the target holds writes the panel was not shown, and
   * the panel may still read the target, which it scanned before the last
   * flip. */
  bool unshown, settling;
  ppa_client_handle_t present;
  ppa_client_handle_t mover;
  SemaphoreHandle_t moved;
  SemaphoreHandle_t written;
  buffer buffers[2];
  pocket_display_esp_dpi_overlay overlay;
  bool overlay_set;
  /* Rectangles each framebuffer needs repainted (host_damage). */
  pocket_rect pending[2][PENDING_RECTS];
  size_t pending_count[2];
};

static void add_pending(pocket_display_esp_dpi *d, uint32_t framebuffer,
                        uint32_t x, uint32_t y, uint32_t width,
                        uint32_t height) {
  if (d->pending_count[framebuffer] == PENDING_RECTS || !width || !height)
    return;
  d->pending[framebuffer][d->pending_count[framebuffer]++] =
      (pocket_rect){.struct_size = sizeof(pocket_rect),
                    .x = x,
                    .y = y,
                    .width = width,
                    .height = height};
}

/* The overlay's rectangle clipped to the picture, offset by (dx, dy), for
 * one framebuffer. */
static void add_overlay_rect(pocket_display_esp_dpi *d, uint32_t framebuffer,
                             int32_t dx, int32_t dy) {
  const int64_t x0 = (int64_t)d->overlay.x + dx;
  const int64_t y0 = (int64_t)d->overlay.y + dy;
  const int64_t x1 = x0 + d->overlay.size;
  const int64_t y1 = y0 + d->overlay.size;
  const int64_t cx0 = x0 < 0 ? 0 : x0;
  const int64_t cy0 = y0 < 0 ? 0 : y0;
  const int64_t cx1 = x1 > d->config.width ? d->config.width : x1;
  const int64_t cy1 = y1 > d->config.height ? d->config.height : y1;
  if (cx1 > cx0 && cy1 > cy0)
    add_pending(d, framebuffer, (uint32_t)cx0, (uint32_t)cy0,
                (uint32_t)(cx1 - cx0), (uint32_t)(cy1 - cy0));
}

/* The overlay's rectangle in every framebuffer: each one holds the face. */
static void add_overlay_rects(pocket_display_esp_dpi *d) {
  for (uint32_t i = 0; i < d->framebuffer_count; i++)
    add_overlay_rect(d, i, 0, 0);
}

void pocket_display_esp_dpi_set_overlay(
    pocket_display_esp_dpi *d, const pocket_display_esp_dpi_overlay *overlay) {
  if (!d)
    return;
  if (d->overlay_set)
    add_overlay_rects(d);
  d->overlay_set = overlay != NULL && overlay->argb != NULL && overlay->size != 0U;
  if (d->overlay_set) {
    d->overlay = *overlay;
    add_overlay_rects(d);
  }
}

/* Blend the overlay's texels over the strip pixels of `region` (raster
 * coordinates of the picture) in staging buffer `b`, straight alpha. */
static void blend_overlay(const pocket_display_esp_dpi *d, buffer *b,
                          const pocket_rect *region) {
  if (!d->overlay_set)
    return;
  const uint32_t ox1 = d->overlay.x + d->overlay.size;
  const uint32_t oy1 = d->overlay.y + d->overlay.size;
  const uint32_t x0 = region->x > d->overlay.x ? region->x : d->overlay.x;
  const uint32_t y0 = region->y > d->overlay.y ? region->y : d->overlay.y;
  const uint32_t x1 = region->x + region->width < ox1 ? region->x + region->width : ox1;
  const uint32_t y1 = region->y + region->height < oy1 ? region->y + region->height : oy1;
  if (x0 >= x1 || y0 >= y1)
    return;
  const uint32_t width = d->config.width;
  for (uint32_t y = y0; y < y1; y++) {
    uint16_t *row = b->pixels + (size_t)(y - b->region.y) * width;
    const uint32_t *face = d->overlay.argb + (size_t)(y - d->overlay.y) * d->overlay.size;
    for (uint32_t x = x0; x < x1; x++) {
      const uint32_t texel = face[x - d->overlay.x];
      const uint32_t a = texel >> 24;
      if (a == 0U)
        continue;
      const uint16_t under = row[x];
      const uint32_t ur = (under >> 11) << 3;
      const uint32_t ug = ((under >> 5) & 0x3fU) << 2;
      const uint32_t ub = (under & 0x1fU) << 3;
      const uint32_t r = (((texel >> 16) & 0xffU) * a + ur * (255U - a)) / 255U;
      const uint32_t g = (((texel >> 8) & 0xffU) * a + ug * (255U - a)) / 255U;
      const uint32_t bl = ((texel & 0xffU) * a + ub * (255U - a)) / 255U;
      row[x] = (uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (bl >> 3));
    }
  }
}
static bool IRAM_ATTR on_present(ppa_client_handle_t client,
                                 ppa_event_data_t *event, void *context) {
  (void)client;
  (void)event;
  BaseType_t woken = pdFALSE;
  xSemaphoreGiveFromISR(context, &woken);
  return woken == pdTRUE;
}
static bool IRAM_ATTR on_copied(async_memcpy_handle_t copy,
                                async_memcpy_event_t *event, void *context) {
  (void)copy;
  (void)event;
  BaseType_t woken = pdFALSE;
  xSemaphoreGiveFromISR(context, &woken);
  return woken == pdTRUE;
}
/* Collect a buffer's completions. A timeout leaves the rest outstanding. */
static bool drain(buffer *b, TickType_t timeout) {
  const TickType_t deadline = xTaskGetTickCount() + timeout;
  while (b->submitted > 0U) {
    const TickType_t now = xTaskGetTickCount();
    const TickType_t remaining =
        timeout == portMAX_DELAY ? portMAX_DELAY
        : (int32_t)(deadline - now) > 0 ? deadline - now
                                        : 0;
    if (xSemaphoreTake(b->done, remaining) != pdTRUE)
      return false;
    --b->submitted;
  }
  return true;
}
static bool reserved(const buffer *b) {
  return b->pending || b->timed_out;
}
static void new_generation(pocket_display_esp_dpi *d) {
  if (d->generation == UINT64_MAX)
    abort();
  d->generation++;
}
/* Two framebuffers: show the panel the target, which holds a whole frame,
 * and make the framebuffer the panel scanned the target. The panel reads
 * that one until its next refresh; settle waits for it. */
static bool publish(pocket_display_esp_dpi *d) {
  if (!d->unshown)
    return true;
  d->unshown = false;
  const pocket_display_esp_dpi_flip *flip = &d->config.flip;
  if (!flip->show(flip->context, d->framebuffers[d->target])) {
    ESP_LOGE(TAG, "the panel refused framebuffer %" PRIu32, d->target);
    new_generation(d);
    return false;
  }
  d->target ^= 1U;
  d->settling = true;
  return true;
}
/* Before the first write of the target after a flip: wait until the panel
 * scans the other framebuffer. */
static bool settle(pocket_display_esp_dpi *d) {
  if (!d->settling)
    return true;
  const pocket_display_esp_dpi_flip *flip = &d->config.flip;
  if (!flip->wait_shown(flip->context, WAIT_TIMEOUT_MS)) {
    ESP_LOGE(TAG, "the panel did not flip in %d ms", WAIT_TIMEOUT_MS);
    return false;
  }
  d->settling = false;
  return true;
}
pocket_display_esp_dpi *
pocket_display_esp_dpi_create(const pocket_display_esp_dpi_config *c) {
  if (!c || c->struct_size < sizeof(*c) || !c->framebuffer ||
      !c->panel_width || !c->panel_height || !c->width || !c->height ||
      c->width > INT_MAX || c->height > INT_MAX || !c->scale ||
      !c->row_alignment || !c->strip_rows ||
      c->strip_rows % c->row_alignment || c->strip_rows > c->height ||
      c->role > POCKET_DISPLAY_ROLE_AUXILIARY ||
      (c->back_framebuffer &&
       (c->back_framebuffer == c->framebuffer || !c->flip.show ||
        !c->flip.wait_shown)))
    return NULL;
  const uint32_t screen_width = c->turned ? c->panel_height : c->panel_width;
  const uint32_t screen_height = c->turned ? c->panel_width : c->panel_height;
  if ((uint64_t)c->width * c->scale > screen_width - c->origin_x ||
      (uint64_t)c->height * c->scale > screen_height - c->origin_y ||
      c->origin_x > screen_width || c->origin_y > screen_height)
    return NULL;
  const size_t capacity = (size_t)c->width * c->strip_rows * 2U;
  if (capacity > c->frame_buffer_budget / 2U)
    return NULL;
  pocket_display_esp_dpi *d = calloc(1, sizeof(*d));
  if (!d)
    return NULL;
  d->config = *c;
  d->capacity = capacity;
  d->active = UINT32_MAX;
  d->generation = 1;
  d->framebuffers[0] = c->framebuffer;
  d->framebuffers[1] = c->back_framebuffer;
  d->framebuffer_count = c->back_framebuffer ? 2U : 1U;
  d->target = d->framebuffer_count - 1U;
  d->moved = xSemaphoreCreateCounting(MOVE_BACKLOG, 0);
  d->written = xSemaphoreCreateCounting(2, 0);
  const ppa_client_config_t present = {
      .oper_type = PPA_OPERATION_SRM,
      /* Both buffers can have a flush on its way. */
      .max_pending_trans_num = 2U * MAX_PENDING_PRESENTS,
  };
  const ppa_client_config_t mover = {
      .oper_type = PPA_OPERATION_SRM,
      .max_pending_trans_num = 1,
  };
  const ppa_event_callbacks_t callbacks = {.on_trans_done = on_present};
  if (!d->moved || !d->written ||
      ppa_register_client(&present, &d->present) != ESP_OK ||
      ppa_client_register_event_callbacks(d->present, &callbacks) != ESP_OK ||
      ppa_register_client(&mover, &d->mover) != ESP_OK) {
    pocket_display_esp_dpi_destroy(d);
    return NULL;
  }
  for (uint32_t i = 0; i < 2U; i++) {
    buffer *b = &d->buffers[i];
    b->pixels = heap_caps_aligned_alloc(128, capacity,
                                        MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    b->done = xSemaphoreCreateCounting(MAX_PENDING_PRESENTS, 0);
    if (!b->pixels || !b->done) {
      pocket_display_esp_dpi_destroy(d);
      return NULL;
    }
    memset(b->pixels, 0, capacity);
  }
  return d;
}
size_t pocket_display_esp_dpi_buffer_bytes(const pocket_display_esp_dpi *d) {
  return d ? d->capacity * 2U : 0;
}
uint16_t *pocket_display_esp_dpi_staging(pocket_display_esp_dpi *d,
                                         uint32_t index) {
  return d && index < 2U ? d->buffers[index].pixels : NULL;
}
static void drain_all(pocket_display_esp_dpi *d) {
  for (uint32_t i = 0; i < 2U; i++) {
    buffer *b = &d->buffers[i];
    if (b->done)
      (void)drain(b, portMAX_DELAY);
    b->pending = false;
    b->timed_out = false;
  }
}
void pocket_display_esp_dpi_invalidate(pocket_display_esp_dpi *d) {
  if (d) {
    drain_all(d);
    new_generation(d);
  }
}
void pocket_display_esp_dpi_destroy(pocket_display_esp_dpi *d) {
  if (!d)
    return;
  drain_all(d);
  (void)settle(d);
  if (d->present)
    ppa_unregister_client(d->present);
  if (d->mover)
    ppa_unregister_client(d->mover);
  for (uint32_t i = 0; i < 2U; i++) {
    heap_caps_free(d->buffers[i].pixels);
    if (d->buffers[i].done)
      vSemaphoreDelete(d->buffers[i].done);
  }
  if (d->moved)
    vSemaphoreDelete(d->moved);
  if (d->written)
    vSemaphoreDelete(d->written);
  free(d);
}
static int32_t descriptor(void *context, pocket_display_descriptor *out) {
  pocket_display_esp_dpi *d = context;
  if (!d || !out || out->struct_size < sizeof(*out))
    return POCKET_STATUS_INVALID;
  *out = (pocket_display_descriptor){
      .struct_size = sizeof(*out),
      .role = d->config.role,
      .width = d->config.width,
      .height = d->config.height,
      .pixel_format = POCKET_PIXEL_FORMAT_RGB565,
      .stride_bytes = (size_t)d->config.width * 2U,
      .target_kind = POCKET_TARGET_CPU_VISIBLE,
      .flags = POCKET_DISPLAY_FRAME_STORAGE | POCKET_DISPLAY_PARTIAL_REFRESH |
               POCKET_DISPLAY_DOUBLE_BUFFERED |
               POCKET_DISPLAY_PIPELINED_ACQUIRE |
               (d->config.turned || d->config.half_turn
                    ? POCKET_DISPLAY_DEVICE_ROTATION
                    : 0U) |
               /* The PPA scales bilinearly, three quarters of a pixel and
                * one quarter of the pixel beside it, and repeats a block's
                * edge pixels: the runtime grows damage by one pixel. */
               (d->config.scale > 1U ? POCKET_DISPLAY_DEVICE_SCALING |
                                           POCKET_DISPLAY_FILTERED_SCALING
                                     : 0U) |
               (d->config.move_copy ? POCKET_DISPLAY_RETAINED_MOVE : 0U),
      .refresh_width = 1,
      .refresh_height = 1,
      .window_x_alignment = 1,
      .window_y_alignment = d->config.row_alignment};
  return POCKET_STATUS_OK;
}
static int32_t acquire(void *context, const pocket_rect *region,
                       pocket_target *out) {
  pocket_display_esp_dpi *d = context;
  if (d && region && region->struct_size >= sizeof(*region) &&
      region->height > d->config.strip_rows)
    ESP_LOGE(TAG, "acquire of %" PRIu32 " rows: a strip holds %" PRIu32,
             region->height, d->config.strip_rows);
  if (!d || !region || region->struct_size < sizeof(*region) || !out ||
      out->struct_size < sizeof(*out) || region->x ||
      region->width != d->config.width || !region->height ||
      region->height > d->config.strip_rows ||
      region->y > d->config.height - region->height)
    return POCKET_STATUS_INVALID;
  /* An unflushed acquire has no reader and can be replaced after a failed
   * render. */
  for (uint32_t i = 0; i < 2U; i++) {
    buffer *b = &d->buffers[i];
    if (reserved(b))
      continue;
    d->active = i;
    b->region = *region;
    b->surface = (pocket_surface){
        .struct_size = sizeof(b->surface),
        .pixels = (uint8_t *)b->pixels,
        .byte_length = (size_t)d->config.width * region->height * 2U,
        .region = &b->region,
        .stride_bytes = (size_t)d->config.width * 2U,
        .pixel_format = POCKET_PIXEL_FORMAT_RGB565};
    *out = (pocket_target){.struct_size = sizeof(*out),
                           .kind = POCKET_TARGET_CPU_VISIBLE,
                           .region = &b->region,
                           .pixel_format = POCKET_PIXEL_FORMAT_RGB565,
                           .surface = &b->surface};
    return POCKET_STATUS_OK;
  }
  return POCKET_STATUS_FAILED;
}
/* Quarter turns counter-clockwise from the screen to the panel. */
static uint32_t quarter_turns(const pocket_display_esp_dpi_config *c) {
  return (c->turned ? 1U : 0U) + (c->half_turn ? 2U : 0U);
}

/* The panel rectangle of screen pixels [x0, x1) x [y0, y1). Screen (x, y)
 * lands on panel (x, y), (y, ph - 1 - x), (pw - 1 - x, ph - 1 - y) or
 * (pw - 1 - y, x) for 0 to 3 quarter turns. */
static void panel_rect(const pocket_display_esp_dpi_config *c, uint32_t x0,
                       uint32_t y0, uint32_t x1, uint32_t y1, uint32_t *px0,
                       uint32_t *py0, uint32_t *px1, uint32_t *py1) {
  const uint32_t pw = c->panel_width;
  const uint32_t ph = c->panel_height;
  switch (quarter_turns(c)) {
  case 1U:
    *px0 = y0, *px1 = y1, *py0 = ph - x1, *py1 = ph - x0;
    break;
  case 2U:
    *px0 = pw - x1, *px1 = pw - x0, *py0 = ph - y1, *py1 = ph - y0;
    break;
  case 3U:
    *px0 = pw - y1, *px1 = pw - y0, *py0 = x0, *py1 = x1;
    break;
  default:
    *px0 = x0, *px1 = x1, *py0 = y0, *py1 = y1;
    break;
  }
}

/* Copy one damaged rectangle of the strip in `b` to its place on the panel
 * (panel_rect). */
static esp_err_t present(pocket_display_esp_dpi *d, buffer *b,
                         const pocket_rect *r) {
  const pocket_display_esp_dpi_config *c = &d->config;
  const uint32_t y = r->y - b->region.y;
  if (quarter_turns(c) == 0U && c->scale == 1U && c->copy && r->x == 0U &&
      r->width == c->panel_width) {
    /* Whole panel rows are one contiguous run of the framebuffer. */
    return esp_async_memcpy(
        c->copy,
        d->framebuffers[d->target] +
            (size_t)(c->origin_y + r->y) * c->panel_width,
        b->pixels + (size_t)y * c->width, (size_t)r->width * r->height * 2U,
        on_copied, b->done);
  }
  ppa_srm_oper_config_t operation = {
      .in = {.buffer = b->pixels,
             .pic_w = c->width,
             .pic_h = b->region.height,
             .block_w = r->width,
             .block_h = r->height,
             .block_offset_x = r->x,
             .block_offset_y = y,
             .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
      .out = {.buffer = d->framebuffers[d->target],
              .buffer_size =
                  (size_t)c->panel_width * c->panel_height * sizeof(uint16_t),
              .pic_w = c->panel_width,
              .pic_h = c->panel_height,
              .block_offset_x = c->origin_x + r->x * c->scale,
              .block_offset_y = c->origin_y + r->y * c->scale,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
      .rotation_angle = PPA_SRM_ROTATION_ANGLE_0,
      .scale_x = (float)c->scale,
      .scale_y = (float)c->scale,
      .mode = PPA_TRANS_MODE_NON_BLOCKING,
      .user_data = b->done,
  };
  static const ppa_srm_rotation_angle_t angles[4] = {
      PPA_SRM_ROTATION_ANGLE_0, PPA_SRM_ROTATION_ANGLE_90,
      PPA_SRM_ROTATION_ANGLE_180, PPA_SRM_ROTATION_ANGLE_270};
  const uint32_t turns = quarter_turns(c);
  if (turns != 0U) {
    const uint32_t x0 = c->origin_x + r->x * c->scale;
    const uint32_t y0 = c->origin_y + r->y * c->scale;
    uint32_t px0, py0, px1, py1;
    panel_rect(c, x0, y0, x0 + r->width * c->scale, y0 + r->height * c->scale,
               &px0, &py0, &px1, &py1);
    operation.out.block_offset_x = px0;
    operation.out.block_offset_y = py0;
    operation.rotation_angle = angles[turns];
  }
  return ppa_do_scale_rotate_mirror(d->present, &operation);
}
static int32_t flush(void *context, const pocket_rect *regions, size_t count,
                     uint64_t *token) {
  pocket_display_esp_dpi *d = context;
  if (!d || !regions || !count || count > MAX_PENDING_PRESENTS || !token ||
      d->active >= 2U || d->next == UINT64_MAX)
    return POCKET_STATUS_INVALID;
  buffer *b = &d->buffers[d->active];
  const pocket_rect *r = regions;
  uint32_t x0 = UINT32_MAX, y0 = UINT32_MAX, x1 = 0, y1 = 0;
  for (size_t i = 0; i < count; i++) {
    if (r->struct_size < sizeof(*r) || r->struct_size % _Alignof(pocket_rect) ||
        !r->width || !r->height || r->x > d->config.width - r->width ||
        r->y < b->region.y || r->height > b->region.height ||
        r->y - b->region.y > b->region.height - r->height)
      return POCKET_STATUS_INVALID;
    x0 = r->x < x0 ? r->x : x0;
    y0 = r->y < y0 ? r->y : y0;
    x1 = r->x + r->width > x1 ? r->x + r->width : x1;
    y1 = r->y + r->height > y1 ? r->y + r->height : y1;
    r = (const pocket_rect *)((const uint8_t *)r + r->struct_size);
  }
  /* The rectangles may overlap, so the overlay blends once over their
   * bounds instead of once in each. The renderer painted every pixel a
   * rectangle presents this frame; the other pixels of the bounds are not
   * presented. */
  const pocket_rect bounds = {.struct_size = sizeof(bounds),
                              .x = x0,
                              .y = y0,
                              .width = x1 - x0,
                              .height = y1 - y0};
  blend_overlay(d, b, &bounds);
  if (!settle(d)) {
    d->active = UINT32_MAX;
    d->unshown = false;
    new_generation(d);
    return POCKET_STATUS_FAILED;
  }
  r = regions;
  for (size_t i = 0; i < count; i++) {
    const esp_err_t presented = present(d, b, r);
    if (presented != ESP_OK) {
      ESP_LOGE(TAG, "present of %" PRIu32 "x%" PRIu32 " at %" PRIu32 ",%" PRIu32 ": %s",
               r->width, r->height, r->x, r->y, esp_err_to_name(presented));
      (void)drain(b, portMAX_DELAY);
      d->active = UINT32_MAX;
      /* The target holds part of a frame: the next frame repaints it. */
      d->unshown = false;
      new_generation(d);
      return POCKET_STATUS_FAILED;
    }
    ++b->submitted;
    r = (const pocket_rect *)((const uint8_t *)r + r->struct_size);
  }
  d->unshown = d->framebuffer_count == 2U;
  b->pending = true;
  *token = b->token = ++d->next;
  d->active = UINT32_MAX;
  return POCKET_STATUS_OK;
}
static int32_t wait_display(void *context, uint64_t token) {
  pocket_display_esp_dpi *d = context;
  if (!d)
    return POCKET_STATUS_INVALID;
  for (uint32_t i = 0; i < 2U; i++) {
    buffer *b = &d->buffers[i];
    if (!b->pending || b->token != token)
      continue;
    b->pending = false;
    if (!drain(b, pdMS_TO_TICKS(WAIT_TIMEOUT_MS))) {
      ESP_LOGE(TAG, "%" PRIu32 " presents of strip %" PRIu32 " did not complete in %d ms",
               b->submitted, b->region.y, WAIT_TIMEOUT_MS);
      b->timed_out = true;
      d->unshown = false;
      return POCKET_STATUS_FAILED;
    }
    b->timed_out = false;
    /* The runtime keeps a strip in flight while it renders the next one, so
     * the wait that leaves no strip acquired or in flight is the wait for
     * the frame's last strip: the target holds the frame. */
    if (d->active == UINT32_MAX && !reserved(&d->buffers[i ^ 1U]) &&
        !publish(d))
      return POCKET_STATUS_FAILED;
    return POCKET_STATUS_OK;
  }
  return POCKET_STATUS_INVALID;
}
static int32_t identity(void *context, pocket_buffer_identity *out) {
  pocket_display_esp_dpi *d = context;
  if (!d || !out || out->struct_size < sizeof(*out))
    return POCKET_STATUS_INVALID;
  /* A timed-out present may still land: release its buffer once it has. */
  for (uint32_t i = 0; i < 2U; i++) {
    buffer *b = &d->buffers[i];
    if (b->timed_out && drain(b, 0))
      b->timed_out = false;
  }
  if (d->active != UINT32_MAX) {
    /* The frame before this one acquired a strip and did not flush it: it
     * failed, and the target holds part of it. */
    d->unshown = false;
  } else if (!reserved(&d->buffers[0]) && !reserved(&d->buffers[1])) {
    /* It moved pixels and presented nothing: no wait showed the target. */
    (void)publish(d);
  }
  *out = (pocket_buffer_identity){.struct_size = sizeof(*out),
                                  .buffer = 1U + d->target,
                                  .generation = d->generation};
  return POCKET_STATUS_OK;
}

/* ---- moves ---------------------------------------------------------------
 * Both staging buffers are idle when a frame starts, so a move may bounce
 * through them. */

/* Move whole panel rows y0..y1 by dy in place. Copies run in queue order: a
 * move up copies top-down, every write landing on rows already read; a move
 * down copies bottom-up in chunks no taller than dy, so no chunk overwrites
 * a row not yet read. */
static esp_err_t copy_rows(pocket_display_esp_dpi *d, uint32_t y0, uint32_t y1,
                           int32_t dy) {
  const pocket_display_esp_dpi_config *c = &d->config;
  uint16_t *framebuffer = d->framebuffers[d->target];
  const size_t row_bytes = (size_t)c->panel_width * sizeof(uint16_t);
  const uint32_t chunk =
      dy > 0 && (uint32_t)dy < MOVE_ROWS ? (uint32_t)dy : MOVE_ROWS;
  esp_err_t result = ESP_OK;
  uint32_t queued = 0;
  for (uint32_t done = 0; done < y1 - y0 && result == ESP_OK;) {
    const uint32_t rows = y1 - y0 - done < chunk ? y1 - y0 - done : chunk;
    const uint32_t y = dy > 0 ? y1 - done - rows : y0 + done;
    if (queued == MOVE_BACKLOG) {
      xSemaphoreTake(d->moved, portMAX_DELAY);
      --queued;
    }
    result = esp_async_memcpy(c->move_copy,
                              framebuffer + (size_t)y * c->panel_width,
                              framebuffer + (size_t)(y - dy) * c->panel_width,
                              rows * row_bytes, on_copied, d->moved);
    if (result == ESP_OK)
      ++queued;
    done += rows;
  }
  for (; queued > 0U; --queued)
    xSemaphoreTake(d->moved, portMAX_DELAY);
  return result;
}
/* Move whole panel rows y0..y1 down by a short dy > 0, bottom-up in bands.
 * A band's source overlaps no band written before it, so each band is read
 * into a staging buffer and then written; the move channel reads the next
 * band while the present channel writes this one. */
static esp_err_t copy_rows_down(pocket_display_esp_dpi *d, uint32_t y0,
                                uint32_t y1, uint32_t dy) {
  const pocket_display_esp_dpi_config *c = &d->config;
  uint16_t *framebuffer = d->framebuffers[d->target];
  const size_t row_bytes = (size_t)c->panel_width * sizeof(uint16_t);
  const uint32_t band_rows = d->capacity / row_bytes;
  const uint32_t count = (y1 - y0 + band_rows - 1U) / band_rows;
  uint32_t reads = 0;
  uint32_t writes = 0;
  esp_err_t result = ESP_OK;
  for (uint32_t band = 0; band < count && result == ESP_OK; ++band) {
    const uint32_t top =
        y1 > (band + 1U) * band_rows + y0 ? y1 - (band + 1U) * band_rows : y0;
    const uint32_t rows = y1 - band * band_rows - top;
    uint16_t *strip = d->buffers[band & 1U].pixels;
    /* The buffer is free once the band two before it was written. */
    for (; writes + 2U <= band; ++writes)
      xSemaphoreTake(d->written, portMAX_DELAY);
    result = esp_async_memcpy(c->move_copy, strip,
                              framebuffer + (size_t)(top - dy) * c->panel_width,
                              rows * row_bytes, on_copied, d->moved);
    if (result != ESP_OK)
      break;
    ++reads;
    xSemaphoreTake(d->moved, portMAX_DELAY);
    result = esp_async_memcpy(c->copy ? c->copy : c->move_copy,
                              framebuffer + (size_t)top * c->panel_width,
                              strip, rows * row_bytes, on_copied, d->written);
    if (result != ESP_OK)
      break;
  }
  for (; writes < reads; ++writes)
    xSemaphoreTake(d->written, portMAX_DELAY);
  return result;
}
/* Synchronous 2D copy between the framebuffer and a staging buffer. */
static esp_err_t copy_block(pocket_display_esp_dpi *d, void *to,
                            uint32_t to_width, uint32_t to_height,
                            size_t to_bytes, uint32_t to_x, uint32_t to_y,
                            const void *from, uint32_t from_width,
                            uint32_t from_height, uint32_t from_x,
                            uint32_t from_y, uint32_t w, uint32_t h) {
  const ppa_srm_oper_config_t operation = {
      .in = {.buffer = from, .pic_w = from_width, .pic_h = from_height,
             .block_w = w, .block_h = h, .block_offset_x = from_x,
             .block_offset_y = from_y, .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
      .out = {.buffer = to, .buffer_size = to_bytes, .pic_w = to_width,
              .pic_h = to_height, .block_offset_x = to_x,
              .block_offset_y = to_y, .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
      .rotation_angle = PPA_SRM_ROTATION_ANGLE_0,
      .scale_x = 1.0f,
      .scale_y = 1.0f,
      .mode = PPA_TRANS_MODE_BLOCKING,
  };
  return ppa_do_scale_rotate_mirror(d->mover, &operation);
}
/* Move the picture pixels that land on `destination` from `destination`
 * offset by (-dx, -dy), in raster pixels. Whole panel rows moved up or down
 * go through the move channel; other blocks bounce through a staging buffer,
 * reading each band before writing it, in the order that keeps unread
 * source rows. */
static int32_t move(void *context, const pocket_rect *destination, int32_t dx,
                    int32_t dy) {
  pocket_display_esp_dpi *d = context;
  if (!d || !destination || destination->struct_size < sizeof(*destination) ||
      !d->config.move_copy || !destination->width || !destination->height ||
      destination->x > d->config.width - destination->width ||
      destination->y > d->config.height - destination->height ||
      (int64_t)destination->x - dx < 0 ||
      (int64_t)destination->x - dx + destination->width > d->config.width ||
      (int64_t)destination->y - dy < 0 ||
      (int64_t)destination->y - dy + destination->height > d->config.height)
    return POCKET_STATUS_INVALID;
  const pocket_display_esp_dpi_config *c = &d->config;
  const uint32_t unit = c->scale;
  const uint32_t sx0 = c->origin_x + destination->x * unit;
  const uint32_t sy0 = c->origin_y + destination->y * unit;
  uint32_t x0, y0, x1, y1;
  panel_rect(c, sx0, sy0, sx0 + destination->width * unit,
             sy0 + destination->height * unit, &x0, &y0, &x1, &y1);
  const int32_t screen_dx = dx * (int32_t)unit;
  const int32_t screen_dy = dy * (int32_t)unit;
  int32_t panel_dx = screen_dx;
  int32_t panel_dy = screen_dy;
  switch (quarter_turns(c)) {
  case 1U:
    panel_dx = screen_dy, panel_dy = -screen_dx;
    break;
  case 2U:
    panel_dx = -screen_dx, panel_dy = -screen_dy;
    break;
  case 3U:
    panel_dx = -screen_dy, panel_dy = screen_dx;
    break;
  default:
    break;
  }
  const bool panel_rows = x0 == 0U && x1 == c->panel_width && panel_dx == 0;
  /* A turned move that is not along panel rows (a vertical scroll of a
   * landscape picture) would bounce every band through a staging buffer
   * twice; repainting it costs less. */
  if (c->turned && !panel_rows)
    return POCKET_STATUS_UNSUPPORTED;
  if (!settle(d)) {
    d->unshown = false;
    new_generation(d);
    return POCKET_STATUS_FAILED;
  }
  uint16_t *framebuffer = d->framebuffers[d->target];
  esp_err_t result;
  if (panel_rows) {
    result = panel_dy < 0 || (uint32_t)panel_dy >= MIN_DIRECT_ROWS
                 ? copy_rows(d, y0, y1, panel_dy)
                 : copy_rows_down(d, y0, y1, (uint32_t)panel_dy);
  } else {
    uint16_t *band = d->buffers[0].pixels;
    const uint32_t w = x1 - x0;
    const uint32_t band_rows = d->capacity / (w * sizeof(uint16_t));
    const size_t frame_bytes =
        (size_t)c->panel_width * c->panel_height * sizeof(uint16_t);
    result = ESP_OK;
    for (uint32_t done = 0; done < y1 - y0 && result == ESP_OK;) {
      const uint32_t rows =
          y1 - y0 - done < band_rows ? y1 - y0 - done : band_rows;
      const uint32_t y = panel_dy > 0 ? y1 - done - rows : y0 + done;
      result = copy_block(d, band, w, rows, d->capacity, 0, 0, framebuffer,
                          c->panel_width, c->panel_height, x0 - panel_dx,
                          y - panel_dy, w, rows);
      if (result == ESP_OK)
        result = copy_block(d, framebuffer, c->panel_width, c->panel_height,
                            frame_bytes, x0, y, band, w, rows, 0, 0, w, rows);
      done += rows;
    }
  }
  if (result != ESP_OK) {
    d->unshown = false;
    new_generation(d);
    return POCKET_STATUS_FAILED;
  }
  d->unshown = d->framebuffer_count == 2U;
  /* The move carried the overlay's pixels along: repaint where they were
   * and where they landed. */
  if (d->overlay_set) {
    const uint32_t ox1 = d->overlay.x + d->overlay.size;
    const uint32_t oy1 = d->overlay.y + d->overlay.size;
    const uint32_t sx0 = destination->x > dx ? destination->x - dx : 0U;
    const uint32_t sy0 = destination->y > dy ? destination->y - dy : 0U;
    const bool in_destination =
        destination->x < ox1 && d->overlay.x < destination->x + destination->width &&
        destination->y < oy1 && d->overlay.y < destination->y + destination->height;
    const bool in_source = sx0 < ox1 && d->overlay.x < sx0 + destination->width &&
                           sy0 < oy1 && d->overlay.y < sy0 + destination->height;
    if (in_destination || in_source) {
      add_overlay_rect(d, d->target, 0, 0);
      add_overlay_rect(d, d->target, dx, dy);
    }
  }
  return POCKET_STATUS_OK;
}

static int32_t host_damage(void *context, pocket_rect *out, size_t capacity,
                           size_t *count) {
  pocket_display_esp_dpi *d = context;
  if (!d || !out || !count)
    return POCKET_STATUS_INVALID;
  const size_t pending = d->pending_count[d->target];
  const size_t n = pending < capacity ? pending : capacity;
  for (size_t i = 0; i < n; i++)
    out[i] = d->pending[d->target][i];
  *count = n;
  d->pending_count[d->target] = 0;
  return POCKET_STATUS_OK;
}
static const pocket_display_output_v1 DISPLAY = {.struct_size = sizeof(DISPLAY),
                                                 .descriptor = descriptor,
                                                 .acquire = acquire,
                                                 .flush = flush,
                                                 .wait = wait_display,
                                                 .frame_identity = identity,
                                                 .move_pixels = move,
                                                 .host_damage = host_damage};
const pocket_display_output_v1 *pocket_display_esp_dpi_vtable(void) {
  return &DISPLAY;
}
