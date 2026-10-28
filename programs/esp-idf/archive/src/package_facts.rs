//! What a launcher program reads from a stored `.pocket` before it boots
//! it: the variant's sections, its hash and the facts of its plan. The
//! runtime admits the package again at boot; this call shares its reader.
use pocket_package::sha256::sha256_hex_prefix;
use pocket_package::{plan_facts, select_guest, GuestError, PackageError, PlanFactsError};

/// Borrowed sections of one verified `.pocket`; the caller keeps the bytes
/// alive while it reads them.
#[repr(C)]
pub struct PocketIdfPackageFacts {
    pub struct_size: usize,
    pub javascript: *const u8,
    pub javascript_length: usize,
    pub pak: *const u8,
    pub pak_length: usize,
    pub plan: *const u8,
    pub plan_length: usize,
    pub package_hash: u64,
    pub variant_hash: u64,
    pub view_width: u32,
    pub view_height: u32,
    pub raster_density: u32,
    /// Zero when the plan has no auxiliary surface.
    pub aux_width: u32,
    pub aux_height: u32,
    pub features: u32,
    /// The first 16 hex digits of SHA-256 of the app id, NUL-terminated: the
    /// application's slot below the store's apps directory.
    pub slot: [u8; 17],
}

/// `features.data.fs` is true in the plan.
pub const POCKET_IDF_FEATURE_FS: u32 = 1;
/// `features.camera.qr` is true in the plan.
pub const POCKET_IDF_FEATURE_CAMERA_QR: u32 = 2;
/// `features.camera.photo` is true in the plan.
pub const POCKET_IDF_FEATURE_CAMERA_PHOTO: u32 = 4;
/// `features.media.playback` is true in the plan.
pub const POCKET_IDF_FEATURE_MEDIA: u32 = 8;

fn package_error_code(error: GuestError) -> i32 {
    match error {
        GuestError::Package(PackageError::Truncated) => 1,
        GuestError::Package(PackageError::BadMagic) => 2,
        GuestError::Package(PackageError::BadVersion) => 3,
        GuestError::Package(PackageError::HashMismatch) => 4,
        GuestError::Package(PackageError::BadUtf8) => 5,
        GuestError::Package(PackageError::BadLayout) => 17,
        GuestError::ProfileHashMismatch => 16,
        GuestError::MissingVariant => 6,
        GuestError::HostAbiMismatch => 7,
        GuestError::MissingIdentity => 8,
        GuestError::MissingPlan => 9,
        GuestError::MissingJavaScript => 10,
        GuestError::JavaScriptNotTerminated => 11,
        GuestError::WorkerSectionMismatch => 18,
    }
}

/// Verify a complete `.pocket` for `target`, `host_abi` and the expected
/// profile identity, and read its facts. Returns 0 on success; the non-zero
/// codes are those of the 3DS product's `pocket_package_open` (12 is a bad
/// pointer, a short record or a non-UTF-8 target; 13 to 15 a plan whose
/// JSON, viewport or auxiliary surface cannot be read; 16 a profile
/// mismatch; 17 a malformed layout; 18 a worker declaration and section
/// that disagree).
///
/// # Safety
/// `bytes`, `target` and `expected_profile_hash` are readable for their
/// lengths (32 bytes for the hash) and `out` is writable for `struct_size`.
#[no_mangle]
pub unsafe extern "C" fn pocket_idf_package_open(
    bytes: *const u8,
    length: usize,
    target: *const u8,
    target_length: usize,
    host_abi: u32,
    expected_profile_hash: *const u8,
    out: *mut PocketIdfPackageFacts,
) -> i32 {
    if bytes.is_null()
        || length == 0
        || length > isize::MAX as usize
        || target.is_null()
        || target_length == 0
        || target_length > isize::MAX as usize
        || expected_profile_hash.is_null()
        || out.is_null()
        || unsafe { (*out).struct_size } < core::mem::size_of::<PocketIdfPackageFacts>()
    {
        return 12;
    }
    let target = match core::str::from_utf8(unsafe { core::slice::from_raw_parts(target, target_length) }) {
        Ok(value) if !value.is_empty() => value,
        _ => return 12,
    };
    let mut profile_hash = [0; 32];
    profile_hash.copy_from_slice(unsafe { core::slice::from_raw_parts(expected_profile_hash, 32) });
    let package = unsafe { core::slice::from_raw_parts(bytes, length) };
    let guest = match select_guest(package, target, host_abi, &profile_hash, false) {
        Ok(guest) => guest,
        Err(error) => return package_error_code(error),
    };
    if guest.id.is_empty() {
        return 8;
    }
    let facts = match plan_facts(guest.plan) {
        Ok(facts) => facts,
        Err(PlanFactsError::Malformed) => return 13,
        Err(PlanFactsError::Viewport) => return 14,
        Err(PlanFactsError::Auxiliary) => return 15,
    };
    let auxiliary = facts.auxiliary;
    let mut slot = [0u8; 17];
    slot[..16].copy_from_slice(&sha256_hex_prefix::<16>(guest.id.as_bytes()));
    let flag = |name: &str, bit: u32| if facts.feature(name) { bit } else { 0 };
    unsafe {
        out.write(PocketIdfPackageFacts {
            struct_size: core::mem::size_of::<PocketIdfPackageFacts>(),
            javascript: guest.js.as_ptr(),
            javascript_length: guest.js.len(),
            pak: guest.pak.as_ptr(),
            pak_length: guest.pak.len(),
            plan: guest.plan.as_ptr(),
            plan_length: guest.plan.len(),
            package_hash: guest.package_hash,
            variant_hash: guest.variant_hash,
            view_width: facts.viewport.width,
            view_height: facts.viewport.height,
            raster_density: facts.viewport.raster_density,
            aux_width: auxiliary.map_or(0, |surface| surface.width),
            aux_height: auxiliary.map_or(0, |surface| surface.height),
            features: flag("data.fs", POCKET_IDF_FEATURE_FS)
                | flag("camera.qr", POCKET_IDF_FEATURE_CAMERA_QR)
                | flag("camera.photo", POCKET_IDF_FEATURE_CAMERA_PHOTO)
                | flag("media.playback", POCKET_IDF_FEATURE_MEDIA),
            slot,
        });
    }
    0
}
