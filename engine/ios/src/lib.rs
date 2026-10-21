//! pocket-apple — the PocketJS iOS host core behind a C ABI.
//!
//! Composition mirrors `hosts/pocketbook`: one `pocket_mod::Guest` (QuickJS
//! realm), one `pocket_ui_surface::UiSurface` (`globalThis.ui` + pak feeding),
//! and `pocketjs_core::raster` driven incrementally through a `DamageTracker`.
//! The framebuffer is ARGB32 words — BGRA byte order in memory on
//! little-endian, i.e. `kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst`
//! for CoreGraphics without any swizzling.
//!
//! Threading: everything here is single-threaded by construction (`UiSurface`
//! is `Rc<RefCell<..>>`). Create, drive, and destroy a handle from one thread —
//! in practice the main thread, alongside CADisplayLink.
//!
//! Call order per handle: `create` → `load_pak`* → [`set_identity`] →
//! [`set_tick_rate`] → `eval_bundle` → per tick `frame` then `render` →
//! `destroy`. `load_pak`, `set_identity` and `set_tick_rate` are all
//! rejected after `eval_bundle` because the surface publishes them to the
//! guest at mount time — and the guest converts its mount-time `animate()`
//! durations to frames at the rate in force while the bundle evaluates, so
//! a rate declared later would have silently converted them at 60.

