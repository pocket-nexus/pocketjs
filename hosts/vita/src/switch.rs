//! Whole-guest app switching for the Vita launcher host.
//!
//! Exactly one guest is live at a time. The build script emits the embedded
//! app table; this module owns only process-level switch state and the frozen
//! frame handed to a summoned launcher. QuickJS, `Ui`, pak and GPU-cache
//! teardown remain in `Runtime`/`main` so a request cannot swap a guest in the
//! middle of its frame.

use alloc::string::String;
use alloc::vec::Vec;

use pocketjs_core::package::{self, Package};
use pocketjs_core::{spec, Ui};

// $OUT_DIR/apps.rs -- `EmbeddedApp` + `APPS` (hosts/vita/build.rs).
include!(concat!(env!("OUT_DIR"), "/apps.rs"));

/// Zero-copy bytes for one guest: embedded, or (feature `runtime`) the
/// app0:app.pocket the process loaded. Package JS includes the trailing NUL
/// required by `Runtime::eval`; classic single-app JS is generated with the
/// same terminator.
#[derive(Clone, Copy)]
pub struct GuestBytes {
    pub js: &'static str,
    pub pak: &'static [u8],
}

/// The guest at `index`, or the line that says why it cannot start.
pub fn guest(index: usize) -> Result<GuestBytes, String> {
    #[cfg(feature = "runtime")]
    if index == 0 {
        return crate::package_file::game();
    }
    guest_bytes(index).ok_or_else(|| String::from("embedded package unreadable"))
}

pub fn guest_bytes(index: usize) -> Option<GuestBytes> {
    #[cfg(feature = "runtime")]
    if index == 0 {
        return crate::package_file::game().ok();
    }
    let app = APPS.get(index)?;
    if app.pocket.is_empty() {
        return Some(GuestBytes {
            js: app.js,
            pak: app.pak,
        });
    }
    // Embedded packages are build inputs of the signed VPK, so the device can
    // skip the package footer walk. Filesystem-loaded packages must not.
    let package = Package::parse(app.pocket, true).ok()?;
    let variant = package.find_variant(env!("POCKETJS_TARGET")).ok()??;
    let js = variant.section(package::section::JS).ok()??;
    let pak = variant.section(package::section::PAK).ok()?.unwrap_or(&[]);
    Some(GuestBytes {
        js: core::str::from_utf8(js).ok()?,
        pak,
    })
}

pub const SHOT_W: u32 = 256;
pub const SHOT_H: u32 = 128;
const SHOT_BYTES: usize = (SHOT_W * SHOT_H * 4) as usize;

#[repr(C, align(16))]
struct AlignedShot([u8; SHOT_BYTES]);

static mut CURRENT: usize = 0;
static mut PENDING: i32 = -1;
static mut PENDING_SUMMON: bool = false;
static mut RESUME: i32 = -1;
static mut SHOT: AlignedShot = AlignedShot([0; SHOT_BYTES]);
static mut SHOT_VALID: bool = false;
static mut GUEST_SHOT: bool = false;
static mut SHOT_HANDLE: i32 = -1;
// Retained across summons to avoid repeatedly allocating a 960x544 CPU oracle.
static mut RASTER_SCRATCH: Option<Vec<u8>> = None;

pub fn multi() -> bool {
    APPS.len() > 1
}

pub unsafe fn set_current(index: usize) {
    CURRENT = index;
}

pub unsafe fn resume() -> Option<usize> {
    usize::try_from(RESUME)
        .ok()
        .filter(|index| *index < APPS.len())
}

pub fn find(output: &str) -> Option<usize> {
    APPS.iter().position(|app| app.output == output)
}

fn identity(app: &'static EmbeddedApp) -> (&'static str, &'static str, &'static str) {
    if !app.id.is_empty() || !app.title.is_empty() || app.pocket.is_empty() {
        return (app.output, app.id, app.title);
    }
    let package = Package::parse(app.pocket, true).ok();
    let variant = package
        .as_ref()
        .and_then(|package| package.find_variant(env!("POCKETJS_TARGET")).ok().flatten());
    let embedded = variant.and_then(|variant| variant.identity().ok().flatten());
    embedded
        .map(|identity| (identity.output, identity.id, identity.title))
        .unwrap_or((app.output, app.id, app.title))
}

pub unsafe fn request_launch(index: usize) {
    if index < APPS.len() {
        PENDING = index as i32;
        PENDING_SUMMON = false;
    }
}

pub unsafe fn request_summon() {
    if multi() {
        PENDING = 0;
        PENDING_SUMMON = true;
    }
}

/// Clear a request left behind by a guest that failed before its frame could
/// reach the normal switch boundary.
pub unsafe fn cancel_pending() {
    PENDING = -1;
    PENDING_SUMMON = false;
}

/// Consume the request after the outgoing frame has been presented.
pub unsafe fn take_pending() -> Option<(usize, bool)> {
    let target = usize::try_from(PENDING)
        .ok()
        .filter(|index| *index < APPS.len())?;
    let summon = PENDING_SUMMON;
    cancel_pending();
    if summon {
        RESUME = CURRENT as i32;
        GUEST_SHOT = true;
    } else {
        RESUME = -1;
        GUEST_SHOT = false;
    }
    SHOT_HANDLE = -1;
    Some((target, summon))
}

