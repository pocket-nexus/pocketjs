#include "pocketjs_ppa.h"
#include "pocketjs/esp32p4_ppa_status.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#include "driver/ppa.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#if __has_include("esp_private/esp_cache_private.h")
#include "esp_private/esp_cache_private.h"
#define POCKETJS_PPA_HAS_CACHE_ALIGNMENT 1
#endif

static const char *TAG = "pocketjs_ppa";

struct pocketjs_ppa_context {
  ppa_client_handle_t fill;
  ppa_client_handle_t blend;
  ppa_client_handle_t srm;
  bool fill_error_logged;
  bool blend_error_logged;
  bool srm_error_logged;
};

static bool surface_is_valid(const void *buffer, size_t pixels, uint32_t width,
                             uint32_t height, size_t bytes_per_pixel) {
  if (buffer == NULL || width == 0 || height == 0 || bytes_per_pixel == 0) {
    return false;
  }
  return (size_t)width <= SIZE_MAX / (size_t)height &&
         pixels == (size_t)width * (size_t)height &&
         pixels <= SIZE_MAX / bytes_per_pixel;
}

static bool rect_is_valid(uint32_t surface_width, uint32_t surface_height,
                          uint32_t x, uint32_t y, uint32_t width,
                          uint32_t height) {
  return width > 0 && height > 0 && x <= surface_width && y <= surface_height &&
         width <= surface_width - x && height <= surface_height - y;
}

static bool byte_ranges_overlap(const void *first, size_t first_size,
                                const void *second, size_t second_size) {
  const uintptr_t first_start = (uintptr_t)first;
  const uintptr_t second_start = (uintptr_t)second;
  if (first_size > UINTPTR_MAX - first_start ||
      second_size > UINTPTR_MAX - second_start) {
    return true;
  }
  const uintptr_t first_end = first_start + first_size;
  const uintptr_t second_end = second_start + second_size;
  return first_start < second_end && second_start < first_end;
}

static color_pixel_argb8888_data_t rgb565_to_argb8888(uint16_t color) {
  const uint8_t red5 = (uint8_t)((color >> 11) & 0x1FU);
  const uint8_t green6 = (uint8_t)((color >> 5) & 0x3FU);
  const uint8_t blue5 = (uint8_t)(color & 0x1FU);
  const color_pixel_argb8888_data_t expanded = {
      .r = (uint8_t)((red5 << 3) | (red5 >> 2)),
      .g = (uint8_t)((green6 << 2) | (green6 >> 4)),
      .b = (uint8_t)((blue5 << 3) | (blue5 >> 2)),
      .a = UINT8_MAX,
  };
  return expanded;
}

/* Blocking ppa_do_* calls validate their arguments and queue the DMA2D
 * transaction before any destination write. A rejected call leaves the
 * destination unchanged, so the renderer draws that operation in software. */
static int decline_operation(const char *operation, esp_err_t error,
                             bool *already_logged) {
  if (!*already_logged) {
    ESP_LOGW(TAG, "PPA %s rejected (%s); drawing it in software", operation,
             esp_err_to_name(error));
    *already_logged = true;
  }
  return POCKET_STATUS_UNSUPPORTED;
}

static esp_err_t register_client(ppa_operation_t operation,
                                 ppa_client_handle_t *out_client) {
  const ppa_client_config_t config = {
      .oper_type = operation,
      .max_pending_trans_num = 1,
      .data_burst_length = PPA_DATA_BURST_LENGTH_128,
  };
  return ppa_register_client(&config, out_client);
}

