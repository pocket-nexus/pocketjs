# GBA MicroTS Hero

This experimental host builds the 240 × 160 [`apps/gba-hero`](../../apps/gba-hero) scene into a Game Boy Advance ROM. **MicroTS compiles the TypeScript model and TSX view into Rust.** The ROM runs the generated application, button input, signals, conditional content and animations without a JavaScript VM or operating system. **The presenter is generated from the compiler's layout and sprite layer plan**: no crop, frame count, OAM slot or VRAM offset is written by hand.

**The page is `layout-baked`: every rect except the spinner island is a build-time constant, and the cartridge runs no flexbox solve for it.** In mGBA 0.10.5 the ROM presents at the two-VBlank rate, 29.86 FPS, with zero missed deadlines over a 60-second idle sample and a 30-second input sample; the same source on the ordinary layout path measures 14.93 FPS with a 69.5 ms `app.frame`. Physical hardware has not been tested.

## Build

Run from a repository checkout with Bun and Rustup installed:

```sh
bun install --frozen-lockfile
rustup toolchain install stable
rustup toolchain install nightly-2026-07-01 --component rust-src
bun hosts/gba/build.ts
```

The command writes `dist/gba/gba-hero.gba`, `gba-hero.elf` and `build.json`. The build record includes commands, toolchain selection, ROM and ELF SHA-256 hashes, and asset sizes. `bun hosts/gba/build.ts --outdir=<directory>` selects another output directory. This build entry is available in the repository checkout; it is not part of the published npm package.

Open `gba-hero.gba` in mGBA. Emulator keyboard bindings depend on the user's configuration. The action button starts with focus.

| GBA control | Action |
| --- | --- |
| A | Increment the counter once per press |
| B | Reset the counter |
| Up / Down | Focus the action button |

The build performs four steps:

1. Compile the strict MicroTS app with a layout environment (240 × 160, the baked atlases, the no_std wasm core, `spriteLayers: true`). The compiler solves the `layout-baked` page and writes `layers.json`: one recipe per sprite layer (`microts/compiler/aot-paint-plan.ts`).
2. Run the [desktop baker](bake/src/main.rs): it drives the running app through every state each recipe enumerates, captures the screen with the retained core's layout and RGBA rasterizer, and takes each layer's crop from the pixels that changed.
3. [Pack the layers](assets.ts) into RGB555 palettes, background tiles and sprite tiles, and allocate OAM slots and OBJ VRAM in layer order. Limits are build errors.
4. Build `core` and `alloc` for `thumbv4t-none-eabi`, link the startup code and host, then write the cartridge header and checksum.

## Sprite layers

A **layer** is the nearest element with a `debugName` above anything that still paints at runtime inside the `layout-baked` page. Each layer has one state recipe, inferred from the view and model:

| Recipe | Source in the app | States baked | Read back on the cartridge |
| --- | --- | --- | --- |
| `branches` | `<Show>` children of the layer root (several `<Show>`s form one list) | each branch, mounted by hand from the plan and captured alone | the mounted child's style id, image asset and text, matched against the branch signatures |
| `opacity` | an `opacity` binding on the root | one | `resolved_style().opacity` |
| `size` | a formula leaf's width or height: a `:style` binding or a model `animate` on its ref | every integer of the range; the range comes from the animate literal and the initial style, or from `gba-layers.json` | `layout_of()` |
| `color` | `focus:`/`active:` variants that change `bgColor` | the endpoints and one sample per 30 Hz tick a `transition-colors` can show | `resolved_style().bg_color`, nearest sample |
| `text` | a `Text` with interpolated parts | one glyph per character the parts' types can produce (`i32`: digits and minus); the static prefix is in the background | `node_text()`, one object per glyph of the tail, advanced in quarter pixels |

`translateX`/`translateY` bindings on a root move its sprites; they bake no states. Anything else (a dynamic class, a keyframe timeline, a binding on another prop, a `<For>`) is a compile error naming the node. Declarations the plan cannot infer — a size range without a literal target, a string-typed text's glyph set and length — go in an optional `apps/<app>/gba-layers.json` keyed by layer name.

