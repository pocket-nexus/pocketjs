# GBA MicroTS Hero

This experimental host builds the 240 × 160 [`apps/gba-hero`](../../apps/gba-hero) scene into a Game Boy Advance ROM. **MicroTS compiles the TypeScript model and TSX view into Rust.** The ROM runs the generated application, button input, signals, conditional content and animations without a JavaScript VM or operating system.

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

1. Compile the strict MicroTS app and prepare its font and image resources.
2. Run the [desktop baker](bake/src/main.rs) with the retained core's layout and RGBA rasterizer to produce the background and dynamic layers.
3. [Pack the layers](assets.ts) into RGB555 palettes, background tiles and sprite tiles.
4. Build `core` and `alloc` for `thumbv4t-none-eabi`, link the startup code and host, then write the cartridge header and checksum.

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

The sprite presenter reserves 35 OAM slots and 17,920 OBJ VRAM bytes. The assets include eight spinner frames, 145 underline widths, 21 button colors, counter glyphs and a conditional message. Font and image pixels are consumed by the desktop baker; the cartridge uses the resulting tiles.

The application advances simulation time by 1/30 second per update and schedules presentation after two hardware VBlanks when work fits the deadline. Two VBlanks are 33.49 ms at the GBA clock; the baked ROM's worst sampled frame is 13.1 ms of work before DMA.

## Limits

This is a fixed Hero scene presenter. It does not translate arbitrary draw lists or dynamic Flexbox results into GBA tiles. The 240 × 160 adapter remains separate from the shared Hero view; consolidating that layout requires changes to its baked crops and sprite bindings.

Palette reduction limits color precision. Shadows and edge coverage are blended against the baked background. Underline width is rounded to a pixel and button colors select one of 21 samples. Layout changes require rebuilding the assets and updating the presenter bindings.

There is no audio, storage, networking or OS service layer. Emulator startup and input checks do not establish physical GBA support or completion of the 30 FPS target. Keep ROM copies, measurements and screenshots in ignored `.pocket-build/validation/gba/` output or an artifact store.
