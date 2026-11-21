//! Cursor-ray picking against oriented boxes.
//!
//! Widgets pick on mouse events, never per frame — a handful of slab tests
//! against part bounds is a cold path. Rays come from
//! [`pocket3d::camera::Camera::screen_ray`]; boxes are a part's local AABB
//! under its instance transform.

use glam::{Mat4, Vec3};

/// Ray / oriented-box intersection. `aabb` is the box in local space,
/// `transform` places it in the world. Returns the ray parameter `t` of the
/// nearest hit at or in front of the origin (`t` is preserved by the
/// local-space transform, so callers compare `t` across boxes directly).
pub fn ray_obb(origin: Vec3, dir: Vec3, transform: &Mat4, aabb: (Vec3, Vec3)) -> Option<f32> {
    let inv = transform.inverse();
    let o = inv.transform_point3(origin);
    let d = inv.transform_vector3(dir);

    let mut tmin = 0.0f32;
    let mut tmax = f32::MAX;
    for axis in 0..3 {
        let (o, d) = (o[axis], d[axis]);
        let (lo, hi) = (aabb.0[axis], aabb.1[axis]);
        if d.abs() < 1e-8 {
            if o < lo || o > hi {
                return None;
            }
            continue;
        }
        let (t0, t1) = ((lo - o) / d, (hi - o) / d);
        tmin = tmin.max(t0.min(t1));
        tmax = tmax.min(t0.max(t1));
        if tmax < tmin {
            return None;
        }
    }
    Some(tmin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::FRAC_PI_4;

    const BOX: (Vec3, Vec3) = (Vec3::new(-1.0, -1.0, -1.0), Vec3::new(1.0, 1.0, 1.0));

    #[test]
    fn hits_axis_aligned_box() {
        let t = ray_obb(Vec3::new(0.0, 0.0, 5.0), Vec3::NEG_Z, &Mat4::IDENTITY, BOX);
        assert!((t.unwrap() - 4.0).abs() < 1e-4);
    }

    #[test]
    fn misses_beside_box() {
        assert!(ray_obb(Vec3::new(3.0, 0.0, 5.0), Vec3::NEG_Z, &Mat4::IDENTITY, BOX).is_none());
    }

    #[test]
    fn misses_box_behind_origin() {
        assert!(ray_obb(Vec3::new(0.0, 0.0, 5.0), Vec3::Z, &Mat4::IDENTITY, BOX).is_none());
    }

    #[test]
    fn origin_inside_box_hits_at_zero() {
        let t = ray_obb(Vec3::ZERO, Vec3::NEG_Z, &Mat4::IDENTITY, BOX);
        assert_eq!(t, Some(0.0));
    }

    #[test]
    fn t_is_world_scale_under_rotation_and_translation() {
        // Box rotated 45° around Y and pushed to x=10: a ray down -X from
        // (20, 0, 0) hits the corner-on silhouette at 10 - sqrt(2).
        let m = Mat4::from_translation(Vec3::new(10.0, 0.0, 0.0))
            * Mat4::from_rotation_y(FRAC_PI_4);
        let t = ray_obb(Vec3::new(20.0, 0.0, 0.0), Vec3::NEG_X, &m, BOX).unwrap();
        assert!((t - (10.0 - 2.0f32.sqrt())).abs() < 1e-3, "t = {t}");
    }

    #[test]
    fn parallel_ray_outside_slab_misses() {
        assert!(
            ray_obb(Vec3::new(0.0, 2.0, 5.0), Vec3::NEG_Z, &Mat4::IDENTITY, BOX).is_none()
        );
    }
}
