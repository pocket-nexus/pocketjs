//! QuickJS bindings: the `globalThis.ui` namespace — the PSP side of the
//! HostOps contract (contracts/spec/spec.ts OP table; JS caller in framework/src/host.ts).
//!
//! Registration pattern copied from dreamcart runtime/src/gfx.rs register():
//! JS_NewCFunction2 + JS_SetPropertyStr onto a JS_NewObject installed on the
//! global (JS_SetPropertyStr consumes ownership).
//!
//! One `Ui` instance, one JS thread — `static mut` matches the established
//! dreamcart style. All ops are synchronous; the JS renderer keeps a mirror
//! tree so reconciler reads never cross this boundary.
//!
//! Extra (not a spec op): `ui.__textures` — a plain JS object mapping the
//! pak image names (`ui:img.<name>` -> `<name>`) to their upload_texture
//! handles, built at boot from pak::feed's table. framework/src/index.ts's PSP branch
//! walks it and calls renderer.registerTexture(name, handle) so JSX
//! `src="<name>"` resolves.

use alloc::string::String;
use alloc::vec::Vec;

use libquickjs_sys::*;
use pocketjs_core::Ui;

static mut UI: Option<Ui> = None;

/// Create the single core instance (call once, on the worker thread, AFTER
/// the arena-backed global allocator is linked in — Ui::new allocates).
pub unsafe fn init_ui() -> &'static mut Ui {
    UI = Some(Ui::new());
    ui()
}

/// The single core instance. Panics if init_ui was never called.
pub unsafe fn ui() -> &'static mut Ui {
    UI.as_mut().expect("ffi::init_ui not called")
}

// ---------------------------------------------------------------------------
// arg helpers
// ---------------------------------------------------------------------------

#[inline]
pub unsafe fn arg_i32(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> i32 {
    if (i as i32) >= argc {
        return 0;
    }
    let mut out: i32 = 0;
    JS_ToInt32(ctx, &mut out, *argv.offset(i));
    out
}

#[inline]
pub unsafe fn arg_f64(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> f64 {
    if (i as i32) >= argc {
        return 0.0;
    }
    let mut out: f64 = 0.0;
    JS_ToFloat64(ctx, &mut out, *argv.offset(i));
    out
}

/// Borrow the bytes behind an ArrayBuffer OR a typed-array view (host.ts
/// passes Uint8Arrays). The returned pointer is only valid until the next JS
/// allocation — callers must consume it before returning to JS.
unsafe fn buffer_bytes(ctx: *mut JSContext, val: JSValue) -> Option<(*const u8, usize)> {
    let mut len: size_t = 0;
    let p = JS_GetArrayBuffer(ctx, &mut len, val);
    if !p.is_null() {
        return Some((p as *const u8, len));
    }
    // Not an ArrayBuffer: clear the pending TypeError, try `.buffer` +
    // `.byteOffset`/`.byteLength` (typed-array view).
    JS_FreeValue(ctx, JS_GetException(ctx));
    let buf = JS_GetPropertyStr(ctx, val, b"buffer\0".as_ptr() as *const _);
    let mut blen: size_t = 0;
    let bp = JS_GetArrayBuffer(ctx, &mut blen, buf);
    // `val` retains its ArrayBuffer, so dropping this extra ref is safe.
    JS_FreeValue(ctx, buf);
    if bp.is_null() {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return None;
    }
    let off_v = JS_GetPropertyStr(ctx, val, b"byteOffset\0".as_ptr() as *const _);
    let mut off: i32 = 0;
    JS_ToInt32(ctx, &mut off, off_v);
    JS_FreeValue(ctx, off_v);
    let len_v = JS_GetPropertyStr(ctx, val, b"byteLength\0".as_ptr() as *const _);
    let mut vlen: i32 = 0;
    JS_ToInt32(ctx, &mut vlen, len_v);
    JS_FreeValue(ctx, len_v);
    if off < 0 || vlen < 0 || (off as usize) + (vlen as usize) > blen {
        return None;
    }
    Some((bp.add(off as usize) as *const u8, vlen as usize))
}

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

unsafe extern "C" fn js_create_node(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let t = arg_i32(ctx, argc, argv, 0);
    JS_NewInt32(ctx, ui().create_node(t as u8))
}

unsafe extern "C" fn js_destroy_node(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().destroy_node(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn js_insert_before(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().insert_before(
        arg_i32(ctx, argc, argv, 0),
        arg_i32(ctx, argc, argv, 1),
        arg_i32(ctx, argc, argv, 2),
    );
    JS_UNDEFINED
}

unsafe extern "C" fn js_remove_child(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().remove_child(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1));
    JS_UNDEFINED
}

unsafe extern "C" fn js_set_style(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_style(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1));
    JS_UNDEFINED
}

unsafe extern "C" fn js_set_prop(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_prop(
        arg_i32(ctx, argc, argv, 0),
        arg_i32(ctx, argc, argv, 1) as u8,
        arg_f64(ctx, argc, argv, 2),
    );
    JS_UNDEFINED
}

#[inline]
fn read_f64_le(bytes: &[u8], offset: usize) -> f64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&bytes[offset..offset + 8]);
    f64::from_le_bytes(raw)
}

