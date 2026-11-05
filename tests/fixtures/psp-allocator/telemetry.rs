#![allow(dead_code, non_snake_case, non_camel_case_types)]
extern crate self as libquickjs_sys;
extern crate self as psp;
extern crate self as pocket_psp_alloc;
#[path = "../../../platforms/psp/alloc/src/arena.rs"]
mod arena;
#[path = "../../../platforms/psp/quickjs-alloc/src/lib.rs"]
mod qjs_alloc;
mod sys;
use core::ffi::c_void;
use core::ptr;

// Capture the callbacks registered by production new_runtime(). This harness
// checks allocator bookkeeping, not QuickJS execution or PSP kernel behavior.
pub type size_t = usize;
pub enum JSMallocState {}
pub enum JSRuntime {}
#[derive(Clone, Copy)]
pub struct JSMallocFunctions {
    pub js_malloc: Option<unsafe extern "C" fn(*mut JSMallocState, size_t) -> *mut c_void>,
    pub js_free: Option<unsafe extern "C" fn(*mut JSMallocState, *mut c_void)>,
    pub js_realloc:
        Option<unsafe extern "C" fn(*mut JSMallocState, *mut c_void, size_t) -> *mut c_void>,
    pub js_malloc_usable_size: Option<unsafe extern "C" fn(*const c_void) -> size_t>,
}
static mut CALLBACKS: Option<JSMallocFunctions> = None;
pub unsafe fn JS_NewRuntime2(mf: &JSMallocFunctions, _: *mut c_void) -> *mut JSRuntime {
    CALLBACKS = Some(*mf);
    ptr::null_mut()
}
unsafe fn callbacks() -> JSMallocFunctions {
    qjs_alloc::new_runtime();
    CALLBACKS.unwrap()
}

#[test]
fn live_bytes_follow_realloc_and_free() {
    unsafe {
        let f = callbacks();
        let p = f.js_malloc.unwrap()(ptr::null_mut(), 17);
        assert!(!p.is_null());
        (p as *mut u8).write_bytes(0x5a, 17);
        assert_eq!(qjs_alloc::stats().live_requested, 17);
        let p2 = f.js_realloc.unwrap()(ptr::null_mut(), p, 31);
        assert_eq!(p, p2); // header + request stay in the 64-byte class
        assert_eq!(f.js_malloc_usable_size.unwrap()(p2), 31);
        assert_eq!(qjs_alloc::stats().live_requested, 31);
        let p3 = f.js_realloc.unwrap()(ptr::null_mut(), p2, 100);
        assert!(!p3.is_null());
        assert_ne!(p2, p3);
        assert!(core::slice::from_raw_parts(p3 as *const u8, 17)
            .iter()
            .all(|v| *v == 0x5a));
        assert_eq!(qjs_alloc::stats().live_requested, 100);
        assert_eq!(qjs_alloc::stats().peak_requested, 100);
        let p4 = f.js_realloc.unwrap()(ptr::null_mut(), p3, 1);
        assert!(!p4.is_null());
        assert_eq!(*(p4 as *const u8), 0x5a);
        assert_eq!(qjs_alloc::stats().live_requested, 1);
        assert!(f.js_realloc.unwrap()(ptr::null_mut(), p4, 0).is_null());
        let s = qjs_alloc::stats();
        assert_eq!(s.live_requested, 0);
        assert_eq!(s.peak_requested, 100);
        assert_eq!(s.alloc_calls, 5);
        assert_eq!(s.largest_request, 100);
        assert_eq!(s.last_failed_request, 0);
    }
}

#[test]
fn failed_realloc_keeps_live_bytes_and_old_data() {
    unsafe {
        let f = callbacks();
        let p = f.js_malloc.unwrap()(ptr::null_mut(), 100);
        assert!(!p.is_null());
        (p as *mut u8).write(55);
        assert!(f.js_realloc.unwrap()(ptr::null_mut(), p, sys::CAPACITY).is_null());
        let s = qjs_alloc::stats();
        assert_eq!(s.live_requested, 100);
        assert_eq!(s.peak_requested, 100);
        assert_eq!(s.last_failed_request, sys::CAPACITY);
        assert_eq!(s.largest_request, sys::CAPACITY);
        assert_eq!(*(p as *const u8), 55);
        f.js_free.unwrap()(ptr::null_mut(), p);
        assert_eq!(qjs_alloc::stats().live_requested, 0);
    }
}

