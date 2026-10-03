# PSP GE device mechanisms

This crate owns GE texture swizzling, retained aligned frame allocations and
CPU cache publication. It has no BSP/Atlas format, material model, camera or
render loop. Host builds expose the layout and allocation code; PSP builds add
cache writeback and uploads through the pinned rust-psp SDK.

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
