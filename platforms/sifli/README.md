# SiFli SF32LB5x platform

**A SiFli program links one Rust archive, the drivers in this directory and
its own composition.** The archive (`programs/sifli/archive`) contains the
canonical runtime and the EPIC renderer's C factory. The program creates a
runtime from its exported host contract, registers the generated QuickJS guest, a
package source, the renderer, the framebuffer display and input sources, and
starts the runner thread. It owns board files, the partition table,
`proj.conf`, framebuffer storage and any switching between applications.

| Unit | Source | Kconfig |
| --- | --- | --- |
| DrawList renderer and its C factory | `render-epic/` (Rust, `pocket-render-sifli-epic`) | linked through the archive |
| EPIC executor behind `pocket_epic_ops`, VG Lite on SF32LB58 | `epic/` | `POCKETJS_EPIC`, `POCKETJS_EPIC_VGLITE` |
| `pocket_host_*` heap, panic and log hooks; memory package source | `hooks/hooks.c`, `hooks/package.c` | `POCKETJS` |
| SF32LB58x MPU table | `hooks/mpu.c` | `POCKETJS_MPU_OVERRIDE` |
| Framebuffer ring over the RT-Thread `lcd` device | `display/display.c` | `POCKETJS_DISPLAY` |
| Board keys, touch contacts | `input/keys.c`, `input/touch.c` | `POCKETJS_INPUT_KEYS`, `POCKETJS_INPUT_TOUCH` |
| Generated QuickJS guest with heap and stack limits | `guest/guest.c` | `POCKETJS_GUEST_QUICKJS` |
| Runner thread | `runner/runner.c` | `POCKETJS_RUNNER` |
| Native texture baker | `tools/build/sifli/epic.ts` | |

