# PocketJS ESP32-P4 PPA backend

This `no_std` crate interprets PocketJS DrawLists directly into an RGB565
surface. It accelerates operations that map exactly to the ESP32-P4 Pixel
Processing Accelerator and preserves DrawList order with an RGB565 software
fallback for everything else.

The default crate deliberately does not depend on ESP-IDF or a board support
package. Hosts implement `PpaOps` through a driver adapter or test double. The
ESP-IDF adapter and component composition live under
[`hosts/esp-idf`](../../../hosts/esp-idf/README.md); board-specific display
presentation remains in the product BSP.

Accelerated paths:

- opaque and translucent flat rectangles (`FILL` or A8 `BLEND`);
- antialiased font runs (`A8` coverage composed once, then `BLEND`);
- single-color alpha textures such as PocketJS rounded-corner masks (`A8`
  `BLEND`);
- opaque PSM 5650 texture quads (`SRM`) when scaling semantics are compatible.

Gradients, arbitrary triangles, textured triangles, and unsupported texture
formats fall back to `pocketjs_core::raster::render_scaled_rgb565_over`.
No full-frame RGB888 or ARGB8888 surface is allocated.

## Incremental rendering

`Renderer::render_incremental` uses the backend-independent
`pocketjs_core::damage::DamageTracker` to compare the current DrawList with
the DrawList that produced a persistent RGB565 target. Changed operation
bounds are collected into up to 8 disjoint logical damage rectangles. Each
rectangle is cleared and the current DrawList is replayed through that
rectangle's scissor, preserving normal painter order and translucent
composition without touching unchanged pixels.

Keep one `RenderTargetState` per framebuffer. This is required for
double-buffered hosts because each target contains a different older frame.
The first render and structural DrawList changes use a conservative full
redraw. This backend additionally promotes damage covering at least 75
percent of the viewport; that transaction-cost policy is deliberately kept
outside the common damage planner.

Core-managed texture, font, and style mutations bump `Ui::raster_revision()`,
so every `RenderTargetState` automatically forces a complete repaint and the
renderer drops texture classifications even when DrawList handles stay
unchanged. Call `Renderer::invalidate_resources()` and explicitly invalidate
target states only for output-affecting changes performed outside `Ui`.

Hosts that present damage through a separate asynchronous display pipeline can
split planning from history updates:

- `prepare_damage` computes a plan without mutating the target snapshot;
- `render_strip` renders one logical damage rectangle into a compact,
  full-viewport-width RGB565 strip while preserving global sampling phase;
- `commit_damage` advances history only after every strip is presented;
- `abort_damage` invalidates a partially updated target so its next plan is a
  full redraw.

This keeps framebuffer history transactional when a display transfer fails and
lets two reusable strips overlap CPU rendering with asynchronous presentation.

## Test

Run the portable renderer and pixel-parity tests on the host:

```sh
cargo test --locked --manifest-path engine/backends/rgb565/Cargo.toml
```
