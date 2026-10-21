//! GPU resources stay outside the guest ABI. The runtime worker records and
//! submits rendering; the window thread presents a retained GPU image.
use super::*;
use pocket_ui_wgpu::Blit;
pub use pocket_ui_wgpu::{ProgramOutput as RuntimeOutput, ProgramTarget as Target};
use pocket3d::gpu::Gpu;
use std::sync::{Arc, Weak};

pub struct Renderer;
impl Renderer {
    pub fn new(_: Arc<Gpu>) -> Self {
        Self
    }
    pub fn render(&mut self, runtime: &mut Runtime) -> Result<Option<Arc<Target>>> {
        if !runtime.output.prepare()? {
            return Ok(None);
        }
        let active: HashSet<u32> = runtime
            .supervisor
            .instances
            .iter()
            .filter(|child| child.state != AppInstanceState::Failed)
            .map(|child| child.surface_handle)
            .collect();
        runtime.output.retain_surfaces(|id| active.contains(&id));
        for instance in &mut runtime.supervisor.instances {
            if !instance.visible || instance.state == AppInstanceState::Failed {
                continue;
            }
            let hash = instance
                .surface
                .with_ui(|ui| fnv1a64(&ui.draw().words) ^ ui.raster_revision().rotate_left(7));
            if instance.render_hash != Some(hash) && instance.output.prepare()? {
                instance.program.present()?;
                instance.render_hash = Some(hash);
            }
            if let Some(target) = instance.output.last() {
                let [w, h] = instance.package.plan.viewport.logical;
                runtime
                    .output
                    .set_surface(instance.surface_handle, &target, (w, h));
            }
        }
        runtime.program.present()?;
        Ok(runtime.output.last())
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
    fn read(gpu: &Gpu, target: &Target) -> Vec<u8> {
        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: target.size.1 as u64 * 256,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            target.texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: Some(target.size.1),
                },
            },
            target.texture.size(),
        );
        let index = gpu.queue.submit([encoder.finish()]);
        let (send, receive) = std::sync::mpsc::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                send.send(result).unwrap()
            });
        gpu.device
            .poll(wgpu::PollType::WaitForSubmissionIndex(index))
            .unwrap();
        receive.recv().unwrap().unwrap();
        let mapped = buffer.slice(..).get_mapped_range();
        let bytes = (0..target.size.1 as usize)
            .flat_map(|row| mapped[row * 256..row * 256 + target.size.0 as usize * 4].to_vec())
            .collect();
        drop(mapped);
        buffer.unmap();
        bytes
    }
    #[test]
    #[ignore = "requires a GPU; run with --ignored on GPU acceptance hosts"]
    fn canonical_program_presents_through_registered_wgpu_and_preserves_leased_frames() {
        let gpu = Arc::new(Gpu::new_headless().unwrap());
        let output = RuntimeOutput::new(&gpu, (4, 4), 1.).unwrap();
        let mut program = UiProgram::new(ProgramConfig {
            host: "native-test",
            host_abi: 1,
            logical: [4, 4],
            density: 1,
            scale: 1,
            tick_hz: 60,
            heap_limit: 4 * 1024 * 1024,
            frame_buffer_budget: 1024,
        })
        .unwrap();
        output.register(&mut program).unwrap();
        let source = format!(
            "const n=ui.createNode(0);ui.insertBefore(1,n,0);ui.setProp(n,{},4);ui.setProp(n,{},4);ui.setProp(n,{},{});globalThis.frame=()=>ui.setProp(n,{},{});",
            pocketjs_core::spec::prop::WIDTH,
            pocketjs_core::spec::prop::HEIGHT,
            pocketjs_core::spec::prop::BG_COLOR,
            0xff2814f0u32,
            pocketjs_core::spec::prop::BG_COLOR,
            0xff00ff00u32
        );
        program
            .boot(Rc::new(Guest::new().unwrap()), "gpu", &source, &[])
            .unwrap();
        output.prepare().unwrap();
        program.present().unwrap();
        let first = output.last().unwrap();
        assert_eq!(read(&gpu, &first), [240, 20, 40, 255].repeat(16));
        program.advance().unwrap();
        output.prepare().unwrap();
        program.present().unwrap();
        let second = output.last().unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
        assert_eq!(read(&gpu, &second), [0, 255, 0, 255].repeat(16));
        assert_eq!(read(&gpu, &first), [240, 20, 40, 255].repeat(16));
        assert_eq!(output.pending_submissions(), 0);
        output.set_size((8, 4)).unwrap();
        program.resize([8, 4], [8, 4]).unwrap();
        output.prepare().unwrap();
        program.present().unwrap();
        assert_eq!(output.last().unwrap().size, (8, 4));
        assert_eq!(read(&gpu, &second), [0, 255, 0, 255].repeat(16));
    }
}
