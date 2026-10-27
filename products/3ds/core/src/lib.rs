//! One canonical runtime archive plus the 3DS package recovery inspection ABI.
//! The host composes C guest, PICA Renderer, Display and input drivers.
#![no_std]
extern crate alloc;
mod worker_section;
use pocket_package::sha256::sha256_hex_prefix;
use pocket_package::package::section;
use pocket_package::{plan_facts, select_guest, GuestError, Package, PackageError, PlanFactsError};
pub use pocket_runtime_cabi::*;

unsafe fn bytes<'a>(pointer: *const u8, length: usize) -> &'a [u8] {
    unsafe { core::slice::from_raw_parts(pointer, length) }
}
/// Borrowed sections of one verified filesystem `.pocket`. The C runtime owns
/// the package allocation and keeps it alive until the guest is torn down.
#[repr(C)]
pub struct PocketGuestPackage {
    pub javascript: *const u8,
    pub javascript_length: usize,
    pub worker_javascript: *const u8,
    pub worker_javascript_length: usize,
    pub pak: *const u8,
    pub pak_length: usize,
    pub plan: *const u8,
    pub plan_length: usize,
    pub package_hash: u64,
    pub variant_hash: u64,
    /// What the runtime takes from the variant's plan at boot instead of
    /// having it compiled in: the primary and auxiliary surfaces (auxiliary
    /// width and height are 0 when the plan has none) and
    /// POCKET_GUEST_FEATURE_* bits.
    pub view_width: u32,
    pub view_height: u32,
    pub raster_density: u32,
    pub aux_width: u32,
    pub aux_height: u32,
    pub aux_raster_density: u32,
    pub features: u32,
    /// The application's state directory name below runtime/apps: the first
    /// 16 hex digits of SHA-256(app id), NUL-terminated (tools/3ds.ts
    /// `runtimeSlot`).
    pub slot: [u8; 17],
}

/// `features.io.offload` is true in the plan.
pub const POCKET_GUEST_FEATURE_OFFLOAD: u32 = 1;
/// `features.media.playback` is true in the plan.
pub const POCKET_GUEST_FEATURE_MEDIA: u32 = 2;
/// `features.system.agent` is true in the plan: the top screen is the agent stage.
pub const POCKET_GUEST_FEATURE_AGENT: u32 = 4;
/// `features.data.fs` is true in the plan: the guest gets `globalThis.fs`.
pub const POCKET_GUEST_FEATURE_FS: u32 = 8;
/// `features.camera.qr` is true in the plan: the outer camera's viewfinder
/// with QR decoding.
pub const POCKET_GUEST_FEATURE_CAMERA_QR: u32 = 16;
/// `features.camera.photo` is true in the plan: both cameras, capture and
/// the photo store.
pub const POCKET_GUEST_FEATURE_CAMERA_PHOTO: u32 = 32;

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
    }
}

/// Verify a complete `.pocket` for an independent target/ABI/profile identity.
/// Returns 0 on success; non-zero codes are stable for the C runtime's status
/// and recovery files (12 is a bad pointer or non-UTF-8 target argument;
/// 13-15 a plan whose JSON, viewport or auxiliary surface cannot be read;
/// 16 a profile mismatch; 17 a malformed layout).
#[no_mangle]
pub unsafe extern "C" fn pocket_package_open(
    ptr: *const u8,
    len: usize,
    target_ptr: *const u8,
    target_len: usize,
    host_abi: u32,
    expected_profile_hash: *const u8,
    out: *mut PocketGuestPackage,
) -> i32 {
    if ptr.is_null()
        || len == 0
        || len > isize::MAX as usize
        || target_ptr.is_null()
        || target_len == 0
        || target_len > isize::MAX as usize
        || expected_profile_hash.is_null()
        || out.is_null()
    {
        return 12;
    }
    let target = match core::str::from_utf8(bytes(target_ptr, target_len)) {
        Ok(value) if !value.is_empty() => value,
        _ => return 12,
    };
    let mut profile_hash = [0; 32];
    profile_hash.copy_from_slice(bytes(expected_profile_hash, 32));
    let guest = match select_guest(bytes(ptr, len), target, host_abi, &profile_hash, false) {
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
    // select_guest has validated the package and profile. Read the append-only
    // worker section from the same verified variant without hashing it twice.
    let worker_declared = match pocket_package::plan_facts::worker_declared(guest.plan) {
        Ok(declared) => declared,
        Err(_) => return 18,
    };
    let worker = match Package::parse(bytes(ptr, len), true)
        .and_then(|package| package.find_variant(target))
        .and_then(|variant| variant.ok_or(PackageError::BadLayout))
        .and_then(|variant| variant.section(section::WORKER_JS)) {
        Ok(section) => match worker_section::select(worker_declared, section) {
            Ok(source) => source,
            Err(code) => return code,
        },
        Err(_) => return 17,
    };
    let auxiliary = facts.auxiliary;
    let mut slot = [0u8; 17];
    slot[..16].copy_from_slice(&sha256_hex_prefix::<16>(guest.id.as_bytes()));
    out.write(PocketGuestPackage {
        javascript: guest.js.as_ptr(),
        javascript_length: guest.js.len(),
        worker_javascript: worker.as_ptr(),
        worker_javascript_length: worker.len(),
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
        aux_raster_density: auxiliary.map_or(0, |surface| surface.raster_density),
        features: if facts.feature("io.offload") {
            POCKET_GUEST_FEATURE_OFFLOAD
        } else {
            0
        } | if facts.feature("media.playback") {
            POCKET_GUEST_FEATURE_MEDIA
        } else {
            0
        } | if facts.feature("system.agent") {
            POCKET_GUEST_FEATURE_AGENT
        } else {
            0
        } | if facts.feature("data.fs") {
            POCKET_GUEST_FEATURE_FS
        } else {
            0
        } | if facts.feature("camera.qr") {
            POCKET_GUEST_FEATURE_CAMERA_QR
        } else {
            0
        } | if facts.feature("camera.photo") {
            POCKET_GUEST_FEATURE_CAMERA_PHOTO
        } else {
            0
        },
        slot,
    });
    0
}
