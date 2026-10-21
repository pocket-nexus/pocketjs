# Architecture

**PocketJS application sources are TypeScript.** This page describes their
guest build: the compiler emits a JavaScript bundle for the host's execution
engine. Solid TSX and Vue SFC views can also compile to Rust, with either a
compiled TypeScript model or a handwritten Rust model. See
[TypeScript and native code](/docs/microts-boundaries/) for those
execution paths and their host contracts.

The [TypeScript support reference](/docs/typescript-support/) compares the
ordinary application, AOT view and compiled model source rules.

PocketJS turns component code into native pixels through
**one Rust core, framework-specific JS adapters, and one layout engine on every
host.**

`hosts/` holds one directory per host implementation — consoles, phones,
e-readers, a microcontroller, desktop, browser and a headless sim. A smaller
set of those ship as stock build targets, registered in
`contracts/spec/platforms.ts` (`POCKET_TARGETS`); the others build through
their own profile module or a supplied build plan. That registry is the only
record of what a target implements, so read it rather than any list
on this page — see [Platform contracts](/docs/platform-contracts/).

The application's framework can be Solid, Vue Vapor, or Octane. Solid uses its
universal renderer; Vue Vapor uses a Vapor renderer adapter and a DOM-shaped
facade for Vue's helpers; Octane compiles JSX and hooks to static host plans
plus dynamic slots whose driver (`renderer-octane.ts`) targets the native tree
with no DOM shim. The layout, styling, animation, 2D physics, and text engine
live in `pocketjs-core`; software drawing and presentation live in separate
`no_std` Rust crates compiled for each host's target triple. Styling is a
build-time [Tailwind subset](/docs/styling/); fonts are
baked into atlases at build time.

## Driver contracts

The first stage of the driver migration separates shared contracts from the
UI implementation. **`pocket-spec` has no dependencies; `pocket-drivers`
depends on `pocket-spec`.** Both crates use `no_std`. The generated Rust
operation table lives in `engine/spec/src/lib.rs`. `engine/drivers` owns
`DrawList`, `TextBox`, `TexView`, `FontView`, and `RenderResources`.
`pocketjs-core` re-exports these types under their existing paths and keeps
the `RenderResources` implementation for `Ui`.

