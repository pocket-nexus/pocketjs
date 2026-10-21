#include "esp_heap_caps.h"
#include "pocket/display_esp_lcd.h"
#include <limits.h>
#include <stdlib.h>
#include <string.h>
typedef struct {
  uint8_t *pixels;
  bool pending, terminal;
  uint64_t token;
  pocket_rect region;
  pocket_surface surface;
} buffer;
struct pocket_display_esp_lcd {
  pocket_display_esp_lcd_config config;
  size_t capacity;
  uint32_t active;
  uint64_t next, generation;
  buffer buffers[2];
};
/* IDF's parameter transaction waits for all queued color transfers before
 * returning. A no-command/no-parameter transaction is the terminal barrier.
 * Failure to establish it is fatal: returning would release live DMA storage.
 */
static void terminal(pocket_display_esp_lcd *d) {
  ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(d->config.io, -1, NULL, 0));
  for (uint32_t i = 0; i < d->config.buffer_count; i++)
    if (d->buffers[i].pending)
      d->buffers[i].terminal = true;
}
pocket_display_esp_lcd *
pocket_display_esp_lcd_create(const pocket_display_esp_lcd_config *c) {
  if (!c || c->struct_size < sizeof(*c) || !c->panel || !c->io || !c->width ||
      !c->height || c->width > INT_MAX || c->height > INT_MAX ||
      !c->strip_rows || c->strip_rows > c->height || !c->buffer_count ||
      c->buffer_count > 2 ||
      c->width > SIZE_MAX / 2 / c->strip_rows / c->buffer_count)
    return NULL;
  size_t capacity = (size_t)c->width * c->strip_rows * 2;
  if (capacity * c->buffer_count > c->frame_buffer_budget)
    return NULL;
  pocket_display_esp_lcd *d = calloc(1, sizeof(*d));
  if (!d)
    return NULL;
  d->config = *c;
  d->capacity = capacity;
  d->active = UINT32_MAX;
  d->generation = 1;
  for (uint32_t i = 0; i < c->buffer_count; i++) {
    d->buffers[i].pixels = heap_caps_aligned_alloc(
        128, capacity, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    if (!d->buffers[i].pixels) {
      pocket_display_esp_lcd_destroy(d);
      return NULL;
    }
    memset(d->buffers[i].pixels, 0, capacity);
  }
  return d;
}
size_t pocket_display_esp_lcd_buffer_bytes(const pocket_display_esp_lcd *d) {
  return d ? d->capacity * d->config.buffer_count : 0;
}
void pocket_display_esp_lcd_invalidate(pocket_display_esp_lcd *d) {
  if (d) {
    terminal(d);
    if (d->generation == UINT64_MAX)
      abort();
    d->generation++;
  }
}
void pocket_display_esp_lcd_destroy(pocket_display_esp_lcd *d) {
  if (!d)
    return;
  bool pending = false;
  for (uint32_t i = 0; i < d->config.buffer_count; i++)
    pending |= d->buffers[i].pending;
  if (pending)
    terminal(d);
  for (uint32_t i = 0; i < d->config.buffer_count; i++)
    heap_caps_free(d->buffers[i].pixels);
  free(d);
}
static int32_t descriptor(void *context, pocket_display_descriptor *out) {
  pocket_display_esp_lcd *d = context;
  if (!d || !out || out->struct_size < sizeof(*out))
    return POCKET_STATUS_INVALID;
  *out = (pocket_display_descriptor){
      .struct_size = sizeof(*out),
      .role = POCKET_DISPLAY_ROLE_PRIMARY,
      .width = d->config.width,
      .height = d->config.height,
      .pixel_format = POCKET_PIXEL_FORMAT_RGB565,
      .stride_bytes = (size_t)d->config.width * 2,
      .target_kind = POCKET_TARGET_CPU_VISIBLE,
      .flags =
          POCKET_DISPLAY_FRAME_STORAGE | POCKET_DISPLAY_PARTIAL_REFRESH |
          (d->config.buffer_count == 2 ? POCKET_DISPLAY_DOUBLE_BUFFERED |
                                             POCKET_DISPLAY_PIPELINED_ACQUIRE
                                       : 0),
      .refresh_width = d->config.width,
      .refresh_height = 1,
      .window_x_alignment = d->config.width,
      .window_y_alignment = 1};
  return POCKET_STATUS_OK;
}
static int32_t acquire(void *context, const pocket_rect *region,
                       pocket_target *out) {
  pocket_display_esp_lcd *d = context;
  if (!d || !region || region->struct_size < sizeof(*region) || !out ||
      out->struct_size < sizeof(*out) || region->x ||
      region->width != d->config.width || !region->height ||
      region->height > d->config.strip_rows ||
      region->height > d->config.height ||
      region->y > d->config.height - region->height)
    return POCKET_STATUS_INVALID;
  /* An unflushed acquire has no DMA reader and can be replaced after a failed
   * render. */
  for (uint32_t i = 0; i < d->config.buffer_count; i++)
    if (!d->buffers[i].pending) {
      buffer *b = &d->buffers[i];
      d->active = i;
      b->region = *region;
      b->surface = (pocket_surface){.struct_size = sizeof(b->surface),
                                    .pixels = b->pixels,
                                    .byte_length = (size_t)d->config.width *
                                                   region->height * 2,
                                    .region = &b->region,
                                    .stride_bytes = (size_t)d->config.width * 2,
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
static int32_t flush(void *context, const pocket_rect *regions, size_t count,
                     uint64_t *token) {
  pocket_display_esp_lcd *d = context;
  if (!d || !regions || !count || !token ||
      d->active >= d->config.buffer_count || d->next == UINT64_MAX)
    return POCKET_STATUS_INVALID;
  buffer *b = &d->buffers[d->active];
  const pocket_rect *r = regions;
  uint32_t end = b->region.y;
  for (size_t i = 0; i < count; i++) {
    if (r->struct_size < sizeof(*r) || r->struct_size % _Alignof(pocket_rect) ||
        r->x || r->width != d->config.width || !r->height || r->y < end ||
        r->height > b->region.height ||
        r->y - b->region.y > b->region.height - r->height)
      return POCKET_STATUS_INVALID;
    end = r->y + r->height;
    r = (const pocket_rect *)((const uint8_t *)r + r->struct_size);
  }
  if (d->config.byte_swap)
    for (size_t i = 0; i < b->surface.byte_length; i += 2) {
      uint8_t a = b->pixels[i];
      b->pixels[i] = b->pixels[i + 1];
      b->pixels[i + 1] = a;
    }
  r = regions;
  for (size_t i = 0; i < count; i++) {
    uint8_t *pixels =
        b->pixels + (size_t)(r->y - b->region.y) * d->config.width * 2;
    if (esp_lcd_panel_draw_bitmap(d->config.panel, 0, (int)r->y, (int)r->width,
                                  (int)(r->y + r->height), pixels) != ESP_OK) {
      terminal(d);
      d->active = UINT32_MAX;
      if (d->generation == UINT64_MAX)
        abort();
      d->generation++;
      return POCKET_STATUS_FAILED;
    }
    r = (const pocket_rect *)((const uint8_t *)r + r->struct_size);
  }
  b->pending = true;
  b->terminal = false;
  *token = b->token = ++d->next;
  d->active = UINT32_MAX;
  return POCKET_STATUS_OK;
}
static int32_t wait_display(void *context, uint64_t token) {
  pocket_display_esp_lcd *d = context;
  if (!d)
    return POCKET_STATUS_INVALID;
  for (uint32_t i = 0; i < d->config.buffer_count; i++) {
    buffer *b = &d->buffers[i];
    if (b->pending && b->token == token) {
      if (!b->terminal)
        terminal(d);
      b->pending = false;
      return POCKET_STATUS_OK;
    }
  }
  return POCKET_STATUS_INVALID;
}
static int32_t identity(void *context, pocket_buffer_identity *out) {
  pocket_display_esp_lcd *d = context;
  if (!d || !out || out->struct_size < sizeof(*out))
    return POCKET_STATUS_INVALID;
  *out = (pocket_buffer_identity){
      .struct_size = sizeof(*out), .buffer = 1, .generation = d->generation};
  return POCKET_STATUS_OK;
}
static const pocket_display_output_v1 DISPLAY = {.struct_size = sizeof(DISPLAY),
                                                 .descriptor = descriptor,
                                                 .acquire = acquire,
                                                 .flush = flush,
                                                 .wait = wait_display,
                                                 .frame_identity = identity};
const pocket_display_output_v1 *pocket_display_esp_lcd_vtable(void) {
  return &DISPLAY;
}
