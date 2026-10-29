//! One canonical runtime archive plus the 3DS package recovery inspection ABI.
//! The host composes C guest, PICA Renderer, Display and input drivers.
#![no_std]
extern crate alloc;
use pocket_package::sha256::sha256_hex_prefix;
use pocket_package::{plan_facts, PlanFactsError};
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

/// Verify a complete `.pocket` and admit the first variant the exported
/// profile facts satisfy (`pocket_package::admission`). Returns 0 on success;
/// non-zero codes are stable for the C runtime's status and recovery files
/// (`pocket_runtime_cabi::package_open::guest_error_code`: 12 is a bad
/// pointer, 13-15 a plan whose JSON, viewport or auxiliary surface cannot be
/// read, 17 a malformed layout, 18 a worker declaration and section that
/// disagree, 19-25 the first failed admission item). The profile hash only
/// orders variants.
#[no_mangle]
pub unsafe extern "C" fn pocket_package_open(
    ptr: *const u8,
    len: usize,
    facts: *const abi::PocketProfileFacts,
    host_abi: u32,
    profile_hash: *const u8,
    out: *mut PocketGuestPackage,
) -> i32 {
    if ptr.is_null() || len == 0 || len > isize::MAX as usize || facts.is_null() || out.is_null() {
        return 12;
    }
    let guest = match package_open::admit(bytes(ptr, len), facts, host_abi, profile_hash) {
        Ok(guest) => guest,
        Err(code) => return code,
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
    out.write(PocketGuestPackage {
        javascript: guest.js.as_ptr(),
        javascript_length: guest.js.len(),
        worker_javascript: guest.worker_js.as_ptr(),
        worker_javascript_length: guest.worker_js.len(),
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
