use pocket_drivers::abi::{
    PocketProfileFacts, POCKET_PACKAGE_OPEN_BAD_ARGUMENT, POCKET_PACKAGE_OPEN_OK,
};
use pocket_runtime::abi::open_package;

/// One `.pocket` variant admitted for a runtime that serves every game: the
/// borrowed guest sections and what the host takes from the variant's plan at
/// launch instead of having it compiled in. Pointers borrow the caller's
/// package buffer, which must outlive the guest.
#[repr(C)]
pub struct PocketNativePackage {
    pub javascript: *const u8,
    /// Includes the QuickJS NUL terminator.
    pub javascript_length: usize,
    pub pak: *const u8,
    pub pak_length: usize,
    pub plan: *const u8,
    pub plan_length: usize,
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

/// Verify a complete `.pocket` (footer hash included) and select the first
/// variant the exported profile facts admit (`pocket_package::admission`).
/// Returns the generated `POCKET_PACKAGE_OPEN_*` codes of `pocket_runtime.h`
/// from the table `pocket_runtime::abi::open_package` shares with the 3DS and
/// ESP-IDF entry points: `OK` admits; `BAD_ARGUMENT` for a null or empty
/// argument; the selection codes of `guest_error_code`; `PLAN_JSON`,
/// `PLAN_VIEWPORT` or `PLAN_AUXILIARY` for a plan whose JSON, viewport or
/// auxiliary surface cannot be read after admission. The profile hash, null
/// or 32 readable bytes, only orders variants.
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
    let opened = match unsafe { open_package(ptr, len, facts, host_abi, profile_hash, false) } {
        Ok(opened) => opened,
        Err(code) => return code,
    };
    let (guest, facts) = (opened.guest, opened.facts);
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
    unsafe {
        out.write(PocketNativePackage {
            javascript: guest.js.as_ptr(),
            javascript_length: guest.js.len(),
            pak: guest.pak.as_ptr(),
            pak_length: guest.pak.len(),
            plan: guest.plan.as_ptr(),
            plan_length: guest.plan.len(),
            package_hash: guest.package_hash,
            view_width: facts.viewport.width,
            view_height: facts.viewport.height,
            raster_density: facts.viewport.raster_density,
            features,
        })
    };
    POCKET_PACKAGE_OPEN_OK
}
