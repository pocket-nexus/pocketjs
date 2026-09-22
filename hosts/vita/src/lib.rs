#![allow(static_mut_refs)]

extern crate alloc;

use core::ffi::c_void;
use std::fmt;
use std::string::String;

use libquickjs_sys::*;
use pocketjs_core::Ui;

pub mod audio;
pub mod dbg;
pub mod dev;
#[cfg(feature = "usb-debug")]
mod dev_delivery;
pub mod dev_protocol;
pub mod devmenu;
pub mod ffi;
pub mod graphics;
pub mod input;
pub mod net;
pub mod pak;
pub mod stats;
pub mod svc;
pub mod switch;
pub mod vid;

static mut INPUT_INITIALIZED: bool = false;
/// A plain `Drop` is allowed to happen inside an external host's open scene, so
/// guest-native teardown is explicit. Refuse a second guest until the previous
/// one crossed `Runtime::shutdown` at a safe frame boundary.
static mut GUEST_NATIVE_ACTIVE: bool = false;

extern "C" {
    fn JS_SetInterruptHandler(
        rt: *mut JSRuntime,
        callback: Option<unsafe extern "C" fn(*mut JSRuntime, *mut c_void) -> i32>,
        opaque: *mut c_void,
    );
    fn JS_NewArray(ctx: *mut JSContext) -> JSValue;
    fn JS_SetPropertyUint32(
        ctx: *mut JSContext,
        this_obj: JSValue,
        index: u32,
        value: JSValue,
    ) -> i32;
    fn JS_NewArrayBuffer(
        ctx: *mut JSContext,
        buf: *mut u8,
        len: usize,
        free_func: Option<unsafe extern "C" fn(*mut JSRuntime, *mut c_void, *mut c_void)>,
        opaque: *mut c_void,
        is_shared: i32,
    ) -> JSValue;
    fn JS_ExecutePendingJob(rt: *mut JSRuntime, pctx: *mut *mut JSContext) -> i32;
    fn sceClibPrintf(fmt: *const i8, ...) -> i32;
}

pub fn vita_log(args: fmt::Arguments<'_>) {
    use std::fmt::Write;
    let mut line = String::new();
    let _ = line.write_fmt(args);
    line.push('\0');
    unsafe {
        sceClibPrintf(c"%s\n".as_ptr(), line.as_ptr());
    }
}

unsafe fn exception_string(ctx: *mut JSContext) -> String {
    let value = JS_GetException(ctx);
    let mut len: size_t = 0;
    let ptr = JS_ToCStringLen2(ctx, &mut len, value, 0);
    let message = if ptr.is_null() {
        String::from("unknown JavaScript exception")
    } else {
        let bytes = core::slice::from_raw_parts(ptr as *const u8, len);
        let text = String::from_utf8_lossy(bytes).into_owned();
        JS_FreeCString(ctx, ptr);
        text
    };
    JS_FreeValue(ctx, value);
    message
}

/// Reusable PocketJS Vita host. External games can register additional
/// QuickJS namespaces through `context()`/`global()` before calling `eval()`.
pub struct Runtime {
    rt: *mut JSRuntime,
    ctx: *mut JSContext,
    global: JSValue,
    frame_fn: JSValue,
    owned_pak: Option<std::sync::Arc<[u8]>>,
    deadline: Box<std::time::Instant>,
}

