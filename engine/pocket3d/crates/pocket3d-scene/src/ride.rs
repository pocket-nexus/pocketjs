//! The drift: where the hull sits on the river at a given moment, and where
//! the camera rides behind it.
//!
//! This lives in the portable crate rather than in either renderer so a still
//! rendered on a desktop and a frame on the device are the same shot. It is
//! also why the cooked fog is honest: [`DriftSettings`] names the stretch of
//! river the camera stays on, and the cooker bakes aerial perspective from the
//! middle of exactly that stretch.

use glam::{Mat4, Quat, Vec3};

use crate::format::Scene;
use crate::math::{atan2f, cosf, sinf, sqrtf, wrap01};

/// The stretch of river the camera travels and how it is framed.
#[derive(Clone, Copy, Debug)]
pub struct DriftSettings {
    /// World z the drift starts at, and where it ends. The camera loops.
    pub near: f32,
    pub far: f32,
    /// Fraction of the stretch covered per second.
    pub speed: f32,
    /// Camera offsets from the hull, in its own frame.
    pub eye_back: f32,
    pub eye_side: f32,
    pub eye_up: f32,
    /// How far down the channel the camera looks, and at what height.
    pub look_ahead: f32,
    pub look_height: f32,
}

impl Default for DriftSettings {
    fn default() -> Self {
        Self {
            near: 60.0,
            far: -180.0,
            speed: 0.012,
            eye_back: 6.2,
            eye_side: 1.9,
            eye_up: 3.5,
            look_ahead: 95.0,
            look_height: 1.4,
        }
    }
}

/// Everything a renderer needs to place the shot.
#[derive(Clone, Copy, Debug)]
pub struct Ride {
    pub eye: Vec3,
    pub target: Vec3,
    /// World transform for the cooked boat object.
    pub boat: Mat4,
    pub boat_position: Vec3,
    pub boat_heading: f32,
}

/// Where the hull sits at `z`, and how it is turned and rocking at `time`.
pub fn boat_transform(scene: &Scene<'_>, z: f32, time: f32) -> (Vec3, f32, Mat4) {
    let (x, _) = scene.river_at(z);
    let (ahead, _) = scene.river_at(z - 8.0);
    // The hull points down-current; the centre line's own slope is its heading.
    let heading = atan2f(x - ahead, 8.0);
    let bob = sinf(time * 1.15) * 0.045 + sinf(time * 0.63 + 1.9) * 0.03;
    let roll = sinf(time * 0.83 + 0.4) * 0.018;
    let pitch = sinf(time * 1.31) * 0.012;
    let position = Vec3::new(x, scene.header.water_level + bob, z);
    let rotation =
        Quat::from_rotation_y(heading) * Quat::from_rotation_z(roll) * Quat::from_rotation_x(pitch);
    (
        position,
        heading,
        Mat4::from_rotation_translation(rotation, position),
    )
}

/// Resolve the whole shot at `time`.
pub fn ride(scene: &Scene<'_>, settings: &DriftSettings, time: f32) -> Ride {
    let span = settings.near - settings.far;
    let progress = wrap01(time * settings.speed);
    let z = settings.near - span * progress;
    let (boat_position, heading, boat) = boat_transform(scene, z, time);

    let back = Vec3::new(sinf(heading), 0.0, cosf(heading));
    let side = Vec3::new(back.z, 0.0, -back.x);
    // Over the stern and off to one side, so the hull sits in the lower third
    // and leaves the channel open down the middle of the frame.
    let eye = boat_position
        + back * settings.eye_back
        + side * settings.eye_side
        + Vec3::Y * settings.eye_up;
    let sway = sinf(time * 0.08) * 3.0;
    let ahead_z = z - settings.look_ahead;
    let (ahead_x, _) = scene.river_at(ahead_z);
    let target = Vec3::new(ahead_x + sway, settings.look_height, ahead_z);
    Ride {
        eye,
        target,
        boat,
        boat_position,
        boat_heading: heading,
    }
}

