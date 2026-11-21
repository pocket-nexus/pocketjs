//! What a program reads from an application before it boots it: the
//! sections, the hashes, the app id and the facts of its plan, from a bundle
//! in memory or from a package source, and whether the plan turns a feature
//! on. The runtime admits the program again at boot; these calls share its
//! admission path.
use core::{
    ffi::{c_char, c_void, CStr},
    ptr,
};

use pocket_drivers::abi::{
    PocketPackageSourceV1, PocketProfileFacts, POCKET_PACKAGE_OPEN_BAD_ARGUMENT,
    POCKET_PACKAGE_OPEN_OK,
};
use pocket_package::plan_facts;
use pocket_runtime::abi::{open_c_source, open_package, plan_code, OpenedPackage};

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
    /// The app id, UTF-8 without a terminator: the identity section's id in
    /// a bundle, the plan's `app.id` for stated sections.
    pub app_id: *const u8,
    pub app_id_length: usize,
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
}

/// A record `out` can hold.
fn writable(out: *const PocketIdfPackageFacts) -> bool {
    !out.is_null() && unsafe { (*out).struct_size } >= core::mem::size_of::<PocketIdfPackageFacts>()
}

/// The facts of an opened program. `retained` is false when its slices
/// borrow memory the call releases: the four pointers are then null.
fn record(opened: &OpenedPackage<'_>, retained: bool) -> PocketIdfPackageFacts {
    let (guest, facts) = (&opened.guest, &opened.facts);
    let auxiliary = facts.auxiliary;
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
        app_id: pointer(guest.id.as_bytes()),
        app_id_length: guest.id.len(),
        package_hash: guest.package_hash,
        payload_hash: guest.payload_hash,
        view_width: facts.viewport.width,
        view_height: facts.viewport.height,
        raster_density: facts.viewport.raster_density,
        aux_width: auxiliary.map_or(0, |surface| surface.width),
        aux_height: auxiliary.map_or(0, |surface| surface.height),
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
/// or short source table. `javascript`, `pak`, `plan` and `app_id` borrow the
/// bytes the source's `all` callback returned until the next call on the
/// source; a source without `all` is read through `range` into memory this
/// call releases, and the four pointers are null with their lengths set.
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

/// Whether the plan of an opened program turns the capability `name` on:
/// `*enabled` is true when the plan's `features.<name>` is `true`, false when
/// it is `false` or absent. The name is compared as a string, a registered
/// id or one the host contract defines. `OK` with `*enabled` written;
/// `BAD_ARGUMENT` for a null or short record, a record whose plan pointer is
/// null, a null or non-UTF-8 name, or a null `enabled`; `PLAN_JSON`,
/// `PLAN_VIEWPORT` or `PLAN_AUXILIARY` for plan bytes that cannot be read.
///
/// # Safety
/// `facts` is null or readable for `struct_size`, and its `plan` is null or
/// readable for `plan_length` bytes; `name` is null or NUL-terminated;
/// `enabled` is null or writable.
#[no_mangle]
pub unsafe extern "C" fn pocket_idf_package_feature(
    facts: *const PocketIdfPackageFacts,
    name: *const c_char,
    enabled: *mut bool,
) -> i32 {
    if !writable(facts) || name.is_null() || enabled.is_null() {
        return POCKET_PACKAGE_OPEN_BAD_ARGUMENT;
    }
    let facts = unsafe { &*facts };
    if facts.plan.is_null() {
        return POCKET_PACKAGE_OPEN_BAD_ARGUMENT;
    }
    let Ok(name) = unsafe { CStr::from_ptr(name) }.to_str() else {
        return POCKET_PACKAGE_OPEN_BAD_ARGUMENT;
    };
    let plan = unsafe { core::slice::from_raw_parts(facts.plan, facts.plan_length) };
    match plan_facts(plan) {
        Ok(plan) => {
            unsafe { enabled.write(plan.feature(name)) };
            POCKET_PACKAGE_OPEN_OK
        }
        Err(error) => plan_code(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocket_drivers::abi::{PocketProfileDisplay, POCKET_PACKAGE_OPEN_PLAN_JSON};

    const PLAN: &[u8] = br#"{"animation":"composited","app":{"id":"dev.bundle"},"features":{"input.buttons":true,"io.offload":false,"vendor.camera":true},"profile":{"tickHz":60},"viewport":{"logical":[480,272],"presentation":"native","rasterDensity":1}}"#;
    static LOGICAL: [u32; 2] = [480, 272];
    static CADENCES: [u32; 1] = [60];
    // The host contract lists one registered id and one it defines.
    const CAPABILITIES: &[u8] = b"input.buttons\0vendor.camera\0";

    fn display() -> PocketProfileDisplay {
        PocketProfileDisplay {
            physical: LOGICAL,
            logical: LOGICAL.as_ptr(),
            logical_count: 1,
            raster_density: 1,
            ..PocketProfileDisplay::empty()
        }
    }
    fn profile(display: &PocketProfileDisplay) -> PocketProfileFacts {
        PocketProfileFacts {
            id: b"fixture".as_ptr(),
            id_length: 7,
            tick_hz: 60,
            display,
            cadences: CADENCES.as_ptr(),
            cadence_count: 1,
            capabilities: CAPABILITIES.as_ptr().cast(),
            capabilities_length: CAPABILITIES.len(),
            presentations: c"native".as_ptr().cast(),
            presentations_length: 7,
            animation: b"composited".as_ptr(),
            animation_length: 10,
            ..PocketProfileFacts::empty()
        }
    }
    fn bundle() -> std::vec::Vec<u8> {
        let identity = pocket_package::embedded::identity("app", "dev.bundle", "App").unwrap();
        pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
            host_abi: pocket_spec::BINDING_GENERATION,
            profile_hash: [7; 32],
            identity: &identity,
            plan: PLAN,
            code: b"globalThis.frame=()=>{}",
            pak: b"pak",
        })
        .unwrap()
    }
    fn empty() -> PocketIdfPackageFacts {
        PocketIdfPackageFacts {
            struct_size: core::mem::size_of::<PocketIdfPackageFacts>(),
            javascript: ptr::null(),
            javascript_length: 0,
            pak: ptr::null(),
            pak_length: 0,
            plan: ptr::null(),
            plan_length: 0,
            app_id: ptr::null(),
            app_id_length: 0,
            package_hash: 0,
            payload_hash: 0,
            view_width: 0,
            view_height: 0,
            raster_density: 0,
            aux_width: 0,
            aux_height: 0,
        }
    }
    fn feature(facts: *const PocketIdfPackageFacts, name: &CStr) -> (i32, bool) {
        let mut enabled = false;
        let code = unsafe { pocket_idf_package_feature(facts, name.as_ptr(), &mut enabled) };
        (code, enabled)
    }

    #[test]
    fn reads_the_app_id_and_features_by_name() {
        let display = display();
        let profile = profile(&display);
        let bytes = bundle();
        let mut facts = empty();
        let code = unsafe {
            pocket_idf_package_open(
                bytes.as_ptr(),
                bytes.len(),
                &profile,
                pocket_spec::BINDING_GENERATION,
                ptr::null(),
                &mut facts,
            )
        };
        assert_eq!(code, POCKET_PACKAGE_OPEN_OK);
        let id = unsafe { core::slice::from_raw_parts(facts.app_id, facts.app_id_length) };
        assert_eq!(id, b"dev.bundle");
        assert_eq!((facts.view_width, facts.view_height, facts.raster_density), (480, 272, 1));
        assert_eq!(feature(&facts, c"input.buttons"), (POCKET_PACKAGE_OPEN_OK, true));
        assert_eq!(feature(&facts, c"vendor.camera"), (POCKET_PACKAGE_OPEN_OK, true));
        assert_eq!(feature(&facts, c"io.offload"), (POCKET_PACKAGE_OPEN_OK, false));
        assert_eq!(feature(&facts, c"vendor.radio"), (POCKET_PACKAGE_OPEN_OK, false));
    }

    #[test]
    fn refuses_a_record_without_plan_bytes_and_bad_arguments() {
        let mut facts = empty();
        assert_eq!(feature(&facts, c"input.buttons").0, POCKET_PACKAGE_OPEN_BAD_ARGUMENT);
        assert_eq!(feature(ptr::null(), c"input.buttons").0, POCKET_PACKAGE_OPEN_BAD_ARGUMENT);
        facts.plan = b"{".as_ptr();
        facts.plan_length = 1;
        assert_eq!(feature(&facts, c"input.buttons").0, POCKET_PACKAGE_OPEN_PLAN_JSON);
        let mut enabled = false;
        assert_eq!(
            unsafe { pocket_idf_package_feature(&facts, ptr::null(), &mut enabled) },
            POCKET_PACKAGE_OPEN_BAD_ARGUMENT
        );
        assert_eq!(
            unsafe { pocket_idf_package_feature(&facts, c"a.b".as_ptr(), ptr::null_mut()) },
            POCKET_PACKAGE_OPEN_BAD_ARGUMENT
        );
        facts.struct_size -= 1;
        assert_eq!(feature(&facts, c"input.buttons").0, POCKET_PACKAGE_OPEN_BAD_ARGUMENT);
    }
}
