//! Package admission for the C inspection entry points (`pocket_ui_package_open`,
//! the 3DS product's `pocket_package_open`, the ESP-IDF launcher's
//! `pocket_idf_package_open`). They admit against the same exported profile
//! facts `pocket_runtime_create` copies, and report stable status codes.
use crate::abi::PocketProfileFacts;
use pocket_runtime::pocket_package::{
    admission::item, select_guest, Guest, GuestError, PackageError,
};

/// Status codes of the package inspection entry points. 12 is a bad
/// argument; 13 to 15 a plan whose JSON, viewport or auxiliary surface
/// cannot be read after admission.
pub fn guest_error_code(error: GuestError) -> i32 {
    match error {
        GuestError::Package(PackageError::Truncated) => 1,
        GuestError::Package(PackageError::BadMagic) => 2,
        GuestError::Package(PackageError::BadVersion) => 3,
        GuestError::Package(PackageError::HashMismatch) => 4,
        GuestError::Package(PackageError::BadUtf8) => 5,
        GuestError::MissingVariant => 6,
        GuestError::MissingIdentity => 8,
        GuestError::MissingJavaScript => 10,
        GuestError::JavaScriptNotTerminated => 11,
        GuestError::Package(PackageError::BadLayout) => 17,
        GuestError::WorkerSectionMismatch => 18,
        GuestError::BadBytecode => 26,
        GuestError::NotAdmitted(mismatch) => match mismatch.first() {
            item::BINDING_GENERATION => 7,
            item::PLAN => 9,
            item::RASTER_DENSITY => 19,
            item::ANIMATION => 20,
            item::RATE => 21,
            item::VIEWPORT => 22,
            item::PRESENTATION => 23,
            item::CAPABILITY => 24,
            _ => 25,
        },
    }
}

/// Admit `bytes` against exported facts. The profile hash only orders
/// variants (`pocket_package::admission`).
/// # Safety
/// `facts` follows `pocket_runtime_create`'s profile contract and
/// `profile_hash` is null or readable for 32 bytes.
pub unsafe fn admit<'a>(
    bytes: &'a [u8],
    facts: *const PocketProfileFacts,
    host_abi: u32,
    profile_hash: *const u8,
) -> Result<Guest<'a>, i32> {
    let profile = unsafe { crate::runtime::profile(facts) }.ok_or(12)?;
    let mut hash = [0; 32];
    if !profile_hash.is_null() {
        hash.copy_from_slice(unsafe { core::slice::from_raw_parts(profile_hash, 32) });
    }
    select_guest(bytes, &profile.host_facts(host_abi, hash), false).map_err(guest_error_code)
}
