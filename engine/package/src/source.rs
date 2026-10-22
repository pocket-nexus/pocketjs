//! Source-independent admission with stable package storage.
//!
//! `PackageSource::all` can expire at the next mutable source call. Copying it
//! once keeps script buffers and asset slices alive through guest shutdown.
//! Explicitly transferred owned storage and immutable static storage need no
//! copy. Both use the same parser, hashes, and admission checks.
//! Range sources use the same parser and admission rules as embedded sources.

use crate::{select_guest, GuestError};
use alloc::{boxed::Box, vec::Vec};
use core::ops::Range;
use pocket_drivers::{PackageBytes, PackageSource, SourceError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadError {
    Source(SourceError),
    TooLarge,
    NoMemory,
    Truncated,
    Changed,
    Admission(GuestError),
}

pub struct LoadedPackage {
    bytes: PackageBytes,
    js: Range<usize>,
    pak: Range<usize>,
    plan: Range<usize>,
    pub package_hash: u64,
    pub variant_hash: u64,
}

impl LoadedPackage {
    /// The expected hash comes from the program profile exported at build
    /// time, never from this source or a selected package variant.
    /// `take_bytes` runs before admission. A source that transfers ownership
    /// is consumed even when admission fails; retry with a new owned source.
    pub fn load(
        source: &mut dyn PackageSource,
        target: &str,
        host_abi: u32,
        expected_profile_hash: &[u8; 32],
        byte_limit: usize,
    ) -> Result<Self, LoadError> {
        let length = source.length().map_err(LoadError::Source)?;
        if length > byte_limit || length > isize::MAX as usize {
            return Err(LoadError::TooLarge);
        }
        match source.take_bytes() {
            Ok(bytes) => {
                if bytes.as_ref().len() != length {
                    return Err(LoadError::Changed);
                }
                return Self::from_storage(bytes, target, host_abi, expected_profile_hash);
            }
            Err(SourceError::Unsupported) => {}
            Err(error) => return Err(LoadError::Source(error)),
        }
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(length)
            .map_err(|_| LoadError::NoMemory)?;
        match source.all() {
            Ok(all) => {
                if all.len() != length {
                    return Err(LoadError::Changed);
                }
                bytes.extend_from_slice(all);
            }
            Err(SourceError::Unsupported) => {
                bytes.resize(length, 0);
                let mut at = 0;
                while at < length {
                    let count = source
                        .range(at, &mut bytes[at..])
                        .map_err(LoadError::Source)?;
                    if count == 0 {
                        return Err(LoadError::Truncated);
                    }
                    if count > length - at {
                        return Err(LoadError::Changed);
                    }
                    at += count;
                }
            }
            Err(error) => return Err(LoadError::Source(error)),
        }
        // Never trust embedding as a reason to skip the footer check. All
        // sources pass through the same admission path.
        Self::from_bytes(
            bytes.into_boxed_slice(),
            target,
            host_abi,
            expected_profile_hash,
        )
    }

    pub fn from_bytes(
        bytes: Box<[u8]>,
        target: &str,
        host_abi: u32,
        expected_profile_hash: &[u8; 32],
    ) -> Result<Self, LoadError> {
        Self::from_storage(
            PackageBytes::Owned(bytes),
            target,
            host_abi,
            expected_profile_hash,
        )
    }

    fn from_storage(
        bytes: PackageBytes,
        target: &str,
        host_abi: u32,
        expected_profile_hash: &[u8; 32],
    ) -> Result<Self, LoadError> {
        let guest = select_guest(
            bytes.as_ref(),
            target,
            host_abi,
            expected_profile_hash,
            false,
        )
        .map_err(LoadError::Admission)?;
        let range = |part: &[u8]| {
            if part.is_empty() {
                return 0..0;
            }
            let offset = part.as_ptr() as usize - bytes.as_ref().as_ptr() as usize;
            offset..offset + part.len()
        };
        let (js, pak, plan) = (range(guest.js), range(guest.pak), range(guest.plan));
        let (package_hash, variant_hash) = (guest.package_hash, guest.variant_hash);
        Ok(Self {
            bytes,
            js,
            pak,
            plan,
            package_hash,
            variant_hash,
        })
    }
    pub fn bytes(&self) -> &[u8] {
        self.bytes.as_ref()
    }
    pub fn javascript(&self) -> &[u8] {
        &self.bytes.as_ref()[self.js.clone()]
    }
    pub fn pak(&self) -> &[u8] {
        &self.bytes.as_ref()[self.pak.clone()]
    }
    pub fn plan(&self) -> &[u8] {
        &self.bytes.as_ref()[self.plan.clone()]
    }
}

/// A source that transfers its allocation before admission. It cannot be read
/// after transfer, including when admission fails. Use `MemorySource` when the
/// caller needs to retain bytes.
pub struct OwnedMemorySource(Option<Box<[u8]>>);
impl OwnedMemorySource {
    pub fn new(bytes: impl Into<Box<[u8]>>) -> Self {
        Self(Some(bytes.into()))
    }
    fn bytes(&self) -> Result<&[u8], SourceError> {
        self.0.as_deref().ok_or(SourceError::Failed)
    }
}
impl PackageSource for OwnedMemorySource {
    fn length(&self) -> Result<usize, SourceError> {
        self.bytes().map(<[u8]>::len)
    }
    fn take_bytes(&mut self) -> Result<PackageBytes, SourceError> {
        self.0
            .take()
            .map(PackageBytes::Owned)
            .ok_or(SourceError::Failed)
    }
    fn all(&mut self) -> Result<&[u8], SourceError> {
        self.bytes()
    }
    fn range(&mut self, offset: usize, buffer: &mut [u8]) -> Result<usize, SourceError> {
        copy_range(self.bytes()?, offset, buffer)
    }
}

/// Immutable bytes linked into the program. The type carries the lifetime
/// required to retain the package after dropping this source.
pub struct StaticMemorySource(pub &'static [u8]);
impl PackageSource for StaticMemorySource {
    fn length(&self) -> Result<usize, SourceError> {
        Ok(self.0.len())
    }
    fn take_bytes(&mut self) -> Result<PackageBytes, SourceError> {
        Ok(PackageBytes::Static(self.0))
    }
    fn all(&mut self) -> Result<&[u8], SourceError> {
        Ok(self.0)
    }
    fn range(&mut self, offset: usize, buffer: &mut [u8]) -> Result<usize, SourceError> {
        copy_range(self.0, offset, buffer)
    }
}

fn copy_range(bytes: &[u8], offset: usize, buffer: &mut [u8]) -> Result<usize, SourceError> {
    let remaining = bytes.get(offset..).ok_or(SourceError::OutOfBounds)?;
    let length = remaining.len().min(buffer.len());
    buffer[..length].copy_from_slice(&remaining[..length]);
    Ok(length)
}

/// An embedded or caller-owned memory source; no I/O implementation is needed.
pub struct MemorySource<B>(pub B);
impl<B: AsRef<[u8]>> PackageSource for MemorySource<B> {
    fn length(&self) -> Result<usize, SourceError> {
        Ok(self.0.as_ref().len())
    }
    fn all(&mut self) -> Result<&[u8], SourceError> {
        Ok(self.0.as_ref())
    }
    fn range(&mut self, offset: usize, buffer: &mut [u8]) -> Result<usize, SourceError> {
        copy_range(self.0.as_ref(), offset, buffer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIXTURE: &[u8] = include_bytes!("../tests/fixtures/synthetic.pocket");
    struct ShortReads;
    impl PackageSource for ShortReads {
        fn length(&self) -> Result<usize, SourceError> {
            Ok(FIXTURE.len())
        }
        fn range(&mut self, offset: usize, output: &mut [u8]) -> Result<usize, SourceError> {
            let count = output.len().min(7).min(FIXTURE.len() - offset);
            output[..count].copy_from_slice(&FIXTURE[offset..offset + count]);
            Ok(count)
        }
    }
    #[test]
    fn memory_and_short_range_reads_have_identical_admission() {
        let memory = LoadedPackage::load(
            &mut MemorySource(FIXTURE),
            "psp",
            1,
            &[0x11; 32],
            FIXTURE.len(),
        )
        .unwrap();
        let ranges =
            LoadedPackage::load(&mut ShortReads, "psp", 1, &[0x11; 32], FIXTURE.len()).unwrap();
        assert_eq!(memory.bytes(), ranges.bytes());
        assert_eq!(memory.javascript(), ranges.javascript());
        assert_eq!(memory.pak(), ranges.pak());
        assert!(matches!(
            LoadedPackage::load(&mut ShortReads, "psp", 1, &[0x11; 32], FIXTURE.len() - 1),
            Err(LoadError::TooLarge)
        ));
    }
    #[test]
    fn owned_package_survives_source_mutation() {
        let mut source = MemorySource(FIXTURE.to_vec());
        let package = LoadedPackage::load(&mut source, "psp", 1, &[0x11; 32], usize::MAX).unwrap();
        source.0.fill(0);
        assert_eq!(package.bytes(), FIXTURE);
    }
    #[test]
    fn transferred_and_static_storage_keep_their_original_address() {
        let bytes = FIXTURE.to_vec().into_boxed_slice();
        let address = bytes.as_ptr();
        let mut source = OwnedMemorySource::new(bytes);
        // The budget is checked before consuming an owned source.
        assert!(matches!(
            LoadedPackage::load(&mut source, "psp", 1, &[0x11; 32], FIXTURE.len() - 1),
            Err(LoadError::TooLarge)
        ));
        assert_eq!(source.all().unwrap().as_ptr(), address);
        let owned = LoadedPackage::load(&mut source, "psp", 1, &[0x11; 32], FIXTURE.len()).unwrap();
        assert_eq!(source.length(), Err(SourceError::Failed));
        assert!(matches!(
            LoadedPackage::load(&mut source, "psp", 1, &[0x11; 32], FIXTURE.len()),
            Err(LoadError::Source(SourceError::Failed))
        ));
        drop(source);
        assert_eq!(owned.bytes().as_ptr(), address);
        assert_eq!(owned.bytes(), FIXTURE);

        let mut source = StaticMemorySource(FIXTURE);
        assert!(matches!(
            LoadedPackage::load(&mut source, "psp", 1, &[0x11; 32], FIXTURE.len() - 1),
            Err(LoadError::TooLarge)
        ));
        let static_package =
            LoadedPackage::load(&mut source, "psp", 1, &[0x11; 32], FIXTURE.len()).unwrap();
        assert_eq!(static_package.bytes().as_ptr(), FIXTURE.as_ptr());
        assert_eq!(static_package.javascript(), owned.javascript());
        assert_eq!(static_package.pak(), owned.pak());
        let again = LoadedPackage::load(&mut source, "psp", 1, &[0x11; 32], FIXTURE.len()).unwrap();
        assert_eq!(again.bytes().as_ptr(), static_package.bytes().as_ptr());
    }
    #[test]
    fn transferred_storage_has_the_same_admission_and_length_checks() {
        for (target, abi, hash) in [
            ("other", 1, [0x11; 32]),
            ("psp", 2, [0x11; 32]),
        ] {
            assert!(matches!(
                LoadedPackage::load(
                    &mut StaticMemorySource(FIXTURE),
                    target,
                    abi,
                    &hash,
                    FIXTURE.len()
                ),
                Err(LoadError::Admission(_))
            ));
            assert!(matches!(
                LoadedPackage::load(
                    &mut OwnedMemorySource::new(FIXTURE.to_vec()),
                    target,
                    abi,
                    &hash,
                    FIXTURE.len()
                ),
                Err(LoadError::Admission(_))
            ));
        }
        struct Changed;
        impl PackageSource for Changed {
            fn length(&self) -> Result<usize, SourceError> {
                Ok(FIXTURE.len() - 1)
            }
            fn take_bytes(&mut self) -> Result<PackageBytes, SourceError> {
                Ok(PackageBytes::Static(FIXTURE))
            }
            fn range(&mut self, _: usize, _: &mut [u8]) -> Result<usize, SourceError> {
                panic!("must not fall back after transfer")
            }
        }
        assert!(matches!(
            LoadedPackage::load(&mut Changed, "psp", 1, &[0x11; 32], FIXTURE.len()),
            Err(LoadError::Changed)
        ));
    }
}
