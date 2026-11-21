//! Package admission for the C inspection entry points: the program crate's
//! `pocket_native_package_open` and `pocket_native_package_open_source`, the
//! ESP-IDF archive's `pocket_idf_package_open` and
//! `pocket_idf_package_open_source`, and a product's own entry points such as
//! the 3DS product's `pocket_package_open`. They admit against the same
//! exported profile facts `pocket_runtime_create` copies, through the
//! admission path boot takes (`pocket_package::admit`), and return the
//! `POCKET_PACKAGE_OPEN_*` codes that `contracts/spec/runtime-abi.ts`
//! generates into `pocket_runtime.h` and `pocket_drivers::abi`.
//! [`open_package`] admits a bundle in caller-owned bytes; [`open_source`]
//! admits what a package source holds, a bundle or stated sections, without
//! taking it. Each entry point adds its own argument checks and output
//! record around them.
use core::ffi::c_void;

use pocket_drivers::abi::*;
use pocket_drivers::PackageSource;
use pocket_package::{
    admission::item, admit_bundle, plan_facts, source::LoadError, Guest, GuestError, PackageError,
    PlanFacts, PlanFactsError,
};

/// The `POCKET_PACKAGE_OPEN_*` code of an admission failure.
/// [`open_package`] adds `POCKET_PACKAGE_OPEN_BAD_ARGUMENT` for a bad
/// argument and the three `POCKET_PACKAGE_OPEN_PLAN_*` codes of [`plan_code`]
/// for a plan whose JSON, viewport or auxiliary surface cannot be read after
/// admission.
pub fn guest_error_code(error: GuestError) -> i32 {
    match error {
        GuestError::Package(PackageError::Truncated) => POCKET_PACKAGE_OPEN_TRUNCATED,
        GuestError::Package(PackageError::BadMagic) => POCKET_PACKAGE_OPEN_BAD_MAGIC,
        GuestError::Package(PackageError::BadVersion) => POCKET_PACKAGE_OPEN_BAD_VERSION,
        GuestError::Package(PackageError::HashMismatch) => POCKET_PACKAGE_OPEN_HASH_MISMATCH,
        GuestError::Package(PackageError::BadUtf8) => POCKET_PACKAGE_OPEN_BAD_UTF8,
        GuestError::MissingIdentity => POCKET_PACKAGE_OPEN_NO_IDENTITY,
        GuestError::MissingJavaScript => POCKET_PACKAGE_OPEN_NO_JAVASCRIPT,
        GuestError::JavaScriptNotTerminated => POCKET_PACKAGE_OPEN_JAVASCRIPT_NOT_TERMINATED,
        GuestError::Package(PackageError::BadLayout) => POCKET_PACKAGE_OPEN_BAD_LAYOUT,
        GuestError::WorkerSectionMismatch => POCKET_PACKAGE_OPEN_WORKER_SECTION,
        GuestError::BadBytecode => POCKET_PACKAGE_OPEN_BAD_BYTECODE,
        // The first failed admission item in check order.
        GuestError::NotAdmitted(mismatch) => match mismatch.first() {
            item::BINDING_GENERATION => POCKET_PACKAGE_OPEN_BINDING_GENERATION,
            item::PLAN => POCKET_PACKAGE_OPEN_PLAN,
            item::RASTER_DENSITY => POCKET_PACKAGE_OPEN_RASTER_DENSITY,
            item::ANIMATION => POCKET_PACKAGE_OPEN_ANIMATION,
            item::RATE => POCKET_PACKAGE_OPEN_RATE,
            item::VIEWPORT => POCKET_PACKAGE_OPEN_VIEWPORT,
            item::PRESENTATION => POCKET_PACKAGE_OPEN_PRESENTATION,
            item::CAPABILITY => POCKET_PACKAGE_OPEN_CAPABILITY,
            _ => POCKET_PACKAGE_OPEN_AUXILIARY,
        },
    }
}

/// The `POCKET_PACKAGE_OPEN_*` code of a failed source read or admission:
/// `SOURCE` when the source does not supply its length, sections or bytes.
pub fn load_error_code(error: LoadError) -> i32 {
    match error {
        LoadError::Admission(error) => guest_error_code(error),
        LoadError::Source(_)
        | LoadError::TooLarge
        | LoadError::NoMemory
        | LoadError::Truncated
        | LoadError::Changed => POCKET_PACKAGE_OPEN_SOURCE,
    }
}

