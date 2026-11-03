//! What a launcher program reads from a stored `.pocket` before it boots
//! it: the variant's sections, its hash and the facts of its plan. The
//! runtime admits the package again at boot; this call shares its reader.
use pocket_drivers::abi::{
    PocketProfileFacts, POCKET_PACKAGE_OPEN_BAD_ARGUMENT, POCKET_PACKAGE_OPEN_OK,
};
use pocket_package::sha256::sha256_hex_prefix;
use pocket_runtime::abi::open_package;

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
/// Returns the generated `POCKET_PACKAGE_OPEN_*` codes of `pocket_runtime.h`
/// from the table of `pocket_runtime::abi::open_package`, shared with the 3DS
/// product's `pocket_package_open`: `OK` on success, the selection codes of
/// `guest_error_code`,
/// `BAD_ARGUMENT` for a bad pointer or a short record, `NO_IDENTITY` for an
/// empty app id, and `PLAN_JSON`, `PLAN_VIEWPORT` or `PLAN_AUXILIARY` for a
/// plan whose JSON, viewport or auxiliary surface cannot be read. The profile
/// hash only orders variants.
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
    if out.is_null()
        || unsafe { (*out).struct_size } < core::mem::size_of::<PocketIdfPackageFacts>()
    {
        return POCKET_PACKAGE_OPEN_BAD_ARGUMENT;
    }
    // The app id names the slot below the store's apps directory.
    let (guest, facts) =
        match unsafe { open_package(bytes, length, facts, host_abi, profile_hash, true) } {
            Ok(opened) => (opened.guest, opened.facts),
            Err(code) => return code,
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
    POCKET_PACKAGE_OPEN_OK
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocket_drivers::abi::*;

    const PLAN: &[u8] = br#"{"features":{"data.fs":true},"profile":{"tickHz":60},"viewport":{"logical":[32,24],"presentation":"native","rasterDensity":1}}"#;
    /// Admission compares the variant's generation with the host's for
    /// equality; the encoder and the entry point receive the same value.
    const GENERATION: u32 = 0x1234;

    fn package() -> Vec<u8> {
        let identity =
            pocket_package::embedded::identity("fixture", "dev.fixture", "Fixture").unwrap();
        pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
            target: "idf",
            host_abi: GENERATION,
            profile_hash: [0x51; 32],
            identity: &identity,
            plan: PLAN,
            code: b"fixture",
            pak: &[],
        })
        .unwrap()
    }

    fn display(raster_density: u32) -> PocketProfileDisplay {
        static LOGICAL: [u32; 2] = [32, 24];
        PocketProfileDisplay {
            physical: [32, 24],
            logical: LOGICAL.as_ptr(),
            logical_count: 1,
            raster_density,
            ..PocketProfileDisplay::empty()
        }
    }

    fn facts(display: &PocketProfileDisplay) -> PocketProfileFacts {
        PocketProfileFacts {
            id: b"idf".as_ptr(),
            id_length: 3,
            tick_hz: 60,
            input_classes: POCKET_INPUT_CLASS_BUTTONS,
            display,
            capabilities: b"data.fs\0".as_ptr(),
            capabilities_length: 8,
            ..PocketProfileFacts::empty()
        }
    }

    /// The launcher's entry point reports the generated codes and the plan
    /// facts of an admitted variant.
    #[test]
    fn opens_an_admitted_package_and_reports_generated_codes() {
        let bytes = package();
        let hash = [0x51u8; 32];
        let panel = display(1);
        let host = facts(&panel);
        let mut out: PocketIdfPackageFacts = unsafe { core::mem::zeroed() };
        out.struct_size = core::mem::size_of::<PocketIdfPackageFacts>();
        let open = |bytes: &[u8],
                    host: &PocketProfileFacts,
                    abi: u32,
                    out: &mut PocketIdfPackageFacts| unsafe {
            pocket_idf_package_open(bytes.as_ptr(), bytes.len(), host, abi, hash.as_ptr(), out)
        };
        let generation = GENERATION;
        assert_eq!(
            unsafe {
                pocket_idf_package_open(
                    core::ptr::null(),
                    0,
                    &host,
                    generation,
                    hash.as_ptr(),
                    &mut out,
                )
            },
            POCKET_PACKAGE_OPEN_BAD_ARGUMENT
        );
        out.struct_size = 8;
        assert_eq!(
            open(&bytes, &host, generation, &mut out),
            POCKET_PACKAGE_OPEN_BAD_ARGUMENT
        );
        out.struct_size = core::mem::size_of::<PocketIdfPackageFacts>();
        assert_eq!(
            open(&bytes, &host, generation.wrapping_add(1), &mut out),
            POCKET_PACKAGE_OPEN_BINDING_GENERATION
        );
        let dense = display(2);
        assert_eq!(
            open(&bytes, &facts(&dense), generation, &mut out),
            POCKET_PACKAGE_OPEN_RASTER_DENSITY
        );
        let mut damaged = bytes.clone();
        *damaged.last_mut().unwrap() ^= 1;
        assert_eq!(
            open(&damaged, &host, generation, &mut out),
            POCKET_PACKAGE_OPEN_HASH_MISMATCH
        );
        assert_eq!(
            open(&bytes, &host, generation, &mut out),
            POCKET_PACKAGE_OPEN_OK
        );
        assert_eq!(
            out.struct_size,
            core::mem::size_of::<PocketIdfPackageFacts>()
        );
        assert_eq!(
            (
                out.view_width,
                out.view_height,
                out.raster_density,
                out.aux_width,
                out.aux_height
            ),
            (32, 24, 1, 0, 0)
        );
        assert_eq!(out.features, POCKET_IDF_FEATURE_FS);
        assert_eq!(out.javascript_length, b"fixture\0".len());
        assert_eq!(out.plan_length, PLAN.len());
        assert_ne!(out.package_hash, 0);
        assert_eq!(out.slot[16], 0);
        assert!(out.slot[..16].iter().all(u8::is_ascii_hexdigit));
    }
}
