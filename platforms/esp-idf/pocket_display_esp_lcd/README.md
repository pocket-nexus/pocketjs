# pocket_display_esp_lcd

**SPI/I80 GRAM panels use one or two RGB565 DMA strip buffers.** The buffer
payload allocation is `width × strip_rows × 2 × buffer_count` bytes and must fit
`frame_buffer_budget`. The driver has no full-frame scratch allocation. RGB
and MIPI framebuffer panels require other drivers.

The product initializes its panel and panel IO, then creates this driver and
registers its table on the runtime. Two buffers advertise pipelined acquire:
the next strip can render while the previous transfer reads the other buffer.
The runtime expands damage to full-width rows. Flush submits those rows through
`esp_lcd_panel_draw_bitmap`.

Wait uses the panel IO's synchronous no-command parameter transaction to drain
queued color transfers. An error after a submitted transfer also drains the
queue before returning failure. If IDF cannot establish this terminal barrier,
`ESP_ERROR_CHECK` stops the program instead of releasing DMA storage.

The retained panel identity keeps per-panel damage history. Call
`pocket_display_esp_lcd_invalidate` after resets or external pixel writes.
The product owns panel/IO handles and must keep them live through driver
destruction. Configure panel RGB565 wire order or set `byte_swap`.