impl Runtime {
    /// Initialize process-level Vita services (once), then create one fresh
    /// PocketJS guest: core, pak textures and QuickJS realm.
    /// `app_pak` must outlive the runtime because `globalThis.__pak` borrows it.
    ///
    /// # Safety
    ///
    /// Construct only one live runtime at a time, on the Vita render thread.
    /// Call [`Runtime::shutdown`] at a closed-scene frame boundary before
    /// booting another guest. Keep all runtime and graphics access on the same
    /// thread.
    pub unsafe fn new(app_pak: &'static [u8]) -> Result<Self, String> {
        if GUEST_NATIVE_ACTIVE {
            return Err(String::from(
                "previous PocketJS Vita guest was not shut down",
            ));
        }
        graphics::init().map_err(String::from)?;
        if !INPUT_INITIALIZED {
            input::init();
            INPUT_INITIALIZED = true;
        }

        let ui = ffi::init_ui();
        pak::install(app_pak);
        let (textures, sprites) = pak::feed(ui, app_pak);
        switch::upload_shot(ui);
        GUEST_NATIVE_ACTIVE = true;

        let rt = JS_NewRuntime();
        if rt.is_null() {
            reset_guest_state();
            return Err(String::from("JS_NewRuntime failed"));
        }
        let ctx = JS_NewContext(rt);
        if ctx.is_null() {
            JS_FreeRuntime(rt);
            reset_guest_state();
            return Err(String::from("JS_NewContext failed"));
        }
        let global = JS_GetGlobalObject(ctx);
        let mut deadline = Box::new(std::time::Instant::now() + std::time::Duration::from_secs(5));
        if cfg!(feature = "usb-debug") {
            JS_SetInterruptHandler(
                rt,
                Some(guest_interrupt),
                (&mut *deadline as *mut std::time::Instant).cast(),
            );
        }
        ffi::register(ctx, global, &textures, &sprites);
        if !app_pak.is_empty() {
            let ptr = app_pak.as_ptr() as *mut u8;
            let buffer = JS_NewArrayBuffer(ctx, ptr, app_pak.len(), None, ptr as *mut c_void, 0);
            JS_SetPropertyStr(ctx, global, c"__pak".as_ptr(), buffer);
        }
        Ok(Self {
            rt,
            ctx,
            global,
            frame_fn: JS_UNDEFINED,
            owned_pak: None,
            deadline,
        })
    }

    /// Own a hot-updated PAK until QuickJS and native resources are retired.
    /// The render-thread and closed-scene requirements of `new` still apply.
    pub unsafe fn with_owned_pak(pak: std::sync::Arc<[u8]>) -> Result<Self, String> {
        // The Arc is retained in Runtime; shutdown clears every borrower before
        // releasing it. Drop without shutdown retains it, as it cannot retire
        // native resources inside an external host's open scene.
        let bytes = core::slice::from_raw_parts(pak.as_ptr(), pak.len());
        let mut runtime = Self::new(bytes)?;
        runtime.owned_pak = Some(pak);
        Ok(runtime)
    }

    #[inline]
    pub fn context(&self) -> *mut JSContext {
        self.ctx
    }

    #[inline]
    pub fn global(&self) -> JSValue {
        self.global
    }

