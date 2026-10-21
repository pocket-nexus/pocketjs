#include "sample_io.h"
#include "esp_heap_caps.h"
#include <string.h>
int32_t sample_display_init(sample_display *out, uint32_t width,
                            uint32_t height, uint32_t rows, uint32_t count) {
  if (!out || !width || !height || !rows || rows > height || !count ||
      count > 2 || width > SIZE_MAX / 2 / rows)
    return POCKET_STATUS_INVALID;
  memset(out, 0, sizeof(*out));
  out->width = width;
  out->height = height;
  out->rows = rows;
  out->count = count;
  out->active = UINT32_MAX;
  out->capacity = (size_t)width * rows * 2;
  for (uint32_t i = 0; i < count; i++) {
    out->buffers[i].pixels = heap_caps_aligned_alloc(
        128, out->capacity, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    if (!out->buffers[i].pixels) {
      sample_display_destroy(out);
      return POCKET_STATUS_FAILED;
    }
  }
  return POCKET_STATUS_OK;
}
void sample_display_destroy(sample_display *out) {
  if (out)
    for (uint32_t i = 0; i < out->count; i++) {
      heap_caps_free(out->buffers[i].pixels);
      out->buffers[i].pixels = NULL;
    }
}
static int32_t descriptor(void *context, pocket_display_descriptor *out) {
  sample_display *d = context;
  if (!d || !out)
    return POCKET_STATUS_INVALID;
  *out = (pocket_display_descriptor){
      .struct_size = sizeof(*out),
      .role = POCKET_DISPLAY_ROLE_PRIMARY,
      .width = d->width,
      .height = d->height,
      .pixel_format = POCKET_PIXEL_FORMAT_RGB565,
      .stride_bytes = (size_t)d->width * 2,
      .target_kind = POCKET_TARGET_CPU_VISIBLE,
      .flags = POCKET_DISPLAY_FRAME_STORAGE | POCKET_DISPLAY_PARTIAL_REFRESH |
               (d->count == 2 ? POCKET_DISPLAY_DOUBLE_BUFFERED |
                                    POCKET_DISPLAY_PIPELINED_ACQUIRE
                              : 0),
      .refresh_width = 1,
      .refresh_height = 1,
      .window_x_alignment = 1,
      .window_y_alignment = 1};
  return POCKET_STATUS_OK;
}
static int32_t acquire(void *context, const pocket_rect *region,
                       pocket_target *out) {
  sample_display *d = context;
  if (!d || !region || !out || region->x || region->width != d->width ||
      !region->height || region->height > d->rows ||
      region->y > d->height - region->height)
    return POCKET_STATUS_INVALID;
  for (uint32_t i = 0; i < d->count; i++)
    if (!d->buffers[i].pending) {
      sample_buffer *b = &d->buffers[i];
      d->active = i;
      b->region = *region;
      b->surface =
          (pocket_surface){.struct_size = sizeof(b->surface),
                           .pixels = b->pixels,
                           .byte_length = (size_t)d->width * region->height * 2,
                           .region = &b->region,
                           .stride_bytes = (size_t)d->width * 2,
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
  sample_display *d = context;
  if (!d || !regions || count != 1 || !token || d->active >= d->count ||
      d->next == UINT64_MAX)
    return POCKET_STATUS_INVALID;
  sample_buffer *b = &d->buffers[d->active];
  if (!b->region.y)
    d->hash = UINT64_C(0xcbf29ce484222325);
  for (size_t i = 0; i < b->surface.byte_length; i++)
    d->hash = (d->hash ^ b->pixels[i]) * UINT64_C(0x100000001b3);
  b->pending = true;
  *token = b->token = ++d->next;
  d->active = UINT32_MAX;
  d->flushes++;
  return POCKET_STATUS_OK;
}
static int32_t wait(void *context, uint64_t token) {
  sample_display *d = context;
  if (!d)
    return POCKET_STATUS_INVALID;
  for (uint32_t i = 0; i < d->count; i++)
    if (d->buffers[i].pending && d->buffers[i].token == token) {
      d->buffers[i].pending = false;
      d->waits++;
      return POCKET_STATUS_OK;
    }
  return POCKET_STATUS_INVALID;
}
static int32_t identity(void *context, pocket_buffer_identity *out) {
  if (!context || !out)
    return POCKET_STATUS_INVALID;
  *out = (pocket_buffer_identity){
      .struct_size = sizeof(*out), .buffer = 1, .generation = 1};
  return POCKET_STATUS_OK;
}
static const pocket_display_output_v1 DISPLAY = {.struct_size = sizeof(DISPLAY),
                                                 .descriptor = descriptor,
                                                 .acquire = acquire,
                                                 .flush = flush,
                                                 .wait = wait,
                                                 .frame_identity = identity};
const pocket_display_output_v1 *sample_display_vtable(void) { return &DISPLAY; }
static uint32_t classes(void *context) {
  (void)context;
  return POCKET_INPUT_CLASS_BUTTONS;
}
static int32_t poll(void *context, pocket_input_frame_builder *builder) {
  (void)context;
  pocket_input_frame input = {.struct_size = sizeof(input)};
  return builder->append(builder->context, &input);
}
static const pocket_input_source_v1 INPUT = {sizeof(INPUT), classes, poll};
const pocket_input_source_v1 *sample_input_vtable(void) { return &INPUT; }
