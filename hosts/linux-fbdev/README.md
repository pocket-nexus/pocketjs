# PocketJS Linux fbdev host

This host targets embedded Linux systems that expose a display through
`/dev/fb0` (Buildroot, BusyBox, and OpenWrt images are common examples).
It does not require OpenGL, Vulkan, Wayland, X11, or a GPU. Frames are
rasterized by `pocketjs-core` on the CPU and copied into the mapped framebuffer.
The default target profile is the connected RK3506B display geometry: a
720x1280 portrait framebuffer with a 360x640 logical viewport at raster
density 2. The logical size keeps touch coordinates within PocketJS's 10-bit
wide touch wire format while covering the full panel.

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
evdev touchscreen path described below. Devices exposing DRM/KMS without fbdev
do not satisfy the fbdev contract and need a DRM presenter. The optional `rkrga`
feature adds a Rockchip RGA presenter; the default build has no vendor SDK or
runtime library dependency.

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
| Rasterizer throughput | 44.98 fps |
| Rasterizer time per frame | 22.2 ms |
| End-to-end time per frame | 96.0 ms |

A phase-timed 120-frame run on the same board measured 0.83 ms for
QuickJS plus the UI tick, 20.91 ms for the software rasterizer, and 67.38 ms
for the fbdev present step. The original present path repacked every pixel
from RGBA8 into the framebuffer's BGRX8888 layout in a Rust loop, so it read
and wrote all 921,600 pixels on every frame.

The presenter detects the device's BGRX8888 layout, selects that byte order
for rasterization, and copies one complete row at a time. The same
600-frame test then measured:

| Measurement | Before | After |
| --- | ---: | ---: |
| End-to-end host loop | 10.42 fps | 38.47 fps |
| Rasterizer throughput | 44.98 fps | 48.23 fps |
| fbdev present | 67.38 ms/frame | 4.55 ms/frame |

The optimized run used `render_scaled_argb` plus the BGRX row-copy path. Other
pixel layouts retain the generic per-pixel fallback.

## Rockchip RGA backend

Build with the optional `rkrga` feature to render the 360x640 logical surface
on the CPU and resize it to the 720x1280 BGRX framebuffer with Rockchip RGA:

```sh
export POCKET_RKRGA_SDK="$RK_SDK/external/linux-rga"
cargo build --release --features rkrga \
  --target armv7-unknown-linux-gnueabihf \
  --manifest-path hosts/linux-fbdev/Cargo.toml
```

Build `librga.so` from that SDK with the board's
`arm-none-linux-gnueabihf-gcc` toolchain, deploy it beside the host, and run:

```sh
LD_LIBRARY_PATH=/opt/pocketjs \
POCKET_RKRGA_LIB=/opt/pocketjs/librga.so \
POCKET_FB=/dev/fb0 POCKET_INPUT=/dev/input/event0 \
POCKET_PAK=app.pak POCKET_JS=app.js \
  /opt/pocketjs/pocketjs-linux-fbdev
```

RK3506's RGA driver runs without an MMU and rejects memory without contiguous
physical pages. The backend allocates source and destination buffers
from `/dev/dma_heap/linux,cma`, wraps their dma-buf fds with IM2D, and performs
the required DMA cache synchronization. The CPU rasterizer writes into the
mapped CMA source buffer, avoiding an extra source copy. RGA output is copied
from the CMA destination into fbdev because this board does not expose the
fbdev allocation as an importable dma-buf. The destination allocation uses the
fbdev stride, and the presenter copies each visible row into the mapped device.

### Acceleration boundary

**RGA is a fixed-function 2D DMA/blit engine, not a GPU renderer.** Supported
formats, blend modes, buffer types, and operations vary across Rockchip SoCs,
kernel drivers, and `librga` releases. A DrawList operation accepted by one RGA
generation may be absent or have different constraints on another generation.

**The `rkrga` feature uses one cross-device operation: nearest-neighbor 2x
resize from BGRX8888 to BGRX8888.** **Complex DrawList rendering remains in
software.** The CPU rasterizer handles glyphs, rounded geometry, gradients,
textured triangles, clipping, and alpha blending into a persistent 360x640 CMA
source buffer. RGA resizes that completed surface to the 720x1280 framebuffer
geometry. This split preserves the PocketJS DrawList contract when the vendor
engine cannot represent an operation.