#[test]
fn zero_size_does_not_erase_failure_history() {
    unsafe {
        let f = callbacks();
        assert!(f.js_malloc.unwrap()(ptr::null_mut(), sys::CAPACITY).is_null());
        assert_eq!(qjs_alloc::stats().last_failed_request, sys::CAPACITY);
        assert!(f.js_malloc.unwrap()(ptr::null_mut(), 0).is_null());
        assert!(f.js_realloc.unwrap()(ptr::null_mut(), ptr::null_mut(), 0).is_null());
        f.js_free.unwrap()(ptr::null_mut(), ptr::null_mut());
        assert_eq!(f.js_malloc_usable_size.unwrap()(ptr::null()), 0);
        let p = f.js_realloc.unwrap()(ptr::null_mut(), ptr::null_mut(), 20);
        assert!(!p.is_null());
        assert_eq!(qjs_alloc::stats().live_requested, 20);
        f.js_free.unwrap()(ptr::null_mut(), p);
        assert_eq!(qjs_alloc::stats().live_requested, 0);
        assert_eq!(qjs_alloc::stats().last_failed_request, sys::CAPACITY);
        assert_eq!(qjs_alloc::stats().alloc_calls, 4);
    }
}

#[test]
fn diagnostics_count_tail_free_lists_and_splits() {
    unsafe {
        assert_eq!(arena::debug_free(), (sys::CAPACITY, sys::CAPACITY));
        let a = arena::alloc(1, 16);
        let b = arena::alloc(100, 16);
        assert!(!a.is_null());
        assert!(!b.is_null());
        assert_eq!(
            arena::debug_free(),
            (sys::CAPACITY - 144, sys::CAPACITY - 144)
        );
        arena::dealloc(a, 1, 16);
        arena::dealloc(b, 100, 16);
        assert_eq!(arena::debug_free(), (sys::CAPACITY, sys::CAPACITY - 144));
        assert!(!arena::alloc_permanent(sys::CAPACITY - 144, 16).is_null());
        assert_eq!(arena::debug_free(), (144, 128));
        let c = arena::alloc(60, 16);
        assert!(!c.is_null());
        assert_eq!(arena::debug_free(), (80, 64));
        arena::dealloc(c, 60, 16);
        assert_eq!(arena::debug_free(), (144, 64));
        let before = arena::stats().bump_bytes;
        for _ in 0..100 {
            assert_eq!(arena::debug_free(), (144, 64));
        }
        assert_eq!(arena::stats().bump_bytes, before);
        assert_eq!(
            sys::ALLOCATIONS.load(core::sync::atomic::Ordering::Relaxed),
            1
        );
    }
}

#[test]
fn requested_bytes_exclude_other_allocators_and_rounding() {
    unsafe {
        let f = callbacks();
        let before = arena::stats().bump_bytes;
        let p = f.js_malloc.unwrap()(ptr::null_mut(), 17);
        assert!(!p.is_null());
        assert_eq!(arena::stats().bump_bytes - before, 64);
        assert_eq!(qjs_alloc::stats().live_requested, 17);
        let other = arena::alloc(100, 16);
        assert!(!other.is_null());
        assert_eq!(qjs_alloc::stats().live_requested, 17);
        callbacks(); // another runtime registration must not reset live counters
        assert_eq!(qjs_alloc::stats().live_requested, 17);
        f.js_free.unwrap()(ptr::null_mut(), p);
        arena::dealloc(other, 100, 16);
        assert_eq!(qjs_alloc::stats().live_requested, 0);
    }
}

#[no_mangle]
pub extern "C" fn pocket_psp_arena_capacity() -> usize { PROGRAM_BUDGET.load(core::sync::atomic::Ordering::Relaxed) }
static PROGRAM_BUDGET: core::sync::atomic::AtomicUsize = core::sync::atomic::AtomicUsize::new(0);
#[test]
fn program_budget_precedes_non_rust_heap_users() {
    use core::sync::atomic::Ordering;
    PROGRAM_BUDGET.store(4096, Ordering::Relaxed);
    unsafe {
        // Initialize through the platform entry point before the QuickJS
        // allocator is registered or the program GlobalAlloc is called.
        let first = arena::alloc(32,16);
        assert!(!first.is_null());
        let stats = arena::stats();
        assert_eq!(stats.capacity_bytes,4096);
        assert_eq!(stats.configured_bytes,4096);
        let cb=callbacks();
        let second=cb.js_malloc.unwrap()(core::ptr::null_mut(),48);
        assert!(!second.is_null());
        assert_eq!(sys::ALLOCATIONS.load(Ordering::Relaxed),1);
        cb.js_free.unwrap()(core::ptr::null_mut(),second);
        arena::dealloc(first,32,16);
    }
}
