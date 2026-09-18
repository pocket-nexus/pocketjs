# PocketJS — a JSX UI stack for the Sony PSP (and beyond)

**One Rust core. One JSX app. Runs on real PSP hardware, PPSSPP, the browser, and headless Bun.**

PocketJS is a standalone cross-platform UI engine: a retained-mode native UI tree
(Rust: flexbox layout, styling, animation, text, rendering) driven from
JavaScript (QuickJS on PSP, the host JS engine elsewhere) by **Solid** through
its universal renderer, styled with a **build-time Tailwind-subset compiler**,
with **baked font atlases** for text. It is a standalone repository and has no
DreamCart or sibling-checkout build dependency. Some early low-level patterns
were derived from the DreamCart runtime; provenance comments remain where they
help explain the hardware constraints.

This design was adversarially reviewed by three independent audits (PSP-native
feasibility, Solid-universal correctness, framework/compiler/pipeline); every confirmed
finding is folded in below and marked **[R]**.

```
        app.tsx  (Solid + Tailwind classes)
           │  babel-preset-solid {generate:'universal'}  (two-pass build)
           ▼
        bundle.js      styles.bin + font atlases + images ──► app.pak
           │
   ┌── QuickJS (PSP) ──────────┐   ┌── browser / Bun ────────┐
   │ Solid runtime             │   │ Solid runtime           │
   │   │ createNode/setStyle…  │   │   │ same ui.* ops       │
   │   ▼                       │   │   ▼                     │
   │ ui-core (Rust, no_std)    │   │ ui-core (same Rust,     │
   │  tree·taffy·anim·text     │   │   compiled to WASM)     │
   │   │ DrawList              │   │   │ DrawList            │
   │   ▼                       │   │   ▼                     │
   │ sceGu backend (GE)        │   │ software rasterizer     │
   └───────────────────────────┘   │  → canvas / PNG golden  │
                                   └─────────────────────────┘
```

## Why these choices

Decisions grounded in a full audit of the dreamcart runtime (research
artifacts: `$JOB_TMP/map-*.json`).

- **Solid + universal renderer** (`solid-js@1.9.x`, `babel-preset-solid@1.9.x`
  `{generate:'universal', moduleName:<ABSOLUTE path to framework/src/renderer.ts>}` —
  moduleName is emitted verbatim into every file, so it must be absolute or a
  bundler-aliased bare specifier **[R]**): no VDOM — updates run only the
  effect closures of changed signals. Verified: Solid's dist references no
  `window`/`document`/`setTimeout`/`WeakRef`; needs Proxy, WeakMap, Promise.
  Prior art: Lightning TV, `@opentui/solid`. Preact+DOM-shim is the fallback.
- **QuickJS reality [R]**: the linked engine (exact-revision
  `pocket-stack/quickjs-rs` Cargo dependency) is
  **Bellard 2025 (VERSION 2026-06-04), ~ES2023** — logical assignment, WeakRef
  and **FinalizationRegistry are available**. Still absent: `queueMicrotask`
  (polyfill via `Promise.resolve().then`), `setTimeout`, `MessageChannel`,
  `performance` — so Solid's `createResource`/transitions/`enableScheduling`
  remain off-limits on PSP (compiler lints on import).
- **taffy 0.11** (`default-features=false, features=["alloc","taffy_tree","flexbox","content_size"]`):
  verified `no_std`+alloc, f32-only, no libm. Fallback: hand-rolled flexbox
  subset — only if code size or hardware measurement disqualifies it.
- **Rust core compiled twice**: `engine/core/` is a platform-agnostic `no_std` lib.
  PSP bin wraps it with QuickJS + sceGu; `wasm32-unknown-unknown` build wraps
  it with a deterministic software rasterizer used by BOTH the browser dev
  host and headless Bun goldens. One layout engine everywhere.
- **Damage is backend-independent**: `engine/core/src/damage.rs` compares
  retained DrawLists and returns logical damage regions for one persistent
  framebuffer. RGBA8, PPA-memory ARGB8 and RGB565 software paths clear each
  region and replay the complete DrawList under a root clip; framebuffer
  format/scale signatures and `Ui::raster_revision()` prevent stale reuse.
  Region limits and full-redraw thresholds remain backend policy.
