//! Program composition around the canonical runtime and the native GE driver.
use crate::instance;
use alloc::{boxed::Box, format, rc::Rc, string::String};
use core::cell::{Cell, RefCell, RefMut};
use libquickjs_sys::{JSContext, JSValue};
use pocket_psp_render::{native::NativeDevice, Config, GeDisplay, GeRenderer, SharedRenderer};
use pocket_runtime::{CoreState, OpContext};
use pocket_runtime_cabi::{abi::*, embedding as embed};

#[derive(Clone, Copy, Default)]
pub struct FrameTiming {
    pub after_draw: u64,
    pub after_render: u64,
    pub gpu_us: u64,
    pub present_us: u64,
}
struct PacedDevice {
    device: NativeDevice,
    clock: Rc<Cell<u32>>,
    ticks: u32,
    timing: Rc<Cell<FrameTiming>>,
}
// Delegates the driver's pointer lifetime contract to NativeDevice. Pacing
// happens after its terminal wait and before swapping the display buffers.
unsafe impl pocket_psp_render::Device for PacedDevice {
    fn begin(&mut self) -> Result<(), pocket_drivers::RenderError> {
        self.timing.set(FrameTiming {
            after_draw: crate::host::now_us(),
            ..FrameTiming::default()
        });
        self.device.begin()
    }
    fn begin_pass(&mut self, clear: bool) {
        self.device.begin_pass(clear)
    }
    fn clip(&mut self, clip: pocket_drivers::DamageRect) {
        self.device.clip(clip)
    }
    unsafe fn publish(&mut self, p: *const u8, n: usize) {
        self.device.publish(p, n)
    }
    unsafe fn bind(&mut self, t: Option<pocket_psp_render::TextureBinding>) {
        self.device.bind(t)
    }
    unsafe fn draw(&mut self, p: pocket_psp_render::Primitive, v: pocket_psp_render::Vertices<'_>) {
        self.device.draw(p, v)
    }
    fn end_pass(&mut self) {
        self.device.end_pass()
    }
    fn finish(&mut self) -> Result<(), pocket_drivers::RenderError> {
        let result = self.device.finish();
        let mut t = self.timing.get();
        t.after_render = crate::host::now_us();
        self.timing.set(t);
        result
    }
    fn wait(&mut self) -> Result<(), pocket_drivers::RenderError> {
        let start = crate::host::now_us();
        let result = self.device.wait();
        let mut t = self.timing.get();
        t.gpu_us = t.gpu_us.saturating_add(crate::host::now_us() - start);
        self.timing.set(t);
        result
    }
    fn present(&mut self) -> Result<(), pocket_drivers::DisplayError> {
        let start = crate::host::now_us();
        unsafe {
            loop {
                let elapsed = psp::sys::sceDisplayGetVcount().wrapping_sub(self.clock.get());
                if elapsed >= self.ticks && psp::sys::sceDisplayIsVblank() != 0 {
                    break;
                }
                psp::sys::sceDisplayWaitVblankStart();
            }
            self.clock.set(psp::sys::sceDisplayGetVcount());
        }
        let result = self.device.present();
        let mut t = self.timing.get();
        t.present_us = crate::host::now_us() - start;
        self.timing.set(t);
        result
    }
    fn stop(&mut self) {
        self.device.stop()
    }
}

