# pocket_render_esp_ppa

**PPA acceleration implements the public Renderer contract over RGB565 CPU
surfaces.** The factory in `platforms/esp-idf/render-ppa` registers an instance
through `pocket_runtime_add_renderer`; no UI pointer or global renderer is used.

The device table supplies blocking opaque FILL, A8 BLEND and PSM5650 SRM.
`Unsupported` permits software fallback before device writes. A failed operation
aborts the frame without replaying it in software. Glyph masks and white-alpha
batches share the configured A8 payload budget.

Create the device with `pocketjs_esp32p4_ppa_create`, then create the renderer
with `pocket_render_esp_ppa_create`. Destroy the runtime, renderer and device in
that order. Public headers are `pocket/render_esp_ppa.h` and
`pocketjs/esp32p4_ppa_status.h`.
