//! The authored-scene renderer: a `.p3sn` drawn with vita2d's stock shader
//! binaries.
//!
//! Three passes reconstruct per-pixel aerial perspective without a shader of
//! this backend's own:
//!
//! | Pass | Program | Blend | Result |
//! | --- | --- | --- | --- |
//! | albedo | texture | none | `albedo` |
//! | light | colour at offset 8 | `dst * src` | `albedo x lit` |
//! | fog | colour at offset 12 | `src * srcAlpha + dst` | `albedo x lit + fog x coverage` |
//!
//! `lit` already carries `(1 - coverage)`, so the three passes evaluate the
//! same lerp a fragment shader would. The fog pass is skipped for any chunk
//! the cooker measured as effectively clear, which removes it entirely from
//! the near half of a scene.
//!
//! Alpha-blended cutouts take a single pass instead: texture times one flat
//! tint per chunk, derived from the chunk's own baked vertices at load, drawn
//! back to front against a depth test that does not write.

use glam::{Mat4, Vec3};
#[cfg(target_os = "vita")]
use pocket3d_scene::cull::ChunkVisibility;
use pocket3d_scene::cull::{Frustum, VisibleSet};
use pocket3d_scene::format::{MaterialKind, Scene, VERTEX_STRIDE};

use crate::camera::Camera3d;

#[cfg(target_os = "vita")]
use crate::gxm::{self, CullMode, DepthMode, MipTexture, ScenePass};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SceneStats {
    pub chunks_drawn: u32,
    pub triangles: u32,
    /// Triangle submissions across every pass; a fogged opaque chunk counts
    /// three times.
    pub submissions: u32,
    pub draw_calls: u32,
    pub textures_resident: u32,
    pub submission_errors: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SceneUploadError {
    OutOfMemory,
    Texture(usize),
    NoPipeline,
}

/// A resident scene: geometry in one GPU slab, one texture per material.
pub struct SceneRenderer<'a> {
    scene: Scene<'a>,
    #[cfg(target_os = "vita")]
    geometry: Option<gxm::GpuSlab>,
    #[cfg(target_os = "vita")]
    textures: Vec<Option<MipTexture>>,
    /// Flat tint for each cutout chunk, resolved from its baked vertices.
    cutout_tints: Vec<[f32; 4]>,
    index_slab_offset: usize,
    visible: VisibleSet,
    upload_error: Option<SceneUploadError>,
    pub stats: SceneStats,
}

impl<'a> SceneRenderer<'a> {
    pub fn new(scene: Scene<'a>) -> Self {
        let cutout_tints = resolve_cutout_tints(&scene);
        let index_slab_offset = scene.vertices.len().next_multiple_of(16);
        Self {
            scene,
            #[cfg(target_os = "vita")]
            geometry: None,
            #[cfg(target_os = "vita")]
            textures: Vec::new(),
            cutout_tints,
            index_slab_offset,
            visible: VisibleSet::new(),
            upload_error: None,
            stats: SceneStats::default(),
        }
    }

