# GBA MicroTS Hero

This experimental host builds the 240 × 160 [`apps/gba-hero`](../../apps/gba-hero) scene into a Game Boy Advance ROM. **MicroTS compiles the TypeScript model and TSX view into Rust.** The ROM runs the generated application, button input, signals, conditional content and animations without a JavaScript VM or operating system.

**The current scope is ROM construction and emulator startup.** The target is 30 FPS; the build using the core's normal layout path measures about 11 FPS in mGBA. The page labels 30 FPS as a target. Physical hardware has not been tested.

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

**The LCD controller composes a Mode 0 background and OBJ sprites.** The static background stays in VRAM. The CPU runs the generated app and the core's normal layout path, then maps model and animation values to sprite positions, tile references and pre-rendered frames. DMA uploads changed artwork and OAM attributes during VBlank. There is no per-frame software framebuffer or `core.draw()` call.

The sprite presenter reserves 35 OAM slots and 17,920 OBJ VRAM bytes. The assets include eight spinner frames, 145 underline widths, 21 button colors, counter glyphs and a conditional message. Font and image pixels are consumed by the desktop baker; the cartridge uses the resulting tiles.

The application advances simulation time by 1/30 second per update and schedules presentation after two hardware VBlanks when work fits the deadline. **The current CPU workload exceeds that budget**, so wall-clock animation and presentation are slower than the configured simulation rate. Performance work is separate from this initial host.

## Limits

This is a fixed Hero scene presenter. It does not translate arbitrary draw lists or dynamic Flexbox results into GBA tiles. The 240 × 160 adapter remains separate from the shared Hero view; consolidating that layout requires changes to its baked crops and sprite bindings.

Palette reduction limits color precision. Shadows and edge coverage are blended against the baked background. Underline width is rounded to a pixel and button colors select one of 21 samples. Layout changes require rebuilding the assets and updating the presenter bindings.

There is no audio, storage, networking or OS service layer. Emulator startup and input checks do not establish physical GBA support or completion of the 30 FPS target. Keep ROM copies, measurements and screenshots in ignored `.pocket-build/validation/gba/` output or an artifact store.
