//! PSP private audio, debugger, offload, link and media extensions. Public UI methods are
//! generated and dispatch to the active Runtime's OpContext.
use alloc::{string::String, vec::Vec};
use libquickjs_sys::*;
extern "C" {
    fn JS_NewStringLen(ctx: *mut JSContext, text: *const u8, length: usize) -> JSValue;
    fn JS_ToBool(ctx: *mut JSContext, value: JSValue) -> i32;
    fn JS_ParseJSON(
        ctx: *mut JSContext,
        buf: *const core::ffi::c_char,
        len: usize,
        filename: *const core::ffi::c_char,
    ) -> JSValue;
    fn JS_GetTypedArrayBuffer(
        ctx: *mut JSContext,
        value: JSValue,
        offset: *mut usize,
        length: *mut usize,
        element_size: *mut usize,
    ) -> JSValue;
}
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

/// Copy audio bytes before any later JS call. Native typed-array offsets are
/// read through QuickJS rather than user-controlled properties.
unsafe fn buffer_bytes(ctx: *mut JSContext, value: JSValue) -> Option<Vec<u8>> {
    let mut length = 0;
    let pointer = JS_GetArrayBuffer(ctx, &mut length, value);
    if !pointer.is_null() {
        return Some(core::slice::from_raw_parts(pointer, length).to_vec());
    }
    JS_FreeValue(ctx, JS_GetException(ctx));
    let (mut offset, mut count, mut element) = (0, 0, 0);
    let buffer = JS_GetTypedArrayBuffer(ctx, value, &mut offset, &mut count, &mut element);
    if JS_IsException(buffer) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return None;
    }
    let pointer = JS_GetArrayBuffer(ctx, &mut length, buffer);
    let bytes = if !pointer.is_null() && offset <= length && count <= length - offset {
        Some(core::slice::from_raw_parts(pointer.add(offset), count).to_vec())
    } else {
        None
    };
    JS_FreeValue(ctx, buffer);
    bytes
}
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
/// plus build identity (spec OP.debugStats; see programs/psp/src/stats.rs).
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

/// audio.writePcm(handle, buf) copies little-endian samples into the stream ring.
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
    let Some(bytes) = buffer_bytes(ctx, *argv.offset(1)) else {
        return JS_NewInt32(ctx, 0);
    };
    // Read unaligned views as little-endian samples, ignoring a final odd byte.
    let pcm: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    JS_NewInt32(ctx, crate::audio_mod::write_pcm(handle, &pcm))
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
    let v = JS_NewCFunction2(
        ctx,
        Some(f),
        name.as_ptr() as *const _,
        nargs,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, obj, name.as_ptr() as *const _, v);
}

