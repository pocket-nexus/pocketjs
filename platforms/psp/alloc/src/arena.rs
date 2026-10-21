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
//! Single-threaded (the QuickJS worker), so `static mut` matches the existing style.

use core::ffi::c_void;
use core::ptr;

use psp::sys::{self, SceSysMemBlockTypes, SceSysMemPartitionId};

// 32 power-of-two classes (16 B .. 2 GB) — covers any 32-bit PSP allocation.
const NCLASS: usize = 32;
const MIN_SHIFT: usize = 4; // smallest class = 16 bytes (>= a free-list next ptr)

static mut FREE: [*mut u8; NCLASS] = [ptr::null_mut(); NCLASS];
static mut BASE: usize = 0;
static mut BUMP: usize = 0;
static mut BUMP_END: usize = 0;
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
    // Carve a fresh 2^c block from the bump pointer, aligned to `a` (minimal waste).
    let p = (BUMP + a - 1) & !(a - 1);
    let np = p + (1usize << c);
    if np <= BUMP_END {
        BUMP = np;
        return p as *mut u8;
    }
    // The bump is spent. Before failing, split a larger free block: classes
    // strand memory, because a buffer grown geometrically frees each old size
    // into a class nothing asks for again (a one-shot boot that parses a
    // megabyte of JSON can strand megabytes this way). Halving a free 2^k
    // block yields two 2^(k-1) blocks, so any larger class can serve this one.
    // Deliberately last: until the bump runs dry this allocator behaves exactly
    // as before, and big blocks stay whole for the callers that want them.
    let mut c2 = c + 1;
    while c2 < NCLASS {
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
        if base & (a - 1) == 0 {
            return base as *mut u8;
        }
        // Alignment miss (only for align > 16): keep the block in its class
        // rather than leaking it, and report OOM like the pre-split path did.
        *(base as *mut *mut u8) = FREE[c];
        FREE[c] = base as *mut u8;
        break;
    }
    ptr::null_mut()
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
}

pub unsafe fn stats() -> Stats {
    ensure_init();
    let capacity = BUMP_END.saturating_sub(BASE);
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