pub struct UiGuard<'a>(RefMut<'a, CoreState>);
impl core::ops::Deref for UiGuard<'_> {
    type Target = pocketjs_core::Ui;
    fn deref(&self) -> &Self::Target {
        &self.0.ui
    }
}
impl core::ops::DerefMut for UiGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0.ui
    }
}
/// A PSP graphics-thread runtime. No resource borrow survives present().
pub struct Runtime {
    handle: *mut PocketRuntime,
    guest: Box<instance::Guest>,
    ops: OpContext,
    input: Rc<RefCell<instance::Input>>,
    renderer: SharedRenderer<PacedDevice>,
    timing: Rc<Cell<FrameTiming>>,
}
impl Runtime {
    /// # Safety
    /// GU is initialized and this is the only program using host::list_ptr().
    /// Drop the prior Runtime before booting another guest or opening native lists.
    pub unsafe fn new(
        source: Box<dyn pocket_drivers::PackageSource>,
        sim_hz: u32,
        clock: Rc<Cell<u32>>,
    ) -> Result<Self, String> {
        let _fpu = crate::host::FpuGuard::masked();
        let profile = instance::build_profile()?
            .ok_or("PSP runtime requires exported profile build inputs")?;
        let config = PocketRuntimeConfig {
            profile_hash: profile.hash,
            host_abi: env!("POCKETJS_HOST_ABI").parse().unwrap(),
            tick_hz: 60,
            heap_limit: 128 * 1024 * 1024,
            frame_buffer_budget: 1,
            profile_json: profile.json.as_ptr(),
            profile_json_length: profile.json.len(),
            ..PocketRuntimeConfig::empty()
        };
        let handle = pocket_runtime_cabi::pocket_runtime_create(&config);
        if handle.is_null() {
            return Err("PSP runtime profile rejected".into());
        }
        let ops = match embed::op_context(handle) {
            Ok(v) => v,
            Err(e) => {
                pocket_runtime_cabi::pocket_runtime_destroy(handle);
                return Err(format!("{e:?}"));
            }
        };
        let guest = match instance::Guest::new(ops.clone(), sim_hz) {
            Ok(v) => v,
            Err(e) => {
                pocket_runtime_cabi::pocket_runtime_destroy(handle);
                return Err(e);
            }
        };
        if sim_hz == 0 || 60 % sim_hz != 0 {
            pocket_runtime_cabi::pocket_runtime_destroy(handle);
            return Err("invalid PSP simulation rate".into());
        }
        let timing = Rc::new(Cell::new(FrameTiming::default()));
        let device = PacedDevice {
            device: NativeDevice::new(crate::host::list_ptr()),
            clock,
            ticks: 60 / sim_hz,
            timing: timing.clone(),
        };
        let renderer = match GeRenderer::new(device, Config::psp()) {
            Ok(v) => SharedRenderer::new(v),
            Err(e) => {
                pocket_runtime_cabi::pocket_runtime_destroy(handle);
                return Err(format!("{e:?}"));
            }
        };
        let input = Rc::new(RefCell::new(instance::Input {
            buttons: 0,
            analog: 0x8080,
        }));
        let mut runtime = Self {
            handle,
            guest,
            ops,
            input,
            renderer,
            timing,
        };
        runtime
            .ops
            .add_provider(Box::new(instance::Services))
            .map_err(|e| format!("{e:?}"))?;
        runtime
            .ops
            .set_compositor_enabled(true)
            .map_err(|e| format!("{e:?}"))?;
        runtime.check(embed::set_package_source(handle, source))?;
        runtime.check(embed::add_input_source(
            handle,
            Box::new(instance::InputDriver(runtime.input.clone())),
        ))?;
        let id = embed::add_renderer(handle, runtime.renderer.clone())
            .map_err(|status| format!("renderer registration {status}"))?;
        runtime.check(embed::add_display(
            handle,
            GeDisplay::new(runtime.renderer.clone()),
            id,
        ))?;
        let context = (&mut *runtime.guest as *mut instance::Guest).cast();
        runtime.check(pocket_runtime_cabi::pocket_runtime_set_guest(
            handle,
            &instance::GUEST,
            context,
        ))?;
        Ok(runtime)
    }
    fn check(&self, status: i32) -> Result<(), String> {
        if status == 0 {
            Ok(())
        } else {
            let error = self.guest.error();
            Err(if error.is_empty() {
                format!("PSP runtime failed ({status})")
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
    pub fn source_lengths(&self) -> (usize, usize) {
        (self.guest.code_length.get(), self.guest.pak_length.get())
    }
    pub fn frame_timing(&self) -> FrameTiming {
        self.timing.get()
    }
    pub fn eval_times(&self) -> (u64, u64) {
        (self.guest.eval_begin.get(), self.guest.eval_end.get())
    }
    pub fn phase_times(&self) -> (u64, u64) {
        (self.guest.after_js.get(), self.guest.after_jobs.get())
    }
    /// # Safety
    /// Drop this core guard before entering any Runtime or JS method.
    pub unsafe fn ui(&mut self) -> UiGuard<'_> {
        UiGuard(self.ops.core_mut().expect("inactive PSP Runtime"))
    }
    /// # Safety
    /// Owning graphics thread. Boot performs no GU submission.
    pub unsafe fn boot(&mut self) -> Result<(), String> {
        let _fpu = crate::host::FpuGuard::masked();
        self.check(embed::boot_deferred(self.handle))?;
        self.check(embed::skip_presentation(self.handle))
    }
    /// # Safety
    /// No core borrow or native GE submission is active. One guest turn, N ticks.
    pub unsafe fn advance(&mut self, buttons: u32, analog: u32, ticks: u32) -> Result<(), String> {
        let _fpu = crate::host::FpuGuard::masked();
        {
            let mut input = self.input.borrow_mut();
            input.buttons = buttons;
            input.analog = analog;
        }
        self.check(embed::advance_with_core_ticks(self.handle, ticks))
    }
    /// # Safety
    /// Owning graphics thread, no active native submission or core guard.
    pub unsafe fn present(&mut self) -> Result<(), String> {
        let _fpu = crate::host::FpuGuard::masked();
        {
            let mut state = self.ops.core_mut().map_err(|e| format!("{e:?}"))?;
            crate::vid::present(&mut state.ui);
        }
        self.check(embed::present(self.handle))
    }
    /// # Safety
    /// Owning guest thread, no core guard or JS call is active.
    pub unsafe fn collect(&mut self) -> Result<(), String> {
        self.check(embed::collect(self.handle))
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            let _fpu = crate::host::FpuGuard::masked();
            self.renderer.reset();
            if let Ok(mut state) = self.ops.core_mut() {
                crate::vid::close(&mut state.ui);
            }
            crate::audio_mod::reset();
            crate::svc::reset();
            crate::offload::reset();
            crate::offload_local::reset();
            pocket_runtime_cabi::pocket_runtime_destroy(self.handle);
            // guest adapter/context are dropped after canonical shutdown invalidates bindings.
        }
    }
}
