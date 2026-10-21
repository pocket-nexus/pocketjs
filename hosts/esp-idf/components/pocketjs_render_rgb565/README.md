# pocketjs_render_rgb565

Transactional RGB565 DrawList renderer with a complete software path.

- Public header: `pocketjs/render_rgb565.h`
- Targets: ESP32-P4 and ESP32-S3
- Dependency: `pocketjs_ui_core`

The UI component's Rust archive supplies the renderer's native symbols.

Keep one `pocketjs_rgb565_target_t` for each persistent physical buffer. A
frame follows `prepare`, zero or more `render_strip` calls, then `commit` after
successful presentation or `abort` after a partial update. The caller owns
every pixel buffer and all presentation synchronization. The renderer config's
`scale` must equal the frame's raster density. A strip is full-width, but
columns outside the damage rectangle are not modified.
