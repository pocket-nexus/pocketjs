//! Source-independent admission with stable package storage.
//!
//! `PackageSource::all` can expire at the next mutable source call. Copying it
//! once keeps script buffers and asset slices alive through guest shutdown.
//! Explicitly transferred owned storage, immutable static storage and foreign
//! storage released through the package need no copy. All use the same
//! parser and admission checks; only transferred storage whose owner verified
//! it (`PackageSource::verified`) skips the hash pass.
//! Range sources use the same parser and admission rules as embedded sources.

use crate::{
    admission::{HostFacts, Timing},
    select_guest, GuestError,
};
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
    worker_js: Range<usize>,
    pak: Range<usize>,
    plan: Range<usize>,
    pub package_hash: u64,
    pub variant_hash: u64,
    /// The admitted variant's package rate and host cadence.
    pub timing: Timing,
}

impl LoadedPackage {
    /// The host facts come from the program profile exported at build time,
    /// never from this source or a package variant. `take_bytes` runs before
    /// admission. A source that transfers ownership is consumed even when
    /// admission fails; retry with a new owned source.
    pub fn load<S: AsRef<str>>(
        source: &mut dyn PackageSource,
        host: &HostFacts<'_, S>,
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
                return Self::from_storage(bytes, host, source.verified());
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
        // A copy is hashed whatever the source claims: only storage an owner
        // transfers and vouches for skips the footer check.
        Self::from_bytes(bytes.into_boxed_slice(), host)
    }

    pub fn from_bytes<S: AsRef<str>>(
        bytes: Box<[u8]>,
        host: &HostFacts<'_, S>,
    ) -> Result<Self, LoadError> {
        Self::from_storage(PackageBytes::Owned(bytes), host, false)
    }