    pub fn scene(&self) -> &Scene<'a> {
        &self.scene
    }

    pub fn upload_error(&self) -> Option<SceneUploadError> {
        self.upload_error
    }

    /// Move geometry and textures onto the GPU. Idempotent.
    ///
    /// # Safety
    ///
    /// Render-thread only, after vita2d initialization and outside an open
    /// scene.
    #[cfg(target_os = "vita")]
    pub unsafe fn upload(&mut self) -> Result<(), SceneUploadError> {
        if gxm::pipeline().is_err() {
            self.upload_error = Some(SceneUploadError::NoPipeline);
            return Err(SceneUploadError::NoPipeline);
        }
        if self.geometry.is_none() {
            let total = self.index_slab_offset + self.scene.indices.len();
            let slab = gxm::GpuSlab::alloc(total).map_err(|_| {
                self.upload_error = Some(SceneUploadError::OutOfMemory);
                SceneUploadError::OutOfMemory
            })?;
            let base = slab.as_ptr();
            core::ptr::copy_nonoverlapping(
                self.scene.vertices.as_ptr(),
                base,
                self.scene.vertices.len(),
            );
            core::ptr::copy_nonoverlapping(
                self.scene.indices.as_ptr(),
                base.add(self.index_slab_offset),
                self.scene.indices.len(),
            );
            self.geometry = Some(slab);
        }
        if self.textures.len() != self.scene.textures.len() {
            self.textures.clear();
            self.textures
                .resize_with(self.scene.textures.len(), || None);
        }
        for (index, texture) in self.scene.textures.iter().enumerate() {
            if self.textures[index].is_some() {
                continue;
            }
            if texture.width != texture.height {
                self.upload_error = Some(SceneUploadError::Texture(index));
                return Err(SceneUploadError::Texture(index));
            }
            let mut resident =
                MipTexture::upload(texture.width as u32, texture.levels, texture.data).map_err(
                    |_| {
                        self.upload_error = Some(SceneUploadError::Texture(index));
                        SceneUploadError::Texture(index)
                    },
                )?;
            resident.set_repeat(true);
            self.textures[index] = Some(resident);
        }
        self.stats.textures_resident = self.textures.iter().filter(|slot| slot.is_some()).count()
            as u32;
        Ok(())
    }

    #[cfg(not(target_os = "vita"))]
    pub unsafe fn upload(&mut self) -> Result<(), SceneUploadError> {
        Ok(())
    }

    /// Select the visible chunks for this frame. Separated from submission so
    /// a caller can read [`Self::visible_stats`] before drawing.
    pub fn cull(&mut self, camera: &Camera3d) {
        let view_proj = camera.view_proj();
        let frustum = Frustum::from_view_proj(view_proj);
        self.visible.gather(&self.scene, &frustum, camera.pos);
        self.stats.chunks_drawn = self.visible.stats.chunks_drawn;
        self.stats.triangles = self.visible.stats.triangles;
    }

    pub fn visible_stats(&self) -> pocket3d_scene::cull::CullStats {
        self.visible.stats
    }

    /// Submit every visible chunk.
    ///
    /// # Safety
    ///
    /// Render-thread only, inside a `pocket3d_vita` pass opened by
    /// [`crate::begin_3d`].
    #[cfg(target_os = "vita")]
    pub unsafe fn draw(&mut self, camera: &Camera3d) {
        self.cull(camera);
        let Ok(pipeline) = gxm::pipeline() else {
            self.stats.submission_errors += 1;
            return;
        };
        // Split the borrow so each pass can read the scene while it writes stats.
        let Self {
            scene,
            geometry,
            textures,
            cutout_tints,
            index_slab_offset,
            visible,
            stats,
            ..
        } = self;
        let Some(geometry) = geometry.as_ref() else {
            stats.submission_errors += 1;
            return;
        };
        let view_proj = camera.view_proj();
        let vertices = geometry.as_ptr();
        let indices = vertices.add(*index_slab_offset).cast::<u16>();
        let context = PassContext {
            pipeline,
            scene,
            textures,
            cutout_tints,
            vertices,
            indices,
            view_proj,
        };

        gxm::set_cull(CullMode::Back);
        gxm::set_depth(DepthMode::Opaque);
        submit_pass(&context, ScenePass::Albedo, &visible.opaque, stats);
        gxm::set_depth(DepthMode::TestOnly);
        submit_pass(&context, ScenePass::Light, &visible.opaque, stats);
        submit_pass(&context, ScenePass::Fog, &visible.opaque, stats);

        // Foliage cards are single-sided geometry seen from both sides.
        gxm::set_cull(CullMode::None);
        submit_pass(&context, ScenePass::Cutout, &visible.translucent, stats);
        gxm::set_cull(CullMode::Back);
    }

    #[cfg(not(target_os = "vita"))]
    pub unsafe fn draw(&mut self, camera: &Camera3d) {
        self.cull(camera);
    }

    /// Submit a named object's chunks under a runtime transform.
    ///
    /// The object's baked light travels with it; its fog was baked for the
    /// camera path, so an object is expected to stay near that path.
    ///
    /// # Safety
    ///
    /// Same contract as [`Self::draw`].
    #[cfg(target_os = "vita")]
    pub unsafe fn draw_object(&mut self, name: &str, model: Mat4, camera: &Camera3d) {
        let Some(object) = self.scene.object(name).copied() else {
            return;
        };
        let Ok(pipeline) = gxm::pipeline() else {
            self.stats.submission_errors += 1;
            return;
        };
        let Self {
            scene,
            geometry,
            textures,
            cutout_tints,
            index_slab_offset,
            stats,
            ..
        } = self;
        let Some(geometry) = geometry.as_ref() else {
            stats.submission_errors += 1;
            return;
        };
        let vertices = geometry.as_ptr();
        let indices = vertices.add(*index_slab_offset).cast::<u16>();
        let context = PassContext {
            pipeline,
            scene,
            textures,
            cutout_tints,
            vertices,
            indices,
            view_proj: camera.view_proj() * model,
        };
        let first = object.first_chunk as usize;
        let entries: Vec<ChunkVisibility> = (first
            ..first + object.chunk_count as usize)
            .filter(|index| *index < scene.chunks.len())
            .map(|index| ChunkVisibility {
                chunk: index as u16,
                depth: 0.0,
            })
            .collect();

        gxm::set_depth(DepthMode::Opaque);
        submit_pass(&context, ScenePass::Albedo, &entries, stats);
        gxm::set_depth(DepthMode::TestOnly);
        submit_pass(&context, ScenePass::Light, &entries, stats);
    }

    #[cfg(not(target_os = "vita"))]
    pub unsafe fn draw_object(&mut self, _name: &str, _model: Mat4, _camera: &Camera3d) {}

    pub fn reset_stats(&mut self) {
        self.stats = SceneStats {
            textures_resident: self.stats.textures_resident,
            ..SceneStats::default()
        };
    }

    /// Release GPU resources.
    ///
    /// # Safety
    ///
    /// No queued or in-flight GXM work may reference this scene.
    #[cfg(target_os = "vita")]
    pub unsafe fn release(&mut self) {
        for texture in self.textures.drain(..).flatten() {
            texture.free();
        }
        if let Some(geometry) = self.geometry.take() {
            geometry.free();
        }
    }
}

