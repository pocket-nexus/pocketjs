# pocket_display_esp_lcd

**SPI/I80 GRAM panels use one or two RGB565 render buffers.** The buffer
payload allocation is `width × strip_rows × 2 × buffer_count` bytes and must fit
`frame_buffer_budget`. RGB and MIPI framebuffer panels require other drivers.

| `transfer_rows` | Render buffers | Rows reach the panel |
| --- | --- | --- |
| 0 | DMA strips of `strip_rows` rows; no full-frame allocation | as each strip is rendered |
| > 0 (staged) | `strip_rows = height`: the frame, in memory of `buffer_caps` | after the frame is rendered, behind the panel's scan |

The sections up to "Staged presentation" describe the strip buffers.

The product initializes its panel and panel IO, then creates this driver and
registers its table on the runtime. Two buffers advertise pipelined acquire:
the next strip can render while the previous transfer reads the other buffer.
The runtime expands damage to full-width rows. Flush submits those rows through
`esp_lcd_panel_draw_bitmap`.

The driver registers the panel IO's `on_color_trans_done` callback and counts
completed transfers. Wait blocks until the waited buffer's own transfers have
completed, while the other buffer's transfer keeps streaming. A wait longer
than 1000 ms returns failure and keeps that buffer reserved until its transfer
lands. Invalidation, destruction and an error after a submitted transfer use
the panel IO's synchronous no-command parameter transaction to drain the
queue. If IDF cannot establish this terminal barrier, `ESP_ERROR_CHECK` stops
the program instead of releasing DMA storage. The product must not register
its own color-transfer callback on this IO.

## Staged presentation

**A panel with GRAM refreshes on its own clock. Strips sent while a frame is
rendered reach it over several refreshes, and each of those refreshes shows
rows of two frames.** With `transfer_rows > 0` the frame is rendered first:

- `strip_rows` equals `height`, so a render buffer holds the frame. It may
  live outside DMA memory: `buffer_caps = MALLOC_CAP_SPIRAM`.
- Flush queues the flushed rows for a presenter task (`presenter_core`,
  `presenter_priority`) and returns. Wait consumes the token at once. The
  buffer stays reserved until the presenter has copied its rows; acquire
  blocks for a free buffer, at most 1000 ms. With two buffers the next frame
  renders while the presenter sends the previous one.
- The presenter copies `transfer_rows` rows at a time into one of two DMA
  transfer buffers (`width × transfer_rows × 2` bytes each, internal memory
  outside the budget), exchanges the bytes while it copies when `byte_swap`
  is set, and calls `esp_lcd_panel_draw_bitmap`. A transfer buffer is written
  again after its previous transfer has completed.
- `wait_refresh` reports the panel's refresh: the time at which the panel
  finished a scan of its rows (the tearing-effect edge) and the period. The
  presenter waits for it and starts the transfer of rows `[row, row + n)` at
  or after `start + period / 8 + (row + n) × period / height`. The scan has
  then passed those rows and shows the previous frame in all of them; the
  next scan shows the new frame in all of them. `period / 8` covers the
  blanking interval between the edge and the first row.
- Without `wait_refresh`, or when it reports no refresh within 50 ms, the
  rows go out at once.
- `column_alignment > 0` makes the flushed regions windows instead of
  full-width rows. The display reports `column_alignment` as its refresh
  width and window alignment, so the runtime renders and flushes a change as
  the columns it covers, with the left edge and the width rounded to that
  many columns: `1` for a panel that takes any window, `2` for one that takes
  even columns. `width` is a multiple of it. A transfer carries
  `transfer_rows` rows of one window, and `esp_lcd_panel_draw_bitmap`
  receives that window's columns. The presenter sends next the window whose
  first unsent row is the highest on the panel: windows that stand side by
  side take turns, and rows go out in ascending order behind the scan. One
  flush takes at most `strip_rows` windows.

`pocket_display_esp_lcd_get_stats` counts the flushes presented, those
without a refresh report, and those of which a transfer started when the next
scan may already have reached its rows (within `period / 8` of
`start + period + row × (period − period / 8) / height`).

A transfer the panel refuses ends that frame: the driver drains the panel IO
and reports a new buffer generation, and the runtime repaints the panel. The
presenter calls the panel's `draw_bitmap` from its own task; a panel driver
whose other commands (brightness, sleep) run on another task serialises them
with `draw_bitmap`.

## Panel identity

The retained panel identity keeps per-panel damage history. Call
`pocket_display_esp_lcd_invalidate` after resets or external pixel writes.
The product owns panel/IO handles and must keep them live through driver
destruction. Configure panel RGB565 wire order or set `byte_swap`.
