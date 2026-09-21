//! Bounds of the quantized vertices actually referenced by a cooked run.
use glam::Vec3;

use super::{CookedMap, FaceRun, VERTEX_STRIDE};
use crate::vis::Frustum;
/// Bounds and an optional inward plane, constructed at load without changing files.
#[derive(Clone, Copy, Debug)]
pub struct RunBounds {
    mins: [i16; 3],
    maxs: [i16; 3],
    plane: [f32; 4],
}

impl RunBounds {
    pub fn new(map: &CookedMap<'_>, run: FaceRun) -> Self {
        if run.batch == u16::MAX {
            return Self::empty();
        }
        let batch = &map.batches[run.batch as usize];
        Self::from_indices(
            &map.verts[batch.vert_base as usize * VERTEX_STRIDE..],
            &map.indices
                [run.index_base as usize..run.index_base as usize + run.index_count as usize],
        )
    }

    pub(crate) fn empty() -> Self {
        Self {
            mins: [i16::MAX; 3],
            maxs: [i16::MIN; 3],
            plane: [0.0; 4],
        }
    }

    fn from_indices(vertices: &[u8], indices: &[u16]) -> Self {
        let mut bounds = Self::empty();
        for &index in indices {
            let offset = index as usize * VERTEX_STRIDE + 12;
            for axis in 0..3 {
                let start = offset + axis * 2;
                let value = i16::from_le_bytes([vertices[start], vertices[start + 1]]);
                bounds.mins[axis] = bounds.mins[axis].min(value);
                bounds.maxs[axis] = bounds.maxs[axis].max(value);
            }
        }
        let point = |index: u16| {
            let offset = index as usize * VERTEX_STRIDE + 12;
            Vec3::new(
                i16::from_le_bytes([vertices[offset], vertices[offset + 1]]) as f32,
                i16::from_le_bytes([vertices[offset + 2], vertices[offset + 3]]) as f32,
                i16::from_le_bytes([vertices[offset + 4], vertices[offset + 5]]) as f32,
            )
        };
        for triangle in indices.chunks_exact(3) {
            let a = point(triangle[0]);
            let normal = (point(triangle[1]) - a)
                .cross(point(triangle[2]) - a)
                .normalize_or_zero();
            if normal.length_squared() < 0.5 {
                continue;
            }
            let distance = normal.dot(a);
            if indices
                .iter()
                .all(|&i| (normal.dot(point(i)) - distance).abs() <= 1.5)
            {
                bounds.plane = [normal.x, normal.y, normal.z, distance];
            }
            break;
        }
        bounds
    }

    pub fn center(&self) -> Vec3 {
        Vec3::new(
            (self.mins[0] as f32 + self.maxs[0] as f32) * 0.5,
            (self.mins[1] as f32 + self.maxs[1] as f32) * 0.5,
            (self.mins[2] as f32 + self.maxs[2] as f32) * 0.5,
        )
    }

    pub fn orientation(&self) -> u8 {
        let [x, y, z, _] = self.plane;
        if x.abs() >= y.abs() && x.abs() >= z.abs() {
            u8::from(x >= 0.0)
        } else if y.abs() >= z.abs() {
            2 + u8::from(y >= 0.0)
        } else {
            4 + u8::from(z >= 0.0)
        }
    }

    pub fn union(&mut self, other: &Self) {
        if self.mins[0] > self.maxs[0] {
            *self = *other;
            return;
        }
        for i in 0..3 {
            self.mins[i] = self.mins[i].min(other.mins[i]);
            self.maxs[i] = self.maxs[i].max(other.maxs[i]);
        }
        if self.plane[..3] == other.plane[..3] {
            self.plane[3] = self.plane[3].max(other.plane[3]);
        } else {
            self.plane = [0.0; 4];
        }
    }

    /// GoldSrc polygon winding points into the brush. Keep the quantization
    /// boundary and non-planar runs conservative. Brush surface winding is
    /// independent of the renderer strip winding; water remains two-sided.
    #[inline]
    pub fn facing(&self, camera: Vec3) -> bool {
        let [x, y, z, distance] = self.plane;
        x * camera.x + y * camera.y + z * camera.z - distance <= 2.0
    }

    #[inline]
    pub fn visible(&self, frustum: &Frustum) -> bool {
        self.mins[0] <= self.maxs[0]
            && frustum.intersects_aabb(
                Vec3::new(
                    self.mins[0] as f32,
                    self.mins[1] as f32,
                    self.mins[2] as f32,
                ),
                Vec3::new(
                    self.maxs[0] as f32,
                    self.maxs[1] as f32,
                    self.maxs[2] as f32,
                ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verts(points: &[[i16; 3]]) -> alloc::vec::Vec<u8> {
        let mut bytes = alloc::vec![0; points.len() * VERTEX_STRIDE];
        for (i, point) in points.iter().enumerate() {
            for (axis, value) in point.iter().enumerate() {
                bytes[i * VERTEX_STRIDE + 12 + axis * 2..i * VERTEX_STRIDE + 14 + axis * 2]
                    .copy_from_slice(&value.to_le_bytes());
            }
        }
        bytes
    }

    #[test]
    fn bounds_use_referenced_vertices_and_signed_quantized_coordinates() {
        let bytes = verts(&[[30000, 30000, 30000], [-3, -2, -10], [4, 5, -8], [0, 0, -9]]);
        let bounds = RunBounds::from_indices(&bytes, &[1, 2, 3, 2, 1, 3]);
        assert_eq!(bounds.mins, [-3, -2, -10]);
        assert_eq!(bounds.maxs, [4, 5, -8]);
        assert_eq!(core::mem::size_of::<RunBounds>(), 28);
    }

    #[test]
    fn conservative_frustum_keeps_crossing_faces_and_rejects_outside_faces() {
        for fov in [0.7, 1.4] {
            let frustum = Frustum::from_clip(
                glam::camera::rh::proj::opengl::perspective(fov, 1.7, 1.0, 100.0),
                false,
            );
            let inside = verts(&[[-1, -1, -10], [1, -1, -10], [0, 1, -10]]);
            let outside = verts(&[[200, -1, -10], [202, -1, -10], [201, 1, -10]]);
            let crossing = verts(&[[-300, -1, -10], [300, -1, -10], [0, 300, -10]]);
            assert!(RunBounds::from_indices(&inside, &[0, 1, 2]).visible(&frustum));
            assert!(!RunBounds::from_indices(&outside, &[0, 1, 2]).visible(&frustum));
            assert!(RunBounds::from_indices(&crossing, &[0, 1, 2]).visible(&frustum));
            assert!(!RunBounds::empty().visible(&frustum));
        }
    }
    #[test]
    fn inward_planes_and_unions_keep_every_front_side() {
        let floor = verts(&[[0, 0, 0], [64, 0, 0], [0, 0, 64]]);
        let upper = verts(&[[0, 32, 0], [64, 32, 0], [0, 32, 64]]);
        let a = RunBounds::from_indices(&floor, &[0, 1, 2]);
        let b = RunBounds::from_indices(&upper, &[0, 1, 2]);
        assert!(a.facing(Vec3::new(8.0, 36.0, 8.0)));
        assert!(!a.facing(Vec3::new(8.0, -36.0, 8.0)));
        let mut union = a;
        union.union(&b);
        for y in -64..96 {
            let eye = Vec3::new(8.0, y as f32, 8.0);
            if a.facing(eye) || b.facing(eye) {
                assert!(union.facing(eye));
            }
        }
    }
}
