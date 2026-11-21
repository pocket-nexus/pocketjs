//! Skinned/static model assets (glTF) and scene instances.

use std::cell::Cell;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};

use crate::anim::{AnimState, Channel, ChannelPath, Clip, Interpolation, NodeTrs, Skeleton};
use crate::gpu::Gpu;
use crate::texture::{GpuTexture, Samplers, create_rgba_texture};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct ModelVertex {
    pub pos: [f32; 3],
    pub normal: [f32; 3],
    pub uv: [f32; 2],
    pub joints: [u32; 4],
    pub weights: [f32; 4],
}

impl ModelVertex {
    pub const LAYOUT: wgpu::VertexBufferLayout<'static> = wgpu::VertexBufferLayout {
        array_stride: std::mem::size_of::<ModelVertex>() as u64,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &wgpu::vertex_attr_array![
            0 => Float32x3, 1 => Float32x3, 2 => Float32x2, 3 => Uint32x4, 4 => Float32x4
        ],
    };
}

/// The glTF alpha policy retained on each uploaded primitive.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaterialAlphaMode {
    Opaque,
    Mask,
    Blend,
}

/// Optional authored treatment of a material's final base color.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MaterialBaseColorMode {
    #[default]
    Authored,
    /// Convert the final RGB value to luminance while preserving alpha.
    Monochrome,
}

impl MaterialAlphaMode {
    fn from_gltf(mode: gltf::material::AlphaMode) -> Self {
        match mode {
            gltf::material::AlphaMode::Opaque => Self::Opaque,
            gltf::material::AlphaMode::Mask => Self::Mask,
            gltf::material::AlphaMode::Blend => Self::Blend,
        }
    }
}

/// Replace the base-color texture of semantically tagged glTF materials.
///
/// Matching prefers `extras.pocket3d_role`; `name_prefix` is used only when
/// that role is absent. The texture and sampler are captured by the primitive
/// bind group, so callers may render new pixels into the same texture without
/// rebuilding the model.
pub struct MaterialTextureOverride<'a> {
    pub role: &'a str,
    pub name_prefix: Option<&'a str>,
    pub texture_view: &'a wgpu::TextureView,
    pub sampler: &'a wgpu::Sampler,
    pub expected_primitive_count: Option<usize>,
    pub force_white: bool,
    pub force_unlit: bool,
    pub force_opaque: bool,
    pub force_blend: bool,
    pub require_normalized_texcoord0: bool,
}

impl<'a> MaterialTextureOverride<'a> {
    pub fn new(
        role: &'a str,
        name_prefix: Option<&'a str>,
        texture_view: &'a wgpu::TextureView,
        sampler: &'a wgpu::Sampler,
    ) -> Self {
        Self {
            role,
            name_prefix,
            texture_view,
            sampler,
            expected_primitive_count: None,
            force_white: false,
            force_unlit: false,
            force_opaque: false,
            force_blend: false,
            require_normalized_texcoord0: false,
        }
    }

    pub fn expect_primitives(mut self, count: usize) -> Self {
        self.expected_primitive_count = Some(count);
        self
    }

    pub fn force_white(mut self) -> Self {
        self.force_white = true;
        self
    }

    pub fn force_unlit(mut self) -> Self {
        self.force_unlit = true;
        self
    }

    pub fn force_opaque(mut self) -> Self {
        self.force_opaque = true;
        self
    }

    /// Force alpha blending even when the authored glTF material is opaque.
    /// This is useful for replacing a cosmetic layer with a transparent
    /// texture without modifying the source mesh.
    pub fn force_blend(mut self) -> Self {
        self.force_blend = true;
        self
    }

    /// Reject matching primitives unless `TEXCOORD_0` is finite, normalized,
    /// and spans enough of each axis for a live 2D surface.
    pub fn require_normalized_texcoord0(mut self) -> Self {
        self.require_normalized_texcoord0 = true;
        self
    }
}

#[derive(Eq, Hash, PartialEq)]
struct ModelTextureCacheKey {
    width: u32,
    height: u32,
    rgba: Box<[u8]>,
}

/// Explicit content-addressed cache for textures shared by multiple models.
///
/// Keys use the exact RGBA pixels after [`ModelLoadOptions`] downsampling plus
/// their dimensions, so identical images in independently cooked LOD files
/// share one GPU allocation without relying on image indices or names. The
/// cache retains those CPU pixels to make equality collision-free; callers
/// loading a fixed batch can drop it afterwards because every [`ModelAsset`]
/// keeps its shared [`GpuTexture`] allocations alive with [`Arc`].
#[derive(Default)]
pub struct ModelTextureCache {
    entries: HashMap<ModelTextureCacheKey, Arc<GpuTexture>>,
    hits: usize,
}

