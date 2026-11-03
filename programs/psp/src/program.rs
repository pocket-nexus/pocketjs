//! Program composition around the canonical runtime and the native GE driver.
use crate::{instance, profile};
use alloc::{boxed::Box, format, rc::Rc, string::String};
use core::cell::{Cell, RefCell, RefMut};
use libquickjs_sys::{JSContext, JSValue};
use pocket_psp_render::{native::NativeDevice, Config, GeDisplay, GeRenderer, SharedRenderer};
use pocket_runtime::{
    abi::{self, status_code, Handle},
    CoreState, OpContext, RuntimeConfig, RuntimeError,
};

/// One `present` call: the previous list's residual GE wait and its paced
/// swap, then this frame's encode and kick.
#[derive(Clone, Copy, Default)]
pub struct FrameTiming {
    /// The DrawList is built: the previous list's wait, or this encode, starts.
    pub after_draw: u64,
    /// This frame's list is kicked.
    pub after_render: u64,
    /// Residual wait for the previous list.
    pub gpu_us: u64,
    /// VBlank pacing and buffer swap of the previous list.
    pub present_us: u64,
}
struct PacedDevice {
    device: NativeDevice,
    clock: Rc<Cell<u32>>,
    /// 60 Hz vblanks per presented frame, set at boot from the cadence.
    vblanks: Rc<Cell<u32>>,
    timing: Rc<Cell<FrameTiming>>,
}
// Delegates the driver's pointer lifetime contract to NativeDevice. Pacing
// happens after its terminal wait and before swapping the display buffers.
// Within one present the previous list's wait and swap precede this begin.
unsafe impl pocket_psp_render::Device for PacedDevice {
    fn begin(&mut self) -> Result<(), pocket_drivers::RenderError> {
        let mut t = self.timing.get();
        if t.after_draw == 0 {
            t.after_draw = crate::host::now_us();
        }
        self.timing.set(t);
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
        if t.after_draw == 0 {
            t.after_draw = start;
        }
        t.gpu_us = t.gpu_us.saturating_add(crate::host::now_us() - start);
        self.timing.set(t);
        result
    }
    fn present(&mut self) -> Result<(), pocket_drivers::DisplayError> {
        let start = crate::host::now_us();
        unsafe {
            loop {
                let elapsed = psp::sys::sceDisplayGetVcount().wrapping_sub(self.clock.get());
                if elapsed >= self.vblanks.get() && psp::sys::sceDisplayIsVblank() != 0 {
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
/// A PSP graphics-thread runtime. present() kicks a GE list and returns; the
/// GE draws it while the next guest turn runs. The next present() syncs that
/// list, paces and swaps it, then kicks its own. Zero-copy texture storage
/// the list reads stays unchanged until then; no other borrow survives.
pub struct Runtime {
    /// Declared first: it drops right after `Drop::drop` returns, so the
    /// canonical shutdown precedes the guest adapter and its context.
    handle: Box<Handle>,
    guest: Box<instance::Guest>,
    ops: OpContext,
    input: Rc<RefCell<instance::Input>>,
    renderer: SharedRenderer<PacedDevice>,
    timing: Rc<Cell<FrameTiming>>,
    vblanks: Rc<Cell<u32>>,
}
impl Runtime {
    /// # Safety
    /// GU is initialized and this is the only program using host::list_ptr().
    /// Drop the prior Runtime before booting another guest or opening native lists.
    pub unsafe fn new(
        source: Box<dyn pocket_drivers::PackageSource>,
        fixed_cadence: Option<u32>,
        clock: Rc<Cell<u32>>,
    ) -> Result<Self, String> {
        let _fpu = crate::host::FpuGuard::masked();
        let handle = Handle::new(RuntimeConfig {
            profile_hash: profile::PROFILE_HASH,
            host_abi: profile::HOST_ABI,
            heap_limit: 128 * 1024 * 1024,
            frame_buffer_budget: 1,
            profile: profile::profile().expect("build.rs requires an exported profile"),
        })
        .map_err(|error| format!("PSP runtime profile rejected: {error:?}"))?;
        let ops = handle.op_context();
        let guest = instance::Guest::new(ops.clone(), fixed_cadence)?;
        let timing = Rc::new(Cell::new(FrameTiming::default()));
        let vblanks = Rc::new(Cell::new(1));
        let device = PacedDevice {
            device: NativeDevice::new(crate::host::list_ptr()),
            clock,
            vblanks: vblanks.clone(),
            timing: timing.clone(),
        };
        let renderer = match GeRenderer::new(device, Config::psp()) {
            Ok(v) => SharedRenderer::new(v),
            Err(e) => return Err(format!("{e:?}")),
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
            vblanks,
        };
        runtime
            .ops
            .add_provider(Box::new(instance::Services))
            .map_err(|e| format!("{e:?}"))?;
        runtime
            .ops
            .set_compositor_enabled(true)
            .map_err(|e| format!("{e:?}"))?;
        runtime.call(|r| r.set_package_source(source))?;
        let input = Box::new(instance::InputDriver(runtime.input.clone()));
        runtime.call(|r| r.add_input_source(input))?;
        let renderer = runtime.renderer.clone();
        let id = runtime
            .handle
            .with_runtime(|r| r.add_renderer(renderer))
            .map_err(|error| format!("renderer registration {}", status_code(error)))?;
        let display = GeDisplay::new(runtime.renderer.clone());
        runtime.call(|r| r.add_display(display, id).map(|_| ()))?;
        let context = (&mut *runtime.guest as *mut instance::Guest).cast();
        runtime.check(abi::pocket_runtime_set_guest(
            runtime.handle.as_ptr(),
            &instance::GUEST,
            context,
        ))?;
        Ok(runtime)
    }
    /// One runtime call; a failure reads as `check` reports its status.
    fn call(
        &self,
        action: impl FnOnce(&mut pocket_runtime::Runtime) -> Result<(), RuntimeError>,
    ) -> Result<(), String> {
        self.check(
            self.handle
                .with_runtime(action)
                .map_or_else(status_code, |_| 0),
        )
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
        self.call(pocket_runtime::Runtime::boot_deferred)?;
        // The guest recorded the admitted rate and the cadence it published.
        let sim_hz = self.guest.sim_hz.get();
        if sim_hz == 0 || 60 % sim_hz != 0 {
            return Err(alloc::format!("PSP cannot present at {sim_hz} Hz"));
        }
        self.vblanks.set(60 / sim_hz);
        self.call(pocket_runtime::Runtime::skip_presentation)
    }
    /// Guest frames per second after boot (__simHz).
    pub fn sim_hz(&self) -> u32 {
        self.guest.sim_hz.get()
    }
    /// Core ticks each guest frame advances after boot.
    pub fn core_ticks(&self) -> u32 {
        self.guest.tick_hz.get() / self.guest.sim_hz.get().max(1)
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
        self.call(|r| r.advance_with_core_ticks(ticks))
    }
    /// # Safety
    /// Owning graphics thread, no core guard. The GE may still draw the
    /// previous list; this call completes it before kicking the next one.
    pub unsafe fn present(&mut self) -> Result<(), String> {
        let _fpu = crate::host::FpuGuard::masked();
        self.timing.set(FrameTiming::default());
        {
            // A video frame commit while the GE reads the plane writes new
            // texture storage; the core keeps the old storage until retire.
            let mut state = self.ops.core_mut().map_err(|e| format!("{e:?}"))?;
            crate::vid::present(&mut state.ui);
            crate::media::present(&mut state.ui);
        }
        self.call(pocket_runtime::Runtime::present)
    }
    /// Sync, pace and swap the list kicked by the last present(), so the
    /// display shows it and the GE is idle.
    /// # Safety
    /// Owning graphics thread, no core guard.
    pub unsafe fn complete(&mut self) -> Result<(), String> {
        let _fpu = crate::host::FpuGuard::masked();
        self.call(pocket_runtime::Runtime::complete_presentation)
    }
    /// # Safety
    /// Owning guest thread, no core guard or JS call is active.
    pub unsafe fn collect(&mut self) -> Result<(), String> {
        self.call(pocket_runtime::Runtime::collect)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            let _fpu = crate::host::FpuGuard::masked();
            // Show the frame in flight before the renderer stops the GE.
            let _ = self
                .handle
                .with_runtime(pocket_runtime::Runtime::complete_presentation);
            self.renderer.reset();
            if let Ok(mut state) = self.ops.core_mut() {
                crate::vid::close(&mut state.ui);
            }
            crate::audio_mod::reset();
            crate::svc::reset();
            crate::pack_ops::reset();
            crate::media::reset();
            crate::offload::reset();
            crate::offload_local::reset();
            // `handle` drops next: canonical shutdown invalidates bindings
            // before the guest adapter/context are dropped.
        }
    }
}
