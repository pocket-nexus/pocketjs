//! Global allocator and abort handlers over devkitPPC newlib.

use core::alloc::{GlobalAlloc, Layout};
use core::ffi::c_void;

unsafe extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn memalign(alignment: usize, size: usize) -> *mut c_void;
    fn realloc(ptr: *mut c_void, size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
    fn abort() -> !;
}

struct CAllocator;

unsafe impl GlobalAlloc for CAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if layout.align() <= 8 {
            malloc(layout.size().max(1)).cast()
        } else {
            memalign(layout.align(), layout.size().max(1)).cast()
        }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, _layout: Layout) {
        free(ptr.cast());
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if layout.align() <= 8 {
            return realloc(ptr.cast(), size.max(1)).cast();
        }
        let grown = memalign(layout.align(), size.max(1)).cast::<u8>();
        if !grown.is_null() {
            core::ptr::copy_nonoverlapping(ptr, grown, layout.size().min(size));
            free(ptr.cast());
        }
        grown
    }
}

#[global_allocator]
static ALLOCATOR: CAllocator = CAllocator;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    unsafe { abort() }
}

#[alloc_error_handler]
fn allocation_error(_layout: Layout) -> ! {
    unsafe { abort() }
}
