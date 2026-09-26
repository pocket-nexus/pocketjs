# Nintendo DS MicroTS host

This host runs the default [`apps/hero`](../../apps/hero/) Solid component through the [`apps/hero-nds`](../../apps/hero-nds/) screen wrapper as **generated Rust on ARM9**. MicroTS compiles the Solid TSX view and TypeScript model. The ROM has no JavaScript runtime. The lower LCD shows the Hero at **256 × 192 pixels**; the upper LCD shows frame, draw, input, and counter diagnostics.

This experimental host supports **the Hero demo at 30 application updates per second**. The build entry is `bun nds`; NDS is not a general `pocket build --target` platform. Emulator boot and input have been validated. **Physical hardware has not been validated.**

## Shared Hero source

The default [`apps/hero/app.tsx`](../../apps/hero/app.tsx) component renders the shared [`Hero.tsx`](../../apps/hero/Hero.tsx) view and [`Hero.ts`](../../apps/hero/Hero.ts) counter, spinner, and underline model. [`apps/hero-nds/app.tsx`](../../apps/hero-nds/app.tsx) imports this default Hero component with `compact` and device labels. The NDS wrapper contains no separate interaction model.

The NDS build compiles this source to Rust through MicroTS. The standard guest build compiles the same source to JavaScript:

```sh
bun tools/build.ts apps/hero/main.tsx --framework=solid
```

The shared model uses the MicroTS-admitted TypeScript subset. **The JavaScript guest still executes JavaScript**; the shared source does not require a Rust guest on other hosts. The compact layout uses direct button color changes; the standard layout retains its color transitions.

## Build

Follow the [devkitPro package-manager setup](https://devkitpro.org/wiki/devkitPro_pacman) and install the **`nds-dev`** package group, including devkitARM, libnds, and ndstool. The build supports libnds layouts with Calico and the earlier `ds_arm9.specs` layout. Set `DEVKITPRO` to the installation directory; `DEVKITARM` defaults to `$DEVKITPRO/devkitARM`.

The emulator-validated toolchain uses **devkitARM r65 (GCC 14.2), libnds 1.8.3, default ARM7 0.7.4, devkitARM CRT 1.2.4, and ndstool 2.3.1**. The Calico link path is provided for newer SDK installations but has not been validated in this port.

Install the pinned Rust compiler and its sources:

```sh
rustup toolchain install nightly-2026-07-01 --profile minimal --component rust-src
```

From the repository root, after installing the repository dependencies:

```sh
export DEVKITPRO=/opt/devkitpro
bun nds
```

The build performs strict MicroTS admission for `nds`, bakes font and image assets, compiles a `no_std` Rust static library for **`armv5te-none-eabi` with `target-cpu=arm946e-s`**, and links the ARM9 program with the devkitPro ARM7 program. It emits `dist/nds/hero-nds.nds` and `dist/nds/hero-nds.elf`. Generated source and intermediate objects stay under `.pocket-build/nds/`; compiler identities and ROM hashes stay under `.pocket-build/validation/nds-build/`.

Options:

```sh
bun nds --devkitpro /path/to/devkitpro --outdir dist/nds
bun nds --assets-only
```

`--assets-only` compiles the view/model and packs assets without an NDS SDK.

## Controls

- **D-pad:** focus the Hero button.
- **A:** increment the counter once at the down edge. Holding A does not repeat.
- **Stylus:** tap the button or its label. Holding or dragging the contact does not repeat; a tap outside the button does not activate it.

The model changes the underline position with the counter and reveals a message after four activations. The spinner waits **100 ms on the application clock** between its eight images. Its timing uses a duration instead of a fixed frame count, so the same model supports 30 Hz and 60 Hz. Opacity selects the visible image without changing layout. The host maps all twelve DS buttons: A/B/X/Y, Start/Select, D-pad, and L/R. The input profile has touch support and no motion or relative-axis driver.

## Emulator acceptance

For interactive use, open `dist/nds/hero-nds.nds` in [melonDS](https://github.com/melonDS-emu/melonDS/releases) in DS mode. The ROM has also been booted in melonDS 1.1. Click the lower-screen button to use the stylus; configure the emulator's key bindings for D-pad and A input.

Use a **DeSmuME libretro core** built for the machine running Python. Obtain it through the [Libretro DeSmuME documentation](https://docs.libretro.com/library/desmume/) or build the [Libretro DeSmuME source](https://github.com/libretro/desmume). The headless harness drives the ROM through libretro input and reads the linked telemetry symbol from emulated DS RAM. It uses the emulator's firmware implementation; no BIOS dump is required by this harness.

```sh
python3 tests/e2e/nds.py \
  --core /path/to/desmume_libretro.dylib \
  --rom dist/nds/hero-nds.nds \
  --elf dist/nds/hero-nds.elf \
  --nm "$DEVKITPRO/devkitARM/bin/arm-none-eabi-nm"
```

The core extension can be `.so`, `.dylib`, or `.dll`, matching the host. **The ELF and ROM must come from the same build.** The test checks ROM boot, nonblank dual-screen output, D-pad focus, A down-edge dispatch, held A, touch outside the button, button-label touch, held touch, dragging, count four, and a further 600 emulated VBlanks of operation. The steady interval must contain **295–301 application updates per 600 VBlanks**, with no VRAM writes on unchanged frames. Its output directory contains screenshots, ROM/core hashes, measured telemetry, and `result.json`. The default directory is `.pocket-build/validation/nds-hero/<run>/`.

For a boot capture without acceptance assertions:

```sh
python3 tests/e2e/nds.py \
  --core /path/to/desmume_libretro.dylib \
  --rom dist/nds/hero-nds.nds \
  --elf dist/nds/hero-nds.elf \
  --nm "$DEVKITPRO/devkitARM/bin/arm-none-eabi-nm" \
  --smoke-frames 600
```

Compiler admission and framebuffer checks do not require an emulator:

```sh
bun test tests/aot-admission.test.ts tests/nds-present.test.ts
```

## Rendering and timing

The C host scans libnds input, calls the generated application through a C ABI, and schedules each update across **two VBlanks**. The retained core uses a **30 Hz model and animation clock**. A missed deadline resumes at a later VBlank without running a burst of catch-up updates.

ARM946E-S has no compare-and-swap instruction. The host enables the MicroTS `critical-section` feature and supplies the libnds interrupt-mask implementation used by its atomics.

PocketJS lays out the retained tree and rasterizes damaged regions into a **98,304-byte RGB565 framebuffer**. The host tracks pending damage for each of the two VRAM pages, converts the changed row spans to the DS bitmap format, and swaps at VBlank. Unchanged frames skip conversion and swapping. Tracking both pages preserves changes across alternating buffers. Baked fonts and the Hero logo/spinner images are embedded in the ROM.

The top-screen heading states the configured 30 FPS rate; `Present` is measured from completed application frames and the DS timer. Telemetry also exposes update, draw-command generation, raster, and copy times, copied pixels, and missed deadlines. `Late frames` counts missed deadlines from startup, including the initial drawing and input interactions; the acceptance report also records the count for its steady interval. The model and animation clock advance once per application update, so missed update deadlines slow animations. Emulator measurements do not establish hardware frame rate, memory margin, touch calibration, or flashcart compatibility; these remain part of physical-device validation.
