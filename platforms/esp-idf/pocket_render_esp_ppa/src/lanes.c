#include "pocketjs/esp32p4_ppa_lanes.h"

#include <stdbool.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

/* The helper's stack holds the renderer's frames only; the raster state
 * lives on the heap. */
#define HELPER_STACK_BYTES (16U * 1024U)

typedef struct {
  pocket_render_esp_ppa *renderer;
  uint64_t submission;
  int32_t status;
  bool used;
} lane_t;

struct pocketjs_esp32p4_ppa_lanes {
  lane_t lanes[2];
  uint32_t row_alignment;
  uint64_t next;
  TaskHandle_t helper;
  SemaphoreHandle_t start;
  SemaphoreHandle_t done;
  /* The lower half's frame while the helper renders it. */
  pocket_frame_input frame;
  pocket_target target;
  pocket_surface surface;
  pocket_rect region;
  bool stopping;
};

static const pocket_renderer_v1 *ppa(void) {
  return pocket_render_esp_ppa_vtable();
}

static void helper_task(void *context) {
  pocketjs_esp32p4_ppa_lanes_t *lanes = context;
  for (;;) {
    xSemaphoreTake(lanes->start, portMAX_DELAY);
    if (lanes->stopping)
      break;
    lane_t *lane = &lanes->lanes[1];
    lane->status = ppa()->render(lane->renderer, &lanes->frame,
                                 &lane->submission);
    xSemaphoreGive(lanes->done);
  }
  xSemaphoreGive(lanes->done);
  vTaskDelete(NULL);
}

esp_err_t pocketjs_esp32p4_ppa_lanes_create(pocket_render_esp_ppa *upper,
                                            pocket_render_esp_ppa *lower,
                                            int helper_core,
                                            uint32_t row_alignment,
                                            pocketjs_esp32p4_ppa_lanes_t **out) {
  if (!upper || !lower || upper == lower || !row_alignment || !out)
    return ESP_ERR_INVALID_ARG;
  *out = NULL;
  pocketjs_esp32p4_ppa_lanes_t *lanes = calloc(1, sizeof(*lanes));
  if (!lanes)
    return ESP_ERR_NO_MEM;
  lanes->lanes[0].renderer = upper;
  lanes->lanes[1].renderer = lower;
  lanes->row_alignment = row_alignment;
  lanes->start = xSemaphoreCreateBinary();
  lanes->done = xSemaphoreCreateBinary();
  if (!lanes->start || !lanes->done ||
      xTaskCreatePinnedToCore(helper_task, "pocketjs_lane", HELPER_STACK_BYTES,
                              lanes, 5, &lanes->helper,
                              helper_core) != pdPASS) {
    if (lanes->start)
      vSemaphoreDelete(lanes->start);
    if (lanes->done)
      vSemaphoreDelete(lanes->done);
    free(lanes);
    return ESP_ERR_NO_MEM;
  }
  *out = lanes;
  return ESP_OK;
}

void pocketjs_esp32p4_ppa_lanes_destroy(pocketjs_esp32p4_ppa_lanes_t *lanes) {
  if (!lanes)
    return;
  lanes->stopping = true;
  xSemaphoreGive(lanes->start);
  xSemaphoreTake(lanes->done, portMAX_DELAY);
  vSemaphoreDelete(lanes->start);
  vSemaphoreDelete(lanes->done);
  free(lanes);
}

static int32_t descriptor(void *context, pocket_renderer_descriptor *out) {
  pocketjs_esp32p4_ppa_lanes_t *lanes = context;
  if (!lanes)
    return POCKET_STATUS_INVALID;
  return ppa()->descriptor(lanes->lanes[0].renderer, out);
}

/* Damaged raster rows of `region`, as [*top, *bottom). False when no damage
 * record reaches it. */
static bool damaged_rows(const pocket_frame_input *frame,
                         const pocket_rect *region, uint32_t *top,
                         uint32_t *bottom) {
  if (!frame->damage_count) {
    *top = region->y;
    *bottom = region->y + region->height;
    return true;
  }
  uint32_t first = UINT32_MAX;
  uint32_t last = 0;
  const pocket_rect *rect = frame->damage;
  for (size_t i = 0; i < frame->damage_count; i++) {
    const uint32_t y0 = rect->y > region->y ? rect->y : region->y;
    const uint32_t y1 = rect->y + rect->height < region->y + region->height
                            ? rect->y + rect->height
                            : region->y + region->height;
    if (rect->width && y0 < y1) {
      first = y0 < first ? y0 : first;
      last = y1 > last ? y1 : last;
    }
    rect = (const pocket_rect *)((const uint8_t *)rect + rect->struct_size);
  }
  *top = first;
  *bottom = last;
  return first < last;
}