impl ModelTextureCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn hit_count(&self) -> usize {
        self.hits
    }

    fn get_or_upload(
        &mut self,
        gpu: &Gpu,
        label: &str,
        width: u32,
        height: u32,
        rgba: Vec<u8>,
    ) -> Arc<GpuTexture> {
        let key = ModelTextureCacheKey {
            width,
            height,
            rgba: rgba.into_boxed_slice(),
        };
        match self.entries.entry(key) {
            Entry::Occupied(entry) => {
                self.hits += 1;
                entry.get().clone()
            }
            Entry::Vacant(entry) => {
                let key = entry.key();
                let texture = Arc::new(create_rgba_texture(
                    gpu, label, key.width, key.height, &key.rgba, true, true,
                ));
                entry.insert(texture.clone());
                texture
            }
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct MaterialRaw {
    base_color_factor: [f32; 4],
    /// x: unlit, y: alpha cutoff (0 = off), z: double-sided, w: blend.
    params: [f32; 4],
    /// x: monochrome base color, y/z/w reserved.
    style: [f32; 4],
}

struct PrimitiveUpload {
    first_index: u32,
    index_count: u32,
    image: Option<usize>,
    base_color_factor: [f32; 4],
    alpha_mode: MaterialAlphaMode,
    alpha_cutoff: f32,
    double_sided: bool,
    unlit: bool,
    base_color_mode: MaterialBaseColorMode,
    material_name: Option<String>,
    material_role: Option<String>,
    texture_override: Option<usize>,
}

pub struct Primitive {
    pub first_index: u32,
    pub index_count: u32,
    pub bind_group: wgpu::BindGroup,
    pub alpha_mode: MaterialAlphaMode,
    pub alpha_cutoff: f32,
    pub double_sided: bool,
    pub unlit: bool,
    pub base_color_mode: MaterialBaseColorMode,
    pub material_name: Option<String>,
    pub material_role: Option<String>,
    /// Kept alive explicitly alongside the bind group.
    #[allow(dead_code)]
    material_buf: wgpu::Buffer,
}

#[derive(Default, Clone, Copy)]
pub struct ModelLoadOptions {
    /// Halve textures until no side exceeds this (mip-friendly box filter).
    /// Character/prop authoring resolutions routinely exceed what small
    /// windows can display; this is the biggest single memory lever.
    pub max_texture_dim: Option<u32>,
}

pub use pocket3d_mesh::Skin;

/// One morph target of a primitive, stored sparse: only vertices the target
/// actually displaces. Deltas are in object space (bake transform applied).
pub struct MorphTargetData {
    /// (vertex index within the primitive, position delta).
    pub pos: Vec<(u32, Vec3)>,
    /// (vertex index within the primitive, normal delta).
    pub normal: Vec<(u32, Vec3)>,
}

/// A primitive that carries morph targets. Its base vertices are kept on the
/// CPU; morphed copies are written into a per-instance overlay buffer.
pub struct MorphPrim {
    /// Index into [`ModelAsset::primitives`].
    pub primitive: usize,
    /// First vertex of this primitive in the shared asset vertex buffer.
    pub vertex_base: u32,
    pub vertex_count: u32,
    /// First vertex of this primitive in a [`MorphState`] overlay buffer.
    pub overlay_offset: u32,
    base: Vec<ModelVertex>,
    pub targets: Vec<MorphTargetData>,
}

/// All morph-bearing primitives of one glTF mesh. VRM blend-shape binds
/// address targets as (glTF mesh index, target index), which maps here.
pub struct MorphMesh {
    /// glTF mesh index.
    pub mesh: usize,
    pub target_count: usize,
    pub prims: Vec<MorphPrim>,
}

/// Per-instance morph weights + the GPU overlay holding morphed vertices.
/// Weights are set by game code; the overlay upload happens lazily during
/// render prepare, and costs nothing on frames where no weight changed.
pub struct MorphState {
    /// Parallel to [`ModelAsset::morph_meshes`]; one weight per target.
    weights: Vec<Vec<f32>>,
    /// Bitmask of morph meshes needing recompute (interior mutability so the
    /// renderer can flush during prepare without a `&mut Scene`).
    dirty: Cell<u64>,
    buffer: wgpu::Buffer,
}

impl MorphState {
    /// `mesh_slot` indexes [`ModelAsset::morph_meshes`].
    pub fn set_weight(&mut self, mesh_slot: usize, target: usize, weight: f32) {
        let Some(w) = self
            .weights
            .get_mut(mesh_slot)
            .and_then(|m| m.get_mut(target))
        else {
            return;
        };
        if *w != weight {
            *w = weight;
            let bit = if mesh_slot < 64 {
                1u64 << mesh_slot
            } else {
                u64::MAX
            };
            self.dirty.set(self.dirty.get() | bit);
        }
    }

    pub fn weight(&self, mesh_slot: usize, target: usize) -> f32 {
        self.weights
            .get(mesh_slot)
            .and_then(|m| m.get(target))
            .copied()
            .unwrap_or(0.0)
    }

    pub(crate) fn buffer(&self) -> &wgpu::Buffer {
        &self.buffer
    }

    /// Recompute + upload overlay vertices for meshes whose weights changed.
    pub(crate) fn upload_if_dirty(&self, gpu: &Gpu, asset: &ModelAsset) {
        let dirty = self.dirty.replace(0);
        if dirty == 0 {
            return;
        }
        for (mi, mesh) in asset.morph_meshes.iter().enumerate() {
            if mi < 64 && dirty & (1u64 << mi) == 0 {
                continue;
            }
            let weights = &self.weights[mi];
            for prim in &mesh.prims {
                let mut verts = prim.base.clone();
                for (ti, target) in prim.targets.iter().enumerate() {
                    let w = weights.get(ti).copied().unwrap_or(0.0);
                    if w.abs() < 1e-4 {
                        continue;
                    }
                    for &(vi, d) in &target.pos {
                        let v = &mut verts[vi as usize];
                        v.pos = (Vec3::from(v.pos) + d * w).to_array();
                    }
                    for &(vi, d) in &target.normal {
                        let v = &mut verts[vi as usize];
                        v.normal = (Vec3::from(v.normal) + d * w).to_array();
                    }
                }
                gpu.queue.write_buffer(
                    &self.buffer,
                    prim.overlay_offset as u64 * std::mem::size_of::<ModelVertex>() as u64,
                    bytemuck::cast_slice(&verts),
                );
            }
        }
    }
}

pub struct ModelAsset {
    pub vbuf: wgpu::Buffer,
    pub ibuf: wgpu::Buffer,
    pub primitives: Vec<Primitive>,
    pub skeleton: Skeleton,
    /// glTF node names indexed exactly like [`Self::skeleton`]. Procedural
    /// assets have no nodes, so this is empty for `from_geometry*` models.
    node_names: Vec<Option<String>>,
    /// All skins in the file. The joint palette concatenates them in order;
    /// vertex joint indices were remapped at load to address the combined
    /// palette (multi-skin characters: body + visor etc.).
    pub skins: Vec<Skin>,
    pub clips: Vec<Clip>,
    /// Meshes carrying morph targets (facial blend shapes etc.).
    pub morph_meshes: Vec<MorphMesh>,
    /// Parallel to `primitives`: (morph mesh slot, prim slot) when morphing.
    pub prim_morph: Vec<Option<(usize, usize)>>,
    /// Rest-pose bounds (object space; skinned primitives measured through
    /// their rest-pose joint matrices, so units/orientation baked into the
    /// rig — cm exports, Z-up meshes — are already resolved).
    pub aabb: (Vec3, Vec3),
    #[allow(dead_code)]
    textures: Vec<Arc<GpuTexture>>,
}

fn make_material_bind_group(
    gpu: &Gpu,
    layout: &wgpu::BindGroupLayout,
    label: &str,
    view: &wgpu::TextureView,
    sampler: &wgpu::Sampler,
    material: &MaterialRaw,
) -> (wgpu::BindGroup, wgpu::Buffer) {
    use wgpu::util::DeviceExt;

    let material_buf = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(&format!("{label} params")),
            contents: bytemuck::bytes_of(material),
            usage: wgpu::BufferUsages::UNIFORM,
        });
    let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some(label),
        layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(sampler),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: material_buf.as_entire_binding(),
            },
        ],
    });
    (bind_group, material_buf)
}

fn pocket3d_material_role(material: &gltf::Material<'_>) -> Option<String> {
    let raw = material.extras().as_ref()?.get();
    pocket3d_role_from_extras(raw)
}

fn pocket3d_material_base_color_mode(material: &gltf::Material<'_>) -> MaterialBaseColorMode {
    let Some(raw) = material.extras().as_ref().map(|extras| extras.get()) else {
        return MaterialBaseColorMode::Authored;
    };
    pocket3d_base_color_mode_from_extras(raw)
}

fn pocket3d_role_from_extras(raw: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()?
        .get("pocket3d_role")?
        .as_str()
        .map(str::to_owned)
}

fn pocket3d_base_color_mode_from_extras(raw: &str) -> MaterialBaseColorMode {
    match serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|extras| {
            extras
                .get("pocket3d_base_color_mode")?
                .as_str()
                .map(str::to_owned)
        })
        .as_deref()
    {
        Some("monochrome") => MaterialBaseColorMode::Monochrome,
        _ => MaterialBaseColorMode::Authored,
    }
}

fn semantic_material_matches(
    material_role: Option<&str>,
    material_name: Option<&str>,
    role: &str,
    name_prefix: Option<&str>,
) -> bool {
    match material_role {
        Some(material_role) => material_role == role,
        None => name_prefix
            .zip(material_name)
            .is_some_and(|(prefix, name)| name.starts_with(prefix)),
    }
}

