//! Attitude and heading from the BMI270 and BMM150 as the screen sees them:
//! x along the panel to the right, y up the panel, z out of it. The sensor
//! axes map as the vendor's Compass app establishes (CardputerZero/Compass,
//! compass_pose.cpp).

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub const fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }
    pub fn dot(self, other: Vec3) -> f32 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }
    pub fn cross(self, other: Vec3) -> Vec3 {
        Vec3::new(
            self.y * other.z - self.z * other.y,
            self.z * other.x - self.x * other.z,
            self.x * other.y - self.y * other.x,
        )
    }
    pub fn scale(self, factor: f32) -> Vec3 {
        Vec3::new(self.x * factor, self.y * factor, self.z * factor)
    }
    pub fn sub(self, other: Vec3) -> Vec3 {
        Vec3::new(self.x - other.x, self.y - other.y, self.z - other.z)
    }
    pub fn add(self, other: Vec3) -> Vec3 {
        Vec3::new(self.x + other.x, self.y + other.y, self.z + other.z)
    }
    pub fn norm(self) -> f32 {
        self.dot(self).sqrt()
    }
    pub fn normalized(self, minimum: f32) -> Option<Vec3> {
        let norm = self.norm();
        if !norm.is_finite() || norm < minimum {
            None
        } else {
            Some(self.scale(1.0 / norm))
        }
    }
    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite()
    }
}

/// BMI270 axes to screen axes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn accel_to_screen(raw: Vec3) -> Vec3 {
    Vec3::new(raw.y, -raw.x, raw.z)
}

/// BMM150 axes to screen axes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn mag_to_screen(raw: Vec3) -> Vec3 {
    Vec3::new(raw.y, raw.x, -raw.z)
}

/// Pitch and roll in degrees and the level's bubble: `bubble_x` and
/// `bubble_y` in -1..1 saturate at `BUBBLE_RANGE_DEG`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pose {
    pub pitch_deg: f32,
    pub roll_deg: f32,
    pub bubble_x: f32,
    pub bubble_y: f32,
    /// The bearing the top edge of the panel points to, 0..360, when a
    /// magnetic field is known.
    pub heading_deg: Option<f32>,
}

pub const BUBBLE_RANGE_DEG: f32 = 18.0;
const MINIMUM_NORM: f32 = 1.0e-5;
const MINIMUM_FORWARD_NORM: f32 = 0.05;

fn clamp_unit(value: f32) -> f32 {
    value.clamp(-1.0, 1.0)
}

pub fn normalize_degrees(degrees: f32) -> f32 {
    let wrapped = degrees % 360.0;
    if wrapped < 0.0 {
        wrapped + 360.0
    } else {
        wrapped
    }
}

/// The pose of a panel whose acceleration (gravity reaction, m/s², screen
/// axes) and magnetic field (screen axes) are known.
pub fn pose(accel: Vec3, mag: Option<Vec3>) -> Pose {
    let mut out = Pose::default();
    if !accel.is_finite() {
        return out;
    }
    let pitch = accel.y.atan2(accel.x.hypot(accel.z));
    let roll = accel.x.atan2(accel.y.hypot(accel.z));
    out.pitch_deg = pitch.to_degrees();
    out.roll_deg = roll.to_degrees();
    out.bubble_x = clamp_unit(out.roll_deg / BUBBLE_RANGE_DEG);
    out.bubble_y = clamp_unit(-out.pitch_deg / BUBBLE_RANGE_DEG);
    let Some(mag) = mag.filter(|m| m.is_finite()) else {
        return out;
    };
    let Some(up) = accel.normalized(MINIMUM_NORM) else {
        return out;
    };
    let top = Vec3::new(0.0, 1.0, 0.0);
    let Some(forward) = top.sub(up.scale(top.dot(up))).normalized(MINIMUM_FORWARD_NORM) else {
        return out;
    };
    let Some(north) = mag.sub(up.scale(mag.dot(up))).normalized(MINIMUM_NORM) else {
        return out;
    };
    let Some(mut right) = forward.cross(up).normalized(MINIMUM_NORM) else {
        return out;
    };
    // Face down, the projected top edge is the same but cross(forward, up)
    // flips: keep the right edge along +x so turning right reads clockwise.
    if right.x < 0.0 {
        right = right.scale(-1.0);
    }
    // The bearing of the top edge: the angle from forward round to north,
    // clockwise. North to the right means the panel points west.
    let east = north.dot(right);
    let ahead = north.dot(forward);
    out.heading_deg = Some(normalize_degrees(-east.atan2(ahead).to_degrees()));
    out
}

/// A first-order low-pass: `alpha` of the new sample per step.
pub fn smooth(previous: Vec3, sample: Vec3, alpha: f32) -> Vec3 {
    previous.add(sample.sub(previous).scale(alpha))
}

