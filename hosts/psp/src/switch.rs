//! App switching (docs/LAUNCHER.md, spec ops 39..41): the embedded app table,
//! the pending switch request, and the frozen-frame capture.
//!
//! One guest is alive at a time; a "switch" is a whole-guest swap main.rs
//! performs at the bottom of a frame. This module only holds the state the
//! swap needs: which app to boot next, the resume context of a SELECT
//! summon, and the 256×128 shot the summon captured from the display
//! framebuffer. Single-app builds have an APPS table of one — `multi()` is
//! false, the ops are never registered, and none of this runs.
//!
//! Single-threaded (the QuickJS worker), `static mut` matches the crate
//! style.

use alloc::string::String;

use psp::sys::{self, DisplayPixelFormat, DisplaySetBufSync};

use pocketjs_core::package::{self, Package};
use pocketjs_core::{spec, Ui};

// $OUT_DIR/apps.rs — `EmbeddedApp` + `APPS` (build.rs generates both).
include!(concat!(env!("OUT_DIR"), "/apps.rs"));

/// The bytes a guest boots from — extracted zero-copy from the entry's
/// embedded `.pocket` (package mode), or the classic inline embed. `js`
/// includes its NUL terminator (eval with len - 1). None = a malformed
/// package or a variant this target does not carry; main.rs routes that
/// through the broken-guest path.
pub struct GuestBytes {
    pub js: &'static [u8],
    pub pak: &'static [u8],
}

pub fn guest_bytes(index: usize) -> Option<GuestBytes> {
    let app = &APPS[index];
    if app.pocket.is_empty() {
        return Some(GuestBytes { js: app.js.as_bytes(), pak: app.pak });
    }
    // Embedded packages were hashed into the build identity at pack time —
    // skip the footer walk at boot (filesystem loads must NOT skip it).
    let pkg = Package::parse(app.pocket, true).ok()?;
    let variant = pkg.find_variant(env!("POCKETJS_TARGET")).ok()??;
    let js = variant.section(package::section::JS).ok()??;
    let pak = variant.section(package::section::PAK).ok()?.unwrap_or(&[]);
    Some(GuestBytes { js, pak })
}

/// Shot geometry (spec op 41; hosts/sim/shot.ts is the sim twin). The FULL
/// 480×272 frame is downscaled — the texture stores it slightly squeezed
/// (2:1 vs 1.76:1) and consumers draw at screen aspect, which undoes it
/// exactly. No crop: a cropped shot visibly deformed the veil's "dimming
/// screen" and cut covers' top/bottom (real-hardware find).
pub const SHOT_W: u32 = 256;
pub const SHOT_H: u32 = 128;
const SHOT_BYTES: usize = (SHOT_W * SHOT_H * 4) as usize;
const SRC_W: usize = 480;
const SRC_H: usize = 272;
const FB_STRIDE_BYTES: usize = 512 * 4;

static mut CURRENT: usize = 0;
static mut PENDING: i32 = -1;
static mut PENDING_SUMMON: bool = false;
static mut RESUME: i32 = -1;
// 16-aligned: sceGuTexImage samples this buffer directly during the veil.
static mut SHOT: psp::Align16<[u8; SHOT_BYTES]> = psp::Align16([0; SHOT_BYTES]);
/// Raw pixels valid (ANY switch captures — the veil dims the real outgoing
/// frame). GUEST_SHOT additionally marks a summon: only then does the shot
/// upload into the incoming guest's core (spec op 41 semantics).
static mut SHOT_VALID: bool = false;
static mut GUEST_SHOT: bool = false;
static mut SHOT_HANDLE: i32 = -1;

/// More than one embedded bundle: the summon chord + the app* ops are live.
pub fn multi() -> bool {
    APPS.len() > 1
}

pub unsafe fn current() -> usize {
    CURRENT
}

pub unsafe fn set_current(index: usize) {
    CURRENT = index;
}

pub unsafe fn current_output() -> &'static str {
    APPS[CURRENT].output
}

pub unsafe fn resume() -> Option<usize> {
    usize::try_from(RESUME).ok()
}

pub fn find(output: &str) -> Option<usize> {
    APPS.iter().position(|a| a.output == output)
}

/// Guest request (spec op 40): switch after the current frame presents.
pub unsafe fn request_launch(index: usize) {
    PENDING = index as i32;
    PENDING_SUMMON = false;
}

/// Host chord: SELECT press-edge in a non-launcher guest summons app 0.
pub unsafe fn request_summon() {
    PENDING = 0;
    PENDING_SUMMON = true;
}

/// Consume the pending request: (target app, was-a-summon).
pub unsafe fn take_pending() -> Option<(usize, bool)> {
    let target = usize::try_from(PENDING).ok()?;
    let summon = PENDING_SUMMON;
    PENDING = -1;
    PENDING_SUMMON = false;
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

/// The veil's background: the raw downscaled pixels of the frame the
/// outgoing guest last presented (any switch), 256×128 RGBA.
pub unsafe fn shot_pixels() -> Option<&'static [u8]> {
    if SHOT_VALID { Some(&SHOT.0) } else { None }
}

