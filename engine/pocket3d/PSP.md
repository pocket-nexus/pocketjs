# pocket3d on PSP — the OpenStrike hardware port

*Design for running OpenStrike (GoldSrc-style FPS on the pocket3d substrate) on a
real Sony PSP, end to end and smooth — and for what pocket3d gains as a general
3D runtime along the way.*

Status: historical design record from 2026-07-08. The ownership proposal and
milestones below describe the original port. Current code ownership is in
[the Pocket3D README](README.md) and [device mechanisms](../../devices/README.md).
OpenStrike owns the BSP format, cooker and GE/GXM/GLES2 domain renderers under
[open-strike/domain](https://github.com/pocket-nexus/open-strike/tree/main/domain).
PocketJS owns its hosts and the reusable device kernels; the old crate paths
below are historical paths, not current build entrypoints.

## 1. Goal

`openstrike` today is a desktop binary: wgpu 25 + winit, rquickjs guest, GoldSrc
BSP v30 maps parsed at runtime, glTF soldier with GPU skinning. The PSP has none
of that — but it has something better positioned than any other target: the
repo's `hosts/psp/` host already runs QuickJS + the `ui` surface + a sceGu DrawList
backend at 60 fps on the hardware, with a proven memory model, build pipeline,
PPSSPP e2e harness, and PSPLINK debug loop.

The port therefore is not "make wgpu run on PSP". It is:

1. make the **map/collision substrate** (`pocket3d-bsp`) portable and complete
   (no_std core, PVS culling, a cooked asset format),
2. write a **second renderer backend** (`pocket3d-gu`, sceGu) against the same
   plain-data seam the wgpu renderer consumes,
3. make the PSP host a **library** (`hosts/psp/` lib + thin bin) so a game EBOOT
   can compose guest + `ui` surface + its own surface,
4. extract OpenStrike's game systems into a **portable core crate** and add a
   PSP EBOOT bin in the open-strike repo.

Every step except (4) is a general capability of pocket3d, not a PSP hack:
the cooked format speeds up desktop startup, PVS culling benefits every
backend, the portability split is what makes a *third* backend cheap.

## 2. What exists / what's missing

Verified against source (2026-07-08):

| Layer | Exists | Missing for PSP |
| --- | --- | --- |
| BSP parse (`pocket3d-bsp/raw.rs`) | GoldSrc v30, LE-explicit reader, Y-up convert | `std::fs` only in `load_map`/`wad.rs`; `HashMap` use |
| Collision (`trace.rs`, `collide.rs`) | clipnode hull trace + GoldSrc controller, pure glam | nothing — drops in as-is |
| Visibility | VIS lump read but **unused** | PVS decode, leaf→faces, point→leaf, per-frame visible set |
| Lightmaps (`lightmap.rs`) | 1024² RGBA atlas pages (4 MB/page) | PSP-sized strategy (vertex baking v1) |
| Textures (`wad.rs`) | WAD3 miptex → RGBA8 | keep them **CLUT8** (they are natively 8-bit paletted) + swizzle |
| Renderer | wgpu concrete (`renderer.rs`), no trait; `Scene`/`WorldSource` are plain data | the entire sceGu backend |
| Models (`model.rs`, `anim.rs`) | glTF load, GPU skinning; anim sampling is pure CPU math | cooked model format, CPU/GE skinning |
| Guest hosting | `pocket-mod` (rquickjs, desktop) | reuse `hosts/psp/` QuickJS embedding instead |
| PSP host (`hosts/psp/`) | arena allocator, QuickJS boot, `ui` ffi, GU 2D pass, pipelined present, dbg mailbox | lib-ification; depth buffer; a 3D pass in front of the 2D pass |
| Verification | PPSSPP byte-exact goldens (2D), tape goldens, hw bench (`--features bench`) | analog input in the capture script; 3D goldens |

Map data ground truth (de_dust2): 5 383 faces, 6 555 verts, 1 455 leaves,
PVS 69 KB compressed, clipnodes 65 KB, 44 textures (15 embedded, 29 from
`cs_dust.wad`/`halflife.wad`), lightmaps 491 KB RGB24. All comfortably inside a
32 MB PSP once cooked.

## 3. Crate layout

```
pocketjs repo
  engine/pocket3d/crates/pocket3d-bsp     [changed] no_std-able core; vis module; cooked module
  engine/pocket3d/crates/pocket3d-cook    [new]     desktop CLI: .bsp+.wad (+.glb) → .p3d
  engine/pocket3d/crates/pocket3d-gu      [new]     sceGu renderer; standalone (excluded from
                                             the desktop workspace, like hosts/psp/)
  hosts/psp/                          [changed] lib (modules: arena/alloc/c_heap/qjs_alloc/
                                             ffi/ge/pak/dbg/boot) + thin bin pocketjs-psp
                                             — byte-identical EBOOT behavior, e2e-guarded

open-strike repo
  crates/openstrike-core           [new]     game systems extracted from the bin:
                                             game/weapon/bot/state (+alloc, no wgpu/winit)
  crates/openstrike                [changed] desktop bin, now thin over openstrike-core
  crates/openstrike-psp            [new]     EBOOT bin: native host lib + pocket3d-gu +
                                             openstrike-core + strike ffi; standalone
  tools/psp.ts                   [new]     build JS bundle → cook map/model → cargo psp
```

Why the split lands this way: game code stays open-strike IP; everything the
*next* 3D game on PSP would need (map substrate, GU renderer, host library,
cooker) lands in pocketjs as reusable machinery. `pocket3d-gu` and
`openstrike-psp` are standalone crates outside any workspace for the same
reason `hosts/psp/` is: cargo-psp wants a lone bin, and workspace membership
would break desktop `cargo check` on a tier-3 target.

## 4. The cooked format (`.p3d`)

`load_map` parses BSP+WAD at runtime on desktop. On PSP we cook offline
instead — not only for parse time, but because the cooked layout is built for
**zero-copy GE consumption out of `.rodata`**: the EBOOT embeds the `.p3d`
via `include_bytes!`, we `sceKernelDcacheWritebackRange` the region once at
boot, and the GE reads vertices, index bases, CLUTs and texels directly from
the module image. The map costs its file size in RAM and nothing more; the
arena stays free for QuickJS and game state.

Container: `P3D1` magic, LE, a section table of `(tag, offset, len)` with all
section payloads 16-byte aligned. World sections:

- `WVTX` — world vertices, final GE layout `[u,v:f32][color:u32 ABGR][x,y,z:i16][pad]`
  (20 B/vertex, `GU_TEXTURE_32BITF | GU_COLOR_8888 | GU_VERTEX_16BIT`).
  GoldSrc coordinates fit i16 natively; UVs are normalized-tiled floats
  (dropping to `GU_TEXTURE_16BIT` + `sceGuTexScale` is a reserved 4 B/vertex
  lever). **Vertex color = baked lighting** (see §5). Coordinates are Y-up —
  the same space as collision, the character controller, and the game.
- `WIDX` — u16 triangle indices, grouped per *face run* so visibility can
  splice face-granular ranges.
- `WBAT` — batches keyed by (texture, SurfaceKind), each an array of face
  runs `(first_index, index_count, face_id)`.
- `WTEX` — textures as **swizzled CLUT8 + 256×RGBA8 palette + full mip chain**
  (WAD3 miptex are already 8-bit paletted with 4 mips; we keep them native and
  extend the chain down to 8×8). `{`-transparency (index 255) marks the batch
  alpha-test.
- `WVIS` — decompressed-per-leaf-friendly PVS (raw RLE rows as in the lump,
  plus leaf count), leaf AABBs, leaf→marksurface lists, and the render-BSP
  node tree for point→leaf.
- `WCLP` — clipnode hulls 0–3 verbatim (the existing `trace.rs` structures,
  serialized), plus solid brush-model entity registry.
- `WENT` — spawns (CT/T), sun (`light_environment`), map bounds, sky colors.

Model sections (`MVTX`/`MSKL`/`MCLP` — mesh with u8 joint indices + u8 weights,
joint hierarchy, animation clips) reuse the same container for the soldier.

The cooker is `pocket3d-cook`: `cargo run -p pocket3d-cook -- de_dust2.bsp
--wads support/ -o dust2.p3d`. It reuses `pocket3d-bsp`'s parser, so cook and
runtime can never drift. A `cooked` module in `pocket3d-bsp` holds the format:
a no_std zero-copy reader (used by PSP) and a std writer (used by the cooker).
Desktop gains `WorldSource::from_cooked` so the same `.p3d` renders under wgpu
— that's the visual verification path for the cooker itself.

## 5. Rendering on the GE

Frame structure (all inside the existing `sceGuStart`…`sceGuFinish` owned by
the host loop, before the 2D `ge::render` HUD pass):

1. **Sky** — clear color+depth, then a screen-space gradient quad + sun disc
   (the wgsl sky, evaluated per-vertex on a small grid), depth write off. Sky
   *faces* in the world are skipped; the background shows through.
2. **World opaque** — `sceGumDrawArray(Triangles, indexed u16)` per batch,
   CLUT8 texture + per-batch CLUT load, vertex color = baked light,
   `sceGuTexFunc(Modulate)`, depth test+write on. Visible set from PVS ∩
   frustum (see below).
3. **World alpha-test** — same, `sceGuAlphaFunc(Greater, 0x7f)` for `{`
   textures (fences, grates).
4. **Models** — soldier instances CPU-skinned into the per-frame vertex pool
   (palette math = the existing portable `anim.rs`/`joint_palette`), rifle
   viewmodel drawn last with depth cleared (its own small depth range), both
   as `GU_VERTEX_32BITF` triangles.
5. **Sprites/beams** — camera-facing quads built CPU-side, additive blend,
   one procedural glow texture built at boot.
6. **2D HUD** — the untouched `ge::render` DrawList pass (depth test off);
   PocketJS JSX HUD composites exactly like on desktop (`LoadOp::Load`
   equivalent: we simply don't clear).

**Visibility** is a portable `vis` module in `pocket3d-bsp`, not GU code:
point→leaf walk, PVS row decode cached per leaf change, leaf AABB frustum
test, face dedup by frame-stamp, output = per-batch spliced index ranges.
The PSP renderer copies the spliced u16 ranges into the frame pool and draws;
a future desktop adopter can feed the same output to an index buffer. Dust2's
visible set from typical positions is a few hundred faces — the GE's transform
budget at 60 fps is not the constraint; fill rate is, and PVS is what caps
overdraw.

**Lighting v1 = vertex-baked.** The cooker subdivides large faces (target edge
≤ 96 units, configurable) and samples the face's lightmap bilinearly at every
vertex into the `color` field (GoldSrc 2× overbright folded in, clamped).
One pass, zero extra texture memory, looks right for dust2's soft outdoor
shadows at 480×272. Estimated cost: ~2–3× vertex count (≈ 300–500 KB more
`.rodata`). The classic two-pass lightmap-atlas multiply
(`sceGuBlendFunc(Add, DstColor, Fix0)`) stays on the table as an A/B
experiment once the game is smooth — the section table makes the format
addition append-only.

**Framebuffer** stays double-buffered 512×272 PSM8888 + 16-bit Z
(1.39 MB of 2 MB VRAM) so every existing capture/screenshot/devtools tool
keeps working unmodified. Textures are sampled swizzled from main RAM (the
standard PSP approach). If hardware profiling shows ROP-bound frames, dropping
to PSM5650 halves write bandwidth and frees ~560 KB VRAM for hot textures —
that's lever #1, reserved.

**Depth range** comes from cooked map bounds (dust2 ≈ 4.6 k units diagonal),
znear 4 — not the desktop's zfar 16384 — to keep 16-bit Z artifact-free.

## 6. Game + guest on PSP

`openstrike-core` extracts `game.rs`/`weapon.rs`/`bot.rs` + the
command/event/state types unchanged (they are already pure math over
`TraceWorld` + xorshift RNG; fixed dt moves 64 Hz→60 Hz, parameterized).
The desktop bin keeps its rquickjs `guest.rs`; `openstrike-psp` registers the
same hand-written `strike` surface through the `native` host's `add_fn`
pattern onto `globalThis.strike`, and preserves the exact desktop turn order:
drain events → `strike.__dispatch(state, events)` → `frame(buttons)` →
`ui.tick()` → apply queued commands. The JS bundle (`rules.ts` + `hud.tsx` +
`sdk.ts`) is built by the unchanged two-pass pipeline and embedded like any
PocketJS app.

**Input mapping** (PSP pad → `MoveInput` natively, per tick, in Rust):

| PSP | Action |
| --- | --- |
| analog stick | move (deadzone 28, magnitude-scaled wishspeed) |
| △ / ✕ / □ / ○ | look up / down / left / right (accelerating curve) |
| R | fire |
| L | jump |
| d-pad down | reload |
| d-pad up | walk (0.52×) |
| START | pause (host-level) |

The `u16` button mask still reaches the guest `frame()` untouched (the `ui`
contract is unchanged); analog is consumed by the native game core only. The
DevTools input tape therefore records buttons but not analog — 3D replay
fidelity needs the capture harness's extended script format (below); wiring
analog into the tape ring is a follow-up, not v1.

## 7. Memory budget (32 MB PSP-1000 baseline)

| Item | Est. |
| --- | --- |
| EBOOT image: code (QuickJS + host + game) | ~2.5 MB |
| embedded `dust2.p3d` (geometry + CLUT8 textures + vis + hulls) | ~3.5 MB |
| embedded soldier `.p3d` + `openstrike.{js,pak}` | ~1.0 MB |
| arena (everything else: QuickJS heap, UI core, pools) | remainder ≈ 16 MB |

The arena already sizes itself from `sceKernelMaxFreeMemSize()` − 2 MB. No new
memory machinery is needed; the map deliberately never enters the arena.

## 8. Verification ladder

1. **Desktop unit/integration** — `pocket3d-bsp` vis + cooked round-trip tests
   gated on the real maps (`POCKET3D_TEST_MAPS`); cooker CLI goldens (face/
   vert/leaf counts, texture inventory for dust2); `WorldSource::from_cooked`
   renders under wgpu (screenshot sanity via openstrike `--screenshot`).
2. **Host lib-ification guard** — `bun run e2e` + `bun run tape:check` must
   stay byte-identical after `hosts/psp/` becomes a lib (same goldens, no
   re-baseline allowed).
3. **PPSSPP (emulator, deterministic)** — openstrike-psp capture builds bake
   an extended input script `(frame, buttons, ax, ay)`; scripted sequences
   (spawn → walk CT-mid → aim → fire) dump framebuffers exactly like
   `tests/e2e/ppsspp.ts`; goldens byte-exact per PPSSPP commit, software
   renderer.
4. **Real hardware** — `bun run hw`-style launch over PSPLINK; `--features
   bench` gives `avg_work_us` vs the 16 667 µs budget plus `avg_gpu_us`;
   the DevTools mailbox rides along for `console`/eval. Smoothness bar:
   **stable 60 fps in representative dust2 loops; hard floor 30 fps in the
   worst vista**, measured by the bench skill's methodology (emulator numbers
   are never quoted as hardware proof).

## 9. Milestones

- **M1** `pocket3d-bsp`: no_std core + `vis` + `cooked` + `pocket3d-cook`;
  desktop tests green. *(general capability)*
- **M2** `hosts/psp/` lib + thin bin; e2e/tape byte-identical. *(general)*
- **M3** `pocket3d-gu` world renderer; dust2 flythrough EBOOT in PPSSPP
  (camera on rails, no game). *(general)*
- **M4** `openstrike-core` extraction (desktop headless scripts still pass) +
  `openstrike-psp`: movement + collision + camera on PPSSPP.
- **M5** combat loop: weapons, bots (procedural stand-in body), rounds,
  `strike` surface, JSX HUD composited; PPSSPP e2e goldens.
- **M6** hardware bring-up + optimization to the smoothness bar (PVS/batch
  tuning, texture residency, PSM5650 lever, VFPU wins as needed).
- **M7** skinned soldier (cooked skeletal model, CPU skinning; GE hardware
  skinning ≤8 bones as the follow-up if CPU skinning eats the budget).
- **M8** PRs (pocketjs: M1–M3; open-strike: M4–M7 + submodule bump), docs,
  docs/RUNTIMES.md note: the PSP is now a first-class pocket3d target.

## 10. Non-goals (v1)

Water rendering (dust2 has none), decals, `func_breakable` glass physics
(kept static-solid, as on desktop), GoldSrc MDL loading (the soldier stays
glTF→cooked), netplay, sound, PVS adoption in the wgpu renderer (API is
shared; wiring it is a desktop follow-up), analog input in DevTools tapes.
