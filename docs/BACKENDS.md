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

**An embedding host can measure, wrap and paint every piece of text with a
text provider of its own**, for example one built on the system font
library, and then needs no baked atlas. The `text.layout.native` capability
names this contract; no built-in host advertises it. The provider has three
parts:

| Part | Rust type | Installed with |
| --- | --- | --- |
| Measurer | `pocketjs_core::text::MeasureFn` = `Box<dyn Fn(&str, u8, f32, f32) -> (f32, f32)>`: text, slot, tracking, line height (NaN = the slot's default) to (widest line, total height) in logical px; lines break at `'\n'` only | `UiProgram::set_text_provider(measure, wrap)`, `UiSurface::set_text_provider`, or `Ui::set_text_measure` |
| Wrapper | `pocketjs_core::text::WrapFn` = `Box<dyn Fn(&str, u8, f32) -> Vec<u32>>`: text, slot, maximum width to soft-break columns in UTF-16 code units | the same calls, or `Ui::set_text_wrap` |
| Painter | `pocket_wgpu_render::TextPainter` | `ProgramOutput::set_text_painter`, `UiRenderer::set_text_painter`, or `WgpuRenderer::set_text_painter` |

**The target decides which apps get the provider, not the app.** A host
whose target provides `text.layout.native` installs its provider for every
app before the guest mounts. On a target that provides `text.layout.native`
and not `text.glyphs.baked`, every app is built without an atlas and the host
installs its provider for every app; an app's `requires` or `enhances` entry
for `text.layout.native` changes neither the build nor what the host
installs. A role grant is the one exception: when the target's
`roleCapabilities.systemUI` lists `text.glyphs.baked` and a System UI app
resolves it (`features["text.glyphs.baked"] === true` in its plan), that
package carries atlases and the host draws it from them without a provider.

**With a measurer installed, every text run the layout solver places
measures through it and draws as one `TEXT_RUN`**: tracked, rotated, scaled
and skewed runs included. Layout records the provider and the measured size
on each text node, so the provider that sized a box paints its text, and
paint culls with the recorded size without calling the measurer again. The
`measureText` and `wrapText` ops answer from the same measurer and wrapper.
A `LAYOUT_STATIC` text node, whose rect ahead-of-time compilation computed
from the atlases, keeps `GLYPH_RUN` and draws nothing without an atlas;
ahead-of-time compilation refuses a target without atlases, so such nodes
exist only in packages that carry them. Without a measurer the core emits
`GLYPH_RUN` from the baked atlases, and its DrawLists, goldens and software
pixels are unchanged.

**`TEXT_RUN` carries everything the painter needs** (`contracts/spec/spec.ts`,
"DRAWLIST op format"; word offsets in `pocket_spec::text_run`): the slot,
the `TextAlign`, the box's top-left on screen, the box width, the line
height, the color, the tracking, the linear part `[a, b, c, d]` of the run's
2D transform, the provider generation and the UTF-8 bytes. A box-local point
`(x, y)` lands on screen at `origin + (a·x + c·y, b·x + d·y)`. The box width
is the node's **rounded layout width**, the width alignment places lines in;
it can be smaller than the width the measurer returned (a run measured
13.6 px after a 0.5 px sibling gets 13), so it is not a wrap width. A run
whose linear part has **determinant 0** (`scale-0`) is culled and never
emitted, and a tracking that is not finite reaches the measurer and the
record as **0**. A run whose transformed box is not inside the current clip
is bracketed in `SCISSOR`/`SCISSOR_POP`. The box-local x range that test
transforms is `[boxW − w, w]`, with `w` the larger of the box width and the
measured width: the range a right- or centre-aligned line wider than its box
can cover.

**Within one `Ui` and its provider the words are the complete pixel truth**:
snapshots, demand-render hashes and damage diffs compare them and need no
side table. The generation is a **counter per `Ui`** that advances each time
the host installs a measurer or calls `text_provider_changed`. It does not
identify a font across `Ui`s or sessions (two sessions with different fonts
both start at generation 1), and replacing only the painter leaves it as it
was.

**Text inside a perspective subtree is upright and unscaled at the run's
projected anchor**: its `TEXT_RUN` carries the anchor as the origin and the
identity linear part, because the DrawList has no projective text primitive.
That is where the baked path places its glyph cells in a perspective
subtree. Under a 2D rotation or skew the two paths differ: the provider
receives the linear part and draws rotated glyphs, while the baked path moves
each upright glyph cell to its transformed anchor.

**`pocket-wgpu-render` draws `TEXT_RUN` through the installed
`TextPainter`** and depends on no font library:

```rust
pub trait TextPainter {
    fn begin_frame(&mut self) {}
    fn paint(
        &mut self,
        run: &TextRun<'_>,            // pocket_render::TextRun: the decoded record
        text: &str,
        context: &TextPaintContext,   // scale, clip; #[non_exhaustive]
        quads: &mut Vec<TextQuad>,
    ) -> Result<(), RenderError>;
    fn end_frame(&mut self) {}
}
```

For every frame the renderer calls `begin_frame`, `paint` once per run in
DrawList order, then `end_frame` (also when the frame failed).
`TextPaintContext::scale` is the target's physical pixels per logical pixel;
`TextPaintContext::clip` is `[x0, y0, x1, y1]` in box-local logical pixels,
the bounding box of the visible part of the run's scissor mapped back
through the run's transform, so a painter can skip the lines and glyphs
outside it. The painter appends `TextQuad { texture, ink, rect, uv }` values:
`texture` is a `wgpu::TextureView` the painter owns, `rect` is
`[x0, y0, x1, y1]` in box-local logical pixels and `uv` the normalized
texture coordinates of its corners. `TextInk::Coverage` reads coverage from
the red channel (an `R8Unorm` atlas page or a whole-line texture) and paints
it in the run's color; `TextInk::Color` reads straight-alpha color in the
renderer's image format (`image_format()` on `WgpuRenderer`, `UiRenderer` and
`ProgramOutput`) and applies the run's alpha. The renderer maps each quad
through the run's transform and draws it in painter order under the run's
scissor, so one glyph atlas, or one texture per line, serves every
transform. Without a painter a frame containing `TEXT_RUN` is `Unsupported`.

