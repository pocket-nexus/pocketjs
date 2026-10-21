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
    TooLarge,
    NoMemory,
}

pub struct EmbeddedPackage<'a> {
    pub target: &'a str,
    pub host_abi: u32,
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
        || package.target.len() >= POCKET_TARGET_BYTES
        || package.target.contains('\0')
    {
        return Err(EncodeError::InvalidTarget);
    }
    let code = package.code.strip_suffix(&[0]).unwrap_or(package.code);
    if code.contains(&0) {
        return Err(EncodeError::InvalidJavaScript);
    }
    let mut javascript = Vec::new();
    javascript
        .try_reserve_exact(code.len().checked_add(1).ok_or(EncodeError::TooLarge)?)
        .map_err(|_| EncodeError::NoMemory)?;
    javascript.extend_from_slice(code);
    javascript.push(0);
    let sections = [
        package.identity,
        package.plan,
        javascript.as_slice(),
        package.pak,
    ];
    let table = align(POCKET_HEADER_SIZE)?;
    let directory = table + POCKET_VARIANT_SIZE;
    let mut cursor = align(directory + sections.len() * POCKET_SECTION_SIZE)?;
    let mut offsets = [0usize; 4];
    for (offset, section) in offsets.iter_mut().zip(sections) {
        *offset = cursor;
        cursor = align(
            cursor
                .checked_add(section.len())
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
    bytes[table..table + package.target.len()].copy_from_slice(package.target.as_bytes());
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
    let hash = fnv1a64(&sections);
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
        write32(&mut bytes, entry + OFFSET_SECTION_SIZE, section.len());
        bytes[offset..offset + section.len()].copy_from_slice(section);
    }
    let hash = fnv1a64(&[&bytes[..cursor]]);
    bytes[cursor..].copy_from_slice(&hash.to_le_bytes());
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{LoadedPackage, MemorySource};
    #[test]
    fn embedded_input_uses_normal_admission_and_keeps_one_terminator() {
        let identity = identity("test", "test.embedded", "Embedded").unwrap();
        let make = |code| {
            encode(EmbeddedPackage {
                target: "web",
                host_abi: 1,
                identity: &identity,
                plan: b"{}",
                code,
                pak: &[],
            })
        };
        let bytes = make(b"hello").unwrap();
        assert_eq!(bytes, make(b"hello\0").unwrap());
        assert_eq!(make(b"hello\0\0"), Err(EncodeError::InvalidJavaScript));
        let package =
            LoadedPackage::load(&mut MemorySource(&bytes), "web", 1, bytes.len()).unwrap();
        assert_eq!(package.javascript(), b"hello\0");
        assert!(LoadedPackage::load(&mut MemorySource(&bytes), "web", 2, bytes.len()).is_err());
        let mut damaged = bytes;
        damaged[0] ^= 1;
        assert!(LoadedPackage::load(&mut MemorySource(&damaged), "web", 1, damaged.len()).is_err());
    }
}
