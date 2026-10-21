//! The no_std archive has one allocator and one panic implementation.
#[cfg(not(feature = "std"))]
use core::alloc::{GlobalAlloc, Layout};
#[cfg(not(feature = "std"))]
use pocket_drivers::abi;
#[cfg(not(feature = "std"))]
struct HostAllocator;
#[cfg(not(feature = "std"))]
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
#[cfg(not(feature = "std"))]
#[global_allocator]
static ALLOCATOR: HostAllocator = HostAllocator;
#[cfg(not(feature = "std"))]
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
#[cfg(not(feature = "std"))]
#[no_mangle]
pub extern "C" fn rust_eh_personality() -> ! {
    let message = b"PocketJS runtime cannot unwind";
    unsafe { abi::pocket_host_panic(message.as_ptr().cast(), message.len()) };
    loop {
        core::hint::spin_loop();
    }
}