/// Apply packed Float64 triples `[nodeId, propId, value]` through one
/// QuickJS/C boundary. The buffer is borrowed only for this synchronous call.
unsafe extern "C" fn js_set_prop_batch(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_UNDEFINED;
    }
    let Some((ptr, len)) = buffer_bytes(ctx, *argv.offset(0)) else {
        return JS_UNDEFINED;
    };
    let bytes = core::slice::from_raw_parts(ptr, len);
    let instance = ui();
    for record in bytes.chunks_exact(24) {
        instance.set_prop(
            read_f64_le(record, 0) as i32,
            read_f64_le(record, 8) as u8,
            read_f64_le(record, 16),
        );
    }
    JS_UNDEFINED
}

/// Shared body of setText/replaceText (identical core semantics).
unsafe fn set_text_impl(ctx: *mut JSContext, argc: i32, argv: *mut JSValue) -> JSValue {
    if argc < 2 {
        return JS_UNDEFINED;
    }
    let id = arg_i32(ctx, argc, argv, 0);
    let mut len: size_t = 0;
    let s = JS_ToCStringLen2(ctx, &mut len, *argv.offset(1), 0);
    if s.is_null() {
        return JS_UNDEFINED;
    }
    // Lossy: QuickJS encodes lone UTF-16 surrogates (e.g. a string sliced
    // mid-emoji) as WTF-8 bytes that are invalid UTF-8 — they become U+FFFD
    // (matching the web host) instead of silently dropping the whole update.
    let text =
        alloc::string::String::from_utf8_lossy(core::slice::from_raw_parts(s as *const u8, len));
    ui().set_text(id, &text);
    JS_FreeCString(ctx, s);
    JS_UNDEFINED
}

unsafe extern "C" fn js_set_text(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    set_text_impl(ctx, argc, argv)
}

unsafe extern "C" fn js_replace_text(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    set_text_impl(ctx, argc, argv)
}

unsafe extern "C" fn js_upload_texture(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 4 {
        return JS_NewInt32(ctx, -1);
    }
    let Some((p, len)) = buffer_bytes(ctx, *argv.offset(0)) else {
        return JS_NewInt32(ctx, -1);
    };
    let w = arg_i32(ctx, argc, argv, 1);
    let h = arg_i32(ctx, argc, argv, 2);
    let psm = arg_i32(ctx, argc, argv, 3);
    let bytes = core::slice::from_raw_parts(p, len);
    let handle = ui().upload_texture(bytes, w as u32, h as u32, psm as u32);
    if handle >= 0 {
        // GE samples RAM: write the core's aligned copy (pixels + CLUT) back
        // once at upload.
        crate::ge::writeback_texture(ui(), handle);
    }
    JS_NewInt32(ctx, handle)
}

/// loadTileTexture(key, index) -> handle | -1 (spec op 23): decode ONE tile
/// of a TILESET pak entry, looked up by key in the embedded pak at runtime
/// (pak::feed skips `ui:tile.*` — tiles stream on demand, they never bulk-
/// load at boot). Missing pak/key and malformed entries all surface as -1.
unsafe extern "C" fn js_load_tile_texture(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 2 {
        return JS_NewInt32(ctx, -1);
    }
    let mut len: size_t = 0;
    let s = JS_ToCStringLen2(ctx, &mut len, *argv.offset(0), 0);
    if s.is_null() {
        return JS_NewInt32(ctx, -1);
    }
    // Pak keys are UTF-8 by construction (framework/compiler/pak.ts); a WTF-8 lone
    // surrogate from JS can't match any entry, so treat it as a miss.
    let handle = match core::str::from_utf8(core::slice::from_raw_parts(s as *const u8, len)) {
        Ok(key) => match crate::pak::find(crate::pak::installed(), key) {
            Some(blob) => ui().upload_tileset_tile(blob, arg_i32(ctx, argc, argv, 1) as u32),
            None => -1,
        },
        Err(_) => -1,
    };
    JS_FreeCString(ctx, s);
    if handle >= 0 {
        crate::ge::writeback_texture(ui(), handle);
    }
    JS_NewInt32(ctx, handle)
}

