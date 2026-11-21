//! Fullscreen-triangle blit: composite one texture onto another target.
//! Nearest for chunky integer upscales (the PSP look), linear for smooth
//! DPI scaling (HUD overlays on hidpi swapchains).

use pocket3d::gpu::Gpu;

const BLIT_WGSL: &str = r#"
struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
    var out: VsOut;
    let x = f32(i32(i % 2u) * 4 - 1);
    let y = f32(i32(i / 2u) * 4 - 1);
    out.pos = vec4f(x, y, 0.0, 1.0);
    out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
    return textureSample(tex, samp, in.uv);
}
"#;

pub struct Blit {
    pipeline: wgpu::RenderPipeline,
    bind: wgpu::BindGroup,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
}

impl Blit {
    /// A blit from `src` into targets of `format`. `blend` enables standard
    /// alpha blending (overlay compositing); disable it for opaque copies.
    pub fn new(
        gpu: &Gpu,
        src: &wgpu::TextureView,
        format: wgpu::TextureFormat,
        filter: wgpu::FilterMode,
        blend: bool,
    ) -> Blit {
        Self::with_blend(
            gpu,
            src,
            format,
            filter,
            blend.then_some(wgpu::BlendState::ALPHA_BLENDING),
        )
    }
    /// Composite a transparent render target whose RGB already includes alpha.
    pub fn new_premultiplied(
        gpu: &Gpu,
        src: &wgpu::TextureView,
        format: wgpu::TextureFormat,
        filter: wgpu::FilterMode,
    ) -> Blit {
        Self::with_blend(
            gpu,
            src,
            format,
            filter,
            Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
        )
    }
    fn with_blend(
        gpu: &Gpu,
        src: &wgpu::TextureView,
        format: wgpu::TextureFormat,
        filter: wgpu::FilterMode,
        blend: Option<wgpu::BlendState>,
    ) -> Blit {
        let shader = gpu
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("pocket-ui blit"),
                source: wgpu::ShaderSource::Wgsl(BLIT_WGSL.into()),
            });
        let layout = gpu
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("pocket-ui blit layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });
        let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("pocket-ui blit sampler"),
            mag_filter: filter,
            min_filter: filter,
            ..Default::default()
        });
        let bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pocket-ui blit bind"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(src),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        let pl = gpu
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("pocket-ui blit pl"),
                bind_group_layouts: &[&layout],
                push_constant_ranges: &[],
            });
        let pipeline = gpu
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("pocket-ui blit pipeline"),
                layout: Some(&pl),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            });
        Blit {
            pipeline,
            bind,
            layout,
            sampler,
        }
    }

    /// Replace the sampled frame without rebuilding the shader or pipeline.
    /// Encoders which already used the previous bind group retain its resources.
    pub fn set_source(&mut self, gpu: &Gpu, src: &wgpu::TextureView) {
        self.bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pocket-ui blit bind"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(src),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
    }

    /// Draw the blit inside an existing render pass (set the viewport first
    /// for letterboxed integer scaling).
    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>) {
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind, &[]);
        pass.draw(0..3, 0..1);
    }
}