- **Textures batch by view identity.** Each distinct view takes **one bind
  group per frame**, and consecutive quads over one view draw in one batch;
  a painter keeps one view per texture instead of calling `create_view` per
  quad, which makes every quad a bind group and a batch of its own.
- **Content stays valid until the frame is submitted.** `queue.write_texture`
  executes at the next `submit`, ahead of the frame's commands, so a texture
  region rewritten twice before then shows the last write in every run that
  samples it. An atlas evicts and reuses space in `begin_frame` or after
  `end_frame`, never between two runs of one frame. `Renderer::render`
  submits before `end_frame`; with `WgpuRenderer::encode` the host submits
  its encoder after `end_frame` and keeps the painter's textures unchanged
  until then.
- **A renderer with a painter slot is not `Send`.** The painter carries no
  `Send` bound, so it can share an `Rc` font system with the measurer;
  `WgpuRenderer` and `UiRenderer` therefore stay on the thread that created
  them.
- **Installation reports failure.** `WgpuRenderer::set_text_painter` returns
  `Err(RenderError::Failed)` after shutdown; `ProgramOutput::set_text_painter`
  and `UiRenderer::set_text_painter` return an error when the renderer is
  shut down, taken or in use (a call from inside `paint`). The painter is
  dropped in each case.

**The slot table comes from `pocket_spec::font_slot::TABLE`**, generated
from `FONT_SLOT_TABLE` in `contracts/spec/spec.ts`: the pixel size, weight
and family of each slot, the same table the compiler assigns slots from.
A provider resolves the slot argument of its measurer, wrapper and painter
through it.

