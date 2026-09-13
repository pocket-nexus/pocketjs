//! Fixed USB mailbox envelopes. No allocator or platform calls.
pub const MAGIC: u32 = 0x31424f50;
pub const HEADER: usize = 64;
pub const JSON_MAX: usize = 4096;
pub fn word(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
pub fn put(b: &mut [u8], at: usize, value: u32) {
    b[at..at + 4].copy_from_slice(&value.to_le_bytes());
}
pub fn hash(b: &[u8]) -> u32 {
    b.iter()
        .fold(2166136261, |h, v| (h ^ *v as u32).wrapping_mul(16777619))
}
pub fn valid(b: &[u8], epoch: u32, boot: u32, seq: u32) -> bool {
    if b.len() != HEADER
        || word(b, 0) != MAGIC
        || word(b, 4) != epoch
        || word(b, 8) != boot
        || word(b, 12) != seq
    {
        return false;
    }
    word(b, 16) == 0 && word(b, 32) > 0 && word(b, 32) as usize <= JSON_MAX
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn json_only_bounded_generation_fenced() {
        let mut h=[0u8;HEADER];
        for (at,v) in [(0,MAGIC),(4,1),(8,2),(12,3),(32,4096)] { put(&mut h,at,v); }
        assert!(valid(&h,1,2,3)); assert!(!valid(&h,2,2,3)); assert!(!valid(&h,1,3,3)); assert!(!valid(&h,1,2,4));
        put(&mut h,32,4097); assert!(!valid(&h,1,2,3));
        put(&mut h,32,1); put(&mut h,16,2); assert!(!valid(&h,1,2,3));
    }
}
