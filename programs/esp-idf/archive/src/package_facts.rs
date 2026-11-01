//! What a launcher program reads from a stored `.pocket` before it boots
//! it: the variant's sections, its hash and the facts of its plan. The
//! runtime admits the package again at boot; this call shares its reader.
use pocket_package::sha256::sha256_hex_prefix;
use pocket_package::{plan_facts, PlanFactsError};
use pocket_runtime_cabi::{abi::PocketProfileFacts, package_open};

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
/// `features.audio.pcm` is true in the plan.
pub const POCKET_IDF_FEATURE_AUDIO_PCM: u32 = 16;
/// `features.audio.capture` is true in the plan.
pub const POCKET_IDF_FEATURE_AUDIO_CAPTURE: u32 = 32;
/// `features.system.device` is true in the plan.
pub const POCKET_IDF_FEATURE_DEVICE: u32 = 64;

/// Verify a complete `.pocket` and admit the first variant the exported
/// profile facts satisfy (`pocket_package::admission`), then read its facts.
/// Returns 0 on success; the non-zero codes are those of the 3DS product's
/// `pocket_package_open` (`package_open::guest_error_code`: 12 is a bad
/// pointer or a short record, 13 to 15 a plan whose JSON, viewport or
/// auxiliary surface cannot be read, 17 a malformed layout, 18 a worker
/// declaration and section that disagree, 19 to 25 the first failed
/// admission item). The profile hash only orders variants.
///
/// # Safety
/// `bytes` is readable for `length`, `facts` follows `pocket_runtime_create`'s
/// profile contract, `profile_hash` is null or readable for 32 bytes, and
/// `out` is writable for `struct_size`.
#[no_mangle]
pub unsafe extern "C" fn pocket_idf_package_open(
    bytes: *const u8,
    length: usize,
    facts: *const PocketProfileFacts,
    host_abi: u32,
    profile_hash: *const u8,
    out: *mut PocketIdfPackageFacts,
) -> i32 {
    if bytes.is_null()
        || length == 0
        || length > isize::MAX as usize
        || facts.is_null()
        || out.is_null()
        || unsafe { (*out).struct_size } < core::mem::size_of::<PocketIdfPackageFacts>()
    {
        return 12;
    }
    let package = unsafe { core::slice::from_raw_parts(bytes, length) };
    let guest = match unsafe { package_open::admit(package, facts, host_abi, profile_hash) } {
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
                | flag("media.playback", POCKET_IDF_FEATURE_MEDIA)
                | flag("audio.pcm", POCKET_IDF_FEATURE_AUDIO_PCM)
                | flag("audio.capture", POCKET_IDF_FEATURE_AUDIO_CAPTURE)
                | flag("system.device", POCKET_IDF_FEATURE_DEVICE),
            slot,
        });
    }
    0
}