**`UiProgram::text_provider_changed` reports a new font behind the same
provider** (`UiSurface::text_provider_changed`, `Ui::text_provider_changed`).
The next frame re-measures every text run, and the `TEXT_RUN` generation word
changes, so a DrawList whose geometry repeats under the new font still
differs. Installing a measurer has the same effect. Installing a painter does
not: a host that replaces the painter with one that draws differently calls
`text_provider_changed` as well.

### Painting what was measured

The core lays out with the measurer's sizes and hands the painter the
record; nothing in between checks that the two agree. A provider matches
them through these rules.

- **Alignment and the baseline are the painter's.** The core places nothing
  inside the box. The baked path lays out each line at its pen width `w`
  (the sum of advance plus tracking over its characters) and shifts it by
  `0` for `Left`, `(boxW − w) / 2` for `Center` and `boxW − w` for `Right`,
  negative when the line is wider than the box. Line `i` occupies
  `[i·lineHeight, (i + 1)·lineHeight)`, and the glyph cell, which spans the
  font's ascent plus descent in whole pixels, is centred in it: the baseline
  sits at `i·lineHeight + (lineHeight − (ascent + descent)) / 2 + ascent`. A
  painter that applies the same rules places text where baked text would be.
- **A NaN line height is the slot's default**, which the provider chooses
  (the baked atlases use the font's ascent plus descent plus line gap,
  rounded). The measurer and the painter use the same default; the guest
  cannot query it.
- **Tracking is added after every character, the last one included**, and
  the measured width contains that trailing tracking; the baked path adds it
  once per Unicode scalar value. The painter adds tracking the way its
  measurer did, or a right-aligned or centred line moves by the difference.
- **The measurer gets no device scale.** One answer serves every target
  scale and every transform, so the measurer and the painter use unhinted
  metrics with fractional advances; hinted advances differ per pixel size
  and make painted lines longer or shorter than measured.
- **Views are reused and content is kept until submission**, as stated
  above.
- **Replacing the painter alone does not change the generation**; call
  `text_provider_changed` with it.

This API carries a width per string and nothing finer. It has no positions
inside a run: a guest's caret and selection arithmetic sums `measureText`
over prefixes of the line, which is right only when advances add up, so a
provider used with text fields turns ligatures and kerning off. It carries no
base direction, so a right-to-left paragraph is laid out per line with no
paragraph direction. `wrapText` takes no tracking, so wrap columns of a
tracked run are computed without it. The guest receives no signal when the
provider changes: `text_provider_changed` re-measures the core's text nodes,
while wraps and positions the guest computed stay as they were.

**The compiler bakes no atlas for a target that provides
`text.layout.native` and not `text.glyphs.baked`** (`planBakesAtlases` in
`framework/compiler/bake-font.ts`, read from the resolved plan): the
package's pak holds styles and images and no `ui:font.<slot>` entry. A
`text.glyphs.baked` the plan resolved through a role grant counts as
provided. An application that requires `text.glyphs.baked` fails resolution
for such a target with `capability.unavailable`, as for any capability the
target lacks. Ahead-of-time compilation (`tools/aot-compile.ts`) lays text
out with the atlases and refuses a plan without them.

**`text.layout.offload` uses package fonts in a separate worker.** The Rust
text engine wraps, shapes and rasterizes text for native and WASM consumers.
PSP requires a paired companion for this capability. See
[TEXT-OFFLOAD.md](TEXT-OFFLOAD.md) for bounded records, incremental edits and
first-page delivery.

## Browser System host

**`web-app` runs every package in an independent same-origin iframe
JavaScript Realm with its own wasm `Ui`.** `programs/web/system-engine.js`
derives the package catalog, surface handles and lifecycle policy from one
`ResolvedSystemPlan`. Live shell bindings create and remove AppInstances;
focus and visible painter order determine scheduling.

The wasm software compositor retains each visible child framebuffer and
paints it at each `SURFACE_QUAD` position during the host render.
Full bounds determine the child coordinate origin, clip bounds constrain the
visible pixels, and the instruction remains at its original DrawList offset.
Shell chrome emitted after the surface therefore stays above the child. A
missing child raster leaves the shell's loading fallback visible.

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
