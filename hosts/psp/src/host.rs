//! Shared host plumbing: the GE display list, graphics init, the worker
//! thread pattern, FPU setup, and small QuickJS helpers. Everything here is
//! composition-agnostic — used by the `pocketjs-psp` UI bin and by game
//! EBOOTs that link this crate as a library.

use core::ffi::c_void;

#[cfg(feature = "quickjs")]
use libquickjs_sys::*;
use psp::sys::{
    self, DisplayPixelFormat, GuContextType, GuState, GuSyncBehavior, GuSyncMode, ShadingModel,
    TexturePixelFormat, ThreadAttributes,
};
use psp::vram_alloc::get_vram_allocator;
use psp::{Align16, BUF_WIDTH, SCREEN_HEIGHT, SCREEN_WIDTH};

// GE display list buffer (1 MB), 16-byte aligned. One per program; the
// frame loop owns sceGuStart/Finish against it (the "dreamcart contract" —
// ge.rs never opens or kicks lists).
static mut LIST: Align16<[u32; 0x40000]> = Align16([0; 0x40000]);

/// The display-list pointer for `sceGuStart`.
pub fn list_ptr() -> *mut c_void {
    unsafe { &mut LIST as *mut _ as *mut c_void }
}

/// Real PSP hardware can start a PSPLINK-loaded user thread with FPU
/// exceptions enabled. Taffy intentionally uses NaN sentinels for auto/
/// undefined dimensions; with invalid-operation traps enabled, ordinary
/// flexbox math over those sentinels raises FPE and the screen stays black.
/// Clear FCSR so exceptions are masked and NaNs propagate as the layout
/// engine expects. PPSSPP's software renderer path did not expose this.
#[inline]
pub unsafe fn reset_fpu_status() {
    core::arch::asm!("ctc1 $zero, $31", options(nostack, nomem));
}

/// The `psp::module!` main thread has only a 256 KB stack; QuickJS compiling
/// a bundle overflows it. Run `entry` on a 1 MB USER|VFPU worker (the VFPU
/// flag is required for sceGum on hardware) and wait for it. One MiB remains
/// four times the overflowing main stack while returning the other MiB to the
/// shared arena before its one kernel block is reserved. Falls back to calling
/// `fallback` inline if thread creation fails.
pub unsafe fn run_on_worker(
    entry: unsafe extern "C" fn(usize, *mut c_void) -> i32,
    fallback: unsafe fn(),
) {
    let id = sys::sceKernelCreateThread(
        b"pocketjs_main\0".as_ptr(),
        entry,
        32,          // priority
        1024 * 1024, // 1 MB stack
        ThreadAttributes::USER | ThreadAttributes::VFPU,
        core::ptr::null_mut(),
    );
    if id.0 >= 0 {
        sys::sceKernelStartThread(id, 0, core::ptr::null_mut());
        sys::sceKernelWaitThreadEnd(id, core::ptr::null_mut());
    } else {
        fallback();
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

/// Graphics setup selector. `depth: false` is the 2D UI runtime's exact
/// historical init (no zbuffer, depth test off). `depth: true` additionally
/// allocates a 16-bit zbuffer for 3D passes; the frame loop still owns
/// enabling/disabling DepthTest per pass.
#[derive(Clone, Copy, Default)]
pub struct GfxConfig {
    pub depth: bool,
}

/// Double-buffered 480x272 PSM8888 GU init — copied from dreamcart
/// runtime/src/main.rs init_graphics with the 3D-pass state trimmed to what a
/// 2D UI needs (scissor + smooth shading for gradient gouraud; depth test
/// off). With `cfg.depth` a zbuffer is allocated and registered as well.
pub unsafe fn init_graphics(cfg: GfxConfig) {
    let allocator = match get_vram_allocator() {
        Ok(a) => a,
        Err(_) => halt("get_vram_allocator failed"),
    };
    let fbp0 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm8888)
        .as_mut_ptr_from_zero();
    let fbp1 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm8888)
        .as_mut_ptr_from_zero();
    let zbp = cfg.depth.then(|| {
        allocator
            .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm4444)
            .as_mut_ptr_from_zero()
    });

    sys::sceGuInit();
    sys::sceGuStart(GuContextType::Direct, list_ptr());
    sys::sceGuDrawBuffer(DisplayPixelFormat::Psm8888, fbp0 as _, BUF_WIDTH as i32);
    sys::sceGuDispBuffer(
        SCREEN_WIDTH as i32,
        SCREEN_HEIGHT as i32,
        fbp1 as _,
        BUF_WIDTH as i32,
    );
    if let Some(zbp) = zbp {
        sys::sceGuDepthBuffer(zbp as _, BUF_WIDTH as i32);
    }
    sys::sceGuOffset(2048 - (SCREEN_WIDTH / 2), 2048 - (SCREEN_HEIGHT / 2));
    sys::sceGuViewport(2048, 2048, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32);
    sys::sceGuScissor(0, 0, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32);
    sys::sceGuEnable(GuState::ScissorTest);
    // Smooth shading: gradient rects gouraud-interpolate per-vertex color.
    sys::sceGuShadeModel(ShadingModel::Smooth);
    sys::sceGuFinish();
    sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
    sys::sceDisplayWaitVblankStart();
    sys::sceGuDisplay(true);
}

// libquickjs-sys omits JS_ExecutePendingJob; the linked QuickJS C library
// provides it (local-extern pattern). size_t stays usize (MIPS o32).
#[cfg(feature = "quickjs")]
extern "C" {
    fn JS_ExecutePendingJob(rt: *mut JSRuntime, pctx: *mut *mut JSContext) -> i32;
}

/// Drain queued microtask jobs (queueMicrotask polyfill = promise jobs).
#[cfg(feature = "quickjs")]
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
#[cfg(feature = "quickjs")]
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
