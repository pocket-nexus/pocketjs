//! Resident indexed rigid vertices and row-major affine palettes.
use crate::colored::{AssetError, MeshAsset};
use alloc::vec::Vec;
use glam::Mat4;

/// Immutable vertex input for a rigid GPU skin. Colors are display-space
/// material factors; the shader applies sqrt(diffuse lighting) per vertex.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct RigidVertex {
    pub position: [f32; 3],
    pub normal: [f32; 3],
    pub color: [f32; 3],
    pub matrix_row: f32,
}
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct RigidRange {
    pub first: u32,
    pub count: u32,
    pub joints: [u16; 3],
    pub reserved: u16,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct SkinMatrix {
    /// Row-major affine transform. A zero matrix marks an invisible joint.
    pub rows: [[f32; 4]; 3],
}
pub struct RigidMesh {
    pub vertices: Vec<RigidVertex>,
    pub indices: Vec<u16>,
    pub ranges: Vec<RigidRange>,
    pub joints: usize,
}

impl MeshAsset {
    /// Preserve vertex sharing and triangle order. Visibility ranges let a
    /// backend omit hidden layers without rebuilding or uploading indices.
    pub fn rigid_mesh(&self) -> Result<RigidMesh, AssetError> {
        if self.vertices.len() > u16::MAX as usize + 1 || self.skin.joints.len() > u16::MAX as usize
        {
            return Err(AssetError::Limit);
        }
        if self.skin.joints.len() != self.skin.inverse_bind.len()
            || self
                .skin
                .joints
                .iter()
                .any(|&n| n >= self.skeleton.rest.len())
            || !self.indices.len().is_multiple_of(3)
            || self
                .indices
                .iter()
                .any(|&i| i as usize >= self.vertices.len())
            || self
                .vertices
                .iter()
                .any(|v| v.joint >= self.skin.joints.len())
        {
            return Err(AssetError::Invalid);
        }
        let vertices = self
            .vertices
            .iter()
            .map(|v| RigidVertex {
                position: v.position.to_array(),
                normal: v.normal.to_array(),
                color: v.color.sqrt().to_array(),
                matrix_row: (v.joint * 3) as f32,
            })
            .collect();
        let indices = self.indices.iter().map(|&i| i as u16).collect();
        let mut ranges: Vec<RigidRange> = Vec::new();
        for (first, tri) in self.indices.as_chunks::<3>().0.iter().enumerate() {
            let mut joints = [0u16; 3];
            for (j, &i) in joints.iter_mut().zip(tri) {
                *j = self.vertices[i as usize].joint as u16;
            }
            joints.sort_unstable();
            if let Some(last) = ranges.last_mut().filter(|r| r.joints == joints) {
                last.count += 3;
            } else {
                ranges.push(RigidRange {
                    first: (first * 3) as u32,
                    count: 3,
                    joints,
                    reserved: 0,
                });
            }
        }
        Ok(RigidMesh {
            vertices,
            indices,
            ranges,
            joints: self.skin.joints.len(),
        })
    }
    pub fn skin_matrices(&self, globals: &[Mat4], model: Mat4, out: &mut Vec<SkinMatrix>) {
        out.clear();
        out.extend(self.skin_transforms(globals, model).map(|(m, visible)| {
            if !visible {
                SkinMatrix::default()
            } else {
                SkinMatrix {
                    rows: [
                        m.row(0).to_array(),
                        m.row(1).to_array(),
                        m.row(2).to_array(),
                    ],
                }
            }
        }));
    }
}
