# Architecture

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

The JavaScript side can be Solid, Vue Vapor, or Octane. Solid uses its
universal renderer; Vue Vapor uses a Vapor renderer adapter and a DOM-shaped
facade for Vue's helpers; Octane compiles JSX and hooks to static host plans
plus dynamic slots whose driver (`renderer-octane.ts`) targets the native tree
with no DOM shim. The rendering, layout, styling, animation, and text engine is
one `no_std` Rust crate (`pocketjs-core`) compiled for each host's target
triple. Styling is a build-time [Tailwind subset](/docs/styling/); fonts are
baked into atlases at build time.

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

1. **`app.tsx`** is ordinary framework JSX: PocketJS components from
   [`@pocketjs/framework/components`](/docs/components/), state/lifecycle from
   `solid-js`, `vue`, or `octane`, and `class` strings from the Tailwind subset.
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
   ticks animations, measures and lays out text, and produces a flat
   **DrawList** each frame.
5. A thin **backend** turns the DrawList into pixels: sceGu/GE on PSP,
   vita2d/GXM on Vita, gpui on `hosts/desktop`, wgpu in the debug uihosts, and
   the deterministic software rasterizer in `engine/core/src/raster.rs` behind
   the browser canvas and the byte-exact PNG goldens.

Everything *above* the backend follows the same contract across targets. The
layout you see in the browser [playground](/playground/) is the same layout,
computed by the same code, that runs on the handheld.

ESP-IDF exposes the same stages as separate libraries — `pocketjs_guest`,
`pocketjs_ui_core`, `pocketjs_ui_qjs`, `pocketjs_render_rgb565`. **Only the
optional runner creates a task; the product BSP owns input, physical buffers,
and presentation.** See [ESP-IDF](/docs/esp-idf/).

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
**`pocketjs-core`**. It contains no I/O, no graphics API, and no timing — just
the tree, layout, styling, animation, text, and DrawList generation. Each
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
JavaScript only *declares* motion (through
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
The compiler scans source text codepoints and combines them with a **fixed
`0`–`9` floor** and the app's declared runtime-text charset. See
[Styling](/docs/styling/) and [Build pipeline](/docs/build-pipeline/) for the
declaration and scan rules.

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

**1. The app + framework runtime (JavaScript).** Your components and reactive
state. The Solid/Vue/Octane adapters keep a lightweight JS *mirror* of the tree —
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
text, ticks animation tracks, and walks the tree into a DrawList. A CPU **clip
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
[Render backends](https://github.com/pocket-stack/pocketjs/blob/main/docs/BACKENDS.md).

The exact op signatures, node lifecycle, and per-frame ordering live on the
[Native contract](/docs/native-contract/) page.

### Modules beyond the UI

The UI is one module in that shape and the other domains reuse it unchanged. A
module is an SDK subpath, a spec, and a native core. Its capability id is the
same string as the spec namespace and the pak prefix: `audio.pcm` means
`globalThis.audio` is mounted and `audio:wav.` pak entries have meaning, so one
name covers the manifest, the runtime namespace, and the asset key.
`contracts/spec/` holds the shipped specs — `audio`, `db`, `fs`, `net`,
`platforms`, `spec`, plus the manifest, package, system and runtime-wire files.
They are plain TypeScript data: `gen-rust.ts` generates
`engine/core/src/spec.rs`, `gen-c.ts` generates
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
[`docs/STRUCTURE.md`](https://github.com/pocket-stack/pocketjs/blob/main/docs/STRUCTURE.md).

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
