//! Program diagnostics and guest helpers; platform mechanisms are explicit dependencies.
use libquickjs_sys::*;
pub use pocket_psp_display::{list_ptr, read_display_rows_rgba, take_render_memory, GfxConfig};
pub use pocket_psp_system::*;
use psp::sys;
pub unsafe fn init_graphics(config: GfxConfig) {
    if let Err(error) = pocket_psp_display::init_graphics(config) {
        halt(error);
    }
}
pub unsafe fn init_graphics_with_format(config: GfxConfig, format: sys::DisplayPixelFormat) {
    if let Err(error) = pocket_psp_display::init_graphics_with_format(config, format) {
        halt(error);
    }
}
/// Fatal-error handler: message on the debug screen, then park on vblank
/// (HOME still exits).
pub unsafe fn halt(msg: &str) -> ! {
    psp::dprintln!("[PocketJS halt] {}", msg);
    psp::dprintln!("HOME exits. Last stage stays on screen.");
    loop {
        sys::sceDisplayWaitVblankStart();
    }
}

// libquickjs-sys omits JS_ExecutePendingJob; the linked QuickJS C library
// provides it (local-extern pattern). size_t stays usize (MIPS o32).
extern "C" {
    fn JS_ExecutePendingJob(rt: *mut JSRuntime, pctx: *mut *mut JSContext) -> i32;
}

/// Drain queued microtask jobs (queueMicrotask polyfill = promise jobs).
pub unsafe fn drain_jobs(rt: *mut JSRuntime) {
    loop {
        let mut pctx: *mut JSContext = core::ptr::null_mut();
        if JS_ExecutePendingJob(rt, &mut pctx) <= 0 {
            break;
        }
    }
}

/// Print the pending JS exception via the debug screen; `sink` also receives
/// the message (trace files, mailboxes).
pub unsafe fn log_exception_with(ctx: *mut JSContext, sink: impl Fn(&str)) {
    let e = JS_GetException(ctx);
    let mut len: size_t = 0;
    let s = JS_ToCStringLen2(ctx, &mut len, e, 0);
    if !s.is_null() {
        if let Ok(msg) = core::str::from_utf8(core::slice::from_raw_parts(s as *const u8, len)) {
            sink(msg);
            psp::dprintln!("[PocketJS js error] {}", msg);
        }
        JS_FreeCString(ctx, s);
    }
    // Diagnostics for opaque exception values: report the tag and, for
    // objects, the message/stack properties individually (a throw whose
    // toString fails stringifies as "null" above and hides the cause).
    // JS_TAG_OBJECT (-1) is absent from the PSP bindings surface.
    const TAG_OBJECT: i32 = -1;
    sink(&alloc::format!("exception tag={}", JS_ValueGetTag(e)));
    if JS_ValueGetTag(e) == TAG_OBJECT {
        for prop in [b"message\0".as_ptr(), b"stack\0".as_ptr()] {
            let v = JS_GetPropertyStr(ctx, e, prop as *const core::ffi::c_char);
            let mut plen: size_t = 0;
            let ps = JS_ToCStringLen2(ctx, &mut plen, v, 0);
            if !ps.is_null() {
                if let Ok(pmsg) =
                    core::str::from_utf8(core::slice::from_raw_parts(ps as *const u8, plen))
                {
                    sink(pmsg);
                }
                JS_FreeCString(ctx, ps);
            }
            JS_FreeValue(ctx, v);
        }
    }
    JS_FreeValue(ctx, e);
}
