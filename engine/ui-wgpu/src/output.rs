//! Registered wgpu display targets shared by native program compositions.
use anyhow::{Result, anyhow};
use pocket_drivers::target::{RendererCell, TargetSlot};
use pocket_drivers::*;
use pocket_wgpu_render::{TargetConfig, WgpuRenderer};
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
///
/// The output creates the renderer and owns its textures. Under the device
/// target contract (`pocket_drivers::target`) the display reaches the
/// renderer only through a `TargetSlot`: `prepare` registers the selected
/// texture, replacing the previous frame's registration. An unregistered
/// target detaches from a pending submission, which keeps its own view.
#[derive(Clone)]
pub struct ProgramOutput {
    renderer: RendererCell<WgpuRenderer>,
    state: Rc<RefCell<OutputState>>,
}
/// State shared by the host handle and the registered display.
struct OutputState {
    device: wgpu::Device,
    format: wgpu::TextureFormat,
    pixel_format: PixelFormat,
    clear: wgpu::Color,
    fixed: bool,
    /// Display-owned textures, at most `FRAME_TARGETS`. A texture whose only
    /// owner is this list holds no host lease and can take the next frame.
    textures: Vec<Arc<ProgramTarget>>,
    size: (u32, u32),
    scale: f32,
    selected: Option<Arc<ProgramTarget>>,
    /// The renderer registration of `selected`.
    target: TargetSlot<WgpuRenderer>,
    last: Option<Arc<ProgramTarget>>,
    pending: Option<u64>,
    next_token: u64,
    registered: bool,
}
impl OutputState {
    fn config(&self, target: &ProgramTarget) -> TargetConfig {
        TargetConfig::new(
            &target.view,
            self.size,
            self.scale,
            wgpu::LoadOp::Clear(self.clear),
        )
    }
    /// Drop every texture and the current registration.
    fn reset_textures(&mut self) {
        self.textures.clear();
        // An unregistered target detaches from pending work; release cannot
        // be refused.
        let _ = self.target.release();
        self.last = None;
    }
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
        let pixel_format = driver.descriptor().formats()[0];
        let renderer = RendererCell::new(driver);
        // Validate size before runtime admission, even before the first acquire.
        let texture = Arc::new(new_target(&gpu.device, size, format)?);
        let mut target = TargetSlot::new(renderer.port());
        target
            .replace(TargetConfig::new(
                &texture.view,
                size,
                scale,
                wgpu::LoadOp::Clear(clear),
            ))
            .map_err(|error| anyhow!("wgpu target: {error:?}"))?;
        Ok(Self {
            renderer,
            state: Rc::new(RefCell::new(OutputState {
                device: gpu.device.clone(),
                format,
                pixel_format,
                clear,
                fixed,
                textures: vec![texture],
                size,
                scale,
                selected: None,
                target,
                last: None,
                pending: None,
                next_token: 0,
                registered: false,
            })),
        })
    }
    pub fn register(&self, program: &mut pocket_ui_surface::UiProgram) -> Result<()> {
        {
            let mut state = self.state.borrow_mut();
            anyhow::ensure!(!state.registered, "output already has a registration owner");
            state.registered = true;
        }
        let registration = self
            .renderer
            .registration()
            .map_err(|error| anyhow!("wgpu renderer: {error:?}"))?;
        let renderer = program.add_renderer(registration)?;
        program.add_display(RegisteredDisplay(self.state.clone()), renderer)
    }
    fn ensure_live(&self) -> Result<()> {
        anyhow::ensure!(
            !self
                .renderer
                .with(|renderer| renderer.is_shutdown())
                .unwrap_or(true),
            "renderer is shut down"
        );
        Ok(())
    }
    pub fn size(&self) -> (u32, u32) {
        self.state.borrow().size
    }
    pub fn set_size(&self, size: (u32, u32)) -> Result<()> {
        self.ensure_live()?;
        let mut state = self.state.borrow_mut();
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
        let mut state = self.state.borrow_mut();
        if state.scale != scale {
            state.reset_textures();
            state.selected = None;
            state.scale = scale;
        }
        Ok(())
    }
    pub fn first(&self) -> Option<Arc<ProgramTarget>> {
        self.state.borrow().textures.first().cloned()
    }
    pub fn pending_submissions(&self) -> usize {
        self.renderer
            .with(|renderer| renderer.pending_submissions())
            .unwrap_or(0)
    }
    pub fn prepare(&self) -> Result<bool> {
        self.ensure_live()?;
        let mut state = self.state.borrow_mut();
        anyhow::ensure!(state.pending.is_none(), "display transfer is still pending");
        state.selected = None;
        if state
            .textures
            .first()
            .is_some_and(|texture| texture.size != state.size)
        {
            state.reset_textures();
        }
        let texture = if state.fixed && !state.textures.is_empty() {
            state.textures[0].clone()
        } else if let Some(texture) = state
            .textures
            .iter()
            .find(|texture| Arc::strong_count(texture) == 1)
        {
            texture.clone()
        } else if state.textures.len() < FRAME_TARGETS {
            Arc::new(new_target(&state.device, state.size, state.format)?)
        } else {
            return Ok(false);
        };
        let config = state.config(&texture);
        state
            .target
            .replace(config)
            .map_err(|error| anyhow!("wgpu target: {error:?}"))?;
        if !state
            .textures
            .iter()
            .any(|owned| Arc::ptr_eq(owned, &texture))
        {
            state.textures.push(texture.clone());
        }
        state.selected = Some(texture);
        Ok(true)
    }
    pub fn last(&self) -> Option<Arc<ProgramTarget>> {
        self.state.borrow().last.clone()
    }
    pub fn set_surface(&self, handle: u32, target: &ProgramTarget, logical: (u32, u32)) {
        let _ = self
            .renderer
            .with(|renderer| renderer.set_surface(handle, &target.view, logical));
    }
    pub fn retain_surfaces(&self, mut keep: impl FnMut(u32) -> bool) {
        // A host filter may drop its UiProgram. Do not hold the renderer
        // while calling it: the registration's drop must stop the GPU.
        let handles: Vec<_> = self
            .renderer
            .with(|renderer| renderer.surface_handles().collect())
            .unwrap_or_default();
        let retained: std::collections::HashSet<_> =
            handles.into_iter().filter(|&id| keep(id)).collect();
        let _ = self
            .renderer
            .with(|renderer| renderer.retain_surfaces(|id| retained.contains(&id)));
    }
}
struct RegisteredDisplay(Rc<RefCell<OutputState>>);
impl DisplayOutput for RegisteredDisplay {
    type Token = u64;
    fn descriptor(&self) -> DisplayDescriptor {
        let state = self.0.borrow();
        DisplayDescriptor::new(
            DisplayRole::Primary,
            state.size.0,
            state.size.1,
            state.pixel_format,
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
        let state = self.0.borrow();
        if state.pending.is_some() || state.selected.is_none() {
            return Err(DisplayError::InvalidTarget);
        }
        let target = state
            .target
            .target()
            .map_err(|_| DisplayError::InvalidTarget)?;
        if target.region != region {
            return Err(DisplayError::InvalidTarget);
        }
        Ok(pocket_drivers::Target::DeviceOwned(target))
    }
    fn flush(&mut self, _: &[Rect]) -> std::result::Result<u64, DisplayError> {
        let mut state = self.0.borrow_mut();
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
        let mut state = self.0.borrow_mut();
        if state.pending != Some(token) {
            return Err(DisplayError::InvalidTarget);
        }
        // Renderer::wait is terminal before flush. The window receives a lease
        // only after GPU writes finish; its sampling submission precedes reuse.
        state.pending = None;
        state.last = state.selected.take();
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
        let mut display = RegisteredDisplay(output.state.clone());
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
        let (profile, profile_hash) = crate::embedded_profile("gpu-test", [4, 4], 1, 60);
        crate::UiProgram::new(crate::ProgramConfig {
            profile,
            profile_hash,
            tick_hz: 60,
            host_abi: pocket_spec::BINDING_GENERATION,
            logical: [4, 4],
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
        let retained = output.state.borrow().selected.clone().unwrap();
        let driver = output.renderer.clone();
        let complete = Arc::new(AtomicBool::new(false));
        let completed = complete.clone();
        assert!(
            catch_unwind(AssertUnwindSafe(|| {
                let _ = program.runtime_mut().present_with_overlay(|_| {
                    assert_eq!(driver.with(|d| d.pending_submissions()).unwrap(), 1);
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
        // The coordinator dropped only the renderer registration; these two
        // cell owners and the completed texture lease are still alive.
        assert!(complete.load(Ordering::SeqCst));
        assert!(driver.with(|d| d.is_shutdown()).unwrap());
        assert_eq!(driver.with(|d| d.pending_submissions()).unwrap(), 0);
        assert_eq!(driver.with(|d| d.resident_images()).unwrap(), 0);
        assert_eq!(driver.with(|d| d.resident_fonts()).unwrap(), 0);
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
        assert!(!output.renderer.with(|d| d.is_shutdown()).unwrap());
        let target = output.first().unwrap();
        output.set_surface(5, &target, (4, 4));
        let mut owner = Some(owner);
        output.retain_surfaces(|_| {
            drop(owner.take());
            false
        });
        assert!(owner.is_none());
        assert!(output.renderer.with(|d| d.is_shutdown()).unwrap());
    }
}
