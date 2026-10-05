//! The device, and where a frame goes.

use wgpu::{Device, Queue, Surface, Texture, TextureFormat, TextureView};

/// The depth buffer of every screen: 24 bits or more.
pub const DEPTH: TextureFormat = TextureFormat::Depth24Plus;

#[derive(Clone)]
pub struct Gpu {
    pub device: Device,
    pub queue: Queue,
    /// What the adapter calls itself, for a status.
    pub adapter: String,
}

/// A canvas the frames are presented on.
pub struct Canvas {
    surface: Surface<'static>,
    format: TextureFormat,
}

async fn open(instance: &wgpu::Instance, surface: Option<&Surface<'static>>) -> Result<(wgpu::Adapter, Gpu), String> {
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, compatible_surface: surface, force_fallback_adapter: false })
        .await
        .map_err(|e| format!("no GPU adapter: {e}"))?;
    let info = adapter.get_info();
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("pocket3d"),
            required_features: wgpu::Features::empty(),
            // What every WebGPU device has: a game that fits these runs wherever WebGPU does.
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
        })
        .await
        .map_err(|e| format!("no GPU device: {e}"))?;
    let adapter_name = format!("{} ({:?})", info.name, info.backend);
    Ok((adapter, Gpu { device, queue, adapter: adapter_name }))
}

impl Gpu {
    /// A device with no screen: frames go to textures and are read back.
    pub async fn headless() -> Result<Gpu, String> {
        let instance = wgpu::Instance::default();
        Ok(open(&instance, None).await?.1)
    }

    /// A device for a canvas of a page.
    #[cfg(target_arch = "wasm32")]
    pub async fn for_canvas(canvas: web_sys::HtmlCanvasElement) -> Result<(Gpu, Canvas), String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor { backends: wgpu::Backends::BROWSER_WEBGPU, ..Default::default() });
        let surface = instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas)).map_err(|e| format!("the canvas takes no WebGPU context: {e}"))?;
        let (adapter, gpu) = open(&instance, Some(&surface)).await?;
        // Colours are written as the pack holds them, in the display's own encoding: a format that does not
        // convert on the way out.
        let formats = surface.get_capabilities(&adapter).formats;
        let format = formats.iter().copied().find(|f| !f.is_srgb()).or(formats.first().copied()).ok_or("the canvas offers no format")?;
        Ok((gpu, Canvas { surface, format }))
    }
}

enum Output {
    Canvas(Canvas),
    /// A texture a frame is resolved into, to be read back.
    Texture(Texture),
}

/// Where frames go: `width` by `height` pixels with `samples` samples each and a depth buffer.
pub struct Screen {
    output: Output,
    pub format: TextureFormat,
    pub width: u32,
    pub height: u32,
    pub samples: u32,
    /// The target with several samples a pixel, when `samples` is more than one.
    several: Option<TextureView>,
    depth: TextureView,
}

/// One frame's views: draw into `colour` (resolved into `resolve` when there is one) and `depth`.
pub struct Frame {
    pub colour: TextureView,
    pub resolve: Option<TextureView>,
    pub depth: TextureView,
    presented: Option<wgpu::SurfaceTexture>,
}

impl Frame {
    /// The picture the display is handed: one sample a pixel, the samples resolved into it when the pass has
    /// ended. A pass after the scene's draws into it.
    pub fn shown(&self) -> &TextureView {
        self.resolve.as_ref().unwrap_or(&self.colour)
    }

    /// The frame's one pass over the whole screen, cleared to `clear`.
    pub fn pass<'a>(&'a self, encoder: &'a mut wgpu::CommandEncoder, clear: [f32; 3]) -> wgpu::RenderPass<'a> {
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("scene"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.colour,
                resolve_target: self.resolve.as_ref(),
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color { r: clear[0] as f64, g: clear[1] as f64, b: clear[2] as f64, a: 1.0 }),
                    // (the samples are kept only as far as the resolve)
                    store: if self.resolve.is_some() { wgpu::StoreOp::Discard } else { wgpu::StoreOp::Store },
                },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &self.depth,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
        })
    }

    /// Hands the frame to the display (a frame of a texture stays where it is).
    pub fn present(self) {
        if let Some(texture) = self.presented {
            texture.present();
        }
    }
}

fn attachment(gpu: &Gpu, label: &str, format: TextureFormat, width: u32, height: u32, samples: u32, also: wgpu::TextureUsages) -> Texture {
    gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: samples,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | also,
        view_formats: &[],
    })
}

