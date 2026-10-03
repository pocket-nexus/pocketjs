# pocket-vita-gxm

PS Vita device mechanisms shared by Pocket Atlas and the BSP renderer used by
OpenStrike. The crate is hosted in PocketJS so applications can pin one revision
with their existing toolchain and host dependency. It does not depend on the
PocketJS JavaScript runtime, BSP, PlaceIR, or either application's materials.

- `mem`: CDRAM / uncached main-memory blocks, arenas and frame rings. GPU access
  flags remain explicit; OpenStrike requests read-only mapping, Atlas read/write.
- `program`: aligned GXP storage, registration and GXM patching. Static programs
  can register without a copy. Runtime-compiled programs own their storage.
- `patcher`, `target`, `texture`: GXM resources and texture descriptors.
- `runtime-compiler` feature: optional SceShaccCg loading / compilation. Atlas
  enables it for development; OpenStrike uses its existing embedded GXPs.

These are GXM operations, not a portable GPU API. Applications own shaders,
render passes, frame submission, presentation, quality settings and scene
formats. Target compilers remain free to exploit the device's formats and costs.
Do not put scene names, material models, visibility policy or asset cooking here.

`ColorFormat::R32f` stores one 32-bit float per pixel and samples it as RRRR;
its fragment output format is `Output::Float`. `ColorFormat::Rg16Unorm` stores
two normalized 16-bit channels per pixel, preserves shader R/G in sampled
`.rg`, and uses `Output::Ushort2`. Both allocate **4 bytes per pixel** and use
32-bit output registers. For `Ushort2`, a fragment entry returns `float4 COLOR`
with normalized R/G in `[0, 1]`, not floats scaled to `[0, 65535]`. Data passes
disable blending and dithering. Storage and patcher output formats do not
increase the precision of arithmetic or conversions compiled into a GXP.

## Lifetime contract

The caller owns the render thread and GPU completion. `free` / `unregister` are
explicit: first stop submission and wait for the GPU, release patched programs,
unregister programs, then free their storage and the patcher. Rings only reuse a
segment after the caller has waited for its previous frame. No destructor inserts
an implicit GPU wait. Error cleanup follows the same ownership order.

Atlas calls these primitives directly. OpenStrike owns the BSP renderer in
`domain/crates/pocket3d-vita`; it uses the same device kernel. GE and PICA kernels
live alongside this crate and expose their native mechanisms independently.

## Validation

```sh
cargo test --locked --manifest-path devices/vita/pocket-vita-gxm/Cargo.toml
# With VitaSDK, a nightly Rust toolchain and rust-src:
cargo +nightly-2026-05-28 check --locked \
  --manifest-path devices/vita/pocket-vita-gxm/Cargo.toml \
  --features runtime-compiler \
  --target armv7-sony-vita-newlibeabihf -Z build-std=std,panic_abort
# Application target compilation is covered by Atlas and OpenStrike builds.
```

Host tests cover allocation arithmetic. Target compilation checks GXM bindings.
Neither proves GPU execution, shader compilation on the console, or resource
release while switching scenes; those require application device tests.