/// freeTexture(handle) (spec op 24). Stale/unknown handles are no-ops in the
/// core, so no validation here.
unsafe extern "C" fn js_free_texture(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().free_texture(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

/// uploadImgEntry(blob) -> handle | -1 (spec op 25): a self-contained IMG
/// pak entry (header + flags + pixel stream), the dynamic-image counterpart
/// of the boot-time `ui:img.*` feed.
unsafe extern "C" fn js_upload_img_entry(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewInt32(ctx, -1);
    }
    let Some((p, len)) = buffer_bytes(ctx, *argv.offset(0)) else {
        return JS_NewInt32(ctx, -1);
    };
    let handle = ui().upload_img_entry(core::slice::from_raw_parts(p, len));
    if handle >= 0 {
        crate::ge::writeback_texture(ui(), handle);
    }
    JS_NewInt32(ctx, handle)
}

unsafe extern "C" fn js_set_image(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_image(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1));
    JS_UNDEFINED
}

unsafe extern "C" fn js_set_sprite(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_sprite(
        arg_i32(ctx, argc, argv, 0),
        arg_i32(ctx, argc, argv, 1),
        arg_i32(ctx, argc, argv, 2) as u32,
        arg_i32(ctx, argc, argv, 3) as u32,
        arg_i32(ctx, argc, argv, 4) as u32,
    );
    JS_UNDEFINED
}

unsafe extern "C" fn js_animate(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let id = arg_i32(ctx, argc, argv, 0);
    let prop = arg_i32(ctx, argc, argv, 1) as u8;
    let to = arg_f64(ctx, argc, argv, 2);
    let dur = arg_i32(ctx, argc, argv, 3).max(0) as u32;
    let easing = arg_i32(ctx, argc, argv, 4) as u8;
    let delay = arg_i32(ctx, argc, argv, 5).max(0) as u32;
    JS_NewInt32(ctx, ui().animate(id, prop, to, dur, easing, delay))
}

unsafe extern "C" fn js_cancel_anim(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().cancel_anim(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn js_set_focus(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_focus(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn js_set_active(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_active(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1) != 0);
    JS_UNDEFINED
}

// Virtual cursor ops (spec ops 27..29, input.cursor).

unsafe extern "C" fn js_hit_test(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let id = ui().hit_test(arg_f64(ctx, argc, argv, 0) as f32, arg_f64(ctx, argc, argv, 1) as f32);
    JS_NewInt32(ctx, id)
}

unsafe extern "C" fn js_set_cursor(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_cursor(
        arg_i32(ctx, argc, argv, 0),
        arg_f64(ctx, argc, argv, 1) as f32,
        arg_f64(ctx, argc, argv, 2) as f32,
        arg_f64(ctx, argc, argv, 3) as f32,
        arg_f64(ctx, argc, argv, 4) as f32,
    );
    JS_UNDEFINED
}

unsafe extern "C" fn js_set_cursor_pos(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_cursor_pos(arg_f64(ctx, argc, argv, 0) as f32, arg_f64(ctx, argc, argv, 1) as f32);
    JS_UNDEFINED
}

/// Not used on PSP (pak.rs feeds the core natively before eval), but
/// registered so the full HostOps surface exists. Returns bool.
unsafe extern "C" fn js_load_styles(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewBool(ctx, false);
    }
    let Some((p, len)) = buffer_bytes(ctx, *argv.offset(0)) else {
        return JS_NewBool(ctx, false);
    };
    let ok = ui().load_styles(core::slice::from_raw_parts(p, len));
    JS_NewBool(ctx, ok)
}

unsafe extern "C" fn js_load_font_atlas(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewBool(ctx, false);
    }
    let Some((p, len)) = buffer_bytes(ctx, *argv.offset(0)) else {
        return JS_NewBool(ctx, false);
    };
    let ok = ui().load_font_atlas(core::slice::from_raw_parts(p, len));
    JS_NewBool(ctx, ok)
}

unsafe extern "C" fn js_measure_text(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewFloat64(ctx, 0.0);
    }
    let mut len: size_t = 0;
    let s = JS_ToCStringLen2(ctx, &mut len, *argv.offset(0), 0);
    if s.is_null() {
        return JS_NewFloat64(ctx, 0.0);
    }
    let slot = arg_i32(ctx, argc, argv, 1) as u8;
    // Lossy for the same reason as set_text_impl: lone surrogates -> U+FFFD.
    let text =
        alloc::string::String::from_utf8_lossy(core::slice::from_raw_parts(s as *const u8, len));
    let width = ui().measure_text(&text, slot);
    JS_FreeCString(ctx, s);
    JS_NewFloat64(ctx, width as f64)
}