/// Everything one pass reads, gathered so the submission loop borrows the
/// renderer's fields disjointly from the statistics it writes.
#[cfg(target_os = "vita")]
struct PassContext<'ctx, 'scene> {
    pipeline: &'ctx gxm::Pipeline,
    scene: &'ctx Scene<'scene>,
    textures: &'ctx [Option<MipTexture>],
    cutout_tints: &'ctx [[f32; 4]],
    vertices: *mut u8,
    indices: *const u16,
    view_proj: Mat4,
}

/// Submit one pass over an ordered chunk list.
///
/// Program binding is deferred until the first chunk that actually survives
/// the pass's own filter, so a scene with no fogged chunk in view never binds
/// the fog programs at all.
///
/// # Safety
///
/// Render-thread only, inside an active pass, with `vertices` and `indices`
/// pointing into a live GPU allocation for this scene.
#[cfg(target_os = "vita")]
unsafe fn submit_pass(
    context: &PassContext<'_, '_>,
    pass: ScenePass,
    entries: &[ChunkVisibility],
    stats: &mut SceneStats,
) {
    let pipeline = context.pipeline;
    let mut bound = false;
    for entry in entries {
        let Some(&chunk) = context.scene.chunks.get(entry.chunk as usize) else {
            continue;
        };
        if pass == ScenePass::Fog && !chunk.is_fogged() {
            continue;
        }
        let material = context.scene.materials[chunk.material as usize];
        let textured = matches!(pass, ScenePass::Albedo | ScenePass::Cutout);
        let texture = if material.texture == u16::MAX {
            None
        } else {
            context
                .textures
                .get(material.texture as usize)
                .and_then(|slot| slot.as_ref())
        };
        if textured && texture.is_none() {
            continue;
        }
        if !bound {
            pipeline.bind_scene(pass);
            bound = true;
        }
        let wvp = (context.view_proj * chunk.dequantize()).to_cols_array();
        if !pipeline.set_scene_transform(pass, &wvp) {
            stats.submission_errors += 1;
            continue;
        }
        if textured {
            let texture = texture.expect("checked above");
            if !pipeline.set_texture(texture.handle()) {
                stats.submission_errors += 1;
                continue;
            }
        }
        if pass == ScenePass::Cutout {
            let tint = context
                .cutout_tints
                .get(entry.chunk as usize)
                .copied()
                .unwrap_or([1.0; 4]);
            if !pipeline.set_tint(tint) {
                stats.submission_errors += 1;
                continue;
            }
        }
        let stream = context
            .vertices
            .add(chunk.vertex_base as usize * VERTEX_STRIDE)
            .cast();
        if pipeline.set_stream(stream)
            && pipeline.draw_indexed(context.indices.add(chunk.index_base as usize), chunk.index_count)
        {
            stats.draw_calls += 1;
            stats.submissions += chunk.index_count / 3;
        } else {
            stats.submission_errors += 1;
        }
    }
}

