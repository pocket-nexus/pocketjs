//! Bone-type eye look-at: yaw/pitch in degrees onto the eye bones' local
//! rotations, limited by the model's VRM0 look-at ranges.
//!
//! Conventions (verified against the -Z-facing VRM0 rest pose, see the
//! crate docs): `yaw_deg > 0` looks toward the character's own left (a +Y
//! local rotation), `pitch_deg > 0` looks up (a +X local rotation).

use glam::Quat;
use pocket3d::anim::NodeTrs;

use crate::parse::{LookAtDegreeMap, LookAtRanges};

/// VRM0 degree mapping, linearized: input degrees clamp to `x_range`, scale
/// onto `y_range` output degrees (the sign of the input is preserved by the
/// caller).
fn map_degrees(deg: f32, map: &LookAtDegreeMap) -> f32 {
    if map.x_range <= 0.0 {
        return 0.0;
    }
    (deg.abs().min(map.x_range) / map.x_range) * map.y_range
}

/// Write eye look-at rotations into `locals`: each present eye gets
/// `rest_rotation * yaw (Y axis) * pitch (X axis)`, with yaw limited by the
/// per-side horizontal range (inner = toward the nose, outer = away) and
/// pitch by the vertical up/down ranges. Pure; nodes absent from the model
/// (None) are skipped.
pub fn apply_eye_look(
    locals: &mut [NodeTrs],
    rest: &[NodeTrs],
    left_eye: Option<usize>,
    right_eye: Option<usize>,
    ranges: &LookAtRanges,
    yaw_deg: f32,
    pitch_deg: f32,
) {
    let pitch_map = if pitch_deg >= 0.0 {
        &ranges.vertical_up
    } else {
        &ranges.vertical_down
    };
    let pitch_mag = map_degrees(pitch_deg, pitch_map).to_radians();
    let pitch = if pitch_deg >= 0.0 {
        pitch_mag
    } else {
        -pitch_mag
    };

    // Looking left (+yaw): the left eye swings away from the nose (outer),
    // the right eye toward it (inner) — and mirrored for -yaw.
    let eyes = [
        (left_eye, &ranges.horizontal_outer, &ranges.horizontal_inner),
        (
            right_eye,
            &ranges.horizontal_inner,
            &ranges.horizontal_outer,
        ),
    ];
    for (eye, pos_map, neg_map) in eyes {
        let Some(node) = eye else { continue };
        if node >= locals.len() || node >= rest.len() {
            continue;
        }
        let yaw_map = if yaw_deg >= 0.0 { pos_map } else { neg_map };
        let yaw_mag = map_degrees(yaw_deg, yaw_map).to_radians();
        let yaw = if yaw_deg >= 0.0 { yaw_mag } else { -yaw_mag };
        locals[node].rotation =
            rest[node].rotation * Quat::from_rotation_y(yaw) * Quat::from_rotation_x(pitch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::LookAtRanges;

    fn ranges() -> LookAtRanges {
        let mut r = LookAtRanges::default();
        r.horizontal_inner.y_range = 8.0;
        r.horizontal_outer.y_range = 12.0;
        r
    }

    #[test]
    fn yaw_clamps_to_per_side_output_range() {
        let rest = vec![NodeTrs::IDENTITY; 2];
        let mut locals = rest.clone();
        // Far past xRange (90°): output must clamp to yRange per side.
        apply_eye_look(&mut locals, &rest, Some(0), Some(1), &ranges(), 500.0, 0.0);
        let left_angle = locals[0].rotation.to_axis_angle().1.to_degrees();
        let right_angle = locals[1].rotation.to_axis_angle().1.to_degrees();
        assert!((left_angle - 12.0).abs() < 1e-3, "outer: {left_angle}");
        assert!((right_angle - 8.0).abs() < 1e-3, "inner: {right_angle}");
    }

    #[test]
    fn yaw_scales_within_range_and_pitch_signs() {
        let rest = vec![NodeTrs::IDENTITY; 2];
        let mut locals = rest.clone();
        // 45° of a 90° xRange = half the output range.
        apply_eye_look(&mut locals, &rest, Some(0), None, &ranges(), 45.0, 0.0);
        let angle = locals[0].rotation.to_axis_angle().1.to_degrees();
        assert!((angle - 6.0).abs() < 1e-3, "half outer: {angle}");

        // Pitch up = +X rotation; down = -X.
        let mut up = rest.clone();
        apply_eye_look(&mut up, &rest, Some(0), None, &ranges(), 0.0, 30.0);
        let (axis, _) = up[0].rotation.to_axis_angle();
        assert!(axis.x > 0.99, "up should rotate about +X, got {axis:?}");
        let mut down = rest.clone();
        apply_eye_look(&mut down, &rest, Some(0), None, &ranges(), 0.0, -30.0);
        let (axis, _) = down[0].rotation.to_axis_angle();
        assert!(axis.x < -0.99, "down should rotate about -X, got {axis:?}");
    }

    #[test]
    fn missing_eyes_are_skipped() {
        let rest = vec![NodeTrs::IDENTITY];
        let mut locals = rest.clone();
        apply_eye_look(&mut locals, &rest, None, Some(7), &ranges(), 30.0, 10.0);
        assert_eq!(locals[0].rotation, Quat::IDENTITY);
    }
}