esp_err_t pocketjs_ppa_create(pocketjs_ppa_handle_t *out_handle) {
  if (out_handle == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  *out_handle = NULL;

  pocketjs_ppa_handle_t handle = calloc(1, sizeof(*handle));
  if (handle == NULL) {
    return ESP_ERR_NO_MEM;
  }

  esp_err_t result = register_client(PPA_OPERATION_FILL, &handle->fill);
  if (result == ESP_OK) {
    result = register_client(PPA_OPERATION_BLEND, &handle->blend);
  }
  if (result == ESP_OK) {
    result = register_client(PPA_OPERATION_SRM, &handle->srm);
  }
  if (result != ESP_OK) {
    ESP_LOGE(TAG, "failed to register PocketJS PPA clients: %s",
             esp_err_to_name(result));
    pocketjs_ppa_destroy(handle);
    return result;
  }

  *out_handle = handle;
  ESP_LOGI(TAG, "RGB565 backend ready: FILL + A8 BLEND + SRM");
  return ESP_OK;
}

void pocketjs_ppa_destroy(pocketjs_ppa_handle_t handle) {
  if (handle == NULL) {
    return;
  }
  if (handle->srm != NULL) {
    (void)ppa_unregister_client(handle->srm);
  }
  if (handle->blend != NULL) {
    (void)ppa_unregister_client(handle->blend);
  }
  if (handle->fill != NULL) {
    (void)ppa_unregister_client(handle->fill);
  }
  free(handle);
}

size_t pocketjs_ppa_buffer_alignment(void) {
#ifdef POCKETJS_PPA_HAS_CACHE_ALIGNMENT
  size_t alignment = 0;
  if (esp_cache_get_alignment(MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA,
                              &alignment) == ESP_OK &&
      alignment > 0) {
    return alignment;
  }
#endif
  return 64;
}

int pocketjs_ppa_fill_rgb565(pocketjs_ppa_handle_t handle,
                             uint16_t *destination, size_t destination_pixels,
                             uint32_t width, uint32_t height, uint32_t x,
                             uint32_t y, uint32_t rect_width,
                             uint32_t rect_height, uint16_t color) {
  if (handle == NULL || handle->fill == NULL ||
      !surface_is_valid(destination, destination_pixels, width, height,
                        sizeof(*destination)) ||
      !rect_is_valid(width, height, x, y, rect_width, rect_height)) {
    return POCKET_STATUS_UNSUPPORTED;
  }

  const ppa_fill_oper_config_t operation = {
      .out =
          {
              .buffer = destination,
              .buffer_size = destination_pixels * sizeof(*destination),
              .pic_w = width,
              .pic_h = height,
              .block_offset_x = x,
              .block_offset_y = y,
              .fill_cm = PPA_FILL_COLOR_MODE_RGB565,
          },
      .fill_block_w = rect_width,
      .fill_block_h = rect_height,
      // The fixed fill pixel is supplied as ARGB components even when the
      // output mode is RGB565. A packed RGB565 word produces wrong colors.
      .fill_argb_color = rgb565_to_argb8888(color),
      .mode = PPA_TRANS_MODE_BLOCKING,
  };
  const esp_err_t result = ppa_do_fill(handle->fill, &operation);
  if (result != ESP_OK) {
    return decline_operation("fill", result, &handle->fill_error_logged);
  }
  return POCKET_STATUS_OK;
}

int pocketjs_ppa_blend_a8_rgb565(pocketjs_ppa_handle_t handle,
                                 uint16_t *destination,
                                 size_t destination_pixels, uint32_t width,
                                 uint32_t height, const uint8_t *mask,
                                 size_t mask_len, uint32_t x, uint32_t y,
                                 uint32_t rect_width, uint32_t rect_height,
                                 uint8_t red, uint8_t green, uint8_t blue,
                                 uint8_t global_alpha) {
  if (global_alpha == 0) {
    return POCKET_STATUS_OK;
  }
  if (handle == NULL || handle->blend == NULL ||
      !surface_is_valid(destination, destination_pixels, width, height,
                        sizeof(*destination)) ||
      !surface_is_valid(mask, mask_len, width, height, sizeof(*mask)) ||
      !rect_is_valid(width, height, x, y, rect_width, rect_height)) {
    return POCKET_STATUS_UNSUPPORTED;
  }

  ppa_blend_oper_config_t operation = {
      .in_bg =
          {
              .buffer = destination,
              .pic_w = width,
              .pic_h = height,
              .block_w = rect_width,
              .block_h = rect_height,
              .block_offset_x = x,
              .block_offset_y = y,
              .blend_cm = PPA_BLEND_COLOR_MODE_RGB565,
          },
      .in_fg =
          {
              .buffer = mask,
              .pic_w = width,
              .pic_h = height,
              .block_w = rect_width,
              .block_h = rect_height,
              .block_offset_x = x,
              .block_offset_y = y,
              .blend_cm = PPA_BLEND_COLOR_MODE_A8,
          },
      .out =
          {
              .buffer = destination,
              .buffer_size = destination_pixels * sizeof(*destination),
              .pic_w = width,
              .pic_h = height,
              .block_offset_x = x,
              .block_offset_y = y,
              .blend_cm = PPA_BLEND_COLOR_MODE_RGB565,
          },
      .bg_alpha_update_mode = PPA_ALPHA_NO_CHANGE,
      .fg_alpha_update_mode = PPA_ALPHA_NO_CHANGE,
      .fg_fix_rgb_val =
          {
              .r = red,
              .g = green,
              .b = blue,
          },
      .mode = PPA_TRANS_MODE_BLOCKING,
  };
  if (global_alpha < UINT8_MAX) {
    const uint32_t fixed_alpha = ((uint32_t)global_alpha * 256U + 127U) / 255U;
    operation.fg_alpha_update_mode = PPA_ALPHA_SCALE;
    operation.fg_alpha_scale_ratio = (float)fixed_alpha / 256.0f;
  }

  const esp_err_t result = ppa_do_blend(handle->blend, &operation);
  if (result != ESP_OK) {
    return decline_operation("blend", result, &handle->blend_error_logged);
  }
  return POCKET_STATUS_OK;
}

static bool exact_scale(uint32_t source_extent, uint32_t destination_extent,
                        float *out_scale) {
  if (source_extent == 0 || destination_extent > UINT32_MAX / 16U) {
    return false;
  }
  const uint32_t sixteenths_numerator = destination_extent * 16U;
  if ((sixteenths_numerator % source_extent) != 0) {
    return false;
  }
  const uint32_t sixteenths = sixteenths_numerator / source_extent;
  if (sixteenths == 0 || sixteenths >= 256U * 16U) {
    return false;
  }
  *out_scale = (float)sixteenths / 16.0f;
  return true;
}

int pocketjs_ppa_srm_psm5650_rgb565(
    pocketjs_ppa_handle_t handle, uint16_t *destination,
    size_t destination_pixels, uint32_t width, uint32_t height,
    const uint8_t *source, size_t source_len, uint32_t source_width,
    uint32_t source_height, uint32_t source_x, uint32_t source_y,
    uint32_t source_rect_width, uint32_t source_rect_height,
    uint32_t destination_x, uint32_t destination_y,
    uint32_t destination_rect_width, uint32_t destination_rect_height,
    uint32_t quarter_turn, int mirror_x, int mirror_y) {
  if (handle == NULL || handle->srm == NULL ||
      !surface_is_valid(destination, destination_pixels, width, height,
                        sizeof(*destination)) ||
      source == NULL || source_width == 0 || source_height == 0 ||
      (size_t)source_width > SIZE_MAX / (size_t)source_height ||
      (size_t)source_width * (size_t)source_height > SIZE_MAX / 2U) {
    return POCKET_STATUS_UNSUPPORTED;
  }

  const size_t source_required =
      (size_t)source_width * (size_t)source_height * 2U;
  const size_t destination_size = destination_pixels * sizeof(*destination);
  if (source_len < source_required ||
      byte_ranges_overlap(source, source_required, destination,
                          destination_size) ||
      !rect_is_valid(source_width, source_height, source_x, source_y,
                     source_rect_width, source_rect_height) ||
      !rect_is_valid(width, height, destination_x, destination_y,
                     destination_rect_width, destination_rect_height) ||
      quarter_turn > 3U) {
    return POCKET_STATUS_UNSUPPORTED;
  }

  const bool swaps_axes = quarter_turn == 1U || quarter_turn == 3U;
  const uint32_t scaled_width =
      swaps_axes ? destination_rect_height : destination_rect_width;
  const uint32_t scaled_height =
      swaps_axes ? destination_rect_width : destination_rect_height;
  float scale_x = 0.0f;
  float scale_y = 0.0f;
  if (!exact_scale(source_rect_width, scaled_width, &scale_x) ||
      !exact_scale(source_rect_height, scaled_height, &scale_y)) {
    return POCKET_STATUS_UNSUPPORTED;
  }

  const ppa_srm_rotation_angle_t rotations[] = {
      PPA_SRM_ROTATION_ANGLE_0,
      PPA_SRM_ROTATION_ANGLE_90,
      PPA_SRM_ROTATION_ANGLE_180,
      PPA_SRM_ROTATION_ANGLE_270,
  };
  const ppa_srm_oper_config_t operation = {
      .in =
          {
              .buffer = source,
              .pic_w = source_width,
              .pic_h = source_height,
              .block_w = source_rect_width,
              .block_h = source_rect_height,
              .block_offset_x = source_x,
              .block_offset_y = source_y,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565,
          },
      .out =
          {
              .buffer = destination,
              .buffer_size = destination_size,
              .pic_w = width,
              .pic_h = height,
              .block_offset_x = destination_x,
              .block_offset_y = destination_y,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565,
          },
      .rotation_angle = rotations[quarter_turn],
      .scale_x = scale_x,
      .scale_y = scale_y,
      .mirror_x = mirror_x != 0,
      .mirror_y = mirror_y != 0,
      .rgb_swap = true,
      .byte_swap = false,
      .alpha_update_mode = PPA_ALPHA_NO_CHANGE,
      .mode = PPA_TRANS_MODE_BLOCKING,
  };
  const esp_err_t result = ppa_do_scale_rotate_mirror(handle->srm, &operation);
  if (result != ESP_OK) {
    return decline_operation("SRM", result, &handle->srm_error_logged);
  }
  return POCKET_STATUS_OK;
}
