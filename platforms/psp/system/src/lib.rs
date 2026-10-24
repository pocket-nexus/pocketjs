#![no_std]
use core::ffi::c_void;
use psp::sys::{self, ThreadAttributes};
/// Real PSP hardware can start a PSPLINK-loaded user thread with FPU
/// exceptions enabled. Taffy intentionally uses NaN sentinels for auto/
/// undefined dimensions; with invalid-operation traps enabled, ordinary
/// flexbox math over those sentinels raises FPE and the screen stays black.
/// Clear FCSR so exceptions are masked and NaNs propagate as the layout
/// engine expects. PPSSPP's software renderer path did not expose this.
#[inline]
pub unsafe fn reset_fpu_status() {
    pocket_psp_fpu_reset();
}

/// PSP monotonic microseconds for guest phase measurements.
pub fn now_us() -> u64 {
    unsafe { sys::sceKernelGetSystemTimeWide() as u64 }
}

/// newlib's `struct timeval` on the PSP: a 64-bit `time_t`, a 32-bit
/// `suseconds_t`, 16 bytes with padding.
#[repr(C)]
pub struct Timeval {
    pub sec: i64,
    pub usec: i32,
}

/// Microseconds from 0001-01-01 (the RTC's tick origin) to 1970-01-01.
const RTC_UNIX_EPOCH_US: u64 = 62_135_596_800 * 1_000_000;

/// newlib's `gettimeofday` backend, so `Date.now()` is the RTC's UTC time.
/// pspsdk's libcglue answers through sceKernelLibcGettimeofday, which on a
/// PSP Slim under PSPLINK gives the time of day on 1970-01-01. A program
/// links this before libcglue by naming it from its own object (see
/// programs/psp/src/main.rs).
///
/// # Safety
/// `tv` is null or points at a writable `Timeval`.
#[no_mangle]
pub unsafe extern "C" fn _gettimeofday(tv: *mut Timeval, _tz: *mut c_void) -> i32 {
    let mut tick = 0u64;
    if sys::sceRtcGetCurrentTick(&mut tick) < 0 || tick < RTC_UNIX_EPOCH_US {
        return -1;
    }
    if let Some(tv) = tv.as_mut() {
        let us = tick - RTC_UNIX_EPOCH_US;
        tv.sec = (us / 1_000_000) as i64;
        tv.usec = (us % 1_000_000) as i32;
    }
    0
}
extern "C" {
    fn pocket_psp_fpu_reset();
    fn pocket_psp_fpu_mask() -> u32;
    fn pocket_psp_fpu_restore(saved: u32);
}
/// Preserve a native caller's floating-point status across a runtime turn.
pub struct FpuGuard(u32);
impl FpuGuard {
    /// # Safety
    /// Call on the PSP guest thread, without moving this guard to another thread.
    pub unsafe fn masked() -> Self {
        Self(pocket_psp_fpu_mask())
    }
}
impl Drop for FpuGuard {
    fn drop(&mut self) {
        unsafe { pocket_psp_fpu_restore(self.0) }
    }
}

/// The `psp::module!` main thread has only a 256 KB stack; QuickJS compiling
/// a bundle overflows it. Run `entry` on a 1 MB USER|VFPU worker (the VFPU
/// flag is required for sceGum on hardware) and wait for it. One MiB remains
/// four times the overflowing main stack while returning the other MiB to the
/// shared arena before its one kernel block is reserved. Falls back to calling
/// `fallback` inline if thread creation fails.
pub unsafe fn run_on_worker(
    entry: unsafe extern "C" fn(usize, *mut c_void) -> i32,
    fallback: unsafe fn(),
) {
    let id = sys::sceKernelCreateThread(
        b"pocketjs_main\0".as_ptr(),
        entry,
        32,          // priority
        1024 * 1024, // 1 MB stack
        ThreadAttributes::USER | ThreadAttributes::VFPU,
        core::ptr::null_mut(),
    );
    if id.0 >= 0 {
        sys::sceKernelStartThread(id, 0, core::ptr::null_mut());
        sys::sceKernelWaitThreadEnd(id, core::ptr::null_mut());
    } else {
        fallback();
    }
}