unsafe extern "C" fn js_offload_session(
    ctx: *mut JSContext,
    _: JSValue,
    _: i32,
    _: *mut JSValue,
) -> JSValue {
    crate::offload::start();
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

unsafe extern "C" fn js_local_session(
    ctx: *mut JSContext,
    _: JSValue,
    _: i32,
    _: *mut JSValue,
) -> JSValue {
    crate::offload_local::start();
    JS_NewInt32(ctx, crate::offload_local::session())
}
unsafe extern "C" fn js_local_take(
    ctx: *mut JSContext,
    _: JSValue,
    _: i32,
    _: *mut JSValue,
) -> JSValue {
    match crate::offload_local::take() {
        Some(s) => JS_NewStringLen(ctx, s.as_ptr(), s.len()),
        None => JS_UNDEFINED,
    }
}
unsafe fn local_number(ctx: *mut JSContext, obj: JSValue, key: &[u8]) -> u32 {
    let v = JS_GetPropertyStr(ctx, obj, key.as_ptr() as *const _);
    let mut n = 0;
    JS_ToInt32(ctx, &mut n, v);
    JS_FreeValue(ctx, v);
    n as u32
}
unsafe fn local_string(ctx: *mut JSContext, obj: JSValue, key: &[u8]) -> String {
    let v = JS_GetPropertyStr(ctx, obj, key.as_ptr() as *const _);
    let mut n = 0;
    let p = JS_ToCStringLen2(ctx, &mut n, v, 0);
    let s = if !p.is_null() && n <= 4096 {
        String::from_utf8_lossy(core::slice::from_raw_parts(p as *const u8, n)).into_owned()
    } else {
        String::new()
    };
    if !p.is_null() {
        JS_FreeCString(ctx, p);
    }
    JS_FreeValue(ctx, v);
    s
}
unsafe extern "C" fn js_local_submit(
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
    if len > 4096 {
        JS_FreeCString(ctx, p);
        return JS_NewBool(ctx, false);
    }
    let obj = JS_ParseJSON(ctx, p, len, b"local request\0".as_ptr() as *const _);
    JS_FreeCString(ctx, p);
    if JS_IsException(obj) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return JS_NewBool(ctx, false);
    }
    let mut r = crate::offload_local::Request::empty();
    r.id = local_number(ctx, obj, b"id\0");
    let method = local_string(ctx, obj, b"method\0");
    let payload = local_string(ctx, obj, b"payload\0");
    let version = local_number(ctx, obj, b"v\0");
    JS_FreeValue(ctx, obj);
    if version != 1 || r.id == 0 {
        return JS_NewBool(ctx, false);
    }
    r.op = match method.as_str() {
        "font.open" => 1,
        "font.glyphs" => 2,
        "font.stats" => 3,
        "fs.read-text" => 4,
        "font.close" => 5,
        _ => 0,
    };
    if r.op == 1 || r.op == 4 {
        if payload.len() >= 128 {
            return JS_NewBool(ctx, false);
        }
        r.path[..payload.len()].copy_from_slice(payload.as_bytes());
    }
    if r.op == 2 {
        // QuickJS requires buf[buf_len] == 0 even when a length is supplied.
        // A Rust String does not carry that terminator; allocator reuse after
        // a UTF-8 file read otherwise makes valid glyph requests fail parsing.
        let Ok(json) = alloc::ffi::CString::new(payload.as_bytes()) else {
            return JS_NewBool(ctx, false);
        };
        let args = JS_ParseJSON(
            ctx,
            json.as_ptr(),
            payload.len(),
            b"font batch\0".as_ptr() as *const _,
        );
        if JS_IsException(args) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            return JS_NewBool(ctx, false);
        }
        r.generation = local_number(ctx, args, b"generation\0");
        let slot = local_number(ctx, args, b"slot\0");
        let cps = JS_GetPropertyStr(ctx, args, b"scalars\0".as_ptr() as *const _);
        let count = local_number(ctx, cps, b"length\0");
        if count > 0 && count <= 4 && slot < 24 {
            r.count = count as u8;
            r.slot = slot as u8;
            for i in 0..count {
                let key = [b'0' + i as u8, 0];
                r.cps[i as usize] = local_number(ctx, cps, &key);
            }
        }
        JS_FreeValue(ctx, cps);
        JS_FreeValue(ctx, args);
        if r.count == 0 {
            return JS_NewBool(ctx, false);
        }
    }
    JS_NewBool(ctx, crate::offload_local::submit(r))
}
/// A string argument as bytes, or None when absent/undefined. The caller
/// frees every returned pointer with JS_FreeCString.
unsafe fn arg_bytes(
    ctx: *mut JSContext,
    argc: i32,
    argv: *mut JSValue,
    i: isize,
) -> Option<(*const i8, &'static [u8])> {
    if (i as i32) >= argc || JS_IsUndefined(*argv.offset(i)) {
        return None;
    }
    let mut len: size_t = 0;
    let p = JS_ToCStringLen2(ctx, &mut len, *argv.offset(i), 0);
    if p.is_null() {
        return None;
    }
    Some((p, core::slice::from_raw_parts(p as *const u8, len)))
}
unsafe fn upload_decoded(
    ctx: *mut JSContext,
    decoded: Option<crate::offload_image::Decoded>,
) -> i32 {
    let Some(d) = decoded else { return -1 };
    crate::instance::with_ui(ctx, |ui| {
        ui.upload_texture(
            &d.bytes,
            d.width,
            d.height,
            pocketjs_core::spec::psm::PSM_T8,
        )
    })
    .unwrap_or(-1)
}
/// offload.uploadCoverage(base64, width, height, color, columns?, palette?) -> handle | -1:
/// the 3DS's native coverage upload, here as one PSM_T8 texture.
unsafe extern "C" fn js_offload_upload_coverage(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let Some((sp, text)) = arg_bytes(ctx, argc, argv, 0) else {
        return JS_NewInt32(ctx, -1);
    };
    let width = arg_i32(ctx, argc, argv, 1) as u32;
    let height = arg_i32(ctx, argc, argv, 2) as u32;
    let mut color: f64 = 0.0;
    if argc > 3 {
        JS_ToFloat64(ctx, &mut color, *argv.offset(3));
    }
    let columns = arg_bytes(ctx, argc, argv, 4);
    let palette = arg_bytes(ctx, argc, argv, 5);
    let handle = upload_decoded(
        ctx,
        crate::offload_image::coverage(
            text,
            width,
            height,
            color as u32,
            columns.map(|c| c.1),
            palette.map(|p| p.1),
        ),
    );
    JS_FreeCString(ctx, sp);
    if let Some((p, _)) = columns {
        JS_FreeCString(ctx, p);
    }
    if let Some((p, _)) = palette {
        JS_FreeCString(ctx, p);
    }
    JS_NewInt32(ctx, handle)
}
/// offload.uploadIndexedImage(pixels, width, height, palette) -> handle | -1:
/// a 16-colour 4 bpp reply as one PSM_T8 texture, no JS expansion.
unsafe extern "C" fn js_offload_upload_indexed(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let Some((pp, pixels)) = arg_bytes(ctx, argc, argv, 0) else {
        return JS_NewInt32(ctx, -1);
    };
    let Some((cp, palette)) = arg_bytes(ctx, argc, argv, 3) else {
        JS_FreeCString(ctx, pp);
        return JS_NewInt32(ctx, -1);
    };
    let width = arg_i32(ctx, argc, argv, 1) as u32;
    let height = arg_i32(ctx, argc, argv, 2) as u32;
    let handle = upload_decoded(
        ctx,
        crate::offload_image::indexed(pixels, width, height, palette),
    );
    JS_FreeCString(ctx, pp);
    JS_FreeCString(ctx, cp);
    JS_NewInt32(ctx, handle)
}
/// A typed array or ArrayBuffer argument as the guest's own bytes, for a
/// native call that fills it before returning to JS.
unsafe fn buffer_mut<'a>(ctx: *mut JSContext, value: JSValue) -> Option<&'a mut [u8]> {
    let mut length = 0;
    let pointer = JS_GetArrayBuffer(ctx, &mut length, value);
    if !pointer.is_null() {
        return Some(core::slice::from_raw_parts_mut(pointer, length));
    }
    JS_FreeValue(ctx, JS_GetException(ctx));
    let (mut offset, mut count, mut element) = (0, 0, 0);
    let buffer = JS_GetTypedArrayBuffer(ctx, value, &mut offset, &mut count, &mut element);
    if JS_IsException(buffer) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return None;
    }
    let pointer = JS_GetArrayBuffer(ctx, &mut length, buffer);
    JS_FreeValue(ctx, buffer);
    if pointer.is_null() || offset > length || count > length - offset {
        return None;
    }
    Some(core::slice::from_raw_parts_mut(pointer.add(offset), count))
}

