//! Colored rigid meshes and CPU reference rendering.
use crate::Skin;
use alloc::{string::String, vec, vec::Vec};
use glam::{Mat4, Vec3};
use pocket3d_anim::{Clip, Skeleton};

#[derive(Debug, PartialEq)]
pub enum AssetError {
    Truncated,
    Format,
    Limit,
    Invalid,
}
#[derive(Clone, Copy)]
pub struct Vertex {
    pub position: Vec3,
    pub normal: Vec3,
    pub color: Vec3,
    pub joint: usize,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ColorVertex {
    pub position: [f32; 3],
    pub color: [f32; 4],
}

/// Directional light for the gamma-2 colored-mesh profile. The application
/// supplies its art direction; the mesh and renderer do not choose a sun.
#[derive(Clone, Copy, Debug)]
pub struct DirectionalLight {
    pub direction: Vec3,
    pub ambient: f32,
    pub diffuse: f32,
}
impl DirectionalLight {
    /// Linear factors must be nonnegative and sum to at most one. A zero
    /// direction is allowed for an ambient-only (including unlit) pass.
    pub fn new(direction: Vec3, ambient: f32, diffuse: f32) -> Option<Self> {
        if !direction.is_finite()
            || !direction.length_squared().is_finite()
            || !ambient.is_finite()
            || !diffuse.is_finite()
            || ambient < 0.
            || diffuse < 0.
            || ambient + diffuse > 1.
            || (diffuse > 0. && direction.length_squared() < 1e-12)
        {
            return None;
        }
        Some(Self {
            direction: direction.normalize_or_zero(),
            ambient,
            diffuse,
        })
    }
}

pub struct MeshAsset {
    pub skeleton: Skeleton,
    pub names: Vec<String>,
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
    pub clips: Vec<Clip>,
    pub skin: Skin,
}
impl MeshAsset {
    pub fn clip(&self, name: &str) -> Option<usize> {
        self.clips.iter().position(|c| c.name == name)
    }
    /// Both CPU expansion and resident GPU packing use this transform and
    /// visibility rule. P3M1 hides a joint by collapsing its affine basis.
    pub(crate) fn skin_transforms<'a>(
        &'a self,
        globals: &'a [Mat4],
        model: Mat4,
    ) -> impl ExactSizeIterator<Item = (Mat4, bool)> + 'a {
        self.skin.matrices(globals, Some(model)).map(|m| {
            let visible = m
                .x_axis
                .truncate()
                .length_squared()
                .max(m.y_axis.truncate().length_squared())
                .max(m.z_axis.truncate().length_squared())
                >= 1e-6;
            (m, visible)
        })
    }
    /// Skin unique vertices once, then expand indices for backends with a
    /// streaming triangle buffer. Reuse `scratch` and `output` across frames.
    pub fn skin(
        &self,
        globals: &[Mat4],
        model: Mat4,
        light: DirectionalLight,
        scratch: &mut Vec<ColorVertex>,
        output: &mut Vec<ColorVertex>,
    ) {
        let palette: Vec<_> = self.skin_transforms(globals, model).collect();
        // Material runs share the same base color. sqrt(c * l) = sqrt(c) *
        // sqrt(l), so keep three color roots per run and one per vertex.
        // This call-local cache also respects callers editing public vertices.
        let mut last_color = Vec3::splat(-1.0);
        let mut display_color = Vec3::ZERO;
        scratch.clear();
        for v in &self.vertices {
            let (m, visible) = palette[v.joint];
            if !visible {
                scratch.push(ColorVertex::default());
                continue;
            }
            let pos = m.transform_point3(v.position);
            let normal = m.transform_vector3(v.normal).normalize_or_zero();
            let diffuse = normal.dot(light.direction).max(0.0);
            let intensity = light.ambient + light.diffuse * diffuse;
            // Blender material factors are linear. PICA's framebuffer has no
            // sRGB conversion; this profile uses a gamma-2 transfer.
            if v.color != last_color {
                display_color = v.color.sqrt();
                last_color = v.color;
            }
            let rgb = display_color * Vec3::splat(intensity).sqrt().x;
            scratch.push(ColorVertex {
                position: pos.to_array(),
                color: [rgb.x, rgb.y, rgb.z, 1.0],
            });
        }
        output.clear();
        for tri in self.indices.as_chunks::<3>().0 {
            if tri.iter().all(|&i| scratch[i as usize].color[3] == 0.0) {
                continue;
            }
            output.extend(tri.iter().map(|&i| scratch[i as usize]));
        }
    }
    pub fn rest_globals(&self) -> Vec<Mat4> {
        let mut g = vec![];
        self.skeleton
            .globals_from_locals(&self.skeleton.rest, &mut g);
        g
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rigid::{RigidRange, RigidVertex, SkinMatrix};
    use glam::Quat;
    use pocket3d_anim::NodeTrs;

    // A generated prop asset: one translating node and one colored triangle.
    // No application names, rig layout or embedded game assets are needed.
    fn fixture() -> Vec<u8> {
        let mut b = b"P3M1".to_vec();
        for value in [1u32, 3, 3, 0] {
            b.extend(value.to_le_bytes());
        }
        b.extend(4u16.to_le_bytes());
        b.extend(b"prop");
        b.extend(u32::MAX.to_le_bytes());
        for value in [0f32, 2., 0., 0., 0., 0., 1., 1., 1., 1.] {
            b.extend(value.to_le_bytes());
        }
        for p in [[0f32, 2., 0.], [1., 2., 0.], [0., 3., 0.]] {
            for value in p.into_iter().chain([0., 0., 1., 0.5, 0.25, 1.]) {
                b.extend(value.to_le_bytes());
            }
            b.extend(0u16.to_le_bytes());
        }
        for index in [0u32, 1, 2] {
            b.extend(index.to_le_bytes());
        }
        b
    }

    #[test]
    fn bounded_asset_decoder_and_rigid_palette_accept_an_independent_prop() {
        let bytes = fixture();
        let mesh = MeshAsset::decode(&bytes).unwrap();
        for end in 0..bytes.len() {
            assert!(MeshAsset::decode(&bytes[..end]).is_err());
        }
        let mut invalid = bytes.clone();
        let len = invalid.len();
        invalid[len - 4..].copy_from_slice(&99u32.to_le_bytes());
        assert!(matches!(
            MeshAsset::decode(&invalid),
            Err(AssetError::Invalid)
        ));
        let mut trailing = bytes;
        trailing.push(0);
        assert!(matches!(
            MeshAsset::decode(&trailing),
            Err(AssetError::Format)
        ));
        let rigid = mesh.rigid_mesh().unwrap();
        assert_eq!(rigid.indices, [0, 1, 2]);
        assert_eq!(rigid.ranges.len(), 1);
        let mut palette = vec![];
        mesh.skin_matrices(
            &mesh.rest_globals(),
            Mat4::from_translation(Vec3::X),
            &mut palette,
        );
        assert_eq!(
            palette[0].rows,
            [[1., 0., 0., 1.], [0., 1., 0., 0.], [0., 0., 1., 0.]]
        );
        mesh.skin_matrices(&[Mat4::ZERO], Mat4::IDENTITY, &mut palette);
        assert_eq!(palette[0].rows, [[0.; 4]; 3]);
        assert_eq!(core::mem::size_of::<RigidVertex>(), 40);
        assert_eq!(core::mem::size_of::<RigidRange>(), 16);
        assert_eq!(core::mem::size_of::<SkinMatrix>(), 48);
    }

    #[test]
    fn lighting_rejects_nonfinite_or_out_of_range_factors() {
        assert!(DirectionalLight::new(Vec3::Y, -1., 1.).is_none());
        assert!(DirectionalLight::new(Vec3::Y, 0.5, 0.6).is_none());
        assert!(DirectionalLight::new(Vec3::Y, f32::NAN, 0.).is_none());
        assert!(DirectionalLight::new(Vec3::ZERO, 0., 1.).is_none());
        assert!(DirectionalLight::new(Vec3::ZERO, 0., 0.).is_some());
        assert!(DirectionalLight::new(Vec3::splat(f32::MAX), 0., 1.).is_none());
    }

    #[test]
    fn material_runs_match_reference_skinning_across_transforms_and_visibility() {
        let mut asset = MeshAsset {
            skeleton: Skeleton {
                parents: vec![usize::MAX; 2],
                rest: vec![NodeTrs::IDENTITY; 2],
                order: vec![0, 1],
            },
            names: vec![],
            clips: vec![],
            skin: Skin {
                joints: vec![0, 1],
                inverse_bind: vec![Mat4::IDENTITY; 2],
            },
            indices: (0..6).collect(),
            vertices: (0..6)
                .map(|i| Vertex {
                    position: Vec3::new(i as f32, 0.5, -0.2),
                    normal: Vec3::new(0.3, 0.8, -0.4),
                    color: if i < 4 {
                        Vec3::new(0., 0.25, 1.)
                    } else {
                        Vec3::new(0.8, 0.02, 0.3)
                    },
                    joint: i / 3,
                })
                .collect(),
        };
        for light in [
            DirectionalLight::new(Vec3::Y, 0.2, 0.8).unwrap(),
            DirectionalLight::new(Vec3::ZERO, 1., 0.).unwrap(),
            DirectionalLight::new(Vec3::ZERO, 0., 0.).unwrap(),
        ] {
            for scale in [Vec3::ONE, Vec3::new(0.3, 2., 1.2)] {
                for hidden in [false, true] {
                    let model =
                        Mat4::from_rotation_translation(Quat::from_rotation_y(0.8), Vec3::X);
                    let globals = [
                        Mat4::from_scale_rotation_translation(
                            scale,
                            Quat::from_rotation_x(-0.4),
                            Vec3::Y,
                        ),
                        Mat4::from_scale(Vec3::splat(if hidden { 0.0001 } else { 1. })),
                    ];
                    let mut scratch = vec![];
                    let mut out = vec![];
                    asset.skin(&globals, model, light, &mut scratch, &mut out);
                    assert_eq!(out.len(), if hidden { 3 } else { 6 });
                    for (v, actual) in asset.vertices.iter().zip(&out) {
                        let m = model * globals[v.joint];
                        let normal = m.transform_vector3(v.normal).normalize_or_zero();
                        let intensity =
                            light.ambient + light.diffuse * normal.dot(light.direction).max(0.);
                        let expected = (v.color * intensity).sqrt();
                        assert!(
                            (Vec3::from_array(actual.position) - m.transform_point3(v.position))
                                .length()
                                < 1e-6
                        );
                        assert!(
                            (Vec3::from_slice(&actual.color) - expected)
                                .abs()
                                .max_element()
                                < 2e-7
                        );
                        assert_eq!(actual.color[3], 1.);
                    }
                    // Editing a public vertex must not reuse stale material data.
                    asset.vertices[0].color = Vec3::splat(0.1);
                }
            }
        }
    }
}