/// Hard-iron calibration: the midpoint of the extremes seen while the device
/// turned through every direction.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MagCalibration {
    pub min: Vec3,
    pub max: Vec3,
    pub samples: u32,
}

impl Default for MagCalibration {
    fn default() -> Self {
        Self {
            min: Vec3::new(f32::MAX, f32::MAX, f32::MAX),
            max: Vec3::new(f32::MIN, f32::MIN, f32::MIN),
            samples: 0,
        }
    }
}

impl MagCalibration {
    pub fn feed(&mut self, sample: Vec3) {
        self.min = Vec3::new(self.min.x.min(sample.x), self.min.y.min(sample.y), self.min.z.min(sample.z));
        self.max = Vec3::new(self.max.x.max(sample.x), self.max.y.max(sample.y), self.max.z.max(sample.z));
        self.samples += 1;
    }
    /// The offset to subtract from raw fields, once each axis has swung
    /// through more than `span` of field.
    pub fn offset(&self, span: f32) -> Option<Vec3> {
        if self.samples == 0 {
            return None;
        }
        let extent = self.max.sub(self.min);
        if extent.x < span || extent.y < span || extent.z < span {
            return None;
        }
        Some(self.min.add(self.max).scale(0.5))
    }
    /// How much of a full turn the extremes cover so far, 0..1, against
    /// `span` per axis.
    pub fn progress(&self, span: f32) -> f32 {
        if self.samples == 0 {
            return 0.0;
        }
        let extent = self.max.sub(self.min);
        ((extent.x / span).min(1.0) + (extent.y / span).min(1.0) + (extent.z / span).min(1.0)) / 3.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flat_panel_is_level_and_tilts_read_in_degrees() {
        let flat = pose(Vec3::new(0.0, 0.0, 9.81), None);
        assert!(flat.pitch_deg.abs() < 1e-3 && flat.roll_deg.abs() < 1e-3);
        assert_eq!(flat.heading_deg, None);
        // Top edge raised: gravity reaction gains +y.
        let raised = pose(Vec3::new(0.0, 9.81 * (10f32.to_radians()).sin(), 9.81 * (10f32.to_radians()).cos()), None);
        assert!((raised.pitch_deg - 10.0).abs() < 0.01, "{}", raised.pitch_deg);
        assert!((raised.bubble_y + 10.0 / BUBBLE_RANGE_DEG).abs() < 1e-3);
        let rolled = pose(Vec3::new(9.81 * (30f32.to_radians()).sin(), 0.0, 9.81 * (30f32.to_radians()).cos()), None);
        assert!((rolled.roll_deg - 30.0).abs() < 0.01);
        assert!((rolled.bubble_x - 1.0).abs() < 1e-6);
    }

    #[test]
    fn heading_is_the_bearing_of_the_top_edge() {
        let up = Vec3::new(0.0, 0.0, 9.81);
        let north_ahead = pose(up, Some(Vec3::new(0.0, 30.0, -40.0))).heading_deg.unwrap();
        assert!(north_ahead.abs() < 1e-3 || (north_ahead - 360.0).abs() < 1e-3, "{north_ahead}");
        // North to the panel's right: the panel points west.
        let north_right = pose(up, Some(Vec3::new(30.0, 0.0, -40.0))).heading_deg.unwrap();
        assert!((north_right - 270.0).abs() < 1e-3, "{north_right}");
        // North behind: south.
        let north_behind = pose(up, Some(Vec3::new(0.0, -30.0, -40.0))).heading_deg.unwrap();
        assert!((north_behind - 180.0).abs() < 1e-3, "{north_behind}");
        // Face down, the same field reads the same bearing.
        let face_down = pose(Vec3::new(0.0, 0.0, -9.81), Some(Vec3::new(30.0, 0.0, -40.0))).heading_deg.unwrap();
        assert!((face_down - 270.0).abs() < 1e-3, "{face_down}");
    }

    #[test]
    fn calibration_needs_a_full_turn_and_centres_the_field() {
        let mut calibration = MagCalibration::default();
        assert_eq!(calibration.offset(40.0), None);
        for step in 0..72 {
            let angle = (step as f32 * 5.0).to_radians();
            calibration.feed(Vec3::new(10.0 + 30.0 * angle.cos(), -5.0 + 30.0 * angle.sin(), 20.0 + 30.0 * (angle * 2.0).sin()));
        }
        let offset = calibration.offset(40.0).unwrap();
        assert!((offset.x - 10.0).abs() < 0.5 && (offset.y + 5.0).abs() < 0.5 && (offset.z - 20.0).abs() < 0.5);
        assert!(calibration.progress(40.0) > 0.99);
        assert_eq!(accel_to_screen(Vec3::new(1.0, 2.0, 3.0)), Vec3::new(2.0, -1.0, 3.0));
        assert_eq!(mag_to_screen(Vec3::new(1.0, 2.0, 3.0)), Vec3::new(2.0, 1.0, -3.0));
    }
}
