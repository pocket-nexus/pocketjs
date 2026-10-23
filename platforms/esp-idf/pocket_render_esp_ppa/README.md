# pocket_render_esp_ppa

**PPA acceleration implements the public Renderer contract over RGB565 CPU
surfaces.** The factory in `platforms/esp-idf/render-ppa` registers an instance
through `pocket_runtime_add_renderer`; no UI pointer or global renderer is used.

The device table supplies blocking opaque FILL, A8 BLEND and PSM5650 SRM.
`Unsupported` permits software fallback before device writes. A transaction the
IDF driver rejects returns it, so the renderer draws that operation in software
and logs the first rejection per operation with its IDF error name. The table
also reports the DMA cache-line alignment (`esp_cache_get_alignment`, 64 bytes
on P4); a strip whose address or byte length is not a multiple of it renders in
software. Each strip repaints the frame's damage bounds and no other pixels.
Glyph masks and white-alpha batches share the configured A8 payload budget.

Create the device with `pocketjs_esp32p4_ppa_create`, then create the renderer
with `pocket_render_esp_ppa_create`. Destroy the runtime, renderer and device in
that order. Public headers are `pocket/render_esp_ppa.h` and
`pocketjs/esp32p4_ppa_status.h`.
