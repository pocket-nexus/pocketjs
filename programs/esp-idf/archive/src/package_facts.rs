//! What a launcher program reads from a stored application before it boots
//! it: the sections, the hashes and the facts of its plan, from a bundle in
//! memory or from a package source. The runtime admits the program again at
//! boot; these calls share its admission path.
use core::{ffi::c_void, ptr};

use pocket_drivers::abi::{
    PocketPackageSourceV1, PocketProfileFacts, POCKET_PACKAGE_OPEN_BAD_ARGUMENT,
    POCKET_PACKAGE_OPEN_OK,
};
use pocket_package::sha256::sha256_hex_prefix;
use pocket_runtime::abi::{open_c_source, open_package, OpenedPackage};

/// Borrowed sections of one admitted program; the caller keeps the bytes
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
    /// The bundle's footer hash; zero for stated sections.
    pub package_hash: u64,
    /// The bundle's payload hash; zero for stated sections.
    pub payload_hash: u64,
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

/// A record `out` can hold.
fn writable(out: *mut PocketIdfPackageFacts) -> bool {
    !out.is_null() && unsafe { (*out).struct_size } >= core::mem::size_of::<PocketIdfPackageFacts>()
}

/// The facts of an opened program. `retained` is false when its slices
/// borrow memory the call releases: the three pointers are then null.
fn record(opened: &OpenedPackage<'_>, retained: bool) -> PocketIdfPackageFacts {
    let (guest, facts) = (&opened.guest, &opened.facts);
    let auxiliary = facts.auxiliary;
    let mut slot = [0u8; 17];
    slot[..16].copy_from_slice(&sha256_hex_prefix::<16>(guest.id.as_bytes()));
    let flag = |name: &str, bit: u32| if facts.feature(name) { bit } else { 0 };
    let pointer = |slice: &[u8]| {
        if retained {
            slice.as_ptr()
        } else {
            ptr::null()
        }
    };
    PocketIdfPackageFacts {
        struct_size: core::mem::size_of::<PocketIdfPackageFacts>(),
        javascript: pointer(guest.js),
        javascript_length: guest.js.len(),
        pak: pointer(guest.pak),
        pak_length: guest.pak.len(),
        plan: pointer(guest.plan),
        plan_length: guest.plan.len(),
        package_hash: guest.package_hash,
        payload_hash: guest.payload_hash,
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
    }
}

/// Verify a complete bundle and admit its plan against the exported profile
/// facts (`pocket_package::admission`), then read its facts. Returns the
/// generated `POCKET_PACKAGE_OPEN_*` codes of `pocket_runtime.h` from the
/// table of `pocket_runtime::abi`: `OK` on success, the admission codes of
/// `guest_error_code`, `BAD_ARGUMENT` for a bad pointer or a short record,
/// `NO_IDENTITY` for an empty app id, and `PLAN_JSON`, `PLAN_VIEWPORT` or
/// `PLAN_AUXILIARY` for a plan whose JSON, viewport or auxiliary surface
/// cannot be read. The profile hash is provenance.
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
    if !writable(out) {
        return POCKET_PACKAGE_OPEN_BAD_ARGUMENT;
    }
    // The app id names the slot below the store's apps directory.
    match unsafe { open_package(bytes, length, facts, host_abi, profile_hash, true) } {
        Ok(opened) => {
            unsafe { out.write(record(&opened, true)) };
            POCKET_PACKAGE_OPEN_OK
        }
        Err(code) => code,
    }
}

/// The same facts for what a package source holds — a bundle, or the
/// sections its `sections` callback states — read through the path boot
/// takes without taking the source. For stated sections the app id is the
/// plan's `app.id` and both hashes are zero. `SOURCE` for a source that does
/// not supply its length, sections or bytes; `BAD_ARGUMENT` also for a null
/// or short source table. `javascript`, `pak` and `plan` borrow the bytes the
/// source's `all` callback returned until the next call on the source; a
/// source without `all` is read through `range` into memory this call
/// releases, and the three pointers are null with their lengths set.
///
/// # Safety
/// `source` and `context` obey the C package source contract; `facts`,
/// `profile_hash` and `out` are as for `pocket_idf_package_open`.
#[no_mangle]
pub unsafe extern "C" fn pocket_idf_package_open_source(
    source: *const PocketPackageSourceV1,
    context: *mut c_void,
    facts: *const PocketProfileFacts,
    host_abi: u32,
    profile_hash: *const u8,
    out: *mut PocketIdfPackageFacts,
) -> i32 {
    if !writable(out) {
        return POCKET_PACKAGE_OPEN_BAD_ARGUMENT;
    }
    match unsafe { open_c_source(source, context, facts, host_abi, profile_hash, true, record) } {
        Ok(record) => {
            unsafe { out.write(record) };
            POCKET_PACKAGE_OPEN_OK
        }
        Err(code) => code,
    }
}
