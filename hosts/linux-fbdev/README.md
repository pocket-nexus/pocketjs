# PocketJS Linux fbdev host

This host targets embedded Linux systems that expose a display through
`/dev/fb0` (Buildroot, BusyBox, and OpenWrt images are common examples).
It does not require OpenGL, Vulkan, Wayland, X11, or a GPU. Frames are
rasterized by `pocketjs-core` on the CPU and copied into the mapped framebuffer.
The default target profile is the connected RK3506B display geometry: a
720x1280 portrait framebuffer with a 360x640 logical viewport at raster
density 2. The logical size keeps touch coordinates within PocketJS's 10-bit
wide touch wire format while still covering the full panel.

The presenter reads the mode with `FBIOGET_VSCREENINFO` and
`FBIOGET_FSCREENINFO`, respects the reported stride and channel offsets, and
supports 16, 24, and 32 bits per pixel. `POCKET_FB` selects another device;
`POCKET_PAK` and `POCKET_JS` select the app package and bundle.

Build on the target or with a Buildroot-compatible Rust toolchain:

```sh
cargo build --release --manifest-path hosts/linux-fbdev/Cargo.toml
POCKET_FB=/dev/fb0 POCKET_INPUT=/dev/input/event0 POCKET_PAK=app.pak POCKET_JS=app.js \
  ./target/release/pocketjs-linux-fbdev
```

Run a fixed-frame software-rendering benchmark and read the FPS from stderr:

```sh
POCKET_BENCH_FRAMES=300 ./target/release/pocketjs-linux-fbdev
```

The presenter keeps the device dependencies small. It includes the standard
evdev touchscreen path described below. Devices exposing only DRM/KMS do not
satisfy the fbdev contract and need a DRM presenter. Vendor blitters such as
RGA can be added behind the presenter after the CPU path is validated; they are
optional and never a startup dependency.

## RK3506B touch validation

The Luckfox Lyra Zero W test device reports a Goodix GT9271 touchscreen as
`/dev/input/event0`, with `ABS_MT_POSITION_X/Y` ranges 0..719 and 0..1279.
The host reads this evdev node in non-blocking mode, maps the physical contact
to the 360x640 logical viewport, and sends PocketJS's 10-bit wide touch wire
format. Override the node with `POCKET_INPUT` when the event number changes.

`apps/clear` is the touch validation demo. Its RK3506B test manifest is kept
under `.pocket-build/validation/linux-fbdev/clear-rk3506.json`; build it with
the normal PocketJS CLI and run the resulting JS/pak pair with the command
above. The board image used for validation did not include `sendevent`, so
automatic contact injection was unavailable; the evdev parser is covered by a
host-side unit test and requires a physical finger pass for final UI acceptance.

On the three-core Cortex-A7 RK3506B board, the 720x1280 Clear demo measured
over 600 frames with the CPU rasterizer and full framebuffer presentation:

| Measurement | Result |
| --- | ---: |
| End-to-end host loop | 10.42 fps |
| Rasterizer only | 44.98 fps |
| Rasterizer time per frame | 22.2 ms |
| End-to-end time per frame | 96.0 ms |

A phase-timed 120-frame run on the same board measured 0.83 ms for
QuickJS plus the UI tick, 20.91 ms for the software rasterizer, and 67.38 ms
for the fbdev present step. The present step currently repacks every pixel
from RGBA8 into the framebuffer's BGRX8888 layout in a Rust loop, so it reads
and writes all 921,600 pixels on every frame.

The presenter now detects the device's BGRX8888 layout, asks the rasterizer
for that byte order directly, and copies one complete row at a time. The same
600-frame test then measured:

| Measurement | Before | After |
| --- | ---: | ---: |
| End-to-end host loop | 10.42 fps | 38.47 fps |
| Rasterizer only | 44.98 fps | 48.23 fps |
| fbdev present | 67.38 ms/frame | 4.55 ms/frame |

The optimized run used `render_scaled_argb` plus the BGRX row-copy path. Other
pixel layouts retain the generic per-pixel fallback.

The end-to-end number includes QuickJS, UI tick, rasterization, and writing
the complete 720x1280 framebuffer. No RGA or GPU acceleration was enabled.