/// The `POCKET_PACKAGE_OPEN_PLAN_*` code of a plan fact that cannot be read
/// after admission. The entry points return one table: a program without an
/// auxiliary surface reports `POCKET_PACKAGE_OPEN_PLAN_AUXILIARY` for a
/// damaged auxiliary block like the products that have one.
pub fn plan_code(error: PlanFactsError) -> i32 {
    match error {
        PlanFactsError::Malformed => POCKET_PACKAGE_OPEN_PLAN_JSON,
        PlanFactsError::Viewport => POCKET_PACKAGE_OPEN_PLAN_VIEWPORT,
        PlanFactsError::Auxiliary => POCKET_PACKAGE_OPEN_PLAN_AUXILIARY,
    }
}

/// The exported facts as admission reads them. The profile hash is
/// provenance (`pocket_package::admission`). Null facts are
/// `POCKET_PACKAGE_OPEN_BAD_ARGUMENT`.
///
/// # Safety
/// `facts` follows `pocket_runtime_create`'s profile contract and
/// `profile_hash` is null or readable for 32 bytes.
unsafe fn host(
    facts: *const PocketProfileFacts,
    profile_hash: *const u8,
) -> Result<(crate::Profile, [u8; 32]), i32> {
    let profile = unsafe { super::profile(facts) }.ok_or(POCKET_PACKAGE_OPEN_BAD_ARGUMENT)?;
    let mut hash = [0; 32];
    if !profile_hash.is_null() {
        hash.copy_from_slice(unsafe { core::slice::from_raw_parts(profile_hash, 32) });
    }
    Ok((profile, hash))
}

/// Admit a bundle in `bytes` against exported facts.
///
/// # Safety
/// As for [`host`].
pub unsafe fn admit<'a>(
    bytes: &'a [u8],
    facts: *const PocketProfileFacts,
    host_abi: u32,
    profile_hash: *const u8,
) -> Result<Guest<'a>, i32> {
    let (profile, hash) = unsafe { host(facts, profile_hash) }?;
    admit_bundle(bytes, &profile.host_facts(host_abi, hash), false).map_err(guest_error_code)
}

/// An admitted program and the facts of its plan: what every inspection
/// entry point reads before it fills its own output record.
pub struct OpenedPackage<'a> {
    pub guest: Guest<'a>,
    pub facts: PlanFacts<'a>,
}

/// The identity check and plan facts every entry point reads after
/// admission. An entry point that names per-application state after the app
/// id passes `require_identity`: an admitted program with an empty id is
/// then `POCKET_PACKAGE_OPEN_NO_IDENTITY`, checked before the plan facts.
fn opened(guest: Guest<'_>, require_identity: bool) -> Result<OpenedPackage<'_>, i32> {
    if require_identity && guest.id.is_empty() {
        return Err(POCKET_PACKAGE_OPEN_NO_IDENTITY);
    }
    let facts = plan_facts(guest.plan).map_err(plan_code)?;
    Ok(OpenedPackage { guest, facts })
}

/// Verify a complete bundle (footer and payload hashes included), admit its
/// plan against the exported profile facts, and read the plan's facts. A
/// null or empty byte span and null facts are
/// `POCKET_PACKAGE_OPEN_BAD_ARGUMENT`; an admission failure is its
/// `guest_error_code`; a plan fact that cannot be read is its `plan_code`.
///
/// # Safety
/// `bytes` is null or readable for `length` bytes that outlive the result;
/// `facts` and `profile_hash` are as for [`admit`].
pub unsafe fn open_package<'a>(
    bytes: *const u8,
    length: usize,
    facts: *const PocketProfileFacts,
    host_abi: u32,
    profile_hash: *const u8,
    require_identity: bool,
) -> Result<OpenedPackage<'a>, i32> {
    if bytes.is_null() || length == 0 || length > isize::MAX as usize || facts.is_null() {
        return Err(POCKET_PACKAGE_OPEN_BAD_ARGUMENT);
    }
    let bytes = unsafe { core::slice::from_raw_parts(bytes, length) };
    let guest = unsafe { admit(bytes, facts, host_abi, profile_hash) }?;
    opened(guest, require_identity)
}

