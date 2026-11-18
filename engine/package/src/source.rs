//! Source-independent admission with stable package storage.
//!
//! `PackageSource::all` can expire at the next mutable source call. Copying it
//! once keeps script buffers and asset slices alive through guest shutdown.
//! Explicitly transferred owned storage, immutable static storage and foreign
//! storage released through the package need no copy. All use the same
//! admission path (`crate::bundle::admit`): a bundle is parsed and its hashes
//! checked, stated sections are read at their ranges; only transferred
//! storage whose owner verified it (`PackageSource::verified`) skips the hash
//! pass. Range sources use the same path as embedded sources.

use crate::{
    admission::{admit_plan, HostFacts, Timing},
    bundle::{admit_bundle, guest_sections, not_admitted, Guest},
    GuestError, PackageError,
};
use alloc::{boxed::Box, vec::Vec};
use core::ops::Range;
use pocket_drivers::{PackageBytes, PackageSections, PackageSource, SourceError};

/// Admit one program at ranges its host stated in `bytes`
/// (`PackageSource::sections`). The plan and code sections pass the checks
/// of `admit_bundle`; no container is parsed and no container hash is read.
/// The application id is the plan's `app.id`, empty when the plan has none.
pub fn admit_stated<'a, S: AsRef<str>>(
    bytes: &'a [u8],
    sections: &PackageSections,
    host: &HostFacts<'_, S>,
) -> Result<Guest<'a>, GuestError> {
    let layout = GuestError::Package(PackageError::BadLayout);
    let part = |range: &Range<usize>| bytes.get(range.clone()).ok_or(layout);
    let optional = |range: &Option<Range<usize>>| range.as_ref().map(part).transpose();
    let plan = part(&sections.plan)?;
    let timing = admit_plan(host, sections.host_abi, Some(plan)).map_err(not_admitted)?;
    let (js, worker_js, bytecode, worker_bytecode) = guest_sections(
        plan,
        optional(&sections.js)?,
        optional(&sections.bytecode)?,
        optional(&sections.worker_js)?,
        optional(&sections.worker_bytecode)?,
    )?;
    let pak = optional(&sections.pak)?.unwrap_or(&[]);
    Ok(Guest {
        id: crate::plan_facts::app_id(plan).unwrap_or(""),
        timing,
        js,
        worker_js,
        bytecode,
        worker_bytecode,
        pak,
        plan,
        package_hash: 0,
        payload_hash: 0,
    })
}

/// [`admit_stated`] when the source stated sections, `admit_bundle`
/// otherwise: the one admission path of every package source.
pub fn admit<'a, S: AsRef<str>>(
    bytes: &'a [u8],
    sections: Option<&PackageSections>,
    host: &HostFacts<'_, S>,
    skip_hash: bool,
) -> Result<Guest<'a>, GuestError> {
    match sections {
        Some(sections) => admit_stated(bytes, sections, host),
        None => admit_bundle(bytes, host, skip_hash),
    }
}

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
    bytecode: Option<Range<usize>>,
    worker_bytecode: Option<Range<usize>>,
    /// The bundle's footer hash; zero for a program whose source stated its
    /// sections (`PackageSource::sections`), where no bundle is read.
    pub package_hash: u64,
    /// The bundle's payload hash; zero like `package_hash`.
    pub payload_hash: u64,
    /// The application rate and the host cadence it runs at.
    pub timing: Timing,
}

/// The source's length, checked against `byte_limit`, and the sections it
/// states. A source that states its sections holds a container of the
/// host's own; one that states none holds a bundle.
fn prepare(
    source: &mut dyn PackageSource,
    byte_limit: usize,
) -> Result<(usize, Option<PackageSections>), LoadError> {
    let length = source.length().map_err(LoadError::Source)?;
    if length > byte_limit || length > isize::MAX as usize {
        return Err(LoadError::TooLarge);
    }
    let sections = source.sections().map_err(LoadError::Source)?;
    Ok((length, sections))
}

fn buffer(length: usize) -> Result<Vec<u8>, LoadError> {
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| LoadError::NoMemory)?;
    Ok(bytes)
}

/// All `length` bytes of a source without contiguous storage, through
/// `range`.
fn copy_ranges(source: &mut dyn PackageSource, length: usize) -> Result<Vec<u8>, LoadError> {
    let mut bytes = buffer(length)?;
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
    Ok(bytes)
}

