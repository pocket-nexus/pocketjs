# pocket_display_esp_dpi

**A MIPI-DSI DPI panel scans one RGB565 framebuffer out of PSRAM; this
driver places a picture inside it.** The runtime renders strips into two
internal DMA staging buffers (`width × strip_rows × 2 × 2` bytes, within
`frame_buffer_budget`). Flush copies each damaged rectangle of a strip into
the framebuffer: whole panel rows of an upright picture through the
program's `copy` GDMA channel, everything else through the PPA SRM engine,
which turns a landscape picture 90 degrees counter-clockwise onto a portrait
panel (`turned`), turns the picture a further 180 degrees for a panel mounted
upside down (`half_turn`) and scales it by the integer `scale`. Screen
`(x, y)` lands on panel `(y, panel_height - 1 - x)` when turned,
`(panel_width - 1 - x, panel_height - 1 - y)` with `half_turn` and
`(panel_width - 1 - y, x)` with both. The picture lands at
`origin_x, origin_y` on the screen as the picture is oriented; the program
owns every pixel outside it.

The descriptor advertises double buffering with pipelined acquire, partial
refresh, device rotation and scaling when they apply, and a row quantum of
`row_alignment` raster rows. **A turned strip presented by the PPA must be at
least 8 raster rows tall:** the PPA stops completing 90-degree presents of
blocks 4 or 6 raster rows tall while the panel scans out (measured on an
ESP32-P4 rev 1.3; 2 and 8 to 28 rows complete). Every strip holds a multiple
of the rows that span whole 128-byte cache lines, so PPA operands start and
end on a line: four 1184-byte rows at 592 pixels wide, one 1280-byte row at
640; a turned strip's quantum is the smallest multiple of that count and of 8.

At a scale above 1 the PPA interpolates between neighbouring pixels, so the
descriptor declares `POCKET_DISPLAY_FILTERED_SCALING` and the runtime grows
damage by one pixel.

With `move_copy` (a second GDMA channel) the driver declares
`POCKET_DISPLAY_RETAINED_MOVE` and implements `move_pixels`: the runtime's
damage planner then reuses content that only moved. Whole panel rows move
through `move_copy`, in the order that keeps unread source rows (a picture
with `half_turn` moves the rows the opposite way on the panel); other blocks
of an upright or half-turned picture bounce through a staging buffer with the
PPA. A turned move
that is not along panel rows (a vertical scroll of a landscape picture)
returns `POCKET_STATUS_UNSUPPORTED`, and the runtime repaints its destination:
that costs less than bouncing every band through a staging buffer twice. The
move completes before the frame's first present.

`pocket_display_esp_dpi_set_overlay` hands the driver one square ARGB8888
face at a picture position (the program's home ball). Flush blends the face
once over the bounds of the rectangles it presents, which may overlap, so the
framebuffer keeps the overlay wherever the picture changed under it, and the
display's
`host_damage` reports the overlay's rectangle when its face changes and, after
a move that carried its pixels, where they were and where they landed; the
runtime adds those rectangles to the frame's plan. A face of `NULL` or size 0
removes the overlay and reports its last rectangle once.

A wait longer than 1000 ms fails and keeps that buffer reserved until its
presents land. `pocket_display_esp_dpi_invalidate` follows external writes
inside the picture; `pocket_display_esp_dpi_staging` lends a staging buffer
to the program between frames.
