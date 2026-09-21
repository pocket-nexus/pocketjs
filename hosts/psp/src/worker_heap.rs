//! A worker-owned coalescing heap. No allocation or lock touches the UI heap
//! after the UI reserves its backing block, before starting the worker.
use core::ptr;

const UNIT: usize = 16;
#[repr(C)]
struct Free {
    size: usize,
    next: *mut Free,
}
pub struct Heap {
    base: usize,
    end: usize,
    first: *mut Free,
    used: usize,
    peak: usize,
    failures: usize,
}
impl Heap {
    pub const fn empty() -> Self {
        Self {
            base: 0,
            end: 0,
            first: ptr::null_mut(),
            used: 0,
            peak: 0,
            failures: 0,
        }
    }
    /// Caller provides an exclusive, 16-aligned block retained for this heap's lifetime.
    pub unsafe fn init(&mut self, pointer: *mut u8, bytes: usize) {
        self.base = pointer as usize;
        self.end = self.base + bytes;
        self.first = pointer.cast();
        self.used = 0;
        self.peak = 0;
        self.failures = 0;
        self.first.write(Free {
            size: bytes,
            next: ptr::null_mut(),
        });
    }
    fn normalized(size: usize) -> Option<usize> {
        size.max(UNIT)
            .checked_add(UNIT - 1)
            .map(|n| n & !(UNIT - 1))
    }
    pub unsafe fn alloc(&mut self, size: usize, align: usize) -> *mut u8 {
        let Some(size) = Self::normalized(size) else {
            self.failures += 1;
            return ptr::null_mut();
        };
        let align = align.max(UNIT);
        if !align.is_power_of_two() {
            self.failures += 1;
            return ptr::null_mut();
        }
        let mut link = &mut self.first as *mut *mut Free;
        while !(*link).is_null() {
            let block = *link;
            let start = block as usize;
            let Some(at) = start.checked_add(align - 1).map(|n| n & !(align - 1)) else {
                break;
            };
            let prefix = at - start;
            if prefix <= (*block).size && size <= (*block).size - prefix {
                let tail_size = (*block).size - prefix - size;
                let tail = if tail_size > 0 {
                    let tail = (at + size) as *mut Free;
                    tail.write(Free {
                        size: tail_size,
                        next: (*block).next,
                    });
                    tail
                } else {
                    (*block).next
                };
                if prefix > 0 {
                    (*block).size = prefix;
                    (*block).next = tail;
                } else {
                    *link = tail;
                }
                self.used += size;
                self.peak = self.peak.max(self.used);
                return at as *mut u8;
            }
            link = &mut (*block).next;
        }
        self.failures += 1;
        ptr::null_mut()
    }
    pub unsafe fn dealloc(&mut self, pointer: *mut u8, size: usize) {
        if pointer.is_null() {
            return;
        }
        let size = Self::normalized(size).unwrap();
        let at = pointer as usize;
        debug_assert!(at >= self.base && at + size <= self.end);
        let mut previous: *mut Free = ptr::null_mut();
        let mut next = self.first;
        while !next.is_null() && (next as usize) < at {
            previous = next;
            next = (*next).next;
        }
        let block = pointer as *mut Free;
        block.write(Free { size, next });
        if previous.is_null() {
            self.first = block
        } else {
            (*previous).next = block
        }
        if !next.is_null() && at + (*block).size == next as usize {
            (*block).size += (*next).size;
            (*block).next = (*next).next;
        }
        if !previous.is_null() && previous as usize + (*previous).size == at {
            (*previous).size += (*block).size;
            (*previous).next = (*block).next;
        }
        self.used -= size;
    }
}

#[cfg(target_os = "psp")]
mod device {
    use super::*;
    use core::sync::atomic::{AtomicI32, AtomicUsize, Ordering::*};
    pub const CAPACITY: usize = 4 * 1024 * 1024;
    static BASE: AtomicUsize = AtomicUsize::new(0);
    static OWNER: AtomicI32 = AtomicI32::new(0);
    static USED: AtomicUsize = AtomicUsize::new(0);
    static PEAK: AtomicUsize = AtomicUsize::new(0);
    static FAILURES: AtomicUsize = AtomicUsize::new(0);
    static mut HEAP: Heap = Heap::empty();
    /// Runs on the UI thread before the OS worker exists. No font work occurs here.
    pub unsafe fn reserve() -> bool {
        if BASE.load(Acquire) != 0 {
            return true;
        }
        let pointer = crate::arena::alloc(CAPACITY, UNIT);
        if pointer.is_null() {
            return false;
        }
        HEAP.init(pointer, CAPACITY);
        BASE.store(pointer as usize, Release);
        true
    }
    pub unsafe fn attach() {
        OWNER.store(psp::sys::sceKernelGetThreadId(), Release);
    }
    #[inline]
    pub fn is_worker() -> bool {
        let owner = OWNER.load(Relaxed);
        owner != 0 && unsafe { psp::sys::sceKernelGetThreadId() } == owner
    }
    #[inline]
    pub fn owns(pointer: *mut u8) -> bool {
        let base = BASE.load(Acquire);
        let at = pointer as usize;
        base != 0 && at >= base && at - base < CAPACITY
    }
    unsafe fn publish() {
        USED.store(HEAP.used, Relaxed);
        PEAK.store(HEAP.peak, Relaxed);
        FAILURES.store(HEAP.failures, Relaxed);
    }
    pub unsafe fn allocate(size: usize, align: usize) -> *mut u8 {
        let p = HEAP.alloc(size, align);
        publish();
        p
    }
    pub unsafe fn free(pointer: *mut u8, size: usize) {
        HEAP.dealloc(pointer, size);
        publish();
    }
    pub fn stats() -> (usize, usize, usize, usize) {
        (
            CAPACITY,
            USED.load(Relaxed),
            PEAK.load(Relaxed),
            FAILURES.load(Relaxed),
        )
    }
}
#[cfg(target_os = "psp")]
pub use device::*;

