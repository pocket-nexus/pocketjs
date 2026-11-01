//! The envelope of a bytecode section (package sections 6 and 9,
//! `contracts/spec/quickjs-bytecode.ts`): a 48-byte header that names the
//! engine ABI the payload was serialized by, then the serialized QuickJS
//! object. The engine that reads the payload compares the digest with its
//! own; this module checks the shape alone.

use crate::package_format::{OFFSET_BYTECODE_ENGINE_ABI, OFFSET_BYTECODE_PAYLOAD};

/// "QJBC" as a little-endian word.
pub const MAGIC: u32 = 0x4342_4a51;
pub const VERSION: u32 = 1;
pub const HEADER_SIZE: usize = OFFSET_BYTECODE_PAYLOAD;
pub const FLAGS: u32 = 0;
pub const ENGINE_ABI_BYTES: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Envelope<'a> {
    /// SHA-256 of the canonical engine-ABI descriptor.
    pub engine_abi: [u8; ENGINE_ABI_BYTES],
    /// The serialized QuickJS object; never empty.
    pub bytecode: &'a [u8],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvelopeError {
    Truncated,
    BadMagic,
    BadVersion,
    BadHeader,
    BadFlags,
    Empty,
}

pub fn parse(bytes: &[u8]) -> Result<Envelope<'_>, EnvelopeError> {
    if bytes.len() < HEADER_SIZE {
        return Err(EnvelopeError::Truncated);
    }
    let word =
        |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    if word(0) != MAGIC {
        return Err(EnvelopeError::BadMagic);
    }
    if word(4) != VERSION {
        return Err(EnvelopeError::BadVersion);
    }
    if word(8) as usize != HEADER_SIZE {
        return Err(EnvelopeError::BadHeader);
    }
    if word(12) != FLAGS {
        return Err(EnvelopeError::BadFlags);
    }
    if bytes.len() == HEADER_SIZE {
        return Err(EnvelopeError::Empty);
    }
    let mut engine_abi = [0; ENGINE_ABI_BYTES];
    engine_abi.copy_from_slice(
        &bytes[OFFSET_BYTECODE_ENGINE_ABI..OFFSET_BYTECODE_ENGINE_ABI + ENGINE_ABI_BYTES],
    );
    Ok(Envelope {
        engine_abi,
        bytecode: &bytes[HEADER_SIZE..],
    })
}

/// Wrap a serialized object for `engine_abi`, for fixtures and tools.
pub fn encode(engine_abi: &[u8; ENGINE_ABI_BYTES], bytecode: &[u8]) -> alloc::vec::Vec<u8> {
    let mut bytes = alloc::vec![0u8; HEADER_SIZE];
    bytes[0..4].copy_from_slice(&MAGIC.to_le_bytes());
    bytes[4..8].copy_from_slice(&VERSION.to_le_bytes());
    bytes[8..12].copy_from_slice(&(HEADER_SIZE as u32).to_le_bytes());
    bytes[12..16].copy_from_slice(&FLAGS.to_le_bytes());
    bytes[OFFSET_BYTECODE_ENGINE_ABI..OFFSET_BYTECODE_ENGINE_ABI + ENGINE_ABI_BYTES]
        .copy_from_slice(engine_abi);
    bytes.extend_from_slice(bytecode);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_envelope_round_trips_and_refuses_other_shapes() {
        let digest = [0xab; ENGINE_ABI_BYTES];
        let section = encode(&digest, &[25, 1, 2, 3]);
        assert_eq!(section.len(), HEADER_SIZE + 4);
        let envelope = parse(&section).unwrap();
        assert_eq!(envelope.engine_abi, digest);
        assert_eq!(envelope.bytecode, &[25, 1, 2, 3]);
        assert_eq!(
            parse(&section[..HEADER_SIZE - 1]),
            Err(EnvelopeError::Truncated)
        );
        assert_eq!(parse(&section[..HEADER_SIZE]), Err(EnvelopeError::Empty));
        let mut other = section.clone();
        other[0] ^= 0xff;
        assert_eq!(parse(&other), Err(EnvelopeError::BadMagic));
        let mut other = section.clone();
        other[4] = 2;
        assert_eq!(parse(&other), Err(EnvelopeError::BadVersion));
        let mut other = section.clone();
        other[8] = 64;
        assert_eq!(parse(&other), Err(EnvelopeError::BadHeader));
        let mut other = section;
        other[12] = 1;
        assert_eq!(parse(&other), Err(EnvelopeError::BadFlags));
    }
}