/// spec op 39 — the table + runtime state, one JSON string.
pub unsafe fn table_json() -> String {
    let mut out = String::from("{\"apps\":[");
    for (i, a) in APPS.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"output\":");
        push_json_str(&mut out, a.output);
        out.push_str(",\"id\":");
        push_json_str(&mut out, a.id);
        out.push_str(",\"title\":");
        push_json_str(&mut out, a.title);
        out.push('}');
    }
    out.push_str("],\"current\":");
    push_json_str(&mut out, APPS[CURRENT].output);
    out.push_str(",\"resume\":");
    match resume() {
        Some(i) => push_json_str(&mut out, APPS[i].output),
        None => out.push_str("null"),
    }
    out.push('}');
    out
}

fn push_json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                out.push_str("\\u00");
                let b = c as u32;
                let hex = b"0123456789abcdef";
                out.push(hex[(b >> 4) as usize] as char);
                out.push(hex[(b & 0xf) as usize] as char);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Capture the just-presented display framebuffer (Psm8888, 512 stride, the
/// dbg.rs shot technique: uncached VRAM mirror, cached-RAM bounce rows) and
/// bilinear-downscale the FULL frame into the static shot buffer.
/// Call ONLY between present and the next sceGuStart — the GE must be idle.
pub unsafe fn capture_shot() {
    let mut top: *mut core::ffi::c_void = core::ptr::null_mut();
    let mut bw: usize = 0;
    let mut fmt = DisplayPixelFormat::Psm8888;
    sys::sceDisplayGetFrameBuf(&mut top, &mut bw, &mut fmt, DisplaySetBufSync::Immediate);
    if !matches!(fmt, DisplayPixelFormat::Psm8888) {
        // Non-8888 display never happens with host::init_graphics; skip the
        // shot rather than misread it.
        SHOT_VALID = false;
        return;
    }
    let mut addr = top as u32;
    if addr < 0x0400_0000 {
        addr += 0x0400_0000;
    }
    addr |= 0x4000_0000;
    let base = addr as usize;

    // Two source rows bounced into cached RAM per output row (VRAM reads by
    // the CPU are painfully slow AND the mirror must not be held long).
    let mut row0 = [0u8; SRC_W * 4];
    let mut row1 = [0u8; SRC_W * 4];
    let scale_x = SRC_W as f32 / SHOT_W as f32; // 1.875
    let scale_y = SRC_H as f32 / SHOT_H as f32; // 2.125
    for dy in 0..SHOT_H as usize {
        let sy = (dy as f32 + 0.5) * scale_y - 0.5;
        let y0 = (sy as i32).clamp(0, SRC_H as i32 - 1) as usize;
        let y1 = (y0 + 1).min(SRC_H - 1);
        let fy = (sy - y0 as f32).clamp(0.0, 1.0);
        core::ptr::copy_nonoverlapping(
            (base + y0 * FB_STRIDE_BYTES) as *const u8,
            row0.as_mut_ptr(),
            SRC_W * 4,
        );
        core::ptr::copy_nonoverlapping(
            (base + y1 * FB_STRIDE_BYTES) as *const u8,
            row1.as_mut_ptr(),
            SRC_W * 4,
        );
        for dx in 0..SHOT_W as usize {
            let sx = (dx as f32 + 0.5) * scale_x - 0.5;
            let x0 = (sx as i32).clamp(0, SRC_W as i32 - 1) as usize;
            let x1 = (x0 + 1).min(SRC_W - 1);
            let fx = (sx - x0 as f32).clamp(0.0, 1.0);
            let o = (dy * SHOT_W as usize + dx) * 4;
            for c in 0..3 {
                let p00 = row0[x0 * 4 + c] as f32;
                let p01 = row0[x1 * 4 + c] as f32;
                let p10 = row1[x0 * 4 + c] as f32;
                let p11 = row1[x1 * 4 + c] as f32;
                let top = p00 + (p01 - p00) * fx;
                let bot = p10 + (p11 - p10) * fx;
                SHOT.0[o + c] = (top + (bot - top) * fy + 0.5) as u8;
            }
            // The GE leaves framebuffer alpha at 0 — an as-is upload would
            // blend to nothing. The shot is opaque by definition.
            SHOT.0[o + 3] = 0xff;
        }
    }
    SHOT_VALID = true;
}

/// After a summoned guest boots: upload the shot into ITS core, once. The
/// handle dies with the guest's Ui, so it is re-uploaded per boot. Bilinear:
/// the 256×128 shot stretches back over 480×272 — nearest would pixel-double.
pub unsafe fn upload_shot(ui: &mut Ui) {
    if SHOT_VALID && GUEST_SHOT {
        SHOT_HANDLE = ui.upload_texture_flags(
            &SHOT.0,
            SHOT_W,
            SHOT_H,
            spec::psm::PSM_8888,
            spec::img::FLAG_LINEAR,
        );
    }
}

/// spec op 41 — the shot texture handle, -1 when none was captured.
pub unsafe fn shot_handle() -> i32 {
    SHOT_HANDLE
}
