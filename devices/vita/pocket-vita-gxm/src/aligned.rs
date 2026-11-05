//! Owned shader bytes with an alignment independent of the target's u128 ABI.

#[derive(Clone)]
#[repr(C, align(16))]
struct Block([u8; 16]);

// These assertions also run when cross-compiling for the Vita's 32-bit ABI.
const _: () = assert!(core::mem::align_of::<Block>() == 16);
const _: () = assert!(core::mem::size_of::<Block>() == 16);

pub(crate) struct AlignedBytes {
    blocks: Vec<Block>,
    len: usize,
}

impl AlignedBytes {
    pub(crate) fn new(bytes: &[u8]) -> Self {
        let mut blocks = vec![Block([0; 16]); bytes.len().div_ceil(16)];
        for (block, chunk) in blocks.iter_mut().zip(bytes.chunks(16)) {
            block.0[..chunk.len()].copy_from_slice(chunk);
        }
        Self {
            blocks,
            len: bytes.len(),
        }
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        // Block has no padding; the allocation contains at least len initialized bytes.
        unsafe { core::slice::from_raw_parts(self.blocks.as_ptr().cast(), self.len) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shader_storage_preserves_unaligned_input_and_exact_length() {
        for len in [0, 1, 15, 16, 17, 324, 396, 1352, 4097] {
            let input: Vec<u8> = (0..len + 1).map(|n| (n % 251) as u8).collect();
            let bytes = AlignedBytes::new(&input[1..]);
            assert_eq!(bytes.bytes().as_ptr() as usize % 16, 0);
            assert_eq!(bytes.bytes(), &input[1..]);
        }
    }

    #[test]
    fn storage_owns_its_bytes_across_moves_and_other_allocations() {
        let input = vec![0x5a; 324];
        let bytes = AlignedBytes::new(&input);
        drop(input);
        let address = bytes.bytes().as_ptr();
        let moved = Box::new(bytes);
        let others: Vec<_> = (1..128)
            .map(|len| AlignedBytes::new(&vec![0; len]))
            .collect();
        assert_eq!(moved.bytes().as_ptr(), address);
        assert_eq!(moved.bytes(), &[0x5a; 324]);
        assert!(others.iter().all(|b| b.bytes().as_ptr() as usize % 16 == 0));
    }
}
