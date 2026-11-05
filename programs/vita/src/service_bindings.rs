//! Native extension helpers and debugger-only callbacks. Public UI operations
//! are mounted by the generated QuickJS guest and dispatch through OpContext.
use libquickjs_sys::*;
extern "C" {
    fn JS_NewStringLen(ctx: *mut JSContext, text: *const u8, length: usize) -> JSValue;
}
#[inline]
/// Read an integer argument from a QuickJS callback.
///
/// # Safety
///
/// `ctx` and the first `argc` entries of `argv` must be valid for the duration
/// of the call.
pub unsafe fn arg_i32(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> i32 {
    if (i as i32) >= argc {
        return 0;
    }
    let mut out: i32 = 0;
    JS_ToInt32(ctx, &mut out, *argv.offset(i));
    out
}

#[inline]
/// Read a floating-point argument from a QuickJS callback.
///
/// # Safety
///
/// `ctx` and the first `argc` entries of `argv` must be valid for the duration
/// of the call.
pub unsafe fn arg_f64(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> f64 {
    if (i as i32) >= argc {
        return 0.0;
    }
    let mut out: f64 = 0.0;
    JS_ToFloat64(ctx, &mut out, *argv.offset(i));
    out
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

/// Register one C function onto a JS object (shared by extra surfaces
/// like OpenStrike's `strike` namespace).
///
/// # Safety
///
/// `ctx` and `obj` must belong to the active QuickJS realm, `name` must be
/// NUL-terminated, and `f` must obey the QuickJS callback ABI.
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

/// # Safety
/// The generated guest mounted ui in this context; call on its owning thread.
pub unsafe fn register_private(ctx: *mut JSContext, global: JSValue) {
    let ui = JS_GetPropertyStr(ctx, global, c"ui".as_ptr());
    add_fn(ctx, ui, b"__dbgActive\0", js_dbg_active, 0);
    add_fn(ctx, ui, b"__dbgPoll\0", js_dbg_poll, 0);
    add_fn(ctx, ui, b"__dbgSend\0", js_dbg_send, 1);
    add_fn(ctx, ui, b"__dbgShot\0", js_dbg_shot, 0);
    JS_FreeValue(ctx, ui);
}
