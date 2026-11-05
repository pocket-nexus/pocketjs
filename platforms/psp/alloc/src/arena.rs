// COPIED from dreamcart runtime/src/arena.rs (proven on hardware), with ONE
// change [R]: ensure_init calls sceKernelAllocPartitionMemory /
// sceKernelGetBlockHeadAddr DIRECTLY. In this crate the arena IS the
// #[global_allocator] (framework/src/alloc.rs), so the original's alloc::alloc::alloc
// route would recurse infinitely. Margin shrunk 4 MB -> 2 MB: retained core
// buffers/textures now live inside the arena, so the margin only covers
// late kernel allocations (utility thread stacks) + safety.

//! A single-arena sub-allocator for QuickJS + newlib `malloc` + Rust `alloc`.
//!
//! rust-psp's global allocator (`alloc_impl.rs`) calls `sceKernelAllocPartitionMemory`
//! for EVERY allocation — i.e. one kernel object per allocation. The PSP kernel
//! caps the number of objects (~4096 in PPSSPP), and QuickJS makes many thousands
//! of small allocations evaluating a large bundle, so it exhausts the slots and
//! the un-checked allocator writes to a null block head -> the `0x300000000` crash.
//!
//! Fix: grab ONE big block from the kernel up front and sub-allocate from it. Every
//! QuickJS / C `malloc` then comes from this arena and consumes ZERO additional
//! kernel objects.
//!
//! The sub-allocator is a SEGREGATED (power-of-two size-class) free list: alloc and
//! free are O(1) — pop/push a per-class free list, carving a fresh block from a bump
//! pointer when a class is empty. This matters enormously: QuickJS makes thousands
//! of small alloc/free per frame (every matrix/array/temporary), and a first-fit
//! linked-list allocator's O(free-holes) cost made that ~1 ms PER ALLOCATION on the
//! emulated core (the dominant per-frame cost). O(1) classes fixed it (car3d 15 ->
//! 60 fps). Blocks recycle within their class, so a steady per-frame workload stops
//! growing the bump and runs entirely from the free lists.
//!
//! Script heap and big blocks grow from opposite ends: below 4 KB up from the bottom, 4 KB and above
//! down from the top. A script heap woven between textures leaves freed texture holes that can never
//! rejoin, and a game dies with a megabyte free in 32 KB pieces. `Stats::bump_bytes` therefore counts
//! the script-heap side only, which is what the host's collection trigger is watching.
//!
//! Single-threaded (the QuickJS worker), so `static mut` matches the existing style.

use core::ffi::c_void;
use core::ptr;

use psp::sys::{self, SceSysMemBlockTypes, SceSysMemPartitionId};

// 32 power-of-two classes (16 B .. 2 GB) — covers any 32-bit PSP allocation.
const NCLASS: usize = 32;
const MIN_SHIFT: usize = 4; // smallest class = 16 bytes (>= a free-list next ptr)
const COMPACT_MIN_FREED: usize = 32 * 1024; // a routine pass (`compact`) waits for this much to have been freed
const LARGE_SHIFT: usize = 12; // 4 KB and up: textures, big buffers. Everything smaller is script heap.

static mut FREE: [*mut u8; NCLASS] = [ptr::null_mut(); NCLASS];
static mut BASE: usize = 0;
static mut BUMP: usize = 0;
static mut BUMP_END: usize = 0;
static mut ARENA_END: usize = 0;
static mut FREED_SINCE_COMPACT: usize = 0;
static mut SCRIPT_HEAP_HELD_APART: bool = false; // the last routine pass left script-heap runs unjoined
static mut INIT_FREE: usize = 0;
static mut CONFIGURED_SIZE: usize = 0;
static mut INITED: bool = false;

#[derive(Clone, Copy)]
pub struct Stats {
    pub capacity_bytes: usize,
    pub bump_bytes: usize,
    pub tail_free_bytes: usize,
    pub init_free_bytes: usize,
    pub configured_bytes: usize,
}

// Program-owned startup policy. This hook must not allocate or call the arena.
extern "C" {
    fn pocket_psp_arena_capacity() -> usize;
}

