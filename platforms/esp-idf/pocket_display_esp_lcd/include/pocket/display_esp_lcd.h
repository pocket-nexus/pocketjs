#pragma once
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "pocket_drivers.h"
#include <stdbool.h>
typedef struct pocket_display_esp_lcd pocket_display_esp_lcd;
/* SPI/I80 panel IO with GRAM. Panel and IO stay live until destroy. This
 * instance exclusively submits color transfers to the IO and owns its
 * on_color_trans_done callback. Configure the panel for RGB565, with no
 * rotation after creation. byte_swap adapts wire order. budget counts both
 * DMA pixel allocations; no full-frame scratch is allocated.
 */
typedef struct {
  size_t struct_size;
  esp_lcd_panel_handle_t panel;
  esp_lcd_panel_io_handle_t io;
  uint32_t width, height, strip_rows, buffer_count;
  size_t frame_buffer_budget;
  bool byte_swap;
} pocket_display_esp_lcd_config;
pocket_display_esp_lcd *
pocket_display_esp_lcd_create(const pocket_display_esp_lcd_config *);
const pocket_display_output_v1 *pocket_display_esp_lcd_vtable(void);
size_t pocket_display_esp_lcd_buffer_bytes(const pocket_display_esp_lcd *);
/* Call after external writes/reset, while no runtime call is active. Pending
 * transfers terminate first; the next frame repaints the panel. */
void pocket_display_esp_lcd_invalidate(pocket_display_esp_lcd *);
/* Drains transfers before releasing storage. Does not destroy panel or IO. */
void pocket_display_esp_lcd_destroy(pocket_display_esp_lcd *);
