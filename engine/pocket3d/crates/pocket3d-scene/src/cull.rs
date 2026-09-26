//! Backend-independent visibility: six-plane frustum rejection, LOD band
//! selection and translucent sorting over [`crate::format::Chunk`] records.
//!
//! Every constrained backend needs this and none of it touches a GPU, so it
//! lives beside the format instead of being written once per backend. The
//! working vectors are retained across frames, so a steady-state frame does
//! no allocation.

use alloc::vec::Vec;

use glam::{Mat4, Vec3, Vec4, Vec4Swizzles};

use crate::format::{Chunk, MaterialKind, Scene};

/// A chunk with this LOD is drawn in every band, up to the cull distance.
pub const LOD_ALWAYS: u8 = 0xff;

/// Six outward-facing clip planes, `xyz` normal and `w` offset.
#[derive(Clone, Copy, Debug, Default)]
pub struct Frustum {
    pub planes: [Vec4; 6],
}

impl Frustum {
    /// Extract planes from a view-projection matrix (Gribb/Hartmann).
    pub fn from_view_proj(view_proj: Mat4) -> Self {
        let row = |index: usize| {
            Vec4::new(
                view_proj.x_axis[index],
                view_proj.y_axis[index],
                view_proj.z_axis[index],
                view_proj.w_axis[index],
            )
        };
        let (x, y, z, w) = (row(0), row(1), row(2), row(3));
        let mut planes = [w + x, w - x, w + y, w - y, w + z, w - z];
        for plane in &mut planes {
            let length = plane.xyz().length();
            if length > 1e-6 {
                *plane /= length;
            }
        }
        Self { planes }
    }

    /// False when the sphere is entirely outside at least one plane.
    pub fn intersects_sphere(&self, center: Vec3, radius: f32) -> bool {
        self.planes
            .iter()
            .all(|plane| plane.xyz().dot(center) + plane.w >= -radius)
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CullStats {
    pub chunks_tested: u32,
    pub chunks_drawn: u32,
    pub culled_frustum: u32,
    pub culled_distance: u32,
    pub culled_lod: u32,
    pub triangles: u32,
}

/// One chunk selected for drawing, with the depth its pass sorts by.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChunkVisibility {
    pub chunk: u16,
    /// Distance from the eye to the chunk's bounding-sphere centre.
    pub depth: f32,
}

/// The per-frame draw lists, retained across frames.
#[derive(Debug, Default)]
pub struct VisibleSet {
    /// Depth-written geometry, ordered near to far so the depth test rejects
    /// the most fragments.
    pub opaque: Vec<ChunkVisibility>,
    /// Alpha-blended geometry, ordered far to near.
    pub translucent: Vec<ChunkVisibility>,
    pub stats: CullStats,
}

impl VisibleSet {
    pub const fn new() -> Self {
        Self {
            opaque: Vec::new(),
            translucent: Vec::new(),
            stats: CullStats {
                chunks_tested: 0,
                chunks_drawn: 0,
                culled_frustum: 0,
                culled_distance: 0,
                culled_lod: 0,
                triangles: 0,
            },
        }
    }

    pub fn clear(&mut self) {
        self.opaque.clear();
        self.translucent.clear();
        self.stats = CullStats::default();
    }

