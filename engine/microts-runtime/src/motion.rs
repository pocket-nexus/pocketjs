//! Fused motion state published by a native motion driver.
//!
//! The driver owns sampling, calibration and fusion, and derives the angle
//! conveniences from its core members; the app receives only the estimates
//! below and the runtime reads them without computing on them. Vectors use the
//! W3C/Android device frame: +x toward the right edge, +y toward the top edge,
//! +z out of the screen.

use crate::spec::motion::{self, quality, reference_frame};

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

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MotionPair {
    pub value: [f32; 2],
    pub quality: u8,
}

/// Angles in degrees within an orientation's reference frame and epoch.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MotionAngles {
    pub value: [f32; 3],
    pub quality: u8,
    pub reference_frame: u8,
    pub epoch: u32,
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
    /// Derived from `gravity_direction`: clockwise degrees in (-180, 180] that
    /// keep content upright; unreliable while the screen lies near horizontal.
    pub screen_rotation: MotionScalar,
    /// Derived from `gravity_direction`: W3C DeviceOrientation beta and gamma.
    pub tilt: MotionPair,
    /// Derived from `orientation`: W3C DeviceOrientation alpha, beta and gamma.
    pub angles: MotionAngles,
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

impl MotionState {
    /// Quality of one value, core or derived.
    pub fn quality(&self, value: u8) -> u8 {
        match value {
            motion::GRAVITY_DIRECTION => self.gravity_direction.quality,
            motion::INCLINATION => self.inclination.quality,
            motion::LINEAR_ACCELERATION => self.linear_acceleration.quality,
            motion::ROTATION_RATE => self.rotation_rate.quality,
            motion::ORIENTATION => self.orientation.quality,
            motion::HEADING => self.heading.quality,
            motion::SCREEN_ROTATION => self.screen_rotation.quality,
            motion::TILT => self.tilt.quality,
            motion::ANGLES => self.angles.quality,
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
            motion::SCREEN_ROTATION => set(&[self.screen_rotation.value]),
            motion::TILT => set(&self.tilt.value),
            motion::ANGLES => set(&self.angles.value),
            _ => {}
        }
        match value {
            motion::ORIENTATION => {
                sample.reference_frame = self.orientation.reference_frame;
                sample.epoch = self.orientation.epoch;
            }
            motion::ANGLES => {
                sample.reference_frame = self.angles.reference_frame;
                sample.epoch = self.angles.epoch;
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

    #[test]
    fn samples_read_driver_values_with_their_metadata() {
        let state = MotionState {
            timestamp: 7,
            screen_rotation: MotionScalar {
                value: 90.0,
                quality: quality::MEDIUM,
            },
            tilt: MotionPair {
                value: [12.5, -30.0],
                quality: quality::HIGH,
            },
            angles: MotionAngles {
                value: [90.0, 0.0, 0.0],
                quality: quality::MEDIUM,
                reference_frame: reference_frame::LOCAL,
                epoch: 2,
            },
            ..MotionState::default()
        };
        let upright = state.sample(motion::SCREEN_ROTATION, quality::LOW);
        assert_eq!(
            (upright.component(0), upright.quality(), upright.timestamp()),
            (90.0, quality::MEDIUM, 7)
        );
        assert_eq!(
            state.sample(motion::TILT, quality::HIGH).components[..2],
            [12.5, -30.0]
        );
        let angles = state.sample(motion::ANGLES, quality::LOW);
        assert_eq!(
            (
                angles.component(0),
                angles.reference_frame(),
                angles.epoch()
            ),
            (90.0, reference_frame::LOCAL, 2)
        );
    }

    #[test]
    fn quality_gates_and_absent_values_stay_unavailable() {
        let state = MotionState {
            screen_rotation: MotionScalar {
                value: 3.0,
                quality: quality::UNRELIABLE,
            },
            ..MotionState::default()
        };
        assert!(
            !state
                .sample(motion::SCREEN_ROTATION, quality::LOW)
                .is_present()
        );
        assert!(
            state
                .sample(motion::SCREEN_ROTATION, quality::UNRELIABLE)
                .is_present()
        );
        assert!(
            !state
                .sample(motion::ANGLES, quality::UNRELIABLE)
                .is_present()
        );
        assert_eq!(state.quality(motion::TILT), quality::UNAVAILABLE);
    }
}