/// Reserve the arena on first use: take most of the free partition in a single
/// kernel block, leaving a 2 MB margin for late kernel allocations (utility
/// thread stacks) + safety. Called lazily from `alloc` — the global allocator
/// can be hit before main-style init, so this must be self-contained.
///
/// [R] Direct syscalls (NOT alloc::alloc::alloc): this arena backs the crate's
/// #[global_allocator] (framework/src/alloc.rs), so allocating through the Rust
/// allocator here would recurse straight back into `ensure_init`.
unsafe fn ensure_init() {
    if INITED {
        return;
    }
    INITED = true;
    let free = sys::sceKernelMaxFreeMemSize() as usize;
    INIT_FREE = free;
    CONFIGURED_SIZE = pocket_psp_arena_capacity();
    let margin = 2 * 1024 * 1024;
    let default_size = if free > margin + 1024 * 1024 {
        free - margin
    } else {
        free / 2
    };
    let size = if CONFIGURED_SIZE > 0 {
        CONFIGURED_SIZE
    } else {
        default_size
    };
    if size == 0 {
        return;
    }
    // ONE kernel object for the whole heap.
    let id = sys::sceKernelAllocPartitionMemory(
        SceSysMemPartitionId::SceKernelPrimaryUserPartition,
        b"PocketJS-arena\0".as_ptr(),
        SceSysMemBlockTypes::Low,
        size as u32,
        ptr::null_mut::<c_void>(),
    );
    if id.0 < 0 {
        return;
    }
    let base = sys::sceKernelGetBlockHeadAddr(id) as usize;
    if base != 0 {
        BASE = (base + 15) & !15; // 16-align the bump start
        BUMP = BASE;
        BUMP_END = base + size;
        ARENA_END = BUMP_END;
    }
}

/// Smallest power-of-two class index whose block (2^c) holds `need` bytes.
#[inline]
fn class_of(need: usize) -> usize {
    let mut c = MIN_SHIFT;
    while (1usize << c) < need {
        c += 1;
    }
    c
}

/// True when `old` and `new` bytes land in the same class, i.e. a block already
/// sized for `old` also holds `new`. A grow that stays inside its class owns the
/// bytes already, so a caller can keep the pointer instead of copying (see
/// qjs_alloc's realloc: QuickJS grows buffers geometrically, and half of those
/// grows stay in class).
#[inline]
pub fn same_class(old: usize, new: usize, align: usize) -> bool {
    let a = if align < 16 { 16 } else { align };
    let norm = |n: usize| if n > a { n } else { a };
    old != 0 && new != 0 && class_of(norm(old)) == class_of(norm(new))
}

/// Allocate `size` bytes aligned to `align` from the arena (null on OOM).
#[inline]
pub unsafe fn alloc(size: usize, align: usize) -> *mut u8 {
    ensure_init();
    if size == 0 || BUMP == 0 {
        return ptr::null_mut();
    }
    let a = if align < 16 { 16 } else { align };
    // Block must hold `size` AND be sized up for `align`. Free-listed blocks
    // are only guaranteed aligned to the `a` of THEIR carve, so a pop must
    // re-check alignment (align > 16 requests fall through to a fresh carve
    // when the head block doesn't satisfy them).
    let c = class_of(if size > a { size } else { a });
    if c >= NCLASS {
        return ptr::null_mut();
    }
    let head = FREE[c];
    if !head.is_null() && (head as usize) & (a - 1) == 0 {
        FREE[c] = *(head as *mut *mut u8); // pop: next-pointer is stored in the block
        return head;
    }
    if c >= LARGE_SHIFT {
        let bytes = 1usize << c;
        if BUMP_END >= bytes {
            let p = (BUMP_END - bytes) & !(a - 1);
            if p >= BUMP {
                BUMP_END = p;
                return p as *mut u8;
            }
        }
    } else {
        // Free script heap first, so the region does not grow while it holds free blocks. Compaction
        // gathers small frees into bigger small classes, and a steady heap must keep running from those.
        if split_free(c, a, LARGE_SHIFT) {
            return alloc(size, align);
        }
        let p = (BUMP + a - 1) & !(a - 1);
        let np = p + (1usize << c);
        if np <= BUMP_END {
            BUMP = np;
            return p as *mut u8;
        }
    }
    // The tail is spent. Before failing, split a larger free block: classes strand memory, because a
    // buffer grown geometrically frees each old size into a class nothing asks for again (a one-shot
    // boot that parses a megabyte of JSON can strand megabytes this way). Halving a free 2^k block
    // yields two 2^(k-1) blocks, so any larger class can serve this one.
    if split_free(c, a, NCLASS) {
        return alloc(size, align);
    }
    // Still nothing: free blocks are stranded in smaller classes. Rejoin everything that can rejoin
    // (rare, and much cheaper than dying with a megabyte free in pieces) and try once more.
    if FREED_SINCE_COMPACT > 0 || SCRIPT_HEAP_HELD_APART {
        join_free(true);
        if split_free(c, a, NCLASS) {
            return alloc(size, align);
        }
        let head = FREE[c];
        if !head.is_null() && (head as usize) & (a - 1) == 0 {
            FREE[c] = *(head as *mut *mut u8);
            return head;
        }
    }
    ptr::null_mut()
}