/// Yaw and pitch that look from `eye` towards `target`, for a camera that
/// stores angles rather than a matrix.
pub fn look_angles(eye: Vec3, target: Vec3) -> (f32, f32) {
    let delta = target - eye;
    let flat = (delta.x * delta.x + delta.z * delta.z).max(1e-8);
    let yaw = atan2f(-delta.x, -delta.z);
    let pitch = atan2f(delta.y, sqrtf(flat));
    (yaw, pitch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::{Mesh, SceneBuilder};
    use crate::format::{Material, MaterialKind, RiverSample};
    use crate::light::BakedVertexColor;
    use alloc::vec;
    use alloc::vec::Vec;

    fn scene_bytes() -> Vec<u8> {
        let mut builder = SceneBuilder::new();
        builder.header.lod_distances = [90.0, 300.0, 1200.0];
        builder.add_texture("flat", 2, 2, &[255u8; 16], false).unwrap();
        let material = builder.add_material(Material {
            texture: 0,
            kind: MaterialKind::Opaque,
            flags: 0,
            tint: [255; 4],
            sort_bias: 0.0,
        });
        let mut mesh = Mesh::new();
        let color = BakedVertexColor {
            lit: 0xffff_ffff,
            fog: 0,
        };
        let a = mesh.push_vertex(Vec3::ZERO, [0.0, 0.0], color);
        let b = mesh.push_vertex(Vec3::X, [1.0, 0.0], color);
        let c = mesh.push_vertex(Vec3::Z, [0.0, 1.0], color);
        mesh.push_triangle(a, b, c);
        builder.add_mesh(&mesh, material, 0xff, 0).unwrap();
        let mut river = vec![];
        let mut z = -400.0f32;
        while z <= 120.0 {
            river.push(RiverSample {
                z,
                x: sinf(z * 0.01) * 30.0,
                half_width: 15.0,
                depth: 2.5,
            });
            z += 10.0;
        }
        builder.set_river(river);
        builder.finish().unwrap()
    }

    #[test]
    fn the_hull_stays_on_the_centre_line_throughout_the_drift() {
        let bytes = scene_bytes();
        let scene = Scene::parse(&bytes).unwrap();
        let settings = DriftSettings::default();
        for step in 0..120 {
            let time = step as f32 * 0.9;
            let shot = ride(&scene, &settings, time);
            let (center, half_width) = scene.river_at(shot.boat_position.z);
            assert!(
                (shot.boat_position.x - center).abs() < half_width * 0.25,
                "strayed at t={time}"
            );
        }
    }

    #[test]
    fn the_drift_stays_inside_the_stretch_the_fog_was_baked_for() {
        let bytes = scene_bytes();
        let scene = Scene::parse(&bytes).unwrap();
        let settings = DriftSettings::default();
        for step in 0..400 {
            let shot = ride(&scene, &settings, step as f32 * 2.3);
            assert!(
                shot.boat_position.z <= settings.near + 0.01
                    && shot.boat_position.z >= settings.far - 0.01,
                "left the stretch at {}",
                shot.boat_position.z
            );
        }
    }

    #[test]
    fn the_camera_sits_behind_and_above_the_hull() {
        let bytes = scene_bytes();
        let scene = Scene::parse(&bytes).unwrap();
        let settings = DriftSettings::default();
        let shot = ride(&scene, &settings, 12.0);
        assert!(shot.eye.y > shot.boat_position.y + 2.0);
        // Behind means further up-current, which is greater z here.
        assert!(shot.eye.z > shot.boat_position.z);
        assert!((shot.eye - shot.boat_position).length() < 10.0);
    }

    #[test]
    fn look_angles_recover_the_direction_they_were_built_from() {
        for target in [
            Vec3::new(0.0, 0.0, -10.0),
            Vec3::new(5.0, 3.0, -8.0),
            Vec3::new(-7.0, -2.0, 4.0),
        ] {
            let (yaw, pitch) = look_angles(Vec3::ZERO, target);
            let forward = Vec3::new(
                -sinf(yaw) * cosf(pitch),
                sinf(pitch),
                -cosf(yaw) * cosf(pitch),
            );
            let expected = target.normalize();
            assert!(
                (forward - expected).length() < 1e-4,
                "{forward:?} vs {expected:?}"
            );
        }
    }
}
