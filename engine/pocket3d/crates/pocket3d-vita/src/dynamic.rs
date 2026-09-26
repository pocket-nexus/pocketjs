//! Drawing the runtime surfaces: water, sky dome, clouds, wake and particles.
//!
//! `pocket3d_scene` rebuilds these every frame as a
//! [`DynamicMesh`](pocket3d_scene::runtime::DynamicMesh); this uploads one into
//! vita2d's per-frame GPU pool and submits it.
//!
//! Opaque surfaces take the full three passes, so the river carries per-vertex
//! reflection, glitter and aerial perspective exactly as the cooker resolved
//! it. Blended surfaces take a single pass, because a multiply pass over an
//! already-blended tile would be wrong: `texture_tint_f` gives them one flat
//! colour per batch instead, which the caller resolves on the CPU. That is the
//! real limit of drawing without a shader of one's own, and it lands where it
//! costs least — on particles and cloud, which are small or uniform anyway.

use pocket3d_scene::runtime::DynamicMesh;

#[cfg(target_os = "vita")]
use crate::gxm::{self, CullMode, DepthMode, ScenePass};
use crate::scene::SceneStats;

/// How a runtime surface combines with the scene already in the tile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceKind {
    /// Depth-written, three passes, per-vertex light and fog.
    Opaque,
    /// Drawn over everything behind it with no depth interaction: the sky.
    Background,
    /// Alpha-blended against one flat tint, depth-tested, no depth write.
    Alpha,
    /// Additive against one flat tint, depth-tested, no depth write.
    Additive,
}

/// Staging buffers retained across frames so a steady-state frame allocates
/// nothing on the CPU side either.
#[derive(Default)]
pub struct DynamicSurface {
    vertices: Vec<u8>,
    indices: Vec<u8>,
}

impl DynamicSurface {
    pub const fn new() -> Self {
        Self {
            vertices: Vec::new(),
            indices: Vec::new(),
        }
    }

    /// Submit `mesh`.
    ///
    /// `tint` is the flat colour the blended kinds multiply their texture by;
    /// [`SurfaceKind::Opaque`] and [`SurfaceKind::Background`] ignore it.
    ///
    /// # Safety
    ///
    /// Render-thread only, inside a `pocket3d_vita` pass, with `texture` a
    /// live vita2d texture or null.
    #[cfg(target_os = "vita")]
    pub unsafe fn draw(
        &mut self,
        mesh: &DynamicMesh,
        kind: SurfaceKind,
        texture: *const vita2d_sys::vita2d_texture,
        tint: [f32; 4],
        view_proj: &[f32; 16],
        stats: &mut SceneStats,
    ) {
        if mesh.is_empty() {
            return;
        }
        let Ok(pipeline) = gxm::pipeline() else {
            stats.submission_errors += 1;
            return;
        };
        mesh.write_vertex_bytes(&mut self.vertices);
        mesh.write_index_bytes(&mut self.indices);

        let vertex_bytes = vita2d_sys::vita2d_pool_memalign(self.vertices.len() as u32, 8);
        let index_bytes = vita2d_sys::vita2d_pool_memalign(self.indices.len() as u32, 4);
        if vertex_bytes.is_null() || index_bytes.is_null() {
            stats.dropped_triangles += mesh.triangle_count() as u32;
            stats.submission_errors += 1;
            return;
        }
        core::ptr::copy_nonoverlapping(
            self.vertices.as_ptr(),
            vertex_bytes.cast::<u8>(),
            self.vertices.len(),
        );
        core::ptr::copy_nonoverlapping(
            self.indices.as_ptr(),
            index_bytes.cast::<u8>(),
            self.indices.len(),
        );
        let indices = index_bytes.cast::<u16>();
        let index_count = mesh.indices.len() as u32;

        let mut submit = |pass: ScenePass, needs_texture: bool, needs_tint: bool| {
            if !pipeline.bind_dynamic_scene(pass) {
                stats.submission_errors += 1;
                return;
            }
            if !pipeline.set_scene_transform(pass, view_proj) {
                stats.submission_errors += 1;
                return;
            }
            if needs_texture && !texture.is_null() && !pipeline.set_texture(texture) {
                stats.submission_errors += 1;
                return;
            }
            if needs_tint && !pipeline.set_tint(tint) {
                stats.submission_errors += 1;
                return;
            }
            if pipeline.set_stream(vertex_bytes) && pipeline.draw_indexed(indices, index_count) {
                stats.draw_calls += 1;
                stats.submissions += index_count / 3;
            } else {
                stats.submission_errors += 1;
            }
        };

        match kind {
            SurfaceKind::Opaque => {
                gxm::set_depth(DepthMode::Opaque);
                if texture.is_null() {
                    submit(ScenePass::Emissive, false, false);
                } else {
                    submit(ScenePass::Albedo, true, false);
                    gxm::set_depth(DepthMode::TestOnly);
                    submit(ScenePass::Light, false, false);
                }
                submit(ScenePass::Fog, false, false);
            }
            SurfaceKind::Background => {
                // The dome is behind everything and writes no depth, so the
                // world drawn after it covers it without a test of its own.
                gxm::set_depth(DepthMode::Overlay);
                gxm::set_cull(CullMode::None);
                submit(ScenePass::Emissive, false, false);
                gxm::set_cull(CullMode::Back);
                gxm::set_depth(DepthMode::Opaque);
            }
            SurfaceKind::Alpha => {
                gxm::set_depth(DepthMode::TestOnly);
                gxm::set_cull(CullMode::None);
                submit(ScenePass::Cutout, true, true);
                gxm::set_cull(CullMode::Back);
            }
            SurfaceKind::Additive => {
                gxm::set_depth(DepthMode::TestOnly);
                gxm::set_cull(CullMode::None);
                submit(ScenePass::Glow, true, true);
                gxm::set_cull(CullMode::Back);
            }
        }
        stats.triangles += mesh.triangle_count() as u32;
    }

