//! Byte codecs for streamed assets — currently just the PackBits-style RLE
//! pinned in contracts/spec/spec.ts ("PackBits-style byte RLE").
//!
//! Format (the only compression the runtime knows):
//!   control byte c < 128  -> copy the next c+1 literal bytes
//!   control byte c >= 128 -> repeat the next byte (c - 126) times  [2..129]
//!
//! Encoding happens compiler-side (spec.ts packbitsEncode); the core only
//! decodes, and only accepts streams that decode to EXACTLY the expected
//! pixel-stream size — anything else is a malformed asset, not a best-effort
//! partial texture.

/// Decode a PackBits-RLE stream into `dst`. Returns true only when `src` is
/// consumed completely (no overrun, no trailing bytes) AND exactly
/// `dst.len()` bytes were produced; on false, `dst` contents are unspecified.
/// Never panics on malformed input — every read/write is bounds-checked
/// before it happens.
pub fn packbits_decode(src: &[u8], dst: &mut [u8]) -> bool {
    let mut i = 0usize; // src cursor
    let mut o = 0usize; // dst cursor
    while i < src.len() {
        let c = src[i];
        i += 1;
        if c < 128 {
            // Literal copy: next c+1 bytes verbatim.
            let n = c as usize + 1;
            if i + n > src.len() || o + n > dst.len() {
                return false;
            }
            dst[o..o + n].copy_from_slice(&src[i..i + n]);
            i += n;
            o += n;
        } else {
            // Run: repeat the next byte (c - 126) times [2..129].
            let n = c as usize - 126;
            if i >= src.len() || o + n > dst.len() {
                return false;
            }
            let b = src[i];
            i += 1;
            for d in dst[o..o + n].iter_mut() {
                *d = b;
            }
            o += n;
        }
    }
    o == dst.len()
}