use std::cell::RefCell;
use std::ffi::{c_char, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::slice;

pub mod core_host;

use pocket_mod::Guest;
use pocket_ui_surface::UiSurface;
use pocketjs_core::damage::{DamagePolicy, DamageTracker, DEFAULT_DAMAGE_REGIONS};
use pocketjs_core::raster;
use pocketjs_core::spec;

pub const POCKET_APPLE_ABI_VERSION: u32 = 1;
pub const POCKET_APPLE_MAX_DAMAGE_REGIONS: usize = DEFAULT_DAMAGE_REGIONS;

/// Accepted `set_tick_rate` range: covers every Apple display cadence from a
/// throttled 1 Hz up to the 240 Hz headroom above ProMotion's 120 (the
/// core's own ceiling — `pocketjs_core::MAX_TICK_HZ`).
pub(crate) const MIN_TICK_HZ: u32 = 1;
pub(crate) const MAX_TICK_HZ: u32 = pocketjs_core::MAX_TICK_HZ;

const OK: i32 = 0;
const ERR_BAD_ARGUMENT: i32 = -1;
const ERR_BAD_STATE: i32 = -2;
const ERR_GUEST: i32 = -3;
const ERR_PANIC: i32 = -4;

thread_local! {
    static LAST_ERROR: RefCell<CString> = RefCell::new(CString::new("").unwrap());
}

pub(crate) fn set_last_error(message: impl AsRef<str>) {
    let sanitized = message.as_ref().replace('\0', " ");
    LAST_ERROR.with(|slot| {
        *slot.borrow_mut() = CString::new(sanitized).unwrap_or_default();
    });
}

pub type PocketAppleEffectCallback =
    extern "C" fn(line: *const c_char, context: *mut std::ffi::c_void);

pub struct PocketApple {
    guest: Guest,
    surface: UiSurface,
    framebuffer: Vec<u8>,
    tracker: DamageTracker,
    density: u32,
    logical_width: u32,
    logical_height: u32,
    mounted: bool,
    effect_callback: Option<(PocketAppleEffectCallback, *mut std::ffi::c_void)>,
}

/// One rendered frame. `pixels` stays valid until the next `render`, a
/// `destroy`, or any other call that mutates the handle.
#[repr(C)]
pub struct PocketAppleFrame {
    pub pixels: *const u8,
    pub width_px: u32,
    pub height_px: u32,
    pub stride_bytes: u32,
    /// Repaint rects in pixel coordinates as x, y, w, h. `region_count == 0`
    /// means nothing changed this frame; the previous contents are current.
    pub regions: [[i32; 4]; POCKET_APPLE_MAX_DAMAGE_REGIONS],
    pub region_count: u32,
    pub full_redraw: i32,
}

fn with_handle<R>(
    handle: *mut PocketApple,
    default: R,
    f: impl FnOnce(&mut PocketApple) -> R,
) -> R {
    if handle.is_null() {
        set_last_error("null handle");
        return default;
    }
    let state = unsafe { &mut *handle };
    match catch_unwind(AssertUnwindSafe(|| f(state))) {
        Ok(value) => value,
        Err(_) => {
            set_last_error("panic inside pocket-apple");
            default
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_abi_version() -> u32 {
    POCKET_APPLE_ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_last_error() -> *const c_char {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_create(
    density: u32,
    logical_width: u32,
    logical_height: u32,
) -> *mut PocketApple {
    let result = catch_unwind(|| {
        if density == 0
            || density > raster::MAX_RENDER_SCALE
            || logical_width == 0
            || logical_height == 0
        {
            set_last_error("invalid density or viewport");
            return std::ptr::null_mut();
        }
        let guest = match Guest::new() {
            Ok(guest) => guest,
            Err(error) => {
                set_last_error(format!("guest create failed: {error}"));
                return std::ptr::null_mut();
            }
        };
        let surface = UiSurface::new_with_density(
            (logical_width as f32, logical_height as f32),
            density,
        );
        let pixel_len =
            (logical_width * density) as usize * (logical_height * density) as usize * 4;
        Box::into_raw(Box::new(PocketApple {
            guest,
            surface,
            framebuffer: vec![0; pixel_len],
            tracker: DamageTracker::default(),
            density,
            logical_width,
            logical_height,
            mounted: false,
            effect_callback: None,
        }))
    });
    result.unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_set_identity(
    handle: *mut PocketApple,
    host_id: *const c_char,
    host_abi: u32,
) -> i32 {
    with_handle(handle, ERR_PANIC, |state| {
        if state.mounted {
            set_last_error("identity must be set before eval_bundle");
            return ERR_BAD_STATE;
        }
        if host_id.is_null() {
            return ERR_BAD_ARGUMENT;
        }
        let id = unsafe { std::ffi::CStr::from_ptr(host_id) };
        match id.to_str() {
            Ok(id) => {
                state.surface.set_identity(id, host_abi);
                OK
            }
            Err(_) => ERR_BAD_ARGUMENT,
        }
    })
}

/// Declare the exact companion service names this host serves (comma-
/// separated; svcOpen answers false for everything else — and for
/// everything when this is never called, per the surface's deny-by-default
/// contract). Must be called before `eval_bundle`, like `set_identity`.
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_set_svc_allowlist(
    handle: *mut PocketApple,
    comma_separated: *const c_char,
) -> i32 {
    with_handle(handle, ERR_PANIC, |state| {
        if state.mounted {
            set_last_error("svc allowlist must be set before eval_bundle");
            return ERR_BAD_STATE;
        }
        if comma_separated.is_null() {
            return ERR_BAD_ARGUMENT;
        }
        let names = unsafe { std::ffi::CStr::from_ptr(comma_separated) };
        match names.to_str() {
            Ok(names) => {
                state
                    .surface
                    .set_svc_allowlist(names.split(',').filter(|s| !s.is_empty()));
                OK
            }
            Err(_) => ERR_BAD_ARGUMENT,
        }
    })
}

/// Ticks (and therefore `pocket_apple_frame` calls) per second of guest
/// virtual time. 1..=240; the guest bundle must be built for the same rate.
/// Rejected after `eval_bundle`, like `set_identity`: the mount publishes
/// the rate to the guest as `ui.__tickHz`, and the bundle's mount-time
/// `animate()` calls convert ms to frames at the rate in force while it
/// evaluates.
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_set_tick_rate(handle: *mut PocketApple, hz: u32) -> i32 {
    with_handle(handle, ERR_PANIC, |state| {
        if state.mounted {
            set_last_error("tick rate must be set before eval_bundle");
            return ERR_BAD_STATE;
        }
        if !(MIN_TICK_HZ..=MAX_TICK_HZ).contains(&hz) {
            set_last_error("tick rate must be 1 through 240 Hz");
            return ERR_BAD_ARGUMENT;
        }
        if !state.surface.set_tick_rate(hz) {
            set_last_error("tick rate must be set before the realm ticks");
            return ERR_BAD_STATE;
        }
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_load_pak(
    handle: *mut PocketApple,
    bytes: *const u8,
    length: usize,
) -> i32 {
    with_handle(handle, ERR_PANIC, |state| {
        if state.mounted {
            set_last_error("pak must be fed before eval_bundle");
            return ERR_BAD_STATE;
        }
        if bytes.is_null() || length == 0 {
            return ERR_BAD_ARGUMENT;
        }
        let pak = unsafe { slice::from_raw_parts(bytes, length) };
        match state.surface.try_feed_pak(pak) {
            Ok(()) => OK,
            Err(error) => {
                set_last_error(format!("asset pack rejected: {error}"));
                ERR_BAD_ARGUMENT
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_eval_bundle(
    handle: *mut PocketApple,
    source: *const u8,
    length: usize,
    label: *const c_char,
) -> i32 {
    with_handle(handle, ERR_PANIC, |state| {
        if source.is_null() || length == 0 {
            return ERR_BAD_ARGUMENT;
        }
        let bytes = unsafe { slice::from_raw_parts(source, length) };
        let bundle = match std::str::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => {
                set_last_error("bundle is not UTF-8");
                return ERR_BAD_ARGUMENT;
            }
        };
        let label = if label.is_null() {
            "app"
        } else {
            unsafe { std::ffi::CStr::from_ptr(label) }
                .to_str()
                .unwrap_or("app")
        };
        if !state.mounted {
            if let Err(error) = state.surface.mount(&state.guest) {
                set_last_error(format!("ui mount failed: {error}"));
                return ERR_GUEST;
            }
            state.mounted = true;
        }
        if let Err(error) = state.guest.eval(label, bundle) {
            set_last_error(format!("bundle eval failed: {error}"));
            return ERR_GUEST;
        }
        if !state.guest.has_frame() {
            set_last_error("bundle installed no frame() — is this a PocketJS app?");
            return ERR_GUEST;
        }
        OK
    })
}

/// `touches`: up to 8 packed words in logical coordinates. Legacy words carry
/// x:9, y:9, id:8 with bit 31 clear. Wide words set bit 31 and carry x:10,
/// y:10, id:8. Pass `analog = 0x8080` when centered.
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_frame(
    handle: *mut PocketApple,
    buttons: u32,
    analog: u32,
    touches: *const u32,
    touch_count: usize,
) -> i32 {
    with_handle(handle, ERR_PANIC, |state| {
        if !state.mounted {
            set_last_error("frame before eval_bundle");
            return ERR_BAD_STATE;
        }
        let touch_words: &[u32] = if touches.is_null() || touch_count == 0 {
            &[]
        } else {
            unsafe { slice::from_raw_parts(touches, touch_count.min(8)) }
        };
        // Resolve each new contact against the committed core frame before the
        // guest mutates it, then carry that fact in Ui's contact table until
        // release. This is frame() argument 4 from the touch contract.
        let mut touch_hits = [0i32; 8];
        let hit_count = state
            .surface
            .with_ui(|ui| ui.touch_hits(touch_words, &mut touch_hits));
        let analog = if analog == 0 { spec::ANALOG_CENTER } else { analog };
        if let Err(error) = state.guest.frame_with_touch_hits(
            buttons,
            analog,
            touch_words,
            &touch_hits[..hit_count],
        ) {
            set_last_error(format!("guest frame failed: {error}"));
            return ERR_GUEST;
        }
        state.surface.tick();
        if let Some((callback, context)) = state.effect_callback {
            for line in state.surface.svc_drain() {
                if let Ok(line) = CString::new(line) {
                    callback(line.as_ptr(), context);
                }
            }
        }
        OK
    })
}

/// Register the guest -> host effect sink. Lines are whatever the guest's
/// effect driver `svcSend`s (JSON by convention), delivered synchronously
/// during `pocket_apple_frame` on the calling thread. `context` must stay
/// valid until the callback is replaced or the handle destroyed.
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_set_effect_callback(
    handle: *mut PocketApple,
    callback: Option<PocketAppleEffectCallback>,
    context: *mut std::ffi::c_void,
) -> i32 {
    with_handle(handle, ERR_PANIC, |state| {
        state.effect_callback = callback.map(|cb| (cb, context));
        OK
    })
}

/// Queue one line for the guest's next `svcPoll` — host -> guest facts land
/// at a frame boundary, per the "no mid-tick callbacks" law.
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_post_event(
    handle: *mut PocketApple,
    line: *const c_char,
) -> i32 {
    with_handle(handle, ERR_PANIC, |state| {
        if line.is_null() {
            return ERR_BAD_ARGUMENT;
        }
        match unsafe { std::ffi::CStr::from_ptr(line) }.to_str() {
            Ok(text) => {
                state.surface.svc_push(text);
                OK
            }
            Err(_) => ERR_BAD_ARGUMENT,
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_render(
    handle: *mut PocketApple,
    out: *mut PocketAppleFrame,
) -> i32 {
    with_handle(handle, ERR_PANIC, |state| {
        if out.is_null() {
            return ERR_BAD_ARGUMENT;
        }
        if !state.mounted {
            set_last_error("render before eval_bundle");
            return ERR_BAD_STATE;
        }
        let density = state.density;
        let framebuffer = &mut state.framebuffer;
        let tracker = &mut state.tracker;
        let plan = state.surface.with_ui(|ui| {
            let words = ui.draw().words.clone();
            match raster::render_scaled_argb_incremental(
                ui,
                &words,
                framebuffer,
                density,
                tracker,
                DamagePolicy::default(),
            ) {
                Ok(plan) => plan,
                Err(_) => {
                    raster::render_scaled_argb(ui, &words, framebuffer, density);
                    tracker.invalidate();
                    pocketjs_core::damage::DamagePlan::full(
                        pocketjs_core::damage::DamageRect::new(
                            0,
                            0,
                            state.logical_width as i32,
                            state.logical_height as i32,
                        ),
                    )
                }
            }
        });

        let width_px = state.logical_width * density;
        let height_px = state.logical_height * density;
        let frame = unsafe { &mut *out };
        frame.pixels = state.framebuffer.as_ptr();
        frame.width_px = width_px;
        frame.height_px = height_px;
        frame.stride_bytes = width_px * 4;
        frame.full_redraw = i32::from(plan.is_full_redraw());
        frame.region_count = plan.region_count().min(POCKET_APPLE_MAX_DAMAGE_REGIONS) as u32;
        frame.regions = [[0; 4]; POCKET_APPLE_MAX_DAMAGE_REGIONS];
        for (slot, rect) in frame.regions.iter_mut().zip(plan.regions()) {
            let scale = density as i32;
            let x = rect.x0.max(0) * scale;
            let y = rect.y0.max(0) * scale;
            let w = (rect.x1 - rect.x0).max(0) * scale;
            let h = (rect.y1 - rect.y0).max(0) * scale;
            *slot = [x, y, w, h];
        }
        OK
    })
}

/// Hit test in logical coordinates. Returns the focusable node id or 0.
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_hit_test_bounds(
    handle: *mut PocketApple,
    x: f32,
    y: f32,
) -> i32 {
    with_handle(handle, 0, |state| {
        state.surface.with_ui(|ui| ui.hit_test_bounds(x, y))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_destroy(handle: *mut PocketApple) {
    if handle.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        drop(Box::from_raw(handle));
    }));
}
