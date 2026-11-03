//! The no_std archive has one allocator and one panic implementation.
#[cfg(all(not(feature = "std"), not(feature = "external-runtime")))]
use core::alloc::{GlobalAlloc, Layout};
#[cfg(all(not(feature = "std"), not(feature = "external-runtime")))]
use pocket_drivers::abi;
#[cfg(all(not(feature = "std"), not(feature = "external-runtime")))]
struct HostAllocator;
#[cfg(all(not(feature = "std"), not(feature = "external-runtime")))]
unsafe impl GlobalAlloc for HostAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        unsafe { abi::pocket_host_alloc(layout.size().max(1), layout.align()).cast() }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { abi::pocket_host_free(pointer.cast(), layout.size().max(1), layout.align()) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        unsafe {
            abi::pocket_host_realloc(
                pointer.cast(),
                layout.size().max(1),
                layout.align(),
                new_size.max(1),
            )
            .cast()
        }
    }
}
#[cfg(all(not(feature = "std"), not(feature = "external-runtime")))]
#[global_allocator]
static ALLOCATOR: HostAllocator = HostAllocator;
#[cfg(all(not(feature = "std"), not(feature = "external-runtime")))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    let message = b"PocketJS runtime panic";
    unsafe {
        abi::pocket_host_panic(message.as_ptr().cast(), message.len());
    }
    loop {
        core::hint::spin_loop();
    }
}

// Some rustup core/alloc archives retain references to this compiler support
// symbol even when the application uses panic=abort. Supply it in the archive
// so a C consumer still implements only the six documented host hooks. This
// runtime never unwinds; reaching a personality routine is a fatal error.
#[cfg(all(not(feature = "std"), not(feature = "external-runtime")))]
#[no_mangle]
pub extern "C" fn rust_eh_personality() -> ! {
    let message = b"PocketJS runtime cannot unwind";
    unsafe { abi::pocket_host_panic(message.as_ptr().cast(), message.len()) };
    loop {
        core::hint::spin_loop();
    }
}

/// Standard-library programs share one implementation of the host C symbols.
#[cfg(feature = "std")]
mod standard {
    use core::ffi::{c_char, c_void};
    use std::alloc::{alloc, dealloc, realloc, Layout};
    use std::io::Write;

    #[no_mangle]
    pub unsafe extern "C" fn pocket_host_alloc(size: usize, align: usize) -> *mut c_void {
        let Ok(layout) = Layout::from_size_align(size.max(1), align) else {
            return core::ptr::null_mut();
        };
        unsafe { alloc(layout).cast() }
    }

    #[no_mangle]
    pub unsafe extern "C" fn pocket_host_realloc(
        pointer: *mut c_void,
        old_size: usize,
        align: usize,
        new_size: usize,
    ) -> *mut c_void {
        if pointer.is_null() {
            return unsafe { pocket_host_alloc(new_size, align) };
        }
        let Ok(layout) = Layout::from_size_align(old_size.max(1), align) else {
            return core::ptr::null_mut();
        };
        // A null result leaves the caller's original allocation live.
        unsafe { realloc(pointer.cast(), layout, new_size.max(1)).cast() }
    }

    #[no_mangle]
    pub unsafe extern "C" fn pocket_host_free(pointer: *mut c_void, size: usize, align: usize) {
        if pointer.is_null() {
            return;
        }
        if let Ok(layout) = Layout::from_size_align(size.max(1), align) {
            unsafe { dealloc(pointer.cast(), layout) };
        }
    }

    #[no_mangle]
    pub unsafe extern "C" fn pocket_host_log(_level: i32, message: *const c_char, length: usize) {
        if message.is_null() || length == 0 {
            return;
        }
        let bytes = unsafe { core::slice::from_raw_parts(message.cast::<u8>(), length) };
        let mut output = std::io::stderr().lock();
        let _ = output.write_all(bytes);
        let _ = output.write_all(b"\n");
    }

    #[no_mangle]
    pub unsafe extern "C" fn pocket_host_panic(message: *const c_char, length: usize) {
        unsafe { pocket_host_log(0, message, length) };
        std::process::abort();
    }

    #[no_mangle]
    pub extern "C" fn pocket_host_boot_stage(_stage: i32) {}

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn c_allocator_retains_alignment_and_payload_across_resize() {
            unsafe {
                let pointer = pocket_host_alloc(32, 256).cast::<u8>();
                assert!(!pointer.is_null());
                assert_eq!(pointer as usize % 256, 0);
                core::slice::from_raw_parts_mut(pointer, 32).fill(0xa5);
                let enlarged = pocket_host_realloc(pointer.cast(), 32, 256, 512).cast::<u8>();
                assert!(!enlarged.is_null());
                assert_eq!(enlarged as usize % 256, 0);
                assert!(core::slice::from_raw_parts(enlarged, 32)
                    .iter()
                    .all(|b| *b == 0xa5));
                pocket_host_free(enlarged.cast(), 512, 256);
                assert!(pocket_host_alloc(8, 3).is_null());
                pocket_host_free(core::ptr::null_mut(), 0, 1);
            }
        }
    }
}
