//! Fused motion state published by a native motion driver.
//!
//! The driver owns sampling, calibration and fusion; the app receives only the
//! estimates below. Vectors use the W3C/Android device frame: +x toward the
//! right edge, +y toward the top edge, +z out of the screen. Derived values
//! are computed here in f64 and rounded once to f32, as the JavaScript runtime
//! does, so both engines agree to the ulp of their libm.

use crate::spec::motion::{self, quality, reference_frame};
use core::f64::consts::PI;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MotionVector {
    pub value: [f32; 3],
    pub quality: u8,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MotionScalar {
    pub value: f32,
    pub quality: u8,
}

/// Unit quaternion (w, x, y, z) rotating device-frame vectors into `reference_frame`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MotionOrientation {
    pub value: [f32; 4],
    pub quality: u8,
    pub reference_frame: u8,
    /// Increments whenever the driver re-establishes the reference frame.
    pub epoch: u32,
}

/// Degrees clockwise from north with an error estimate (-1 when unknown).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MotionHeading {
    pub value: f32,
    pub accuracy: f32,
    pub quality: u8,
    pub reference_frame: u8,
}

/// One fused estimate. A member with `quality::UNAVAILABLE` is absent.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MotionState {
    /// Microseconds on the driver's monotonic clock: newest sample in the estimate.
    pub timestamp: u64,
    /// Unit vector toward the ground.
    pub gravity_direction: MotionVector,
    /// Degrees between the screen normal and up: 0 face up, 90 upright, 180 face down.
    pub inclination: MotionScalar,
    /// Acceleration without gravity, m/s².
    pub linear_acceleration: MotionVector,
    /// Bias-corrected angular velocity, degrees per second, right-hand rule.
    pub rotation_rate: MotionVector,
    pub orientation: MotionOrientation,
    pub heading: MotionHeading,
}

/// One subscribed value as a handler receives it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MotionSample {
    pub components: [f32; 4],
    pub quality: u8,
    pub reference_frame: u8,
    pub epoch: u32,
    pub timestamp: u64,
}

impl MotionSample {
    pub fn is_present(&self) -> bool {
        self.quality != quality::UNAVAILABLE
    }
    pub fn component(&self, index: u8) -> f32 {
        self.components.get(index as usize).copied().unwrap_or(0.0)
    }
    pub fn quality(&self) -> u8 {
        self.quality
    }
    pub fn reference_frame(&self) -> u8 {
        self.reference_frame
    }
    pub fn epoch(&self) -> u32 {
        self.epoch
    }
    pub fn timestamp(&self) -> u64 {
        self.timestamp
    }
}

const DEGREES: f64 = 180.0 / PI;

fn planar(g: [f32; 3]) -> f64 {
    let (x, y) = (g[0] as f64, g[1] as f64);
    libm::sqrt(x * x + y * y)
}

fn screen_rotation(g: [f32; 3]) -> f32 {
    (libm::atan2(-(g[0] as f64), -(g[1] as f64)) * DEGREES) as f32
}

fn tilt(g: [f32; 3]) -> [f32; 2] {
    let (ux, uy, uz) = (-(g[0] as f64), -(g[1] as f64), -(g[2] as f64));
    let facing = if uz >= 0.0 { 1.0 } else { -1.0 };
    [
        (libm::atan2(uy, facing * libm::sqrt(ux * ux + uz * uz)) * DEGREES) as f32,
        (libm::atan2(-facing * ux, facing * uz) * DEGREES) as f32,
    ]
}

/// The W3C DeviceOrientation worked example over the device-to-world matrix.
fn angles(q: [f32; 4]) -> [f32; 3] {
    let [w, x, y, z] = q.map(|value| value as f64);
    let r12 = 2.0 * (x * y - w * z);
    let r22 = 1.0 - 2.0 * (x * x + z * z);
    let r32 = 2.0 * (y * z + w * x);
    let r31 = 2.0 * (x * z - w * y);
    let r33 = 1.0 - 2.0 * (x * x + y * y);
    let r11 = 1.0 - 2.0 * (y * y + z * z);
    let r21 = 2.0 * (x * y + w * z);
    let asin = |value: f64| libm::asin(value.clamp(-1.0, 1.0));
    let flip = |beta: f64| beta + if beta >= 0.0 { -PI } else { PI };
    let (mut alpha, beta, gamma) = if r33 > 0.0 {
        (libm::atan2(-r12, r22), asin(r32), libm::atan2(-r31, r33))
    } else if r33 < 0.0 {
        (
            libm::atan2(r12, -r22),
            flip(-asin(r32)),
            libm::atan2(r31, -r33),
        )
    } else if r31 > 0.0 {
        (libm::atan2(-r12, r22), asin(r32), -PI / 2.0)
    } else if r31 < 0.0 {
        (libm::atan2(r12, -r22), flip(-asin(r32)), -PI / 2.0)
    } else {
        (
            libm::atan2(r21, r11),
            if r32 > 0.0 { PI / 2.0 } else { -PI / 2.0 },
            0.0,
        )
    };
    if alpha < 0.0 {
        alpha += 2.0 * PI;
    }
    [
        (alpha * DEGREES) as f32,
        (beta * DEGREES) as f32,
        (gamma * DEGREES) as f32,
    ]
}