The driver traits and generated C declarations define display, renderer,
input, and package-source boundaries. **The driver/runtime ABI remains a
candidate contract.** Layout, C/Rust consumer, and deferred-device lifecycle
tests check the implementation; they do not freeze its interface. This
migration retains the application package format and the existing `hostAbi`
meaning. See [Native contract](/docs/native-contract/#driver-contract-migration).

## Application instances and guests

**`pocket-runtime` owns one `CoreState` per application instance.** It retains
`Ui`, the admitted package, asset registrations, guest, input sources, and
renderer/display registrations. Guest callbacks reach that UI through a
cloned `OpContext`; the runtime releases its UI borrow before invoking the
JavaScript engine.

`contracts/spec/ui-ops.ts` describes **61 numbered public calls and six private
host hooks**. Existing operation numbers 1–56 retain their values. The five
added numbers cover property batches, animation completions, font-stream
batches, and text capture. `tools/ui-bindings.ts` generates the dispatcher and
operation descriptors used by `guest-quickjs` and `guest-rquickjs`. Both adapters
perform scalar and string coercion before borrowing a JavaScript byte view.
They omit optional service methods when no provider is registered.

The C adapter provides QuickJS-NG lifecycle callbacks; the Rust adapter
implements the runtime's `Guest` trait. Both retain the eight-argument frame
wire, promise-job draining, host identity, tick rate, viewport, and native asset
tables. **Absent asset tables mean JavaScript must load assets from `__pak`.**
An empty native table means native loading completed without that asset kind.

`pocket-runtime-cabi` owns the instance C entry points and the compatibility
implementations for the old UI and IDF libraries. `engine/ui-cabi` and
`hosts/esp-idf/native/ui-core` retain their library names and delegate to those
implementations, whose UI state uses `CoreState`. The GLES backend now resides
in `engine/runtime-cabi/src/compat/ui/gl`. Existing C guest entry points use
`pocket_legacy_runtime_*` symbols; the old rquickjs `UiSurface` remains available
while hosts migrate to instance registration.

The presentation coordinator keeps borrowed resources alive until renderer
and display work reaches a terminal state. **It redraws each acquired CPU
region in full.** Persistent display-buffer identities are required before
this path can reuse a previous buffer's damage history. Existing host damage
APIs retain their compatibility paths.

## Core extraction

**Rendering, presentation, package parsing, and media parsing do not depend
on the UI core.** Their callers supply resource views or borrowed bytes.

| Crate | Source | Responsibility |
| --- | --- | --- |
| `pocket-raster` | `engine/raster` | DrawList interpretation and software pixel output |
| `pocket-present` | `engine/present` | Damage history, prepare/commit/abort transactions, incremental drawing, and surface composition |
| `pocket-package` | `engine/package` | Package admission, variant selection, pak entries, build facts, and SHA-256 |
| `pocket-media` | `engine/modules/media` | Stream containers, transport messages, RAM stream assembly, and byte codecs |

`pocket-present` calls `pocket-raster` for software drawing. Both consume
`RenderResources` from `pocket-drivers`; neither requires a `Ui` instance.
**The core keeps compatibility exports at the existing module paths.**
Hosts can continue importing `pocketjs_core::raster`, `damage`, `compositor`,
`package`, `pak`, `sha256`, `plan_facts`, `stream`, `stream_rx`, `wire`, and
`codec` while their implementations reside in the new crates. Package bytes,
admission checks, and DrawList encoding retain their existing formats.

## Rendering utilities

**The rendering utilities use `no_std` and have no dependency on the UI core
or each other.** Drivers select the utilities they need.

| Crate | Mechanism |
| --- | --- |
| `pocket-draw-ops` | Borrows operation words, validates record lengths, and attaches the current absolute clip |
| `pocket-tri-batch` | Constructs driver-defined vertices and merges adjacent ranges with equal texture and clip keys |
| `pocket-glyph-pages` | Expands A8 pages and masks, and retains ABGR4444 pages by submission |
| `pocket-tex-cache` | Keeps device texture versions alive until their last referencing submission retires |

`pocket-raster::RasterRenderer` implements the driver trait for RGBA8888,
ARGB8888, and RGB565 CPU targets. **It writes only the acquired region and
honors its byte stride**, including RGB565 slices without word alignment.
Its scale is a constructor parameter. `render_operation` draws one operation
over the existing pixels, after the caller has completed earlier accelerator
work and made the target cache visible. Native text and surface composition
remain separate host responsibilities.

The GLES backend uses the shared triangle construction and batching code.
The core's glyph texture preparation and the RGB565 glyph mask path use
`pocket-glyph-pages`. Existing host entry points remain available during the
runtime migration.

## The pipeline

```
        app.tsx  (Solid, Vue Vapor or Octane + Tailwind-subset classes)
           │
           │  framework JSX transform   (two-pass build)
           ▼
   ┌────────────────────────────────────────────────┐
   │  bundle.js   +   styles.bin + atlases + images  │
   │      │                     │                     │
   │      │                     └──► app.pak        │
   └──────┼──────────────────────────────────────────┘
          │
   ┌──────┴──────────────────┐   ┌──────────────────────────┐
   │ QuickJS device hosts    │   │ browser / desktop / Bun   │
   │    framework runtime    │   │    framework runtime      │
   │      │ ui.* ops         │   │      │ same ui.* ops      │
   │      ▼                  │   │      ▼                    │
   │  pocketjs-core          │   │  pocketjs-core            │
   │  (Rust, no_std)         │   │  (same Rust → wasm32)     │
   │  tree · taffy · anim    │   │  tree · taffy · anim      │
   │  · text                 │   │  · text                   │
   │      │ DrawList         │   │      │ DrawList           │
   │      ▼                  │   │      ▼                    │
   │ GE or GXM backend       │   │ software or wgpu backend  │
   └─────────────────────────┘   │   → canvas / PNG / window │
                                 └───────────────────────────┘
```

Reading it top to bottom:

1. **`app.tsx`** contains TypeScript and framework JSX: PocketJS components
   and lifecycle APIs come from `@pocketjs/framework/*`, framework primitives
   come from `solid-js`, `vue`, or `octane`, and `class` strings use the
   Tailwind subset.
2. A product **build** resolves `pocket.json` for one target, then runs the
   selected JSX transform, compiles class strings to a binary style table
   (`styles.bin`), bakes target-density glyph atlases/assets, and packs them
   into `app.pak`. The JS is bundled with target/ABI constants. The low-level
   `bun tools/build.ts <app>` path remains for framework development. See
   [Build pipeline](/docs/build-pipeline/) for the two-pass details.
3. At **runtime**, the selected framework runtime executes on whichever JS
   engine the host provides — QuickJS on the device hosts, the host engine in
   the browser or Bun — and emits mutation ops (`ui.*`) into `pocketjs-core`.
4. **`pocketjs-core`** owns the retained UI tree: it runs flexbox layout,
   ticks animations, steps 2D physics worlds, measures and lays out text, and produces a flat
   **DrawList** each frame.
5. A **renderer** consumes the DrawList and borrowed resources: sceGu/GE on PSP,
   GXM on Vita, wgpu in the desktop host, and
   the deterministic software rasterizer in `engine/raster/src/lib.rs` behind
   the browser canvas and the byte-exact PNG goldens.

Everything *above* the backend follows the same contract across targets. The
layout you see in the browser [playground](/playground/) is the same layout,
computed by the same code, that runs on the handheld.

ESP-IDF composes `pocket_runtime`, `pocket_guest_quickjs`,
`pocket_display_esp_lcd` and `pocket_render_esp_ppa`. **One Rust archive owns
the runtime and renderer; the product registers its input, LCD and PPA
instances.** The optional `pocket_runner` creates the FreeRTOS task and uses
the shared tick schedule. See [ESP-IDF](/docs/esp-idf/).

## Why these choices

### Framework adapters over HostOps

PocketJS keeps framework code above a small renderer adapter boundary. Solid
uses `babel-preset-solid` with `generate: 'universal'`; Vue Vapor uses
`vue-jsx-vapor` and `renderer-vue-vapor.ts`; Octane uses its universal
compiler against the "pocket" renderer descriptor and `renderer-octane.ts`.
All three adapters target the same JS
mirror tree and `ui.*` HostOps, so the Rust core, input manager, style table,
animation system, `.pak` format, and native targets do not fork by framework.

The universal renderer means Solid never touches the DOM. Instead it calls a
small set of node operations (`createNode`, `insertBefore`, `setProperty`,
`replaceText`, …) that PocketJS maps onto the native `ui.*` contract. Solid's
distributed runtime references no `window`, `document`, `setTimeout`,
`WeakRef`, or `FinalizationRegistry`; it needs `Proxy`, `WeakMap`, `Promise`,
and `queueMicrotask`, and the last of those is polyfilled onto the promise job
queue.

### QuickJS reality: ES2023, minus timers

On the PSP the JavaScript engine is **QuickJS** (Bellard's engine, the
`2026-06-04` build), which is roughly **ES2023**. Modern syntax works — logical
assignment operators, `WeakRef`, and `FinalizationRegistry` are available.
PocketJS node lifetime does not depend on garbage-collector timing: the mirror
tree uses an explicit end-of-frame sweep plus `retain` / `release` for detached
subtrees.

What is *not* there shapes the API surface:

| Missing on QuickJS | Consequence |
|---|---|
| `queueMicrotask` | Polyfilled via `Promise.resolve().then(...)`; the host drains the promise job queue once per frame. |
| `setTimeout` / `clearTimeout` | `framework/src/scheduler-polyfill.ts` installs both where absent — `setTimeout` **lowers to a microtask and ignores its delay**, `clearTimeout` is a no-op. There is no wall-clock scheduling; use [`onFrame`](/docs/animation/) or `after()`. |
| `MessageChannel`, `performance` | Absent. Timing is frame-index based. |

That polyfill is the prelude for Vue Vapor (`framework/src/prelude.ts`) and is
itself Octane's prelude, because both runtimes' scheduler modules read the
globals at module evaluation time.

Because there is no timer or microtask *scheduler*, three Solid imports are
rejected by the compiler — `createResource`, `useTransition`, and
`startTransition` (`BANNED_SOLID_IMPORTS` in
`framework/compiler/jsx-plugin.ts`) — so a build fails rather than a device.
Browser and Bun development builds stay inside the same syntax and scheduler
subset. Target compatibility is checked separately from the manifest's required
APIs and viewport contract, so a touch-required Vita app is rejected for PSP
before compilation.

### taffy 0.11 for layout

Flexbox is computed by **taffy 0.11**, built with
`default-features = false` and the `alloc`, `taffy_tree`, `flexbox`, and
`content_size` features. That configuration is verified `no_std` + `alloc`,
f32-only, and needs no `libm`, which is exactly what a bare-metal PSP binary
requires. Using a real, tested layout engine — rather than a hand-rolled
subset — is why layout is identical on every host.

### One Rust core, compiled per host

`engine/core/` is a platform-agnostic `#![no_std]` + `alloc` library,
**`pocketjs-core`**. It contains no I/O, no graphics API, and no timing: the
tree, layout, styling, animation, 2D physics, text, and DrawList generation. Each
directory under `hosts/` gives it a body: it compiles the same crate for its
target triple and supplies I/O, a JS engine, and a backend. `hosts/psp` embeds
QuickJS and renders through `sceGu`; `engine/wasm` wraps the identical core
with the software rasterizer in one `wasm32-unknown-unknown` cdylib that serves
both the browser dev host and the headless Bun goldens; `hosts/desktop` drives
gpui behind the `macos-app` and `linux-app` targets. Native hosts consume the
same stable `HostBuildInputs` projection.

### Native animation on a fixed core clock

Tweens and springs tick inside Rust in exact **`dt = 1/hz s`** steps. `hz` is a
per-realm declaration, not a constant: `engine/core/src/lib.rs` defaults to
`DEFAULT_TICK_HZ` 60 and caps at `MAX_TICK_HZ` 240, and `Ui::set_tick_rate`
is refused once the first `tick()` has run, so the rate is fixed for the whole
run. A bundle bakes its rate at build time (`--hz=N`, 1 through 240) and
refuses to mount on a host whose `ui.__tickHz` disagrees. One core tick per
virtual frame is the common case; a slower simulation rate advances several.
TypeScript application code declares motion (through
[`@pocketjs/framework/animation`](/docs/animation/) or `transition-*` classes);
it never drives it frame by frame.

Given the same build, simulation-rate policy, input tape, and frame-boundary
effect deliveries, those discrete ticks follow the same trajectory. That is
what makes the PNG golden tests exact rather than fuzzy — the `wasm32`
rasterizer and the goldens agree down to the pixel.

### Baked text

The portable path carries no runtime font files. At build time an
`opentype.js`-based baker turns each glyph the app uses into a
horizontally-supersampled 8-bit coverage cell, plus proportional advances and a
cmap. On device, drawing text means run-length-extracting the alpha coverage
and batching it into GE sprites, with no glyph rasterization at runtime.
Because only the used glyphs are baked, the compiler scans your source for text
codepoints during the build — see [Styling](/docs/styling/) and
[Build pipeline](/docs/build-pipeline/).

The defaults in `framework/compiler/bake-font.ts` are **Inter** for regular and
bold and **JetBrains Mono** for the `font-mono` slots, chosen per slot at bake
time; `assets/fonts/` also vendors InterDisplay and W95FA, and each face can be
overridden per build. Two capabilities lift the baked-charset limit: a host
with `text.glyphs.runtime` extends the atlases at runtime for codepoints
outside the baked set, and one with `text.layout.native` measures and shapes
through the host text system instead, covering whatever the OS font fallback
chain covers.

## The three layers

PocketJS is three layers with narrow contracts between them.

**1. The TypeScript app and framework runtime.** The guest build emits an
engine bundle containing the components and reactive state. The
Solid/Vue/Octane adapters keep a JS *mirror* of the tree —
`{ id, parent, children[], … }` — so the reconciler can *read* tree structure
without crossing the FFI boundary.
Only *mutations* cross into native. `setProperty` runs through a dispatch table:
`className` → style id, `on*` → the input registry, `src` → the texture
registry, a `style={{…}}` object → per-key property ids (previous-value
diffed). Anything unrecognized is a loud dev-time error rather than a silent
no-op.

**2. `pocketjs-core` (Rust, `no_std`).** The retained tree lives in a node arena
(`Vec<Node>` + free list) with a **generation counter**, so a stale handle is a
safe no-op rather than a dangling reference. Core parses the style table,
resolves `base` / `focus` / `active` variants, syncs nodes into taffy, measures
text, ticks animation tracks, steps physics worlds, and walks the tree into a DrawList. A CPU **clip
stage** in `draw.rs` guarantees no negative or oversized coordinates ever reach
a backend — axis-aligned quads are clipped with UV/color re-interpolation,
rotated quads are Sutherland–Hodgman-clipped or culled.

**3. The backend.** Consumes the DrawList and nothing else. PSP uses `sceGu`,
Vita uses vita2d/GXM, `hosts/desktop` uses the gpui backend
(`engine/backends/gpui`), the debug uihosts use wgpu, and `wasm32` uses a
scanline rasterizer that handles blending, gradients, and glyph coverage
deterministically. Backends do not redefine input or styling semantics, and
they differ from each other in one capability alone: **who measures and
shapes text**. An app that enhances with `text.layout.native` gets a core text
measurer installed before the guest mounts, so taffy leaf sizes, `measureText`
and painted glyphs all come from the host text system — layout changes with the
backend in that one case, and only for apps that asked for it. The rest are
byte-identical, which is what the PNG goldens pin. See
[Render backends](https://github.com/pocket-nexus/pocketjs/blob/main/docs/BACKENDS.md).

The exact op signatures, node lifecycle, and per-frame ordering live on the
[Native contract](/docs/native-contract/) page.

### Modules beyond the UI

The UI is one module in that shape and the other domains reuse it unchanged. A
module is an SDK subpath, a spec, and a native core. Its capability id is the
same string as the spec namespace and the pak prefix: `audio.pcm` means
`globalThis.audio` is mounted and `audio:wav.` pak entries have meaning, so one
name covers the manifest, the runtime namespace, and the asset key.
`contracts/spec/` holds the shipped specs — `audio`, `db`, `fs`, `net`,
`physics`, `platforms`, `spec`, plus the manifest, package, system and runtime-wire files.
They are plain TypeScript data: `gen-rust.ts` generates
`engine/spec/src/lib.rs`, `gen-c.ts` generates
`contracts/generated/pocket_spec.h`, and `tests/contract.ts` regenerates both
in memory and byte-compares them against the committed files, so the three
languages cannot drift.

The guest has one clock, the tick. A module whose domain cannot wait for a
frame — real-time audio output is the shipped case — declares a native-side
clock in its frame contract: it never calls the guest, never blocks on it, and
batches its facts to tick boundaries for delivery. On virtual-clock hosts the
same module consumes by a pinned per-tick formula instead of a device callback,
so a two-clock module keeps a byte-reproducible headless test path.

## Repository layout

One axis per top-level directory. The tree and the rule that governs it live in
[`docs/STRUCTURE.md`](https://github.com/pocket-nexus/pocketjs/blob/main/docs/STRUCTURE.md).

## Memory (PSP)

The PSP build replaces `rust-psp`'s default `#[global_allocator]`, which makes
one kernel object per allocation and caps out long before a real UI tree is
built, with one backed by a single arena (`hosts/psp/src/alloc.rs` over
`arena.rs`) — the same kernel block QuickJS, newlib and the core's textures and
retained buffers all draw from. The public **8 MB** figure names that
application arena with its safety headroom, not the PSP's whole main memory:
code and embedded `.pak`/JS bytes live in the EBOOT image, the worker stack is
separate, and display framebuffers come from VRAM. The allocator setup, the
per-frame vertex bump pool, and the exact PSP frame order are on the
[Native contract](/docs/native-contract/) page.
