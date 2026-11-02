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
/// 0 = admitted; the other codes are `package_open::guest_error_code`'s: 1-5
/// a damaged file, 6 no variant, 7 another binding generation, 8 a missing
/// identity, 9 an unreadable plan, 10-11 missing or unterminated JavaScript,
/// 12 a bad argument, 13-14 a plan whose JSON or viewport cannot be read, 17
/// an invalid section layout, 18 a plan whose `domains.worker` and section 8
/// disagree, and 19-25 the first failed admission item (raster density,
/// animation, rate, viewport, presentation, capability, auxiliary). The
/// profile hash, null or 32 readable bytes, only orders variants.
///
/// # Safety
/// `ptr` is readable for `len` bytes, `facts` follows
/// `pocket_runtime_create`'s profile contract, `profile_hash` is null or
/// readable for 32 bytes, and `out` is writable.
#[no_mangle]
pub unsafe extern "C" fn pocket_native_package_open(
    ptr: *const u8,
    len: usize,
    facts: *const pocket_runtime_cabi::abi::PocketProfileFacts,
    host_abi: u32,
    profile_hash: *const u8,
    out: *mut PocketNativePackage,
) -> i32 {
    use pocketjs_core::plan_facts::{plan_facts, PlanFactsError};
    if ptr.is_null() || len == 0 || facts.is_null() || out.is_null() {
        return 12;
    }
    let guest = match pocket_runtime_cabi::package_open::admit(
        core::slice::from_raw_parts(ptr, len),
        facts,
        host_abi,
        profile_hash,
    ) {
        Ok(guest) => guest,
        Err(code) => return code,
    };
    let facts = match plan_facts(guest.plan) {
        Ok(facts) => facts,
        Err(PlanFactsError::Malformed) => return 13,
        Err(_) => return 14,
    };
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
    });
    0
}
