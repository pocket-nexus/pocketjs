#![no_std]
//! Back QuickJS's allocator with the single-arena sub-allocator (`arena.rs`).
//!
//! rust-psp's startup does not set up a C heap, so newlib `malloc` (used by the
//! bundled QuickJS) has no backing memory and hangs/corrupts during
//! `JS_NewRuntime`. We instead create the runtime via `JS_NewRuntime2` with these
//! hooks. They route every allocation through `arena`, which sub-allocates from
//! ONE big kernel block — crucial because the PSP kernel caps the number of
//! objects and one-kernel-block-per-allocation exhausts it on large bundles.

use core::ffi::c_void;
use core::ptr;

use libquickjs_sys::*;

use pocket_psp_alloc::arena;

// A 16-byte header keeps user pointers 16-byte aligned and stores the request
// size so `free`/`realloc`/`usable_size` can recover it.
const HEADER: usize = 16;

static mut ALLOC_CALLS: usize = 0;
static mut LIVE_REQUESTED: usize = 0;
static mut PEAK_REQUESTED: usize = 0;
static mut LARGEST_REQUEST: usize = 0;
static mut LAST_FAILED_REQUEST: usize = 0;

#[derive(Clone, Copy)]
/// Process-lifetime QuickJS allocation requests, excluding headers, arena
/// size-class rounding, and Rust/C allocations outside these callbacks.
pub struct Stats {
    /// malloc and realloc calls, including zero-size and failed requests.
    /// Saturates at usize::MAX instead of wrapping on a long-running device.
    pub alloc_calls: usize,
    pub live_requested: usize,
    pub peak_requested: usize,
    pub largest_request: usize,
    /// Most recent nonzero request that failed; zero means none recorded.
    pub last_failed_request: usize,
}

/// Read counters without allocating. Creating a new runtime does not reset them.
///
/// # Safety
/// Call on the arena's owning thread, without concurrent allocator access.
pub unsafe fn stats() -> Stats {
    Stats {
        alloc_calls: ALLOC_CALLS,
        live_requested: LIVE_REQUESTED,
        peak_requested: PEAK_REQUESTED,
        largest_request: LARGEST_REQUEST,
        last_failed_request: LAST_FAILED_REQUEST,
    }
}

#[inline]
unsafe fn raw_size(ptr: *const c_void) -> usize {
    *((ptr as *const u8).sub(HEADER) as *const usize)
}

#[inline]
unsafe fn note_request(size: usize) {
    ALLOC_CALLS = ALLOC_CALLS.saturating_add(1);
    LARGEST_REQUEST = LARGEST_REQUEST.max(size);
}

#[inline]
unsafe fn note_live(old: usize, new: usize) {
    LIVE_REQUESTED = LIVE_REQUESTED.saturating_sub(old).saturating_add(new);
    PEAK_REQUESTED = PEAK_REQUESTED.max(LIVE_REQUESTED);
}

#[inline]
unsafe fn raw_alloc(size: usize) -> *mut c_void {
    if size == 0 {
        return ptr::null_mut();
    }
    let p = arena::alloc(size + HEADER, 16);
    if p.is_null() {
        return ptr::null_mut();
    }
    *(p as *mut usize) = size;
    p.add(HEADER) as *mut c_void
}

#[inline]
unsafe fn raw_free(ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    let base = (ptr as *mut u8).sub(HEADER);
    let size = *(base as *mut usize);
    arena::dealloc(base, size + HEADER, 16);
}

#[inline]
unsafe fn raw_realloc(p: *mut c_void, size: usize) -> *mut c_void {
    if p.is_null() {
        return raw_alloc(size);
    }
    if size == 0 {
        raw_free(p);
        return ptr::null_mut();
    }
    let base = (p as *mut u8).sub(HEADER);
    let old = *(base as *mut usize);
    // In-place when the block already spans the new size: the arena rounds
    // every request up to its power-of-two class, so a grow that stays inside
    // the class owns those bytes already. QuickJS grows its string and array
    // builders geometrically, so this skips both the copy and the churn that
    // would strand the old block in a class nothing asks for again.
    if arena::same_class(old + HEADER, size + HEADER, 16) {
        *(base as *mut usize) = size;
        return p;
    }
    let np = raw_alloc(size);
    if np.is_null() {
        return ptr::null_mut();
    }
    let copy = if old < size { old } else { size };
    ptr::copy_nonoverlapping(base.add(HEADER), np as *mut u8, copy);
    arena::dealloc(base, old + HEADER, 16);
    np
}

unsafe extern "C" fn qjs_malloc(_s: *mut JSMallocState, size: size_t) -> *mut c_void {
    let size = size as usize;
    note_request(size);
    let ptr = raw_alloc(size);
    if ptr.is_null() {
        if size != 0 {
            LAST_FAILED_REQUEST = size;
        }
    } else {
        note_live(0, size);
    }
    ptr
}

unsafe extern "C" fn qjs_free(_s: *mut JSMallocState, ptr: *mut c_void) {
    if !ptr.is_null() {
        note_live(raw_size(ptr), 0);
    }
    raw_free(ptr)
}

unsafe extern "C" fn qjs_realloc(
    _s: *mut JSMallocState,
    ptr: *mut c_void,
    size: size_t,
) -> *mut c_void {
    let size = size as usize;
    let old = if ptr.is_null() { 0 } else { raw_size(ptr) };
    note_request(size);
    let next = raw_realloc(ptr, size);
    if size != 0 && next.is_null() {
        LAST_FAILED_REQUEST = size;
    } else {
        note_live(old, size);
    }
    next
}

unsafe extern "C" fn qjs_usable_size(ptr: *const c_void) -> size_t {
    if ptr.is_null() {
        return 0;
    }
    raw_size(ptr) as size_t
}

/// Create a QuickJS runtime that allocates through the Rust/PSP allocator.
pub unsafe fn new_runtime() -> *mut JSRuntime {
    let mf = JSMallocFunctions {
        js_malloc: Some(qjs_malloc),
        js_free: Some(qjs_free),
        js_realloc: Some(qjs_realloc),
        js_malloc_usable_size: Some(qjs_usable_size),
    };
    // JS_NewRuntime2 copies `mf` into the runtime, so a stack value is fine.
    JS_NewRuntime2(&mf, ptr::null_mut())
}
