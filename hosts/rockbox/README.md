# Rockbox Plugin Host

This experimental host runs MicroTS apps as [Rockbox](https://www.rockbox.org/) plugins. The default build packages [`apps/ipod-video-demo`](../../apps/ipod-video-demo), the shared Hero view at 320 × 240, for the iPod Video (5th generation). **MicroTS compiles the TypeScript model and TSX view into Rust**, and the plugin runs it on the iPod's PP5021C (ARM7TDMI at 80 MHz) without a JavaScript VM.

**The current scope is a plugin on an installed Rockbox build.** The host does not replace Rockbox, play audio or load apps at runtime.

## Build

Run from a repository checkout with Bun and Rustup installed, next to a Rockbox source checkout:

```sh
bun install --frozen-lockfile
rustup toolchain install stable
rustup toolchain install nightly-2026-07-01 --component rust-src
git clone --branch v4.0-final https://github.com/Rockbox/rockbox.git ../rockbox
(cd ../rockbox && tools/rockboxdev.sh --target=a)   # arm-elf-eabi-gcc, add its bin/ to PATH
bun hosts/rockbox/build.ts --rockbox=../rockbox
```

The command writes `dist/rockbox/rockbox.zip`: the Rockbox firmware, its plugins, `pocketjs_ipod.rock` and the app's fonts and images. Plugins must match the firmware's plugin API version, so install the whole archive: extract it to the root of the iPod's disk and reboot into Rockbox. The demo is under Plugins → Applications → `pocketjs_ipod`. `--outdir=<directory>` selects another output directory.

`--sim` builds the Rockbox UI simulator instead and installs the plugin into its `simdisk`. `--app=<name>:<dir>` builds `pocketjs_<name>.rock` from `apps/<dir>`; repeat it for several plugins. `--perf-hud` adds a strip with the frame rate, per-phase milliseconds, the repainted share of the screen and the stack high-water mark. `--target=<model>` passes another Rockbox target to `tools/configure`; [`plugin/pocketjs.c`](plugin/pocketjs.c) maps the iPod click-wheel buttons, so other targets need their own button mapping.

The build changes the Rockbox checkout: it copies [`plugin/`](plugin) to `apps/plugins/pocketjs/` and adds one entry each to `apps/plugins/SUBDIRS` and `apps/plugins/CATEGORIES`. It configures `build-pocketjs-<target>` there, and the plugin makefile runs [`gen.ts`](gen.ts) and Cargo for each app.

| iPod control | PocketJS input |
| --- | --- |
| Select | `confirm` (○) |
| Menu | `back` (×) on release; holding it for 400 ms opens a Resume / Quit menu |
| Play/Pause | `START` |
| ⏮ / ⏭ | Left / Right |
| Click wheel | Moves focus; also relative axis 0, 15° per step |

## Runtime

[`plugin/pocketjs.c`](plugin/pocketjs.c) owns the frame loop, input and LCD updates; [`src/lib.rs`](src/lib.rs) is a `staticlib` with the app, the core and the allocator. Firmware builds compile Rust for `armv4t-none-eabi` in ARM state, matching Rockbox's C code.

**The plugin borrows Rockbox's audio buffer.** The first 256 KB become the stack of the thread that runs the frame loop, and the rest the Rust heap. Rockbox starts plugins on its 8 KB main thread stack, and the core needs more than that; the Rockbox SDL ports start a thread with a larger stack in the same way. The simulator runs the loop on its main thread.

The plugin buffer on the iPod Video holds 512 KB of code and data. Fonts and images stay out of it: `gen.ts` bakes them into `.rockbox/rocks.data/pocketjs/<app>/`, and the host reads them at start.

**Each frame repaints only damaged pixels.** The host renders through `render_scaled_rgb565_incremental` and returns the repainted rectangles, and the plugin pushes only those to the LCD. Frames run every 3 Rockbox ticks (33.3 Hz) with the CPU boosted to 80 MHz while input or damage continues, and every 10 ticks at the idle clock after one second without either. The app clock runs at 33 Hz, and `gen.ts` bakes animation timelines at the same rate.

## Limits

The app clock counts frames, so app time runs at one third of wall time during idle frames. Rockbox stops playback to lend the audio buffer, so music cannot play while the plugin runs. `gen.ts` bakes images and glyphs that appear as literals in the app's sources; computed `src` values and runtime strings outside those literals are not baked.

Keep firmware archives, measurements and screenshots in ignored `.pocket-build/validation/rockbox/` output or an artifact store.
