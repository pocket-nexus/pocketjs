# iPod nano 2G MicroTS Hero

This experimental host builds the 176 × 132 [`apps/ipodnano-hero`](../../apps/ipodnano-hero) scene into a Rockbox plugin for the iPod nano 2nd generation. **MicroTS compiles the TypeScript model and TSX view into Rust; the plugin runs the generated app, the retained core and its software rasterizer without a JavaScript VM.** The app shares its model with [`apps/gba-hero`](../../apps/gba-hero) and differs in layout and button labels.

## Device contract

| Fact | Value |
| --- | --- |
| Rockbox target | `ipodnano2g`, Samsung S5L8701, ARM940T (ARMv4T), no FPU |
| CPU clock while the plugin runs | 191.7 MHz (`cpu_boost`) |
| LCD | 176 × 132, RGB565 |
| Plugin buffer | 512 KiB |
| Main thread stack | 8 KiB in IRAM |

**The app is 786 KB (419 KB code, 366 KB read-only data, of which 333 KB are font atlases and images), so it does not fit the plugin buffer.** `pockethero.rock` is a 1.2 KB launcher that calls Rockbox's `run_overlay`; `pockethero.ovl` is linked at the top of the audio buffer, the layout Rockbox uses for Duke3D and Quake. The overlay takes the audio buffer below its load address: a 128 KiB stack at the top, because the 8 KiB main stack does not hold a layout solve, and a heap under it. Audio playback stops while the plugin runs.

**A plugin runs only on the Rockbox build whose plugin API it was compiled against.** Build against the source revision named by `Version:` in the iPod's `.rockbox/rockbox-info.txt`; `--install` refuses a volume whose version differs.

## Build

Run from a repository checkout with Bun, Rustup and an ARM EABI GCC installed:

```sh
bun install --frozen-lockfile
rustup toolchain install nightly-2026-07-01 --component rust-src
git clone https://github.com/Rockbox/rockbox.git ~/rockbox
git -C ~/rockbox checkout <revision from rockbox-info.txt>
bun hosts/ipodnano/build.ts --rockbox=~/rockbox
```

The command writes `dist/ipodnano/pockethero.rock`, `pockethero.ovl`, `build.json` and `preview/*.png`. The build record includes commands, the Rockbox revision, the compiler prefix and the SHA-256 of both outputs. Rockbox recommends `arm-elf-eabi-gcc` 9.5.0; the build uses it when it is on `PATH` and falls back to `arm-none-eabi-gcc`, which builds working plugins at GCC 16.1. `--compiler-prefix=<prefix>` selects another toolchain. Without `--rockbox` the build stops after the preview and the Rust staticlib.

The build performs four steps:

1. Compile the strict MicroTS app with a layout environment (176 × 132, the baked atlases, the no_std wasm core). The `layout-baked` page solves at build time: 20 nodes, one formula leaf (the underline) and one live island (the spinner).
2. Run the [host preview](preview/src/main.rs): it drives the same `Hero` type the plugin links through 89 scripted frames, checks every frame against a fresh full-tree layout solve, and writes PNGs of the framebuffer.
3. Build the [crate](src/lib.rs) as a staticlib for `armv4t-none-eabi` with `build-std` and `compiler-builtins-mem`.
4. Copy [`rockbox/pockethero`](rockbox/pockethero) into `apps/plugins/` of the Rockbox source, configure an `ipodnano2g` build with `--plugins=pockethero`, and run `make rocks`.

## Install and run

Connect the iPod while Rockbox runs; it mounts as a FAT32 volume. Then:

```sh
bun hosts/ipodnano/build.ts --rockbox=~/rockbox --install=/Volumes/IPOD
```

Both files go to `.rockbox/rocks/apps/`. Eject, unplug, and open **Plugins → Applications → pockethero**.

| iPod control | Action |
| --- | --- |
| Center | CIRCLE: increment the counter once per press |
| Play/Pause | START: reset the counter |
| Wheel | UP / DOWN: focus the action button |
| Previous / Next | LEFT / RIGHT |
| Menu | Leave the plugin |

The mapping is the one the Pocket Stage iPod profile and the MicroTS playground use, except Menu, which belongs to Rockbox here.

Connecting USB also leaves the plugin and hands the event to Rockbox.

## Runtime

Each 30 Hz tick the plugin drains wheel events, reads the held center and Play/Pause state, and calls `pockethero_frame`. The Rust side runs the generated app, emits the DrawList and renders it with `render_scaled_rgb565_incremental` into a persistent framebuffer. **The damage tracker compares the DrawList with the previous frame's and returns at most eight rectangles; the plugin copies only those to the LCD** with `lcd_bitmap_part` and `lcd_update_rect`. A late frame moves the schedule forward instead of queueing catch-up frames.

On exit the plugin writes `.rockbox/pockethero.log`: frame count, missed deadlines, mount time, mean and maximum frame time from the microsecond timer, LCD copy time, damage totals and the heap peak. A Rust panic writes the log with the source line, shows it, and returns to Rockbox through the plugin runtime's `exit`.

## Measurements

One 85.6-second session on hardware (Rockbox `f684d3ba6a`, `arm-none-eabi-gcc` 16.1.0), with 23 presses:

| Measure | Value |
| --- | --- |
| Frames | 2511 (29.3 per second) |
| Missed 30 Hz deadlines | 122 (4.9 %) |
| Mean frame time (app, layout, DrawList, raster) | 22.5 ms |
| Maximum frame time | 214 ms |
| Mean LCD copy time | 0.19 ms |
| Mean damaged area | 616 px per frame (2.7 % of the screen) |
| Mount time | 27.7 ms |
| Heap peak | 443,120 bytes |

The frame time covers the app tick, layout, DrawList emission, damage comparison and rasterization together; the log does not split them. LCD copies are measured separately. The host preview reports 5692 px per frame for its scripted session, which presses on most frames.
