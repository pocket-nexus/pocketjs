# PSP GE device mechanisms

This crate owns GE texture swizzling, retained aligned frame allocations,
display-list storage and CPU cache publication. It has no BSP/Atlas format, material model, camera or
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

**A display list has data-cache lines of its own.** `sceGuStart` writes a
list through the uncached mirror of its address (`| 0x4000_0000`), and the GE
reads the commands from RAM. `DisplayList<WORDS>` is aligned to **64 bytes**,
the line of the PSP's data cache, and sized in whole lines, so no other object
is in a line with it. A list buffer aligned to 16 bytes can start inside a
line that also holds a static the CPU writes through the cache. That write
loads the line with the list's first bytes as RAM held them, and the line's
write-back replaces the commands written since. On a PSP this replaced **the
first 12 commands of the first list**, among them `sceGuDrawBuffer`'s
framebuffer format: the GE kept the 5650 format of its reset list and drew
16-bit pixels into the 32-bit display. The write-back fell before the GE's
read for some cache sets, so one build showed it and the next did not.
PPSSPP has no data cache and draws such a build right.

The PocketJS UI host and OpenStrike GE renderer use the same frame arena.
Atlas and OpenStrike cookers use the same byte swizzle. An extracted mechanism
keeps target-specific constraints visible to both compilers.

```sh
cargo test --locked --manifest-path devices/psp/pocket-psp-ge/Cargo.toml
```
