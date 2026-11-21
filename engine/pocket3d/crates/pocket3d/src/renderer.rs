//! Forward renderer. One `Renderer` owns all pipelines; each frame it draws
//! a `Scene` (3D) then a `Hud` (2D overlay) into any color view.

use anyhow::Result;
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};

use crate::camera::Camera;
use crate::geometry::{WorldBatchKind, WorldVertex};
use crate::gpu::{DEPTH_FORMAT, DepthTarget, Gpu};
use crate::hud::{ATLAS_H, ATLAS_W, Hud, HudVertex, build_font_atlas};
use crate::model::{MaterialAlphaMode, ModelAsset, ModelInstance, ModelVertex};
use crate::scene::Scene;
use crate::texture::{GpuTexture, Samplers, create_rgba_texture};

fn finite_or(value: f32, fallback: f32) -> f32 {
    if value.is_finite() { value } else { fallback }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct GlobalsRaw {
    view_proj: [[f32; 4]; 4],
    inverse_view_proj: [[f32; 4]; 4],
    cam_pos: [f32; 4],
    sky_zenith: [f32; 4],
    sky_horizon: [f32; 4],
    sky_sun_dir: [f32; 4],
    sky_sun_color: [f32; 4],
    model_sun_dir: [f32; 4],
    model_sun_color: [f32; 4],
    model_ambient: [f32; 4],
    /// x: band count, y: wrap, z: enabled.
    toon: [f32; 4],
    /// rgb: color, w: strength.
    rim_color: [f32; 4],
    /// x: exponent.
    rim_params: [f32; 4],
    /// rgb: color, w: enabled.
    fog_color: [f32; 4],
    /// x: start, y: end.
    fog_params: [f32; 4],
}

pub struct Renderer {
    pub color_format: wgpu::TextureFormat,
    pub samplers: Samplers,
    pub world_material_layout: wgpu::BindGroupLayout,
    pub model_material_layout: wgpu::BindGroupLayout,
    depth: Option<DepthTarget>,
    globals_buf: wgpu::Buffer,
    globals_bg: wgpu::BindGroup,
    world_opaque: wgpu::RenderPipeline,
    world_alphatest: wgpu::RenderPipeline,
    world_sky: wgpu::RenderPipeline,
    world_background_sky: wgpu::RenderPipeline,
    models: ModelPass,
    sprites: SpritePass,
    hud: HudPass,
}

impl Renderer {
    pub fn new(gpu: &Gpu, color_format: wgpu::TextureFormat) -> Result<Self> {
        let device = &gpu.device;
        let samplers = Samplers::new(gpu);

        let globals_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("globals"),
            size: std::mem::size_of::<GlobalsRaw>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let globals_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("globals bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let globals_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("globals bg"),
            layout: &globals_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: globals_buf.as_entire_binding(),
            }],
        });

        // --- world pipelines ---------------------------------------------
        let world_material_layout = crate::geometry::WorldModel::material_layout(gpu);
        let world_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("world.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/world.wgsl").into()),
        });
        let world_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("world layout"),
            bind_group_layouts: &[&globals_bgl, &world_material_layout],
            push_constant_ranges: &[],
        });
        let background_sky_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("world background sky layout"),
                bind_group_layouts: &[&globals_bgl],
                push_constant_ranges: &[],
            });
        let make_world_pipeline = |label: &str, fs_entry: &str| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&world_layout),
                vertex: wgpu::VertexState {
                    module: &world_shader,
                    entry_point: Some("vs_main"),
                    compilation_options: Default::default(),
                    buffers: &[WorldVertex::LAYOUT],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &world_shader,
                    entry_point: Some(fs_entry),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: color_format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: None,
                    ..Default::default()
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: DEPTH_FORMAT,
                    depth_write_enabled: true,
                    depth_compare: wgpu::CompareFunction::LessEqual,
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };
        let world_opaque = make_world_pipeline("world opaque", "fs_opaque");
        let world_alphatest = make_world_pipeline("world alphatest", "fs_alphatest");
        let world_sky = make_world_pipeline("world sky", "fs_sky");
        let world_background_sky = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("world background sky"),
            layout: Some(&background_sky_layout),
            vertex: wgpu::VertexState {
                module: &world_shader,
                entry_point: Some("vs_background_sky"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &world_shader,
                entry_point: Some("fs_background_sky"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: color_format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: false,
                depth_compare: wgpu::CompareFunction::LessEqual,
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let models = ModelPass::new(gpu, color_format, &globals_bgl);
        let model_material_layout = models.material_layout.clone();
        let sprites = SpritePass::new(gpu, color_format, &globals_bgl);

        Ok(Self {
            color_format,
            samplers,
            world_material_layout,
            model_material_layout,
            depth: None,
            globals_buf,
            globals_bg,
            world_opaque,
            world_alphatest,
            world_sky,
            world_background_sky,
            models,
            sprites,
            hud: HudPass::new(gpu, color_format),
        })
    }

    fn ensure_depth(&mut self, gpu: &Gpu, size: (u32, u32)) {
        if self.depth.as_ref().map(|d| d.size) != Some(size) {
            self.depth = Some(DepthTarget::new(gpu, size.0, size.1));
        }
    }

    pub fn render(
        &mut self,
        gpu: &Gpu,
        color_view: &wgpu::TextureView,
        size: (u32, u32),
        scene: &Scene,
        camera: &Camera,
        hud: &Hud,
    ) {
        self.ensure_depth(gpu, size);
        let aspect = size.0 as f32 / size.1 as f32;

        let view_proj = camera.view_proj(aspect);
        let toon = match scene.lighting.toon {
            Some(toon) => [
                toon.steps as f32,
                finite_or(toon.wrap, 0.0).clamp(0.0, 1.0),
                1.0,
                0.0,
            ],
            None => [0.0; 4],
        };
        let (rim_color, rim_params) = match scene.lighting.rim {
            Some(rim) => (
                rim.color
                    .extend(finite_or(rim.strength, 0.0).max(0.0))
                    .to_array(),
                [finite_or(rim.power, 1.0).max(0.0001), 0.0, 0.0, 0.0],
            ),
            None => ([0.0; 4], [1.0, 0.0, 0.0, 0.0]),
        };
        let (fog_color, fog_params) = match scene.lighting.fog {
            Some(fog)
                if fog.color.is_finite()
                    && fog.start.is_finite()
                    && fog.end.is_finite()
                    && fog.end > fog.start =>
            {
                (
                    fog.color.extend(1.0).to_array(),
                    [fog.start, fog.end, 0.0, 0.0],
                )
            }
            _ => ([0.0; 4], [0.0, 1.0, 0.0, 0.0]),
        };
        let globals = GlobalsRaw {
            view_proj: view_proj.to_cols_array_2d(),
            inverse_view_proj: view_proj.inverse().to_cols_array_2d(),
            cam_pos: camera.pos.extend(scene.time).to_array(),
            sky_zenith: scene.sky.zenith.extend(1.0).to_array(),
            sky_horizon: scene.sky.horizon.extend(1.0).to_array(),
            sky_sun_dir: scene.sky.sun_dir.extend(0.0).to_array(),
            sky_sun_color: scene.sky.sun_color.extend(1.0).to_array(),
            model_sun_dir: scene.lighting.sun_dir.extend(0.0).to_array(),
            model_sun_color: scene.lighting.sun_color.extend(1.0).to_array(),
            model_ambient: scene.lighting.ambient.extend(1.0).to_array(),
            toon,
            rim_color,
            rim_params,
            fog_color,
            fog_params,
        };
        gpu.queue
            .write_buffer(&self.globals_buf, 0, bytemuck::bytes_of(&globals));

        // Upload per-instance data (joint palettes etc.) before recording.
        let (model_draws, viewmodel_draw) = self.models.prepare(gpu, scene);
        let sprite_verts = self.sprites.prepare(gpu, scene, camera);

        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("frame"),
            });

        // --- 3D scene pass ------------------------------------------------
        {
            let h = scene.sky.horizon;
            let depth_view = &self.depth.as_ref().unwrap().view;
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("scene"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: color_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(if scene.transparent_clear {
                            wgpu::Color::TRANSPARENT
                        } else {
                            wgpu::Color {
                                r: h.x as f64,
                                g: h.y as f64,
                                b: h.z as f64,
                                a: 1.0,
                            }
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            pass.set_bind_group(0, &self.globals_bg, &[]);

            if scene.draw_sky {
                pass.set_pipeline(&self.world_background_sky);
                pass.draw(0..3, 0..1);
            }

            if let Some(world) = &scene.world {
                pass.set_vertex_buffer(0, world.vbuf.slice(..));
                pass.set_index_buffer(world.ibuf.slice(..), wgpu::IndexFormat::Uint32);
                for kind in [
                    WorldBatchKind::Opaque,
                    WorldBatchKind::AlphaTest,
                    WorldBatchKind::Sky,
                ] {
                    let pipeline = match kind {
                        WorldBatchKind::Opaque => &self.world_opaque,
                        WorldBatchKind::AlphaTest => &self.world_alphatest,
                        WorldBatchKind::Sky => &self.world_sky,
                    };
                    let mut bound = false;
                    for batch in world.batches.iter().filter(|b| b.kind == kind) {
                        if !bound {
                            pass.set_pipeline(pipeline);
                            bound = true;
                        }
                        pass.set_bind_group(1, &batch.bind_group, &[]);
                        pass.draw_indexed(
                            batch.first_index..batch.first_index + batch.index_count,
                            0,
                            0..1,
                        );
                    }
                }
            }

            self.models.draw(&mut pass, &model_draws);
            self.sprites.draw(&mut pass, sprite_verts);
        }

        // --- viewmodel pass (own depth range so the gun never clips) -------
        if let Some(vm) = &viewmodel_draw {
            let depth_view = &self.depth.as_ref().unwrap().view;
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("viewmodel"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: color_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_bind_group(0, &self.globals_bg, &[]);
            self.models.draw(&mut pass, std::slice::from_ref(vm));
        }

        // --- HUD overlay pass ----------------------------------------------
        if !hud.verts.is_empty() {
            self.hud.upload(gpu, hud, size);
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("hud"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: color_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            self.hud.draw(&mut pass, hud);
        }

        gpu.queue.submit([encoder.finish()]);
    }
}

// ---------------------------------------------------------------------------
// Model pass (skinned + static, dynamic-offset instance/joint buffers)
// ---------------------------------------------------------------------------

const INSTANCE_STRIDE: u64 = 256;
const JOINT_ALIGN: u64 = 256;
/// Fixed window each draw binds from the joints buffer: 512 mat4s (32 KB —
/// VRoid-style humanoid rigs carry ~270 joints across their skins).
const JOINT_WINDOW: u64 = 512 * 64;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct InstanceRaw {
    model: [[f32; 4]; 4],
    normal_model: [[f32; 4]; 4],
    tint: [f32; 4],
    params: [f32; 4],
}

/// CPU-side inverse-transpose for instance transforms. A singular transform
/// cannot define a true normal matrix, so retain the old linear transform as
/// a finite fallback for zero-scale hiding and transition animations.
fn model_normal_matrix(model: Mat4) -> Mat4 {
    let determinant = model.determinant();
    if determinant.is_finite() && determinant.abs() > 1e-8 {
        model.inverse().transpose()
    } else {
        Mat4::from_cols(model.x_axis, model.y_axis, model.z_axis, glam::Vec4::W)
    }
}

pub(crate) struct ModelDraw {
    instance_blend: bool,
    asset: std::sync::Arc<ModelAsset>,
    inst_offset: u32,
    joints_offset: u32,
    /// The instance's morph overlay buffer (wgpu buffers are ref-counted).
    morph: Option<wgpu::Buffer>,
}

struct ModelPass {
    opaque: wgpu::RenderPipeline,
    opaque_double_sided: wgpu::RenderPipeline,
    blend: wgpu::RenderPipeline,
    blend_double_sided: wgpu::RenderPipeline,
    material_layout: wgpu::BindGroupLayout,
    object_layout: wgpu::BindGroupLayout,
    object_bg: wgpu::BindGroup,
    instance_buf: wgpu::Buffer,
    joints_buf: wgpu::Buffer,
    instance_capacity: u64,
    joints_capacity: u64,
}

impl ModelPass {
    fn new(
        gpu: &Gpu,
        color_format: wgpu::TextureFormat,
        globals_bgl: &wgpu::BindGroupLayout,
    ) -> Self {
        let device = &gpu.device;
        let material_layout = ModelAsset::material_layout(gpu);
        let object_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("model object"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: true,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("model.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/model.wgsl").into()),
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("model layout"),
            bind_group_layouts: &[globals_bgl, &material_layout, &object_layout],
            push_constant_ranges: &[],
        });
        let make_pipeline = |label: &str,
                             blend: Option<wgpu::BlendState>,
                             depth_write_enabled: bool,
                             cull_mode: Option<wgpu::Face>| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    compilation_options: Default::default(),
                    buffers: &[ModelVertex::LAYOUT],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: color_format,
                        blend,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode,
                    ..Default::default()
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: DEPTH_FORMAT,
                    depth_write_enabled,
                    depth_compare: wgpu::CompareFunction::LessEqual,
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };
        let opaque = make_pipeline("model opaque", None, true, Some(wgpu::Face::Back));
        let opaque_double_sided = make_pipeline("model opaque double-sided", None, true, None);
        let blend = make_pipeline(
            "model blend",
            Some(wgpu::BlendState::ALPHA_BLENDING),
            false,
            Some(wgpu::Face::Back),
        );
        let blend_double_sided = make_pipeline(
            "model blend double-sided",
            Some(wgpu::BlendState::ALPHA_BLENDING),
            false,
            None,
        );

        let instance_capacity = 64 * INSTANCE_STRIDE;
        let joints_capacity = 256 * 1024;
        let instance_buf = Self::make_instance_buf(device, instance_capacity);
        let joints_buf = Self::make_joints_buf(device, joints_capacity);
        let object_bg = Self::make_object_bg(device, &object_layout, &instance_buf, &joints_buf);

        Self {
            opaque,
            opaque_double_sided,
            blend,
            blend_double_sided,
            material_layout,
            object_layout,
            object_bg,
            instance_buf,
            joints_buf,
            instance_capacity,
            joints_capacity,
        }
    }

    fn make_instance_buf(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("model instances"),
            size,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    fn make_joints_buf(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("model joints"),
            size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    fn make_object_bg(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        instances: &wgpu::Buffer,
        joints: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("model object bg"),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: instances,
                        offset: 0,
                        size: wgpu::BufferSize::new(INSTANCE_STRIDE),
                    }),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: joints,
                        offset: 0,
                        size: wgpu::BufferSize::new(JOINT_WINDOW),
                    }),
                },
            ],
        })
    }

    /// Compute palettes + instance data for everything in the scene and
    /// upload once. Returns draw entries (scene models, viewmodel).
    fn prepare(&mut self, gpu: &Gpu, scene: &Scene) -> (Vec<ModelDraw>, Option<ModelDraw>) {
        let all: Vec<&ModelInstance> = scene.models.iter().chain(scene.viewmodel.iter()).collect();
        if all.is_empty() {
            return (Vec::new(), None);
        }

        let mut inst_bytes = vec![0u8; all.len() * INSTANCE_STRIDE as usize];
        let mut joint_bytes: Vec<u8> = Vec::with_capacity(all.len() * 64 * 4);
        let mut draws = Vec::with_capacity(all.len());
        let mut palette: Vec<Mat4> = Vec::new();

        for (i, inst) in all.iter().enumerate() {
            let raw = InstanceRaw {
                model: inst.transform.to_cols_array_2d(),
                normal_model: model_normal_matrix(inst.transform).to_cols_array_2d(),
                tint: inst.tint,
                params: [inst.lit, inst.cutout, 0.0, 0.0],
            };
            let off = i * INSTANCE_STRIDE as usize;
            inst_bytes[off..off + std::mem::size_of::<InstanceRaw>()]
                .copy_from_slice(bytemuck::bytes_of(&raw));

            if let Some(morph) = &inst.morph {
                morph.upload_if_dirty(gpu, &inst.asset);
            }
            match &inst.pose {
                Some(globals) => inst.asset.palette_from_globals(globals, &mut palette),
                None => inst.asset.joint_palette(&inst.anim, &mut palette),
            }
            if palette.len() as u64 * 64 > JOINT_WINDOW {
                log::warn!(
                    "model has {} joints; truncating to {}",
                    palette.len(),
                    JOINT_WINDOW / 64
                );
                palette.truncate((JOINT_WINDOW / 64) as usize);
            }
            let joints_offset = joint_bytes.len() as u32;
            for m in &palette {
                joint_bytes.extend_from_slice(bytemuck::cast_slice(&m.to_cols_array()));
            }
            // Align the next palette.
            let pad = (JOINT_ALIGN as usize - joint_bytes.len() % JOINT_ALIGN as usize)
                % JOINT_ALIGN as usize;
            joint_bytes.extend(std::iter::repeat_n(0u8, pad));

            draws.push(ModelDraw {
                instance_blend: inst.tint[3] < 1.0,
                asset: inst.asset.clone(),
                inst_offset: off as u32,
                joints_offset,
                morph: inst.morph.as_ref().map(|m| m.buffer().clone()),
            });
        }

        // Every dynamic offset must leave a full JOINT_WINDOW in range.
        if let Some(last) = draws.last() {
            let need = last.joints_offset as usize + JOINT_WINDOW as usize;
            if joint_bytes.len() < need {
                joint_bytes.resize(need, 0);
            }
        }

        // Grow buffers if needed (recreates the bind group).
        let device = &gpu.device;
        let mut recreate = false;
        if inst_bytes.len() as u64 > self.instance_capacity {
            self.instance_capacity = (inst_bytes.len() as u64).next_power_of_two();
            self.instance_buf = Self::make_instance_buf(device, self.instance_capacity);
            recreate = true;
        }
        if joint_bytes.len() as u64 > self.joints_capacity {
            self.joints_capacity = (joint_bytes.len() as u64).next_power_of_two();
            self.joints_buf = Self::make_joints_buf(device, self.joints_capacity);
            recreate = true;
        }
        if recreate {
            self.object_bg = Self::make_object_bg(
                device,
                &self.object_layout,
                &self.instance_buf,
                &self.joints_buf,
            );
        }
        gpu.queue.write_buffer(&self.instance_buf, 0, &inst_bytes);
        if !joint_bytes.is_empty() {
            gpu.queue.write_buffer(&self.joints_buf, 0, &joint_bytes);
        }

        let viewmodel = scene.viewmodel.is_some().then(|| draws.pop()).flatten();
        (draws, viewmodel)
    }

    fn draw<'p>(&'p self, pass: &mut wgpu::RenderPass<'p>, draws: &'p [ModelDraw]) {
        if draws.is_empty() {
            return;
        }
        self.draw_phase(pass, draws, false);
        self.draw_phase(pass, draws, true);
    }

    /// Draw all opaque/masked primitives across all instances before any
    /// blended primitive. Blend primitives keep depth testing but never write
    /// depth; glTF authoring order is retained within each phase.
    fn draw_phase<'p>(
        &'p self,
        pass: &mut wgpu::RenderPass<'p>,
        draws: &'p [ModelDraw],
        blend_phase: bool,
    ) {
        for d in draws {
            pass.set_bind_group(2, &self.object_bg, &[d.inst_offset, d.joints_offset]);
            pass.set_vertex_buffer(0, d.asset.vbuf.slice(..));
            pass.set_index_buffer(d.asset.ibuf.slice(..), wgpu::IndexFormat::Uint32);
            let mut overlay_bound = false;
            for (pi, prim) in d.asset.primitives.iter().enumerate() {
                if (d.instance_blend || prim.alpha_mode == MaterialAlphaMode::Blend) != blend_phase
                {
                    continue;
                }
                let pipeline = match (blend_phase, prim.double_sided) {
                    (false, false) => &self.opaque,
                    (false, true) => &self.opaque_double_sided,
                    (true, false) => &self.blend,
                    (true, true) => &self.blend_double_sided,
                };
                pass.set_pipeline(pipeline);
                pass.set_bind_group(1, &prim.bind_group, &[]);
                // Morphing primitives read vertices from the instance's
                // overlay buffer; base_vertex redirects the shared indices.
                let morph = d
                    .morph
                    .as_ref()
                    .zip(d.asset.prim_morph.get(pi).copied().flatten());
                match morph {
                    Some((buf, (mi, pj))) => {
                        let mp = &d.asset.morph_meshes[mi].prims[pj];
                        if !overlay_bound {
                            pass.set_vertex_buffer(0, buf.slice(..));
                            overlay_bound = true;
                        }
                        pass.draw_indexed(
                            prim.first_index..prim.first_index + prim.index_count,
                            mp.overlay_offset as i32 - mp.vertex_base as i32,
                            0..1,
                        );
                    }
                    None => {
                        if overlay_bound {
                            pass.set_vertex_buffer(0, d.asset.vbuf.slice(..));
                            overlay_bound = false;
                        }
                        pass.draw_indexed(
                            prim.first_index..prim.first_index + prim.index_count,
                            0,
                            0..1,
                        );
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sprite pass (additive billboards + beams)
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct SpriteVertex {
    pos: [f32; 3],
    uv: [f32; 2],
    color: [f32; 4],
}

struct SpritePass {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    vbuf: wgpu::Buffer,
    vbuf_capacity: u64,
    #[allow(dead_code)]
    texture: GpuTexture,
}

impl SpritePass {
    fn new(
        gpu: &Gpu,
        color_format: wgpu::TextureFormat,
        globals_bgl: &wgpu::BindGroupLayout,
    ) -> Self {
        let device = &gpu.device;

        // Soft radial glow texture.
        let size = 64u32;
        let mut px = vec![0u8; (size * size * 4) as usize];
        for y in 0..size {
            for x in 0..size {
                let dx = (x as f32 + 0.5) / size as f32 * 2.0 - 1.0;
                let dy = (y as f32 + 0.5) / size as f32 * 2.0 - 1.0;
                let r = (dx * dx + dy * dy).sqrt().min(1.0);
                let a = ((1.0 - r).powf(2.0) * 255.0) as u8;
                let i = ((y * size + x) * 4) as usize;
                px[i..i + 4].copy_from_slice(&[255, 255, 255, a]);
            }
        }
        let texture = create_rgba_texture(gpu, "sprite glow", size, size, &px, false, true);

        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("sprite bgl"),
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
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("sprite sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("sprite bg"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&texture.view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("sprite.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/sprite.wgsl").into()),
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("sprite layout"),
            bind_group_layouts: &[globals_bgl, &bgl],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("sprite pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<SpriteVertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x2, 2 => Float32x4],
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: color_format,
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::SrcAlpha,
                            dst_factor: wgpu::BlendFactor::One,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::One,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: false,
                depth_compare: wgpu::CompareFunction::LessEqual,
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let vbuf_capacity = 64 * 1024;
        let vbuf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("sprite vbuf"),
            size: vbuf_capacity,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Self {
            pipeline,
            bind_group,
            vbuf,
            vbuf_capacity,
            texture,
        }
    }

    fn prepare(&mut self, gpu: &Gpu, scene: &Scene, camera: &Camera) -> u32 {
        let mut verts: Vec<SpriteVertex> = Vec::new();
        let fwd = camera.forward();
        let right = fwd.cross(Vec3::Y).normalize_or_zero();
        let up = right.cross(fwd);

        let mut quad = |corners: [Vec3; 4], color: [f32; 4]| {
            let uv = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
            let idx = [0, 1, 2, 0, 2, 3];
            for &i in &idx {
                verts.push(SpriteVertex {
                    pos: corners[i].to_array(),
                    uv: uv[i],
                    color,
                });
            }
        };

        for s in &scene.sprites {
            let h = s.size * 0.5;
            quad(
                [
                    s.pos - right * h + up * h,
                    s.pos + right * h + up * h,
                    s.pos + right * h - up * h,
                    s.pos - right * h - up * h,
                ],
                s.color,
            );
        }
        for b in &scene.beams {
            let mid = (b.a + b.b) * 0.5;
            let axis = b.b - b.a;
            let side = axis.cross(camera.pos - mid).normalize_or_zero() * (b.width * 0.5);
            quad([b.a - side, b.b - side, b.b + side, b.a + side], b.color);
        }

        if verts.is_empty() {
            return 0;
        }
        let bytes: &[u8] = bytemuck::cast_slice(&verts);
        if bytes.len() as u64 > self.vbuf_capacity {
            self.vbuf_capacity = (bytes.len() as u64).next_power_of_two();
            self.vbuf = gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("sprite vbuf"),
                size: self.vbuf_capacity,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }
        gpu.queue.write_buffer(&self.vbuf, 0, bytes);
        verts.len() as u32
    }

    fn draw<'p>(&'p self, pass: &mut wgpu::RenderPass<'p>, vert_count: u32) {
        if vert_count == 0 {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(1, &self.bind_group, &[]);
        pass.set_vertex_buffer(0, self.vbuf.slice(..));
        pass.draw(0..vert_count, 0..1);
    }
}

// ---------------------------------------------------------------------------
// HUD pass
// ---------------------------------------------------------------------------

struct HudPass {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    globals: wgpu::Buffer,
    vbuf: wgpu::Buffer,
    vbuf_capacity: u64,
}

impl HudPass {
    fn new(gpu: &Gpu, color_format: wgpu::TextureFormat) -> Self {
        let device = &gpu.device;
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("hud.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/hud.wgsl").into()),
        });

        // Font atlas texture (R8).
        let atlas_pixels = build_font_atlas();
        let atlas = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("hud font atlas"),
            size: wgpu::Extent3d {
                width: ATLAS_W,
                height: ATLAS_H,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &atlas,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &atlas_pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(ATLAS_W),
                rows_per_image: Some(ATLAS_H),
            },
            wgpu::Extent3d {
                width: ATLAS_W,
                height: ATLAS_H,
                depth_or_array_layers: 1,
            },
        );
        let atlas_view = atlas.create_view(&wgpu::TextureViewDescriptor::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("hud sampler"),
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        let globals = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("hud globals"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("hud bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("hud bg"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: globals.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&atlas_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });

        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("hud layout"),
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("hud pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<HudVertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x4],
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: color_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let vbuf_capacity = 64 * 1024;
        let vbuf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("hud vbuf"),
            size: vbuf_capacity,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Self {
            pipeline,
            bind_group,
            globals,
            vbuf,
            vbuf_capacity,
        }
    }

    fn upload(&mut self, gpu: &Gpu, hud: &Hud, size: (u32, u32)) {
        let bytes: &[u8] = bytemuck::cast_slice(&hud.verts);
        if bytes.len() as u64 > self.vbuf_capacity {
            self.vbuf_capacity = (bytes.len() as u64).next_power_of_two();
            self.vbuf = gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("hud vbuf"),
                size: self.vbuf_capacity,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }
        gpu.queue.write_buffer(&self.vbuf, 0, bytes);
        let globals = [size.0 as f32, size.1 as f32, 0.0, 0.0];
        gpu.queue
            .write_buffer(&self.globals, 0, bytemuck::cast_slice(&globals));
    }

    fn draw<'p>(&'p self, pass: &mut wgpu::RenderPass<'p>, hud: &Hud) {
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.set_vertex_buffer(0, self.vbuf.slice(..));
        pass.draw(0..hud.verts.len() as u32, 0..1);
    }
}

#[cfg(test)]
mod tests {
    use glam::{Quat, Vec3};
    #[cfg(not(target_arch = "wasm32"))]
    use wgpu::naga::{
        front::wgsl::parse_str,
        valid::{Capabilities, ValidationFlags, Validator},
    };

    use super::{GlobalsRaw, InstanceRaw, model_normal_matrix};

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn renderer_shaders_pass_cpu_validation() {
        for (label, source) in [
            ("world.wgsl", include_str!("shaders/world.wgsl")),
            ("model.wgsl", include_str!("shaders/model.wgsl")),
            ("sprite.wgsl", include_str!("shaders/sprite.wgsl")),
            ("hud.wgsl", include_str!("shaders/hud.wgsl")),
        ] {
            let module = parse_str(source).unwrap_or_else(|error| panic!("{label}: {error}"));
            Validator::new(ValidationFlags::all(), Capabilities::empty())
                .validate(&module)
                .unwrap_or_else(|error| panic!("{label}: {error}"));
        }
    }

    #[test]
    fn gpu_uniform_structs_retain_wgsl_alignment() {
        assert_eq!(std::mem::size_of::<GlobalsRaw>(), 336);
        assert_eq!(std::mem::size_of::<InstanceRaw>(), 160);
        assert_eq!(std::mem::align_of::<GlobalsRaw>(), 4);
        assert_eq!(std::mem::align_of::<InstanceRaw>(), 4);
    }

    #[test]
    fn normal_matrix_preserves_tangent_orthogonality_after_nonuniform_scale() {
        let tangent = Vec3::new(1.0, 1.0, 0.0).normalize();
        let normal = Vec3::new(1.0, -1.0, 0.0).normalize();
        let model = glam::Mat4::from_scale_rotation_translation(
            Vec3::new(2.0, 0.5, 3.0),
            Quat::from_rotation_y(0.7),
            Vec3::new(4.0, 5.0, 6.0),
        );

        let world_tangent = model.transform_vector3(tangent).normalize();
        let world_normal = model_normal_matrix(model)
            .transform_vector3(normal)
            .normalize();
        assert!(world_tangent.dot(world_normal).abs() < 1e-5);

        let old_world_normal = model.transform_vector3(normal).normalize();
        assert!(world_tangent.dot(old_world_normal).abs() > 0.1);
    }

    #[test]
    fn singular_normal_matrix_fallback_stays_finite() {
        let normal = model_normal_matrix(glam::Mat4::from_scale(Vec3::new(1.0, 0.0, 2.0)));
        assert!(normal.to_cols_array().iter().all(|value| value.is_finite()));
    }
}
