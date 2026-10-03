//! PSP GE mechanisms. Scene formats, draw ordering, materials and frame pacing
//! belong to the caller. No operation here starts or waits for a GE list.
#![no_std]
extern crate alloc;
pub mod pool;
pub mod swizzle;
pub use pool::FramePool;

#[cfg(target_os = "psp")]
pub mod cache {
    use core::ffi::c_void;
    /// Publish CPU-written bytes before submitting GE references to them.
    ///
    /// # Safety
    /// The pointer must cover `bytes` readable bytes. The caller owns any GE
    /// synchronization required before rewriting or freeing the allocation.
    pub unsafe fn writeback_range(data: *const c_void, bytes: usize) {
        if bytes != 0 {
            psp::sys::sceKernelDcacheWritebackRange(
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