#[cfg(test)]
mod tests {
    use super::*;
    #[repr(align(256))]
    struct Bytes([u8; 65536]);
    #[test]
    fn coalesces_every_hole_and_preserves_live_allocations() {
        let mut bytes = Box::new(Bytes([0; 65536]));
        let mut heap = Heap::empty();
        unsafe {
            heap.init(bytes.0.as_mut_ptr(), bytes.0.len());
            let mut live = Vec::new();
            for round in 0..100 {
                for i in 0..80 {
                    let size = (round + i * 31) % 512 + 1;
                    let alignment = 1 << (i % 9);
                    let p = heap.alloc(size, alignment);
                    assert!(!p.is_null());
                    assert_eq!(p as usize % alignment, 0);
                    ptr::write_bytes(p, i as u8, size);
                    live.push((p, size, i as u8));
                }
                for (p, n, tag) in live.drain(..).rev() {
                    assert!(core::slice::from_raw_parts(p, n).iter().all(|b| *b == tag));
                    heap.dealloc(p, n);
                }
                assert_eq!(heap.used, 0);
                let whole = heap.alloc(65536, 16);
                assert_eq!(whole, bytes.0.as_mut_ptr());
                heap.dealloc(whole, 65536);
            }
        }
    }
    #[test]
    fn exhaustion_is_bounded_and_cannot_corrupt_another_heap() {
        let mut a = Box::new(Bytes([0; 65536]));
        let mut b = Box::new(Bytes([0; 65536]));
        let mut first = Heap::empty();
        let mut second = Heap::empty();
        unsafe {
            first.init(a.0.as_mut_ptr(), 65536);
            second.init(b.0.as_mut_ptr(), 65536);
            let owned = second.alloc(4096, 16);
            ptr::write_bytes(owned, 71, 4096);
            let full = first.alloc(65536, 16);
            assert!(!full.is_null());
            assert!(first.alloc(1, 1).is_null());
            assert!(first.alloc(usize::MAX, 1).is_null());
            assert_eq!(first.failures, 2);
            assert!(core::slice::from_raw_parts(owned, 4096)
                .iter()
                .all(|b| *b == 71));
            first.dealloc(full, 65536);
            assert!(!first.alloc(4096, 256).is_null());
            second.dealloc(owned, 4096);
        }
    }

    #[test]
    fn mixed_lifetimes_recover_the_entire_worker_arena() {
        let mut bytes = Box::new(Bytes([0; 65536]));
        let mut heap = Heap::empty();
        let mut random = 0x193ae54du32;
        let mut live: Vec<(*mut u8, usize, u8)> = Vec::new();
        unsafe {
            heap.init(bytes.0.as_mut_ptr(), bytes.0.len());
            for step in 0..100_000 {
                random ^= random << 13;
                random ^= random >> 17;
                random ^= random << 5;
                if !live.is_empty() && (random & 3 == 0 || live.len() == 80) {
                    let (p, size, tag) = live.swap_remove(random as usize % live.len());
                    assert!(core::slice::from_raw_parts(p, size)
                        .iter()
                        .all(|v| *v == tag));
                    heap.dealloc(p, size);
                } else {
                    let size = (random as usize % 1024) + 1;
                    let align = 1 << (random % 9);
                    let p = heap.alloc(size, align);
                    if p.is_null() {
                        continue;
                    }
                    assert_eq!(p as usize % align, 0);
                    assert!(live
                        .iter()
                        .all(|(q, n, _)| (p as usize + size) <= *q as usize
                            || *q as usize + n <= p as usize));
                    let tag = (step % 251) as u8;
                    ptr::write_bytes(p, tag, size);
                    live.push((p, size, tag));
                }
            }
            for (p, size, tag) in live {
                assert!(core::slice::from_raw_parts(p, size)
                    .iter()
                    .all(|v| *v == tag));
                heap.dealloc(p, size);
            }
            assert_eq!(heap.used, 0);
            assert_eq!(heap.alloc(65536, 16), bytes.0.as_mut_ptr());
        }
    }
}
