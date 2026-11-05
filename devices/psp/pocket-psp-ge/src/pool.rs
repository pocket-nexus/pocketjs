//! Retained, 16-byte-aligned blocks for transient GE vertex and index data.
use alloc::vec::Vec;
#[repr(C, align(16))]
#[derive(Clone, Copy)]
struct Chunk([u8; 16]);
const BLOCK_BYTES: usize = 64 * 1024;
pub struct FramePool {
    blocks: Vec<Vec<Chunk>>,
    current: usize,
    used: usize,
}
impl FramePool {
    pub const fn new() -> Self {
        Self {
            blocks: Vec::new(),
            current: 0,
            used: 0,
        }
    }
    /// Returned bytes retain their address until reset or drop, including when
    /// a later allocation grows the block list. Large asks get their own block.
    pub fn alloc(&mut self, bytes: usize) -> *mut u8 {
        let need = bytes.checked_add(15).expect("GE allocation overflow") & !15;
        assert!(
            need <= isize::MAX as usize,
            "GE allocation exceeds address space"
        );
        loop {
            if self.current < self.blocks.len() {
                let block = &mut self.blocks[self.current];
                let capacity = block.len() * 16;
                if need <= capacity - self.used {
                    let out = unsafe { block.as_mut_ptr().cast::<u8>().add(self.used) };
                    self.used += need;
                    return out;
                }
                self.current += 1;
                self.used = 0;
            } else {
                self.blocks
                    .push(alloc::vec![Chunk([0;16]);need.max(BLOCK_BYTES)/16]);
            }
        }
    }
    /// # Safety
    /// All GE lists referencing this pool must have completed. Reset does not
    /// wait; the owning runtime controls retirement and frame timing.
    pub unsafe fn reset(&mut self) {
        self.current = 0;
        self.used = 0;
    }
    #[cfg(target_os = "psp")]
    pub fn upload(&mut self, data: &[u8]) -> *const u8 {
        let dst = self.alloc(data.len());
        unsafe {
            core::ptr::copy_nonoverlapping(data.as_ptr(), dst, data.len());
            crate::cache::writeback_range(dst.cast(), data.len());
        }
        dst
    }
    pub fn resident_bytes(&self) -> usize {
        self.blocks.iter().map(|b| b.len() * 16).sum()
    }
}
impl Default for FramePool {
    fn default() -> Self {
        Self::new()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn growth_keeps_old_gpu_addresses_aligned_and_retirement_reuses_memory() {
        let mut p = FramePool::new();
        let a = p.alloc(31);
        unsafe {
            core::ptr::write_bytes(a, 0x5a, 31);
        }
        let b = p.alloc(65536);
        let c = p.alloc(100000);
        for x in [a, b, c] {
            assert_eq!(x as usize % 16, 0);
        }
        assert!(a != b && b != c);
        assert_eq!(unsafe { core::slice::from_raw_parts(a, 31) }, [0x5a; 31]);
        let bytes = p.resident_bytes();
        unsafe {
            p.reset();
        }
        assert_eq!(p.alloc(31), a);
        assert_eq!(p.alloc(65536), b);
        assert_eq!(p.alloc(100000), c);
        assert_eq!(p.resident_bytes(), bytes);
    }
    #[test]
    #[should_panic(expected = "overflow")]
    fn overflowing_size_is_rejected_before_allocation() {
        FramePool::new().alloc(usize::MAX);
    }
}