fn validate_normalized_texcoord0(
    texcoords: Option<&[[f32; 2]]>,
    vertex_count: usize,
    material_name: Option<&str>,
    path: &Path,
) -> Result<()> {
    let label = material_name.unwrap_or("<unnamed>");
    let Some(texcoords) = texcoords else {
        bail!(
            "material {label:?} in {} requires TEXCOORD_0, but it is missing",
            path.display()
        );
    };
    if texcoords.len() != vertex_count {
        bail!(
            "material {label:?} in {} has {} TEXCOORD_0 values for {vertex_count} vertices",
            path.display(),
            texcoords.len()
        );
    }

    let mut min = [f32::INFINITY; 2];
    let mut max = [f32::NEG_INFINITY; 2];
    for uv in texcoords {
        if !uv[0].is_finite() || !uv[1].is_finite() {
            bail!(
                "material {label:?} in {} has non-finite TEXCOORD_0 values",
                path.display()
            );
        }
        for axis in 0..2 {
            min[axis] = min[axis].min(uv[axis]);
            max[axis] = max[axis].max(uv[axis]);
        }
    }

    const NORMALIZED_TOLERANCE: f32 = 0.01;
    if min.iter().any(|&value| value < -NORMALIZED_TOLERANCE)
        || max.iter().any(|&value| value > 1.0 + NORMALIZED_TOLERANCE)
    {
        bail!(
            "material {label:?} in {} has non-normalized TEXCOORD_0 bounds {:?}..{:?}",
            path.display(),
            min,
            max
        );
    }

    const MIN_AXIS_SPAN: f32 = 0.5;
    let span = [max[0] - min[0], max[1] - min[1]];
    if span[0] < MIN_AXIS_SPAN || span[1] < MIN_AXIS_SPAN {
        bail!(
            "material {label:?} in {} has insufficient TEXCOORD_0 span {:?}; each axis must span at least {MIN_AXIS_SPAN}",
            path.display(),
            span
        );
    }
    Ok(())
}

impl ModelAsset {
    /// Return the glTF node index for `name`.
    ///
    /// Node indices address [`Self::skeleton`] and can be sampled with
    /// [`Self::sampled_node_transform`]. If a file contains duplicate names,
    /// the first node in glTF index order wins.
    pub fn node_named(&self, name: &str) -> Option<usize> {
        find_node_named(&self.node_names, name)
    }

    /// Sample one node's object-space global transform for `anim`.
    ///
    /// The returned matrix includes the animated transforms of all node
    /// ancestors. It does not include a [`ModelInstance`] transform or any skin
    /// inverse-bind matrix, so callers can compose it directly with an
    /// instance transform when placing a held object or other socket content.
    /// Invalid node indices return `None`.
    pub fn sampled_node_transform(&self, node: usize, anim: &AnimState) -> Option<Mat4> {
        sample_node_transform(&self.skeleton, &self.clips, node, anim)
    }

    pub fn clip_named(&self, name: &str) -> Option<usize> {
        self.clips.iter().position(|c| c.name == name)
    }

    pub fn height(&self) -> f32 {
        (self.aabb.1.y - self.aabb.0.y).max(0.001)
    }

    /// Joint palette for the given animation state (identity if no skin).
    /// Skins concatenate in file order, matching the load-time joint remap.
    pub fn joint_palette(&self, anim: &AnimState, out: &mut Vec<Mat4>) {
        let mut globals = Vec::new();
        let clip = self.clips.get(anim.clip);
        self.skeleton
            .global_transforms(clip, anim.time, anim.looping, &mut globals);
        self.palette_from_globals(&globals, out);
    }

    /// Joint palette from externally computed node globals (procedural poses:
    /// look-at, physics bones). Same skin concatenation as `joint_palette`.
    pub fn palette_from_globals(&self, globals: &[Mat4], out: &mut Vec<Mat4>) {
        out.clear();
        for skin in &self.skins {
            out.extend(skin.matrices(globals, None));
        }
        if out.is_empty() {
            out.push(Mat4::IDENTITY);
        }
    }

    /// Which slot in `morph_meshes` a glTF mesh landed in.
    pub fn morph_mesh_slot(&self, gltf_mesh: usize) -> Option<usize> {
        self.morph_meshes.iter().position(|m| m.mesh == gltf_mesh)
    }

