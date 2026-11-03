//! Package admission for the C inspection entry points (`pocket_native_package_open`,
//! the 3DS product's `pocket_package_open`, the ESP-IDF launcher's
//! `pocket_idf_package_open`). They admit against the same exported profile
//! facts `pocket_runtime_create` copies, and return the `POCKET_PACKAGE_OPEN_*`
//! codes that `contracts/spec/runtime-abi.ts` generates into `pocket_runtime.h`
//! and `pocket_drivers::abi`.
use crate::abi::*;
use pocket_runtime::pocket_package::{
    admission::item, select_guest, Guest, GuestError, PackageError,
};

/// The `POCKET_PACKAGE_OPEN_*` code of a variant selection failure. The entry
/// points return `POCKET_PACKAGE_OPEN_BAD_ARGUMENT` and the three
/// `POCKET_PACKAGE_OPEN_PLAN_*` codes themselves, for a bad argument and for
/// a plan whose JSON, viewport or auxiliary surface cannot be read after
/// admission.
pub fn guest_error_code(error: GuestError) -> i32 {
    match error {
        GuestError::Package(PackageError::Truncated) => POCKET_PACKAGE_OPEN_TRUNCATED,
        GuestError::Package(PackageError::BadMagic) => POCKET_PACKAGE_OPEN_BAD_MAGIC,
        GuestError::Package(PackageError::BadVersion) => POCKET_PACKAGE_OPEN_BAD_VERSION,
        GuestError::Package(PackageError::HashMismatch) => POCKET_PACKAGE_OPEN_HASH_MISMATCH,
        GuestError::Package(PackageError::BadUtf8) => POCKET_PACKAGE_OPEN_BAD_UTF8,
        GuestError::MissingVariant => POCKET_PACKAGE_OPEN_NO_VARIANT,
        GuestError::MissingIdentity => POCKET_PACKAGE_OPEN_NO_IDENTITY,
        GuestError::MissingJavaScript => POCKET_PACKAGE_OPEN_NO_JAVASCRIPT,
        GuestError::JavaScriptNotTerminated => POCKET_PACKAGE_OPEN_JAVASCRIPT_NOT_TERMINATED,
        GuestError::Package(PackageError::BadLayout) => POCKET_PACKAGE_OPEN_BAD_LAYOUT,
        GuestError::WorkerSectionMismatch => POCKET_PACKAGE_OPEN_WORKER_SECTION,
        GuestError::BadBytecode => POCKET_PACKAGE_OPEN_BAD_BYTECODE,
        // The first failed admission item in check order.
        GuestError::NotAdmitted(mismatch) => match mismatch.first() {
            item::BINDING_GENERATION => POCKET_PACKAGE_OPEN_BINDING_GENERATION,
            item::PLAN => POCKET_PACKAGE_OPEN_PLAN,
            item::RASTER_DENSITY => POCKET_PACKAGE_OPEN_RASTER_DENSITY,
            item::ANIMATION => POCKET_PACKAGE_OPEN_ANIMATION,
            item::RATE => POCKET_PACKAGE_OPEN_RATE,
            item::VIEWPORT => POCKET_PACKAGE_OPEN_VIEWPORT,
            item::PRESENTATION => POCKET_PACKAGE_OPEN_PRESENTATION,
            item::CAPABILITY => POCKET_PACKAGE_OPEN_CAPABILITY,
            _ => POCKET_PACKAGE_OPEN_AUXILIARY,
        },
    }
}

