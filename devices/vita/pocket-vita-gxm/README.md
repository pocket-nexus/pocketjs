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

## Lifetime contract

The caller owns the render thread and GPU completion. `free` / `unregister` are
explicit: first stop submission and wait for the GPU, release patched programs,
unregister programs, then free their storage and the patcher. Rings only reuse a
segment after the caller has waited for its previous frame. No destructor inserts
an implicit GPU wait. Error cleanup follows the same ownership order.

Atlas calls these primitives directly. The existing `pocket3d-vita` renderer
wraps memory and shader registration for its BSP pipeline; its scene policy and
shaders remain in `engine/pocket3d`. Moving that renderer into OpenStrike is a
later migration. PICA / GE kernels should be extracted when two real consumers
establish their required mechanisms, without introducing an empty common API.

## Validation

```sh
cargo test --locked --manifest-path devices/vita/pocket-vita-gxm/Cargo.toml
# With VitaSDK, a nightly Rust toolchain and rust-src:
cargo +nightly-2026-05-28 check --locked \
  --manifest-path engine/pocket3d/crates/pocket3d-vita/Cargo.toml \
  --target armv7-sony-vita-newlibeabihf -Z build-std=std,panic_abort
```

Host tests cover allocation arithmetic. Target compilation checks GXM bindings.
Neither proves GPU execution, shader compilation on the console, or resource
release while switching scenes; those require application device tests.