/// Halve the smallest larger free block below class `limit` down to class `c`. True when class `c` now
/// has a block whose head satisfies `a`; the caller's retry pops it.
unsafe fn split_free(c: usize, a: usize, limit: usize) -> bool {
    let mut c2 = c + 1;
    while c2 < limit {
        let big = FREE[c2];
        if big.is_null() {
            c2 += 1;
            continue;
        }
        FREE[c2] = *(big as *mut *mut u8);
        let base = big as usize;
        let mut k = c2;
        while k > c {
            k -= 1;
            let half = (base + (1usize << k)) as *mut u8;
            *(half as *mut *mut u8) = FREE[k];
            FREE[k] = half;
        }
        // Alignment miss (only for align > 16): the block stays in its class rather than leaking.
        *(base as *mut *mut u8) = FREE[c];
        FREE[c] = base as *mut u8;
        return base & (a - 1) == 0;
    }
    false
}

/// Sort a free list by address: bottom-up merge sort over the next-pointers, no extra memory.
unsafe fn sort_by_address(mut list: *mut u8) -> *mut u8 {
    let mut width = 1usize;
    loop {
        let (mut rest, mut merges) = (list, 0usize);
        let mut out: *mut u8 = ptr::null_mut();
        let mut tail: *mut u8 = ptr::null_mut();
        while !rest.is_null() {
            merges += 1;
            let mut a = rest;
            let mut b = rest;
            let mut na = 0usize;
            while na < width && !b.is_null() {
                b = *(b as *mut *mut u8);
                na += 1;
            }
            let mut nb = width;
            while na > 0 || (nb > 0 && !b.is_null()) {
                let take_a = na > 0 && (nb == 0 || b.is_null() || (a as usize) < (b as usize));
                let node = if take_a {
                    let n = a;
                    a = *(a as *mut *mut u8);
                    na -= 1;
                    n
                } else {
                    let n = b;
                    b = *(b as *mut *mut u8);
                    nb -= 1;
                    n
                };
                if tail.is_null() {
                    out = node;
                } else {
                    *(tail as *mut *mut u8) = node;
                }
                tail = node;
            }
            rest = b;
        }
        if !tail.is_null() {
            *(tail as *mut *mut u8) = ptr::null_mut();
        }
        list = out;
        if merges <= 1 {
            return list;
        }
        width *= 2;
    }
}

/// Rejoin free memory at a moment the host chose (`pack.gc`), when enough has been freed to be worth it.
/// Free script heap stays in script-heap classes, so the two regions stay apart and the heap keeps
/// running from its own blocks. An allocation that would otherwise fail joins everything itself.
///
/// # Safety
/// Call on the arena's owning thread, without concurrent allocator access.
pub unsafe fn compact() {
    if FREED_SINCE_COMPACT >= COMPACT_MIN_FREED {
        join_free(false);
    }
}

/// Every free block goes through one address-sorted list, whatever its class, and each contiguous run is
/// cut back into the largest power-of-two blocks that fit. Blocks of different classes must be able to
/// merge: a freed 8 KB texture next to a freed 16 KB one is what fragmentation looks like here. No block
/// needs natural alignment (`alloc` re-checks), and a free block has room for its size because the
/// smallest class is 16 bytes. O(n log n) in free blocks; run rarely.
///
/// `whole` also lets script-heap runs become big blocks; without it they stop at the largest small class.
unsafe fn join_free(whole: bool) {
    FREED_SINCE_COMPACT = 0;
    SCRIPT_HEAP_HELD_APART = !whole;
    let mut all: *mut u8 = ptr::null_mut();
    for c in MIN_SHIFT..NCLASS {
        let mut node = FREE[c];
        FREE[c] = ptr::null_mut();
        while !node.is_null() {
            let next = *(node as *mut *mut u8);
            *(node as *mut usize).add(1) = 1usize << c;
            *(node as *mut *mut u8) = all;
            all = node;
            node = next;
        }
    }
    let mut node = sort_by_address(all);
    while !node.is_null() {
        let start = node as usize;
        let mut end = start + *(node as *mut usize).add(1);
        node = *(node as *mut *mut u8);
        while !node.is_null() && node as usize == end {
            end += *(node as *mut usize).add(1);
            node = *(node as *mut *mut u8);
        }
        let top = if !whole && end <= BUMP { LARGE_SHIFT - 1 } else { NCLASS - 1 };
        let mut at = start;
        while at < end {
            let c = ((usize::BITS - 1 - (end - at).leading_zeros()) as usize).min(top);
            *(at as *mut *mut u8) = FREE[c];
            FREE[c] = at as *mut u8;
            at += 1usize << c;
        }
    }
}