- **ESP32-P4 stays 16-bit**: `engine/backends/rgb565/` consumes the same
  DrawList into an opaque RGB565 target. It maps flat fills, A8 coverage
  blending, and compatible PSM 5650 texture transforms to the PPA, then
  preserves ordering with the core RGB565 rasterizer for unsupported ops.
  It never allocates a full-frame RGB888/ARGB8888 intermediate.
- **Native animation**: tweens/springs tick in Rust per vblank with **fixed
  dt = 1/60 s** (frame content is a pure function of frame index — this is
  what makes byte-exact goldens possible **[R]**). JS only declares motion.
- **Baked text**: opentype.js atlas baker → horizontally-supersampled 8-bit
  coverage cells + proportional advances + cmap; native draw = alpha run-length
  extraction into batched GE sprites. Font: **Inter** (OFL), vendored in
  `assets/fonts/`.

## Repository layout

```
PocketJS/
  DESIGN.md, README.md
  package.json         self-contained; PINNED: solid-js@^1.9, babel-preset-solid@^1.9,
                       @babel/core@^7 (Babel 8 breaks preset-solid [R]),
                       @babel/preset-typescript@^7 (required for .tsx [R]), opentype.js, typescript
  tsconfig.json        jsx:'preserve' (babel owns the transform); editors typecheck only [R]
  framework/src/jsx.d.ts         JSX component typing only; public primitives live in framework/src/primitives.ts [R]
  assets/fonts/        Inter-Regular.ttf, Inter-Bold.ttf (+ OFL LICENSE)
  contracts/spec/
    spec.ts            SINGLE SOURCE OF TRUTH: op codes, prop ids, enums,
                       style-table format, atlas format, DrawList format,
                       pak container constants (magic/header/entry/align/fnv1a) [R]
    gen-rust.ts        codegen → engine/core/src/spec.rs (committed)
  engine/core/                Rust lib `pocketjs-core` — #![no_std] + alloc
    framework/src/lib.rs         pub struct Ui: apply-ops, tick(1/60), draw() → &DrawList
    framework/src/spec.rs        GENERATED — tests/contract.ts re-runs gen-rust.ts and
                       byte-compares this file (airtight drift guard) [R]
    framework/src/tree.rs        node arena: Vec<Node> + free list + GENERATION COUNTER
                       (ids are (gen<<20)|slot; stale ids are no-ops) [R]
    framework/src/style.rs       style table parse/resolve; base/focus/active variants
    framework/src/layout.rs      taffy sync + text measure closures + dirty tracking;
                       empty text nodes are excluded from the taffy tree [R]
    framework/src/text.rs        atlas registry, cmap (miss → gid 0 tofu + miss counter [R]),
                       measurement, inline-run layout
    framework/src/anim.rs        tween/spring tracks; transitions on style swap; fixed dt
    framework/src/draw.rs        tree walk → DrawList + CPU CLIP STAGE: axis-aligned clip
                       with UV/color re-interpolation for textured/gradient quads;
                       rotated quads Sutherland-Hodgman-clipped (or culled) so no
                       negative/oversized coords ever reach a backend [R]
    framework/src/raster.rs      shared deterministic software rasterizer used by WASM
                       goldens and Vita guest-side capture
  hosts/psp/              Rust bin `pocketjs-psp` — the EBOOT (standalone dir, lone bin)
    Cargo.toml         exact-revision pocket-stack psp + libquickjs-sys deps;
                       pocketjs-core (local path)
    build.rs           embeds $POCKETJS_APP_OUTPUT js + app.pak when the stock backend owns packaging;
                       [features] capture = [] for the E2E frame-dump
    targets/mipsel-sony-psp.json  copied from runtime/ (self-contained)
    framework/src/main.rs        boot (2MB USER|VFPU worker), vblank loop, job pump
    framework/src/alloc.rs       #[global_allocator] backed by the arena [R] — see Memory
    framework/src/arena.rs       ┐ copied from dreamcart runtime; ensure_init changed to
    framework/src/c_heap.rs      ├ call sceKernelAllocPartitionMemory DIRECTLY (no recursion
    framework/src/qjs_alloc.rs   ┘ through alloc::alloc now that arena IS the global) [R]
    framework/src/ffi.rs         QuickJS ui.* bindings → core ops
    framework/src/ge.rs          DrawList → sceGu; PER-FRAME BUMP VERTEX ARENA (Vec<Chunk16>
                       pool allocated at boot, reset after sceGuSync — never reuse
                       a region within a frame; GE reads async in Direct mode) [R]
    framework/src/pak.rs       native read-only .pak walker: styles + atlases + images +
                       sprite atlases are fed to core DIRECTLY from include_bytes!
                       before JS eval (zero QuickJS-heap transit); image + sprite
                       handles are exposed as ui.__textures / ui.__sprites [R]
  engine/wasm/                Rust cdylib `pocketjs-wasm` — core + rasterizer, no wasm-bindgen
    framework/src/lib.rs         extern "C" op mirror + byte-exact render() at 480×272;
                       renderScaled(1..4) rasterizes directly at physical density;
                       opt-in incremental exports retain and repaint damage regions
  engine/core/src/damage.rs   DrawList diff, logical damage plans and per-target snapshots
  engine/core/src/raster.rs   shared deterministic scanline rasterizer used by wasm and
                       native capture (full and region-clipped RGBA/ARGB/RGB565)
  framework/src/                 TS/JS runtime shared by all hosts
    renderer.ts        Solid universal createRenderer; JS mirror tree; setProperty
                       DISPATCH TABLE [R]: class→styleId, on*→input registry,
                       src→texture registry, style object→per-key propId (prev-diffed);
                       classList / on: / bool: / unknown → loud dev error.
                       NODE RECLAMATION [R]: end-of-frame sweep destroys subtrees
                       removed and not re-attached during the frame; retain()/release()
                       escape hatch; FinalizationRegistry as backstop tier.
    host.ts            HostOps interface + PSP(globalThis.ui) / wasm bindings
    pak.ts           QuickJS-safe reader (fromCharCode, NO TextDecoder) — web/test
                       hosts load styles/atlases through ops; PSP does it natively [R]
    styles.ts          class-string → styleId map (imports generated table)
    input.ts           edge-detect, focus manager (refocus on removal:
                       next sibling → prev → nearest focusable ancestor [R]), onPress
    anim.ts            animate()/spring() typed API
    index.ts           render(), signals re-export
  framework/compiler/
    jsx-plugin.ts      babel transformAsync per framework: Solid gets
                       [[babel-preset-solid,{generate:'universal',moduleName}],
                       [@babel/preset-typescript]], Vue Vapor gets vue-jsx-vapor +
                       preset-typescript, Octane gets the octane universal compiler
                       (static host plans + dynamic slots) retargeted at
                       renderer-octane.ts; ALSO collects, per file, class strings + text
                       codepoints FROM THE AST (StringLiteral + TemplateLiteral quasis —
                       JSX text compiles to template literals [R]); lints: classList attr,
                       interpolated class, HTML entities in JSX text, solid
                       createResource/transition imports
    vue-sfc-compile.ts .vue → inline Vapor render function via @vue/compiler-sfc
                       (comments stripped at the SFC parse [R]); the emitted template is
                       ordinary string literals, so the collector above needs no
                       template-specific walk
    tailwind.ts        token parser + style-table compiler → styles.bin + styles.generated.ts;
                       a literal becomes a style record iff EVERY whitespace-separated
                       token parses as a supported utility (else ignored) [R]
    bake-font.ts       atlas baker (charset from numeric 0-9 floor + AST scan +
                       app.runtimeText/extraChars [R]; gid 0 = tofu box)
    pak.ts           writer (standalone; constants imported from contracts/spec/spec.ts)
  hosts/web/
    index.html         480×272 canvas playground, virtual buttons, demo picker
    engine.js          loads wasm, HostOps, rAF loop (fixed-step), keyboard map
    serve.ts           static Bun.serve dev server (no livereload; rebuild + reload manually)
  apps/
    hero/, cards/, stats/, library/, settings/, notifications/, music/
                       each demo has app.tsx + main.tsx (mount entry)
  tests/
    contract.ts        spec drift guard (regen + byte-compare) + engine constants
    golden.ts          headless Bun: wasm rasterizer, scripted input, byte-exact PNGs
    goldens/           *.png (wasm rasterizer goldens)
    goldens/psp/       *.png + PPSSPP-COMMIT.txt (emulator build stamp [R])
    tests/e2e/ppsspp.ts      EBOOT (capture) → PPSSPPHeadless → frames vs goldens/psp/
  tools/
    build.ts           TWO-PASS build [R] — see Build pipeline
    psp.ts             build.ts + cargo psp (env from runtime/build.ts) → EBOOT
    dev.ts             one-shot: wasm build + demo build(s) + serve
    wasm.ts            cargo build --target wasm32-unknown-unknown --release
```