/// Average the baked colours of a cutout chunk into the flat tint its single
/// alpha-blended pass multiplies the texture by.
///
/// The composite `lit + fog.rgb * fog.a` is what the three opaque passes would
/// have produced, so a card drawn this way sits in the same aerial perspective
/// as the terrain behind it.
fn resolve_cutout_tints(scene: &Scene<'_>) -> Vec<[f32; 4]> {
    let mut tints = vec![[1.0f32, 1.0, 1.0, 1.0]; scene.chunks.len()];
    let vertex_count = scene.vertices.len() / VERTEX_STRIDE;
    for (index, chunk) in scene.chunks.iter().enumerate() {
        if scene.materials[chunk.material as usize].kind != MaterialKind::Cutout {
            continue;
        }
        let start = chunk.vertex_base as usize;
        let end = scene
            .chunks
            .get(index + 1)
            .map(|next| next.vertex_base as usize)
            .unwrap_or(vertex_count)
            .min(vertex_count);
        if end <= start {
            continue;
        }
        let mut total = Vec3::ZERO;
        let mut samples = 0.0f32;
        // Sixteen samples are enough for a flat tint and keep load bounded.
        let step = ((end - start) / 16).max(1);
        for vertex in (start..end).step_by(step) {
            let base = vertex * VERTEX_STRIDE;
            let lit = read_abgr(scene.vertices, base + pocket3d_scene::format::VERTEX_LIT_OFFSET);
            let fog = read_abgr(scene.vertices, base + pocket3d_scene::format::VERTEX_FOG_OFFSET);
            total += Vec3::new(lit[0], lit[1], lit[2]) + Vec3::new(fog[0], fog[1], fog[2]) * fog[3];
            samples += 1.0;
        }
        if samples > 0.0 {
            let average = (total / samples).min(Vec3::ONE);
            tints[index] = [average.x, average.y, average.z, 1.0];
        }
    }
    tints
}

