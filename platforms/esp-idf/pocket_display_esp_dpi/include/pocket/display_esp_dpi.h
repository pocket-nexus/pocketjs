#pragma once
#include "esp_async_memcpy.h"
#include "pocket_drivers.h"
#include <stdbool.h>
#include <stdint.h>
typedef struct pocket_display_esp_dpi pocket_display_esp_dpi;
/* A picture inside the RGB565 framebuffer of a MIPI-DSI DPI panel. The
 * runtime renders strips into two internal DMA staging buffers; flush copies
 * a strip's damaged rectangles into the framebuffer with the PPA, turning a
 * landscape picture 90 degrees counter-clockwise onto a portrait panel and
 * scaling it by an integer, or with `copy` (a GDMA memcpy channel the program
 * may share) when the rows are whole panel rows.
 *
 * width x height is the picture in raster pixels as the application draws
 * it. The picture lands at origin_x, origin_y on the screen as the picture is
 * oriented, scale panel pixels per raster pixel. Pixels outside the picture
 * belong to the program. row_alignment is the raster-row quantum of every
 * damaged rectangle (the runtime aligns damage to it); strip_rows must be a
 * multiple of it. budget counts both staging buffers.
 *
 * With `move`, the display moves retained pixels for a frame's motion: whole
 * panel rows through `move_copy` (a GDMA channel of its own), other blocks in
 * bands through a staging buffer with the PPA. Presents wait for the move. */
typedef struct {
  size_t struct_size;
  uint16_t *framebuffer;
  uint32_t panel_width, panel_height;
  uint32_t role;
  uint32_t width, height;
  bool turned;
  uint32_t scale;
  uint32_t origin_x, origin_y;
  uint32_t strip_rows, row_alignment;
  size_t frame_buffer_budget;
  async_memcpy_handle_t copy;
  async_memcpy_handle_t move_copy;
} pocket_display_esp_dpi_config;
pocket_display_esp_dpi *
pocket_display_esp_dpi_create(const pocket_display_esp_dpi_config *);
const pocket_display_output_v1 *pocket_display_esp_dpi_vtable(void);
/* A host overlay the display blends into every presented region that covers
 * it: a `size` x `size` square of ARGB8888 texels (straight alpha) at raster
 * position (x, y) of the picture. The display reports the overlay's rows as
 * host damage when its texels or place change and when a move carries its
 * pixels along, so the picture under it repaints with the overlay on top.
 * The texels stay the caller's; NULL removes the overlay. Call between
 * frames on the task that runs the runtime. */
typedef struct {
  uint32_t x, y, size;
  const uint32_t *argb;
} pocket_display_esp_dpi_overlay;
void pocket_display_esp_dpi_set_overlay(pocket_display_esp_dpi *,
                                        const pocket_display_esp_dpi_overlay *);
size_t pocket_display_esp_dpi_buffer_bytes(const pocket_display_esp_dpi *);
/* A staging buffer the program may borrow while no frame is in flight (for
 * example to paint a host overlay); NULL when index is not 0 or 1. */
uint16_t *pocket_display_esp_dpi_staging(pocket_display_esp_dpi *,
                                         uint32_t index);
/* Call after external writes inside the picture, while no runtime call is
 * active. Pending presents finish first; the next frame repaints it all. */
void pocket_display_esp_dpi_invalidate(pocket_display_esp_dpi *);
/* Drains presents and moves before releasing the staging buffers. Does not
 * release the panel, its framebuffer or the copy channels. */
void pocket_display_esp_dpi_destroy(pocket_display_esp_dpi *);
