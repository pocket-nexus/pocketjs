//! Compatibility construction for embedders that still receive a JS/pak pair.
//! The result uses the ordinary package reader and admission path. New product
//! builds supply the compiler's `.pocket` output through a PackageSource.

use crate::{package::fnv1a64, package_format::*};
use alloc::vec::Vec;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodeError {
    InvalidTarget,
    InvalidIdentity,
    InvalidJavaScript,
    /// Section kinds are not strictly increasing.
    InvalidSections,
    TooLarge,
    NoMemory,
}

pub struct EmbeddedPackage<'a> {
    pub target: &'a str,
    pub host_abi: u32,
    /// Identity of the explicit profile used by the raw JS/pak embedder.
    /// A supplied .pocket must retain its original bytes and admission facts.
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
        .checked_add(POCKET_ALIGN - 1)
        .map(|n| n & !(POCKET_ALIGN - 1))
        .ok_or(EncodeError::TooLarge)
}
fn write32(bytes: &mut [u8], offset: usize, value: usize) {
    bytes[offset..offset + 4].copy_from_slice(&(value as u32).to_le_bytes());
}

pub fn encode(package: EmbeddedPackage<'_>) -> Result<Vec<u8>, EncodeError> {
    if package.target.is_empty()
        || package.target.len() > POCKET_TARGET_MAX_BYTES
        || package.target.contains('\0')
    {
        return Err(EncodeError::InvalidTarget);
    }
    let code = package.code.strip_suffix(&[0]).unwrap_or(package.code);
    if code.contains(&0) {
        return Err(EncodeError::InvalidJavaScript);
    }
    let javascript_length = code.len().checked_add(1).ok_or(EncodeError::TooLarge)?;
    let sections = [package.identity, package.plan, code, package.pak];
    let lengths = [
        package.identity.len(),
        package.plan.len(),
        javascript_length,
        package.pak.len(),
    ];
    let table = align(POCKET_HEADER_SIZE)?;
    let strings = table + POCKET_VARIANT_SIZE;
    let directory = align(strings + package.target.len())?;
    let mut cursor = align(directory + sections.len() * POCKET_SECTION_SIZE)?;
    let mut offsets = [0usize; 4];
    for (offset, size) in offsets.iter_mut().zip(lengths) {
        *offset = cursor;
        cursor = align(cursor.checked_add(size).ok_or(EncodeError::TooLarge)?)?;
    }
    let length = cursor
        .checked_add(POCKET_FOOTER_SIZE)
        .filter(|&n| n <= u32::MAX as usize)
        .ok_or(EncodeError::TooLarge)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| EncodeError::NoMemory)?;
    bytes.resize(length, 0);
    write32(&mut bytes, 0, POCKET_MAGIC as usize);
    write32(&mut bytes, 4, POCKET_VERSION as usize);
    write32(&mut bytes, OFFSET_HEADER_VARIANT_COUNT, 1);
    write32(&mut bytes, OFFSET_HEADER_STRING_TABLE_OFFSET, strings);
    write32(
        &mut bytes,
        OFFSET_HEADER_STRING_TABLE_SIZE,
        package.target.len(),
    );
    write32(&mut bytes, table + OFFSET_VARIANT_TARGET_OFFSET, strings);
    write32(
        &mut bytes,
        table + OFFSET_VARIANT_TARGET_SIZE,
        package.target.len(),
    );
    bytes[strings..strings + package.target.len()].copy_from_slice(package.target.as_bytes());
    bytes[table + OFFSET_VARIANT_PROFILE_HASH..table + OFFSET_VARIANT_PROFILE_HASH + 32]
        .copy_from_slice(&package.profile_hash);
    write32(
        &mut bytes,
        table + OFFSET_VARIANT_HOST_ABI,
        package.host_abi as usize,
    );
    write32(
        &mut bytes,
        table + OFFSET_VARIANT_SECTION_COUNT,
        sections.len(),
    );
    write32(
        &mut bytes,
        table + OFFSET_VARIANT_SECTIONS_OFFSET,
        directory,
    );
    // Hash the terminator as part of JavaScript without allocating a second
    // script buffer. The zero-filled output already contains that byte.
    let hash = fnv1a64(&[package.identity, package.plan, code, &[0], package.pak]);
    bytes[table + OFFSET_VARIANT_HASH..table + OFFSET_VARIANT_HASH + 8]
        .copy_from_slice(&hash.to_le_bytes());
    for (i, ((kind, section), offset)) in [SECTION_IDENTITY, SECTION_PLAN, SECTION_JS, SECTION_PAK]
        .into_iter()
        .zip(sections)
        .zip(offsets)
        .enumerate()
    {
        let entry = directory + i * POCKET_SECTION_SIZE;
        write32(&mut bytes, entry + OFFSET_SECTION_KIND, kind as usize);
        write32(&mut bytes, entry + OFFSET_SECTION_OFFSET, offset);
        write32(&mut bytes, entry + OFFSET_SECTION_SIZE, lengths[i]);
        bytes[offset..offset + section.len()].copy_from_slice(section);
    }
    let hash = fnv1a64(&[&bytes[..cursor]]);
    bytes[cursor..].copy_from_slice(&hash.to_le_bytes());
    Ok(bytes)
}

