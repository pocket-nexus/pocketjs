# PSP GE device mechanisms

This crate owns GE texture swizzling, retained aligned frame allocations and
CPU cache publication. It has no BSP/Atlas format, material model, camera or
render loop. Host builds expose the layout and allocation code; PSP builds add
cache writeback and uploads. The final PSP executable supplies the native
`sceKernelDcacheWritebackRange(const void *, uint32_t)` C symbol through its
pinned rust-psp/PSPSDK provider; the shared crate declares that ABI without
acquiring an SDK dependency. Host cookers and tests have no SDK or network
inputs. Native application linking verifies the provider contract.

Callers retire every referencing GE list before resetting or dropping a pool.
`reset` is unsafe and never inserts a wait. Shader state, command-list lifetime,
frame pacing and presentation remain with the runtime. The returned pointers
stay valid across pool growth; larger allocations use separate retained blocks.

The PocketJS UI host and OpenStrike GE renderer use the same frame arena.
Atlas and OpenStrike cookers use the same byte swizzle. An extracted mechanism
keeps target-specific constraints visible to both compilers.

```sh
cargo test --locked --manifest-path devices/psp/pocket-psp-ge/Cargo.toml
```