/// Permanently carve an exact-sized block from the arena.
///
/// Use this for large, lifetime-long backing stores such as a streamed P3D
/// map. The normal allocator deliberately rounds every request to a power of
/// two so freed blocks can be recycled in O(1). That is a severe penalty for
/// an object which is never freed: an 18.2 MB map would reserve a 32 MB size
/// class. Exact permanent allocations retain the upstream embedded-map memory
/// behaviour (one copy, its actual byte length) while still sharing the one
/// PSP kernel block used by the rest of the runtime.
///
/// The result is uninitialized storage. Only alignment padding and `size`
/// consume the uncarved tail; free-list blocks cannot satisfy this request.
/// Zero size, invalid alignment, overflow and insufficient tail return null.
/// A failed request does not advance the bump pointer.
///
/// # Safety
/// Call on the arena's owning thread, without concurrent allocator access.
/// This allocation lasts until process exit: never pass it to `dealloc`,
/// `free`, `realloc`, `Box::from_raw` or `Vec::from_raw_parts`. Allocate a
/// backing store once and reuse it; repeated calls cannot reclaim old stores.
#[inline]
pub unsafe fn alloc_permanent(size: usize, align: usize) -> *mut u8 {
    ensure_init();
    if size == 0 || BUMP == 0 || !align.is_power_of_two() {
        return ptr::null_mut();
    }
    let a = if align < 16 { 16 } else { align };
    let Some(p) = BUMP.checked_add(a - 1).map(|p| p & !(a - 1)) else {
        return ptr::null_mut();
    };
    let Some(np) = p.checked_add(size) else {
        return ptr::null_mut();
    };
    if np > BUMP_END {
        return ptr::null_mut();
    }
    BUMP = np;
    p as *mut u8
}

/// Free a pointer previously returned by `alloc` with the SAME size + align.
#[inline]
pub unsafe fn dealloc(p: *mut u8, size: usize, align: usize) {
    if p.is_null() || size == 0 {
        return;
    }
    let a = if align < 16 { 16 } else { align };
    let c = class_of(if size > a { size } else { a });
    if c >= NCLASS {
        return;
    }
    *(p as *mut *mut u8) = FREE[c]; // push: store the old head in the freed block
    FREE[c] = p;
    FREED_SINCE_COMPACT += 1usize << c;
}

pub unsafe fn stats() -> Stats {
    ensure_init();
    let capacity = ARENA_END.saturating_sub(BASE);
    let bump = BUMP.saturating_sub(BASE);
    Stats {
        capacity_bytes: capacity,
        bump_bytes: bump,
        tail_free_bytes: BUMP_END.saturating_sub(BUMP),
        init_free_bytes: INIT_FREE,
        configured_bytes: CONFIGURED_SIZE,
    }
}

/// Diagnostic snapshot on the allocator's owning thread; never allocates.
/// Free lists are separate blocks, so total free is not contiguous space.
/// Returns `(total_free_bytes, largest_free_block_bytes)`, including the tail.
/// The largest block is raw storage, not a guaranteed request size after
/// alignment or size-class rounding. Permanent allocations use only the tail.
/// Walks every free-list node: O(number of free blocks). Sample on demand or
/// at a bounded diagnostic interval, outside the per-frame rendering path.
///
/// # Safety
/// Call on the arena's owning thread, without concurrent allocator access.
pub unsafe fn debug_free() -> (usize, usize) {
    let mut total = stats().tail_free_bytes;
    let mut largest = total;
    for c in MIN_SHIFT..NCLASS {
        let mut block = FREE[c];
        if !block.is_null() {
            largest = largest.max(1usize << c);
        }
        while !block.is_null() {
            total += 1usize << c;
            block = *(block as *mut *mut u8);
        }
    }
    (total, largest)
}