/// Admit the program a source holds without keeping its bytes: the source's
/// length and stated sections, then its bytes through `all` or `range`, then
/// the admission of [`LoadedPackage::load`], hashes included. `inspect`
/// never calls `take_bytes`, so the source stays available for the load
/// that boots the program. `read` receives the admitted program and whether
/// its slices borrow the bytes the source's `all` returned (valid until the
/// next call on the source) rather than a copy dropped when `inspect`
/// returns.
pub fn inspect<S: AsRef<str>, R>(
    source: &mut dyn PackageSource,
    host: &HostFacts<'_, S>,
    byte_limit: usize,
    read: impl FnOnce(&Guest<'_>, bool) -> R,
) -> Result<R, LoadError> {
    let (length, sections) = prepare(source, byte_limit)?;
    match source.all() {
        Ok(all) => {
            if all.len() != length {
                return Err(LoadError::Changed);
            }
            let guest = admit(all, sections.as_ref(), host, false).map_err(LoadError::Admission)?;
            return Ok(read(&guest, true));
        }
        Err(SourceError::Unsupported) => {}
        Err(error) => return Err(LoadError::Source(error)),
    }
    let bytes = copy_ranges(source, length)?;
    let guest = admit(&bytes, sections.as_ref(), host, false).map_err(LoadError::Admission)?;
    Ok(read(&guest, false))
}

impl LoadedPackage {
    /// The host facts come from the program profile exported at build time,
    /// never from this source or the bundle. `take_bytes` runs before
    /// admission. A source that transfers ownership is consumed even when
    /// admission fails; retry with a new owned source.
    pub fn load<S: AsRef<str>>(
        source: &mut dyn PackageSource,
        host: &HostFacts<'_, S>,
        byte_limit: usize,
    ) -> Result<Self, LoadError> {
        let (length, sections) = prepare(source, byte_limit)?;
        match source.take_bytes() {
            Ok(bytes) => {
                if bytes.as_ref().len() != length {
                    return Err(LoadError::Changed);
                }
                return Self::from_storage(bytes, sections.as_ref(), host, source.verified());
            }
            Err(SourceError::Unsupported) => {}
            Err(error) => return Err(LoadError::Source(error)),
        }
        let bytes = match source.all() {
            Ok(all) => {
                if all.len() != length {
                    return Err(LoadError::Changed);
                }
                let mut bytes = buffer(length)?;
                bytes.extend_from_slice(all);
                bytes
            }
            Err(SourceError::Unsupported) => copy_ranges(source, length)?,
            Err(error) => return Err(LoadError::Source(error)),
        };
        // A copy is hashed whatever the source claims: only storage an owner
        // transfers and vouches for skips the footer check.
        Self::from_storage(
            PackageBytes::Owned(bytes.into_boxed_slice()),
            sections.as_ref(),
            host,
            false,
        )
    }

    /// Admit owned bundle bytes.
    pub fn from_bytes<S: AsRef<str>>(
        bytes: Box<[u8]>,
        host: &HostFacts<'_, S>,
    ) -> Result<Self, LoadError> {
        Self::from_storage(PackageBytes::Owned(bytes), None, host, false)
    }

    fn from_storage<S: AsRef<str>>(
        bytes: PackageBytes,
        sections: Option<&PackageSections>,
        host: &HostFacts<'_, S>,
        verified: bool,
    ) -> Result<Self, LoadError> {
        let guest =
            admit(bytes.as_ref(), sections, host, verified).map_err(LoadError::Admission)?;
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
        let (bytecode, worker_bytecode) =
            (guest.bytecode.map(range), guest.worker_bytecode.map(range));
        let (package_hash, payload_hash, timing) =
            (guest.package_hash, guest.payload_hash, guest.timing);
        Ok(Self {
            bytes,
            js,
            worker_js,
            pak,
            plan,
            bytecode,
            worker_bytecode,
            package_hash,
            payload_hash,
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
    /// Section 6, the UI bundle as a bytecode envelope (`crate::bytecode`),
    /// when the bundle carries one; `javascript` is then empty when the
    /// source was dropped in its favour.
    pub fn bytecode(&self) -> Option<&[u8]> {
        self.bytecode
            .clone()
            .map(|range| &self.bytes.as_ref()[range])
    }
    /// Section 9, the worker bundle as a bytecode envelope.
    pub fn worker_bytecode(&self) -> Option<&[u8]> {
        self.worker_bytecode
            .clone()
            .map(|range| &self.bytes.as_ref()[range])
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
    use crate::PackageError;
    use pocket_drivers::PackageStorage;
    use std::sync::LazyLock;
    static FIXTURE_BYTES: LazyLock<std::vec::Vec<u8>> = LazyLock::new(|| {
        let identity = crate::embedded::identity("app", "test.app", "App").unwrap();
        crate::embedded::encode(crate::embedded::EmbeddedPackage {
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

    /// A container of the host's own: eight bytes the loader never reads, then
    /// the pak, the bundle and the plan at offsets the source states.
    struct Sectioned {
        bytes: std::vec::Vec<u8>,
        sections: PackageSections,
        transfer: bool,
    }
    fn sectioned(js: &[u8]) -> Sectioned {
        let mut bytes = b"HOSTBOX\x01".to_vec();
        let mut put = |part: &[u8]| {
            let start = bytes.len();
            bytes.extend_from_slice(part);
            start..bytes.len()
        };
        let pak = put(b"pak");
        let js = put(js);
        let plan = put(crate::admission::testing::PLAN);
        Sectioned {
            bytes,
            sections: PackageSections {
                host_abi: 1,
                plan,
                js: Some(js),
                pak: Some(pak),
                bytecode: None,
                worker_js: None,
                worker_bytecode: None,
            },
            transfer: false,
        }
    }
    impl PackageSource for Sectioned {
        fn length(&self) -> Result<usize, SourceError> {
            Ok(self.bytes.len())
        }
        fn sections(&mut self) -> Result<Option<PackageSections>, SourceError> {
            Ok(Some(self.sections.clone()))
        }
        fn take_bytes(&mut self) -> Result<PackageBytes, SourceError> {
            if !self.transfer {
                return Err(SourceError::Unsupported);
            }
            Ok(PackageBytes::Owned(
                core::mem::take(&mut self.bytes).into_boxed_slice(),
            ))
        }
        fn range(&mut self, offset: usize, buffer: &mut [u8]) -> Result<usize, SourceError> {
            copy_range(&self.bytes, offset, buffer)
        }
    }
    const SECTION_JS: &[u8] = b"globalThis.frame=()=>{}\0";

    #[test]
    fn stated_sections_load_from_a_container_the_loader_never_parses() {
        let mut source = sectioned(SECTION_JS);
        // The bytes are no bundle.
        assert!(matches!(
            LoadedPackage::from_bytes(source.bytes.clone().into_boxed_slice(), &host(1)),
            Err(LoadError::Admission(GuestError::Package(
                PackageError::BadMagic
            )))
        ));
        for transfer in [false, true] {
            source.transfer = transfer;
            let address = source.bytes.as_ptr();
            let package = LoadedPackage::load(&mut source, &host(1), usize::MAX).unwrap();
            assert_eq!(package.javascript(), SECTION_JS);
            assert_eq!(package.pak(), b"pak");
            assert_eq!(package.plan(), crate::admission::testing::PLAN);
            assert_eq!(package.worker_javascript(), b"");
            assert_eq!(package.bytecode(), None);
            assert_eq!((package.package_hash, package.payload_hash), (0, 0));
            assert_eq!(
                package.timing,
                Timing {
                    tick_hz: 60,
                    cadence_hz: 60
                }
            );
            // Transferred storage is read in place.
            assert_eq!(package.bytes().as_ptr() == address, transfer);
            source = sectioned(SECTION_JS);
        }
    }

    #[test]
    fn stated_sections_pass_the_admission_and_section_checks_of_a_bundle() {
        // The plan is admitted against the host's facts.
        let mismatch = match LoadedPackage::load(&mut sectioned(SECTION_JS), &host(2), usize::MAX) {
            Err(LoadError::Admission(GuestError::NotAdmitted(mismatch))) => mismatch,
            _ => panic!("another binding generation must not be admitted"),
        };
        assert_eq!(mismatch.items, crate::admission::item::BINDING_GENERATION);
        // The bundle ends with NUL.
        assert!(matches!(
            LoadedPackage::load(
                &mut sectioned(b"globalThis.frame=()=>{}"),
                &host(1),
                usize::MAX
            ),
            Err(LoadError::Admission(GuestError::JavaScriptNotTerminated))
        ));
        // A program has a bundle or its bytecode.
        let mut source = sectioned(SECTION_JS);
        source.sections.js = None;
        assert!(matches!(
            LoadedPackage::load(&mut source, &host(1), usize::MAX),
            Err(LoadError::Admission(GuestError::MissingJavaScript))
        ));
        // A worker bundle needs the plan's worker declaration.
        let mut source = sectioned(SECTION_JS);
        source.sections.worker_js = source.sections.js.clone();
        assert!(matches!(
            LoadedPackage::load(&mut source, &host(1), usize::MAX),
            Err(LoadError::Admission(GuestError::WorkerSectionMismatch))
        ));
        // Every range lies inside the bytes.
        for pick in 0..3 {
            let mut source = sectioned(SECTION_JS);
            let end = source.bytes.len() + 1;
            match pick {
                0 => source.sections.plan.end = end,
                1 => source.sections.js = Some(0..end),
                _ => source.sections.pak = Some(end..end + 1),
            }
            assert!(matches!(
                LoadedPackage::load(&mut source, &host(1), usize::MAX),
                Err(LoadError::Admission(GuestError::Package(
                    PackageError::BadLayout
                )))
            ));
        }
    }

    #[test]
    fn stated_sections_take_the_application_id_from_the_plan() {
        let plan = br#"{"animation":"composited","app":{"id":"dev.stated","title":"S"},"features":{},"profile":{"tickHz":60},"viewport":{"logical":[480,272],"presentation":"native","rasterDensity":1}}"#;
        let mut bytes = SECTION_JS.to_vec();
        let js = 0..bytes.len();
        bytes.extend_from_slice(plan);
        let sections = PackageSections {
            host_abi: 1,
            plan: js.end..bytes.len(),
            js: Some(js),
            pak: None,
            bytecode: None,
            worker_js: None,
            worker_bytecode: None,
        };
        let guest = admit(&bytes, Some(&sections), &host(1), false).unwrap();
        assert_eq!(guest.id, "dev.stated");
        assert_eq!((guest.package_hash, guest.payload_hash), (0, 0));
    }

    #[test]
    fn inspection_admits_without_taking_the_source() {
        // A bundle, borrowed through `all` or copied through `range`.
        let read = |guest: &Guest<'_>, borrowed: bool| (guest.id.len(), guest.js.len(), borrowed);
        let mut memory = MemorySource(fixture());
        let borrowed = inspect(&mut memory, &host(1), usize::MAX, read).unwrap();
        assert_eq!(borrowed, (8, 24, true));
        assert_eq!(
            inspect(&mut ShortReads, &host(1), usize::MAX, read).unwrap(),
            (8, 24, false)
        );
        // An owned source is read, not consumed: it boots afterwards.
        let mut owned = OwnedMemorySource::new(fixture().to_vec());
        assert!(inspect(&mut owned, &host(1), usize::MAX, read).unwrap().2);
        assert!(LoadedPackage::load(&mut owned, &host(1), usize::MAX).is_ok());
        // Stated sections take the same path; their id is the plan's app.id.
        let mut source = sectioned(SECTION_JS);
        assert_eq!(
            inspect(&mut source, &host(1), usize::MAX, |guest, _| (
                guest.id.len(),
                guest.package_hash
            ))
            .unwrap(),
            (0, 0)
        );
        assert!(matches!(
            inspect(&mut sectioned(SECTION_JS), &host(2), usize::MAX, read),
            Err(LoadError::Admission(GuestError::NotAdmitted(_)))
        ));
        // A copy is hashed: inspection checks what boot checks.
        let mut damaged = fixture().to_vec();
        let last = damaged.len() - 1;
        damaged[last] ^= 0xff;
        assert!(matches!(
            inspect(&mut MemorySource(damaged), &host(1), usize::MAX, read),
            Err(LoadError::Admission(GuestError::Package(
                PackageError::HashMismatch
            )))
        ));
    }
}
