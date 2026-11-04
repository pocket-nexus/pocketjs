//! Package admission for the C inspection entry points: the program crate's
//! `pocket_native_package_open`, the 3DS product's `pocket_package_open` and
//! the ESP-IDF archive's `pocket_idf_package_open`. They admit against the same
//! exported profile facts `pocket_runtime_create` copies, and return the
//! `POCKET_PACKAGE_OPEN_*` codes that `contracts/spec/runtime-abi.ts`
//! generates into `pocket_runtime.h` and `pocket_drivers::abi`. [`open_package`]
//! is the body the three entry points share; each adds its own argument checks
//! and output record around it.
use pocket_drivers::abi::*;
use pocket_package::{
    admission::item, plan_facts, select_guest, Guest, GuestError, PackageError, PlanFacts,
    PlanFactsError,
};

/// The `POCKET_PACKAGE_OPEN_*` code of a variant selection failure.
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
        GuestError::MissingVariant => POCKET_PACKAGE_OPEN_NO_VARIANT,
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

/// The `POCKET_PACKAGE_OPEN_PLAN_*` code of a plan fact that cannot be read
/// after admission. The three entry points return one table: a program
/// without an auxiliary surface reports `POCKET_PACKAGE_OPEN_PLAN_AUXILIARY`
/// for a damaged auxiliary block like the two products that have one.
pub fn plan_code(error: PlanFactsError) -> i32 {
    match error {
        PlanFactsError::Malformed => POCKET_PACKAGE_OPEN_PLAN_JSON,
        PlanFactsError::Viewport => POCKET_PACKAGE_OPEN_PLAN_VIEWPORT,
        PlanFactsError::Auxiliary => POCKET_PACKAGE_OPEN_PLAN_AUXILIARY,
    }
}

/// Admit `bytes` against exported facts. The profile hash only orders
/// variants (`pocket_package::admission`). Null facts are
/// `POCKET_PACKAGE_OPEN_BAD_ARGUMENT`.
/// # Safety
/// `facts` follows `pocket_runtime_create`'s profile contract and
/// `profile_hash` is null or readable for 32 bytes.
pub unsafe fn admit<'a>(
    bytes: &'a [u8],
    facts: *const PocketProfileFacts,
    host_abi: u32,
    profile_hash: *const u8,
) -> Result<Guest<'a>, i32> {
    let profile = unsafe { super::profile(facts) }.ok_or(POCKET_PACKAGE_OPEN_BAD_ARGUMENT)?;
    let mut hash = [0; 32];
    if !profile_hash.is_null() {
        hash.copy_from_slice(unsafe { core::slice::from_raw_parts(profile_hash, 32) });
    }
    select_guest(bytes, &profile.host_facts(host_abi, hash), false).map_err(guest_error_code)
}

/// An admitted variant and the facts of its plan: what every inspection entry
/// point reads before it fills its own output record.
pub struct OpenedPackage<'a> {
    pub guest: Guest<'a>,
    pub facts: PlanFacts<'a>,
}

/// Verify a complete `.pocket` (footer hash included), select the first
/// variant the exported profile facts admit, and read its plan facts. A null
/// or empty byte span and null facts are `POCKET_PACKAGE_OPEN_BAD_ARGUMENT`;
/// a selection failure is its `guest_error_code`; a plan fact that cannot be
/// read is its `plan_code`. An entry point that names per-application state
/// after the app id passes `require_identity`: an admitted variant with an
/// empty id is then `POCKET_PACKAGE_OPEN_NO_IDENTITY`, checked before the
/// plan facts.
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
    if require_identity && guest.id.is_empty() {
        return Err(POCKET_PACKAGE_OPEN_NO_IDENTITY);
    }
    let facts = plan_facts(guest.plan).map_err(plan_code)?;
    Ok(OpenedPackage { guest, facts })
}