/// One variant of `target` holding `sections`, given in strictly increasing
/// kind order with their payloads as stored, for fixtures and tools. The
/// layout is `encode`'s with any section set.
pub fn encode_sections(
    target: &str,
    host_abi: u32,
    profile_hash: [u8; 32],
    sections: &[(u32, &[u8])],
) -> Result<Vec<u8>, EncodeError> {
    if target.is_empty() || target.len() > POCKET_TARGET_MAX_BYTES || target.contains('\0') {
        return Err(EncodeError::InvalidTarget);
    }
    if sections.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
        return Err(EncodeError::InvalidSections);
    }
    let table = align(POCKET_HEADER_SIZE)?;
    let strings = table + POCKET_VARIANT_SIZE;
    let directory = align(strings + target.len())?;
    let mut cursor = align(directory + sections.len() * POCKET_SECTION_SIZE)?;
    let mut offsets = Vec::new();
    offsets
        .try_reserve_exact(sections.len())
        .map_err(|_| EncodeError::NoMemory)?;
    for (_, payload) in sections {
        offsets.push(cursor);
        cursor = align(
            cursor
                .checked_add(payload.len())
                .ok_or(EncodeError::TooLarge)?,
        )?;
    }
    let length = cursor
        .checked_add(POCKET_FOOTER_SIZE)
        .filter(|&n| n <= u32::MAX as usize)
        .ok_or(EncodeError::TooLarge)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| EncodeError::NoMemory)?;
    bytes.resize(length, 0);
    write32(&mut bytes, 0, POCKET_MAGIC as usize);
    write32(&mut bytes, 4, POCKET_VERSION as usize);
    write32(&mut bytes, OFFSET_HEADER_VARIANT_COUNT, 1);
    write32(&mut bytes, OFFSET_HEADER_STRING_TABLE_OFFSET, strings);
    write32(&mut bytes, OFFSET_HEADER_STRING_TABLE_SIZE, target.len());
    write32(&mut bytes, table + OFFSET_VARIANT_TARGET_OFFSET, strings);
    write32(&mut bytes, table + OFFSET_VARIANT_TARGET_SIZE, target.len());
    bytes[strings..strings + target.len()].copy_from_slice(target.as_bytes());
    bytes[table + OFFSET_VARIANT_PROFILE_HASH..table + OFFSET_VARIANT_PROFILE_HASH + 32]
        .copy_from_slice(&profile_hash);
    write32(
        &mut bytes,
        table + OFFSET_VARIANT_HOST_ABI,
        host_abi as usize,
    );
    write32(
        &mut bytes,
        table + OFFSET_VARIANT_SECTION_COUNT,
        sections.len(),
    );
    write32(
        &mut bytes,
        table + OFFSET_VARIANT_SECTIONS_OFFSET,
        directory,
    );
    let mut payloads = Vec::new();
    payloads
        .try_reserve_exact(sections.len())
        .map_err(|_| EncodeError::NoMemory)?;
    payloads.extend(sections.iter().map(|(_, payload)| *payload));
    let hash = fnv1a64(&payloads);
    bytes[table + OFFSET_VARIANT_HASH..table + OFFSET_VARIANT_HASH + 8]
        .copy_from_slice(&hash.to_le_bytes());
    for (i, ((kind, payload), offset)) in sections.iter().zip(offsets).enumerate() {
        let entry = directory + i * POCKET_SECTION_SIZE;
        write32(&mut bytes, entry + OFFSET_SECTION_KIND, *kind as usize);
        write32(&mut bytes, entry + OFFSET_SECTION_OFFSET, offset);
        write32(&mut bytes, entry + OFFSET_SECTION_SIZE, payload.len());
        bytes[offset..offset + payload.len()].copy_from_slice(payload);
    }
    let hash = fnv1a64(&[&bytes[..cursor]]);
    bytes[cursor..].copy_from_slice(&hash.to_le_bytes());
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
                target: "web",
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
    fn target_uses_full_utf8_table_and_rejects_invalid_ids() {
        let identity = identity("fixture", "app", "App").unwrap();
        for target in [
            "a target beyond fifteen bytes",
            "\u{feff}设备-\u{1f680}",
            &"a".repeat(65535),
        ] {
            let bytes = encode(EmbeddedPackage {
                target,
                host_abi: 7,
                profile_hash: [0x55; 32],
                identity: &identity,
                plan: PLAN,
                code: b"test",
                pak: &[],
            })
            .unwrap();
            let parsed = crate::Package::parse(&bytes, false).unwrap();
            assert_eq!(parsed.variant(0).unwrap().target, target);
            assert_eq!(parsed.variant(0).unwrap().profile_hash, [0x55; 32]);
            let guest = crate::select_guest(&bytes, &host(7, [0x55; 32]), false).unwrap();
            assert_eq!(guest.target, target);
        }
        for target in ["", "nul\0id", &"a".repeat(65536)] {
            assert_eq!(
                encode(EmbeddedPackage {
                    target,
                    host_abi: 7,
                    profile_hash: [0; 32],
                    identity: &identity,
                    plan: b"{}",
                    code: b"test",
                    pak: &[]
                }),
                Err(EncodeError::InvalidTarget)
            );
        }
    }
}