    /// Select every chunk the camera can see, sorted for submission.
    ///
    /// Dynamic chunks are skipped: the runtime owns their transform and
    /// submits them itself.
    pub fn gather(&mut self, scene: &Scene<'_>, frustum: &Frustum, eye: Vec3) {
        self.clear();
        let bands = lod_bands(scene.header.lod_distances);
        let cull = scene.header.lod_distances[2];
        for (index, chunk) in scene.chunks.iter().enumerate() {
            if chunk.is_dynamic() || chunk.index_count == 0 {
                continue;
            }
            self.stats.chunks_tested += 1;
            let depth = (chunk.center - eye).length();
            if depth - chunk.radius > cull {
                self.stats.culled_distance += 1;
                continue;
            }
            if !in_lod_band(chunk.lod, depth, &bands) {
                self.stats.culled_lod += 1;
                continue;
            }
            if !frustum.intersects_sphere(chunk.center, chunk.radius) {
                self.stats.culled_frustum += 1;
                continue;
            }
            let entry = ChunkVisibility {
                chunk: index as u16,
                depth,
            };
            let kind = scene.materials[chunk.material as usize].kind;
            if kind == MaterialKind::Opaque {
                self.opaque.push(entry);
            } else {
                let bias = scene.materials[chunk.material as usize].sort_bias;
                self.translucent.push(ChunkVisibility {
                    depth: depth + bias,
                    ..entry
                });
            }
            self.stats.chunks_drawn += 1;
            self.stats.triangles += chunk.index_count / 3;
        }
        self.opaque
            .sort_unstable_by(|left, right| order(left.depth, right.depth));
        self.translucent
            .sort_unstable_by(|left, right| order(right.depth, left.depth));
    }
}

fn order(left: f32, right: f32) -> core::cmp::Ordering {
    left.partial_cmp(&right)
        .unwrap_or(core::cmp::Ordering::Equal)
}

/// Inclusive-exclusive distance bands for LOD levels 0, 1 and 2.
pub fn lod_bands(distances: [f32; 3]) -> [(f32, f32); 3] {
    [
        (0.0, distances[0]),
        (distances[0], distances[1]),
        (distances[1], distances[2]),
    ]
}

pub fn in_lod_band(lod: u8, depth: f32, bands: &[(f32, f32); 3]) -> bool {
    if lod == LOD_ALWAYS {
        return true;
    }
    let Some(&(near, far)) = bands.get(lod as usize) else {
        return true;
    };
    depth >= near && depth < far
}

/// Choose the LOD band a distance falls in, for a cooker assigning levels.
pub fn band_for_distance(distance: f32, distances: [f32; 3]) -> u8 {
    if distance < distances[0] {
        0
    } else if distance < distances[1] {
        1
    } else {
        2
    }
}

/// Bounding sphere of a chunk's quantized vertices, in world space.
pub fn chunk_sphere(chunk: &Chunk) -> (Vec3, f32) {
    (chunk.center, chunk.radius)
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Mat4;

    fn camera() -> Mat4 {
        let projection = glam::camera::rh::proj::opengl::perspective(
            60f32.to_radians(),
            960.0 / 544.0,
            1.0,
            1000.0,
        );
        let view = glam::camera::rh::view::look_at_mat4(Vec3::ZERO, Vec3::NEG_Z, Vec3::Y);
        projection * view
    }

    #[test]
    fn a_sphere_in_front_is_visible_and_one_behind_is_not() {
        let frustum = Frustum::from_view_proj(camera());
        assert!(frustum.intersects_sphere(Vec3::new(0.0, 0.0, -100.0), 1.0));
        assert!(!frustum.intersects_sphere(Vec3::new(0.0, 0.0, 100.0), 1.0));
    }

    #[test]
    fn a_sphere_straddling_a_plane_stays_visible() {
        let frustum = Frustum::from_view_proj(camera());
        // Far outside the right plane by its centre, but large enough to reach in.
        assert!(!frustum.intersects_sphere(Vec3::new(400.0, 0.0, -100.0), 1.0));
        assert!(frustum.intersects_sphere(Vec3::new(400.0, 0.0, -100.0), 400.0));
    }

    #[test]
    fn lod_bands_partition_the_distance_range() {
        let bands = lod_bands([50.0, 200.0, 900.0]);
        assert!(in_lod_band(0, 10.0, &bands));
        assert!(!in_lod_band(0, 60.0, &bands));
        assert!(in_lod_band(1, 60.0, &bands));
        assert!(!in_lod_band(1, 400.0, &bands));
        assert!(in_lod_band(2, 400.0, &bands));
        assert!(in_lod_band(LOD_ALWAYS, 400.0, &bands));
    }

    #[test]
    fn band_for_distance_matches_the_bands_it_selects() {
        let distances = [50.0, 200.0, 900.0];
        let bands = lod_bands(distances);
        for distance in [1.0f32, 49.0, 51.0, 199.0, 201.0, 880.0] {
            let lod = band_for_distance(distance, distances);
            assert!(in_lod_band(lod, distance, &bands), "distance {distance}");
        }
    }
}
