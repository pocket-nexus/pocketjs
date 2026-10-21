#![no_std]
#![allow(static_mut_refs)]
//! Single PSP kernel arena. The program selects ArenaAlloc as its allocator.
//! The program must export `extern "C" fn pocket_psp_arena_capacity() -> usize`.
//! It returns the immutable capacity (zero selects available memory), must not
//! allocate, and is called before the first C, QuickJS or Rust allocation.
//! Missing configuration is a link error. This private hook is not the public
//! runtime host ABI. All arena access belongs to one owning thread.
use core::alloc::{GlobalAlloc, Layout};

pub mod arena;
pub mod c_heap;

pub struct ArenaAlloc;

unsafe impl GlobalAlloc for ArenaAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        arena::alloc(layout.size(), layout.align())
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        arena::dealloc(ptr, layout.size(), layout.align())
    }
}
