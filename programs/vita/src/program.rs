use crate::{graphics, input, instance, profile, svc, switch, vid, vita_log};
use libquickjs_sys::*;
use pocket_runtime::{CoreState, OpContext, RuntimeConfig};
use pocket_runtime_cabi::{abi::*, embedding as embed};
use pocketjs_core::Ui;
use std::{
    cell::{RefCell, RefMut},
    rc::Rc,
    string::String,
};
static mut INPUT_INITIALIZED: bool = false;
static mut GUEST_NATIVE_ACTIVE: bool = false;
/// A core guard is scoped to this runtime. It cannot outlive the instance or
/// overlap a runtime call that borrows the retained tree.
pub struct UiGuard<'a>(RefMut<'a, CoreState>);
impl std::ops::Deref for UiGuard<'_> {
    type Target = Ui;
    fn deref(&self) -> &Ui {
        &self.0.ui
    }
}
impl std::ops::DerefMut for UiGuard<'_> {
    fn deref_mut(&mut self) -> &mut Ui {
        &mut self.0.ui
    }
}

/// Vita composition around one canonical runtime C handle and generated C
/// guest. Native namespaces can still use context()/global() before
/// eval_package().
pub struct Runtime {
    handle: *mut PocketRuntime,
    guest: Box<instance::Guest>,
    ops: OpContext,
    input: Rc<RefCell<instance::Input>>,
    booted: bool,
}
impl Runtime {
    /// # Safety
    /// One live guest on the Vita render thread. Shutdown at a closed scene
    /// boundary before replacing it. Native QuickJS extensions use this realm.
    pub unsafe fn new() -> Result<Self, String> {
        if GUEST_NATIVE_ACTIVE {
            return Err("previous PocketJS Vita guest was not shut down".into());
        }
        graphics::init().map_err(String::from)?;
        if !INPUT_INITIALIZED {
            input::init();
            INPUT_INITIALIZED = true;
        }
        let handle = embed::create(RuntimeConfig {
            profile_hash: profile::PROFILE_HASH,
            host_abi: profile::HOST_ABI,
            heap_limit: 128 * 1024 * 1024,
            frame_buffer_budget: 1,
            profile: profile::profile().expect("build.rs requires an exported profile"),
        })
        .map_err(|error| format!("Vita runtime profile rejected: {error:?}"))?;
        let ops = match embed::op_context(handle) {
            Ok(ops) => ops,
            Err(error) => {
                pocket_runtime_cabi::pocket_runtime_destroy(handle);
                return Err(format!("{error:?}"));
            }
        };
        let guest = match instance::Guest::new(ops.clone()) {
            Ok(guest) => guest,
            Err(error) => {
                pocket_runtime_cabi::pocket_runtime_destroy(handle);
                return Err(error);
            }
        };
        let input = Rc::new(RefCell::new(instance::Input {
            analog: 0x8080,
            ..Default::default()
        }));
        let mut runtime = Self {
            handle,
            guest,
            ops,
            input,
            booted: false,
        };
        runtime
            .ops
            .add_provider(Box::new(instance::Services))
            .map_err(|e| format!("{e:?}"))?;
        runtime
            .ops
            .set_compositor_enabled(true)
            .map_err(|e| format!("{e:?}"))?;
        graphics::register(handle)?;
        runtime.check(embed::add_input_source(
            handle,
            Box::new(instance::InputDriver(runtime.input.clone())),
        ))?;
        let context = (&mut *runtime.guest as *mut instance::Guest).cast();
        runtime.check(pocket_runtime_cabi::pocket_runtime_set_guest(
            handle,
            &instance::GUEST,
            context,
        ))?;
        GUEST_NATIVE_ACTIVE = true;
        Ok(runtime)
    }
    fn check(&self, status: i32) -> Result<(), String> {
        if status == 0 {
            Ok(())
        } else {
            let error = self.guest.error();
            Err(if error.is_empty() {
                format!("PocketJS Vita runtime failed ({status})")
            } else {
                error
            })
        }
    }
    pub fn context(&self) -> *mut JSContext {
        self.guest.context
    }
    pub fn global(&self) -> JSValue {
        self.guest.global
    }
    /// # Safety
    /// Keep this guard on the render thread and drop it before runtime calls.
    pub unsafe fn ui(&mut self) -> UiGuard<'_> {
        UiGuard(self.ops.core_mut().expect("inactive Vita runtime"))
    }
    /// Boot the original .pocket bytes, including its admission facts. Runtime
    /// owns the source and retains its selected package through guest shutdown.
    /// # Safety
    /// Call once on the owning thread before any shared native scene opens.
    pub unsafe fn eval_package(&mut self, bytes: impl AsRef<[u8]> + 'static) -> Result<(), String> {
        self.boot_bytes(bytes)
    }
    /// Boot a device file source through the sole Runtime loader.
    /// # Safety
    /// Same owning-thread and once-before-frame requirements as eval_package().
    pub unsafe fn eval_source(
        &mut self,
        source: impl pocket_drivers::PackageSource + 'static,
    ) -> Result<(), String> {
        if self.booted {
            return Err("Vita guest already booted".into());
        }
        self.check(embed::set_package_source(self.handle, Box::new(source)))?;
        self.check(embed::boot_deferred(self.handle))?;
        self.finish_boot()
    }
    unsafe fn boot_bytes(&mut self, bytes: impl AsRef<[u8]> + 'static) -> Result<(), String> {
        if self.booted {
            return Err("Vita guest already booted".into());
        }
        self.check(instance::boot_package(self.handle, bytes))?;
        self.finish_boot()
    }
    unsafe fn finish_boot(&mut self) -> Result<(), String> {
        // Native hosts may install their 3D scene after eval. Match the old
        // embedding boundary: no GPU command is submitted by eval itself.
        self.check(embed::skip_presentation(self.handle))?;
        let frame = JS_GetPropertyStr(self.context(), self.global(), c"frame".as_ptr());
        let missing_frame = JS_IsUndefined(frame);
        JS_FreeValue(self.context(), frame);
        if missing_frame {
            return Err("globalThis.frame is undefined".into());
        }
        self.booted = true;
        Ok(())
    }
    /// # Safety
    /// Call once per presented frame on the owning thread.
    pub unsafe fn frame(&mut self, buttons: i32) -> Result<(), String> {
        self.frame_with_analog(buttons, 0x8080)
    }
    /// # Safety
    /// Same requirements as frame().
    pub unsafe fn frame_with_analog(&mut self, buttons: i32, analog: i32) -> Result<(), String> {
        self.frame_with_input(buttons, analog, &input::TouchSnapshot::EMPTY)
    }
    /// # Safety
    /// No core guard or frame resource borrow may remain live here.
    pub unsafe fn frame_with_input(
        &mut self,
        buttons: i32,
        analog: i32,
        touches: &input::TouchSnapshot,
    ) -> Result<(), String> {
        {
            let mut input = self.input.borrow_mut();
            input.buttons = buttons as u32;
            input.analog = analog as u32;
            input.contacts.clear();
            for &word in touches.packed() {
                input.contacts.push(pocket_drivers::Contact {
                    surface: 0,
                    id: word >> 18,
                    x: (word & 511) as f32,
                    y: ((word >> 9) & 511) as f32,
                    cancelled: false,
                });
            }
        }
        self.check(embed::advance(self.handle))
    }
    /// The canonical advance already ticks the core once. Kept so native
    /// embedders can retain their frame(); tick(); render_over() call sequence.
    /// # Safety
    /// Call on the owning thread after frame().
    pub unsafe fn tick(&mut self) {}
    /// # Safety
    /// Call on the owning thread without an outstanding core borrow.
    pub unsafe fn drain_jobs(&mut self) -> Result<(), String> {
        self.check(embed::collect(self.handle))
    }
    /// # Safety
    /// Call with no open scene. This call presents the completed frame.
    pub unsafe fn render(&mut self) {
        self.render_with_overlay(|| {});
    }
    /// Record a native overlay after UI draw and before the terminal GPU wait.
    /// # Safety
    /// No scene is open. The closure may draw native geometry but must not
    /// mutate the UI or reenter this runtime while frame resources are borrowed.
    pub unsafe fn render_with_overlay(&mut self, overlay: impl FnMut()) {
        graphics::begin_frame(0xff00_0000);
        self.render_over_with(overlay);
    }
    /// # Safety
    /// A shared native scene is open. Commands after the UI pass belong in
    /// render_over_with's closure; this call returns after presentation.
    pub unsafe fn render_over(&mut self) {
        self.render_over_with(|| {});
    }
    /// # Safety
    /// A shared native scene is open; overlay records only native commands.
    pub unsafe fn render_over_with(&mut self, mut overlay: impl FnMut()) {
        if let Ok(mut state) = self.ops.core_mut() {
            vid::present(&mut state.ui);
        }
        let status = embed::present_with_overlay(self.handle, |_| overlay());
        if let Err(error) = self.check(status) {
            graphics::discard_frame();
            vita_log(format_args!("{error}"));
        } else {
            graphics::mark_presented();
        }
    }
    /// # Safety
    /// Call after the outgoing frame is presented, on the render thread.
    pub unsafe fn capture_switch_shot(&mut self) {
        if let Ok(mut state) = self.ops.core_mut() {
            state.ui.draw();
            switch::capture_shot(&state.ui, &state.ui.current_draw_list().words);
        }
    }
    /// # Safety
    /// Call at a closed-scene boundary, with no outstanding UiGuard.
    pub unsafe fn shutdown(mut self) {
        if let Ok(mut state) = self.ops.core_mut() {
            vid::close(&mut state.ui);
        }
        svc::reset();
        self.destroy();
        graphics::reset_guest();
        GUEST_NATIVE_ACTIVE = false;
    }
    #[cfg(feature = "capture")]
    /// # Safety
    /// Call after presentation with no outstanding core guard.
    pub unsafe fn capture_golden(&mut self, path: &str) -> std::io::Result<()> {
        let mut state = self
            .ops
            .core_mut()
            .map_err(|e| std::io::Error::other(format!("{e:?}")))?;
        state.ui.draw();
        graphics::capture_golden(&state.ui, &state.ui.current_draw_list().words, path)
    }
    unsafe fn destroy(&mut self) {
        if !self.handle.is_null() {
            pocket_runtime_cabi::pocket_runtime_destroy(self.handle);
            self.handle = std::ptr::null_mut();
        }
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            self.destroy();
        }
    }
}
