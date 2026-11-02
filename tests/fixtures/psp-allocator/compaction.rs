#![allow(dead_code, non_snake_case)]
extern crate self as psp;
#[path = "../../../platforms/psp/alloc/src/arena.rs"]
mod arena;
mod sys;

const K: usize = 1024;

/// Spend the whole tail, so the next request can only come from free blocks. Returns nothing to keep:
/// these blocks stay allocated for the rest of the process.
unsafe fn exhaust_tail() {
    for shift in (4..=23).rev() {
        while arena::stats().tail_free_bytes >= 1usize << shift && !arena::alloc(1usize << shift, 16).is_null() {}
    }
    assert!(arena::stats().tail_free_bytes < 32);
}

// Each test runs in a fresh process: the production arena has process lifetime.
#[test]
fn script_heap_and_big_blocks_grow_from_opposite_ends() {
    unsafe {
        let small = arena::alloc(64, 16) as usize;
        let big = arena::alloc(64 * K, 16) as usize;
        let small2 = arena::alloc(64, 16) as usize;
        assert!(small < small2 && small2 < big);
        assert_eq!(arena::stats().bump_bytes, small2 + 64 - small);
    }
}

#[test]
fn failure_joins_a_gap_a_routine_pass_would_skip() {
    unsafe {
        // Top-down, so these three are neighbours: 64 KB, 16 KB, 64 KB.
        let (a, b, c) = (arena::alloc(64 * K, 16), arena::alloc(16 * K, 16), arena::alloc(64 * K, 16));
        assert_eq!(a as usize - b as usize, 16 * K);
        assert_eq!(b as usize - c as usize, 64 * K);
        exhaust_tail();
        arena::dealloc(a, 64 * K, 16);
        arena::dealloc(c, 64 * K, 16);
        arena::compact();
        // 16 KB freed since that pass: under the routine threshold, but the 144 KB run needs it.
        arena::dealloc(b, 16 * K, 16);
        assert!(!arena::alloc(128 * K, 16).is_null());
    }
}

#[test]
fn routine_pass_waits_for_enough_freed() {
    unsafe {
        let (a, b) = (arena::alloc(8 * K, 16), arena::alloc(8 * K, 16));
        exhaust_tail();
        arena::dealloc(a, 8 * K, 16);
        arena::dealloc(b, 8 * K, 16);
        let (_, largest) = arena::debug_free();
        arena::compact();
        assert_eq!(arena::debug_free().1, largest);
    }
}

#[test]
fn routine_pass_rejoins_neighbours_across_classes() {
    unsafe {
        let (a, b, c) = (arena::alloc(32 * K, 16), arena::alloc(16 * K, 16), arena::alloc(16 * K, 16));
        exhaust_tail();
        arena::dealloc(a, 32 * K, 16);
        arena::dealloc(b, 16 * K, 16);
        arena::dealloc(c, 16 * K, 16);
        assert_eq!(arena::debug_free().1, 32 * K);
        arena::compact();
        assert_eq!(arena::debug_free().1, 64 * K);
    }
}

#[test]
fn routine_pass_keeps_script_heap_out_of_big_classes() {
    unsafe {
        let blocks: Vec<*mut u8> = (0..2048).map(|_| arena::alloc(64, 16)).collect();
        let top_of_heap = arena::stats().bump_bytes;
        for &p in &blocks {
            arena::dealloc(p, 64, 16);
        }
        arena::compact();
        // A contiguous 128 KB of script heap is free, and a big request still comes from the top.
        let big = arena::alloc(64 * K, 16) as usize;
        assert!(big > blocks[2047] as usize + 16 * K);
        assert_eq!(arena::stats().bump_bytes, top_of_heap);
    }
}

#[test]
fn script_heap_reuses_its_frees_before_growing() {
    unsafe {
        let blocks: Vec<*mut u8> = (0..2048).map(|_| arena::alloc(64, 16)).collect();
        let top_of_heap = arena::stats().bump_bytes;
        for &p in &blocks {
            arena::dealloc(p, 64, 16);
        }
        arena::compact();
        for size in [32, 64, 256, 1024] {
            for _ in 0..16 {
                assert!(!arena::alloc(size, 16).is_null());
            }
        }
        // The host collects every time this grows by 256 KB: reuse must not look like growth.
        assert_eq!(arena::stats().bump_bytes, top_of_heap);
    }
}

#[test]
fn failure_also_joins_script_heap_held_apart() {
    unsafe {
        let blocks: Vec<*mut u8> = (0..2048).map(|_| arena::alloc(64, 16)).collect();
        exhaust_tail();
        for &p in &blocks {
            arena::dealloc(p, 64, 16);
        }
        arena::compact();
        assert!(arena::debug_free().1 < 4 * K);
        assert!(!arena::alloc(64 * K, 16).is_null());
    }
}

#[test]
fn blocks_never_overlap_under_churn() {
    unsafe {
        // A fixed sequence, so a failure replays. Every live block holds its own tag.
        let mut seed = 0x2f6e2b1u32;
        let mut next = move || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as usize
        };
        let mut live: Vec<(*mut u8, usize, u8)> = Vec::new();
        for step in 0..40_000usize {
            if live.len() > 400 || (next() % 3 == 0 && !live.is_empty()) {
                let (p, size, tag) = live.swap_remove(next() % live.len());
                assert!(core::slice::from_raw_parts(p, size).iter().all(|v| *v == tag), "step {step}");
                arena::dealloc(p, size, 16);
            } else {
                let size = 16usize << (next() % 13); // 16 B .. 64 KB
                let p = arena::alloc(size, 16);
                if !p.is_null() {
                    let tag = (step % 251) as u8;
                    p.write_bytes(tag, size);
                    live.push((p, size, tag));
                }
            }
            if step % 977 == 0 {
                arena::compact();
            }
        }
        for (p, size, tag) in live {
            assert!(core::slice::from_raw_parts(p, size).iter().all(|v| *v == tag));
        }
    }
}

#[no_mangle]
extern "C" fn pocket_psp_arena_capacity() -> usize {
    0
}