    #[inline]
    /// Borrow the runtime's process-global PocketJS core.
    ///
    /// # Safety
    ///
    /// Stay on the owning render thread and do not retain this reference
    /// across another call that accesses the core.
    pub unsafe fn ui(&mut self) -> &'static mut Ui {
        ffi::ui()
    }

    /// Evaluate a NUL-terminated bundle and retain `globalThis.frame`.
    ///
    /// # Safety
    ///
    /// Call on the runtime's owning thread. The bundle must obey PocketJS's
    /// single-realm host contract.
    pub unsafe fn eval(&mut self, app_js: &str) -> Result<(), String> {
        *self.deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let Some(len) = app_js
            .len()
            .checked_sub(1)
            .filter(|_| app_js.as_bytes().last() == Some(&0))
        else {
            return Err(String::from("PocketJS Vita bundle must be NUL-terminated"));
        };
        let result = JS_Eval(
            self.ctx,
            app_js.as_ptr() as *const i8,
            len,
            c"game.js".as_ptr(),
            JS_EVAL_TYPE_GLOBAL as i32,
        );
        if JS_IsException(result) {
            return Err(exception_string(self.ctx));
        }
        JS_FreeValue(self.ctx, result);
        let frame_fn = JS_GetPropertyStr(self.ctx, self.global, c"frame".as_ptr());
        if JS_IsUndefined(frame_fn) {
            JS_FreeValue(self.ctx, frame_fn);
            return Err(String::from("globalThis.frame is undefined"));
        }
        if !JS_IsUndefined(self.frame_fn) {
            JS_FreeValue(self.ctx, self.frame_fn);
        }
        self.frame_fn = frame_fn;
        Ok(())
    }

    unsafe fn call_frame(&mut self, values: &mut [JSValue]) -> Result<(), String> {
        *self.deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
        let result = JS_Call(
            self.ctx,
            self.frame_fn,
            self.global,
            values.len() as i32,
            values.as_mut_ptr(),
        );
        if JS_IsException(result) {
            return Err(exception_string(self.ctx));
        }
        JS_FreeValue(self.ctx, result);
        self.drain_jobs()
    }

    /// Run one guest frame with a Vita button mask.
    ///
    /// # Safety
    ///
    /// Call on the runtime's owning thread with no outstanding mutable UI
    /// borrow.
    pub unsafe fn frame(&mut self, buttons: i32) -> Result<(), String> {
        self.call_frame(&mut [JS_NewInt32(self.ctx, buttons)])
    }

    /// Two-argument variant for apps that consume the packed left analog
    /// value separately. Standard PocketJS bundles simply ignore arg 2.
    ///
    /// # Safety
    ///
    /// Call on the runtime's owning thread with no outstanding mutable UI
    /// borrow.
    pub unsafe fn frame_with_analog(&mut self, buttons: i32, analog: i32) -> Result<(), String> {
        self.call_frame(&mut [
            JS_NewInt32(self.ctx, buttons),
            JS_NewInt32(self.ctx, analog),
        ])
    }

    /// Full stock-host input frame: buttons, packed left analog, and a front
    /// touch snapshot already mapped into PocketJS logical coordinates.
    ///
    /// # Safety
    ///
    /// Call on the runtime's owning thread with no outstanding mutable UI
    /// borrow.
    pub unsafe fn frame_with_input(
        &mut self,
        buttons: i32,
        analog: i32,
        touches: &input::TouchSnapshot,
    ) -> Result<(), String> {
        let packed = touches.packed();
        let touch_array = JS_NewArray(self.ctx);
        for (index, value) in packed.iter().enumerate() {
            JS_SetPropertyUint32(
                self.ctx,
                touch_array,
                index as u32,
                JS_NewInt32(self.ctx, *value as i32),
            );
        }
        // Touch hit facts (frame arg 4, docs/TOUCH.md): each NEW contact is
        // bounds-hit ONCE against the committed frame the user is looking at
        // and carried by the core's capture table — the guest never queries
        // on the touch path.
        let mut hits = [0i32; 8];
        let hit_count = ffi::ui().touch_hits(packed, &mut hits);
        let hits_array = JS_NewArray(self.ctx);
        for (index, hit) in hits[..hit_count].iter().enumerate() {
            JS_SetPropertyUint32(
                self.ctx,
                hits_array,
                index as u32,
                JS_NewInt32(self.ctx, *hit),
            );
        }
        let result = self.call_frame(&mut [
            JS_NewInt32(self.ctx, buttons),
            JS_NewInt32(self.ctx, analog),
            touch_array,
            hits_array,
        ]);
        JS_FreeValue(self.ctx, hits_array);
        JS_FreeValue(self.ctx, touch_array);
        result
    }

    /// Drain QuickJS promise jobs queued by the current guest turn.
    ///
    /// # Safety
    ///
    /// Call only on the runtime's owning thread.
    pub unsafe fn drain_jobs(&mut self) -> Result<(), String> {
        loop {
            if cfg!(feature = "usb-debug") && std::time::Instant::now() > *self.deadline {
                return Err("guest JavaScript time budget exceeded".into());
            }
            let mut pending_ctx: *mut JSContext = core::ptr::null_mut();
            let result = JS_ExecutePendingJob(self.rt, &mut pending_ctx);
            if result > 0 {
                continue;
            }
            if result < 0 {
                return Err(exception_string(if pending_ctx.is_null() {
                    self.ctx
                } else {
                    pending_ctx
                }));
            }
            return Ok(());
        }
    }

    /// Advance the fixed-step PocketJS core clock once.
    ///
    /// # Safety
    ///
    /// Call only on the runtime's owning thread with no outstanding UI borrow.
    pub unsafe fn tick(&mut self) {
        ffi::ui().tick();
    }

    fn draw_words(&mut self) -> (*const u32, usize) {
        unsafe {
            let list = ffi::ui().draw();
            (list.words.as_ptr(), list.words.len())
        }
    }

    /// Render a standalone PocketJS frame into a new vita2d scene. The video
    /// plane's staged frame commits here — begin_frame's rendering-done wait
    /// is the GXM-idle window (the GE-race discipline, GXM edition).
    ///
    /// # Safety
    ///
    /// Call only on the Vita render thread with no scene already open.
    pub unsafe fn render(&mut self) {
        let (ptr, len) = self.draw_words();
        graphics::begin_frame(0xff00_0000);
        vid::present(ffi::ui());
        graphics::render_over(ffi::ui(), core::slice::from_raw_parts(ptr, len));
    }

    /// Composite the PocketJS DrawList into the caller's open vita2d scene.
    ///
    /// # Safety
    ///
    /// Call only on the Vita render thread while a vita2d scene is open.
    pub unsafe fn render_over(&mut self) {
        let (ptr, len) = self.draw_words();
        graphics::render_over(ffi::ui(), core::slice::from_raw_parts(ptr, len));
    }

    /// Freeze the current guest's last DrawList for a launcher summon. This is
    /// deliberately a CPU raster path: current Vita3K/macOS GXM framebuffer
    /// readback is incoherent, while the DrawList is deterministic on both
    /// emulator and hardware.
    ///
    /// # Safety
    ///
    /// Call after the guest frame has rendered/presented and before dropping
    /// the runtime, with no outstanding mutable `Ui` borrow.
    pub unsafe fn capture_switch_shot(&mut self) {
        let (ptr, len) = self.draw_words();
        switch::capture_shot(ffi::ui(), core::slice::from_raw_parts(ptr, len));
    }

    /// Finish a guest so another embedded app can boot. Unlike `Drop`, this
    /// retires GPU handles and drops the process-global `Ui`/pak binding.
    /// vita2d and controller sampling remain initialized for the process.
    ///
    /// External native hosts must call this with no open vita2d scene and
    /// before `vita2d_fini`; the stock launcher calls it immediately after the
    /// outgoing frame's `present`.
    ///
    /// # Safety
    ///
    /// Call on the owning render thread with no outstanding `Ui` reference.
    pub unsafe fn shutdown(mut self) {
        // The svc surface is process-global; the guest is not. Close the video
        // plane (frees the GXM texture, releases the audio port on this thread)
        // and clear the mailbox so the next guest cannot read this guest's
        // lines or side files. The net supervisor itself stays up — the TCP
        // session outlives guest switches by design.
        vid::close(ffi::ui());
        svc::reset();
        self.release_quickjs();
        reset_guest_state();
        self.owned_pak = None;
    }

    /// Write a deterministic native-density 960x544 golden for the current UI
    /// tree while retaining PocketJS's 480x272 logical layout contract.
    ///
    /// # Safety
    ///
    /// Call only on the runtime's owning thread with no outstanding UI borrow.
    #[cfg(feature = "capture")]
    pub unsafe fn capture_golden(&mut self, path: &str) -> std::io::Result<()> {
        let (ptr, len) = self.draw_words();
        graphics::capture_golden(ffi::ui(), core::slice::from_raw_parts(ptr, len), path)
    }
}

