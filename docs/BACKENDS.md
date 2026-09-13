# Render backends

The core's output is one contract: the DrawList, a flat `Vec<u32>` of draw
ops pinned in `contracts/spec/spec.ts` ("DRAWLIST op format"). Everything
above it — JSX + Tailwind, the Solid/Vue Vapor/Octane renderers, the frame
transaction (docs/DETERMINISM.md), the animation engine — is identical on
every backend. Backends differ in **how the DrawList becomes pixels**, and
in exactly one capability: **who measures and shapes text**.

## The portable backend

The portable backend is the baked-text pipeline every fixed-function host
shares: `pocket-ui-wgpu` on the desktop, the core software rasterizer
(`engine/core/src/raster.rs`) behind the wasm, Apple, PocketBook and sim
hosts, the PSP GE walker, the ESP32-P4 PPA and Symbian GLES2 ports.

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

## The portable desktop host

`hosts/desktop` uses winit for windows/input and the existing `pocket-ui-wgpu`
DrawList backend for drawing and composition (wgpu/Metal on macOS). It reuses
`pocket3d::gpu::Gpu`; no extra renderer crate or guest API is introduced.
QuickJS guests, flex layout and GPU command recording execute on a runtime
worker. Each AppInstance has an independent text worker through `io.offload`.

**Child surfaces stay on the GPU.** Each has an independent renderer/resource
cache and retained texture. DrawList/resource revisions invalidate content;
instance generations invalidate reopened apps. `SURFACE_QUAD` samples these
textures at the shell's painter position, outside guest texture handles.
The worker leases from a three-target frame pool and submits to a shared queue.
The window thread presents the retained target with a GPU blit. Frame leases
prevent reuse until presentation is submitted; queue ordering protects GPU
reads. The handoff holds one output, and rendering retries when no target is
available. An output reservation prevents recording more GPU work while the
window thread has not consumed the previous output. Surface loss/outdated errors reconfigure and retry; fatal GPU errors
exit with an error. Production presentation performs no framebuffer readback.

The WASM host retains `engine/core/src/compositor.rs` and the software rasterizer.
Vita/GXM and 3DS/PICA retain their own DrawList adapters and capability profiles;
wgpu is not added to their dependency graph. Desktop composition support does
not admit that capability on handheld targets.
`text.layout.offload` wraps, shapes and rasterizes text using explicit package
fonts in Rust, including through the same engine compiled to WASM. PSP requires
a paired companion for this capability. See [TEXT-OFFLOAD.md](TEXT-OFFLOAD.md)
for bounded records, incremental edits, first-page delivery and benchmarks.

The native host no longer links gpui or platform text libraries. Core atlas
measurements for baked UI remain available. Apps that need document reflow
should use the asynchronous text service; the stock Note's legacy baked editor
and specialized widget hosts retain their existing pipeline.

## The legacy gpui backend

