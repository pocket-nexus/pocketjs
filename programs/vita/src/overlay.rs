//! Native text overlays drawn with vita2d's firmware font, outside the
//! guest's UI and pak. Call inside an open scene: the program's own scene, or
//! the closure of `Runtime::render_with_overlay`. The font is loaded once and
//! retained for the process lifetime.
use std::ffi::CString;
use vita2d_sys::*;

static mut FONT: *mut vita2d_pgf = std::ptr::null_mut();

unsafe fn font() -> *mut vita2d_pgf {
    if FONT.is_null() {
        FONT = vita2d_load_default_pgf();
    }
    FONT
}

/// A program without a guest it can start: one line saying what is wrong,
/// and how to leave.
pub unsafe fn notice(line: &str) {
    let font = font();
    if font.is_null() {
        return;
    }
    vita2d_disable_clipping();
    let text = CString::new(line.replace('\0', " ")).unwrap();
    vita2d_pgf_draw_text(font, 48, 72, 0xffef_eeea, 1.0, text.as_ptr());
    vita2d_pgf_draw_text(font, 48, 112, 0xff9a_9590, 1.0, c"Press the PS button to leave.".as_ptr());
}

/// A panel over the guest with up to 13 lines; the first is its title.
pub unsafe fn panel(lines: &[String]) {
    let font = font();
    vita2d_disable_clipping();
    vita2d_draw_rectangle(36.0, 28.0, 888.0, 488.0, 0xf51c_1410);
    vita2d_draw_rectangle(36.0, 28.0, 6.0, 488.0, 0xffdf_d366);
    if font.is_null() {
        return;
    }
    for (i, line) in lines.iter().take(13).enumerate() {
        let text = CString::new(line.replace('\0', " ")).unwrap();
        vita2d_pgf_draw_text(
            font,
            64,
            66 + i as i32 * 33,
            if i == 0 { 0xffdf_d366 } else { 0xffef_eeea },
            1.0,
            text.as_ptr(),
        );
    }
}
