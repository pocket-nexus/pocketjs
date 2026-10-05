//! A picture laid over a frame: a game's interface, drawn by something that
//! is not the game's renderer (PocketJS's UI core, which rasterizes on the
//! processor), over the scene the renderer has drawn.
//!
//! The picture is premultiplied colour with its own alpha, one texel to a
//! pixel of the screen, and goes over the frame in a pass of its own after
//! the scene's samples are resolved: colour × (1 − its alpha) + its colour.
//! PocketJS's UI core rasterizes such a picture in one drawing
//! (`ui_render_premultiplied_scaled`, `renderPremultiplied` of
//! `hosts/web/app-instance.js`): alpha is 0 where the interface draws nothing.

use crate::gpu::{Frame, Gpu};
use wgpu::TextureFormat;

const PROGRAM: &str = "
@group(0) @binding(0) var picture: texture_2d<f32>;
@group(0) @binding(1) var texels: sampler;

struct Out {
  @builtin(position) position: vec4<f32>,
  @location(0) at: vec2<f32>,
}

// One triangle over the whole screen; the picture's first row is the screen's top.
@vertex
fn corner(@builtin(vertex_index) index: u32) -> Out {
  var out: Out;
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  out.position = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  out.at = vec2<f32>(p.x, 1.0 - p.y);
  return out;
}

@fragment
fn over(in: Out) -> @location(0) vec4<f32> {
  return textureSample(picture, texels, in.at);
}
";

pub struct Overlay {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    format: TextureFormat,
    /// The picture, its bind group and its size, once one has been written.
    held: Option<(wgpu::Texture, wgpu::BindGroup, u32, u32)>,
    shown: bool,
}

impl Overlay {
    /// For frames of a screen of this format.
    pub fn new(gpu: &Gpu, format: TextureFormat) -> Overlay {
        let device = &gpu.device;
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("overlay"), source: wgpu::ShaderSource::Wgsl(PROGRAM.into()) });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("overlay"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("overlay"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("overlay"), bind_group_layouts: &[&layout], push_constant_ranges: &[] })),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("corner"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("over"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING), write_mask: wgpu::ColorWrites::COLOR })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });
        // (a texel to a pixel: nothing is mixed)
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor { label: Some("overlay"), ..Default::default() });
        Overlay { pipeline, layout, sampler, format, held: None, shown: false }
    }

    pub fn format(&self) -> TextureFormat {
        self.format
    }

    /// A picture of `width` by `height` texels of premultiplied RGBA, the top row first. It is laid over
    /// every frame from the next on.
    pub fn write(&mut self, gpu: &Gpu, pixels: &[u8], width: u32, height: u32) -> Result<(), String> {
        if pixels.len() != (width * height * 4) as usize || width == 0 || height == 0 {
            return Err(format!("a picture of {} bytes is not {width} by {height} texels", pixels.len()));
        }
        if self.held.as_ref().map(|h| (h.2, h.3)) != Some((width, height)) {
            let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("overlay"),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("overlay"),
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&texture.create_view(&wgpu::TextureViewDescriptor::default())) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                ],
            });
            self.held = Some((texture, group, width, height));
        }
        let Some((texture, ..)) = &self.held else { return Ok(()) };
        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            pixels,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * 4), rows_per_image: Some(height) },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        self.shown = true;
        Ok(())
    }

    /// Nothing is laid over the frames until a picture is written again.
    pub fn hide(&mut self) {
        self.shown = false;
    }

    /// Lays the picture over a frame the scene has been drawn into. Its texels meet the screen's pixels one to
    /// one when the picture has the screen's size; another size is stretched over it.
    pub fn draw(&self, encoder: &mut wgpu::CommandEncoder, frame: &Frame) {
        let Some((_, group, ..)) = self.held.as_ref().filter(|_| self.shown) else { return };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("overlay"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: frame.shown(), resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, group, &[]);
        pass.draw(0..3, 0..1);
    }
}
