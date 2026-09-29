//! The ARM9 UI and libnds share newlib's heap. All calls happen on the main thread.
use core::{
    alloc::{GlobalAlloc, Layout},
    ffi::c_void,
    fmt::{self, Write},
};

extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn memalign(alignment: usize, size: usize) -> *mut c_void;
    fn realloc(pointer: *mut c_void, size: usize) -> *mut c_void;
    fn free(pointer: *mut c_void);
    fn pocket_nds_fatal(code: u32, message: *const u8, length: usize) -> !;
}

struct Newlib;
unsafe impl GlobalAlloc for Newlib {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if layout.align() <= 8 {
            malloc(layout.size().max(1)).cast()
        } else {
            memalign(layout.align(), layout.size().max(1)).cast()
        }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, _: Layout) {
        free(pointer.cast());
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if layout.align() <= 8 {
            return realloc(pointer.cast(), size.max(1)).cast();
        }
        let next: *mut u8 = memalign(layout.align(), size.max(1)).cast();
        if !next.is_null() {
            core::ptr::copy_nonoverlapping(pointer, next, layout.size().min(size));
            free(pointer.cast());
        }
        next
    }
}

#[global_allocator]
static ALLOCATOR: Newlib = Newlib;

struct Message {
    bytes: [u8; 192],
    length: usize,
}
impl Write for Message {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        let length = text.len().min(self.bytes.len() - self.length);
        self.bytes[self.length..self.length + length].copy_from_slice(&text.as_bytes()[..length]);
        self.length += length;
        Ok(())
    }
}

#[panic_handler]
fn panic(info: &core::panic::PanicInfo<'_>) -> ! {
    let mut message = Message {
        bytes: [0; 192],
        length: 0,
    };
    let _ = write!(&mut message, "{info}");
    unsafe { pocket_nds_fatal(2, message.bytes.as_ptr(), message.length) }
}

#[alloc_error_handler]
fn out_of_memory(layout: Layout) -> ! {
    let mut message = Message {
        bytes: [0; 192],
        length: 0,
    };
    let _ = write!(&mut message, "allocation failed: {} bytes", layout.size());
    unsafe { pocket_nds_fatal(3, message.bytes.as_ptr(), message.length) }
}

// ARM946E-S has no compare-and-swap instruction. portable-atomic performs
// MicroTS region-id allocation while libnds masks and restores interrupts.
#[cfg(not(target_has_atomic = "32"))]
mod atomics {
    struct Arm9CriticalSection;
    critical_section::set_impl!(Arm9CriticalSection);
    extern "C" {
        fn pocket_nds_critical_enter() -> u32;
        fn pocket_nds_critical_leave(state: u32);
    }
    unsafe impl critical_section::Impl for Arm9CriticalSection {
        unsafe fn acquire() -> critical_section::RawRestoreState {
            pocket_nds_critical_enter()
        }
        unsafe fn release(state: critical_section::RawRestoreState) {
            pocket_nds_critical_leave(state);
        }
    }
}