unsafe extern "C" fn guest_interrupt(_rt: *mut JSRuntime, opaque: *mut c_void) -> i32 {
    (std::time::Instant::now() > *opaque.cast::<std::time::Instant>()) as i32
}

impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            // QJS owns no GXM resources, so this fallback remains safe if an
            // external host drops Runtime while composing an open scene. Full
            // guest replacement requires the explicit shutdown boundary above.
            self.release_quickjs();
            if let Some(pak) = self.owned_pak.take() {
                std::mem::forget(pak);
            }
        }
    }
}

impl Runtime {
    unsafe fn release_quickjs(&mut self) {
        if self.ctx.is_null() {
            return;
        }
        if !JS_IsUndefined(self.frame_fn) {
            JS_FreeValue(self.ctx, self.frame_fn);
            self.frame_fn = JS_UNDEFINED;
        }
        JS_FreeValue(self.ctx, self.global);
        self.global = JS_UNDEFINED;
        JS_FreeContext(self.ctx);
        self.ctx = core::ptr::null_mut();
        JS_FreeRuntime(self.rt);
        self.rt = core::ptr::null_mut();
    }
}

/// Tear down every guest-owned native surface while retaining process-level
/// vita2d/input initialization for the next app.
unsafe fn reset_guest_state() {
    graphics::reset_guest();
    ffi::reset_ui();
    pak::uninstall();
    GUEST_NATIVE_ACTIVE = false;
}
