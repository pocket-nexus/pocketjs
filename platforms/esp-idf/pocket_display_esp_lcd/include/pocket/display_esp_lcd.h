#pragma once
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "pocket_drivers.h"
#include <stdbool.h>
typedef struct pocket_display_esp_lcd pocket_display_esp_lcd;
/* One refresh of the panel, read from its tearing-effect signal. start_us is
 * the esp_timer time at which the panel finished the scan of its last row;
 * period_us is the time between two such instants. */
typedef struct {
  int64_t start_us;
  uint32_t period_us;
} pocket_display_esp_lcd_refresh;
/* Blocks until the panel finishes a scan, at most timeout_ms. Returns false
 * when the panel reported none. Called on the presenter task. */
typedef bool (*pocket_display_esp_lcd_refresh_fn)(
    void *context, uint32_t timeout_ms, pocket_display_esp_lcd_refresh *out);
/* SPI/I80 panel IO with GRAM. Panel and IO stay live until destroy. This
 * instance exclusively submits color transfers to the IO and owns its
 * on_color_trans_done callback. Configure the panel for RGB565, with no
 * rotation after creation. byte_swap adapts wire order. budget counts the
 * render buffers: width x strip_rows x 2 x buffer_count bytes.
 *
 * transfer_rows = 0: the render buffers are DMA strips and flush sends their
 * rows as they are rendered.
 *
 * transfer_rows > 0, staged presentation: strip_rows equals height, so a
 * render buffer holds the frame and may be allocated outside DMA memory
 * (buffer_caps, e.g. MALLOC_CAP_SPIRAM). A presenter task copies the flushed
 * rows into two DMA transfer buffers of transfer_rows rows and sends them.
 * With wait_refresh it sends a row after the panel's scan has passed it, so
 * one refresh shows the rows of one frame. The presenter calls the panel's
 * draw_bitmap at any time: a panel whose other commands run on another task
 * serialises them with draw_bitmap.
 *
 * column_alignment > 0, staged presentation only: the display reports windows
 * whose left edge and width are multiples of column_alignment columns, the
 * runtime renders and flushes those windows instead of full-width rows, and
 * draw_bitmap receives each window's columns. width is a multiple of it, and
 * one flush takes at most strip_rows windows. 0 keeps full-width rows. */
typedef struct {
  size_t struct_size;
  esp_lcd_panel_handle_t panel;
  esp_lcd_panel_io_handle_t io;
  uint32_t width, height, strip_rows, buffer_count;
  size_t frame_buffer_budget;
  bool byte_swap;
  uint32_t transfer_rows;
  /* Heap capabilities of the render buffers in staged presentation; 0 is
   * MALLOC_CAP_DEFAULT. */
  uint32_t buffer_caps;
  pocket_display_esp_lcd_refresh_fn wait_refresh;
  void *refresh_context;
  /* Presenter task: core (-1: no affinity) and priority (0: one above the
   * task that creates the display). */
  int32_t presenter_core;
  uint32_t presenter_priority;
  /* Staged presentation: columns a flushed window is aligned to (1: any
   * window; 2: a panel that takes even columns); 0 is full-width rows. */
  uint32_t column_alignment;
} pocket_display_esp_lcd_config;
/* Counters of staged presentation since creation. */
typedef struct {
  size_t struct_size;
  uint32_t frames;         /* flushes presented */
  uint32_t unsynced;       /* presented without a refresh report */
  uint32_t late;           /* a transfer started when the next scan may have
                              reached its rows */
  uint32_t present_us_max; /* longest time from flush to the last transfer
                              submitted */
} pocket_display_esp_lcd_stats;
pocket_display_esp_lcd *
pocket_display_esp_lcd_create(const pocket_display_esp_lcd_config *);
const pocket_display_output_v1 *pocket_display_esp_lcd_vtable(void);
size_t pocket_display_esp_lcd_buffer_bytes(const pocket_display_esp_lcd *);
/* False when out is too small or the display is not staged. */
bool pocket_display_esp_lcd_get_stats(const pocket_display_esp_lcd *,
                                      pocket_display_esp_lcd_stats *out);
/* Call after external writes/reset, while no runtime call is active. Pending
 * transfers terminate first; the next frame repaints the panel. */
void pocket_display_esp_lcd_invalidate(pocket_display_esp_lcd *);
/* Drains transfers before releasing storage. Does not destroy panel or IO. */
void pocket_display_esp_lcd_destroy(pocket_display_esp_lcd *);
