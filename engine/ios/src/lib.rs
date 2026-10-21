//! UIKit composition over the canonical runtime C boundary. The compatibility
//! entry points retain no Ui, DrawList, asset parser or presentation policy.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

mod bridge;
mod package;

use bridge::Bridge;
use pocket_guest_rquickjs::{BindingProfile, RquickjsGuest};
use pocket_runtime_cabi::abi::*;
use pocket_runtime_cabi::{
    pocket_runtime_add_display, pocket_runtime_add_input_source, pocket_runtime_add_op_provider,
    pocket_runtime_boot, pocket_runtime_create, pocket_runtime_destroy, pocket_runtime_op,
    pocket_runtime_set_guest, pocket_runtime_set_package_source, pocket_runtime_supports_op,
    pocket_runtime_tick,
};
use std::{
    cell::{Cell, RefCell},
    ffi::{c_char, c_void, CStr, CString},
    ptr,
};

pub const POCKET_APPLE_ABI_VERSION: u32 = 2;
pub const POCKET_APPLE_MAX_DAMAGE_REGIONS: usize = 8;
const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;
pub type PocketAppleEffectCallback = extern "C" fn(*const c_char, *mut c_void);
thread_local! { static LAST_ERROR: RefCell<CString> = RefCell::new(CString::default()); }
fn error(message: impl AsRef<str>) -> i32 {
    LAST_ERROR.with(|slot| {
        *slot.borrow_mut() = CString::new(message.as_ref().replace('\0', " ")).unwrap()
    });
    POCKET_STATUS_FAILED
}
#[repr(C)]
pub struct PocketAppleFrame {
    pub pixels: *const u8,
    pub width_px: u32,
    pub height_px: u32,
    pub stride_bytes: u32,
    pub regions: [[i32; 4]; POCKET_APPLE_MAX_DAMAGE_REGIONS],
    pub region_count: u32,
    pub full_redraw: i32,
}
struct Configuration {
    host: String,
    abi: u32,
    hz: u32,
    pak: Vec<u8>,
    package: Vec<u8>,
    guest: Option<(PocketGuestV1, *mut c_void)>,
}
pub struct PocketApple {
    runtime: Cell<*mut PocketRuntime>,
    busy: Cell<bool>,
    config: RefCell<Configuration>,
    bridge: Box<Bridge>,
    effect: Cell<Option<(PocketAppleEffectCallback, *mut c_void)>>,
}
struct Busy<'a>(&'a Cell<bool>);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}
fn access(handle: *mut PocketApple, operation: impl FnOnce(&PocketApple) -> i32) -> i32 {
    let Some(state) = (unsafe { handle.as_ref() }) else {
        return POCKET_STATUS_INVALID;
    };
    if state.busy.replace(true) {
        return error("Apple runtime call is already active");
    }
    let _guard = Busy(&state.busy);
    operation(state)
}
fn configure(handle: *mut PocketApple, action: impl FnOnce(&mut Configuration) -> i32) -> i32 {
    access(handle, |state| {
        if !state.runtime.get().is_null() {
            return error("configuration must precede guest boot");
        }
        action(&mut state.config.borrow_mut())
    })
}
unsafe fn bytes<'a>(pointer: *const u8, length: usize) -> Option<&'a [u8]> {
    if length == 0 {
        return Some(&[]);
    }
    if pointer.is_null()
        || length > isize::MAX as usize
        || (pointer as usize).checked_add(length).is_none()
    {
        return None;
    }
    Some(unsafe { std::slice::from_raw_parts(pointer, length) })
}
unsafe fn string<'a>(pointer: *const c_char) -> Option<&'a str> {
    if pointer.is_null() {
        None
    } else {
        unsafe { CStr::from_ptr(pointer) }.to_str().ok()
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
pub extern "C" fn pocket_apple_create(density: u32, width: u32, height: u32) -> *mut PocketApple {
    let Some(bridge) = Bridge::new(density, width, height) else {
        error("invalid Apple viewport or allocation size");
        return ptr::null_mut();
    };
    Box::into_raw(Box::new(PocketApple {
        runtime: Cell::new(ptr::null_mut()),
        busy: Cell::new(false),
        config: RefCell::new(Configuration {
            host: "desktop".into(),
            abi: 1,
            hz: 60,
            pak: Vec::new(),
            package: Vec::new(),
            guest: None,
        }),
        bridge: Box::new(bridge),
        effect: Cell::new(None),
    }))
}
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_set_identity(
    handle: *mut PocketApple,
    host: *const c_char,
    abi: u32,
) -> i32 {
    configure(handle, |config| {
        let Some(host) = (unsafe { string(host) }) else {
            return POCKET_STATUS_INVALID;
        };
        if host.is_empty()
            || host.len() > pocket_package::package_format::POCKET_TARGET_MAX_BYTES
            || abi == 0
        {
            return POCKET_STATUS_INVALID;
        }
        config.host = host.into();
        config.abi = abi;
        0
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_set_tick_rate(handle: *mut PocketApple, hz: u32) -> i32 {
    configure(handle, |config| {
        if !(1..=240).contains(&hz) {
            return POCKET_STATUS_INVALID;
        }
        config.hz = hz;
        0
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_set_svc_allowlist(
    handle: *mut PocketApple,
    names: *const c_char,
) -> i32 {
    access(handle, |state| {
        if !state.runtime.get().is_null() {
            return error("service allowlist must precede boot");
        }
        let Some(names) = (unsafe { string(names) }) else {
            return POCKET_STATUS_INVALID;
        };
        state.bridge.services.borrow_mut().allow = names
            .split(',')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        0
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_load_pak(
    handle: *mut PocketApple,
    data: *const u8,
    length: usize,
) -> i32 {
    configure(handle, |config| {
        let Some(pak) = (unsafe { bytes(data, length) }) else {
            return POCKET_STATUS_INVALID;
        };
        // The runtime performs the authoritative asset installation at boot.
        if pocket_package::pak::checked_entries(pak).is_err() {
            return error("invalid asset pack");
        }
        if pak.len() > MAX_PACKAGE_BYTES {
            return error("asset pack exceeds the runtime heap limit");
        }
        let mut owned = Vec::new();
        if owned.try_reserve_exact(pak.len()).is_err() {
            return error("asset pack allocation failed");
        }
        owned.extend_from_slice(pak);
        config.pak = owned;
        0
    })
}
/// Register an external engine before boot. Its callbacks use the same guest
/// lifecycle and runtime_op reentry rules as an owned rquickjs engine.
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_set_guest(
    handle: *mut PocketApple,
    table: *const PocketGuestV1,
    context: *mut c_void,
) -> i32 {
    configure(handle, |config| {
        let Some(table) = (unsafe { PocketGuestV1::read_prefix(table) }) else {
            return POCKET_STATUS_INVALID;
        };
        if table.evaluate.is_none() || table.frame.is_none() {
            return POCKET_STATUS_INVALID;
        }
        config.guest = Some((table, context));
        0
    })
}
fn boot(state: &PocketApple, code: &[u8]) -> i32 {
    if !state.runtime.get().is_null() {
        return error("guest is already booted");
    }
    let (config, guest) = {
        let mut configuration = state.config.borrow_mut();
        let (profile, package) = match package::encode(&configuration, &state.bridge, code) {
            Ok(value) => value,
            Err(message) => return error(message),
        };
        configuration.package = package;
        let mut config = PocketRuntimeConfig::empty();
        config.profile_hash = pocket_package::sha256::sha256(&profile);
        config.host_abi = configuration.abi;
        config.tick_hz = configuration.hz;
        config.heap_limit = MAX_PACKAGE_BYTES;
        config.frame_buffer_budget = state.bridge.byte_length();
        config.profile_json = profile.as_ptr();
        config.profile_json_length = profile.len();
        let runtime = unsafe { pocket_runtime_create(&config) };
        if runtime.is_null() {
            return error("runtime rejected Apple profile");
        }
        state.runtime.set(runtime);
        (runtime, configuration.guest)
    };
    let context = (&*state.bridge as *const Bridge)
        .cast_mut()
        .cast::<c_void>();
    let source_context = (state as *const PocketApple).cast_mut().cast::<c_void>();
    let mut status =
        unsafe { pocket_runtime_set_package_source(config, &bridge::SOURCE, source_context) };
    if status == 0 {
        status = unsafe {
            pocket_runtime_add_display(config, &bridge::DISPLAY, context, POCKET_RENDERER_SOFTWARE)
        };
    }
    if status == 0 {
        status = unsafe { pocket_runtime_add_input_source(config, &bridge::INPUT, context) };
    }
    if status == 0 {
        status = unsafe {
            pocket_runtime_add_op_provider(
                config,
                &bridge::PROVIDER,
                context,
                [30u16, 31, 32].as_ptr(),
                3,
            )
        };
    }
    if status == 0 {
        status = match guest {
            Some((table, context)) => unsafe { pocket_runtime_set_guest(config, &table, context) },
            None => unsafe {
                pocket_runtime_cabi::embedding::set_guest(
                    config,
                    Box::new(RquickjsGuest::new(BindingProfile::Canonical)),
                )
            },
        };
    }
    if status == 0 {
        status = unsafe { pocket_runtime_boot(config) };
    }
    if status != 0 {
        unsafe { pocket_runtime_destroy(config) };
        state.runtime.set(ptr::null_mut());
        state.bridge.reset();
        return error(format!("Apple runtime boot failed ({status})"));
    }
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_eval_bundle(
    handle: *mut PocketApple,
    code: *const u8,
    length: usize,
    _label: *const c_char,
) -> i32 {
    access(handle, |state| {
        let Some(code) = (unsafe { bytes(code, length) }) else {
            return POCKET_STATUS_INVALID;
        };
        if code.is_empty() || code.len() > MAX_PACKAGE_BYTES || std::str::from_utf8(code).is_err() {
            return POCKET_STATUS_INVALID;
        }
        boot(state, code)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_frame(
    handle: *mut PocketApple,
    buttons: u32,
    analog: u32,
    touches: *const u32,
    count: usize,
) -> i32 {
    access(handle, |state| {
        if state.runtime.get().is_null() || count > 8 || (count != 0 && touches.is_null()) {
            return POCKET_STATUS_INVALID;
        }
        let words = if count == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(touches, count) }
        };
        state
            .bridge
            .set_input(buttons, if analog == 0 { 0x8080 } else { analog }, words);
        state.bridge.begin_frame();
        let status = unsafe { pocket_runtime_tick(state.runtime.get()) };
        if status != 0 {
            return error(format!("Apple runtime tick failed ({status})"));
        }
        let lines: Vec<_> = state
            .bridge
            .services
            .borrow_mut()
            .outgoing
            .drain(..)
            .collect();
        if let Some((callback, context)) = state.effect.get() {
            for line in lines {
                if let Ok(line) = CString::new(line) {
                    callback(line.as_ptr(), context);
                }
            }
        }
        0
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_render(handle: *mut PocketApple, out: *mut PocketAppleFrame) -> i32 {
    access(handle, |state| {
        if out.is_null() || state.runtime.get().is_null() {
            return POCKET_STATUS_INVALID;
        }
        let frame = state.bridge.frame.borrow();
        unsafe {
            out.write(frame.snapshot());
        }
        0
    })
}
/// Operations are allowed inside guest callbacks. They must bypass the Apple
/// outer-call guard; the canonical boundary enforces the narrower reentry rule.
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_op(
    handle: *mut PocketApple,
    operation: u16,
    args: *const c_void,
    length: usize,
    result: *mut PocketResult,
) -> i32 {
    let Some(state) = (unsafe { handle.as_ref() }) else {
        return POCKET_STATUS_INVALID;
    };
    unsafe { pocket_runtime_op(state.runtime.get(), operation, args, length, result) }
}
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_supports_op(handle: *mut PocketApple, operation: u16) -> u32 {
    let Some(state) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    unsafe { pocket_runtime_supports_op(state.runtime.get(), operation) }
}
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_hit_test_bounds(handle: *mut PocketApple, x: f32, y: f32) -> i32 {
    let args = [
        PocketOpArg {
            tag: POCKET_ARG_REAL,
            real: f64::from(x),
            ..PocketOpArg::empty()
        },
        PocketOpArg {
            tag: POCKET_ARG_REAL,
            real: f64::from(y),
            ..PocketOpArg::empty()
        },
    ];
    let mut result = PocketResult::empty();
    if pocket_apple_op(
        handle,
        42,
        args.as_ptr().cast(),
        std::mem::size_of_val(&args),
        &mut result,
    ) == 0
    {
        result.integer as i32
    } else {
        0
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_set_effect_callback(
    handle: *mut PocketApple,
    callback: Option<PocketAppleEffectCallback>,
    context: *mut c_void,
) -> i32 {
    access(handle, |state| {
        state
            .effect
            .set(callback.map(|callback| (callback, context)));
        0
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_post_event(handle: *mut PocketApple, line: *const c_char) -> i32 {
    // Effect delivery may synchronously post a reply. Its queue has no active
    // borrow when callbacks execute, and the reply is consumed next tick.
    let Some(state) = (unsafe { handle.as_ref() }) else {
        return POCKET_STATUS_INVALID;
    };
    let Some(line) = (unsafe { string(line) }) else {
        return POCKET_STATUS_INVALID;
    };
    let Ok(mut services) = state.bridge.services.try_borrow_mut() else {
        return POCKET_STATUS_FAILED;
    };
    services.incoming.push_back(line.into());
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_destroy(handle: *mut PocketApple) {
    let Some(state) = (unsafe { handle.as_ref() }) else {
        return;
    };
    if state.busy.replace(true) {
        return;
    }
    unsafe {
        pocket_runtime_destroy(state.runtime.replace(ptr::null_mut()));
        drop(Box::from_raw(handle));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem;

    struct Apple(*mut PocketApple);
    impl Apple {
        fn new() -> Self {
            let ptr = pocket_apple_create(1, 16, 12);
            assert!(!ptr.is_null());
            Self(ptr)
        }
        fn boot(&self, source: &str) -> i32 {
            let status =
                pocket_apple_eval_bundle(self.0, source.as_ptr(), source.len(), ptr::null());
            if status != 0 {
                eprintln!("{:?}", unsafe { CStr::from_ptr(pocket_apple_last_error()) });
            }
            status
        }
        fn tick(&self, words: &[u32]) -> i32 {
            pocket_apple_frame(self.0, 0, 0, words.as_ptr(), words.len())
        }
        fn snapshot(&self) -> (PocketAppleFrame, Vec<u8>) {
            let mut output = mem::MaybeUninit::uninit();
            assert_eq!(pocket_apple_render(self.0, output.as_mut_ptr()), 0);
            let output = unsafe { output.assume_init() };
            let pixels = unsafe {
                std::slice::from_raw_parts(
                    output.pixels,
                    output.stride_bytes as usize * output.height_px as usize,
                )
            }
            .to_vec();
            (output, pixels)
        }
    }
    impl Drop for Apple {
        fn drop(&mut self) {
            pocket_apple_destroy(self.0);
        }
    }
    const RECT: &str = "let n=ui.createNode(0);ui.setProp(n,1,16);ui.setProp(n,2,12);ui.setProp(n,64,0xff0000ff);ui.insertBefore(1,n,0);globalThis.frame=function(){};";

    #[test]
    fn owned_guest_renders_once_per_tick_and_instances_are_isolated() {
        let one = Apple::new();
        let two = Apple::new();
        assert_eq!(one.boot(RECT), 0);
        assert_eq!(two.boot("globalThis.frame=function(){}"), 0);
        assert_eq!(one.tick(&[]), 0);
        assert_eq!(two.tick(&[]), 0);
        let (frame, pixels) = one.snapshot();
        assert_eq!(
            (frame.width_px, frame.height_px, frame.stride_bytes),
            (16, 12, 64)
        );
        assert_eq!(&pixels[..4], &[0, 0, 255, 255]);
        assert_ne!(pixels, two.snapshot().1);
        assert_eq!(pixels, one.snapshot().1);
        assert_eq!(pocket_apple_set_tick_rate(one.0, 120), POCKET_STATUS_FAILED);
        assert_eq!(one.boot(RECT), POCKET_STATUS_FAILED);
    }
    #[test]
    fn pak_and_texture_registry_are_owned_through_guest_shutdown() {
        // One maintained 1x1 RGBA image entry in the existing DCPK format.
        let mut pak = [0u8; 96];
        pak[..4].copy_from_slice(b"DCPK");
        pak[4..6].copy_from_slice(&1u16.to_le_bytes());
        pak[8..12].copy_from_slice(&1u32.to_le_bytes());
        pak[12..16].copy_from_slice(&32u32.to_le_bytes());
        pak[16..20].copy_from_slice(&64u32.to_le_bytes());
        pak[36..40].copy_from_slice(&80u32.to_le_bytes());
        pak[40..44].copy_from_slice(&12u32.to_le_bytes());
        pak[48..50].copy_from_slice(&11u16.to_le_bytes());
        pak[64..75].copy_from_slice(b"ui:img.icon");
        pak[80..92].copy_from_slice(&[1, 0, 1, 0, 3, 0, 0, 0, 7, 8, 9, 255]);
        let app = Apple::new();
        assert_eq!(pocket_apple_load_pak(app.0, pak.as_ptr(), pak.len()), 0);
        pak.fill(0);
        assert_eq!(app.boot("if(!(ui.__textures.icon>=0)||new Uint8Array(__pak)[88]!==7)throw Error('assets'); let n=ui.createNode(2);ui.setProp(n,1,16);ui.setProp(n,2,12);ui.setImage(n,ui.__textures.icon);ui.insertBefore(1,n,0);globalThis.frame=()=>{}"),0);
        let (_, pixels) = app.snapshot();
        assert_eq!(&pixels[..4], &[9, 8, 7, 255]);
        assert_eq!(app.tick(&[]), 0);
        assert_eq!(app.snapshot().1, pixels);
    }
    #[test]
    fn persistent_output_skips_idle_transfers_and_updates_changed_pixels() {
        let app = Apple::new();
        assert_eq!(app.boot("let n=ui.createNode(0);ui.setProp(n,1,16);ui.setProp(n,2,12);ui.setProp(n,64,0xff0000ff);ui.insertBefore(1,n,0);let ticks=0;globalThis.frame=()=>{if(++ticks===2)ui.setProp(n,64,0xff00ff00)}"),0);
        assert_eq!(app.snapshot().0.region_count, 1);
        assert_eq!(app.tick(&[]), 0);
        assert_eq!(app.snapshot().0.region_count, 0);
        assert_eq!(app.tick(&[]), 0);
        let (frame, pixels) = app.snapshot();
        assert!(frame.region_count > 0);
        assert_eq!(&pixels[..4], &[0, 255, 0, 255]);
        assert_eq!(app.tick(&[]), 0);
        assert_eq!(app.snapshot().0.region_count, 0);
    }
    #[test]
    fn failed_boot_tears_down_and_can_retry_with_original_configuration() {
        let app = Apple::new();
        assert_eq!(pocket_apple_set_tick_rate(app.0, 120), 0);
        assert_eq!(app.boot("throw Error('boot fails');"), POCKET_STATUS_FAILED);
        assert_eq!(
            app.boot("if(ui.__tickHz!==120)throw Error('rate');globalThis.frame=function(){}"),
            0
        );
        assert_eq!(app.tick(&[]), 0);
        assert_eq!(pocket_apple_set_tick_rate(app.0, 0), POCKET_STATUS_FAILED);
    }
    #[test]
    fn viewport_and_pak_validation_do_not_create_a_partial_runtime() {
        assert!(pocket_apple_create(5, 16, 12).is_null());
        assert!(pocket_apple_create(4, 4096, 4096).is_null());
        assert!(pocket_apple_create(1, u32::MAX, 12).is_null());
        let app = Apple::new();
        assert_ne!(pocket_apple_load_pak(app.0, b"bad".as_ptr(), 3), 0);
        assert_eq!(app.boot("globalThis.frame=function(){}"), 0);
        assert_ne!(pocket_apple_frame(app.0, 0, 0, ptr::null(), 1), 0);
    }

    struct External {
        apple: *mut PocketApple,
        initializes: u32,
        shutdowns: u32,
        node: i32,
        touches: Vec<Vec<u32>>,
        hits: Vec<Vec<i32>>,
    }
    fn integer(value: i64) -> PocketOpArg {
        PocketOpArg {
            tag: POCKET_ARG_INTEGER,
            integer: value,
            ..PocketOpArg::empty()
        }
    }
    fn real(value: f64) -> PocketOpArg {
        PocketOpArg {
            tag: POCKET_ARG_REAL,
            real: value,
            ..PocketOpArg::empty()
        }
    }
    fn call(app: *mut PocketApple, op: u16, args: &[PocketOpArg]) -> PocketResult {
        let mut result = PocketResult::empty();
        assert_eq!(
            pocket_apple_op(
                app,
                op,
                args.as_ptr().cast(),
                mem::size_of_val(args),
                &mut result
            ),
            0
        );
        result
    }
    unsafe extern "C" fn initialize(
        context: *mut c_void,
        _: *mut PocketRuntime,
        env: *const PocketGuestEnvironment,
    ) -> i32 {
        let state = unsafe { &mut *context.cast::<External>() };
        let env = unsafe { &*env };
        assert_eq!(
            (env.viewport_width, env.viewport_height, env.tick_hz),
            (16, 12, 60)
        );
        assert_eq!(
            unsafe { std::slice::from_raw_parts(env.host, env.host_length) },
            b"desktop"
        );
        state.initializes += 1;
        assert_eq!(pocket_apple_supports_op(state.apple, 1), 1);
        // A nested tick and destroy cannot invalidate the active callback.
        assert_eq!(
            pocket_apple_frame(state.apple, 0, 0, ptr::null(), 0),
            POCKET_STATUS_FAILED
        );
        pocket_apple_destroy(state.apple);
        state.node = call(state.apple, 1, &[integer(0)]).integer as i32;
        for (property, value) in [(1, 16.0), (2, 12.0), (64, 4294901760.0)] {
            call(
                state.apple,
                6,
                &[integer(state.node as i64), integer(property), real(value)],
            );
        }
        call(
            state.apple,
            3,
            &[integer(1), integer(state.node as i64), integer(0)],
        );
        0
    }
    unsafe extern "C" fn evaluate(
        _: *mut c_void,
        _: *mut PocketRuntime,
        _: *const u8,
        _: usize,
    ) -> i32 {
        0
    }
    unsafe extern "C" fn frame(context: *mut c_void, value: *const PocketGuestFrame) -> i32 {
        let state = unsafe { &mut *context.cast::<External>() };
        let value = unsafe { &*value };
        assert_eq!(value.analog, 0x8080);
        let touches = if value.touch_count == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(value.touches, value.touch_count) }.to_vec()
        };
        let hits = if value.touch_count == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(value.hits, value.touch_count) }.to_vec()
        };
        state.touches.push(touches);
        state.hits.push(hits);
        0
    }
    unsafe extern "C" fn shutdown(context: *mut c_void) {
        unsafe { &mut *context.cast::<External>() }.shutdowns += 1;
    }
    #[test]
    fn external_guest_uses_same_core_hit_snapshot_cancel_and_shutdown() {
        let app = Apple::new();
        let mut external = External {
            apple: app.0,
            initializes: 0,
            shutdowns: 0,
            node: 0,
            touches: Vec::new(),
            hits: Vec::new(),
        };
        let table = PocketGuestV1 {
            initialize: Some(initialize),
            evaluate: Some(evaluate),
            frame: Some(frame),
            shutdown: Some(shutdown),
            ..PocketGuestV1::empty()
        };
        assert_eq!(
            pocket_apple_set_guest(app.0, &table, (&mut external as *mut External).cast()),
            0
        );
        assert_eq!(app.boot("external source"), 0);
        assert_eq!(app.tick(&[]), 0);
        let word = (3 << 18) | (2 << 9) | 2;
        assert_eq!(app.tick(&[word]), 0);
        assert_eq!(external.hits[1], [external.node]);
        assert_eq!(app.tick(&[word | 0x40000000]), 0);
        assert_eq!(app.tick(&[]), 0);
        assert_eq!(external.touches[2], [(3 << 18) | 0x40000000]);
        assert!(external.touches[3].is_empty());
        assert_eq!(external.initializes, 1);
        drop(app);
        assert_eq!(external.shutdowns, 1);
    }
    extern "C" fn effect(line: *const c_char, context: *mut c_void) {
        let app = context.cast::<PocketApple>();
        assert_eq!(unsafe { CStr::from_ptr(line) }.to_bytes(), b"request");
        pocket_apple_destroy(app); // Rejected while the effect sink is active.
        assert_eq!(pocket_apple_post_event(app, c"response".as_ptr()), 0);
    }
    #[test]
    fn effects_can_post_a_reply_without_reentering_runtime_dispatch() {
        let app = Apple::new();
        assert_eq!(
            pocket_apple_set_effect_callback(app.0, Some(effect), app.0.cast()),
            0
        );
        assert_eq!(app.boot("let count=0;globalThis.frame=function(){if(count++===0){ui.svcSend('request')}else if(ui.svcPoll()!=='response\\n'){throw Error('reply missing')}}"),0);
        assert_eq!(app.tick(&[]), 0);
        assert_eq!(app.tick(&[]), 0);
    }
}
