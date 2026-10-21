//! Registered wgpu display targets shared by native program compositions.
use anyhow::{Result, anyhow};
use pocket_drivers::*;
use pocket_web_render::{Submission, TargetId, WgpuRenderer};
use pocket3d::gpu::Gpu;
use std::{cell::RefCell, rc::Rc, sync::Arc};

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const FRAME_TARGETS: usize = 3;

pub type ProgramTarget = pocket3d::gpu::OffscreenTarget;
fn new_target(
    device: &wgpu::Device,
    size: (u32, u32),
    format: wgpu::TextureFormat,
) -> Result<ProgramTarget> {
    let limit = device.limits().max_texture_dimension_2d;
    anyhow::ensure!(
        size.0 > 0 && size.1 > 0 && size.0 <= limit && size.1 <= limit,
        "GPU target exceeds device limits: {size:?}"
    );
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Pocket retained render target"),
        size: wgpu::Extent3d {
            width: size.0,
            height: size.1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    Ok(ProgramTarget {
        texture,
        view,
        size,
    })
}
/// Each instance registers a real wgpu renderer and display with Runtime.
/// One UiProgram owns the registration lifetime. Clones configure that same
/// program's targets and compositor textures; they cannot register another
/// runtime. Dropping the registered renderer stops GPU work even when clones
/// retain this handle or completed frame leases.
#[derive(Clone)]
pub struct ProgramOutput(Rc<RefCell<OutputState>>);
struct OutputState {
    device: wgpu::Device,
    format: wgpu::TextureFormat,
    clear: wgpu::Color,
    fixed: bool,
    driver: Rc<RefCell<WgpuRenderer>>,
    frames: Vec<(Arc<ProgramTarget>, TargetId)>,
    size: (u32, u32),
    scale: f32,
    selected: Option<(Arc<ProgramTarget>, TargetId)>,
    last: Option<Arc<ProgramTarget>>,
    pending: Option<u64>,
    next_token: u64,
    registered: bool,
}
impl ProgramOutput {
    pub fn new(gpu: &Gpu, size: (u32, u32), scale: f32) -> Result<Self> {
        Self::with_options(gpu, size, scale, FORMAT, wgpu::Color::BLACK, false)
    }
    /// Fixed textures are updated in place. Submit scene reads on this GPU's
    /// queue before the next presentation; they are not immutable frame leases.
    pub fn with_options(
        gpu: &Gpu,
        size: (u32, u32),
        scale: f32,
        format: wgpu::TextureFormat,
        clear: wgpu::Color,
        fixed: bool,
    ) -> Result<Self> {
        let driver = WgpuRenderer::new(&gpu.device, &gpu.queue, format)
            .map_err(|error| anyhow!("wgpu renderer: {error:?}"))?;
        // Validate size before runtime admission, even before the first acquire.
        let target = Arc::new(new_target(&gpu.device, size, format)?);
        let driver = Rc::new(RefCell::new(driver));
        let id = driver
            .borrow_mut()
            .register_target(&target.view, size, scale, wgpu::LoadOp::Clear(clear))
            .map_err(|error| anyhow!("wgpu target: {error:?}"))?;
        Ok(Self(Rc::new(RefCell::new(OutputState {
            device: gpu.device.clone(),
            format,
            clear,
            fixed,
            driver,
            frames: vec![(target, id)],
            size,
            scale,
            selected: None,
            last: None,
            pending: None,
            next_token: 0,
            registered: false,
        }))))
    }
    pub fn register(&self, program: &mut pocket_ui_surface::UiProgram) -> Result<()> {
        let driver = {
            let mut state = self.0.borrow_mut();
            anyhow::ensure!(!state.registered, "output already has a registration owner");
            state.registered = true;
            state.driver.clone()
        };
        let renderer = program.add_renderer(RegisteredRenderer(driver))?;
        program.add_display(RegisteredDisplay(self.clone()), renderer)
    }
    pub fn size(&self) -> (u32, u32) {
        self.0.borrow().size
    }
    pub fn set_size(&self, size: (u32, u32)) -> Result<()> {
        let mut state = self.0.borrow_mut();
        anyhow::ensure!(
            !state.driver.borrow().is_shutdown(),
            "renderer is shut down"
        );
        anyhow::ensure!(state.pending.is_none(), "display transfer is still pending");
        let limit = state.device.limits().max_texture_dimension_2d;
        anyhow::ensure!(
            size.0 > 0 && size.1 > 0 && size.0 <= limit && size.1 <= limit,
            "GPU target exceeds device limits: {size:?}"
        );
        state.size = size;
        Ok(())
    }
    pub fn configure(&self, size: (u32, u32), scale: f32) -> Result<()> {
        anyhow::ensure!(
            scale.is_finite() && scale > 0.,
            "invalid presentation scale"
        );
        self.set_size(size)?;
        let mut state = self.0.borrow_mut();
        if state.scale != scale {
            for (_, id) in std::mem::take(&mut state.frames) {
                state.driver.borrow_mut().unregister_target(id);
            }
            state.last = None;
            state.selected = None;
            state.scale = scale;
        }
        Ok(())
    }
    pub fn first(&self) -> Option<Arc<ProgramTarget>> {
        self.0
            .borrow()
            .frames
            .first()
            .map(|(target, _)| target.clone())
    }
    pub fn pending_submissions(&self) -> usize {
        self.0.borrow().driver.borrow().pending_submissions()
    }
    pub fn prepare(&self) -> Result<bool> {
        let mut state = self.0.borrow_mut();
        anyhow::ensure!(
            !state.driver.borrow().is_shutdown(),
            "renderer is shut down"
        );
        anyhow::ensure!(state.pending.is_none(), "display transfer is still pending");
        state.selected = None;
        if state
            .frames
            .first()
            .is_some_and(|(frame, _)| frame.size != state.size)
        {
            for (_, id) in std::mem::take(&mut state.frames) {
                state.driver.borrow_mut().unregister_target(id);
            }
            state.last = None;
        }
        let i = if state.fixed && !state.frames.is_empty() {
            0
        } else if let Some(i) = state
            .frames
            .iter()
            .position(|(frame, _)| Arc::strong_count(frame) == 1)
        {
            i
        } else if state.frames.len() < FRAME_TARGETS {
            let target = Arc::new(new_target(&state.device, state.size, state.format)?);
            let id = state
                .driver
                .borrow_mut()
                .register_target(
                    &target.view,
                    state.size,
                    state.scale,
                    wgpu::LoadOp::Clear(state.clear),
                )
                .map_err(|error| anyhow!("wgpu target: {error:?}"))?;
            state.frames.push((target, id));
            state.frames.len() - 1
        } else {
            return Ok(false);
        };
        state.selected = Some(state.frames[i].clone());
        Ok(true)
    }
    pub fn last(&self) -> Option<Arc<ProgramTarget>> {
        self.0.borrow().last.clone()
    }
    pub fn set_surface(&self, handle: u32, target: &ProgramTarget, logical: (u32, u32)) {
        self.0
            .borrow()
            .driver
            .borrow_mut()
            .set_surface(handle, &target.view, logical);
    }
    pub fn retain_surfaces(&self, mut keep: impl FnMut(u32) -> bool) {
        // A host filter may drop its UiProgram. Do not hold either RefCell
        // borrow while calling it: RegisteredRenderer::drop must stop the GPU.
        let driver = self.0.borrow().driver.clone();
        let handles: Vec<_> = driver.borrow().surface_handles().collect();
        let retained: std::collections::HashSet<_> =
            handles.into_iter().filter(|&id| keep(id)).collect();
        driver
            .borrow_mut()
            .retain_surfaces(|id| retained.contains(&id));
    }
}
struct RegisteredRenderer(Rc<RefCell<WgpuRenderer>>);
impl Drop for RegisteredRenderer {
    fn drop(&mut self) {
        // render/wait's temporary RefMut has unwound before Coordinator drops
        // this wrapper. Output callbacks likewise run without a driver borrow.
        self.0.borrow_mut().shutdown();
    }
}
impl pocket_drivers::Renderer for RegisteredRenderer {
    type Submission = Submission;
    fn descriptor(&self) -> RendererDescriptor {
        self.0.borrow().descriptor()
    }
    fn render(
        &mut self,
        frame: &mut FrameInput<'_>,
    ) -> std::result::Result<Submission, RenderError> {
        self.0.borrow_mut().render(frame)
    }
    fn wait(&mut self, submission: &Submission) -> std::result::Result<(), RenderError> {
        self.0.borrow_mut().wait(submission)
    }
    fn retire(&mut self, submission: Submission) {
        self.0.borrow_mut().retire(submission);
    }
}
struct RegisteredDisplay(ProgramOutput);
impl DisplayOutput for RegisteredDisplay {
    type Token = u64;
    fn descriptor(&self) -> DisplayDescriptor {
        let state = self.0.0.borrow();
        DisplayDescriptor::new(
            DisplayRole::Primary,
            state.size.0,
            state.size.1,
            state.driver.borrow().descriptor().formats()[0],
            state.size.0 as usize * 4,
            TargetOwnership::DeviceOwned,
        )
    }
    // Compositor textures can change without changing the shell DrawList.
    // No retained-buffer identity: each published GPU frame redraws all layers.
    fn acquire(
        &mut self,
        region: Rect,
    ) -> std::result::Result<pocket_drivers::Target<'_>, DisplayError> {
        let state = self.0.0.borrow();
        if state.pending.is_some() {
            return Err(DisplayError::InvalidTarget);
        }
        let (_, id) = state.selected.as_ref().ok_or(DisplayError::InvalidTarget)?;
        let target = state
            .driver
            .borrow()
            .target(*id)
            .map_err(|_| DisplayError::InvalidTarget)?;
        if target.region != region {
            return Err(DisplayError::InvalidTarget);
        }
        Ok(pocket_drivers::Target::DeviceOwned(target))
    }
    fn flush(&mut self, _: &[Rect]) -> std::result::Result<u64, DisplayError> {
        let mut state = self.0.0.borrow_mut();
        if state.pending.is_some() || state.selected.is_none() {
            return Err(DisplayError::InvalidTarget);
        }
        state.next_token = state
            .next_token
            .checked_add(1)
            .ok_or(DisplayError::Failed)?;
        let token = state.next_token;
        state.pending = Some(token);
        Ok(token)
    }
    fn wait(&mut self, token: u64) -> std::result::Result<(), DisplayError> {
        let mut state = self.0.0.borrow_mut();
        if state.pending != Some(token) {
            return Err(DisplayError::InvalidTarget);
        }
        // Renderer::wait is terminal before flush. The window receives a lease
        // only after GPU writes finish; its sampling submission precedes reuse.
        state.pending = None;
        state.last = state.selected.take().map(|(target, _)| target);
        Ok(())
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_targets_bound_leases_and_survive_resize() {
        let gpu = Arc::new(Gpu::new_headless().unwrap());
        let output = ProgramOutput::new(&gpu, (32, 32), 1.).unwrap();
        let mut display = RegisteredDisplay(output.clone());
        let mut targets = Vec::new();
        for _ in 0..3 {
            assert!(output.prepare().unwrap());
            let token = display.flush(&[]).unwrap();
            display.wait(token).unwrap();
            targets.push(output.last().unwrap());
        }
        assert!(!output.prepare().unwrap());
        targets.remove(0);
        assert!(output.prepare().unwrap());
        output.set_size((64, 48)).unwrap();
        assert!(output.prepare().unwrap());
        assert_eq!(targets[0].size, (32, 32));
        assert!(output.set_size((0, 0)).is_err());
        assert_eq!(output.size(), (64, 48));
    }
    fn program() -> crate::UiProgram {
        crate::UiProgram::new(crate::ProgramConfig {
            host: "gpu-test",
            host_abi: 1,
            logical: [4, 4],
            density: 1,
            scale: 1,
            tick_hz: 60,
            heap_limit: 4 * 1024 * 1024,
            frame_buffer_budget: 1024,
        })
        .unwrap()
    }
    #[test]
    fn coordinator_unwind_stops_shared_driver_before_frame_release() {
        use std::{
            panic::{AssertUnwindSafe, catch_unwind},
            sync::atomic::{AtomicBool, Ordering},
        };
        let gpu = Gpu::new_headless().unwrap();
        let output = ProgramOutput::new(&gpu, (4, 4), 1.).unwrap();
        let mut program = program();
        output.register(&mut program).unwrap();
        let source = format!(
            "const t=ui.uploadTexture(new Uint8Array([255,0,0,255]).buffer,1,1,{});const n=ui.createNode({});ui.insertBefore(1,n,0);ui.setProp(n,{},4);ui.setProp(n,{},4);ui.setImage(n,t);globalThis.frame=()=>{{}};",
            pocketjs_core::spec::psm::PSM_8888,
            pocketjs_core::spec::NodeType::Image as u8,
            pocketjs_core::spec::prop::WIDTH,
            pocketjs_core::spec::prop::HEIGHT
        );
        program
            .boot(
                Rc::new(pocket_mod::Guest::new().unwrap()),
                "unwind",
                &source,
                &[],
            )
            .unwrap();
        assert!(output.prepare().unwrap());
        let retained = output.0.borrow().selected.as_ref().unwrap().0.clone();
        let driver = output.0.borrow().driver.clone();
        let complete = Arc::new(AtomicBool::new(false));
        let completed = complete.clone();
        assert!(
            catch_unwind(AssertUnwindSafe(|| {
                let _ = program.runtime_mut().present_with_overlay(|_| {
                    assert_eq!(driver.borrow().pending_submissions(), 1);
                    gpu.queue.on_submitted_work_done({
                        let completed = completed.clone();
                        move || {
                            completed.store(true, Ordering::SeqCst);
                        }
                    });
                    panic!("host overlay failed after GPU submit");
                });
            }))
            .is_err()
        );
        // The coordinator dropped only RegisteredRenderer; these two Rc owners
        // and the completed texture lease are still alive.
        assert!(complete.load(Ordering::SeqCst));
        assert!(driver.borrow().is_shutdown());
        assert_eq!(driver.borrow().pending_submissions(), 0);
        assert_eq!(driver.borrow().resident_images(), 0);
        assert_eq!(driver.borrow().resident_fonts(), 0);
        assert!(program.present().is_err());
        assert!(output.prepare().is_err());
        drop(program);
        assert_eq!(
            retained.read_rgba(&gpu).unwrap(),
            [255, 0, 0, 255].repeat(16)
        );
    }
    #[test]
    fn registration_has_one_owner_and_host_filters_can_drop_it() {
        let gpu = Gpu::new_headless().unwrap();
        let output = ProgramOutput::new(&gpu, (4, 4), 1.).unwrap();
        let mut owner = program();
        output.register(&mut owner).unwrap();
        assert!(output.clone().register(&mut program()).is_err());
        assert!(!output.0.borrow().driver.borrow().is_shutdown());
        let target = output.first().unwrap();
        output.set_surface(5, &target, (4, 4));
        let mut owner = Some(owner);
        output.retain_surfaces(|_| {
            drop(owner.take());
            false
        });
        assert!(owner.is_none());
        assert!(output.0.borrow().driver.borrow().is_shutdown());
    }
}
