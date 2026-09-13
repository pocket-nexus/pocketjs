//! GPU resources stay outside the guest ABI. The runtime worker records and
//! submits rendering; the window thread presents a retained GPU image.
use super::*;
use pocket_ui_wgpu::{Blit, UiRenderer};
use pocket3d::gpu::Gpu;
use std::sync::{Arc, Weak};

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const FRAME_TARGETS: usize = 3;

pub struct Target {
    pub _texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub size: (u32, u32),
}
impl Target {
    fn new(gpu: &Gpu, size: (u32, u32)) -> Result<Self> {
        let limit = gpu.device.limits().max_texture_dimension_2d;
        anyhow::ensure!(
            size.0 > 0 && size.1 > 0 && size.0 <= limit && size.1 <= limit,
            "GPU target exceeds device limits: {size:?}"
        );
        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Pocket retained render target"),
            size: wgpu::Extent3d {
                width: size.0,
                height: size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        Ok(Self {
            _texture: texture,
            view,
            size,
        })
    }
}
struct Child {
    generation: u64,
    target: Target,
    renderer: UiRenderer,
    hash: Option<u64>,
}
pub struct Renderer {
    gpu: Arc<Gpu>,
    shell: UiRenderer,
    children: HashMap<u32, Child>,
    frames: Vec<Arc<Target>>,
}
impl Renderer {
    pub fn new(gpu: Arc<Gpu>) -> Self {
        Self {
            shell: UiRenderer::new(&gpu, FORMAT),
            gpu,
            children: HashMap::new(),
            frames: Vec::new(),
        }
    }
    fn acquire_target(&mut self, size: (u32, u32)) -> Result<Option<Arc<Target>>> {
        if self.frames.first().is_some_and(|frame| frame.size != size) {
            self.frames.clear();
        }
        let index = if let Some(i) = self
            .frames
            .iter()
            .position(|frame| Arc::strong_count(frame) == 1)
        {
            i
        } else if self.frames.len() < FRAME_TARGETS {
            self.frames.push(Arc::new(Target::new(&self.gpu, size)?));
            self.frames.len() - 1
        } else {
            return Ok(None); // bounded backpressure; the next tick supplies the latest state
        };
        Ok(Some(self.frames[index].clone()))
    }
    /// A target remains leased until presentation has submitted its sampling
    /// commands. Shared queue ordering then makes reuse safe without readback
    /// or waiting for GPU completion on either CPU thread.
    pub fn render(&mut self, runtime: &mut Runtime) -> Result<Option<Arc<Target>>> {
        let density = runtime.args.density;
        let size = (runtime.viewport.0 * density, runtime.viewport.1 * density);
        let Some(frame) = self.acquire_target(size)? else {
            return Ok(None);
        };
        let active: HashSet<u32> = runtime
            .supervisor
            .instances
            .iter()
            .filter(|child| child.state != AppInstanceState::Failed)
            .map(|child| child.surface_handle)
            .collect();
        self.children.retain(|handle, _| active.contains(handle));
        self.shell
            .retain_surfaces(|handle| active.contains(&handle));
        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Pocket runtime frame"),
            });
        for instance in &runtime.supervisor.instances {
            if !instance.visible || instance.state == AppInstanceState::Failed {
                continue;
            }
            let logical = instance.package.plan.viewport.logical;
            let child_size = (logical[0] * density, logical[1] * density);
            if !self
                .children
                .get(&instance.surface_handle)
                .is_some_and(|child| {
                    child.target.size == child_size && child.generation == instance.generation
                })
            {
                let target = Target::new(&self.gpu, child_size)?;
                self.shell.set_surface(
                    &self.gpu,
                    instance.surface_handle,
                    &target.view,
                    (logical[0], logical[1]),
                );
                self.children.insert(
                    instance.surface_handle,
                    Child {
                        generation: instance.generation,
                        target,
                        renderer: UiRenderer::new(&self.gpu, FORMAT),
                        hash: None,
                    },
                );
            }
            let child = self.children.get_mut(&instance.surface_handle).unwrap();
            instance.surface.with_ui(|ui| -> Result<()> {
                let words = ui.draw().words.clone();
                let hash = fnv1a64(&words) ^ ui.raster_revision().rotate_left(7);
                if child.hash != Some(hash) {
                    child.renderer.render_words_scaled(
                        &self.gpu,
                        ui,
                        &words,
                        &mut encoder,
                        &child.target.view,
                        child_size,
                        density as f32,
                        wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    )?;
                    child.hash = Some(hash);
                }
                Ok(())
            })?;
        }
        runtime.surface.with_ui(|ui| -> Result<()> {
            let words = ui.draw().words.clone();
            self.shell.render_words_scaled(
                &self.gpu,
                ui,
                &words,
                &mut encoder,
                &frame.view,
                size,
                density as f32,
                wgpu::LoadOp::Clear(wgpu::Color::BLACK),
            )
        })?;
        self.gpu.queue.submit([encoder.finish()]);
        Ok(Some(frame))
    }
}

