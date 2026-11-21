#![allow(dead_code, non_snake_case)]
extern crate self as psp;
#[path = "../../../platforms/psp/alloc/src/arena.rs"]
mod arena;
mod sys;

// Each test runs in a fresh process: the production arena has process lifetime.
#[test]
fn exact_large_request() {
    unsafe {
        let size = 18_200_001;
        assert!(arena::alloc(size, 16).is_null()); // rounds to 32 MiB
        assert_eq!(arena::stats().bump_bytes, 0);
        let p = arena::alloc_permanent(size, 16);
        assert!(!p.is_null());
        assert_eq!(arena::stats().bump_bytes, size);
        assert_eq!(arena::stats().tail_free_bytes, sys::CAPACITY - size);
        p.write_bytes(0x5a, size);
        assert!(core::slice::from_raw_parts(p, size)
            .iter()
            .all(|v| *v == 0x5a));
        assert_eq!(
            sys::ALLOCATIONS.load(core::sync::atomic::Ordering::Relaxed),
            1
        );
    }
}

#[test]
fn failed_requests_preserve_tail() {
    unsafe {
        let before = arena::stats().bump_bytes;
        for (size, align) in [
            (0, 16),
            (1, 0),
            (1, 3),
            (usize::MAX, 16),
            (sys::CAPACITY + 1, 16),
            (32, 1usize << (usize::BITS - 1)),
        ] {
            assert!(arena::alloc_permanent(size, align).is_null());
            assert_eq!(arena::stats().bump_bytes, before);
        }
        assert!(!arena::alloc_permanent(16, 16).is_null());
    }
}

#[test]
fn alignment_and_recycling_do_not_overlap() {
    unsafe {
        let old = arena::alloc(31, 16);
        assert!(!old.is_null());
        arena::dealloc(old, 31, 16);
        let permanent = arena::alloc_permanent(17, 64);
        assert!(!permanent.is_null());
        permanent.write_bytes(7, 17);
        let recycled = arena::alloc(31, 16);
        assert_eq!(old, recycled);
        recycled.write_bytes(9, 31);
        let mut previous_end = permanent as usize + 17;
        for align in [1, 2, 4, 8, 16, 32, 64, 128, 4096] {
            let p = arena::alloc_permanent(3, align);
            assert!(!p.is_null());
            assert_eq!(p as usize % align, 0);
            assert!(p as usize >= previous_end);
            p.write_bytes(3, 3);
            previous_end = p as usize + 3;
        }
        let next = arena::alloc(80, 16);
        assert!(!next.is_null());
        assert_eq!(next as usize % 16, 0);
        next.write_bytes(4, 80);
        assert!(core::slice::from_raw_parts(permanent, 17)
            .iter()
            .all(|v| *v == 7));
        assert!(core::slice::from_raw_parts(recycled, 31)
            .iter()
            .all(|v| *v == 9));
    }
}

#[test]
fn exact_fit_then_exhaustion() {
    unsafe {
        let p = arena::alloc_permanent(sys::CAPACITY, 16);
        assert!(!p.is_null());
        assert_eq!(arena::stats().tail_free_bytes, 0);
        assert!(arena::alloc_permanent(1, 16).is_null());
        assert!(arena::alloc(16, 16).is_null());
        assert_eq!(arena::stats().bump_bytes, sys::CAPACITY);
    }
}

#[test]
fn free_list_is_not_permanent_tail() {
    unsafe {
        let recycled = arena::alloc(128, 16);
        assert!(!recycled.is_null());
        arena::dealloc(recycled, 128, 16);
        assert!(!arena::alloc_permanent(sys::CAPACITY - 128, 16).is_null());
        assert!(arena::alloc_permanent(32, 16).is_null());
        assert_eq!(arena::alloc(128, 16), recycled);
    }
}

#[test]
fn kernel_reservation_failure() {
    unsafe {
        std::env::set_var("POCKET_TEST_ARENA_INIT_FAIL", "1");
        assert!(arena::alloc_permanent(1, 16).is_null());
        assert_eq!(arena::stats().capacity_bytes, 0);
        assert_eq!(arena::stats().bump_bytes, 0);
        assert_eq!(
            sys::ALLOCATIONS.load(core::sync::atomic::Ordering::Relaxed),
            1
        );
    }
}

#[no_mangle]
pub extern "C" fn pocket_psp_arena_capacity() -> usize { option_env!("POCKETJS_ARENA_BYTES").unwrap_or("0").parse().unwrap() }