// ---- globalThis.net and globalThis.link over the USB share (link.rs) ----------

/// net.start(metaJson, body) -> handle | -1 (contracts/spec/net.ts).
unsafe extern "C" fn js_net_start(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let Some((meta_ptr, meta)) = arg_bytes(ctx, argc, argv, 0) else {
        return JS_NewInt32(ctx, -1);
    };
    let body = if argc >= 2 {
        buffer_bytes(ctx, *argv.offset(1)).unwrap_or_default()
    } else {
        Vec::new()
    };
    let handle = crate::link::net_start(meta, &body, crate::switch::current_id());
    JS_FreeCString(ctx, meta_ptr);
    JS_NewInt32(ctx, handle)
}

/// net.take(handle, into) -> bytes copied | -1.
unsafe extern "C" fn js_net_take(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 2 {
        return JS_NewInt32(ctx, -1);
    }
    let handle = arg_i32(ctx, argc, argv, 0);
    match buffer_mut(ctx, *argv.offset(1)) {
        Some(into) => JS_NewInt32(ctx, crate::link::net_take(handle, into)),
        None => JS_NewInt32(ctx, -1),
    }
}

/// net.cancel(handle).
unsafe extern "C" fn js_net_cancel(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc >= 1 {
        crate::link::net_cancel(arg_i32(ctx, argc, argv, 0));
    }
    JS_UNDEFINED
}