pub struct Presentation {
    pub gpu: Arc<Gpu>,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    blits: Vec<(Weak<Target>, Blit)>,
}
impl Presentation {
    pub fn new(window: Arc<Window>) -> Result<Self> {
        let instance = Gpu::new_instance();
        let surface = instance.create_surface(window.clone())?;
        let gpu = Arc::new(Gpu::from_instance_for_surface_with_power_preference(
            instance,
            &surface,
            wgpu::PowerPreference::LowPower,
        )?);
        let caps = surface.get_capabilities(&gpu.adapter);
        // Encoded byte-space color matches package colors and the portable
        // rasterizer. Avoid an additional sRGB conversion on final presentation.
        let format = [
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureFormat::Rgba8Unorm,
        ]
        .into_iter()
        .find(|format| caps.formats.contains(format))
        .ok_or_else(|| anyhow!("GPU surface has no portable 8-bit color format"))?;
        let size = window.inner_size();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 1,
            alpha_mode: wgpu::CompositeAlphaMode::Auto,
            view_formats: vec![],
        };
        surface.configure(&gpu.device, &config);
        let info = gpu.adapter.get_info();
        log::info!(
            "Pocket UI GPU: {:?} / {} / {:?}",
            info.backend,
            info.name,
            format
        );
        Ok(Self {
            gpu,
            surface,
            config,
            blits: Vec::new(),
        })
    }
    pub fn present(&mut self, window: &Window, target: &Arc<Target>) -> Result<bool> {
        let size = window.inner_size();
        if size.width == 0 || size.height == 0 {
            return Ok(false);
        }
        if (self.config.width, self.config.height) != (size.width, size.height) {
            self.config.width = size.width;
            self.config.height = size.height;
            self.surface.configure(&self.gpu.device, &self.config);
        }
        let output = match self.surface.get_current_texture() {
            Ok(output) => output,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                self.surface.configure(&self.gpu.device, &self.config);
                window.request_redraw();
                return Ok(false);
            }
            Err(wgpu::SurfaceError::Timeout) => {
                window.request_redraw();
                return Ok(false);
            }
            Err(error) => return Err(error.into()),
        };
        // Weak identities retain bind groups without leasing a frame from the
        // worker's bounded pool. Rebuild only when the pool changes on resize.
        self.blits.retain(|(frame, _)| frame.strong_count() > 0);
        let key = Arc::downgrade(target);
        let index = match self
            .blits
            .iter()
            .position(|(frame, _)| Weak::ptr_eq(frame, &key))
        {
            Some(index) => index,
            None => {
                let blit = Blit::new(
                    &self.gpu,
                    &target.view,
                    self.config.format,
                    wgpu::FilterMode::Nearest,
                    false,
                );
                self.blits.push((key, blit));
                self.blits.len() - 1
            }
        };
        let view = output.texture.create_view(&Default::default());
        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Pocket present"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Pocket present"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            self.blits[index].1.draw(&mut pass);
        }
        self.gpu.queue.submit([encoder.finish()]);
        window.pre_present_notify();
        output.present();
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires a GPU; run with --ignored on GPU acceptance hosts"]
    fn retained_targets_bound_leases_and_survive_resize() {
        let gpu = Arc::new(Gpu::new_headless().unwrap());
        let mut renderer = Renderer::new(gpu);
        let first = renderer.acquire_target((32, 32)).unwrap().unwrap();
        let second = renderer.acquire_target((32, 32)).unwrap().unwrap();
        let third = renderer.acquire_target((32, 32)).unwrap().unwrap();
        assert!(renderer.acquire_target((32, 32)).unwrap().is_none());
        let identity = Arc::downgrade(&first);
        drop(first);
        let reused = renderer.acquire_target((32, 32)).unwrap().unwrap();
        assert!(Weak::ptr_eq(&identity, &Arc::downgrade(&reused)));
        let resized = renderer.acquire_target((64, 48)).unwrap().unwrap();
        assert_eq!(resized.size, (64, 48));
        assert_eq!(second.size, (32, 32));
        assert_eq!(third.size, (32, 32));
        assert_eq!(renderer.frames.len(), 1);
        assert!(renderer.acquire_target((0, 0)).is_err());
    }
}
