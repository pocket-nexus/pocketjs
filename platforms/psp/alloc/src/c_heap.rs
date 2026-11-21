// COPIED VERBATIM from dreamcart runtime/src/c_heap.rs (proven on hardware).
// See Cargo.toml TODO list before changing anything here.

//! C heap (`malloc`/`free`/`calloc`/`realloc`, plus newlib's reentrant `*_r`
//! variants) backed by the Rust/PSP global allocator.
//!
//! rust-psp's startup sets up no C heap, so newlib's `malloc` family has no
//! backing memory. QuickJS itself sidesteps this (it allocates through
//! `qjs_alloc`), but newlib's `strtod`/`__dtoa` — reached whenever a float is
//! parsed at high precision or formatted to a string (`js_atof`/`js_dtoa` in
//! quickjs.c) — call `malloc` internally. With no heap those calls fail and
//! newlib `abort()`s, which is why ANY high-precision float literal or float
//! `toString` crashed on PSP. Providing a working heap here fixes it.
//!
//! A 16-byte header keeps user pointers 16-byte aligned and records the request
//! size so `free`/`realloc` can recover the layout (mirrors `qjs_alloc`).
//!
//! Backed by the single-arena sub-allocator (`arena.rs`), NOT the per-allocation
//! kernel-block global allocator — newlib's dtoa/strtod can make many small
//! allocations and would otherwise contribute to kernel-object exhaustion.

use core::ffi::c_void;
use core::ptr;

use crate::arena;

const HEADER: usize = 16;

#[inline]
unsafe fn heap_alloc(size: usize) -> *mut c_void {
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
unsafe fn heap_free(ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    let base = (ptr as *mut u8).sub(HEADER);
    let size = *(base as *mut usize);
    arena::dealloc(base, size + HEADER, 16);
}

#[inline]
unsafe fn heap_realloc(ptr: *mut c_void, size: usize) -> *mut c_void {
    if ptr.is_null() {
        return heap_alloc(size);
    }
    if size == 0 {
        heap_free(ptr);
        return ptr::null_mut();
    }
    let base = (ptr as *mut u8).sub(HEADER);
    let old = *(base as *mut usize);
    // No in-place grow in the free-list heap: allocate, copy, free.
    let np = heap_alloc(size);
    if np.is_null() {
        return ptr::null_mut();
    }
    let copy = if old < size { old } else { size };
    ptr::copy_nonoverlapping(base.add(HEADER), np as *mut u8, copy);
    arena::dealloc(base, old + HEADER, 16);
    np
}

#[inline]
unsafe fn heap_calloc(nmemb: usize, size: usize) -> *mut c_void {
    let total = nmemb.wrapping_mul(size);
    let p = heap_alloc(total);
    if !p.is_null() {
        ptr::write_bytes(p as *mut u8, 0, total);
    }
    p
}

#[no_mangle]
unsafe extern "C" fn malloc(size: usize) -> *mut c_void {
    heap_alloc(size)
}
#[no_mangle]
unsafe extern "C" fn free(ptr: *mut c_void) {
    heap_free(ptr)
}
#[no_mangle]
unsafe extern "C" fn realloc(ptr: *mut c_void, size: usize) -> *mut c_void {
    heap_realloc(ptr, size)
}
#[no_mangle]
unsafe extern "C" fn calloc(nmemb: usize, size: usize) -> *mut c_void {
    heap_calloc(nmemb, size)
}

// newlib's reentrant variants (its internal dtoa/strtod use these). The leading
// `_reent *` argument is ignored.
#[no_mangle]
unsafe extern "C" fn _malloc_r(_r: *mut c_void, size: usize) -> *mut c_void {
    heap_alloc(size)
}
#[no_mangle]
unsafe extern "C" fn _free_r(_r: *mut c_void, ptr: *mut c_void) {
    heap_free(ptr)
}
#[no_mangle]
unsafe extern "C" fn _realloc_r(_r: *mut c_void, ptr: *mut c_void, size: usize) -> *mut c_void {
    heap_realloc(ptr, size)
}
#[no_mangle]
unsafe extern "C" fn _calloc_r(_r: *mut c_void, nmemb: usize, size: usize) -> *mut c_void {
    heap_calloc(nmemb, size)
}