    #[cfg(not(target_os = "vita"))]
    pub unsafe fn draw(
        &mut self,
        mesh: &DynamicMesh,
        _kind: SurfaceKind,
        _texture: *const core::ffi::c_void,
        _tint: [f32; 4],
        _view_proj: &[f32; 16],
        stats: &mut SceneStats,
    ) {
        mesh.write_vertex_bytes(&mut self.vertices);
        mesh.write_index_bytes(&mut self.indices);
        stats.triangles += mesh.triangle_count() as u32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;
    use pocket3d_scene::runtime::{DYNAMIC_VERTEX_STRIDE, DynamicVertex};

    #[test]
    fn staging_matches_the_stride_the_vertex_programs_declare() {
        let mut mesh = DynamicMesh::new();
        let a = mesh.push_vertex(DynamicVertex::new(Vec3::ZERO, [0.0, 0.0], 0xffff_ffff, 0));
        let b = mesh.push_vertex(DynamicVertex::new(Vec3::X, [1.0, 0.0], 0xffff_ffff, 0));
        let c = mesh.push_vertex(DynamicVertex::new(Vec3::Y, [1.0, 1.0], 0xffff_ffff, 0));
        let d = mesh.push_vertex(DynamicVertex::new(Vec3::Z, [0.0, 1.0], 0xffff_ffff, 0));
        mesh.push_quad(a, b, c, d);

        let mut surface = DynamicSurface::new();
        let mut stats = SceneStats::default();
        unsafe {
            surface.draw(
                &mesh,
                SurfaceKind::Opaque,
                core::ptr::null(),
                [1.0; 4],
                &[0.0; 16],
                &mut stats,
            );
        }
        assert_eq!(surface.vertices.len(), 4 * DYNAMIC_VERTEX_STRIDE);
        assert_eq!(surface.indices.len(), 6 * 2);
        assert_eq!(stats.triangles, 2);
    }

    #[test]
    fn the_position_lands_at_the_offset_the_attribute_reads() {
        let mut mesh = DynamicMesh::new();
        mesh.push_vertex(DynamicVertex::new(
            Vec3::new(1.5, -2.25, 3.75),
            [0.25, 0.5],
            0x8040_2010,
            0x0102_0304,
        ));
        let mut bytes = Vec::new();
        mesh.write_vertex_bytes(&mut bytes);
        let float = |offset: usize| {
            f32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ])
        };
        let word = |offset: usize| {
            u32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ])
        };
        assert_eq!(float(0), 0.25);
        assert_eq!(float(4), 0.5);
        assert_eq!(word(8), 0x8040_2010);
        assert_eq!(word(12), 0x0102_0304);
        assert_eq!(float(16), 1.5);
        assert_eq!(float(20), -2.25);
        assert_eq!(float(24), 3.75);
    }
}