**Each sprite carries the background it was baked on.** Layers paint in document order. The baker captures every layer alone first; a layer that paints where a lower layer does is then re-baked with that layer visible, so its pixels hold the real blend (the message text over the button's shadow). The packer rejects the case this cannot cover: a lower layer whose pixels under an upper layer differ between its own states. Later layers take the lower OAM indices, so they draw on top.

For the hero page the plan is five layers: Spinner (8 branches, 32 × 32), Underline (145 widths, 160 × 16), HeroAction (15 colors, 96 × 48), Counter (11 glyphs, 16 × 32 each) and ReactiveMessage (1 branch, 128 × 16): 31 OAM slots, 15,872 bytes of OBJ VRAM, 456,192 bytes of frame tiles in ROM. Frame tiles stay in ROM; `present` uploads a layer's frame only when its state changed.

## Runtime

The [startup code](src/start.s) initializes RAM and the stack before entering Rust. The GBA host provides the allocator and the `critical-section` implementation used by MicroTS's atomic fallback. That implementation saves the interrupt-enable state and restores it on exit.

**The LCD controller composes a Mode 0 background and OBJ sprites.** The static background stays in VRAM. The CPU runs the generated app, then maps model and animation values to sprite positions, tile references and pre-rendered frames. DMA uploads changed artwork and OAM attributes during VBlank. There is no per-frame software framebuffer or `core.draw()` call.

**Layout is solved at build time.** `apps/gba-hero/app.tsx` marks `HeroScreen` as `layout-baked`; `build.ts` solves that subtree in the no_std wasm core with the 240 × 160 viewport and the baked atlases, and the generated mount code assigns each rect with `set_layout_static`. The underline is a formula leaf (`set_layout_formula`): its animated width recomputes one rect from its own style. The spinner is a `contain-strict` island: its `<Show>` swap reconciles and solves a two-node region. The desktop baker links `pocketjs-core` with `counters` and checks every frame against a fresh full-tree solve (`Ui::layout_mismatches`), so the ROM is written only when the host, running the same no_std float math as the cartridge, agrees with the tables.

Measured with the pinned headless mGBA 0.10.5 runner (HLE BIOS, no host pacing; `app.frame` from the diagnostic mailbox at presentation edges):

| ROM | Idle FPS | Misses / 3600 LCD frames | `app.frame` median / p95 | Peak heap |
| --- | ---: | ---: | ---: | ---: |
| Ordinary layout path (`origin/main` 5a60ab95) | 14.93 | 600 | 69.5 / 69.6 ms | 62,416 B |
| `layout-baked` page, `contain-strict` spinner | 29.86 | 0 | 8.4 / 8.5 ms | 34,308 B |
| `layout-baked` page, spinner as eight opacity-bound views (no island) | 29.86 | 0 | 0.8 / 0.8 ms | 38,192 B |

Frames without a spinner swap cost 0.4 ms in both baked ROMs; a `<Show>` swap inside the island costs about 8 ms (node destroy and create, region reconcile, one flex solve and readback in soft-float from ROM). All three ROMs produce byte-identical captures at the same model state.

Font and image pixels are consumed by the desktop baker; the cartridge uses the resulting tiles. Diagnostic words 28.. publish each layer's state in plan order (branch index, visibility, size value, color bits, glyph count); word 12 is the OAM slot count and word 31 counts branch layers that matched more than one state.

The application advances simulation time by 1/30 second per update and schedules presentation after two hardware VBlanks when work fits the deadline. Two VBlanks are 33.49 ms at the GBA clock; the baked ROM's worst sampled frame is 13.1 ms of work before DMA.

## Limits

The presenter does not translate arbitrary draw lists: a page must be `layout-baked`, and every runtime change must fit one of the recipes above within 128 OAM slots and 32 KiB of OBJ VRAM. The 240 × 160 adapter remains separate from the shared Hero view. Sprites take the two object grids the packer knows, 32 × 16 and 16 × 32; the per-scanline OBJ budget is not checked.

Palette reduction limits color precision: one 256-color palette for the background and one for all sprites. Every layer state is pre-rendered, so a wide size range or a long transition costs ROM in proportion (the underline's 145 widths are 371,200 bytes). Size values round to a pixel and colors snap to the nearest sample. Moving or resizing a node changes nothing in this directory: the next build re-plans, re-bakes and re-packs.

There is no audio, storage, networking or OS service layer. Emulator startup and input checks do not establish physical GBA support or completion of the 30 FPS target. Keep ROM copies, measurements and screenshots in ignored `.pocket-build/validation/gba/` output or an artifact store.