impl MotionState {
    /// Quality of one value, derived or core, without computing it.
    pub fn quality(&self, value: u8) -> u8 {
        match value {
            motion::GRAVITY_DIRECTION | motion::TILT => self.gravity_direction.quality,
            motion::INCLINATION => self.inclination.quality,
            motion::LINEAR_ACCELERATION => self.linear_acceleration.quality,
            motion::ROTATION_RATE => self.rotation_rate.quality,
            motion::ORIENTATION | motion::ANGLES => self.orientation.quality,
            motion::HEADING => self.heading.quality,
            motion::SCREEN_ROTATION => {
                let source = self.gravity_direction.quality;
                if planar(self.gravity_direction.value) < motion::SCREEN_ROTATION_MIN_PLANAR {
                    source.min(quality::UNRELIABLE)
                } else {
                    source
                }
            }
            _ => quality::UNAVAILABLE,
        }
    }

    /// One value as a handler sees it; absent below `min_quality`.
    pub fn sample(&self, value: u8, min_quality: u8) -> MotionSample {
        let quality = self.quality(value);
        if quality == quality::UNAVAILABLE || quality < min_quality {
            return MotionSample::default();
        }
        let mut sample = MotionSample {
            quality,
            reference_frame: reference_frame::DEVICE,
            timestamp: self.timestamp,
            ..MotionSample::default()
        };
        let mut set =
            |components: &[f32]| sample.components[..components.len()].copy_from_slice(components);
        match value {
            motion::GRAVITY_DIRECTION => set(&self.gravity_direction.value),
            motion::INCLINATION => set(&[self.inclination.value]),
            motion::LINEAR_ACCELERATION => set(&self.linear_acceleration.value),
            motion::ROTATION_RATE => set(&self.rotation_rate.value),
            motion::ORIENTATION => set(&self.orientation.value),
            motion::HEADING => set(&[self.heading.value, self.heading.accuracy]),
            motion::SCREEN_ROTATION => set(&[screen_rotation(self.gravity_direction.value)]),
            motion::TILT => set(&tilt(self.gravity_direction.value)),
            motion::ANGLES => set(&angles(self.orientation.value)),
            _ => {}
        }
        match value {
            motion::ORIENTATION | motion::ANGLES => {
                sample.reference_frame = self.orientation.reference_frame;
                sample.epoch = self.orientation.epoch;
            }
            motion::HEADING => sample.reference_frame = self.heading.reference_frame,
            _ => {}
        }
        sample
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upright(gravity: [f32; 3]) -> MotionState {
        MotionState {
            timestamp: 7,
            gravity_direction: MotionVector {
                value: gravity,
                quality: quality::HIGH,
            },
            ..MotionState::default()
        }
    }

    #[test]
    fn screen_rotation_keeps_content_upright_and_distrusts_a_flat_screen() {
        // Portrait: gravity toward the bottom edge.
        assert_eq!(
            upright([0.0, -1.0, 0.0])
                .sample(motion::SCREEN_ROTATION, quality::LOW)
                .component(0),
            0.0
        );
        // Device turned 90 degrees counter-clockwise: gravity toward the left edge.
        let turned = upright([-1.0, 0.0, 0.0]).sample(motion::SCREEN_ROTATION, quality::LOW);
        assert_eq!((turned.component(0), turned.timestamp()), (90.0, 7));
        let flat = upright([0.05, -0.05, -0.997]);
        assert_eq!(flat.quality(motion::SCREEN_ROTATION), quality::UNRELIABLE);
        assert!(
            !flat
                .sample(motion::SCREEN_ROTATION, quality::LOW)
                .is_present()
        );
        assert!(
            flat.sample(motion::SCREEN_ROTATION, quality::UNRELIABLE)
                .is_present()
        );
    }

    #[test]
    fn tilt_follows_the_w3c_beta_and_gamma_conventions() {
        assert_eq!(
            upright([0.0, 0.0, -1.0])
                .sample(motion::TILT, quality::LOW)
                .components[..2],
            [0.0, 0.0]
        );
        assert_eq!(
            upright([0.0, -1.0, 0.0])
                .sample(motion::TILT, quality::LOW)
                .component(0),
            90.0
        );
        // Right edge lowered while face up: gamma is positive.
        let [beta, gamma] = tilt([0.5, 0.0, -0.8660254]);
        assert!(beta.abs() < 1e-4 && (gamma - 30.0).abs() < 1e-4);
    }

    #[test]
    fn angles_of_the_identity_and_of_a_yaw() {
        let state = |q: [f32; 4]| MotionState {
            orientation: MotionOrientation {
                value: q,
                quality: quality::MEDIUM,
                reference_frame: reference_frame::LOCAL,
                epoch: 2,
            },
            ..MotionState::default()
        };
        let identity = state([1.0, 0.0, 0.0, 0.0]).sample(motion::ANGLES, quality::LOW);
        assert_eq!(
            (
                identity.components[..3].to_vec(),
                identity.reference_frame(),
                identity.epoch()
            ),
            ([0.0, 0.0, 0.0].to_vec(), reference_frame::LOCAL, 2)
        );
        let half = core::f32::consts::FRAC_1_SQRT_2;
        let yaw = state([half, 0.0, 0.0, half]).sample(motion::ANGLES, quality::LOW);
        assert!((yaw.component(0) - 90.0).abs() < 1e-3);
        assert!(
            !state([1.0, 0.0, 0.0, 0.0])
                .sample(motion::ANGLES, quality::HIGH)
                .is_present()
        );
    }
}
