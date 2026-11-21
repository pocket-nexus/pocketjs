#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct pocketjs_ppa_context *pocketjs_ppa_handle_t;

/**
 * Register one blocking FILL, BLEND, and SRM client for a renderer.
 *
 * ESP-IDF recommends that each task own its clients. The returned handle must
 * therefore be used and destroyed by the same rendering task.
 */
esp_err_t pocketjs_ppa_create(pocketjs_ppa_handle_t *out_handle);

/**
 * Unregister all clients and release the handle. A NULL handle is accepted.
 */
void pocketjs_ppa_destroy(pocketjs_ppa_handle_t handle);

/**
 * Alignment the PPA driver requires of an output buffer address and byte
 * length: the internal DMA data cache line, or 64 bytes when IDF cannot
 * report it.
 */
size_t pocketjs_ppa_buffer_alignment(void);

/**
 * The component's public accelerator wrapper consumes this private C ABI.
 * Each function returns POCKET_STATUS_OK after a completed transaction or
 * UNSUPPORTED before any write. A transaction the IDF driver rejects is
 * UNSUPPORTED as well: blocking ppa_do_* calls stop before their first
 * destination write, so the renderer draws that operation in software.
 */
int pocketjs_ppa_fill_rgb565(pocketjs_ppa_handle_t handle,
                             uint16_t *destination, size_t destination_pixels,
                             uint32_t width, uint32_t height, uint32_t x,
                             uint32_t y, uint32_t rect_width,
                             uint32_t rect_height, uint16_t color);

int pocketjs_ppa_blend_a8_rgb565(pocketjs_ppa_handle_t handle,
                                 uint16_t *destination,
                                 size_t destination_pixels, uint32_t width,
                                 uint32_t height, const uint8_t *mask,
                                 size_t mask_len, uint32_t x, uint32_t y,
                                 uint32_t rect_width, uint32_t rect_height,
                                 uint8_t red, uint8_t green, uint8_t blue,
                                 uint8_t global_alpha);

int pocketjs_ppa_srm_psm5650_rgb565(
    pocketjs_ppa_handle_t handle, uint16_t *destination,
    size_t destination_pixels, uint32_t width, uint32_t height,
    const uint8_t *source, size_t source_len, uint32_t source_width,
    uint32_t source_height, uint32_t source_x, uint32_t source_y,
    uint32_t source_rect_width, uint32_t source_rect_height,
    uint32_t destination_x, uint32_t destination_y,
    uint32_t destination_rect_width, uint32_t destination_rect_height,
    uint32_t quarter_turn, int mirror_x, int mirror_y);

#ifdef __cplusplus
}
#endif