## Build pipeline (two-pass — fixes the scan cycle [R])

`tools/build.ts <app>`:

1. **Pass 1 — transform & collect.** For every `.tsx`/`.ts` source reachable
   from the app entry, run the babel transform (cached by content hash). The
   plugin collects per-file: (a) candidate class strings, (b) text codepoints
   — both from AST literals *and template quasis*, never regex over quotes.
2. **Compile styles & fonts.** `tailwind.ts` validates tokens (all-or-nothing
   per literal), assigns styleIds, writes `styles.bin`, and keeps an ignored
   `styles.generated.ts` mirror for inspection (excluded from future scans).
   `bake-font.ts` bakes atlas slots for the **numeric 0-9 floor**, the collected
   charset, and characters declared by `app.runtimeText` or `--extra-chars`.
   Apps that receive host-service or text-input data must declare that runtime
   charset; the build rejects detected input paths without a declaration.
   `pak.ts` packs styles.bin + atlases + images → `<app>.pak`.
3. **Pass 2 — bundle.** `Bun.build` with an onLoad plugin that serves the
   *cached* pass-1 transforms plus this build's in-memory generated style
   module, `format:"iife"`, `minify:{whitespace:true, identifiers:false,
   syntax:false}`, `target:"browser"`. Output `<app>.js` next to the pak.
   Bun removes comments and layout whitespace and may omit ASI-safe semicolons;
   identifier renaming and syntax transforms stay off. Esbuild output built
   with `minify: true` overflowed an ESP32-P4 QuickJS task's 8 KB parse stack; another
   variant parsed for four minutes and hit its five-second watchdog. That
   device required whitespace-only output and a 64 KB task stack (see the
   pocket-pi-on-esp32-p4 blog post).
   Parallel builds therefore cannot import one another's transient style
   table.