static int32_t render(void *context, const pocket_frame_input *frame,
                      uint64_t *submission) {
  pocketjs_esp32p4_ppa_lanes_t *lanes = context;
  if (!lanes || !frame || !submission || !frame->target ||
      frame->target->kind != POCKET_TARGET_CPU_VISIBLE ||
      !frame->target->surface || !frame->target->region ||
      lanes->next == UINT64_MAX)
    return POCKET_STATUS_INVALID;
  lane_t *upper = &lanes->lanes[0];
  lane_t *lower = &lanes->lanes[1];
  upper->used = false;
  lower->used = false;
  const pocket_rect *region = frame->target->region;
  const pocket_surface *surface = frame->target->surface;
  uint32_t top = 0;
  uint32_t bottom = 0;
  const uint32_t step = lanes->row_alignment;
  uint32_t split = 0;
  if (damaged_rows(frame, region, &top, &bottom)) {
    /* Halve the damaged rows; a split at a strip edge renders on one lane. */
    split = region->y +
            ((top + bottom) / 2U - region->y + step / 2U) / step * step;
    if (split <= top || split >= bottom)
      split = 0;
  }
  if (!split) {
    upper->used = true;
    const int32_t status =
        ppa()->render(upper->renderer, frame, &upper->submission);
    if (status != POCKET_STATUS_OK) {
      upper->used = false;
      return status;
    }
    *submission = ++lanes->next;
    return POCKET_STATUS_OK;
  }
  const uint32_t upper_rows = split - region->y;
  const size_t upper_bytes = (size_t)upper_rows * surface->stride_bytes;
  lanes->region = (pocket_rect){.struct_size = sizeof(pocket_rect),
                                .x = region->x,
                                .y = split,
                                .width = region->width,
                                .height = region->height - upper_rows};
  lanes->surface = *surface;
  lanes->surface.pixels = surface->pixels + upper_bytes;
  lanes->surface.byte_length = surface->byte_length - upper_bytes;
  lanes->surface.region = &lanes->region;
  lanes->target = *frame->target;
  lanes->target.region = &lanes->region;
  lanes->target.surface = &lanes->surface;
  lanes->frame = *frame;
  lanes->frame.target = &lanes->target;
  xSemaphoreGive(lanes->start);

  pocket_rect upper_region = *region;
  upper_region.height = upper_rows;
  pocket_surface upper_surface = *surface;
  upper_surface.byte_length = upper_bytes;
  upper_surface.region = &upper_region;
  pocket_target upper_target = *frame->target;
  upper_target.region = &upper_region;
  upper_target.surface = &upper_surface;
  pocket_frame_input upper_frame = *frame;
  upper_frame.target = &upper_target;
  const int32_t status =
      ppa()->render(upper->renderer, &upper_frame, &upper->submission);
  xSemaphoreTake(lanes->done, portMAX_DELAY);
  upper->used = status == POCKET_STATUS_OK;
  lower->used = lower->status == POCKET_STATUS_OK;
  if (status != POCKET_STATUS_OK || lower->status != POCKET_STATUS_OK) {
    for (size_t i = 0; i < 2U; i++) {
      if (lanes->lanes[i].used)
        ppa()->retire(lanes->lanes[i].renderer, lanes->lanes[i].submission);
      lanes->lanes[i].used = false;
    }
    return status != POCKET_STATUS_OK ? status : lower->status;
  }
  *submission = ++lanes->next;
  return POCKET_STATUS_OK;
}

/* Both renderers finish before render returns: waits only check the token. */
static int32_t wait(void *context, uint64_t submission) {
  pocketjs_esp32p4_ppa_lanes_t *lanes = context;
  if (!lanes || submission != lanes->next)
    return POCKET_STATUS_INVALID;
  for (size_t i = 0; i < 2U; i++) {
    lane_t *lane = &lanes->lanes[i];
    if (lane->used) {
      const int32_t status = ppa()->wait(lane->renderer, lane->submission);
      if (status != POCKET_STATUS_OK)
        return status;
    }
  }
  return POCKET_STATUS_OK;
}

static void retire(void *context, uint64_t submission) {
  pocketjs_esp32p4_ppa_lanes_t *lanes = context;
  if (!lanes || submission != lanes->next)
    return;
  for (size_t i = 0; i < 2U; i++) {
    lane_t *lane = &lanes->lanes[i];
    if (lane->used)
      ppa()->retire(lane->renderer, lane->submission);
    lane->used = false;
  }
}

static const pocket_renderer_v1 LANES = {.struct_size = sizeof(LANES),
                                         .descriptor = descriptor,
                                         .render = render,
                                         .wait = wait,
                                         .retire = retire};

const pocket_renderer_v1 *pocketjs_esp32p4_ppa_lanes_vtable(void) {
  return &LANES;
}