The DrawList damage tracker repaints changed logical regions and retains the
other source pixels. A tick with no pixel damage skips the RGA submission and
framebuffer copy. A tick with damage performs a full-surface RGA resize
and copies the full visible RGA destination into fbdev. RK3506B does not expose
the fbdev allocation as an importable dma-buf, so this final copy remains in
the presentation path.

### RK3506B benchmark results

All measurements below use the same three-core Cortex-A7 RK3506B and its
720x1280 BGRX8888 fbdev panel. `POCKET_BENCH_FRAMES` removes the 60 Hz sleep, so
the reported FPS is sustained host throughput rather than panel refresh
rate. End-to-end time includes QuickJS, the UI tick, CPU rasterization, RGA
submission where enabled, and the framebuffer write.

The Clear full-presentation benchmark represents a light interface with a
small DrawList:

| Phase | CPU 2x + row copy | CPU 1x + RGA 2x |
| --- | ---: | ---: |
| Guest + UI tick | 0.69 ms | 0.67 ms |
| CPU raster | 20.73 ms | 6.47 ms |
| Present | 4.55 ms | 8.92 ms |
| End-to-end | 38.47 fps | 62.21 fps |

The balanced HMI workload represents a process-control panel with four metric
cards, status indicators, text, rounded controls, a trend graph, two progress
bars, and touch targets. Sensor values and graph state change on every tick.
Each tick damaged an average of 15,623 of 230,400 logical pixels, or 6.8% of
the logical surface. Three 600-frame runs produced these median values:

| Phase | CPU 2x + row copy | CPU 1x incremental + RGA 2x |
| --- | ---: | ---: |
| Guest + UI tick | 6.73 ms | 7.02 ms |
| CPU raster | 29.10 ms | 2.12 ms |
| Present | 5.68 ms | 9.84 ms |
| End-to-end | **24.28 fps** | **52.62 fps** |

The three software runs measured 24.28, 24.28, and 23.78 fps. The three RGA
runs measured 52.57, 52.62, and 52.63 fps. **The RGA path increased sustained
HMI throughput by 2.17x.** Its 19.0 ms frame cost misses the strict 16.67 ms
deadline for 60 Hz. **The HMI workload sustains about 53 fps, which is adequate
for fluid value changes, progress motion, and touch feedback on this panel.**
Panels that update sensor values at 10-20 Hz spend the ticks between updates in
the no-damage path.

A resource sample used the same HMI with changes on every tick and the normal
runtime cadence. Each presenter ran for a 3-second warmup followed by one
10-second measurement window. CPU time came from `utime + stime` in
`/proc/<pid>/stat` with Linux `USER_HZ=100`; 100% denotes one core occupied for
the full window. RSS and PSS are the averages of ten samples from
`/proc/<pid>/status` and `/proc/<pid>/smaps_rollup`:

| Resource | CPU 2x + row copy | CPU 1x incremental + RGA 2x |
| --- | ---: | ---: |
| Process CPU, one-core basis | 100.19% | 88.31% |
| Share of three-core capacity | 33.40% | 29.44% |
| Average RSS | 13,984 KiB (13.66 MiB) | 15,764 KiB (15.39 MiB) |
| Average PSS | 13,368 KiB (13.05 MiB) | 15,056 KiB (14.70 MiB) |
| Peak RSS (`VmHWM`) | 13,984 KiB | 15,764 KiB |
| Host threads | 1 | 1 |

**The RGA path reduced process CPU use by 11.88 percentage points and added
1,780 KiB of resident memory for this HMI workload.** The RGA process owns a
360x640 CMA source, a 720x1280 CMA destination, and the loaded vendor library;
the software process owns a 720x1280 raster buffer. RSS and PSS cover process
mappings and do not include allocations retained inside the kernel RGA driver.

Damage retention validation used a static 600-tick Clear run. The
first tick performed one full redraw and one RGA presentation; the next 599
ticks reported no pixel damage and skipped both operations. The uncapped run
completed in 1.455 seconds. This result measures idle host-loop throughput,
not panel refresh rate.

**The default build remains vendor-neutral and uses full-resolution software
rasterization.** The `rkrga` build uses software rendering for the complete
DrawList, RGA for 2x scaling, and a 60 Hz runtime cadence.