The PSP build (`tools/psp.ts`) then runs `rustup run nightly-2026-05-28
cargo psp` with the exact env block from `runtime/build.ts` (LLVM PATH,
TARGET_CFLAGS, AR_mipsel_sony_psp=llvm-ar, RUST_PSP_TARGET, RUST_PSP_ABORT_ONLY,
RUSTFLAGS `-A linker-messages …`), `POCKETJS_APP_OUTPUT=<app>` and
`POCKETJS_EMBED_APP=1` consumed by the stock runtime `build.rs`.
`POCKETJS_OUTPUT_DIR` carries the CLI artifact directory without putting a
machine-local path into the checksummed build plan.

## The native contract (`ui.*`)

Mutation-only ops; the Solid renderer keeps a JS mirror tree (`{id, parent,
children[], …}`) so reconciler *reads* never cross the FFI. Handles are `i32`
**generation-tagged** ids; node 1 = pre-created root (full-screen flex column).

| op | signature | notes |
|---|---|---|
| createNode | `(type:i32) → id` | 0=view 1=text 2=image 3=compositor surface |
| destroyNode | `(id)` | subtree; frees anim tracks; clears focus if inside **[R]** |
| insertBefore | `(parent, child, anchorOr0)` | **DOM move semantics: if child is attached anywhere, unlink first** (core tree + taffy + JS mirror) **[R]**; append when anchor=0; silently no-ops past `MAX_TREE_DEPTH` (spec, 64) so recursive tree walks stay stack-bounded on PSP |
| removeChild | `(parent, child)` | keeps node alive (Solid re-inserts); renderer sweep destroys it at frame end if still detached |
| setStyle | `(id, styleId)` | triggers transitions (old→new animatable diff) |
| setProp | `(id, propId:i32, value:f64)` | dynamic single prop (colors as u32 bits) |
| setText | `(id, str)` | UTF-8; text nodes only |
| replaceText | `(id, str)` | Solid universal calls this on text updates |
| uploadTexture | `(buf, w, h, psm) → handle` | pow2 ≤512, copied + 16B-aligned |
| setImage | `(id, texHandle)` | texHandle < 0 clears (handles are 0-based: 0 is the first upload); also clears any sprite binding |
| setCompositorSurface | `(id, surfaceHandle, focused)` | binds a type-3 node to a Pocket System application surface; emits `SURFACE_QUAD` with full geometry, clipped geometry and focus at the node's exact painter position. Surface handles use a separate namespace from textures |
| setSprite | `(id, atlas, frames, cols, step)` | binds an ANIMATED SPRITE ATLAS to an image node: the atlas texture holds a `cols`-wide grid of `frames` cells; the core auto-plays it, drawing cell `(frame−start)/step % frames` as a TEX_QUAD UV sub-rect — derived at draw time from the vblank counter, so zero per-frame JS and byte-exact goldens. `frames ≤ 0` clears **[R]** |
| animate | `(id, propId, to:f64, durMs, easing, delayMs) → animId` | from = current |
| cancelAnim | `(animId)` | |
| setFocus | `(idOr0)` | applies `focus:` variant natively |
| loadStyles / loadFontAtlas | `(buf …)` | **web/test hosts only** — on PSP, hosts/psp/src/pak.rs feeds core directly from include_bytes! **[R]** |
| measureText | `(str, fontSlot) → width` | JS convenience; layout measures natively |
| wrapText | `(str, fontSlot, maxW) → u32[]` | soft-wrap break columns for one line (ascending UTF-16 indices, empty = fits): greedy word wrap over the slot's measure provider; native-text hosts install the host text system's wrapper (gpui LineWrapper) and its positions win. Optional — apps fall back to the same greedy rules over measureText |
| loadTileTexture | `(pakKey, tileIndex) → handle` | decode ONE tile of a TILESET pak entry (spec.ts) into a CLUT8 texture, host-side — on PSP straight from `.rodata`, zero JS-heap transit. Hosts without it: the runtime falls back to `__pak` + uploadTexture (framework/src/tiles.ts) |
| freeTexture | `(handle)` | releases a texture slot. Texture handles are **generation-tagged** like node ids (spec `TEX_SLOT_BITS`): a stale handle resolves to nothing and draws nothing — tile churn cannot sample a stranger's texture |
| uploadImgEntry | `(blob) → handle` | self-contained IMG entry upload (v2: PSM_T8 palette, PackBits-RLE + linear-filter flags parsed core-side) |