`engine/backends/gpui` (`pocket-ui-gpui`) paints the same DrawList through
[gpui](https://gpui.rs) — Zed's native GPU renderer. This retained optional
crate is no longer used by the stock desktop host. The following describes its
legacy contract. Boxes, gradients
and images become antialiased vector quads instead of upscaled raster;
text can come from the host text system.

- **Text layout is a host capability, opted into per app.** An app that
  `enhances: ["text.layout.native"]` gets a core text measurer installed
  before the guest mounts (`Ui::set_text_measure`): taffy leaf sizes, the
  `measureText` op and painted glyphs all come from one provider — CoreText
  through gpui's platform text system. Codepoint coverage is the OS font fallback
  chain (CJK, emoji, everything), with **no runtime atlas baking and no
  tofu**.
- **The op is `TEXT_RUN` (9).** With a measurer installed, translation-only
  tracking-0 runs pack the run string's UTF-8 bytes INTO the word stream
  (8 header words + payload) — the DrawList stays the complete `Vec<u32>`
  pixel truth, so snapshots, demand-render hashes and damage word-diffs are
  exact by construction. The provider is chosen once per node at layout
  build and recorded (`Node::text_native`); layout and paint gate on ONE
  shared predicate (`Resolved::declares_transform`), and when a paint-only
  transform changes the answer, `Ui::draw` relayouts and repaints before
  returning — every frame that leaves `draw()` is provider-correct, in
  both directions, with no oscillation on canceling transforms. Tracked,
  scaled and rotated runs keep the baked `GLYPH_RUN` pair — measurement
  and glyphs always come from the same provider per node.
- **Monospace is a slot family.** `font-mono` resolves to dedicated slots
  (16..18; framework/compiler/tailwind.ts MONO_FONT_PX) baked from JetBrains
  Mono on the portable side and mapped to the same family through the host
  text system on gpui — the note's code blocks are monospace on every
  backend.
- **Prefix additivity is preserved.** Ligatures, contextual alternates and
  kerning are disabled in the native shaping configuration
  (`engine/backends/gpui/src/fonts.rs`), because app editor math measures
  caret positions as prefix widths through `measureText`
  (`apps/note/layout.ts`, `apps/im/wrap.ts`) and prefix sums only equal
  shaped positions when advances are additive.
- **Soft-wrap breaks are a host op.** `wrapText` (spec op 43) returns the
  break columns for one line under a pixel width. The core computes greedy
  word wrap over the slot's measure provider; a native-text app gets gpui's
  own `LineWrapper` instead (`native_wrap`, installed next to the measurer
  through the same `TextConfig` — Zed's editor WrapMap consumes the same
  machinery). The wrapped COORDINATE SPACE — visual rows, caret/selection
  mapping and hit testing — stays app-side: the op is only the "where does
  this line break" half, matching the platform/editor split Zed uses.
- **Two ops keep a pixel-exact escape hatch.** Gouraud `TRI` and `TEX_TRI`
  batches (rotated gradients and images, 3D subtrees) have no gpui vector
  equivalent, so consecutive batches raster through
  `pocketjs_core::raster` into cached local images at the target density —
  the portable rasterizer used as a sub-backend.

### What the gpui backend guarantees, and what it does not

The frame transaction is unchanged: the host ticks the guest at the fixed
declared rate (one `guest.frame()` + one `surface.tick()` per virtual tick,
never from a paint callback), rendering is a pure function of the DrawList,
and paints are demand-armed off the DrawList content hash — the
pocket-widget governor discipline. `state[n]` is exactly as deterministic
as on every other host.

Pixels are **not** byte-comparable across hosts in native-text mode: glyph
rasterization, metrics and fallback fonts belong to the OS. That is the
"different guarantee gets a different id" rule — `text.layout.native`
instead of `text.glyphs.baked` — and why gpui-hosted apps verify like the
note does (pure-math unit tests over an injected measurer, sim traces,
`--proof` acceptance runs) instead of joining `tests/golden-specs.ts`.

## Native desktop targets

`contracts/spec/platforms.ts` registers `macos-app` and `linux-app` at
hostAbi 4 with `form: "window"`, a dynamic viewport and `acceptsFixed`.
Both profiles use the same generic host. macOS resolves density 2; Linux
resolves density 1. Fixed-viewport console apps run size-locked and
letterboxed with their baked glyph pipeline intact.

```
bun run macos note        # dynamic viewport, baked text, svc editor protocol
bun run macos hero        # fixed 480x272, size-locked, baked glyphs
bun run macos note --proof
```

`tools/macos.ts` resolves the manifest against `macos-app`, writes the
plan, builds the bundle + pak, and derives the capability-shaped host flags
(`--fixed`, `--companions`) from the resolved plan. If the
selected app directory also contains `pocket.system.json`, the tool
resolves every installed package and starts the host with one complete
`ResolvedSystemPlan`; it does not project child plans into command-line
viewport or title fields.
`--editor` is NOT a capability: it enables the note's companion svc adapter
(an app protocol — the profile deliberately registers no
pointer/text/IME/clipboard ids, see contracts/spec/platforms.ts). The host renders only when the DrawList or retained raster revision changes.

## Browser System host

**`web-app` runs every package in an independent same-origin iframe
JavaScript Realm with its own wasm `Ui`.** `hosts/web/system-engine.js`
derives the package catalog, surface handles and lifecycle policy from one
`ResolvedSystemPlan`. Live shell bindings create and remove AppInstances;
focus and visible painter order determine scheduling.

The wasm software compositor retains each visible child framebuffer and
paints it at each `SURFACE_QUAD` position during the host render.
Full bounds determine the child coordinate origin, clip bounds constrain the
visible pixels, and the instruction remains at its original DrawList offset.
Shell chrome emitted after the surface therefore stays above the child. A
missing child raster leaves the shell's loading fallback visible.

## System UI companion input

The host speaks the `system-ui` svc dialect when the resolved System UI plan
declares that companion. The protocol extends the note dialect's input lines with
**right-button mouse lines (`b:2`), alt/ctl key modifiers, F1–F12,
cmd-flagged ⌘ chords, a boot epoch in the hello**, a `{t:"cursor"}` guest
intent that sets the window's pointer shape, and a `{t:"paste-req"}` guest
intent the host answers with a paste line (menu-driven Paste). ⌘Q quits
and ⌘V pastes host-side; every other ⌘ chord reaches the guest, so the
compositor owns its shortcuts (⌘W close, ⌘M minimize, ⌘` cycle windows,
⌘Esc Start menu, ⌘A/C/X editing). Plain typing and IME commits arrive through winit input events as `ch` lines;
preedit remains separate from committed text. **This
companion carries shell UI input, clipboard requests and cursor intents. It
does not carry package lifecycle, focus, per-frame visibility or button
routing.**

The themeable [Pocket Desktop](https://github.com/pocket-stack/pocket-desktop)
product is maintained separately and consumes these contracts as an external
Pocket System. Its manifest owns the app catalog, installation snapshot,
System UI role and background-execution policy. **Every installed entry
reaches the native host as a complete `ResolvedBuildPlan`; ordinary
applications resolve without the System UI-only compositor capability.**

- **`hosts/desktop` implements a generic `AppSupervisor`; the System contract
  does not expose that implementation.** The host contains no product catalog
  or package-name rules. Live `<CompositorSurface package>` bindings create
  one AppInstance with its own `Guest`, QuickJS `Runtime`, QuickJS `Context`,
  `UiSurface` and retained Rust raster inside the existing process. Their globals,
  node trees, textures, clocks and button state are isolated.
- **Compositor surfaces use `SURFACE_QUAD`, not `TEX_QUAD`.** The instruction
  carries the package-surface handle, unclipped bounds, clipped visible bounds
  and focused state. The Rust compositor paints the child at that exact DrawList
  position, so shell content before and after it keeps its painter order and
  clipping never changes the child coordinate origin.
- **AppInstance lifecycle and scheduling come from the shell core's live
  surface bindings.** Destroying a binding removes its instance. Hidden
  instances become `Suspended` under `backgroundExecution: "suspend"`;
  `"continue"` keeps them `Running`. This policy does not govern memory
  residency. Focused visible instances run first, and hardware-neutral buttons
  go only to the top focused surface.
- **A child exception marks only that AppInstance as `Failed`.** The shell and
  sibling instances continue; the host records the package failure without a
  companion hot path.

Scripted acceptance drives the same dialect from flags: `--mouse
X,Y[,d|u|r]@TICK` (drags, right clicks), `--key
[cmd+][alt+][ctl+]NAME@TICK`, `--type TEXT@TICK`.

## Choosing a backend

|                    | portable                                                         | legacy gpui                                        |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------- |
| hosts              | PSP, Vita, PocketBook, ESP32-P4, Symbian, web, sim, macOS widget, macOS/Linux desktop | optional crate, no stock host           |
| text measurement   | core, atlas advance tables                                       | gpui platform text system, per-app opt-in   |
| codepoint coverage | baked charset (+ runtime extension)                              | OS fallback chain, color emoji              |
| pixel determinism  | byte-exact across hosts                                          | per-host; transactions still deterministic  |
| pixel goldens      | `tests/golden-specs.ts`, tape hashes                             | opted out (note-style verification)         |
| rotated/3D content | native                                                           | portable rasterizer as a local sub-backend  |

The desktop benchmark against Tauri and Electron (harness, comparison
apps, results) lives in its own stacked PR — pocket-stack/pocketjs#294.


`hosts/desktop --trace-frames` emits CPU tick, render-submission, worker-total
and presentation-submission timestamps. These durations exclude GPU completion
and display scanout. Use a native input tape and record the binary/package hashes
when comparing renderer changes.
