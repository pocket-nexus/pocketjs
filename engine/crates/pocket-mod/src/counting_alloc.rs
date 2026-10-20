//! QuickJS allocator that counts live allocations.
//!
//! The idle-GC policy needs the engine's `malloc_size` at every frame
//! boundary. quickjs-ng keeps `JSMallocState` private and
//! `JS_ComputeMemoryUsage` walks the heap, so a realm built with
//! [`CountingAllocator`] maintains the same counters itself. Every block
//! carries a header with its usable size — the pattern rquickjs's own
//! `RustAllocator` uses — and the counters move exactly the way the engine
//! moves `malloc_state`: `usable_size + MALLOC_OVERHEAD` per block
//! (quickjs.c: 8 on non-Apple targets, 0 on Apple).
//!
//! Reading the counter is then constant time and uses only the public
//! [`rquickjs::allocator::Allocator`] trait: no QuickJS private layout is
//! read, and the counter equals `JS_ComputeMemoryUsage().malloc_size` by
//! construction (the engine maintains its state from the same
//! `js_malloc_usable_size` calls).

use std::cell::Cell;
use std::rc::Rc;

use rquickjs::allocator::Allocator;

/// Bytes QuickJS adds to every block when maintaining `malloc_size`
/// (quickjs.c: `MALLOC_OVERHEAD`, zero under `__APPLE__`).
const MALLOC_OVERHEAD: usize = if cfg!(target_vendor = "apple") { 0 } else { 8 };

/// Live-allocation counters shared between the allocator and the guest that
/// reads them at frame boundaries.
#[derive(Default)]
pub(crate) struct CountingState {
    pub(crate) malloc_count: Cell<usize>,
    pub(crate) malloc_size: Cell<usize>,
}

/// Header stored before every block: the usable size the engine counts.
#[derive(Clone, Copy)]
#[repr(transparent)]
struct Header {
    size: usize,
}

/// All allocations are aligned to the largest value QuickJS stores (a u64);
/// the header sits in the prefix rquickjs's `RustAllocator` reserves.
const ALLOC_ALIGN: usize = std::mem::align_of::<u64>();
const HEADER_SIZE: usize = if std::mem::size_of::<Header>() > ALLOC_ALIGN {
    std::mem::size_of::<Header>()
} else {
    ALLOC_ALIGN
};

#[inline]
fn round_size(size: usize) -> usize {
    size.div_ceil(ALLOC_ALIGN) * ALLOC_ALIGN
}

/// QuickJS allocator that mirrors the engine's `malloc_state` counters.
pub(crate) struct CountingAllocator {
    state: Rc<CountingState>,
}

impl CountingAllocator {
    pub(crate) fn new(state: Rc<CountingState>) -> Self {
        CountingAllocator { state }
    }

    #[inline]
    fn account_alloc(&self, size: usize) {
        let count = self.state.malloc_count.get();
        let total = self.state.malloc_size.get();
        self.state.malloc_count.set(count + 1);
        self.state.malloc_size.set(total + size + MALLOC_OVERHEAD);
    }

    #[inline]
    fn account_free(&self, size: usize) {
        let count = self.state.malloc_count.get();
        let total = self.state.malloc_size.get();
        self.state.malloc_count.set(count - 1);
        self.state.malloc_size.set(total - size - MALLOC_OVERHEAD);
    }
}

unsafe impl Allocator for CountingAllocator {
    fn alloc(&mut self, size: usize) -> *mut u8 {
        let size = round_size(size);
        let Ok(layout) = std::alloc::Layout::from_size_align(size + HEADER_SIZE, ALLOC_ALIGN)
        else {
            return std::ptr::null_mut();
        };
        let ptr = unsafe { std::alloc::alloc(layout) };
        if ptr.is_null() {
            return ptr;
        }
        unsafe {
            ptr.cast::<Header>().write(Header { size });
        }
        self.account_alloc(size);
        unsafe { ptr.add(HEADER_SIZE) }
    }

    fn calloc(&mut self, count: usize, size: usize) -> *mut u8 {
        if count == 0 || size == 0 {
            return std::ptr::null_mut();
        }
        let Some(total) = count.checked_mul(size) else {
            return std::ptr::null_mut();
        };
        let size = round_size(total);
        let Ok(layout) = std::alloc::Layout::from_size_align(size + HEADER_SIZE, ALLOC_ALIGN)
        else {
            return std::ptr::null_mut();
        };
        let ptr = unsafe { std::alloc::alloc_zeroed(layout) };
        if ptr.is_null() {
            return ptr;
        }
        unsafe {
            ptr.cast::<Header>().write(Header { size });
        }
        self.account_alloc(size);
        unsafe { ptr.add(HEADER_SIZE) }
    }

    unsafe fn dealloc(&mut self, ptr: *mut u8) {
        let base = unsafe { ptr.sub(HEADER_SIZE) };
        let size = unsafe { base.cast::<Header>().read().size };
        self.account_free(size);
        let layout = unsafe {
            std::alloc::Layout::from_size_align_unchecked(size + HEADER_SIZE, ALLOC_ALIGN)
        };
        unsafe { std::alloc::dealloc(base, layout) };
    }

    unsafe fn realloc(&mut self, ptr: *mut u8, new_size: usize) -> *mut u8 {
        let new_size = round_size(new_size);
        let base = unsafe { ptr.sub(HEADER_SIZE) };
        let old_size = unsafe { base.cast::<Header>().read().size };
        let layout = unsafe {
            std::alloc::Layout::from_size_align_unchecked(old_size + HEADER_SIZE, ALLOC_ALIGN)
        };
        let ptr = unsafe { std::alloc::realloc(base, layout, new_size + HEADER_SIZE) };
        if ptr.is_null() {
            return ptr;
        }
        unsafe {
            ptr.cast::<Header>().write(Header { size: new_size });
        }
        let total = self.state.malloc_size.get();
        self.state.malloc_size.set(total - old_size + new_size);
        unsafe { ptr.add(HEADER_SIZE) }
    }

    unsafe fn usable_size(ptr: *mut u8) -> usize
    where
        Self: Sized,
    {
        unsafe { ptr.sub(HEADER_SIZE).cast::<Header>().read().size }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counter_tracks_live_blocks() {
        let state = Rc::new(CountingState::default());
        let mut alloc = CountingAllocator::new(state.clone());
        assert_eq!(state.malloc_size.get(), 0);
        let a = alloc.alloc(100);
        let a_size = round_size(100) + MALLOC_OVERHEAD;
        assert_eq!(state.malloc_size.get(), a_size);
        assert_eq!(state.malloc_count.get(), 1);
        let b = alloc.alloc(3);
        let b_size = round_size(3) + MALLOC_OVERHEAD;
        assert_eq!(state.malloc_size.get(), a_size + b_size);
        assert_eq!(state.malloc_count.get(), 2);
        unsafe { alloc.dealloc(a) };
        assert_eq!(state.malloc_size.get(), b_size);
        assert_eq!(state.malloc_count.get(), 1);
        let b = unsafe { alloc.realloc(b, 5000) };
        assert_eq!(state.malloc_count.get(), 1);
        assert_eq!(state.malloc_size.get(), round_size(5000) + MALLOC_OVERHEAD);
        unsafe { alloc.dealloc(b) };
        assert_eq!(state.malloc_size.get(), 0);
        assert_eq!(state.malloc_count.get(), 0);
    }
}