`include/pocket/sifli.h` declares the drivers;
`render-epic/include/pocket/render_sifli_epic.h` declares the renderer factory
and the executor table. Only the runner creates a thread. Only `epic/`
includes EPIC and VG Lite headers, and it owns `EPIC_IRQHandler`: keep
`BSP_USING_EPIC` (the SDK's `drv_epic`) and LVGL out of the build.

## Build

The project's `SConscript` includes the SDK, then this directory, then its own
sources; `Kconfig.proj` sources the menu:

```python
objs.extend(SConscript(os.path.join(POCKETJS_ROOT, 'platforms', 'sifli', 'SConscript'),
                       variant_dir='pocketjs', duplicate=0))
```

```
source "$POCKETJS_ROOT/platforms/sifli/Kconfig"
```

```sh
bun tools/pocket.ts host export --config pocket.host.config.ts --out build/profile
bun tools/pocket.ts compile --manifest pocket.app.json --project-root . \
  --host-config pocket.host.config.ts --output build/app.pocket
bun tools/build/sifli/epic.ts --pocket build/app.pocket --out build/app.epic
POCKET_PROFILE_EXPORT_DIR=$PWD/build/profile scons --board=<board> -j8
```

**Viewport, render scale, raster density and tick rate come from the exported
host contract**, not from Kconfig; the SConscript stops when
`POCKET_PROFILE_EXPORT_DIR` holds no `pocket_profile.h`. `PocketjsEmbed(name,
path)`, exported by the SConscript, links a file in `.rodata` at **64-byte
alignment** as `pocketjs_<name>_data` with its length in the 32-bit
`pocketjs_<name>_size`; programs embed the `.pocket` package and the `.epic`
table with it.

The embedded file is a dependency of its assembly **object**, so replacing
package or texture bytes rebuilds the `.incbin` object. A program link also
depends on the Rust archive even though it is passed through `LINKFLAGS_POST`.

With `POCKETJS_RUST_FROM_SOURCE=y` the SConscript runs `cargo build --release
--locked --no-default-features --target thumbv8m.main-none-eabihf` on
`programs/sifli/archive` from the checkout root, so rustup selects the
toolchain in `rust-toolchain.toml`; the target must be installed. Without it,
`POCKET_RUNTIME_ARCHIVE` names a prebuilt `libpocket_sifli_runtime.a`. **Every
SF32LB5x HCPU is a Cortex-M33 with FPU; one target serves 52x through 58x.**

## Renderer

**The target is a device-owned RGB565 framebuffer; the renderer is Deferred.**
A display hands out device handle N for `framebuffers[N - 1]`, and the
executor binds the same array. The presentation coordinator supplies the
damage rectangles of the framebuffer it acquired, so damage history follows
each framebuffer's retained pixels.

Per frame the renderer decodes the DrawList once with `pocket-draw-ops`,
recovers the rectangles and quads the core flattened into triangle pairs, and
groups consecutive coverage-only texture quads into one A8 run. For each
damage rectangle it clears the covering logical pixels and replays every
planned item clipped to it. An item goes to hardware when the executor's
capabilities include it and its physical area reaches the executor's
threshold; otherwise it joins a CPU batch.

| DrawList operation | Hardware command | CPU path |
| --- | --- | --- |
| RECT, opaque | `Fill` | below `min_fill` |
| RECT, translucent | `FillAlpha`, else an A8 plane filled with the alpha | below `min_blend` |
| GRAD_RECT | `Gradient` for unclipped opaque two-stop gradients | clipped or translucent |
| GLYPH_RUN | atlas coverage in an A8 plane, one `BlendA8` per band | below `min_blend` |
| TEX_QUAD, coverage-only texture | consecutive quads in one A8 plane | below `min_blend` |
| TEX_QUAD, other textures | `Blit` of a registered texture | fractional texel edges, no registration, tint or vertical mirror without the capability |
| TEX_TRI pair | `Blit` when upright; `BlitQuad` with VG Lite; `BlitRotate` on 52x after preflight | unpaired, no registration, unsupported transform |
| TRI pair, flat color | `Fill`/`FillAlpha` when upright, else a solid `BlitQuad` | unpaired, Gouraud colors |
| SCISSOR, TEXT_RUN, SURFACE_QUAD | none | none |

**Damage clips writes without changing a scaled texture's sampling map.**
An on-screen quad within the coordinate limit keeps its original source and
destination rectangles and passes damage/scissor bounds as `Blit.clip`.
Fractional UVs introduced only by damage do not force CPU rendering. Larger
or off-screen quads still need an integral source crop; source UVs are never
rounded to make a hardware operation fit.

**The CPU never writes a framebuffer.** A CPU batch renders with
`engine/raster` into one of two SRAM tiles after `TileOut` copied the target
band into it and a fence completed the copy; `TileIn` copies it back. A8 runs
larger than a plane split into row bands, and a plane is rewritten only after
a fence retired the blend that read it. Fills and bands split at
`EPIC_COORDINATES_MAX` (**1010 on 55x/56x/58x, 505 on 52x/57x**).

CPU texture and triangle fallbacks bound their copied tiles to their
geometry, intersected with damage and scissors. Triangle fallback traverses the exact covered interval
of each row and steps integer edge weights, preserving the rasterizer's
pixel-center coverage and UV interpolation.

**52x rotates native texture rectangles through EPIC.** `BlitRotate` keeps
the source rectangle and four destination vertices, with a separate clip.
The executor's read-only `can_blit_rotate` callback fits rotation and uniform
scale to the rounded vertices before the renderer submits a command. The
HAL angle is quantized to 0.1 degree and inverse scale to units of 1/1024.
After quantization, every vertex must remain within **one physical pixel per
axis** of its supplied position. The source width plus height and destination
extents must each fit the coordinate limit. Reflections, nonuniform scales,
shear and perspective outside that tolerance, RGB tint and missing native
registrations retain CPU rendering. Solid-color triangles still require
VG Lite or CPU rendering.

The HAL rotates texel centers; the executor offsets the edge-based DrawList
mapping by half a texel/pixel to preserve placement. EPIC's sampling and edge
coverage need not match the software rasterizer at arbitrary angles. Damage
and scissors clip the hardware result without changing its mapping. The
rotation capability is separate from `blit_quad`; 52x does not enable VG
Lite. Older executor ops tables omit the optional tail callback and keep
the CPU path.

The frame's last commands stay in flight after `render` returns; the next
render, the coordinator's renderer wait or retirement completes them through
the executor's `end`. A frame that blits a portable registration completes
before `render` returns, because the core's texture storage is borrowed for
that call only. The renderer does not declare zero-copy: the C renderer
adapter waits inside zero-copy calls, which would remove the overlap with the
next guest turn.

## Native textures

**Textures reach hardware through registrations.** On the first blit of a
texture revision the renderer computes the source digest of its texture view
and looks it up in the `.epic` table the program passed at creation. A match
registers the native copy; without one, an executor with VG Lite registers the
portable bytes; otherwise the texture stays on the CPU. Registrations are
cached by handle and revision and released when a newer revision replaces
them and no submission reads them.

`epic.ts` turns every `ui:img.*` entry of a package into one 64-byte aligned
payload in EPIC channel order: **RGB565 with red in the high bits, BGRA8888,
or L8 behind a 1024-byte BGRA palette**. `--opaque RRGGBB` composites PSM_8888
alpha over one color at bake time and stores opaque RGB565. The source digest
is FNV-1a 64 over the texture's width, height, PSM code, PSM_T8 palette and
decoded pixels, as `native::source_digest` computes it. The core keeps the
portable bytes, so software fallback reads the same texels.

The executor reads registered storage from **64-byte aligned addresses** and
cleans it from the data cache once at registration. The `.epic` table meets
the alignment when linked with `PocketjsEmbed`. Core texture storage carries
no such guarantee: portable registrations of unaligned textures return
`POCKET_STATUS_UNSUPPORTED` and those textures render on the CPU.

## Buffers

- **Framebuffers belong to the program.** It places them in memory EPIC and
  the LCD controller read without cache maintenance and passes the same array
  to `pocket_sifli_epic_create` and `pocket_sifli_display_create`. On SF32LB58
  the program links them into PSRAM2 (`0x62000000..0x62FFFFFF`) and enables
  `POCKETJS_MPU_OVERRIDE`, which marks that window non-cacheable at startup
  and keeps PSRAM1 cached. With the override the display rejects framebuffers
  outside PSRAM2.
- **A8 planes and fallback tiles live in on-chip SRAM** (`L1_NON_RET_BSS`), two
  of each, `POCKETJS_EPIC_MASK_TILE_KB` and `POCKETJS_EPIC_CPU_TILE_KB` each,
  **64 KB by default, 256 KB in all**.
- The `pocket_host_*` hooks allocate from one `rt_memheap` of
  `POCKETJS_HEAP_KB` (**7 MiB by default**) in cached PSRAM; the QuickJS guest
  allocates from the same heap under its own `heap_limit`.

## Presentation

The display declares device-owned targets, device frame storage, partial
refresh and double buffering; each framebuffer reports its own buffer
identity. A frame takes the most recently presented framebuffer that the
panel neither scans nor is being switched to: **two framebuffers alternate**,
and a third covers a present that timed out.

Flush starts one `draw_rect_async` of the whole framebuffer after the renderer
wait. Display wait returns at its `tx_complete`, which makes that framebuffer
the scanned one; a wait longer than `wait_timeout_ms` fails and keeps the
framebuffer reserved until the present lands. The EPIC executor keeps **one
interrupt-driven transaction in flight**; a command for the other engine
drains the one in use, and begin, fence and end drain both.

## Open on a board

Host regression checks for damage, fallback pixels and triangle coverage:

```sh
cargo test --locked -p pocket-raster -p pocket-render-sifli-epic -p pocketjs-core
cargo clippy --locked -p pocket-raster -p pocket-render-sifli-epic --all-targets --no-deps -- -D warnings
cargo test --locked -p pocket-render-sifli-epic --features cabi,pocket-runtime-cabi/std
```

The rotation preflight also runs on the host, with address/undefined-behavior
sanitizers and no SDK dependency:

```sh
mkdir -p .pocket-build/validation/rotation/host
cc -std=c11 -Wall -Wextra -Werror -fsanitize=undefined,address \
  -Iplatforms/sifli/render-epic/include -Icontracts/generated \
  platforms/sifli/epic/rotate.c platforms/sifli/tests/rotation_geometry.c \
  -lm -o .pocket-build/validation/rotation/host/geometry
.pocket-build/validation/rotation/host/geometry
```

For a hardware clipping check, add `tests/clip_selftest.c` to the diagnostic
program and call `pocket_sifli_epic_test_clip(epic, framebuffers[0],
framebuffers[1], width, height)` after creating the executor, before starting
the renderer. It repaints both buffers and compares every pixel of a clipped
scaled alpha blit to a full blit, including supported mirror modes; pixels
outside the clip must retain the background. It returns 0 on success and
prints the first mismatch otherwise. This checks EPIC output without a panel.

Add `tests/rotation_selftest.c` and call `pocket_sifli_epic_test_rotation`
with the same arguments on 52x, using buffers of at least 128x128. It checks
32 combinations of rotation, scale, atlas cropping, global alpha and partial
off-screen placement. It compares clipped/full hardware output pixel for
pixel, checks colored landmarks, and compares every pixel at 0/90/180/270
degrees and unit scale against an independent expected image. Both tests
repaint the buffers and must run before the renderer starts.

A link result is not a device run. Open:

- that `tx_complete` of a RAM-less DPI panel follows the switch of the scanned
  framebuffer, which the two-framebuffer rotation depends on;
- VG Lite channel order for tints, `VG_LITE_BLEND_SRC_OVER` over straight-alpha
  sources, projective sampling phase and its alignment requirement for
  registered portable textures;
- per-transaction cost behind `POCKETJS_EPIC_MIN_PIXELS` and the engine switch
  cost;
- runner pacing on the RT-Thread tick and the guest stack limit on the runner
  thread.

Keep UART logs, maps and receipts in ignored
`.pocket-build/validation/<task>/<run>/` or an artifact store.