/// net.poll() -> the tick's events as one JSON array | undefined.
unsafe extern "C" fn js_net_poll(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    match crate::link::net_poll() {
        Some(s) => JS_NewStringLen(ctx, s.as_ptr(), s.len()),
        None => JS_UNDEFINED,
    }
}

/// net.lastError() -> "code: message".
unsafe extern "C" fn js_net_last_error(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    let s = crate::link::net_last_error();
    JS_NewStringLen(ctx, s.as_ptr(), s.len())
}

/// link.status() -> LinkStatus JSON (contracts/spec/link.ts).
unsafe extern "C" fn js_link_status(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    let s = crate::link::link_status();
    JS_NewStringLen(ctx, s.as_ptr(), s.len())
}

/// link.pair / forget / remove: the USB carrier has no pairing and no
/// installs (the cable is the trust boundary), so each refuses.
unsafe extern "C" fn js_link_refuse(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewBool(ctx, false)
}

/// link.catalog / install -> -1: not carried over USB.
unsafe extern "C" fn js_link_no_request(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewInt32(ctx, -1)
}

/// link.poll() -> no link events over USB.
unsafe extern "C" fn js_link_poll(
    _ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_UNDEFINED
}
// ---- globalThis.media over the USB share's media ring (media.rs) ---------------

/// media.open(host, port, token) -> bool (contracts/spec/media.ts MediaOps).
unsafe extern "C" fn js_media_open(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let Some((pointer, token)) = arg_bytes(ctx, argc, argv, 2) else {
        return JS_NewBool(ctx, false);
    };
    let ok = crate::media::open(token);
    JS_FreeCString(ctx, pointer);
    JS_NewBool(ctx, ok)
}

unsafe extern "C" fn js_media_close(
    _ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    crate::media::close();
    JS_UNDEFINED
}

unsafe extern "C" fn js_media_paused(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    crate::media::set_paused(argc >= 1 && JS_ToBool(ctx, *argv) > 0);
    JS_UNDEFINED
}

unsafe extern "C" fn js_media_volume(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    crate::media::set_volume(arg_f64(ctx, argc, argv, 0) as f32);
    JS_UNDEFINED
}

unsafe extern "C" fn js_media_texture(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewInt32(ctx, crate::instance::with_ui(ctx, |ui| crate::media::texture(ui)).unwrap_or(-1))
}

