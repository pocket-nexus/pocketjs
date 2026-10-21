//! Host-owned menu. vita2d's firmware font stays outside the guest's UI/PAK.
use std::ffi::CString;
use vita2d_sys::*;

mod input;
pub use input::{Action, Menu};

static mut FONT: *mut vita2d_pgf = std::ptr::null_mut();

/// The generic runtime without a game it can start: one line saying what is
/// wrong, and how to leave. Called inside the host's open scene.
pub unsafe fn notice(line: &str) {
    if FONT.is_null() {
        FONT = vita2d_load_default_pgf();
    }
    if FONT.is_null() {
        return;
    }
    vita2d_disable_clipping();
    let text = CString::new(line.replace('\0', " ")).unwrap();
    vita2d_pgf_draw_text(FONT, 48, 72, 0xffef_eeea, 1.0, text.as_ptr());
    vita2d_pgf_draw_text(FONT, 48, 112, 0xff9a_9590, 1.0, c"Press the PS button to leave.".as_ptr());
}

/// Called inside the host's open scene. Font is retained for the process lifetime.
pub unsafe fn draw(lines: &[String]) {
    if FONT.is_null() {
        FONT = vita2d_load_default_pgf();
    }
    vita2d_disable_clipping();
    vita2d_draw_rectangle(36.0, 28.0, 888.0, 488.0, 0xf51c_1410);
    vita2d_draw_rectangle(36.0, 28.0, 6.0, 488.0, 0xffdf_d366);
    if FONT.is_null() {
        return;
    }
    for (i, line) in lines.iter().take(13).enumerate() {
        let text = CString::new(line.replace('\0', " ")).unwrap();
        vita2d_pgf_draw_text(
            FONT,
            64,
            66 + i as i32 * 33,
            if i == 0 { 0xffdf_d366 } else { 0xffef_eeea },
            1.0,
            text.as_ptr(),
        );
    }
}
