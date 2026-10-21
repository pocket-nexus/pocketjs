//! SHA-256 (FIPS 180-4) over a byte slice.
//!
//! A generic native runtime names an application's state directory from its
//! id with the same digest the build tools use (`tools/3ds.ts`
//! `runtimeSlot`: the first 16 hex digits of SHA-256(id)), so the device
//! computes it from the `.pocket` it boots instead of having it compiled in.

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const INITIAL: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

fn compress(state: &mut [u32; 8], block: &[u8]) {
    let mut w = [0u32; 64];
    for (index, word) in w.iter_mut().take(16).enumerate() {
        let at = index * 4;
        *word = u32::from_be_bytes([block[at], block[at + 1], block[at + 2], block[at + 3]]);
    }
    for index in 16..64 {
        let s0 = w[index - 15].rotate_right(7) ^ w[index - 15].rotate_right(18) ^ (w[index - 15] >> 3);
        let s1 = w[index - 2].rotate_right(17) ^ w[index - 2].rotate_right(19) ^ (w[index - 2] >> 10);
        w[index] = w[index - 16]
            .wrapping_add(s0)
            .wrapping_add(w[index - 7])
            .wrapping_add(s1);
    }
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
    for index in 0..64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let choose = (e & f) ^ (!e & g);
        let t1 = h
            .wrapping_add(s1)
            .wrapping_add(choose)
            .wrapping_add(K[index])
            .wrapping_add(w[index]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let majority = (a & b) ^ (a & c) ^ (b & c);
        let t2 = s0.wrapping_add(majority);
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }
    for (slot, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
        *slot = slot.wrapping_add(value);
    }
}

/// The 32-byte digest of `data`.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut state = INITIAL;
    let mut blocks = data.chunks_exact(64);
    for block in &mut blocks {
        compress(&mut state, block);
    }
    let rest = blocks.remainder();
    let mut tail = [0u8; 128];
    tail[..rest.len()].copy_from_slice(rest);
    tail[rest.len()] = 0x80;
    let tail_length = if rest.len() < 56 { 64 } else { 128 };
    let bits = (data.len() as u64).wrapping_mul(8);
    tail[tail_length - 8..tail_length].copy_from_slice(&bits.to_be_bytes());
    for block in tail[..tail_length].chunks_exact(64) {
        compress(&mut state, block);
    }
    let mut digest = [0u8; 32];
    for (index, word) in state.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

/// Lowercase hex of the first `N / 2` digest bytes: `N` = 16 gives the
/// runtime slot `tools/3ds.ts` names.
pub fn sha256_hex_prefix<const N: usize>(data: &[u8]) -> [u8; N] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = sha256(data);
    let mut out = [0u8; N];
    for (index, slot) in out.iter_mut().enumerate() {
        let byte = digest[index / 2];
        *slot = HEX[if index % 2 == 0 { (byte >> 4) as usize } else { (byte & 15) as usize }];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(digest: [u8; 32]) -> std::string::String {
        digest.iter().map(|byte| std::format!("{byte:02x}")).collect()
    }

    #[test]
    fn known_vectors() {
        assert_eq!(
            hex(sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex(sha256(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        let million = std::vec![b'a'; 1_000_000];
        assert_eq!(
            hex(sha256(&million)),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
        // Every tail length around the 56-byte padding boundary.
        for length in 50..70 {
            let data = std::vec![0x5au8; length];
            assert_eq!(sha256(&data).len(), 32);
        }
    }

    #[test]
    fn runtime_slot_prefix() {
        // tools/3ds.ts runtimeSlot("dev.pocket-nexus.studio.twenty48")
        let slot = sha256_hex_prefix::<16>(b"dev.pocket-nexus.studio.twenty48");
        assert_eq!(&slot, b"8963ccb622f441a1");
    }
}
