use core::{ffi::c_void, ptr};

use pocket_drivers::abi::{
    PocketPackageSourceV1, PocketProfileFacts, POCKET_PACKAGE_OPEN_BAD_ARGUMENT,
    POCKET_PACKAGE_OPEN_OK,
};
use pocket_runtime::abi::{open_c_source, open_package, OpenedPackage};

/// One program admitted for a runtime that serves every game: the borrowed
/// guest sections and what the host takes from the plan at launch instead of
/// having it compiled in. Pointers borrow the bytes the caller or its source
/// supplied, which must outlive the guest.
#[repr(C)]
pub struct PocketNativePackage {
    pub javascript: *const u8,
    /// Includes the QuickJS NUL terminator.
    pub javascript_length: usize,
    pub pak: *const u8,
    pub pak_length: usize,
    pub plan: *const u8,
    pub plan_length: usize,
    /// The bundle's footer hash; zero for a source that states its sections.
    pub package_hash: u64,
    pub view_width: u32,
    pub view_height: u32,
    pub raster_density: u32,
    /// POCKET_NATIVE_PACKAGE_* bits.
    pub features: u32,
}

/// `features.ui.physics` is true in the plan.
pub const POCKET_NATIVE_PACKAGE_PHYSICS: u32 = 1;
/// `features.io.offload` is true in the plan.
pub const POCKET_NATIVE_PACKAGE_OFFLOAD: u32 = 2;
/// The plan names companion services (`companions` is not empty).
pub const POCKET_NATIVE_PACKAGE_COMPANIONS: u32 = 4;

/// The record of an opened program. `retained` is false when its slices
/// borrow memory the call releases: the three pointers are then null.
fn record(opened: &OpenedPackage<'_>, retained: bool) -> PocketNativePackage {
    let (guest, facts) = (&opened.guest, &opened.facts);
    let mut features = 0;
    if facts.feature("ui.physics") {
        features |= POCKET_NATIVE_PACKAGE_PHYSICS;
    }
    if facts.feature("io.offload") {
        features |= POCKET_NATIVE_PACKAGE_OFFLOAD;
    }
    if facts.companions {
        features |= POCKET_NATIVE_PACKAGE_COMPANIONS;
    }
    let pointer = |slice: &[u8]| {
        if retained {
            slice.as_ptr()
        } else {
            ptr::null()
        }
    };
    PocketNativePackage {
        javascript: pointer(guest.js),
        javascript_length: guest.js.len(),
        pak: pointer(guest.pak),
        pak_length: guest.pak.len(),
        plan: pointer(guest.plan),
        plan_length: guest.plan.len(),
        package_hash: guest.package_hash,
        view_width: facts.viewport.width,
        view_height: facts.viewport.height,
        raster_density: facts.viewport.raster_density,
        features,
    }
}

/// Verify a complete bundle (footer and payload hashes included) and admit
/// its plan against the exported profile facts (`pocket_package::admission`).
/// Returns the generated `POCKET_PACKAGE_OPEN_*` codes of `pocket_runtime.h`
/// from the table `pocket_runtime::abi` shares with the ESP-IDF entry points:
/// `OK` admits; `BAD_ARGUMENT` for a null or empty argument; the admission
/// codes of `guest_error_code`; `PLAN_JSON`, `PLAN_VIEWPORT` or
/// `PLAN_AUXILIARY` for a plan whose JSON, viewport or auxiliary surface
/// cannot be read after admission. The profile hash, null or 32 readable
/// bytes, is provenance.
///
/// # Safety
/// `ptr` is readable for `len` bytes, `facts` follows
/// `pocket_runtime_create`'s profile contract, `profile_hash` is null or
/// readable for 32 bytes, and `out` is writable.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_package_open(
    ptr: *const u8,
    len: usize,
    facts: *const PocketProfileFacts,
    host_abi: u32,
    profile_hash: *const u8,
    out: *mut PocketNativePackage,
) -> i32 {
    if out.is_null() {
        return POCKET_PACKAGE_OPEN_BAD_ARGUMENT;
    }
    match unsafe { open_package(ptr, len, facts, host_abi, profile_hash, false) } {
        Ok(opened) => {
            unsafe { out.write(record(&opened, true)) };
            POCKET_PACKAGE_OPEN_OK
        }
        Err(code) => code,
    }
}

/// Admit what a package source holds — a bundle, or the sections its
/// `sections` callback states — through the path boot takes, without taking
/// its storage, so the same source boots the program afterwards. The codes
/// are those of `pocket_native_package_open`, with `BAD_ARGUMENT` for a null
/// or short source table and `SOURCE` for a source that does not supply its
/// length, sections or bytes. `javascript`, `pak` and `plan` borrow the
/// bytes the source's `all` callback returned until the next call on the
/// source; a source without `all` is read through `range` into memory this
/// call releases, and the three pointers are then null with their lengths
/// set. `package_hash` is zero for stated sections.
///
/// # Safety
/// `source` and `context` obey the C package source contract; `facts`,
/// `profile_hash` and `out` are as for `pocket_native_package_open`.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_package_open_source(
    source: *const PocketPackageSourceV1,
    context: *mut c_void,
    facts: *const PocketProfileFacts,
    host_abi: u32,
    profile_hash: *const u8,
    out: *mut PocketNativePackage,
) -> i32 {
    if out.is_null() {
        return POCKET_PACKAGE_OPEN_BAD_ARGUMENT;
    }
    let opened = unsafe {
        open_c_source(
            source,
            context,
            facts,
            host_abi,
            profile_hash,
            false,
            record,
        )
    };
    match opened {
        Ok(record) => {
            unsafe { out.write(record) };
            POCKET_PACKAGE_OPEN_OK
        }
        Err(code) => code,
    }
}
