# Vita GXM renderer

`GxmRenderer<D>` consumes `FrameInput` and `RenderResources` through
`pocket-drivers::Renderer`. **The renderer does not depend on `Ui` or a guest
engine.** It resolves resources referenced by the DrawList, decodes commands
with `pocket-draw-ops`, and preserves painter order with `pocket-tri-batch`.
The target covers the configured physical viewport; partial device targets and
zero-copy rendering return errors.

`native::VitaDevice` uses vita2d's embedded GXM programs and
`pocket-vita-gxm::mem::Block` for submission-owned GPU vertex memory. A terminal
wait closes the scene and calls `vita2d_wait_rendering_done`; retirement then
releases the submission's block and resource references. Draws split at
65,535 vertices, on triangle boundaries, to fit vita2d's 16-bit index buffer.

**Images and glyph pages have bounded revision caches.** Default image limits
are 256 entries and 32 MiB; glyph limits are 128 pages and 8 MiB. Charges include
8-pixel pitch and 256 KiB CDRAM allocation rounding. Glyph coverage uses guarded
A8 pages with point sampling. Images preserve their filtering hint. A retired
image allocation can receive a new revision in place; pending references
prevent writes. A failed update invalidates the affected cached revision.

The native device retains matching retired texture allocations for reuse.
Its total texture allocation limit is 64 MiB, including recycled allocations.
At a closed guest boundary it trims recycled storage to 16 MiB. This retains
the host's workaround for live texture destruction in Vita3K. Vertex storage
per submission is bounded by the pool size passed to `VitaDevice::new`, in
addition to vita2d's native pool. These limits are candidate defaults pending
hardware performance acceptance.

The Vita host registers a typed Renderer and DeviceOwned DisplayOutput in
its canonical Runtime. A shared scene begins with `graphics::begin_frame` and
native 3D; `Runtime::render_over_with` records UI and an optional native overlay
inside the coordinator's frame. **The renderer is `Deferred` and the display
declares a queued flush: presentation ends the scene and queues
`vita2d_swap_buffers` after submission, without a GPU wait.**
`begin_frame` for the next frame calls `vita2d_wait_rendering_done` before
vita2d reuses its vertex pool; the next presentation then retires the previous
submission. No frame drains the display queue; `sceGxmDisplayQueueFinish` runs
at shutdown and display teardown. A failed frame closes its scene without
displaying partial work.
`Config::external_compositor` permits `SURFACE_QUAD` records to be supplied by
that native compositor; without it, such records return `Unsupported`.
`TEXT_RUN` remains unsupported. The host adapter in `programs/vita/src/scene.rs`
registers the process GXM device; frame resource views come from the runtime's
CoreState. Its generated guest uses the pinned Bellard QuickJS context.

## Checks

```sh
cargo +stable test --locked --manifest-path devices/vita/pocket-vita-render/Cargo.toml
cargo +stable clippy --locked --manifest-path devices/vita/pocket-vita-render/Cargo.toml --all-targets -- -D warnings
cargo +stable test --locked --manifest-path engine/Cargo.toml -p pocket-tex-cache
cargo +stable test --locked --manifest-path devices/vita/pocket-vita-gxm/Cargo.toml
bun tools/test-vita-runtime.ts
bun tools/test-quickjs-guest.ts --bellard
```

The native link check uses Rust nightly `2026-05-28` with `rust-src` and VitaSDK
`master-osx-v2.540` (GCC 15.2.0, built 2026-05-24). Install the VitaSDK packages
`libvita2d`, `libjpeg-turbo`, `libpng`, `zlib`, and `taihen` into the SDK's
`arm-vita-eabi` directory. Set `VITASDK` to that installation, then run:

```sh
export PATH="$VITASDK/bin:$PATH"
export TARGET_CC=arm-vita-eabi-gcc
export TARGET_CXX=arm-vita-eabi-g++
export TARGET_AR=arm-vita-eabi-ar
export POCKET_QJS_SOURCE="$(cargo +stable metadata --locked --format-version=1 \
  --manifest-path programs/vita/Cargo.toml | python3 -c 'import json,sys,pathlib; print(next(pathlib.Path(p["manifest_path"]).parent / "embed/quickjs" for p in json.load(sys.stdin)["packages"] if p["name"] == "libquickjs-sys"))')"
POCKETJS_EMBED_APP=0 cargo +nightly-2026-05-28 build --locked \
  --manifest-path programs/vita/Cargo.toml \
  --target armv7-sony-vita-newlibeabihf -Zbuild-std=std,panic_abort \
  --features runtime,capture --release
```

This builds `pocketjs-vita.elf`; it does not run an emulator or device. Keep SDK
and package hashes, build logs, and ELF/SELF receipts under ignored
`.pocket-build/validation/`. Pixel and timing acceptance on a device remains a
separate check.