impl Screen {
    /// The target of several samples a pixel, when there are several, and the depth buffer.
    fn attachments(gpu: &Gpu, format: TextureFormat, width: u32, height: u32, samples: u32) -> (Option<TextureView>, TextureView) {
        let view = |t: Texture| t.create_view(&wgpu::TextureViewDescriptor::default());
        ((samples > 1).then(|| view(attachment(gpu, "samples", format, width, height, samples, wgpu::TextureUsages::empty()))), view(attachment(gpu, "depth", DEPTH, width, height, samples, wgpu::TextureUsages::empty())))
    }

    fn with(gpu: &Gpu, output: Output, format: TextureFormat, width: u32, height: u32, samples: u32) -> Screen {
        let (several, depth) = Self::attachments(gpu, format, width, height, samples);
        Screen { output, format, width, height, samples, several, depth }
    }

    fn configure(gpu: &Gpu, canvas: &Canvas, width: u32, height: u32) {
        canvas.surface.configure(
            &gpu.device,
            &wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format: canvas.format,
                width,
                height,
                present_mode: wgpu::PresentMode::Fifo,
                desired_maximum_frame_latency: 2,
                alpha_mode: wgpu::CompositeAlphaMode::Opaque,
                view_formats: vec![],
            },
        );
    }

    /// A canvas's frames. The canvas element has this many pixels already.
    pub fn canvas(gpu: &Gpu, canvas: Canvas, width: u32, height: u32, samples: u32) -> Screen {
        Self::configure(gpu, &canvas, width, height);
        let format = canvas.format;
        Self::with(gpu, Output::Canvas(canvas), format, width, height, samples)
    }

    /// Frames of a texture, to be read back with [`Screen::read`].
    pub fn texture(gpu: &Gpu, width: u32, height: u32, samples: u32) -> Screen {
        let format = TextureFormat::Rgba8Unorm;
        let texture = attachment(gpu, "frame", format, width, height, 1, wgpu::TextureUsages::COPY_SRC);
        Self::with(gpu, Output::Texture(texture), format, width, height, samples)
    }

    /// Another size, or another number of samples, from the next frame on. A canvas element has the new size
    /// already.
    pub fn resize(&mut self, gpu: &Gpu, width: u32, height: u32, samples: u32) {
        match &mut self.output {
            Output::Canvas(canvas) => Self::configure(gpu, canvas, width, height),
            Output::Texture(texture) => *texture = attachment(gpu, "frame", self.format, width, height, 1, wgpu::TextureUsages::COPY_SRC),
        }
        (self.several, self.depth) = Self::attachments(gpu, self.format, width, height, samples);
        (self.width, self.height, self.samples) = (width, height, samples);
    }

    /// The next frame's views. `Err`: the canvas has none to give this time (it was resized, or the tab lost
    /// its device); the caller skips the frame.
    pub fn frame(&self, gpu: &Gpu) -> Result<Frame, String> {
        let (target, presented) = match &self.output {
            Output::Canvas(canvas) => {
                let texture = match canvas.surface.get_current_texture() {
                    Ok(texture) => texture,
                    Err(e) => {
                        Self::configure(gpu, canvas, self.width, self.height);
                        return Err(format!("{e}"));
                    }
                };
                (texture.texture.create_view(&wgpu::TextureViewDescriptor::default()), Some(texture))
            }
            Output::Texture(texture) => (texture.create_view(&wgpu::TextureViewDescriptor::default()), None),
        };
        let (colour, resolve) = match &self.several {
            Some(several) => (several.clone(), Some(target)),
            None => (target, None),
        };
        Ok(Frame { colour, resolve, depth: self.depth.clone(), presented })
    }

    /// The last frame of a texture screen as rows of RGBA, the top row first.
    pub async fn read(&self, gpu: &Gpu) -> Result<Vec<u8>, String> {
        let Output::Texture(texture) = &self.output else { return Err("a canvas is not read back".into()) };
        // A row of the copy starts on a multiple of 256 bytes.
        let row = (self.width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: (row * self.height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("readback") });
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: None } },
            wgpu::Extent3d { width: self.width, height: self.height, depth_or_array_layers: 1 },
        );
        gpu.queue.submit([encoder.finish()]);
        let (sender, receiver) = std::sync::mpsc::channel();
        buffer.slice(..).map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        gpu.device.poll(wgpu::PollType::Wait).map_err(|e| format!("{e}"))?;
        receiver.recv().map_err(|e| format!("{e}"))?.map_err(|e| format!("{e}"))?;
        let mapped = buffer.slice(..).get_mapped_range();
        let mut pixels = Vec::with_capacity((self.width * self.height * 4) as usize);
        for y in 0..self.height as usize {
            let at = y * row as usize;
            pixels.extend_from_slice(&mapped[at..at + self.width as usize * 4]);
        }
        Ok(pixels)
    }
}
