# PSP arena allocation and diagnostics

Rust allocations, QuickJS callbacks and C heap allocations share **one PSP
kernel partition block**. The arena uses power-of-two size classes for
allocations that can be freed. Its state belongs to the runtime's allocator
thread; the local offload worker must not access it.

## Permanent backing storage

`pocketjs_psp::arena::alloc_permanent(size, align)` reserves uninitialized
storage from the uncarved tail. It consumes **the requested size plus alignment
padding**, with a minimum alignment of 16 bytes. A request of 18,200,001 bytes
therefore does not consume a 32 MiB size class.

Zero size, a non-power-of-two alignment, arithmetic overflow or insufficient
tail space returns null. Failed requests preserve the bump pointer. Free-list
blocks cannot satisfy a permanent request, even if diagnostics report enough
aggregate free space.

**Permanent storage lasts until process exit.** Allocate one backing buffer and
reuse it. Never pass its pointer to `arena::dealloc`, C `free` or `realloc`,
`Box::from_raw`, or `Vec::from_raw_parts`. The caller must initialize bytes before
reading them and end outstanding borrows before overwriting the buffer.

## Diagnostic counters

`pocketjs_psp::qjs_alloc::stats()` reads process-lifetime counters without
allocating. `alloc_calls` includes malloc and realloc calls, including failed
and zero-size requests, and saturates at `usize::MAX`. `live_requested` and
`peak_requested` count QuickJS request bytes. **These values exclude allocation
headers, size-class rounding and Rust/C allocations outside the QuickJS
callbacks.** Runtime creation does not reset the counters. `last_failed_request`
records the latest failed nonzero request; zero means none has been recorded.

`arena::debug_free()` returns `(total_free_bytes, largest_free_block_bytes)`.
It includes the uncarved tail and all reusable free-list blocks. The largest
block describes raw storage; it does not promise that a request of that size
can meet its alignment and size-class requirements. The function allocates no
memory, but **visits every free-list node**. Sample it on demand or at a bounded
diagnostic interval rather than on every rendered frame.

Both diagnostic APIs require the allocator's owning thread and exclude
concurrent allocator access.

## Automated verification

```sh
bun test tests/psp-arena.test.ts tests/psp-qjs-allocator.test.ts
```

The harness compiles the production Rust files with host substitutes for PSP
partition calls and the QuickJS callback-registration boundary. It runs debug
and optimized binaries, with each case in a fresh process. It covers permanent
allocation, invalid requests, OOM, alignment, recycling, free-list splitting,
reallocation failure, data preservation and diagnostic accounting. The
`PSP allocator contracts` workflow runs these cases on Linux and macOS.

These tests do not execute the PSP kernel, MIPS code or the QuickJS interpreter.

## Device acceptance

Build the normal Hero host and the allocator example with the pinned PSP
SDK/toolchain:

```sh
bun tools/psp.ts hero --release --example allocator-check
```

The example source is `programs/psp/examples/allocator-check.rs`. The build produces
an example PRX and EBOOT alongside the normal host outputs under
`programs/psp/target/mipsel-sony-psp/release/`. Use the example artifact for allocator
acceptance; use the normal Hero artifact for a UI smoke check. Neither requires
maps, ROMs or other product assets.

Launch the example from XMB or PSPLINK. It reserves one 18,200,001-byte buffer,
writes and reads its contents, checks ordinary allocation/recycling beside it,
and executes an allocation workload through a real QuickJS runtime. Context
and runtime teardown must return `live_requested` to its starting value.

The screen must reach **`READY - CROSS reruns; HOME exits`** with no `FAIL` line.
Press CROSS several times; each run reuses the permanent buffer, checks its edge
bytes, and creates and destroys a QuickJS runtime. The pass counter must advance
and free space must stabilize after warmup. HOME exits. An allocation failure
on a device with insufficient available partition space is a failed acceptance
run; record the device model, launch mode and displayed arena capacity.

A passing allocator example does not establish acceptance of downstream games
or the framework's graphics pipeline. Record the exact PR heads, artifact hash,
device model and observed result in the PR before merging.
