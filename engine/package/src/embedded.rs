//! Bundle construction for embedders that receive a JS/pak pair. The result
//! uses the ordinary bundle reader and admission path. Product builds supply
//! the compiler's `.pkb` output through a PackageSource instead.

use crate::{bundle::fnv1a64, package_format::*};
use alloc::vec::Vec;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodeError {
    InvalidIdentity,
    InvalidJavaScript,
    /// Section kinds are not strictly increasing.
    InvalidSections,
    TooLarge,
    NoMemory,
}

pub struct EmbeddedPackage<'a> {
    pub host_abi: u32,
    /// Identity of the explicit profile used by the raw JS/pak embedder.
    /// A supplied bundle retains its original bytes and admission facts.
    pub profile_hash: [u8; 32],
    pub identity: &'a [u8],
    pub plan: &'a [u8],
    pub code: &'a [u8],
    pub pak: &'a [u8],
}

pub fn identity(output: &str, id: &str, title: &str) -> Result<Vec<u8>, EncodeError> {
    let mut bytes = Vec::new();
    for value in [output, id, title] {
        let size = u16::try_from(value.len()).map_err(|_| EncodeError::InvalidIdentity)?;
        bytes
            .try_reserve(value.len() + 2)
            .map_err(|_| EncodeError::NoMemory)?;
        bytes.extend_from_slice(&size.to_le_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }
    Ok(bytes)
}

fn align(value: usize) -> Result<usize, EncodeError> {
    value
        .checked_add(BUNDLE_ALIGN - 1)
        .map(|n| n & !(BUNDLE_ALIGN - 1))
        .ok_or(EncodeError::TooLarge)
}
fn write32(bytes: &mut [u8], offset: usize, value: usize) {
    bytes[offset..offset + 4].copy_from_slice(&(value as u32).to_le_bytes());
}

/// A zero-filled bundle of `lengths` payloads with its header and section
/// table written, the payload offsets in `offsets`, and the footer offset.
/// The caller copies the payloads and writes the payload hash and the
/// footer. The bundle is the one allocation.
fn layout(
    host_abi: u32,
    profile_hash: [u8; 32],
    kinds: &[u32],
    lengths: &[usize],
    offsets: &mut [usize],
) -> Result<(Vec<u8>, usize), EncodeError> {
    if kinds.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(EncodeError::InvalidSections);
    }
    let table_size = kinds
        .len()
        .checked_mul(BUNDLE_SECTION_SIZE)
        .ok_or(EncodeError::TooLarge)?;
    let mut cursor = align(
        BUNDLE_HEADER_SIZE
            .checked_add(table_size)
            .ok_or(EncodeError::TooLarge)?,
    )?;
    for (offset, &size) in offsets.iter_mut().zip(lengths) {
        *offset = cursor;
        cursor = align(cursor.checked_add(size).ok_or(EncodeError::TooLarge)?)?;
    }
    let length = cursor
        .checked_add(BUNDLE_FOOTER_SIZE)
        .filter(|&n| n <= u32::MAX as usize)
        .ok_or(EncodeError::TooLarge)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| EncodeError::NoMemory)?;
    bytes.resize(length, 0);
    write32(&mut bytes, OFFSET_HEADER_MAGIC, BUNDLE_MAGIC as usize);
    write32(&mut bytes, OFFSET_HEADER_VERSION, BUNDLE_VERSION as usize);
    write32(&mut bytes, OFFSET_HEADER_HOST_ABI, host_abi as usize);
    write32(&mut bytes, OFFSET_HEADER_SECTION_COUNT, kinds.len());
    bytes[OFFSET_HEADER_PROFILE_HASH..OFFSET_HEADER_PROFILE_HASH + 32]
        .copy_from_slice(&profile_hash);
    for (index, ((&kind, &size), &offset)) in kinds.iter().zip(lengths).zip(&*offsets).enumerate() {
        let entry = BUNDLE_HEADER_SIZE + index * BUNDLE_SECTION_SIZE;
        write32(&mut bytes, entry + OFFSET_SECTION_KIND, kind as usize);
        write32(&mut bytes, entry + OFFSET_SECTION_OFFSET, offset);
        write32(&mut bytes, entry + OFFSET_SECTION_SIZE, size);
    }
    Ok((bytes, cursor))
}

fn finish(bytes: &mut [u8], payload_hash: u64, footer: usize) {
    bytes[OFFSET_HEADER_PAYLOAD_HASH..OFFSET_HEADER_PAYLOAD_HASH + 8]
        .copy_from_slice(&payload_hash.to_le_bytes());
    let hash = fnv1a64(&[&bytes[..footer]]);
    bytes[footer..].copy_from_slice(&hash.to_le_bytes());
}

