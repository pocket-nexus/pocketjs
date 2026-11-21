//! Renderer-independent skin bindings and colored rigid meshes.
#![no_std]
extern crate alloc;

pub mod colored;
mod p3m;
pub mod rigid;

use alloc::vec::Vec;
use glam::Mat4;

/// Joint-to-node mapping and inverse bind transforms, shared by glTF and P3M1.
pub struct Skin {
    /// Node index per joint, in the order addressed by vertex influences.
    pub joints: Vec<usize>,
    pub inverse_bind: Vec<Mat4>,
}

impl Skin {
    /// Evaluate in joint order without allocating. `model` maps the skeleton
    /// into the caller's output space. `None` keeps object-space palettes and
    /// skips model multiplication; `Some` preserves (model * global) * bind.
    ///
    /// Bindings must have equal lengths and every joint must index `globals`.
    /// Loaders validate these invariants; callers constructing skins must too.
    pub fn matrices<'a>(
        &'a self,
        globals: &'a [Mat4],
        model: Option<Mat4>,
    ) -> impl ExactSizeIterator<Item = Mat4> + 'a {
        assert_eq!(self.joints.len(), self.inverse_bind.len());
        self.joints
            .iter()
            .zip(&self.inverse_bind)
            .map(move |(&node, bind)| {
                let global = globals[node];
                model.map_or(global, |model| model * global) * *bind
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use glam::{Quat, Vec3};
    use pocket3d_anim::{NodeTrs, Skeleton};

    #[test]
    fn reordered_and_multiple_skins_preserve_bind_space_and_model_transform() {
        for count in [2, 5] {
            let skeleton = Skeleton {
                parents: (0..count)
                    .map(|i| if i == 0 { usize::MAX } else { i - 1 })
                    .collect(),
                rest: (0..count)
                    .map(|_| NodeTrs {
                        translation: Vec3::Y,
                        ..NodeTrs::IDENTITY
                    })
                    .collect(),
                order: (0..count).collect(),
            };
            let mut globals = vec![];
            skeleton.globals_from_locals(&skeleton.rest, &mut globals);
            let skins = [
                Skin {
                    joints: vec![count - 1, 0],
                    inverse_bind: vec![globals[count - 1].inverse(), globals[0].inverse()],
                },
                Skin {
                    joints: vec![1],
                    inverse_bind: vec![globals[1].inverse()],
                },
            ];
            for matrix in skins.iter().flat_map(|s| s.matrices(&globals, None)) {
                assert!(matrix.abs_diff_eq(Mat4::IDENTITY, 1e-6));
            }
            // Move only the last node in world X. The first palette entry must
            // follow that node, not the first node in hierarchy order.
            globals[count - 1] = Mat4::from_translation(Vec3::X * 3.) * globals[count - 1];
            let model = Mat4::from_rotation_translation(
                Quat::from_rotation_z(core::f32::consts::FRAC_PI_2),
                Vec3::X * 7.,
            );
            let palette: Vec<_> = skins[0].matrices(&globals, Some(model)).collect();
            assert!(
                palette[0]
                    .transform_point3(Vec3::ZERO)
                    .distance(Vec3::new(7., 3., 0.))
                    < 1e-5
            );
            assert!(
                palette[1]
                    .transform_point3(Vec3::ZERO)
                    .distance(Vec3::new(7., 0., 0.))
                    < 1e-5
            );
        }
    }
}