fn read_abgr(bytes: &[u8], offset: usize) -> [f32; 4] {
    [
        bytes[offset] as f32 / 255.0,
        bytes[offset + 1] as f32 / 255.0,
        bytes[offset + 2] as f32 / 255.0,
        bytes[offset + 3] as f32 / 255.0,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocket3d_scene::build::{Mesh, SceneBuilder};
    use pocket3d_scene::format::Material;
    use pocket3d_scene::light::BakedVertexColor;

    fn scene_bytes() -> Vec<u8> {
        let mut builder = SceneBuilder::new();
        builder.header.lod_distances = [100.0, 400.0, 2000.0];
        builder
            .add_texture("flat", 2, 2, &[255u8; 16], false)
            .unwrap();
        let opaque = builder.add_material(Material {
            texture: 0,
            kind: MaterialKind::Opaque,
            flags: 0,
            tint: [255; 4],
            sort_bias: 0.0,
        });
        let cutout = builder.add_material(Material {
            texture: 0,
            kind: MaterialKind::Cutout,
            flags: 0,
            tint: [255; 4],
            sort_bias: 0.0,
        });
        let mut ground = Mesh::new();
        let color = BakedVertexColor {
            lit: 0xffff_ffff,
            fog: 0x0000_0000,
        };
        let a = ground.push_vertex(Vec3::new(-10.0, 0.0, -10.0), [0.0, 0.0], color);
        let b = ground.push_vertex(Vec3::new(10.0, 0.0, -10.0), [1.0, 0.0], color);
        let c = ground.push_vertex(Vec3::new(10.0, 0.0, 10.0), [1.0, 1.0], color);
        let d = ground.push_vertex(Vec3::new(-10.0, 0.0, 10.0), [0.0, 1.0], color);
        ground.push_quad(a, b, c, d);
        builder.add_mesh(&ground, opaque, 0xff, 0).unwrap();

        let mut card = Mesh::new();
        // Half brightness with a quarter of mid-grey fog over it.
        let shaded = BakedVertexColor {
            lit: 0xff80_8080,
            fog: 0x4040_4040,
        };
        let a = card.push_vertex(Vec3::new(-1.0, 0.0, -30.0), [0.0, 1.0], shaded);
        let b = card.push_vertex(Vec3::new(1.0, 0.0, -30.0), [1.0, 1.0], shaded);
        let c = card.push_vertex(Vec3::new(1.0, 2.0, -30.0), [1.0, 0.0], shaded);
        let d = card.push_vertex(Vec3::new(-1.0, 2.0, -30.0), [0.0, 0.0], shaded);
        card.push_quad(a, b, c, d);
        builder.add_mesh(&card, cutout, 0xff, 0).unwrap();
        builder.finish().unwrap()
    }

    #[test]
    fn culling_keeps_what_is_in_front_and_drops_what_is_behind() {
        let bytes = scene_bytes();
        let scene = Scene::parse(&bytes).unwrap();
        let mut renderer = SceneRenderer::new(scene);
        let mut camera = Camera3d::default();
        camera.pos = Vec3::new(0.0, 2.0, 20.0);
        renderer.cull(&camera);
        assert_eq!(renderer.visible_stats().chunks_drawn, 2);

        camera.yaw = core::f32::consts::PI;
        renderer.cull(&camera);
        assert_eq!(renderer.visible_stats().chunks_drawn, 0);
        assert!(renderer.visible_stats().culled_frustum >= 1);
    }

    #[test]
    fn a_cutout_tint_composites_its_baked_light_and_fog() {
        let bytes = scene_bytes();
        let scene = Scene::parse(&bytes).unwrap();
        let renderer = SceneRenderer::new(scene);
        let tint = renderer.cutout_tints[1];
        // lit 0x80 = 0.502, fog 0x40 = 0.251 at coverage 0.251.
        let expected = 128.0 / 255.0 + (64.0 / 255.0) * (64.0 / 255.0);
        assert!((tint[0] - expected).abs() < 0.01, "{tint:?}");
        assert_eq!(tint[3], 1.0);
        // The opaque chunk keeps the neutral tint it never uses.
        assert_eq!(renderer.cutout_tints[0], [1.0, 1.0, 1.0, 1.0]);
    }

    #[test]
    fn translucent_chunks_sort_behind_opaque_ones_into_their_own_list() {
        let bytes = scene_bytes();
        let scene = Scene::parse(&bytes).unwrap();
        let mut renderer = SceneRenderer::new(scene);
        let mut camera = Camera3d::default();
        camera.pos = Vec3::new(0.0, 2.0, 20.0);
        renderer.cull(&camera);
        assert_eq!(renderer.visible.opaque.len(), 1);
        assert_eq!(renderer.visible.translucent.len(), 1);
    }
}
