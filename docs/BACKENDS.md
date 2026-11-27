# Render backends

The core's output is one contract: the DrawList, a flat `Vec<u32>` of draw
ops pinned in `contracts/spec/spec.ts` ("DRAWLIST op format"). Everything
above it — JSX + Tailwind, the Solid/Vue Vapor/Octane renderers, the frame
transaction (docs/DETERMINISM.md), the animation engine — is identical on
every backend. Backends differ in **how the DrawList becomes pixels**, and
in **which text providers they support**.

## The portable backend

The portable backend is the baked-text pipeline every fixed-function host
shares: `pocket-ui-wgpu` for widgets and Pocket3D overlays, the core software
rasterizer (`engine/raster/src/lib.rs`) behind the wasm, Apple, PocketBook and sim
hosts, the PSP GE walker, the ESP32-P4 PPA, the SiFli EPIC executor and
Symbian GLES2 ports.

- **Text is baked at compile time.** `framework/compiler/bake-font.ts`
  rasterizes the app's collected codepoints into FONT ATLAS v3 blobs; the
  core measures runs from the atlas advance tables
  (`engine/core/src/text.rs::measure_run`) and emits `GLYPH_RUN` ops —
  glyph ids and cell positions, nothing else.
- **Software pixels are byte-deterministic.** The Rust rasterizer produces
  identical bytes for the same DrawList, resources and density on native and
  WASM. GPU backends preserve DrawList geometry and painter order; blending,
  filtering and triangle-edge rounding can differ. GPU tests compare selected
  fixtures against software with explicit per-channel tolerances. Hardware
  acceptance remains separate from emulator and software goldens.
- The capability id is `text.glyphs.baked`; hosts that extend atlases at
  runtime (system-font rasterization + `loadFontAtlas` reload, note-widget's
  cjk.rs) add `text.glyphs.runtime`.

## Text provider embedding

**A custom renderer can install its text measure and wrap providers** through
`Ui::set_text_measure` and `Ui::set_text_wrap` before the guest mounts.
The renderer must consume `TEXT_RUN` and paint with the provider that measured
the run. The DrawList stores the run's UTF-8 bytes and style hash.
Runs under a 2D transform (rotate, scale, skew) are `TEXT_RUN_XF`: the run
plus the 2x2 linear part of its world transform, which the backend applies to
the run's pixels. Tracked runs and runs under a 3D transform (rotateX/Y,
perspective) use baked atlas metrics and `GLYPH_RUN`.
The `text.layout.native` capability describes this embedding contract;
no built-in host advertises it. **A build for a host with it bakes atlases
with ASCII and the declared characters only** (`fonts.json`), not the
characters the source spells: the atlases draw tracked runs and runs under 3D
transforms. The shared DrawList walk asks its backend for a
run's pixels (`Backend::text_run` in `pocket-render`); `pocket-wgpu-render`
answers through the host's `TextPainter`.

**`text.layout.offload` uses package fonts in a separate worker.** The Rust
text engine wraps, shapes and rasterizes text for native and WASM consumers.
PSP requires a paired companion for this capability. See
[TEXT-OFFLOAD.md](TEXT-OFFLOAD.md) for bounded records, incremental edits and
first-page delivery.

## Browser realm

**`web-app` runs a package in a same-origin iframe JavaScript Realm with its
own wasm `Ui`** (`programs/web/app-instance.js`, the AppInstance). The page
that creates the iframe owns scheduling and composition through the
instance object; the package receives no other realm or framebuffer. This
repository's web program runs one application.

**Each AppInstance draws codepoints its baked atlases lack**
(`text.glyphs.runtime`, `platforms/web/runtime-glyphs.js`): the realm appends a
cell drawn by the browser to every loaded slot before the core lays the text
out ([Build pipeline](../site/content/docs/build-pipeline.md)).

**The wasm host rasterizes an interface with its coverage for a scene the
embedder draws.** `ui_render_premultiplied_scaled(scale)` runs the primary
DrawList once into a buffer cleared to zero: premultiplied R,G,B and the alpha
the ops accumulated, 0 where nothing is drawn. Its R,G,B bytes equal
`ui_render_scaled`'s, and it writes a buffer of its own, so the opaque
framebuffer and the incremental tracker stay as they were.
`ui_draw_hash_auxiliary` hashes the auxiliary surface's DrawList as
`ui_draw_hash` hashes the primary one. An AppInstance created with
`text: false` starts no text worker and gives its guest no `offload`. A
Pocket3D game's browser tab uses the three to lay its interface over a WebGPU
scene ([`engine/pocket3d/crates/pocket-web-wgpu`](../engine/pocket3d/crates/pocket-web-wgpu/README.md)).