/// Admit what `source` holds as boot does — a bundle, or the sections the
/// source states — without taking its storage, then read the plan's facts.
/// `read` receives the opened program and whether its slices borrow the
/// bytes the source's `all` returned, valid until the next call on the
/// source; otherwise they borrow a copy released when this returns. Null
/// facts are `POCKET_PACKAGE_OPEN_BAD_ARGUMENT`; a source that does not
/// supply its length, sections or bytes is `POCKET_PACKAGE_OPEN_SOURCE`;
/// the other codes are those of [`open_package`].
///
/// # Safety
/// `facts` and `profile_hash` are as for [`admit`].
pub unsafe fn open_source<R>(
    source: &mut dyn PackageSource,
    facts: *const PocketProfileFacts,
    host_abi: u32,
    profile_hash: *const u8,
    require_identity: bool,
    read: impl FnOnce(&OpenedPackage<'_>, bool) -> R,
) -> Result<R, i32> {
    if facts.is_null() {
        return Err(POCKET_PACKAGE_OPEN_BAD_ARGUMENT);
    }
    let (profile, hash) = unsafe { host(facts, profile_hash) }?;
    let host = profile.host_facts(host_abi, hash);
    pocket_package::source::inspect(source, &host, usize::MAX, |guest, borrowed| {
        opened(*guest, require_identity).map(|opened| read(&opened, borrowed))
    })
    .map_err(load_error_code)?
}

/// [`open_source`] for a C `pocket_package_source_v1` and its context. A
/// null or short table, or one without `length` and `range`, is
/// `POCKET_PACKAGE_OPEN_BAD_ARGUMENT`.
///
/// # Safety
/// `table` and `context` obey the C package source contract;
/// `facts` and `profile_hash` are as for [`admit`].
pub unsafe fn open_c_source<R>(
    table: *const PocketPackageSourceV1,
    context: *mut c_void,
    facts: *const PocketProfileFacts,
    host_abi: u32,
    profile_hash: *const u8,
    require_identity: bool,
    read: impl FnOnce(&OpenedPackage<'_>, bool) -> R,
) -> Result<R, i32> {
    let mut source = unsafe { CPackageSource::new(table, context) }
        .map_err(|_| POCKET_PACKAGE_OPEN_BAD_ARGUMENT)?;
    unsafe {
        open_source(
            &mut source,
            facts,
            host_abi,
            profile_hash,
            require_identity,
            read,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;
    use pocket_drivers::{PackageSections, SourceError};
    use pocket_package::source::MemorySource;

    const PLAN: &[u8] = br#"{"animation":"composited","app":{"id":"dev.stated"},"features":{"input.buttons":true},"profile":{"tickHz":60},"viewport":{"logical":[480,272],"presentation":"native","rasterDensity":1}}"#;
    const ANONYMOUS: &[u8] = br#"{"animation":"composited","features":{},"profile":{"tickHz":60},"viewport":{"logical":[480,272],"presentation":"native","rasterDensity":1}}"#;
    static LOGICAL: [u32; 2] = [480, 272];
    static CADENCES: [u32; 1] = [60];
    static HASH: [u8; 32] = [7; 32];

    fn display() -> PocketProfileDisplay {
        PocketProfileDisplay {
            physical: LOGICAL,
            logical: LOGICAL.as_ptr(),
            logical_count: 1,
            raster_density: 1,
            ..PocketProfileDisplay::empty()
        }
    }
    /// Facts that admit PLAN.
    fn facts(display: &PocketProfileDisplay) -> PocketProfileFacts {
        PocketProfileFacts {
            id: b"fixture".as_ptr(),
            id_length: 7,
            tick_hz: 60,
            display,
            cadences: CADENCES.as_ptr(),
            cadence_count: 1,
            capabilities: c"input.buttons".as_ptr().cast(),
            capabilities_length: 14,
            presentations: c"native".as_ptr().cast(),
            presentations_length: 7,
            animation: b"composited".as_ptr(),
            animation_length: 10,
            ..PocketProfileFacts::empty()
        }
    }
    fn bundle() -> Vec<u8> {
        let identity = pocket_package::embedded::identity("app", "dev.bundle", "App").unwrap();
        pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
            host_abi: pocket_spec::BINDING_GENERATION,
            profile_hash: HASH,
            identity: &identity,
            plan: PLAN,
            code: b"globalThis.frame=()=>{}",
            pak: b"pak",
        })
        .unwrap()
    }
    /// The plan and the JavaScript in a container of the host's own.
    struct Stated {
        bytes: Vec<u8>,
        sections: PackageSections,
        fail: bool,
    }
    fn stated(plan: &[u8]) -> Stated {
        let mut bytes = b"HOSTBOX\x01globalThis.frame=()=>{}\0".to_vec();
        let js = 8..bytes.len();
        bytes.extend_from_slice(plan);
        let sections = PackageSections {
            host_abi: pocket_spec::BINDING_GENERATION,
            plan: js.end..bytes.len(),
            js: Some(js),
            pak: None,
            bytecode: None,
            worker_js: None,
            worker_bytecode: None,
        };
        Stated {
            bytes,
            sections,
            fail: false,
        }
    }
    impl PackageSource for Stated {
        fn length(&self) -> Result<usize, pocket_drivers::SourceError> {
            if self.fail {
                return Err(SourceError::Failed);
            }
            Ok(self.bytes.len())
        }
        fn sections(&mut self) -> Result<Option<PackageSections>, SourceError> {
            Ok(Some(self.sections.clone()))
        }
        fn range(&mut self, offset: usize, buffer: &mut [u8]) -> Result<usize, SourceError> {
            let rest = self.bytes.get(offset..).ok_or(SourceError::OutOfBounds)?;
            let count = rest.len().min(buffer.len());
            buffer[..count].copy_from_slice(&rest[..count]);
            Ok(count)
        }
    }
    type Summary = (usize, *const u8, u64, bool);
    fn summary(opened: &OpenedPackage<'_>, borrowed: bool) -> Summary {
        (
            opened.guest.id.len(),
            opened.guest.js.as_ptr(),
            opened.guest.package_hash,
            borrowed,
        )
    }

    #[test]
    fn bytes_and_sources_open_through_one_admission_path() {
        let display = display();
        let facts = facts(&display);
        let generation = pocket_spec::BINDING_GENERATION;
        let hash = HASH.as_ptr();
        let bytes = bundle();
        let opened =
            unsafe { open_package(bytes.as_ptr(), bytes.len(), &facts, generation, hash, true) }
                .ok()
                .unwrap();
        assert_eq!(opened.guest.id, "dev.bundle");
        assert_eq!(opened.facts.viewport.width, 480);
        // The bundle through a source with contiguous storage borrows it.
        let read = unsafe {
            open_source(
                &mut MemorySource(&bytes),
                &facts,
                generation,
                hash,
                true,
                summary,
            )
        }
        .unwrap();
        assert_eq!(
            read,
            (
                10,
                opened.guest.js.as_ptr(),
                opened.guest.package_hash,
                true
            )
        );
        // Stated sections: the plan's app.id names the application.
        let read =
            unsafe { open_source(&mut stated(PLAN), &facts, generation, hash, true, summary) }
                .unwrap();
        assert_eq!((read.0, read.2, read.3), (10, 0, false));
        // A stated plan without app.id has no identity for a slot.
        let anonymous = unsafe {
            open_source(
                &mut stated(ANONYMOUS),
                &facts,
                generation,
                hash,
                true,
                summary,
            )
        };
        assert_eq!(anonymous.err(), Some(POCKET_PACKAGE_OPEN_NO_IDENTITY));
        assert!(unsafe {
            open_source(
                &mut stated(ANONYMOUS),
                &facts,
                generation,
                hash,
                false,
                summary,
            )
        }
        .is_ok());
        // Admission items, source failures and bad arguments keep their codes.
        let mut drifted = stated(PLAN);
        drifted.sections.host_abi += 1;
        assert_eq!(
            unsafe { open_source(&mut drifted, &facts, generation, hash, true, summary) }.err(),
            Some(POCKET_PACKAGE_OPEN_BINDING_GENERATION)
        );
        let mut failing = stated(PLAN);
        failing.fail = true;
        assert_eq!(
            unsafe { open_source(&mut failing, &facts, generation, hash, true, summary) }.err(),
            Some(POCKET_PACKAGE_OPEN_SOURCE)
        );
        let null = core::ptr::null_mut();
        assert_eq!(
            unsafe {
                open_c_source(
                    core::ptr::null(),
                    null,
                    &facts,
                    generation,
                    hash,
                    true,
                    summary,
                )
            }
            .err(),
            Some(POCKET_PACKAGE_OPEN_BAD_ARGUMENT)
        );
        let no_facts = core::ptr::null();
        assert_eq!(
            unsafe { open_source(&mut stated(PLAN), no_facts, generation, hash, true, summary) }
                .err(),
            Some(POCKET_PACKAGE_OPEN_BAD_ARGUMENT)
        );
    }
}
