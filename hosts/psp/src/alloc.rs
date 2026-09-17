//! The crate-wide `#[global_allocator]`, backed by the single-kernel-block
//! arena (`arena.rs`) — docs/DESIGN.md "Memory (the blocker fix)" [R].
//!
//! rust-psp's default `SystemAlloc` makes ONE KERNEL OBJECT per allocation;
//! the PSP kernel caps objects at ~4096, so pocketjs-core's Rust allocations
//! (taffy slotmaps, children Vecs, per-pass collects, the DrawList) would
//! exhaust the slots on any real UI. The `psp` dependency is built with
//! feature `external-global-alloc`, which gates out both its
//! `#[global_allocator]` and its `#[alloc_error_handler]`; this module
//! provides the replacements. Rust, QuickJS (qjs_alloc.rs) and newlib C
//! (c_heap.rs) use the UI arena. Before the local provider starts, it reserves
//! one block for a private worker heap. Thread routing keeps worker allocations
//! and frees out of the UI free lists, including FreeType's C allocations.
//!
//! The allocator can be hit before any explicit init runs — `arena::alloc`
//! lazily `ensure_init`s itself (via direct sceKernel* syscalls, never
//! through this allocator, so no recursion).
//!
//! Loaded as `#[path = "alloc.rs"] mod allocator;` from main.rs: a crate-root
//! module literally named `alloc` would collide with `extern crate alloc`.

use core::alloc::{GlobalAlloc, Layout};

use crate::arena;

struct ArenaAlloc;

pub(crate) unsafe fn allocate(size: usize, align: usize) -> *mut u8 {
    if crate::worker_heap::is_worker() {
        crate::worker_heap::allocate(size, align)
    } else {
        arena::alloc(size, align)
    }
}
pub(crate) unsafe fn deallocate(pointer: *mut u8, size: usize, align: usize) {
    if crate::worker_heap::owns(pointer) {
        crate::worker_heap::free(pointer, size)
    } else {
        arena::dealloc(pointer, size, align)
    }
}

unsafe impl GlobalAlloc for ArenaAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        allocate(layout.size(), layout.align())
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        deallocate(ptr, layout.size(), layout.align())
    }
}

#[global_allocator]
static GLOBAL: ArenaAlloc = ArenaAlloc;

#[alloc_error_handler]
fn alloc_error(layout: Layout) -> ! {
    if crate::worker_heap::is_worker() {
        crate::offload_local::allocation_failed();
    }
    psp::dprintln!("[PocketJS oom] alloc of {} bytes failed", layout.size());
    loop {
        unsafe { psp::sys::sceDisplayWaitVblankStart() };
    }
}