/// Admit `bytes` against exported facts. The profile hash only orders
/// variants (`pocket_package::admission`). Null facts are
/// `POCKET_PACKAGE_OPEN_BAD_ARGUMENT`.
/// # Safety
/// `facts` follows `pocket_runtime_create`'s profile contract and
/// `profile_hash` is null or readable for 32 bytes.
pub unsafe fn admit<'a>(
    bytes: &'a [u8],
    facts: *const PocketProfileFacts,
    host_abi: u32,
    profile_hash: *const u8,
) -> Result<Guest<'a>, i32> {
    let profile =
        unsafe { crate::runtime::profile(facts) }.ok_or(POCKET_PACKAGE_OPEN_BAD_ARGUMENT)?;
    let mut hash = [0; 32];
    if !profile_hash.is_null() {
        hash.copy_from_slice(unsafe { core::slice::from_raw_parts(profile_hash, 32) });
    }
    select_guest(bytes, &profile.host_facts(host_abi, hash), false).map_err(guest_error_code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocket_runtime::pocket_package::admission::{Mismatch, Name};

    fn not_admitted(items: u32) -> GuestError {
        GuestError::NotAdmitted(Mismatch {
            variant: 0,
            items,
            capability: Name::EMPTY,
        })
    }

    /// Every selection failure has one generated code, and the codes the
    /// entry points add for their own checks do not collide with them.
    #[test]
    fn selection_failures_map_onto_distinct_generated_codes() {
        let table = [
            (
                GuestError::Package(PackageError::Truncated),
                POCKET_PACKAGE_OPEN_TRUNCATED,
            ),
            (
                GuestError::Package(PackageError::BadMagic),
                POCKET_PACKAGE_OPEN_BAD_MAGIC,
            ),
            (
                GuestError::Package(PackageError::BadVersion),
                POCKET_PACKAGE_OPEN_BAD_VERSION,
            ),
            (
                GuestError::Package(PackageError::HashMismatch),
                POCKET_PACKAGE_OPEN_HASH_MISMATCH,
            ),
            (
                GuestError::Package(PackageError::BadUtf8),
                POCKET_PACKAGE_OPEN_BAD_UTF8,
            ),
            (GuestError::MissingVariant, POCKET_PACKAGE_OPEN_NO_VARIANT),
            (
                not_admitted(item::BINDING_GENERATION),
                POCKET_PACKAGE_OPEN_BINDING_GENERATION,
            ),
            (GuestError::MissingIdentity, POCKET_PACKAGE_OPEN_NO_IDENTITY),
            (not_admitted(item::PLAN), POCKET_PACKAGE_OPEN_PLAN),
            (
                GuestError::MissingJavaScript,
                POCKET_PACKAGE_OPEN_NO_JAVASCRIPT,
            ),
            (
                GuestError::JavaScriptNotTerminated,
                POCKET_PACKAGE_OPEN_JAVASCRIPT_NOT_TERMINATED,
            ),
            (
                GuestError::Package(PackageError::BadLayout),
                POCKET_PACKAGE_OPEN_BAD_LAYOUT,
            ),
            (
                GuestError::WorkerSectionMismatch,
                POCKET_PACKAGE_OPEN_WORKER_SECTION,
            ),
            (
                not_admitted(item::RASTER_DENSITY),
                POCKET_PACKAGE_OPEN_RASTER_DENSITY,
            ),
            (not_admitted(item::ANIMATION), POCKET_PACKAGE_OPEN_ANIMATION),
            (not_admitted(item::RATE), POCKET_PACKAGE_OPEN_RATE),
            (not_admitted(item::VIEWPORT), POCKET_PACKAGE_OPEN_VIEWPORT),
            (
                not_admitted(item::PRESENTATION),
                POCKET_PACKAGE_OPEN_PRESENTATION,
            ),
            (
                not_admitted(item::CAPABILITY),
                POCKET_PACKAGE_OPEN_CAPABILITY,
            ),
            (not_admitted(item::AUXILIARY), POCKET_PACKAGE_OPEN_AUXILIARY),
            (GuestError::BadBytecode, POCKET_PACKAGE_OPEN_BAD_BYTECODE),
        ];
        let mut codes = alloc::vec::Vec::new();
        for (error, code) in table {
            assert_eq!(guest_error_code(error), code, "{error:?}");
            assert!(code > POCKET_PACKAGE_OPEN_OK, "{error:?}");
            assert!(!codes.contains(&code), "{error:?} repeats {code}");
            codes.push(code);
        }
        let own = [
            POCKET_PACKAGE_OPEN_BAD_ARGUMENT,
            POCKET_PACKAGE_OPEN_PLAN_JSON,
            POCKET_PACKAGE_OPEN_PLAN_VIEWPORT,
            POCKET_PACKAGE_OPEN_PLAN_AUXILIARY,
        ];
        for code in own {
            assert!(!codes.contains(&code), "{code} is also a selection code");
        }
        codes.extend(own);
        codes.sort_unstable();
        assert_eq!(
            codes,
            (1..=26)
                .filter(|code| *code != 16)
                .collect::<alloc::vec::Vec<_>>()
        );
    }

    /// Several failed items report the first one in check order.
    #[test]
    fn the_first_failed_admission_item_is_reported() {
        assert_eq!(
            guest_error_code(not_admitted(item::VIEWPORT | item::RASTER_DENSITY)),
            POCKET_PACKAGE_OPEN_RASTER_DENSITY
        );
        assert_eq!(
            guest_error_code(not_admitted(item::AUXILIARY | item::BINDING_GENERATION)),
            POCKET_PACKAGE_OPEN_BINDING_GENERATION
        );
    }

    #[test]
    fn null_facts_are_a_bad_argument() {
        let result = unsafe { admit(b"", core::ptr::null(), 0, core::ptr::null()) };
        assert_eq!(result.err(), Some(POCKET_PACKAGE_OPEN_BAD_ARGUMENT));
    }
}