**Text model [R].** A `<text>` element lays out its text-node children as one
concatenated inline run (single measure, not N flex items). Text nodes inherit
the resolved text style (font slot, color, tracking, align) from the nearest
ancestor that sets text props; bare strings under `<view>` get the inherited
default. Empty text nodes (Solid's `<Show>` markers) are excluded from layout
until `replaceText` makes them non-empty.

Application code should not write those lower-case host tags directly. The
public SDK surface is imported from `PocketJS` and uses React Native-style
`View`, `Text`, and `Image` primitives; the lower-case tags remain an internal
renderer target for `framework/src/primitives.ts` and low-level tests.

**Analog nub.** The frame entry point is `frame(buttons, analog?)`: `analog`
packs the stick as `(x << 8) | y` (0..255 per axis, 128 center — spec
`ANALOG_CENTER`). Stickless hosts pass one argument and the runtime holds
center, so pre-analog tapes and goldens are unchanged; deadzone policy lives
in the runtime (`analogX()/analogY()` from `PocketJS/lifecycle`), never in
hosts. The DevTools flight recorder tapes the analog track alongside the
masks (omitted while centered — old tape files stay byte-identical).

**Frame order (PSP).** `sceCtrlRead → sceGuStart → JS frame(buttons) → drain
jobs (while JS_ExecutePendingJob(rt,&mut ctx)>0 — declare the symbol in a local
extern block, the curated libquickjs-sys omits it [R]) → renderer end-of-frame
sweep runs inside frame() → core.tick(1/60): anims → layout if dirty → DrawList
→ ge::render → sceGuFinish/Sync/WaitVblank/Swap`. Backends never call
sceGuStart/Finish (display list owned by main.rs, dreamcart contract).

## Memory (the blocker fix [R])

rust-psp installs a `#[global_allocator]` that makes **one kernel object per
allocation** (cap ≈4096 → crash). The QuickJS-side arena trio only hooks
QuickJS + newlib malloc — it does NOT cover pocketjs-core's Rust allocations
(taffy slotmaps, children Vecs, per-pass `.collect()`s, DrawList). Therefore:

1. The pinned `pocket-stack/rust-psp` fork exposes an
   **`external-global-alloc`** feature:
   cfg-gate `psp/src/alloc_impl.rs`'s `#[global_allocator]` out.
2. `hosts/psp/src/alloc.rs` installs the PocketJS global allocator backed by
   `arena::alloc/dealloc` (same single kernel block as QuickJS).
3. `arena.rs`'s `ensure_init` must call `sceKernelAllocPartitionMemory` /
   `sceKernelGetBlockHeadAddr` directly (no recursion through `alloc::alloc`).
4. Texture uploads and retained core buffers live in the same arena — the old
   "4 MB margin" no longer needs to hold them; keep a 2 MB margin for the GE
   list + stack safety.

Other inherited hard rules: JS on the 1 MB `USER|VFPU` worker (main stack
256 KB); GE buffers 16-byte aligned + dcache writeback per batch; 2D vertex
coords i16 with the CPU clip stage guaranteeing in-range values; textures pow2
≤512 sampled from main RAM; `size_t`=`usize` (MIPS o32); llvm-ar; toolchain
`nightly-2026-05-28`; JS bundle NUL-terminated, eval len-1.

## Tailwind subset (v1 — pinned)

Utilities (Tailwind default scales; `w-[123]` arbitrary px supported —
negative in arbitrary form, e.g. `inset-[-10]`; `bg-[#8899aa]`-style arbitrary
hex on every color utility; `rounded-[N]` arbitrary radius; `border-2|4|8|[N]`
widths):

- **flex**: `flex`, `flex-row|col`, `justify-start|center|end|between|around`,
  `items-start|center|end|stretch`, `gap-N`, `grow`, `grow-0`, `shrink-0`,
  `basis-N`, `flex-1`, `flex-wrap`
- **box**: `w-N|full|[px]`, `h-N|full|[px]`, `min/max-w/h-N`, `p*/m*-N`,
  `absolute|relative`, `inset/top/right/bottom/left-N`, `hidden`,
  `overflow-hidden` (scissor), `z-N`
- **visual**: `bg-{palette}`, `bg-gradient-to-t|b|l|r` + `from-{c}`/optional `via-{c}`/`to-{c}`
  (per-vertex gouraud for square boxes; alpha-covered RECT spans for rounded
  boxes), `rounded|-sm|-md|-lg|-xl` (axis-aligned boxes get deterministic
  subpixel edge coverage; **`rounded-full` only on nodes whose w/h are
  build-time known** from `w-N h-N`, compiler bakes the exact radius, else
  compile error **[R]**), `opacity-N`, `shadow|-md|-lg` (layered rounded alpha
  spans), `border`+`border-{c}`
- **text**: `text-{palette}`, `text-xs|sm|base|lg|xl|2xl|4xl` → baked slots
  **12/14/16/18/20/24/36 px** (slots derived from the utility list, both
  weights **[R]**), `font-bold`, `text-left|center|right`, `leading-N`,
  `tracking-wide`
- **transform** (animatable, no relayout): `translate-x/y-N`, `scale-N`,
  `rotate-N`, `scale-x/y-N`, `origin-center|top|bottom|left|right|top-left|…`
  (transform origin as size fractions; rotation/scale pivot)
  **Axis-aligned scale transforms both glyph positions and glyph cells.**
  The core emits clipped `TEX_QUAD` cells from shared coverage pages, with
  linear filtering and text-color tint. Pages reuse the font atlas across
  scale changes and expire when that font's revision changes. Identity-scale
  text retains `GLYPH_RUN`; rotated and perspective text retain their existing
  upright glyph behavior.
- **3D transforms**: `perspective-[N]` makes a node a 3D CONTEXT ROOT — its
  subtree composes 3x4 affine matrices (implicit preserve-3d), projects
  through N px about the root center and painter-sorts by camera depth into
  TRIs. `rotate-x-[N]`, `rotate-y-[N]`, `translate-z-[N]` (arbitrary, signed;
  keyframe props rotateX/rotateY/translateZ + the same functions in
  `transform:` strings). IMAGE nodes project as TEX_TRIs (affine screen-space
  UVs, PSP-authentic) — bake text that must ride a surface as an SVG texture;
  glyph runs anchor at their projected origin and stay upright/unscaled. Box
  decoration (radius/border/shadow) is outside the 3D contract. The same
  TEX_TRI path renders 2D-ROTATED images (previously culled).
- **arc primitive**: `arc-start-[deg]`, `arc-sweep-[deg]`, `arc-width-[px]` —
  with width > 0 and sweep != 0 the bg color strokes a round-capped annular
  sector (center = node center, outer radius = min(w,h)/2) instead of filling
  the box; deterministic 2x2-supersampled coverage RECT runs. All three are
  keyframe-animatable — circular progress, spinners and stroke-draw arcs bake
  to arcStart/arcSweep timelines (rotation belongs in arcStart; the renderer
  is axis-aligned-world only).
- **motion**: `transition[-transform|colors|opacity|all]`, `duration-N`,
  `ease-linear|in|out|in-out|spring|out-back`, `delay-N`
- **keyframe animations (baked)**: `animate-<name>` resolves against
  `theme.keyframes`/`theme.animation` in pocket.config.ts (Tailwind config
  shape; built-ins `spin|ping|pulse|bounce`). The compiler bakes every CSS
  `animation` shorthand (comma lists, `cubic-bezier(…)`, named easings as
  their canonical beziers, delays, `forwards|backwards|both` fills,
  `reverse`, `infinite`) into frame-precise per-prop segment timelines in
  styles.bin — the core plays them at fixed dt with zero per-frame JS.
  Keyframe values must be build-time absolute (px/deg/colors; percentages,
  `calc()`, `var()` are loud errors **[R]**), and every animated prop must be
  pinned at 0% and 100%. `animate-loop-[4s]` (or `{ value, loop }` in the
  config) replays the node's whole choreography — delays included — every N
  ms: the style-level loop plain CSS can't express without a remount.
- **variants**: `focus:`, `active:` — variant blocks in the style record,
  switched natively (zero JS on focus change)

Not supported v1 (loud compile/dev errors, not silent): `classList`, template-
interpolated class fragments, `hover:`. Dynamic styling = ternaries of full
literals, `style={{…}}` objects, or `animate()`.

## Testing (definition of done)

1. `contract.ts` — regen spec.rs in-memory + byte-compare; constants greps.
2. `golden.ts` — headless Bun + wasm rasterizer; fixed dt; scripted input;
   byte-exact PNG goldens. Coverage must include: `<For>` reorder (move
   semantics), `<Show>` toggle inside `gap-N` (marker layout), `Count: {n()}`
   mixed text runs, focus traversal, a non-ASCII glyph **[R]**.
3. `tests/e2e/ppsspp.ts` — capture-feature EBOOT (frame dump to `ms0:/dc_cap`,
   scripted input via `POCKETJS_CAPTURE_INPUT` baked at build; ported from
   origin/main's capture stack), `PPSSPPHeadless --graphics=software
   --timeout=N`, magick decode, byte-exact vs goldens. Goldens carry the
   PPSSPP build commit; mismatch message says "emulator differs → UPDATE=1 or
   threshold fallback (IoU≥0.995, meanRGB≤8)" **[R]**. FPS floor asserted as a
   separate non-golden check (HUD enabled only in that mode) **[R]**.
4. Real hardware smoke: `bun run psp:hw`-style PSPLINK loop (manual).

## Perf budget

One FFI crossing per steady-state frame; DrawList ≤ ~40 sceGuDrawArray calls,
≤ ~2000 quads; per-frame vertex bytes ≈48 KB from the bump pool; layout-prop
animations relayout that frame (prefer transforms); Solid effects only on
interaction. Boot: whitespace-minified and tree-shaken bundle
(identifier and syntax minification stay off — the device QuickJS 8 KB parse
stack rejected esbuild output built with `minify: true`); all binary assets in the pak
(base64-in-JS is the known QuickJS boot killer).

## What v1 explicitly punts

Kinetic scroll views, CLUT/swizzled textures, render-to-texture opacity groups
(per-vertex alpha propagation instead — wrong on overlap, fine for demos),
kerning, `hover:`, percentage sizes beyond `-full`, Android hosts,
`rounded-full` on runtime-sized nodes.

The 3DS left this list with `hosts/3ds` — a QuickJS guest over a PICA200
backend. **The CIA boots and renders on a New 3DS LL.** The `3ds-dev` profile
in `tools/3ds-profile.ts` stays outside the production registry until its
synthesized-cursor, sprite, streamed-texture and large-atlas paths have direct
coverage.