    /// Create per-instance morph state (overlay buffer starts at the rest
    /// shape). `None` when the asset has no morph targets.
    pub fn create_morph_state(&self, gpu: &Gpu) -> Option<MorphState> {
        use wgpu::util::DeviceExt;
        if self.morph_meshes.is_empty() {
            return None;
        }
        let mut init: Vec<ModelVertex> = Vec::new();
        for mesh in &self.morph_meshes {
            for prim in &mesh.prims {
                init.extend_from_slice(&prim.base);
            }
        }
        let buffer = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("morph overlay"),
                contents: bytemuck::cast_slice(&init),
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            });
        Some(MorphState {
            weights: self
                .morph_meshes
                .iter()
                .map(|m| vec![0.0; m.target_count])
                .collect(),
            dirty: Cell::new(0),
            buffer,
        })
    }

    /// The material bind group layout for model primitives (group 1).
    pub fn material_layout(gpu: &Gpu) -> wgpu::BindGroupLayout {
        gpu.device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("model material"),
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
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: wgpu::BufferSize::new(
                                std::mem::size_of::<MaterialRaw>() as u64,
                            ),
                        },
                        count: None,
                    },
                ],
            })
    }

    /// Build an asset from raw geometry (procedural models). `image` is an
    /// optional RGBA8 texture; omit it for a plain white surface.
    pub fn from_geometry(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        label: &str,
        vertices: &[ModelVertex],
        indices: &[u32],
        image: Option<(u32, u32, &[u8])>,
    ) -> Arc<Self> {
        use wgpu::util::DeviceExt;
        let (tw, th, tpx): (u32, u32, &[u8]) = image.unwrap_or((1, 1, &[255u8, 255, 255, 255]));
        let tex = Arc::new(create_rgba_texture(gpu, label, tw, th, tpx, true, false));
        let material = MaterialRaw {
            base_color_factor: [1.0; 4],
            params: [0.0; 4],
            style: [0.0; 4],
        };
        let (bind_group, material_buf) = make_material_bind_group(
            gpu,
            layout,
            label,
            &tex.view,
            &samplers.aniso_repeat,
            &material,
        );
        let vbuf = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::cast_slice(vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let ibuf = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::cast_slice(indices),
                usage: wgpu::BufferUsages::INDEX,
            });
        let mut aabb = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        for v in vertices {
            let p = Vec3::from(v.pos);
            aabb.0 = aabb.0.min(p);
            aabb.1 = aabb.1.max(p);
        }
        Arc::new(Self {
            vbuf,
            ibuf,
            primitives: vec![Primitive {
                first_index: 0,
                index_count: indices.len() as u32,
                bind_group,
                alpha_mode: MaterialAlphaMode::Opaque,
                alpha_cutoff: 0.0,
                double_sided: false,
                unlit: false,
                base_color_mode: MaterialBaseColorMode::Authored,
                material_name: Some(label.to_owned()),
                material_role: None,
                material_buf,
            }],
            skeleton: Skeleton {
                parents: Vec::new(),
                rest: Vec::new(),
                order: Vec::new(),
            },
            node_names: Vec::new(),
            skins: Vec::new(),
            clips: Vec::new(),
            morph_meshes: Vec::new(),
            prim_morph: vec![None],
            aabb,
            textures: vec![tex],
        })
    }

    /// Build an asset from raw geometry whose material samples an external
    /// texture view (an [`crate::gpu::OffscreenTarget`], a video frame, …).
    /// The bind group keeps the underlying texture alive; render into it
    /// each frame and every instance of this asset shows the update — this
    /// is how a live 2D surface lands on a 3D mesh (pocket-widget screens).
    pub fn from_geometry_textured(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        label: &str,
        vertices: &[ModelVertex],
        indices: &[u32],
        view: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
    ) -> Arc<Self> {
        use wgpu::util::DeviceExt;
        let material = MaterialRaw {
            base_color_factor: [1.0; 4],
            params: [0.0; 4],
            style: [0.0; 4],
        };
        let (bind_group, material_buf) =
            make_material_bind_group(gpu, layout, label, view, sampler, &material);
        let vbuf = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::cast_slice(vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let ibuf = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::cast_slice(indices),
                usage: wgpu::BufferUsages::INDEX,
            });
        let mut aabb = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        for v in vertices {
            let p = Vec3::from(v.pos);
            aabb.0 = aabb.0.min(p);
            aabb.1 = aabb.1.max(p);
        }
        Arc::new(Self {
            vbuf,
            ibuf,
            primitives: vec![Primitive {
                first_index: 0,
                index_count: indices.len() as u32,
                bind_group,
                alpha_mode: MaterialAlphaMode::Opaque,
                alpha_cutoff: 0.0,
                double_sided: false,
                unlit: false,
                base_color_mode: MaterialBaseColorMode::Authored,
                material_name: Some(label.to_owned()),
                material_role: None,
                material_buf,
            }],
            skeleton: Skeleton {
                parents: Vec::new(),
                rest: Vec::new(),
                order: Vec::new(),
            },
            node_names: Vec::new(),
            skins: Vec::new(),
            clips: Vec::new(),
            morph_meshes: Vec::new(),
            prim_morph: vec![None],
            aabb,
            textures: Vec::new(),
        })
    }

    pub fn load_glb(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        path: &Path,
    ) -> Result<Arc<Self>> {
        Self::load_glb_opts(gpu, layout, samplers, path, &ModelLoadOptions::default())
    }

    /// Load a self-contained binary glTF model directly from memory.
    ///
    /// `label` is used for diagnostics. External buffer or image URIs are not
    /// supported by this entry point; embed those resources in the GLB.
    pub fn load_glb_bytes(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        bytes: &[u8],
        label: &str,
    ) -> Result<Arc<Self>> {
        let imported = import_glb_slice(bytes, label)?;
        let mut cache = ModelTextureCache::new();
        Self::load_glb_imported(
            gpu,
            layout,
            samplers,
            Path::new(label),
            &ModelLoadOptions::default(),
            &[],
            &mut cache,
            imported,
        )
    }

    pub fn load_glb_opts(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        path: &Path,
        opts: &ModelLoadOptions,
    ) -> Result<Arc<Self>> {
        Self::load_glb_opts_with_overrides(gpu, layout, samplers, path, opts, &[])
    }

    /// Load a glTF model while sharing imported textures through `cache`.
    /// The cache must only be used with the [`Gpu`] that created it.
    pub fn load_glb_with_cache(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        path: &Path,
        cache: &mut ModelTextureCache,
    ) -> Result<Arc<Self>> {
        Self::load_glb_opts_with_cache(
            gpu,
            layout,
            samplers,
            path,
            &ModelLoadOptions::default(),
            cache,
        )
    }

    /// `load_glb_with_cache` plus the normal model load options.
    pub fn load_glb_opts_with_cache(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        path: &Path,
        opts: &ModelLoadOptions,
        cache: &mut ModelTextureCache,
    ) -> Result<Arc<Self>> {
        Self::load_glb_opts_with_overrides_and_cache(gpu, layout, samplers, path, opts, &[], cache)
    }

    /// Load a glTF model and replace selected semantic materials with external
    /// texture views. This is intended for live surfaces such as a handheld
    /// screen; existing `load_glb*` entry points remain equivalent to passing
    /// an empty override slice.
    pub fn load_glb_with_overrides(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        path: &Path,
        overrides: &[MaterialTextureOverride<'_>],
    ) -> Result<Arc<Self>> {
        Self::load_glb_opts_with_overrides(
            gpu,
            layout,
            samplers,
            path,
            &ModelLoadOptions::default(),
            overrides,
        )
    }

    /// `load_glb_with_overrides` plus the normal model load options.
    pub fn load_glb_opts_with_overrides(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        path: &Path,
        opts: &ModelLoadOptions,
        overrides: &[MaterialTextureOverride<'_>],
    ) -> Result<Arc<Self>> {
        let mut cache = ModelTextureCache::new();
        Self::load_glb_opts_with_overrides_and_cache(
            gpu, layout, samplers, path, opts, overrides, &mut cache,
        )
    }

    /// `load_glb_with_overrides` with an explicit texture cache shared across
    /// independently loaded assets.
    pub fn load_glb_with_overrides_and_cache(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        path: &Path,
        overrides: &[MaterialTextureOverride<'_>],
        cache: &mut ModelTextureCache,
    ) -> Result<Arc<Self>> {
        Self::load_glb_opts_with_overrides_and_cache(
            gpu,
            layout,
            samplers,
            path,
            &ModelLoadOptions::default(),
            overrides,
            cache,
        )
    }

    /// Fully configurable glTF load with semantic material overrides and an
    /// explicit content-addressed texture cache.
    pub fn load_glb_opts_with_overrides_and_cache(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        path: &Path,
        opts: &ModelLoadOptions,
        overrides: &[MaterialTextureOverride<'_>],
        cache: &mut ModelTextureCache,
    ) -> Result<Arc<Self>> {
        for material_override in overrides {
            if material_override.force_opaque && material_override.force_blend {
                bail!(
                    "material override role {:?} cannot force both opaque and blend",
                    material_override.role
                );
            }
        }
        let imported =
            gltf::import(path).with_context(|| format!("importing {}", path.display()))?;

        Self::load_glb_imported(
            gpu, layout, samplers, path, opts, overrides, cache, imported,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn load_glb_imported(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        path: &Path,
        opts: &ModelLoadOptions,
        overrides: &[MaterialTextureOverride<'_>],
        cache: &mut ModelTextureCache,
        imported: ImportedGltf,
    ) -> Result<Arc<Self>> {
        let (doc, buffers, images) = imported;

        // --- textures ------------------------------------------------------
        // Only upload images a material actually samples (VRM files carry
        // thumbnails and utility maps), and optionally cap texture size —
        // authoring resolutions (4096²) dwarf what a small widget window can
        // ever show, and GPU memory is the dominant cost of a character.
        let used: std::collections::HashSet<usize> = doc
            .materials()
            .filter(|material| {
                let role = pocket3d_material_role(material);
                !overrides.iter().any(|candidate| {
                    semantic_material_matches(
                        role.as_deref(),
                        material.name(),
                        candidate.role,
                        candidate.name_prefix,
                    )
                })
            })
            .filter_map(|m| {
                m.pbr_metallic_roughness()
                    .base_color_texture()
                    .map(|t| t.texture().source().index())
            })
            .collect();
        // Unused image slots and primitives without a base-color image all
        // share this fallback instead of allocating one dummy texture each.
        let white = Arc::new(create_rgba_texture(
            gpu,
            "white",
            1,
            1,
            &[255, 255, 255, 255],
            true,
            false,
        ));
        let mut textures = Vec::with_capacity(images.len() + 1);
        for (i, img) in images.iter().enumerate() {
            if !used.contains(&i) {
                textures.push(white.clone());
                continue;
            }
            let mut rgba = to_rgba8(img);
            let (mut w, mut h) = (img.width, img.height);
            if let Some(max) = opts.max_texture_dim {
                while w.max(h) > max && w % 2 == 0 && h % 2 == 0 {
                    rgba = downsample_rgba(&rgba, w, h);
                    w /= 2;
                    h /= 2;
                }
            }
            textures.push(cache.get_or_upload(gpu, &format!("model img {i}"), w, h, rgba));
        }

        // --- nodes / skeleton ----------------------------------------------
        let node_count = doc.nodes().count();
        let mut parents = vec![usize::MAX; node_count];
        let mut rest = vec![NodeTrs::IDENTITY; node_count];
        let mut node_names = vec![None; node_count];
        for node in doc.nodes() {
            let (t, r, s) = node.transform().decomposed();
            node_names[node.index()] = node.name().map(str::to_owned);
            rest[node.index()] = NodeTrs {
                translation: Vec3::from(t),
                rotation: glam::Quat::from_array(r),
                scale: Vec3::from(s),
            };
            for child in node.children() {
                parents[child.index()] = node.index();
            }
        }
        // Parents-first order via DFS from roots.
        let mut order = Vec::with_capacity(node_count);
        let mut stack: Vec<usize> = (0..node_count)
            .filter(|&i| parents[i] == usize::MAX)
            .collect();
        stack.reverse();
        let children_of: Vec<Vec<usize>> = doc
            .nodes()
            .map(|n| n.children().map(|c| c.index()).collect())
            .collect();
        while let Some(i) = stack.pop() {
            order.push(i);
            for &c in children_of[i].iter().rev() {
                stack.push(c);
            }
        }
        let skeleton = Skeleton {
            parents,
            rest,
            order,
        };

        // --- skins -----------------------------------------------------------
        // All of them: multi-skin characters (body + visor) address one
        // concatenated joint palette, so each skin gets a base offset and the
        // vertex joint indices are remapped below.
        let skins: Vec<Skin> = doc
            .skins()
            .map(|s| {
                let reader = s.reader(|b| buffers.get(b.index()).map(|d| d.0.as_slice()));
                let inverse_bind: Vec<Mat4> = reader
                    .read_inverse_bind_matrices()
                    .map(|it| it.map(|m| Mat4::from_cols_array_2d(&m)).collect())
                    .unwrap_or_default();
                let joints: Vec<usize> = s.joints().map(|j| j.index()).collect();
                let inverse_bind = if inverse_bind.len() == joints.len() {
                    inverse_bind
                } else {
                    vec![Mat4::IDENTITY; joints.len()]
                };
                Skin {
                    joints,
                    inverse_bind,
                }
            })
            .collect();
        let skin_base: Vec<u32> = skins
            .iter()
            .scan(0u32, |acc, s| {
                let base = *acc;
                *acc += s.joints.len() as u32;
                Some(base)
            })
            .collect();

        // --- meshes ----------------------------------------------------------
        // Global transforms of the rest pose, to bake node placement into
        // non-skinned primitives.
        let mut rest_globals = Vec::new();
        skeleton.global_transforms(None, 0.0, false, &mut rest_globals);

        let mut vertices: Vec<ModelVertex> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        let mut primitives_meta: Vec<PrimitiveUpload> = Vec::new();
        let mut override_counts = vec![0usize; overrides.len()];
        let mut aabb = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        let mut morph_meshes: Vec<MorphMesh> = Vec::new();
        let mut prim_morph: Vec<Option<(usize, usize)>> = Vec::new();
        let mut overlay_verts: u32 = 0;

        for node in doc.nodes() {
            let Some(mesh) = node.mesh() else { continue };
            let node_skin = node.skin().map(|s| s.index()).filter(|&i| i < skins.len());
            let bake = if node_skin.is_some() {
                Mat4::IDENTITY
            } else {
                rest_globals[node.index()]
            };
            let normal_bake = bake.inverse().transpose();
            // Rest-pose joint matrices for measuring skinned bounds: raw
            // vertices can live in an arbitrary rig space (cm, Z-up); only
            // the skinned result is in object space.
            let rest_palette: Vec<Mat4> = node_skin
                .map(|si| {
                    let s = &skins[si];
                    s.matrices(&rest_globals, None).collect()
                })
                .unwrap_or_default();

            for prim in mesh.primitives() {
                let reader = prim.reader(|b| buffers.get(b.index()).map(|d| d.0.as_slice()));
                let Some(pos_iter) = reader.read_positions() else {
                    continue;
                };
                let base = vertices.len() as u32;

                let positions: Vec<[f32; 3]> = pos_iter.collect();
                let normals: Vec<[f32; 3]> = reader
                    .read_normals()
                    .map(|it| it.collect())
                    .unwrap_or_else(|| vec![[0.0, 1.0, 0.0]; positions.len()]);
                let texcoord0: Option<Vec<[f32; 2]>> =
                    reader.read_tex_coords(0).map(|it| it.into_f32().collect());
                let joints: Vec<[u16; 4]> = reader
                    .read_joints(0)
                    .map(|it| it.into_u16().collect())
                    .unwrap_or_else(|| vec![[0, 0, 0, 0]; positions.len()]);
                let weights: Vec<[f32; 4]> = reader
                    .read_weights(0)
                    .map(|it| it.into_f32().collect())
                    .unwrap_or_else(|| vec![[1.0, 0.0, 0.0, 0.0]; positions.len()]);

                for i in 0..positions.len() {
                    let p = bake.transform_point3(Vec3::from(positions[i]));
                    let n = normal_bake
                        .transform_vector3(Vec3::from(normals[i]))
                        .normalize_or_zero();
                    let (j, w) = match node_skin {
                        Some(si) => {
                            // Bounds from the rest-pose skinned position.
                            let raw = Vec3::from(positions[i]);
                            let mut rest = Vec3::ZERO;
                            for k in 0..4 {
                                let m = rest_palette.get(joints[i][k] as usize);
                                if let Some(m) = m {
                                    rest += m.transform_point3(raw) * weights[i][k];
                                }
                            }
                            aabb.0 = aabb.0.min(rest);
                            aabb.1 = aabb.1.max(rest);
                            let base = skin_base[si];
                            (
                                [
                                    base + joints[i][0] as u32,
                                    base + joints[i][1] as u32,
                                    base + joints[i][2] as u32,
                                    base + joints[i][3] as u32,
                                ],
                                weights[i],
                            )
                        }
                        None => {
                            aabb.0 = aabb.0.min(p);
                            aabb.1 = aabb.1.max(p);
                            ([0; 4], [1.0, 0.0, 0.0, 0.0])
                        }
                    };
                    vertices.push(ModelVertex {
                        pos: p.to_array(),
                        normal: n.to_array(),
                        uv: texcoord0
                            .as_deref()
                            .and_then(|texcoords| texcoords.get(i))
                            .copied()
                            .unwrap_or([0.0, 0.0]),
                        joints: j,
                        weights: w,
                    });
                }

                let first = indices.len() as u32;
                match reader.read_indices() {
                    Some(idx) => indices.extend(idx.into_u32().map(|i| base + i)),
                    None => indices.extend(base..vertices.len() as u32),
                }
                let count = indices.len() as u32 - first;

                let material = prim.material();
                let pbr = material.pbr_metallic_roughness();
                let image = pbr
                    .base_color_texture()
                    .map(|t| t.texture().source().index());
                let material_name = material.name().map(str::to_owned);
                let material_role = pocket3d_material_role(&material);
                let base_color_mode = pocket3d_material_base_color_mode(&material);
                let mut texture_override = None;
                for (override_index, candidate) in overrides.iter().enumerate() {
                    if !semantic_material_matches(
                        material_role.as_deref(),
                        material_name.as_deref(),
                        candidate.role,
                        candidate.name_prefix,
                    ) {
                        continue;
                    }
                    if texture_override.is_some() {
                        bail!(
                            "material {:?} in {} matches more than one texture override",
                            material_name.as_deref().unwrap_or("<unnamed>"),
                            path.display()
                        );
                    }
                    texture_override = Some(override_index);
                    override_counts[override_index] += 1;
                }

                let mut base_color_factor = pbr.base_color_factor();
                let mut alpha_mode = MaterialAlphaMode::from_gltf(material.alpha_mode());
                let alpha_cutoff = material.alpha_cutoff().unwrap_or(0.5);
                let double_sided = material.double_sided();
                let mut unlit = false;
                if let Some(override_index) = texture_override {
                    let material_override = &overrides[override_index];
                    if material_override.require_normalized_texcoord0 {
                        validate_normalized_texcoord0(
                            texcoord0.as_deref(),
                            positions.len(),
                            material_name.as_deref(),
                            path,
                        )?;
                    }
                    if material_override.force_white {
                        base_color_factor = [1.0; 4];
                    }
                    if material_override.force_unlit {
                        unlit = true;
                    }
                    if material_override.force_opaque {
                        alpha_mode = MaterialAlphaMode::Opaque;
                    }
                    if material_override.force_blend {
                        alpha_mode = MaterialAlphaMode::Blend;
                    }
                }

                // --- morph targets (sparse deltas, object space) -----------
                let mut targets: Vec<MorphTargetData> = Vec::new();
                for (tpos, tnorm, _ttan) in reader.read_morph_targets() {
                    let mut target = MorphTargetData {
                        pos: Vec::new(),
                        normal: Vec::new(),
                    };
                    if let Some(it) = tpos {
                        for (i, d) in it.enumerate() {
                            let d = bake.transform_vector3(Vec3::from(d));
                            if d.length_squared() > 1e-12 {
                                target.pos.push((i as u32, d));
                            }
                        }
                    }
                    if let Some(it) = tnorm {
                        for (i, d) in it.enumerate() {
                            let d = normal_bake.transform_vector3(Vec3::from(d));
                            if d.length_squared() > 1e-12 {
                                target.normal.push((i as u32, d));
                            }
                        }
                    }
                    targets.push(target);
                }
                if targets.is_empty() {
                    prim_morph.push(None);
                } else {
                    let mesh_idx = mesh.index();
                    let slot = morph_meshes
                        .iter()
                        .position(|m| m.mesh == mesh_idx)
                        .unwrap_or_else(|| {
                            morph_meshes.push(MorphMesh {
                                mesh: mesh_idx,
                                target_count: targets.len(),
                                prims: Vec::new(),
                            });
                            morph_meshes.len() - 1
                        });
                    let vertex_count = (vertices.len() as u32) - base;
                    let mm = &mut morph_meshes[slot];
                    mm.target_count = mm.target_count.max(targets.len());
                    prim_morph.push(Some((slot, mm.prims.len())));
                    mm.prims.push(MorphPrim {
                        primitive: primitives_meta.len(),
                        vertex_base: base,
                        vertex_count,
                        overlay_offset: overlay_verts,
                        base: vertices[base as usize..].to_vec(),
                        targets,
                    });
                    overlay_verts += vertex_count;
                }

                primitives_meta.push(PrimitiveUpload {
                    first_index: first,
                    index_count: count,
                    image,
                    base_color_factor,
                    alpha_mode,
                    alpha_cutoff,
                    double_sided,
                    unlit,
                    base_color_mode,
                    material_name,
                    material_role,
                    texture_override,
                });
            }
        }

        for (material_override, actual) in overrides.iter().zip(override_counts) {
            if let Some(expected) = material_override.expected_primitive_count
                && actual != expected
            {
                bail!(
                    "material override role {:?} expected {expected} primitive(s) in {}, found {actual}",
                    material_override.role,
                    path.display()
                );
            }
        }

        // --- animations -------------------------------------------------------
        let mut clips = Vec::new();
        for anim in doc.animations() {
            let mut channels = Vec::new();
            let mut duration = 0.0f32;
            for ch in anim.channels() {
                let reader = ch.reader(|b| buffers.get(b.index()).map(|d| d.0.as_slice()));
                let Some(times) = reader.read_inputs().map(|it| it.collect::<Vec<f32>>()) else {
                    continue;
                };
                if let Some(&last) = times.last() {
                    duration = duration.max(last);
                }
                let interpolation = match ch.sampler().interpolation() {
                    gltf::animation::Interpolation::Step => Interpolation::Step,
                    // Cubic spline collapses to linear over its key values.
                    _ => Interpolation::Linear,
                };
                let cubic =
                    ch.sampler().interpolation() == gltf::animation::Interpolation::CubicSpline;
                let (path, values) = match reader.read_outputs() {
                    Some(gltf::animation::util::ReadOutputs::Translations(it)) => {
                        (ChannelPath::Translation, flatten3(it.collect(), cubic))
                    }
                    Some(gltf::animation::util::ReadOutputs::Scales(it)) => {
                        (ChannelPath::Scale, flatten3(it.collect(), cubic))
                    }
                    Some(gltf::animation::util::ReadOutputs::Rotations(rot)) => (
                        ChannelPath::Rotation,
                        flatten4(rot.into_f32().collect(), cubic),
                    ),
                    _ => continue,
                };
                channels.push(Channel {
                    node: ch.target().node().index(),
                    path,
                    interpolation,
                    times,
                    values,
                });
            }
            clips.push(Clip {
                name: anim.name().unwrap_or("anim").to_string(),
                duration,
                channels,
            });
        }
        log::info!(
            "{}: {} verts, {} clips {:?}, {} skin(s), {} joints",
            path.display(),
            vertices.len(),
            clips.len(),
            clips.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            skins.len(),
            skins.iter().map(|s| s.joints.len()).sum::<usize>()
        );

        // --- upload ------------------------------------------------------------
        use wgpu::util::DeviceExt;
        let vbuf = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("model vbuf"),
                contents: bytemuck::cast_slice(&vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let ibuf = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("model ibuf"),
                contents: bytemuck::cast_slice(&indices),
                usage: wgpu::BufferUsages::INDEX,
            });

        let primitives = primitives_meta
            .into_iter()
            .map(|meta| {
                let (view, sampler) = match meta.texture_override {
                    Some(override_index) => {
                        let material_override = &overrides[override_index];
                        (material_override.texture_view, material_override.sampler)
                    }
                    None => (
                        meta.image
                            .and_then(|i| textures.get(i))
                            .map(|t| &t.view)
                            .unwrap_or(&white.view),
                        &samplers.aniso_repeat,
                    ),
                };
                let material = MaterialRaw {
                    base_color_factor: meta.base_color_factor,
                    params: [
                        meta.unlit as u8 as f32,
                        if meta.alpha_mode == MaterialAlphaMode::Mask {
                            meta.alpha_cutoff
                        } else {
                            0.0
                        },
                        meta.double_sided as u8 as f32,
                        (meta.alpha_mode == MaterialAlphaMode::Blend) as u8 as f32,
                    ],
                    style: [
                        (meta.base_color_mode == MaterialBaseColorMode::Monochrome) as u8 as f32,
                        0.0,
                        0.0,
                        0.0,
                    ],
                };
                let label = meta.material_name.as_deref().unwrap_or("model material");
                let (bind_group, material_buf) =
                    make_material_bind_group(gpu, layout, label, view, sampler, &material);
                Primitive {
                    first_index: meta.first_index,
                    index_count: meta.index_count,
                    bind_group,
                    alpha_mode: meta.alpha_mode,
                    alpha_cutoff: meta.alpha_cutoff,
                    double_sided: meta.double_sided,
                    unlit: meta.unlit,
                    base_color_mode: meta.base_color_mode,
                    material_name: meta.material_name,
                    material_role: meta.material_role,
                    material_buf,
                }
            })
            .collect();

        textures.push(white);
        Ok(Arc::new(Self {
            vbuf,
            ibuf,
            primitives,
            skeleton,
            node_names,
            skins,
            clips,
            morph_meshes,
            prim_morph,
            aabb,
            textures,
        }))
    }
}

fn find_node_named(node_names: &[Option<String>], name: &str) -> Option<usize> {
    node_names
        .iter()
        .position(|candidate| candidate.as_deref() == Some(name))
}

fn sample_node_transform(
    skeleton: &Skeleton,
    clips: &[Clip],
    node: usize,
    anim: &AnimState,
) -> Option<Mat4> {
    if node >= skeleton.rest.len() {
        return None;
    }
    let mut globals = Vec::new();
    skeleton.global_transforms(clips.get(anim.clip), anim.time, anim.looping, &mut globals);
    globals.get(node).copied()
}

fn flatten3(v: Vec<[f32; 3]>, cubic: bool) -> Vec<f32> {
    strip_cubic(v, cubic)
        .into_iter()
        .flat_map(|a| a.into_iter())
        .collect()
}

fn flatten4(v: Vec<[f32; 4]>, cubic: bool) -> Vec<f32> {
    strip_cubic(v, cubic)
        .into_iter()
        .flat_map(|a| a.into_iter())
        .collect()
}

/// Cubic-spline outputs store [in-tangent, value, out-tangent] per key;
/// keep just the values.
fn strip_cubic<T: Copy>(v: Vec<T>, cubic: bool) -> Vec<T> {
    if !cubic {
        return v;
    }
    v.as_chunks::<3>().0.iter().map(|c| c[1]).collect()
}

/// Box-filter 2×2 downsample (straight alpha; fine for albedo maps).
fn downsample_rgba(px: &[u8], w: u32, h: u32) -> Vec<u8> {
    let (nw, nh) = (w / 2, h / 2);
    let mut out = Vec::with_capacity((nw * nh * 4) as usize);
    for y in 0..nh {
        for x in 0..nw {
            let mut acc = [0u32; 4];
            for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                let src = (((y * 2 + dy) * w + x * 2 + dx) * 4) as usize;
                for c in 0..4 {
                    acc[c] += px[src + c] as u32;
                }
            }
            out.extend(acc.map(|v| (v / 4) as u8));
        }
    }
    out
}

fn to_rgba8(img: &gltf::image::Data) -> Vec<u8> {
    use gltf::image::Format;
    let n = (img.width * img.height) as usize;
    match img.format {
        Format::R8G8B8A8 => img.pixels.clone(),
        Format::R8G8B8 => {
            let mut out = Vec::with_capacity(n * 4);
            for c in img.pixels.as_chunks::<3>().0 {
                out.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
            out
        }
        Format::R8 => {
            let mut out = Vec::with_capacity(n * 4);
            for &g in &img.pixels {
                out.extend_from_slice(&[g, g, g, 255]);
            }
            out
        }
        Format::R8G8 => {
            let mut out = Vec::with_capacity(n * 4);
            for c in img.pixels.as_chunks::<2>().0 {
                // PNG's two-channel color type is grayscale + alpha. The
                // glTF importer exposes that decoded storage as R8G8, so a
                // base-color texture must replicate luminance into RGB and
                // retain the second channel as alpha. Treating the channels
                // as red + green turns white decals neon green and opaque.
                out.extend_from_slice(&[c[0], c[0], c[0], c[1]]);
            }
            out
        }
        // 16-bit and float formats: take the high byte / clamp.
        _ => {
            log::warn!("unsupported glTF image format {:?}; using grey", img.format);
            vec![128; n * 4]
        }
    }
}

/// A model placed in the scene.
pub struct ModelInstance {
    pub asset: Arc<ModelAsset>,
    pub transform: Mat4,
    /// Color multiplier. Alpha below one selects depth-tested blending,
    /// including for authored opaque materials; the instance does not write depth.
    pub tint: [f32; 4],
    pub anim: AnimState,
    /// 0..1 how strongly lighting applies (1 = fully lit by sun/ambient).
    pub lit: f32,
    /// Explicit node globals (from `Skeleton::globals_from_locals`) override
    /// `anim` when set — for procedurally posed characters.
    pub pose: Option<Vec<Mat4>>,
    /// Morph weights + overlay buffer; create via `asset.create_morph_state`.
    pub morph: Option<MorphState>,
    /// Alpha-test threshold for this instance's primitives (0 = off).
    /// Anime-style characters use cutout textures for hair/lashes.
    pub cutout: f32,
}

impl ModelInstance {
    pub fn new(asset: Arc<ModelAsset>) -> Self {
        Self {
            asset,
            transform: Mat4::IDENTITY,
            tint: [1.0; 4],
            anim: AnimState::default(),
            lit: 1.0,
            pose: None,
            morph: None,
            cutout: 0.0,
        }
    }
}

type ImportedGltf = (
    gltf::Document,
    Vec<gltf::buffer::Data>,
    Vec<gltf::image::Data>,
);

fn import_glb_slice(bytes: &[u8], label: &str) -> Result<ImportedGltf> {
    gltf::import_slice(bytes).with_context(|| format!("importing embedded GLB {label}"))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use glam::{Quat, Vec3};

    use crate::anim::{AnimState, Channel, ChannelPath, Clip, Interpolation, NodeTrs, Skeleton};

    use super::{
        MaterialBaseColorMode, MaterialRaw, ModelTextureCacheKey, find_node_named,
        import_glb_slice, pocket3d_base_color_mode_from_extras, pocket3d_role_from_extras,
        sample_node_transform, semantic_material_matches, to_rgba8, validate_normalized_texcoord0,
    };

    fn minimal_glb() -> Vec<u8> {
        let mut json = br#"{"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[]}]}"#.to_vec();
        while !json.len().is_multiple_of(4) {
            json.push(b' ');
        }
        let total_len = 12 + 8 + json.len();
        let mut glb = Vec::with_capacity(total_len);
        glb.extend_from_slice(b"glTF");
        glb.extend_from_slice(&2u32.to_le_bytes());
        glb.extend_from_slice(&(total_len as u32).to_le_bytes());
        glb.extend_from_slice(&(json.len() as u32).to_le_bytes());
        glb.extend_from_slice(b"JSON");
        glb.extend_from_slice(&json);
        glb
    }

    #[test]
    fn embedded_glb_imports_from_memory() {
        let (doc, buffers, images) = import_glb_slice(&minimal_glb(), "embedded-test.glb").unwrap();
        assert_eq!(doc.scenes().count(), 1);
        assert!(buffers.is_empty());
        assert!(images.is_empty());
    }

    #[test]
    fn embedded_glb_error_includes_label() {
        let err = import_glb_slice(b"not a glb", "player.glb").unwrap_err();
        assert!(format!("{err:#}").contains("player.glb"));
    }

    #[test]
    fn named_node_lookup_returns_first_duplicate_in_index_order() {
        let names = vec![
            Some("root".to_owned()),
            Some("hand.R".to_owned()),
            None,
            Some("hand.R".to_owned()),
        ];
        assert_eq!(find_node_named(&names, "root"), Some(0));
        assert_eq!(find_node_named(&names, "hand.R"), Some(1));
        assert_eq!(find_node_named(&names, "missing"), None);
        assert_eq!(find_node_named(&[], "root"), None);
    }

    #[test]
    fn sampled_node_transform_accumulates_animated_ancestors() {
        let skeleton = Skeleton {
            parents: vec![usize::MAX, 0, 1],
            rest: vec![
                NodeTrs {
                    translation: Vec3::X,
                    rotation: Quat::IDENTITY,
                    scale: Vec3::ONE,
                },
                NodeTrs {
                    translation: Vec3::Y * 2.0,
                    rotation: Quat::IDENTITY,
                    scale: Vec3::ONE,
                },
                NodeTrs {
                    translation: Vec3::Z * 3.0,
                    rotation: Quat::IDENTITY,
                    scale: Vec3::ONE,
                },
            ],
            order: vec![0, 1, 2],
        };
        let clips = vec![Clip {
            name: "Reach".to_owned(),
            duration: 1.0,
            channels: vec![Channel {
                node: 1,
                path: ChannelPath::Translation,
                interpolation: Interpolation::Linear,
                times: vec![0.0, 1.0],
                values: vec![0.0, 2.0, 0.0, 0.0, 4.0, 0.0],
            }],
        }];
        let anim = AnimState {
            clip: 0,
            time: 0.5,
            speed: 1.0,
            looping: false,
        };

        let socket = sample_node_transform(&skeleton, &clips, 2, &anim).unwrap();
        let translation = socket.transform_point3(Vec3::ZERO);
        assert!(translation.distance(Vec3::new(1.0, 3.0, 3.0)) < 1e-6);
        assert!(sample_node_transform(&skeleton, &clips, 3, &anim).is_none());
        assert!(sample_node_transform(&skeleton, &clips, usize::MAX, &anim).is_none());
    }

    #[test]
    fn material_role_reads_pocket3d_extras() {
        assert_eq!(
            pocket3d_role_from_extras(r#"{"pocket3d_role":"dynamic_screen","unrelated":true}"#)
                .as_deref(),
            Some("dynamic_screen")
        );
        assert_eq!(pocket3d_role_from_extras("{}"), None);
        assert_eq!(pocket3d_role_from_extras("not json"), None);
    }

    #[test]
    fn explicit_role_wins_over_name_prefix_fallback() {
        assert!(semantic_material_matches(
            Some("dynamic_screen"),
            Some("anything"),
            "dynamic_screen",
            Some("P3D_dynamic_screen__"),
        ));
        assert!(semantic_material_matches(
            None,
            Some("P3D_dynamic_screen__panel"),
            "dynamic_screen",
            Some("P3D_dynamic_screen__"),
        ));
        assert!(!semantic_material_matches(
            Some("different_role"),
            Some("P3D_dynamic_screen__panel"),
            "dynamic_screen",
            Some("P3D_dynamic_screen__"),
        ));
    }

    #[test]
    fn material_uniform_has_portable_uniform_alignment() {
        assert_eq!(std::mem::size_of::<MaterialRaw>(), 48);
        assert_eq!(std::mem::align_of::<MaterialRaw>(), 4);
    }

    #[test]
    fn material_base_color_mode_reads_pocket3d_extras() {
        assert_eq!(
            pocket3d_base_color_mode_from_extras(r#"{"pocket3d_base_color_mode":"monochrome"}"#,),
            MaterialBaseColorMode::Monochrome
        );
        assert_eq!(
            pocket3d_base_color_mode_from_extras(r#"{"pocket3d_base_color_mode":"unknown"}"#),
            MaterialBaseColorMode::Authored
        );
        assert_eq!(
            pocket3d_base_color_mode_from_extras("not json"),
            MaterialBaseColorMode::Authored
        );
    }

    #[test]
    fn texture_cache_key_uses_exact_pixels_and_dimensions() {
        let key = |width, height, rgba: &[u8]| ModelTextureCacheKey {
            width,
            height,
            rgba: rgba.into(),
        };
        let reference = key(2, 1, &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert!(reference == key(2, 1, &[1, 2, 3, 4, 5, 6, 7, 8]));
        assert!(reference != key(1, 2, &[1, 2, 3, 4, 5, 6, 7, 8]));
        assert!(reference != key(2, 1, &[1, 2, 3, 4, 5, 6, 7, 9]));
    }

    #[test]
    fn gray_alpha_base_color_expands_to_rgba() {
        let image = gltf::image::Data {
            pixels: vec![32, 0, 180, 255],
            format: gltf::image::Format::R8G8,
            width: 2,
            height: 1,
        };
        assert_eq!(to_rgba8(&image), vec![32, 32, 32, 0, 180, 180, 180, 255]);
    }

    #[test]
    fn live_surface_texcoord_validation_accepts_normalized_full_span() {
        let texcoords = [[-0.005, 0.0], [1.005, 0.0], [1.0, 1.0], [0.0, 1.0]];
        validate_normalized_texcoord0(
            Some(&texcoords),
            texcoords.len(),
            Some("screen"),
            Path::new("device.glb"),
        )
        .unwrap();
    }

    #[test]
    fn live_surface_texcoord_validation_rejects_missing_or_invalid_uvs() {
        let path = Path::new("device.glb");
        assert!(validate_normalized_texcoord0(None, 4, Some("screen"), path).is_err());
        assert!(
            validate_normalized_texcoord0(
                Some(&[[0.0, 0.0], [f32::NAN, 1.0]]),
                2,
                Some("screen"),
                path,
            )
            .is_err()
        );
        assert!(
            validate_normalized_texcoord0(
                Some(&[[0.0, 0.0], [1.1, 1.0]]),
                2,
                Some("screen"),
                path,
            )
            .is_err()
        );
        assert!(
            validate_normalized_texcoord0(
                Some(&[[0.1, 0.1], [0.2, 0.2]]),
                2,
                Some("screen"),
                path,
            )
            .is_err()
        );
    }
}