/// A bundle of identity, plan, NUL-terminated JavaScript and pak. `code`
/// may end with one NUL; the bundle carries exactly one.
pub fn encode(package: EmbeddedPackage<'_>) -> Result<Vec<u8>, EncodeError> {
    let code = package.code.strip_suffix(&[0]).unwrap_or(package.code);
    if code.contains(&0) {
        return Err(EncodeError::InvalidJavaScript);
    }
    let javascript_length = code.len().checked_add(1).ok_or(EncodeError::TooLarge)?;
    let kinds = [SECTION_IDENTITY, SECTION_PLAN, SECTION_JS, SECTION_PAK];
    let lengths = [
        package.identity.len(),
        package.plan.len(),
        javascript_length,
        package.pak.len(),
    ];
    let mut offsets = [0; 4];
    let (mut bytes, footer) = layout(
        package.host_abi,
        package.profile_hash,
        &kinds,
        &lengths,
        &mut offsets,
    )?;
    // The zero-filled output already holds the JavaScript terminator.
    for (payload, offset) in [package.identity, package.plan, code, package.pak]
        .into_iter()
        .zip(offsets)
    {
        bytes[offset..offset + payload.len()].copy_from_slice(payload);
    }
    // Hash the terminator as part of JavaScript without allocating a second
    // script buffer.
    let hash = fnv1a64(&[package.identity, package.plan, code, &[0], package.pak]);
    finish(&mut bytes, hash, footer);
    Ok(bytes)
}

/// A bundle holding `sections`, given in strictly increasing kind order with
/// their payloads as stored, for fixtures and tools.
pub fn encode_sections(
    host_abi: u32,
    profile_hash: [u8; 32],
    sections: &[(u32, &[u8])],
) -> Result<Vec<u8>, EncodeError> {
    let mut kinds = Vec::new();
    let mut lengths = Vec::new();
    let mut payloads = Vec::new();
    let mut offsets = Vec::new();
    kinds
        .try_reserve_exact(sections.len())
        .and(lengths.try_reserve_exact(sections.len()))
        .and(payloads.try_reserve_exact(sections.len()))
        .and(offsets.try_reserve_exact(sections.len()))
        .map_err(|_| EncodeError::NoMemory)?;
    for &(kind, payload) in sections {
        kinds.push(kind);
        lengths.push(payload.len());
        payloads.push(payload);
        offsets.push(0);
    }
    let (mut bytes, footer) = layout(host_abi, profile_hash, &kinds, &lengths, &mut offsets)?;
    for (payload, &offset) in payloads.iter().zip(&offsets) {
        bytes[offset..offset + payload.len()].copy_from_slice(payload);
    }
    finish(&mut bytes, fnv1a64(&payloads), footer);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::admission::testing::{host, PLAN};
    use crate::source::{LoadedPackage, MemorySource};
    #[test]
    fn embedded_input_uses_normal_admission_and_keeps_one_terminator() {
        let identity = identity("test", "test.embedded", "Embedded").unwrap();
        let make = |code| {
            encode(EmbeddedPackage {
                host_abi: 1,
                profile_hash: [0x11; 32],
                identity: &identity,
                plan: PLAN,
                code,
                pak: &[],
            })
        };
        let bytes = make(b"hello").unwrap();
        assert_eq!(bytes, make(b"hello\0").unwrap());
        assert_eq!(make(b"hello\0\0"), Err(EncodeError::InvalidJavaScript));
        let package =
            LoadedPackage::load(&mut MemorySource(&bytes), &host(1, [0x11; 32]), bytes.len())
                .unwrap();
        assert_eq!(package.javascript(), b"hello\0");
        assert!(
            LoadedPackage::load(&mut MemorySource(&bytes), &host(2, [0x11; 32]), bytes.len())
                .is_err()
        );
        let mut damaged = bytes;
        damaged[0] ^= 1;
        assert!(LoadedPackage::load(
            &mut MemorySource(&damaged),
            &host(1, [0x11; 32]),
            damaged.len()
        )
        .is_err());
    }

    #[test]
    fn encode_and_encode_sections_write_the_same_bundle() {
        let identity = identity("fixture", "app", "App").unwrap();
        let bytes = encode(EmbeddedPackage {
            host_abi: 7,
            profile_hash: [0x55; 32],
            identity: &identity,
            plan: PLAN,
            code: b"test",
            pak: b"pak",
        })
        .unwrap();
        let sections = encode_sections(
            7,
            [0x55; 32],
            &[
                (SECTION_IDENTITY, &identity),
                (SECTION_PLAN, PLAN),
                (SECTION_JS, b"test\0"),
                (SECTION_PAK, b"pak"),
            ],
        )
        .unwrap();
        assert_eq!(bytes, sections);
        let parsed = crate::Bundle::parse(&bytes, false).unwrap();
        assert_eq!(parsed.host_abi, 7);
        assert_eq!(parsed.profile_hash, [0x55; 32]);
        assert_eq!(
            encode_sections(7, [0; 32], &[(SECTION_PLAN, PLAN), (SECTION_PLAN, PLAN)]),
            Err(EncodeError::InvalidSections)
        );
    }
}
