/*
 * Board-facing hooks for the RT-Thread / Edgi-Talk PocketJS host loop.
 *
 * Product firmware (overlay) provides strong definitions. Weak stubs in
 * pocketjs_host_loop.c return -RT_ENOSYS / empty so the host links alone for
 * bring-up tests. See native/README.md.
 *
 * Ported/adapted from PocketJS_for_Edgi-Talk/.../applications/pocketjs/pocketjs_app.c
 * board-specific pieces (LCD, ST7102 touch, product guest installs).
 */
#pragma once

#include <rtthread.h>
#include <stdbool.h>
#include <stdint.h>

#include "pocketjs/guest.h"
#include "pocketjs/package.h"
#include "pocketjs/ui_qjs.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint16_t *framebuffer; /* RGB565, pitch == width * 2 */
    uint32_t width;
    uint32_t height;
    void *opaque; /* optional product LCD device handle */
} pocketjs_board_display_t;

/**
 * Open / query the RGB565 framebuffer. Product typically finds "lcd" and
 * RTGRAPHIC_CTRL_GET_INFO.
 */
rt_err_t pocketjs_board_open_display(pocketjs_board_display_t *out);

/** True when the LCD driver can stage/commit dirty rectangles. */
rt_bool_t pocketjs_board_rect_present_supported(void);

rt_bool_t pocketjs_board_stage_rect_rgb565(uint32_t x, uint32_t y,
                                           uint32_t width, uint32_t height);

rt_bool_t pocketjs_board_commit_rect_rgb565(void);

/** Full-frame present fallback (e.g. RTGRAPHIC_CTRL_RECT_UPDATE). */
rt_err_t pocketjs_board_full_present(void *opaque);

/**
 * Sample one contact into *contact and set input->touches / touch_count.
 * No-op is fine (headless / no touch). Coordinates are logical viewport space.
 */
void pocketjs_board_sample_touch(pocketjs_ui_input_t *input,
                                 pocketjs_ui_touch_t *contact,
                                 uint32_t logical_width,
                                 uint32_t logical_height);

/** Embedded .pocket bytes + host contract (from generated package pattern). */
const pocketjs_embedded_package_t *pocketjs_board_embedded_package(void);
const pocketjs_package_host_contract_t *pocketjs_board_host_contract(void);
/** End symbol for size = end - data when size field is stale; may be NULL. */
const uint8_t *pocketjs_board_embedded_package_end(void);
const char *pocketjs_board_guest_script_name(void);

/**
 * Optional product guest installs (__edgi / dashboard / music / game).
 * Default weak stub returns ESP_OK and does nothing.
 */
esp_err_t pocketjs_board_install_guest_hooks(pocketjs_guest_t *guest);

/** Called after each successful present (e.g. dashboard frame counter). */
void pocketjs_board_on_frame(void);

/** When true, periodic frame stats kprintf is suppressed (e.g. game running). */
rt_bool_t pocketjs_board_suppress_frame_stats(void);

#ifdef __cplusplus
}
#endif