unsafe extern "C" fn js_media_status(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    let s = crate::media::status();
    JS_NewStringLen(ctx, s.as_ptr(), s.len())
}
/// Mount private namespaces after the generated guest has created ui.
pub unsafe fn register_private(ctx: *mut JSContext, global: JSValue) {
    if crate::offload::enabled() {
        let io = JS_NewObject(ctx);
        add_fn(ctx, io, b"session\0", js_offload_session, 0);
        add_fn(ctx, io, b"submit\0", js_offload_submit, 1);
        add_fn(ctx, io, b"take\0", js_offload_take, 0);
        let local = JS_NewObject(ctx);
        add_fn(ctx, local, b"session\0", js_local_session, 0);
        add_fn(ctx, local, b"submit\0", js_local_submit, 1);
        add_fn(ctx, local, b"take\0", js_local_take, 0);
        JS_SetPropertyStr(ctx, io, b"local\0".as_ptr() as *const _, local);
        add_fn(ctx, io, b"uploadCoverage\0", js_offload_upload_coverage, 6);
        add_fn(
            ctx,
            io,
            b"uploadIndexedImage\0",
            js_offload_upload_indexed,
            4,
        );
        JS_SetPropertyStr(ctx, global, b"offload\0".as_ptr() as *const _, io);
    }
    let ui_obj = JS_GetPropertyStr(ctx, global, b"ui\0".as_ptr().cast());
    add_fn(ctx, ui_obj, b"__dbgActive\0", js_dbg_active, 0);
    add_fn(ctx, ui_obj, b"__dbgPoll\0", js_dbg_poll, 0);
    add_fn(ctx, ui_obj, b"__dbgSend\0", js_dbg_send, 1);
    add_fn(ctx, ui_obj, b"__dbgShot\0", js_dbg_shot, 0);
    JS_FreeValue(ctx, ui_obj);
    register_audio(ctx, global);
    register_link(ctx, global);
}
/// Install `globalThis.net`, `globalThis.link` and `globalThis.media`, all
/// carried by the companion on the USB share (link.rs, media.rs). The link starts here, before the
/// guest evaluates, so a request at mount finds a companion that answers.
///
/// # Safety
/// QuickJS context alive, worker thread.
pub unsafe fn register_link(ctx: *mut JSContext, global: JSValue) {
    crate::link::start(crate::profile::ID);
    let net = JS_NewObject(ctx);
    add_fn(ctx, net, b"start\0", js_net_start, 2);
    add_fn(ctx, net, b"take\0", js_net_take, 2);
    add_fn(ctx, net, b"cancel\0", js_net_cancel, 1);
    add_fn(ctx, net, b"poll\0", js_net_poll, 0);
    add_fn(ctx, net, b"lastError\0", js_net_last_error, 0);
    JS_SetPropertyStr(ctx, global, b"net\0".as_ptr() as *const _, net);
    let link = JS_NewObject(ctx);
    add_fn(ctx, link, b"status\0", js_link_status, 0);
    add_fn(ctx, link, b"pair\0", js_link_refuse, 1);
    add_fn(ctx, link, b"forget\0", js_link_refuse, 1);
    add_fn(ctx, link, b"remove\0", js_link_refuse, 1);
    add_fn(ctx, link, b"catalog\0", js_link_no_request, 0);
    add_fn(ctx, link, b"install\0", js_link_no_request, 1);
    add_fn(ctx, link, b"poll\0", js_link_poll, 0);
    JS_SetPropertyStr(ctx, global, b"link\0".as_ptr() as *const _, link);
    let media = JS_NewObject(ctx);
    add_fn(ctx, media, b"open\0", js_media_open, 3);
    add_fn(ctx, media, b"close\0", js_media_close, 0);
    add_fn(ctx, media, b"paused\0", js_media_paused, 1);
    add_fn(ctx, media, b"volume\0", js_media_volume, 1);
    add_fn(ctx, media, b"texture\0", js_media_texture, 0);
    add_fn(ctx, media, b"status\0", js_media_status, 0);
    JS_SetPropertyStr(ctx, global, b"media\0".as_ptr() as *const _, media);
}
/// Install `globalThis.audio` — the audio MODULE as its own namespace
/// (capability audio.pcm = spec namespace, contracts/spec/audio.ts), the
/// pocket-mod `mount("audio", …)` shape spelled in raw QuickJS.
///
/// Separate from [`register_private`] so a host with its own surface instead of `ui`
/// (pocketvoxel-psp's `voxel`) can mount the module without the UI ops. The
/// mixer thread and hardware channel start lazily on the first createStream.
///
/// # Safety
/// QuickJS context alive, worker thread.
pub unsafe fn register_audio(ctx: *mut JSContext, global: JSValue) {
    let audio_obj = JS_NewObject(ctx);
    add_fn(ctx, audio_obj, b"createStream\0", js_audio_create_stream, 2);
    add_fn(
        ctx,
        audio_obj,
        b"destroyStream\0",
        js_audio_destroy_stream,
        1,
    );
    add_fn(ctx, audio_obj, b"writePcm\0", js_audio_write_pcm, 2);
    add_fn(ctx, audio_obj, b"play\0", js_audio_play, 1);
    add_fn(ctx, audio_obj, b"pause\0", js_audio_pause, 1);
    add_fn(ctx, audio_obj, b"stop\0", js_audio_stop, 1);
    add_fn(ctx, audio_obj, b"setVolume\0", js_audio_set_volume, 2);
    add_fn(ctx, audio_obj, b"endStream\0", js_audio_end_stream, 1);
    add_fn(ctx, audio_obj, b"poll\0", js_audio_poll, 0);
    JS_SetPropertyStr(ctx, global, b"audio\0".as_ptr() as *const _, audio_obj);
}
