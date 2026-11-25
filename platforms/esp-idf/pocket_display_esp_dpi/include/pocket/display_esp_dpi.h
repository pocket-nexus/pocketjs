#pragma once
#include "esp_async_memcpy.h"
#include "pocket_drivers.h"
#include <stdbool.h>
#include <stdint.h>
typedef struct pocket_display_esp_dpi pocket_display_esp_dpi;
/* A picture inside the RGB565 framebuffer of a MIPI-DSI DPI panel. The
 * runtime renders strips into two internal DMA staging buffers; flush copies
 * a strip's damaged rectangles into the framebuffer with the PPA, turning a
 * landscape picture 90 degrees counter-clockwise onto a portrait panel
 * (`turned`), turning it a further 180 degrees (`half_turn`, for a panel
 * mounted upside down) and scaling it by an integer, or with `copy` (a GDMA
 * memcpy channel the program may share) when the rows are whole panel rows
 * of an upright picture.
 *
 * width x height is the picture in raster pixels as the application draws
 * it. The picture lands at origin_x, origin_y on the screen as the picture is
 * oriented, scale panel pixels per raster pixel. Pixels outside the picture
 * belong to the program. row_alignment is the raster-row quantum of every
 * damaged rectangle (the runtime aligns damage to it); strip_rows must be a
 * multiple of it. budget counts both staging buffers.
 *
 * At a scale above 1 the PPA interpolates: a panel pixel is three quarters
 * of its raster pixel and one quarter of the raster pixel beside it, and a
 * presented rectangle repeats its edge pixels outward. The descriptor
 * declares POCKET_DISPLAY_FILTERED_SCALING, and the runtime flushes damage
 * grown by one raster pixel on every side.
 *
 * With `move`, the display moves retained pixels for a frame's motion: whole
 * panel rows through `move_copy` (a GDMA channel of its own), other blocks in
 * bands through a staging buffer with the PPA. Presents wait for the move.
 *
 * With `back_framebuffer` the panel has two framebuffers and the display
 * flips between them: a frame's moves and presents write the framebuffer
 * the panel does not scan, and the display reports one buffer identity for
 * each, so the runtime repaints in a framebuffer what changed since the frame
 * it last held. When the frame's last present has landed the display calls
 * `flip.show` with that framebuffer; before it writes the other one it calls
 * `flip.wait_shown`. One scan of the panel then reads the rows of one frame.
 * A frame that moved pixels and presented nothing is shown when the next
 * frame starts. `framebuffer` is the one the panel scans at creation. */
/* The program's page flip, called on the task that runs the runtime. */
typedef struct {
  /* Makes the panel scan `framebuffer` from its next refresh on. Returns
   * without waiting for that refresh; false when the panel refused. */
  bool (*show)(void *context, const uint16_t *framebuffer);
  /* Blocks until the panel no longer reads the framebuffer it scanned before
   * the last `show`, at most timeout_ms. False on a timeout. */
  bool (*wait_shown)(void *context, uint32_t timeout_ms);
  void *context;
} pocket_display_esp_dpi_flip;
typedef struct {
  size_t struct_size;
  uint16_t *framebuffer;
  uint32_t panel_width, panel_height;
  uint32_t role;
  uint32_t width, height;
  /* Screen (x, y) lands on panel (y, panel_height - 1 - x) when turned,
   * on panel (panel_width - 1 - x, panel_height - 1 - y) with half_turn,
   * on panel (panel_width - 1 - y, x) with both. */
  bool turned;
  bool half_turn;
  uint32_t scale;
  uint32_t origin_x, origin_y;
  uint32_t strip_rows, row_alignment;
  size_t frame_buffer_budget;
  async_memcpy_handle_t copy;
  async_memcpy_handle_t move_copy;
  /* The panel's second framebuffer and its page flip; NULL writes
   * `framebuffer` while the panel scans it. */
  uint16_t *back_framebuffer;
  pocket_display_esp_dpi_flip flip;
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
 * active. Pending presents finish first; the next frame of each framebuffer
 * repaints it all. */
void pocket_display_esp_dpi_invalidate(pocket_display_esp_dpi *);
/* Drains presents and moves, and a page flip the panel has not taken yet,
 * before releasing the staging buffers. Does not release the panel, its
 * framebuffers or the copy channels. */
void pocket_display_esp_dpi_destroy(pocket_display_esp_dpi *);