// ---------------------------------------------------------------------------
// DevTools (spec ops 18..22 + the mailbox transport; docs/DEVTOOLS.md)
// ---------------------------------------------------------------------------

// libquickjs-sys omits JS_NewStringLen; the linked QuickJS C library provides
// it (same local-extern pattern as main.rs's JS_NewArrayBuffer).
extern "C" {
    fn JS_NewStringLen(ctx: *mut JSContext, str1: *const u8, len1: usize) -> JSValue;
}

unsafe extern "C" fn js_debug_inspect(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().debug_inspect(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn js_debug_rect_xy(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewInt32(ctx, ui().debug_rect_xy())
}

unsafe extern "C" fn js_debug_rect_wh(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewInt32(ctx, ui().debug_rect_wh())
}

unsafe extern "C" fn js_debug_pause(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().debug_pause(arg_i32(ctx, argc, argv, 0) != 0);
    JS_UNDEFINED
}

unsafe extern "C" fn js_debug_step(
    _ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    ui().debug_step();
    JS_UNDEFINED
}

/// ui.__dbgActive() -> bool: whether the PSPLINK/memstick mailbox was found
/// at boot (dbg::init). The JS shim only builds a transport when true.
unsafe extern "C" fn js_dbg_active(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewBool(ctx, crate::dbg::active())
}

/// ui.__dbgPoll() -> string | undefined: new complete JSON lines from the
/// bridge (may batch several). The shim rate-limits calls to ~every 10
/// frames; each call is a few sceIo round trips over usbhostfs.
unsafe extern "C" fn js_dbg_poll(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    match crate::dbg::poll() {
        Some(s) => JS_NewStringLen(ctx, s.as_ptr(), s.len()),
        None => JS_UNDEFINED,
    }
}

/// ui.debugStats() -> string: one JSON snapshot of the diagnostic counters
/// plus build identity (spec OP.debugStats; see hosts/psp/src/stats.rs).
unsafe extern "C" fn js_debug_stats(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    let s = crate::stats::json();
    JS_NewStringLen(ctx, s.as_ptr(), s.len())
}

/// ui.appTable() -> string (spec op 39): the embedded app table + runtime
/// switch state, one JSON snapshot (docs/LAUNCHER.md).
unsafe extern "C" fn js_app_table(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    let s = crate::switch::table_json();
    JS_NewStringLen(ctx, s.as_ptr(), s.len())
}

/// ui.appLaunch(output) -> 0|1 (spec op 40): request a whole-guest switch
/// after the current frame presents.
unsafe extern "C" fn js_app_launch(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let scheduled = with_str_arg(ctx, argc, argv, 0, false, |output| {
        match crate::switch::find(output) {
            Some(index) => {
                crate::switch::request_launch(index);
                true
            }
            None => false,
        }
    });
    JS_NewInt32(ctx, scheduled as i32)
}

/// ui.appShot() -> handle | -1 (spec op 41): the summon's frozen-frame
/// texture in THIS guest's core.
unsafe extern "C" fn js_app_shot(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewInt32(ctx, crate::switch::shot_handle())
}

/// ui.__dbgShot() -> bool: dump the displayed framebuffer to
/// pocketjs-dbg/shot.raw (the bridge converts it to PNG panel-side).
unsafe extern "C" fn js_dbg_shot(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewBool(ctx, crate::dbg::shot())
}

/// ui.__dbgSend(line): append one JSON line to the outbound mailbox.
unsafe extern "C" fn js_dbg_send(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc >= 1 {
        let mut len: size_t = 0;
        let s = JS_ToCStringLen2(ctx, &mut len, *argv.offset(0), 0);
        if !s.is_null() {
            crate::dbg::send(core::slice::from_raw_parts(s as *const u8, len));
            JS_FreeCString(ctx, s);
        }
    }
    JS_UNDEFINED
}

// ---------------------------------------------------------------------------
// Host service channel + video plane (spec ops 30..37; svc.rs / vid.rs)
// ---------------------------------------------------------------------------

/// Borrow a JS string arg as UTF-8, feed it to `f`. Lone surrogates are a
/// miss (same reasoning as js_load_tile_texture: paths/names are UTF-8 by
/// construction on the host side).
unsafe fn with_str_arg<R>(
    ctx: *mut JSContext,
    argc: i32,
    argv: *mut JSValue,
    i: isize,
    miss: R,
    f: impl FnOnce(&str) -> R,
) -> R {
    if (i as i32) >= argc {
        return miss;
    }
    let mut len: size_t = 0;
    let s = JS_ToCStringLen2(ctx, &mut len, *argv.offset(i), 0);
    if s.is_null() {
        return miss;
    }
    let out = match core::str::from_utf8(core::slice::from_raw_parts(s as *const u8, len)) {
        Ok(v) => f(v),
        Err(_) => miss,
    };
    JS_FreeCString(ctx, s);
    out
}

/// ui.svcOpen(app) -> bool (spec op 30): probe pocket-svc/<app>/ under
/// host0: then ms0:.
unsafe extern "C" fn js_svc_open(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let ok = with_str_arg(ctx, argc, argv, 0, false, |app| crate::svc::open(app));
    JS_NewBool(ctx, ok)
}

/// ui.svcPoll() -> string | undefined (spec op 31): new complete lines from
/// the host. Callers own the cadence (the app driver polls once per frame).
unsafe extern "C" fn js_svc_poll(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    match crate::svc::poll() {
        Some(s) => JS_NewStringLen(ctx, s.as_ptr(), s.len()),
        None => JS_UNDEFINED,
    }
}

/// ui.svcSend(line) (spec op 32): append one JSON line to the outbox.
unsafe extern "C" fn js_svc_send(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc >= 1 {
        let mut len: size_t = 0;
        let s = JS_ToCStringLen2(ctx, &mut len, *argv.offset(0), 0);
        if !s.is_null() {
            crate::svc::send(core::slice::from_raw_parts(s as *const u8, len));
            JS_FreeCString(ctx, s);
        }
    }
    JS_UNDEFINED
}

/// ui.loadImgFile(path) -> handle | -1 (spec op 33): read a small IMG-entry
/// side file from the svc directory into a texture.
unsafe extern "C" fn js_load_img_file(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let handle = with_str_arg(ctx, argc, argv, 0, -1, |rel| {
        match crate::svc::read_side_file(rel, pocketjs_core::spec::svc::IMG_MAX_BYTES) {
            Some(blob) => ui().upload_img_entry(&blob),
            None => -1,
        }
    });
    if handle >= 0 {
        crate::ge::writeback_texture(ui(), handle);
    }
    JS_NewInt32(ctx, handle)
}

/// ui.videoOpen(path) -> bool (spec op 34): open a .pkst stream in the svc
/// directory, allocate the plane, start audio.
unsafe extern "C" fn js_video_open(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let ok = with_str_arg(ctx, argc, argv, 0, false, |rel| crate::vid::open(ui(), rel));
    JS_NewBool(ctx, ok)
}

/// ui.videoTick() -> frameIndex | -1 (spec op 35): the bounded per-frame IO
/// pump — call once per frame while a stream is open.
unsafe extern "C" fn js_video_tick(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewInt32(ctx, crate::vid::tick(ui()))
}

/// ui.videoTexture() -> handle | -1 (spec op 36).
unsafe extern "C" fn js_video_texture(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewInt32(ctx, crate::vid::texture())
}

/// ui.videoClose() (spec op 37).
unsafe extern "C" fn js_video_close(
    _ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    crate::vid::close(ui());
    JS_UNDEFINED
}

// ---------------------------------------------------------------------------
// audio module (contracts/spec/audio.ts — its own namespace, not ui ops)
// ---------------------------------------------------------------------------

unsafe extern "C" fn js_audio_create_stream(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let rate = arg_i32(ctx, argc, argv, 0);
    let channels = arg_i32(ctx, argc, argv, 1);
    JS_NewInt32(
        ctx,
        crate::audio_mod::create_stream(rate.max(0) as u32, channels.max(0) as u32),
    )
}

unsafe extern "C" fn js_audio_destroy_stream(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    crate::audio_mod::destroy_stream(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

/// audio.writePcm(handle, buf) -> framesAccepted. The buffer is BORROWED for
/// the call (spec data contract): bytes are copied into the stream ring
/// before returning, exactly the buffer_bytes lifetime rule.
unsafe extern "C" fn js_audio_write_pcm(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let handle = arg_i32(ctx, argc, argv, 0);
    if argc < 2 {
        return JS_NewInt32(ctx, 0);
    }
    let Some((ptr, len)) = buffer_bytes(ctx, *argv.offset(1)) else {
        return JS_NewInt32(ctx, 0);
    };
    // s16 LE on a LE machine: reinterpret, tolerating a truncated odd byte.
    let pcm = core::slice::from_raw_parts(ptr as *const i16, len / 2);
    JS_NewInt32(ctx, crate::audio_mod::write_pcm(handle, pcm))
}

unsafe extern "C" fn js_audio_play(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    crate::audio_mod::play(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn js_audio_pause(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    crate::audio_mod::pause(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn js_audio_stop(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    crate::audio_mod::stop(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn js_audio_set_volume(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    crate::audio_mod::set_volume(arg_i32(ctx, argc, argv, 0), arg_f64(ctx, argc, argv, 1));
    JS_UNDEFINED
}

unsafe extern "C" fn js_audio_end_stream(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    crate::audio_mod::end_stream(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn js_audio_poll(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    match crate::audio_mod::poll() {
        Some(s) => JS_NewStringLen(ctx, s.as_ptr(), s.len()),
        None => JS_UNDEFINED,
    }
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/// Register one C function onto a JS object (shared by extra surfaces
/// like OpenStrike's `strike` namespace).
pub unsafe fn add_fn(
    ctx: *mut JSContext,
    obj: JSValue,
    name: &'static [u8], // NUL-terminated
    f: unsafe extern "C" fn(*mut JSContext, JSValue, i32, *mut JSValue) -> JSValue,
    nargs: i32,
) {
    let v = JS_NewCFunction2(ctx, Some(f), name.as_ptr() as *const _, nargs, JS_CFUNC_generic, 0);
    JS_SetPropertyStr(ctx, obj, name.as_ptr() as *const _, v);
}

/// Install `globalThis.ui` (full HostOps surface + target identity, textures,
/// and sprites).
/// `textures` and `sprites` come from pak::feed.
unsafe extern "C" fn js_offload_session(
    ctx: *mut JSContext,
    _: JSValue,
    _: i32,
    _: *mut JSValue,
) -> JSValue {
    JS_NewInt32(ctx, crate::offload::session())
}
unsafe extern "C" fn js_offload_submit(
    ctx: *mut JSContext,
    _: JSValue,
    n: i32,
    a: *mut JSValue,
) -> JSValue {
    if n < 1 {
        return JS_NewBool(ctx, false);
    }
    let mut len = 0;
    let p = JS_ToCStringLen2(ctx, &mut len, *a, 0);
    if p.is_null() {
        return JS_NewBool(ctx, false);
    }
    let ok = crate::offload::submit(core::slice::from_raw_parts(p as *const u8, len));
    JS_FreeCString(ctx, p);
    if ok {
        JS_NewBool(ctx, true)
    } else {
        JS_NewBool(ctx, false)
    }
}
unsafe extern "C" fn js_offload_take(
    ctx: *mut JSContext,
    _: JSValue,
    _: i32,
    _: *mut JSValue,
) -> JSValue {
    match crate::offload::take() {
        Some(s) => JS_NewStringLen(ctx, s.as_ptr(), s.len()),
        None => JS_UNDEFINED,
    }
}
pub unsafe fn register(
    ctx: *mut JSContext,
    global: JSValue,
    textures: &[(String, i32)],
    sprites: &[crate::pak::SpriteReg],
) {
    if crate::offload::enabled() {
        crate::offload::start();
        let io = JS_NewObject(ctx);
        add_fn(ctx, io, b"session\0", js_offload_session, 0);
        add_fn(ctx, io, b"submit\0", js_offload_submit, 1);
        add_fn(ctx, io, b"take\0", js_offload_take, 0);
        JS_SetPropertyStr(ctx, global, b"offload\0".as_ptr() as *const _, io);
    }
    let ui_obj = JS_NewObject(ctx);

    add_fn(ctx, ui_obj, b"createNode\0", js_create_node, 1);
    add_fn(ctx, ui_obj, b"destroyNode\0", js_destroy_node, 1);
    add_fn(ctx, ui_obj, b"insertBefore\0", js_insert_before, 3);
    add_fn(ctx, ui_obj, b"removeChild\0", js_remove_child, 2);
    add_fn(ctx, ui_obj, b"setStyle\0", js_set_style, 2);
    add_fn(ctx, ui_obj, b"setProp\0", js_set_prop, 3);
    add_fn(ctx, ui_obj, b"setPropBatch\0", js_set_prop_batch, 1);
    add_fn(ctx, ui_obj, b"setText\0", js_set_text, 2);
    add_fn(ctx, ui_obj, b"replaceText\0", js_replace_text, 2);
    add_fn(ctx, ui_obj, b"uploadTexture\0", js_upload_texture, 4);
    add_fn(ctx, ui_obj, b"setImage\0", js_set_image, 2);
    add_fn(ctx, ui_obj, b"setSprite\0", js_set_sprite, 5);
    add_fn(ctx, ui_obj, b"animate\0", js_animate, 6);
    add_fn(ctx, ui_obj, b"cancelAnim\0", js_cancel_anim, 1);
    add_fn(ctx, ui_obj, b"setFocus\0", js_set_focus, 1);
    add_fn(ctx, ui_obj, b"setActive\0", js_set_active, 2);
    // Virtual cursor ops (spec ops 27..29, input.cursor).
    add_fn(ctx, ui_obj, b"hitTest\0", js_hit_test, 2);
    add_fn(ctx, ui_obj, b"setCursor\0", js_set_cursor, 5);
    add_fn(ctx, ui_obj, b"setCursorPos\0", js_set_cursor_pos, 2);
    add_fn(ctx, ui_obj, b"loadStyles\0", js_load_styles, 1);
    add_fn(ctx, ui_obj, b"loadFontAtlas\0", js_load_font_atlas, 1);
    add_fn(ctx, ui_obj, b"measureText\0", js_measure_text, 2);
    // DevTools ops + mailbox transport (docs/DEVTOOLS.md; debug-only, default-off).
    add_fn(ctx, ui_obj, b"debugInspect\0", js_debug_inspect, 1);
    add_fn(ctx, ui_obj, b"debugRectXY\0", js_debug_rect_xy, 0);
    add_fn(ctx, ui_obj, b"debugRectWH\0", js_debug_rect_wh, 0);
    add_fn(ctx, ui_obj, b"debugPause\0", js_debug_pause, 1);
    add_fn(ctx, ui_obj, b"debugStep\0", js_debug_step, 0);
    // Texture streaming ops (spec ops 23..25: deep-zoom tiles + dynamic IMGs).
    add_fn(ctx, ui_obj, b"loadTileTexture\0", js_load_tile_texture, 2);
    add_fn(ctx, ui_obj, b"freeTexture\0", js_free_texture, 1);
    add_fn(ctx, ui_obj, b"uploadImgEntry\0", js_upload_img_entry, 1);
    add_fn(ctx, ui_obj, b"__dbgActive\0", js_dbg_active, 0);
    add_fn(ctx, ui_obj, b"__dbgPoll\0", js_dbg_poll, 0);
    add_fn(ctx, ui_obj, b"__dbgSend\0", js_dbg_send, 1);
    add_fn(ctx, ui_obj, b"debugStats\0", js_debug_stats, 0);
    add_fn(ctx, ui_obj, b"__dbgShot\0", js_dbg_shot, 0);
    // Host service channel + video plane (spec ops 30..37; svc.rs / vid.rs).
    add_fn(ctx, ui_obj, b"svcOpen\0", js_svc_open, 1);
    add_fn(ctx, ui_obj, b"svcPoll\0", js_svc_poll, 0);
    add_fn(ctx, ui_obj, b"svcSend\0", js_svc_send, 1);
    add_fn(ctx, ui_obj, b"loadImgFile\0", js_load_img_file, 1);
    add_fn(ctx, ui_obj, b"videoOpen\0", js_video_open, 1);
    add_fn(ctx, ui_obj, b"videoTick\0", js_video_tick, 0);
    add_fn(ctx, ui_obj, b"videoTexture\0", js_video_texture, 0);
    add_fn(ctx, ui_obj, b"videoClose\0", js_video_close, 0);
    // App switching (spec ops 39..41, docs/LAUNCHER.md). Only multi-app hosts
    // carry the ops — single-app EBOOTs omit them, the spec's stated
    // degraded mode, so their guests behave exactly as before.
    if crate::switch::multi() {
        add_fn(ctx, ui_obj, b"appTable\0", js_app_table, 0);
        add_fn(ctx, ui_obj, b"appLaunch\0", js_app_launch, 1);
        add_fn(ctx, ui_obj, b"appShot\0", js_app_shot, 0);
    }

    // Framework-owned host identity. JS uses this for target/profile
    // diagnostics only; native-vs-injected ownership is determined by the
    // global namespace itself, never by a target-name branch.
    let target = env!("POCKETJS_TARGET");
    JS_SetPropertyStr(
        ctx,
        ui_obj,
        b"__host\0".as_ptr() as *const _,
        JS_NewStringLen(ctx, target.as_ptr(), target.len()),
    );
    // build.rs validated this is a positive integer; a parse failure here
    // would mean the two fell out of sync, so fail loudly rather than ship 0.
    let host_abi = env!("POCKETJS_HOST_ABI")
        .parse::<i32>()
        .expect("POCKETJS_HOST_ABI validated by build.rs");
    JS_SetPropertyStr(
        ctx,
        ui_obj,
        b"__hostAbi\0".as_ptr() as *const _,
        JS_NewInt32(ctx, host_abi),
    );

    // ui.__textures: pak image name -> texture handle (see module docs).
    let tex_obj = JS_NewObject(ctx);
    for (name, handle) in textures {
        let mut cname: Vec<u8> = Vec::with_capacity(name.len() + 1);
        cname.extend_from_slice(name.as_bytes());
        cname.push(0);
        JS_SetPropertyStr(
            ctx,
            tex_obj,
            cname.as_ptr() as *const _,
            JS_NewInt32(ctx, *handle),
        );
    }
    JS_SetPropertyStr(ctx, ui_obj, b"__textures\0".as_ptr() as *const _, tex_obj);

    // ui.__sprites: pak sprite name -> { handle, frames, cols, step }. The JS
    // runtime (framework/src/index.ts) reads these and registerSprite()s them; <Sprite>
    // then binds via setSprite. Same feed-once-at-boot pattern as __textures.
    let spr_obj = JS_NewObject(ctx);
    for s in sprites {
        let mut cname: Vec<u8> = Vec::with_capacity(s.name.len() + 1);
        cname.extend_from_slice(s.name.as_bytes());
        cname.push(0);
        let meta = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, meta, b"handle\0".as_ptr() as *const _, JS_NewInt32(ctx, s.handle));
        JS_SetPropertyStr(ctx, meta, b"frames\0".as_ptr() as *const _, JS_NewInt32(ctx, s.frames as i32));
        JS_SetPropertyStr(ctx, meta, b"cols\0".as_ptr() as *const _, JS_NewInt32(ctx, s.cols as i32));
        JS_SetPropertyStr(ctx, meta, b"step\0".as_ptr() as *const _, JS_NewInt32(ctx, s.step as i32));
        JS_SetPropertyStr(ctx, spr_obj, cname.as_ptr() as *const _, meta);
    }
    JS_SetPropertyStr(ctx, ui_obj, b"__sprites\0".as_ptr() as *const _, spr_obj);

    // JS_SetPropertyStr consumes ownership of ui_obj.
    JS_SetPropertyStr(ctx, global, b"ui\0".as_ptr() as *const _, ui_obj);

    register_audio(ctx, global);
}

/// Install `globalThis.audio` — the audio MODULE as its own namespace
/// (capability audio.pcm = spec namespace, contracts/spec/audio.ts), the
/// pocket-mod `mount("audio", …)` shape spelled in raw QuickJS.
///
/// Separate from [`register`] so a host with its own surface instead of `ui`
/// (pocketvoxel-psp's `voxel`) can mount the module without the UI ops. The
/// mixer thread and hardware channel start lazily on the first createStream.
///
/// # Safety
/// QuickJS context alive, worker thread.
pub unsafe fn register_audio(ctx: *mut JSContext, global: JSValue) {
    let audio_obj = JS_NewObject(ctx);
    add_fn(ctx, audio_obj, b"createStream\0", js_audio_create_stream, 2);
    add_fn(ctx, audio_obj, b"destroyStream\0", js_audio_destroy_stream, 1);
    add_fn(ctx, audio_obj, b"writePcm\0", js_audio_write_pcm, 2);
    add_fn(ctx, audio_obj, b"play\0", js_audio_play, 1);
    add_fn(ctx, audio_obj, b"pause\0", js_audio_pause, 1);
    add_fn(ctx, audio_obj, b"stop\0", js_audio_stop, 1);
    add_fn(ctx, audio_obj, b"setVolume\0", js_audio_set_volume, 2);
    add_fn(ctx, audio_obj, b"endStream\0", js_audio_end_stream, 1);
    add_fn(ctx, audio_obj, b"poll\0", js_audio_poll, 0);
    JS_SetPropertyStr(ctx, global, b"audio\0".as_ptr() as *const _, audio_obj);
}
