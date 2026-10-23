# pocketbook-host

The PocketJS UI runtime on **PocketBook e-readers**, rendered through the
[inkview](https://github.com/simmsb/inkview-rs) SDK.

`UiProgram` composes **one `pocket-runtime::Runtime` and one UI operation
context**. The JS/pak pair enters the package reader through its embedded
adapter. Generated QuickJS bindings expose public UI operations; the runtime
owns guest calls, contact capture and core advancement.

- Runtime's presentation coordinator computes DrawList damage. Its registered
  software renderer paints acquired regions of a retained RGBA8 target at
  **480×272 logical pixels and scale 2**, producing 960×544 pixels.
- The registered display compares 16×16 tiles inside the damage regions and
  copies changed pixels to Inkview as RGB24. The panel handles grayscale or
  color conversion. An unchanged frame skips raster and pixel scanning.
- `refresh.rs` retains partial, dynamic and full panel updates and the quiet
  cleanup timer. Returning from the background invalidates the buffer's damage
  generation and requests a full refresh.
- `input.rs` publishes button masks and contacts in logical coordinates.
  Runtime encodes guest touch arrays and retains each contact's initial hit.
- Inkview's main thread forwards events to the program thread. Shared
  `TickSchedule` sets **30 wall-clock turns per second**; the existing core
  step and guest metadata remain **60 Hz**. Missed slots do not add guest turns.

The retained target is centered on the panel and scales down when it does not
fit. Inkview copies target pixels before the display's terminal wait completes;
its panel refresh keeps no borrow of the target buffer.

`docs/IMPLEMENTATION.md` records the original implementation proposal and SDK
API findings. Its manual guest/raster examples predate the Runtime composition.

## Status

**The framebuffer and input unit tests pass against the shared Runtime.** The
program targets an ARM ELF with glibc 2.23 and loads `libinkview.so` at runtime.
The `pocketbook` profile and native build recipe are registered in this
repository. Earlier device validation covered boot, render, scale-to-fit
centering and animated partial updates on a PocketBook Verse (grayscale).
That device run predates the current Runtime composition; the checklist below
records those earlier results and the remaining device checks.

## Build

One-time toolchain setup:

```sh
rustup target add armv7-unknown-linux-gnueabi
cargo install cargo-zigbuild
# zig (brew install zig) and libclang (for rquickjs bindgen) are also required.
```

Cross-compile the host (from this directory):

```sh
bun ../../tools/pocket.ts profile export --config pocket.runtime-config.ts --out ../../target/pocketbook-profile
POCKETJS_PROFILE_RS=$PWD/../../target/pocketbook-profile/pocket_profile.rs \
  cargo zigbuild --release --target armv7-unknown-linux-gnueabi.2.23
# → <repository>/target/armv7-unknown-linux-gnueabi/release/pocketbook-host
```

Notes:

- The host compiles in the exported pocketbook profile: `build.rs` copies the
  `pocket_profile.rs` that `POCKETJS_PROFILE_RS` names, and the logical
  viewport, raster density, tick rate and profile hash come from it. A build
  without the variable starts and exits with an error.
  `bun tools/pocket.ts build --config programs/pocketbook/pocket.runtime-config.ts`
  sets the variable.

- `libinkview.so` is `dlopen`'d at runtime (`inkview::load`) — no SDK at build
  time.
- `rquickjs` ships pre-generated FFI bindings for common targets but not the
  soft-float `armv7-unknown-linux-gnueabi`, so the ARM build enables its
  `bindgen` feature (needs `libclang`). Native builds use the pre-generated
  bindings.
- LLVM lowers `f32::max/min` to C23 math symbols (`fmaximum_numf`, …) that
  PocketBook's glibc 2.23 predates; `build.rs` links a tiny shim
  (`src/compat.c`) providing them for the cross-build.
- `inkview` is pinned to Git revision
  `0e4ecab93f6e2907c255bb50bc4b6c1882779274` in `Cargo.toml` and the root lockfile.

## Build the app bundle

From the repo root:

```sh
bun pocket compile --target pocketbook --manifest apps/hero/pocket.json --project-root .
# → dist/hero-main.js + dist/hero-main.pak
```

## Deploy

Connect the PocketBook over USB, then from the repo root:

```sh
bun programs/pocketbook/deploy.ts             # auto-detects the mount point
# or explicitly:
bun programs/pocketbook/deploy.ts /run/media/$USER/PB626
```

It installs `applications/pocketjs-hero/{pocketjs-hero, app.js, app.pak}`.
Eject safely and launch **pocketjs-hero** from the launcher (a firmware rescan
or restart may be needed for a new app to appear).

## Runtime configuration

| Env var | Default | Meaning |
| ------- | ------- | ------- |
| `POCKET_PAK` | `app.pak` | path to the app pak |
| `POCKET_JS` | `app.js` | path to the JS bundle |
| `RUST_LOG` | `info` | log filter (the host logs the panel size + geometry at startup) |

## Device testing checklist

Run on both a grayscale and a color device to exercise both blit paths.

**Boot / render**

- [x] App appears in the launcher and opens without crashing. *(Verse)*
- [x] The `hero` UI renders, centered, with letterbox borders on the larger
      panel. Check the startup log line
      (`pocketbook: panel WxH, … render WxH → disp WxH +(ox,oy)`) for sane
      geometry. On the Verse the 960×544 render is scaled to 758×429 and
      centered vertically. *(Verse)*
- [x] Text is crisp (font atlases are baked @2x). *(Verse)*
- [x] **Verse (gray):** image/logo render in grayscale, no color. *(Verse)*
- [ ] **Era Color (color):** colored UI elements actually show color.

**Input**

- [ ] Touch: tapping a button activates it (touch maps physical→logical via the
      scale-to-fit offset + displayed size).
- [ ] Hardware keys: D-pad moves focus, OK activates, Back/Menu behave.
- [ ] Page-turn keys (Prev/Next) map to left/right.

**E-ink refresh**

- [x] Small changes (button highlight / spinner) update without a full flash —
      the hero spinner and progress bar animate via partial updates. *(Verse)*
- [x] During animation the panel keeps up (dynamic updates), then does a clean
      partial update when it settles (~200 ms quiet). *(Verse)*
- [ ] No persistent ghosting after a few seconds idle (periodic cleanup works).
- [ ] Returning from background (`Show`) does one clean full redraw.

### Validated on hardware

- **PocketBook Verse** (grayscale, 758×1024) — 2026-07-24. Boot, render,
  scale-to-fit centering, @2x text, and animated partial updates all confirmed
  via photo + video, **re-confirmed after the switch to incremental DrawList
  damage** (`render_scaled_incremental`). The progress-bar animation now runs
  at its intended cadence — closer to the desktop host — because the tick loop
  no longer re-rasterizes and re-scans the whole 960×544 frame every 33 ms.
  Input (touch / hardware keys), idle ghosting, and background-return still
  need a hands-on pass.
- **Era Color / Kaleido 3** — not yet tested (color blit path unverified).

### Logs

The `.app` launcher redirects the host's stdout/stderr to
`applications/<app>/pocketjs.log` on the device storage (visible over USB), so
the startup geometry line and any `RUST_LOG` output survive a run. Bump the
filter with `RUST_LOG=debug` in the launcher for verbose traces.

**Report back** any crash (ideally with the `pocketjs.log` contents),
mis-render, touch offset, or excessive flicker — those drive the next
iteration.
