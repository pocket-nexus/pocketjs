//! First-person camera. Right-handed, +Y up; yaw 0 looks down -Z.

use glam::{Mat4, Vec3};

#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub pos: Vec3,
    /// Radians around +Y. 0 = -Z, positive turns left (CCW seen from above).
    pub yaw: f32,
    /// Radians. Positive looks up. Clamped by callers to about +-89 deg.
    pub pitch: f32,
    pub fov_y: f32,
    pub znear: f32,
    pub zfar: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            pos: Vec3::ZERO,
            yaw: 0.0,
            pitch: 0.0,
            fov_y: 70f32.to_radians(),
            znear: 1.0,
            zfar: 16384.0,
        }
    }
}

impl Camera {
    pub fn forward(&self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        let (sp, cp) = self.pitch.sin_cos();
        Vec3::new(-sy * cp, sp, -cy * cp)
    }

    /// Horizontal forward (ignores pitch), normalized.
    pub fn forward_flat(&self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        Vec3::new(-sy, 0.0, -cy)
    }

    pub fn right(&self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        Vec3::new(cy, 0.0, -sy)
    }

    pub fn view(&self) -> Mat4 {
        glam::camera::rh::view::look_to_mat4(self.pos, self.forward(), Vec3::Y)
    }

    pub fn proj(&self, aspect: f32) -> Mat4 {
        // DirectX-style 0..1 clip depth, matching wgpu.
        glam::camera::rh::proj::directx::perspective(self.fov_y, aspect, self.znear, self.zfar)
    }

    pub fn view_proj(&self, aspect: f32) -> Mat4 {
        self.proj(aspect) * self.view()
    }

    /// Point the camera at a world position.
    pub fn look_at(&mut self, target: Vec3) {
        let d = target - self.pos;
        let flat = (d.x * d.x + d.z * d.z).sqrt();
        self.yaw = (-d.x).atan2(-d.z);
        self.pitch = d.y.atan2(flat);
    }

    /// World-space ray through a window pixel (origin, normalized direction).
    /// `cursor` is in pixels from the top-left, `viewport` the target size in
    /// the same units — cursor picking for widgets and editors.
    pub fn screen_ray(&self, cursor: glam::Vec2, viewport: (f32, f32)) -> (Vec3, Vec3) {
        let aspect = viewport.0 / viewport.1.max(1.0);
        let inv = self.view_proj(aspect).inverse();
        let ndc = glam::Vec2::new(
            cursor.x / viewport.0 * 2.0 - 1.0,
            1.0 - cursor.y / viewport.1 * 2.0,
        );
        // wgpu clip depth is 0..1; unproject the near and far plane points.
        let near = inv.project_point3(Vec3::new(ndc.x, ndc.y, 0.0));
        let far = inv.project_point3(Vec3::new(ndc.x, ndc.y, 1.0));
        (near, (far - near).normalize_or_zero())
    }
}

/// Intersect a finite camera-to-subject segment with local axis-aligned bounds.
/// Transform both endpoints into object space before calling for rotated/scaled
/// models. A segment beginning or ending inside the bounds counts as occluded.
pub fn segment_intersects_bounds(start: Vec3, end: Vec3, min: Vec3, max: Vec3) -> bool {
    if !start.is_finite()
        || !end.is_finite()
        || !min.is_finite()
        || !max.is_finite()
        || min.cmpgt(max).any()
    {
        return false;
    }
    let delta = end - start;
    let mut near: f32 = 0.0;
    let mut far: f32 = 1.0;
    for axis in 0..3 {
        if delta[axis].abs() < 1e-8 {
            if start[axis] < min[axis] || start[axis] > max[axis] {
                return false;
            }
        } else {
            let a = (min[axis] - start[axis]) / delta[axis];
            let b = (max[axis] - start[axis]) / delta[axis];
            near = near.max(a.min(b));
            far = far.min(a.max(b));
            if near > far {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod occlusion_tests {
    use super::*;
    use glam::Quat;
    #[test]
    fn finite_segments_handle_rotated_and_nonuniform_bounds() {
        for transform in [
            Mat4::IDENTITY,
            Mat4::from_scale_rotation_translation(
                Vec3::new(2.0, 0.5, 3.0),
                Quat::from_rotation_y(0.7),
                Vec3::new(5.0, 2.0, -3.0),
            ),
        ] {
            let inverse = transform.inverse();
            for (a, b, expected) in [
                (Vec3::Z * 3.0, Vec3::NEG_Z * 3.0, true),
                (Vec3::Z * 3.0, Vec3::Z * 2.0, false),
                (Vec3::new(2.0, 0.0, 3.0), Vec3::new(2.0, 0.0, -3.0), false),
                (Vec3::ZERO, Vec3::ZERO, true),
            ] {
                assert_eq!(
                    segment_intersects_bounds(
                        inverse.transform_point3(transform.transform_point3(a)),
                        inverse.transform_point3(transform.transform_point3(b)),
                        Vec3::NEG_ONE,
                        Vec3::ONE
                    ),
                    expected
                );
            }
        }
    }
}
