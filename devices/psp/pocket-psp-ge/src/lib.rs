//! PSP GE mechanisms. Scene formats, draw ordering, materials and frame pacing
//! belong to the caller. No operation here starts or waits for a GE list.
#![no_std]
extern crate alloc;
pub mod pool;
pub mod swizzle;
pub use pool::FramePool;

#[cfg(any(target_os = "psp", test))]
pub mod cache {
    use core::ffi::c_void;
    // The final PSP runtime links the native C entrypoint from its pinned
    // rust-psp/PSPSDK provider. A host cooker needs neither SDK nor its source
    // toolchain submodules merely to use GE layout or frame allocation.
    unsafe extern "C" {
        fn sceKernelDcacheWritebackRange(data: *const c_void, bytes: u32);
    }
    /// Publish CPU-written bytes before submitting GE references to them.
    ///
    /// # Safety
    /// The pointer must cover `bytes` readable bytes. The caller owns any GE
    /// synchronization required before rewriting or freeing the allocation.
    pub unsafe fn writeback_range(data: *const c_void, bytes: usize) {
        if bytes != 0 {
            sceKernelDcacheWritebackRange(
                data,
                u32::try_from(bytes).expect("GE cache range exceeds u32"),
            );
        }
    }
    pub fn writeback(data: &[u8]) {
        unsafe {
            writeback_range(data.as_ptr().cast(), data.len());
        }
    }
}

#[cfg(test)]
mod cache_tests {
    use core::ffi::c_void;
    use core::sync::atomic::{AtomicUsize, Ordering::SeqCst};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    static POINTER: AtomicUsize = AtomicUsize::new(0);
    static LENGTH: AtomicUsize = AtomicUsize::new(0);

    #[unsafe(export_name = "sceKernelDcacheWritebackRange")]
    unsafe extern "C" fn record_writeback(data: *const c_void, bytes: u32) {
        POINTER.store(data as usize, SeqCst);
        LENGTH.store(bytes as usize, SeqCst);
        CALLS.fetch_add(1, SeqCst);
    }

    #[test]
    fn native_cache_abi_receives_exact_range_and_skips_empty_slices() {
        let bytes = [3u8; 65];
        super::cache::writeback(&bytes);
        assert_eq!(POINTER.load(SeqCst), bytes.as_ptr() as usize);
        assert_eq!(LENGTH.load(SeqCst), bytes.len());
        assert_eq!(CALLS.load(SeqCst), 1);
        super::cache::writeback(&[]);
        assert_eq!(CALLS.load(SeqCst), 1);
    }
}