/// spec op 39: table plus the current summon/resume state.
pub unsafe fn table_json() -> String {
    let mut output = String::from("{\"apps\":[");
    for (index, app) in APPS.iter().enumerate() {
        let (app_output, app_id, app_title) = identity(app);
        if index > 0 {
            output.push(',');
        }
        output.push_str("{\"output\":");
        push_json_str(&mut output, app_output);
        output.push_str(",\"id\":");
        push_json_str(&mut output, app_id);
        output.push_str(",\"title\":");
        push_json_str(&mut output, app_title);
        output.push('}');
    }
    output.push_str("],\"current\":");
    push_json_str(&mut output, APPS[CURRENT].output);
    output.push_str(",\"resume\":");
    match resume() {
        Some(index) => push_json_str(&mut output, APPS[index].output),
        None => output.push_str("null"),
    }
    output.push('}');
    output
}

/// Capture sidecar identity. Frame numbers live in `main.rs` because they are
/// process-global across guest swaps; table identity stays next to `APPS`.
#[cfg(feature = "capture")]
pub fn frame_json(index: usize) -> String {
    let Some(app) = APPS.get(index) else {
        return String::from("{\"appIndex\":-1,\"appOutput\":\"\",\"appId\":\"\"}");
    };
    let (app_output, app_id, _) = identity(app);
    let mut output = alloc::format!("{{\"appIndex\":{index},\"appOutput\":");
    push_json_str(&mut output, app_output);
    output.push_str(",\"appId\":");
    push_json_str(&mut output, app_id);
    output.push('}');
    output
}

fn push_json_str(output: &mut String, value: &str) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            character if (character as u32) < 0x20 => {
                output.push_str("\\u00");
                let value = character as u32;
                let hex = b"0123456789abcdef";
                output.push(hex[(value >> 4) as usize] as char);
                output.push(hex[(value & 0x0f) as usize] as char);
            }
            character => output.push(character),
        }
    }
    output.push('"');
}

/// Capture the outgoing guest's last DrawList through the deterministic CPU
/// rasterizer. Vita3K/macOS cannot coherently read back its GXM framebuffer;
/// using the same physical-density oracle as capture E2E keeps the launcher
/// snapshot reliable on both emulator and hardware.
pub unsafe fn capture_shot(ui: &Ui, words: &[u32]) {
    let source_len =
        crate::graphics::PHYSICAL_W as usize * crate::graphics::PHYSICAL_H as usize * 4;
    let source = RASTER_SCRATCH.get_or_insert_with(Vec::new);
    source.resize(source_len, 0);
    source.fill(0);
    pocketjs_core::raster::render_scaled(ui, words, source, crate::graphics::INTEGER_SCALE as u32);

    let source_w = crate::graphics::PHYSICAL_W as usize;
    let source_h = crate::graphics::PHYSICAL_H as usize;
    let scale_x = source_w as f32 / SHOT_W as f32;
    let scale_y = source_h as f32 / SHOT_H as f32;
    for destination_y in 0..SHOT_H as usize {
        let source_y = (destination_y as f32 + 0.5) * scale_y - 0.5;
        let y0 = (source_y.floor() as i32).clamp(0, source_h as i32 - 1) as usize;
        let y1 = (y0 + 1).min(source_h - 1);
        let fy = (source_y - y0 as f32).clamp(0.0, 1.0);
        for destination_x in 0..SHOT_W as usize {
            let source_x = (destination_x as f32 + 0.5) * scale_x - 0.5;
            let x0 = (source_x.floor() as i32).clamp(0, source_w as i32 - 1) as usize;
            let x1 = (x0 + 1).min(source_w - 1);
            let fx = (source_x - x0 as f32).clamp(0.0, 1.0);
            let p00 = (y0 * source_w + x0) * 4;
            let p01 = (y0 * source_w + x1) * 4;
            let p10 = (y1 * source_w + x0) * 4;
            let p11 = (y1 * source_w + x1) * 4;
            let destination = (destination_y * SHOT_W as usize + destination_x) * 4;
            for channel in 0..3 {
                let top = source[p00 + channel] as f32
                    + (source[p01 + channel] as f32 - source[p00 + channel] as f32) * fx;
                let bottom = source[p10 + channel] as f32
                    + (source[p11 + channel] as f32 - source[p10 + channel] as f32) * fx;
                SHOT.0[destination + channel] = (top + (bottom - top) * fy + 0.5) as u8;
            }
            // A frozen full-screen frame is opaque even if a renderer leaves
            // its backing-buffer alpha undefined.
            SHOT.0[destination + 3] = 0xff;
        }
    }
    SHOT_VALID = true;
}

/// Upload the summoned frame into the incoming launcher's fresh core and GPU
/// cache. The handle belongs to this guest and is invalidated at its teardown.
pub unsafe fn upload_shot(ui: &mut Ui) {
    if !SHOT_VALID || !GUEST_SHOT {
        SHOT_HANDLE = -1;
        return;
    }
    SHOT_HANDLE = ui.upload_texture_flags(
        &SHOT.0,
        SHOT_W,
        SHOT_H,
        spec::psm::PSM_8888,
        spec::img::FLAG_LINEAR,
    );
    if SHOT_HANDLE >= 0 {
        crate::graphics::register_texture(ui, SHOT_HANDLE);
    }
}

pub unsafe fn shot_handle() -> i32 {
    SHOT_HANDLE
}