    fn from_storage<S: AsRef<str>>(
        bytes: PackageBytes,
        host: &HostFacts<'_, S>,
        verified: bool,
    ) -> Result<Self, LoadError> {
        let guest = select_guest(bytes.as_ref(), host, verified).map_err(LoadError::Admission)?;
        let range = |part: &[u8]| {
            if part.is_empty() {
                return 0..0;
            }
            let offset = part.as_ptr() as usize - bytes.as_ref().as_ptr() as usize;
            offset..offset + part.len()
        };
        let (js, worker_js, pak, plan) = (
            range(guest.js),
            range(guest.worker_js),
            range(guest.pak),
            range(guest.plan),
        );
        let (package_hash, variant_hash, timing) =
            (guest.package_hash, guest.variant_hash, guest.timing);
        Ok(Self {
            bytes,
            js,
            worker_js,
            pak,
            plan,
            package_hash,
            variant_hash,
            timing,
        })
    }
    pub fn bytes(&self) -> &[u8] {
        self.bytes.as_ref()
    }
    pub fn javascript(&self) -> &[u8] {
        &self.bytes.as_ref()[self.js.clone()]
    }
    /// Section 8, the NUL-terminated worker bundle; empty for a plan
    /// without `domains.worker`.
    pub fn worker_javascript(&self) -> &[u8] {
        &self.bytes.as_ref()[self.worker_js.clone()]
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
    use pocket_drivers::PackageStorage;
    use std::sync::LazyLock;
    static FIXTURE_BYTES: LazyLock<std::vec::Vec<u8>> = LazyLock::new(|| {
        let identity = crate::embedded::identity("app", "test.app", "App").unwrap();
        crate::embedded::encode(crate::embedded::EmbeddedPackage {
            target: "psp",
            host_abi: 1,
            profile_hash: [0x11; 32],
            identity: &identity,
            plan: crate::admission::testing::PLAN,
            code: b"globalThis.frame=()=>{}",
            pak: b"pak",
        })
        .unwrap()
    });
    static FIXTURE_STATIC: LazyLock<&'static [u8]> =
        LazyLock::new(|| std::boxed::Box::leak(FIXTURE_BYTES.clone().into_boxed_slice()));
    fn fixture() -> &'static [u8] {
        &FIXTURE_STATIC
    }
    fn host(generation: u32) -> HostFacts<'static, &'static str> {
        crate::admission::testing::host(generation, [0x11; 32])
    }
    struct ShortReads;
    impl PackageSource for ShortReads {
        fn length(&self) -> Result<usize, SourceError> {
            Ok(fixture().len())
        }
        fn range(&mut self, offset: usize, output: &mut [u8]) -> Result<usize, SourceError> {
            let count = output.len().min(7).min(fixture().len() - offset);
            output[..count].copy_from_slice(&fixture()[offset..offset + count]);
            Ok(count)
        }
    }
    #[test]
    fn memory_and_short_range_reads_have_identical_admission() {
        let memory =
            LoadedPackage::load(&mut MemorySource(fixture()), &host(1), fixture().len()).unwrap();
        let ranges = LoadedPackage::load(&mut ShortReads, &host(1), fixture().len()).unwrap();
        assert_eq!(memory.bytes(), ranges.bytes());
        assert_eq!(memory.javascript(), ranges.javascript());
        assert_eq!(memory.pak(), ranges.pak());
        assert_eq!(
            memory.timing,
            Timing {
                tick_hz: 60,
                cadence_hz: 60
            }
        );
        assert!(matches!(
            LoadedPackage::load(&mut ShortReads, &host(1), fixture().len() - 1),
            Err(LoadError::TooLarge)
        ));
    }
    #[test]
    fn owned_package_survives_source_mutation() {
        let mut source = MemorySource(fixture().to_vec());
        let package = LoadedPackage::load(&mut source, &host(1), usize::MAX).unwrap();
        source.0.fill(0);
        assert_eq!(package.bytes(), fixture());
    }
    #[test]
    fn transferred_and_static_storage_keep_their_original_address() {
        let bytes = fixture().to_vec().into_boxed_slice();
        let address = bytes.as_ptr();
        let mut source = OwnedMemorySource::new(bytes);
        // The budget is checked before consuming an owned source.
        assert!(matches!(
            LoadedPackage::load(&mut source, &host(1), fixture().len() - 1),
            Err(LoadError::TooLarge)
        ));
        assert_eq!(source.all().unwrap().as_ptr(), address);
        let owned = LoadedPackage::load(&mut source, &host(1), fixture().len()).unwrap();
        assert_eq!(source.length(), Err(SourceError::Failed));
        assert!(matches!(
            LoadedPackage::load(&mut source, &host(1), fixture().len()),
            Err(LoadError::Source(SourceError::Failed))
        ));
        drop(source);
        assert_eq!(owned.bytes().as_ptr(), address);
        assert_eq!(owned.bytes(), fixture());

        let mut source = StaticMemorySource(fixture());
        assert!(matches!(
            LoadedPackage::load(&mut source, &host(1), fixture().len() - 1),
            Err(LoadError::TooLarge)
        ));
        let static_package = LoadedPackage::load(&mut source, &host(1), fixture().len()).unwrap();
        assert_eq!(static_package.bytes().as_ptr(), fixture().as_ptr());
        assert_eq!(static_package.javascript(), owned.javascript());
        assert_eq!(static_package.pak(), owned.pak());
        let again = LoadedPackage::load(&mut source, &host(1), fixture().len()).unwrap();
        assert_eq!(again.bytes().as_ptr(), static_package.bytes().as_ptr());
    }
    #[test]
    fn transferred_storage_has_the_same_admission_and_length_checks() {
        for facts in [
            host(2),
            HostFacts {
                raster_density: 2,
                ..host(1)
            },
        ] {
            assert!(matches!(
                LoadedPackage::load(&mut StaticMemorySource(fixture()), &facts, fixture().len()),
                Err(LoadError::Admission(_))
            ));
            assert!(matches!(
                LoadedPackage::load(
                    &mut OwnedMemorySource::new(fixture().to_vec()),
                    &facts,
                    fixture().len()
                ),
                Err(LoadError::Admission(_))
            ));
        }
        struct Changed;
        impl PackageSource for Changed {
            fn length(&self) -> Result<usize, SourceError> {
                Ok(fixture().len() - 1)
            }
            fn take_bytes(&mut self) -> Result<PackageBytes, SourceError> {
                Ok(PackageBytes::Static(fixture()))
            }
            fn range(&mut self, _: usize, _: &mut [u8]) -> Result<usize, SourceError> {
                panic!("must not fall back after transfer")
            }
        }
        assert!(matches!(
            LoadedPackage::load(&mut Changed, &host(1), fixture().len()),
            Err(LoadError::Changed)
        ));
    }
    #[test]
    fn verified_transfer_skips_the_hash_pass() {
        // The footer's last byte is wrong, so the hash pass refuses the bytes.
        static DAMAGED: LazyLock<&'static [u8]> = LazyLock::new(|| {
            let mut bytes = FIXTURE_BYTES.clone();
            let last = bytes.len() - 1;
            bytes[last] ^= 0xff;
            std::boxed::Box::leak(bytes.into_boxed_slice())
        });
        struct Transfer(bool);
        impl PackageSource for Transfer {
            fn length(&self) -> Result<usize, SourceError> {
                Ok(DAMAGED.len())
            }
            fn take_bytes(&mut self) -> Result<PackageBytes, SourceError> {
                Ok(PackageBytes::Static(&DAMAGED))
            }
            fn verified(&self) -> bool {
                self.0
            }
            fn range(&mut self, _: usize, _: &mut [u8]) -> Result<usize, SourceError> {
                panic!("must not fall back after transfer")
            }
        }
        assert!(matches!(
            LoadedPackage::load(&mut Transfer(false), &host(1), DAMAGED.len()),
            Err(LoadError::Admission(GuestError::Package(
                crate::PackageError::HashMismatch
            )))
        ));
        let intact = LoadedPackage::load(
            &mut StaticMemorySource(fixture()),
            &host(1),
            fixture().len(),
        )
        .unwrap();
        let package = LoadedPackage::load(&mut Transfer(true), &host(1), DAMAGED.len()).unwrap();
        assert_eq!(package.bytes().as_ptr(), DAMAGED.as_ptr());
        assert_eq!(package.javascript(), intact.javascript());
        assert_eq!(package.pak(), intact.pak());
        // A copy is hashed whatever the source claims.
        struct Copied;
        impl PackageSource for Copied {
            fn length(&self) -> Result<usize, SourceError> {
                Ok(DAMAGED.len())
            }
            fn all(&mut self) -> Result<&[u8], SourceError> {
                Ok(&DAMAGED)
            }
            fn verified(&self) -> bool {
                true
            }
            fn range(&mut self, offset: usize, buffer: &mut [u8]) -> Result<usize, SourceError> {
                copy_range(&DAMAGED, offset, buffer)
            }
        }
        assert!(matches!(
            LoadedPackage::load(&mut Copied, &host(1), DAMAGED.len()),
            Err(LoadError::Admission(GuestError::Package(
                crate::PackageError::HashMismatch
            )))
        ));
    }
    #[test]
    fn foreign_storage_is_released_once_when_the_package_drops() {
        use std::cell::Cell;
        use std::rc::Rc;
        struct Counted(&'static [u8], Rc<Cell<u32>>);
        impl PackageStorage for Counted {
            fn bytes(&self) -> &[u8] {
                self.0
            }
        }
        impl Drop for Counted {
            fn drop(&mut self) {
                self.1.set(self.1.get() + 1);
            }
        }
        struct Foreign(Rc<Cell<u32>>);
        impl PackageSource for Foreign {
            fn length(&self) -> Result<usize, SourceError> {
                Ok(fixture().len())
            }
            fn take_bytes(&mut self) -> Result<PackageBytes, SourceError> {
                Ok(PackageBytes::Foreign(Box::new(Counted(
                    fixture(),
                    self.0.clone(),
                ))))
            }
            fn range(&mut self, _: usize, _: &mut [u8]) -> Result<usize, SourceError> {
                panic!("must not fall back after transfer")
            }
        }
        let released = Rc::new(Cell::new(0));
        let package =
            LoadedPackage::load(&mut Foreign(released.clone()), &host(1), fixture().len()).unwrap();
        assert_eq!(package.bytes().as_ptr(), fixture().as_ptr());
        assert_eq!(released.get(), 0);
        drop(package);
        assert_eq!(released.get(), 1);
        // Storage transferred for a package that is not admitted is released too.
        assert!(matches!(
            LoadedPackage::load(&mut Foreign(released.clone()), &host(2), fixture().len()),
            Err(LoadError::Admission(_))
        ));
        assert_eq!(released.get(), 2);
    }
}
