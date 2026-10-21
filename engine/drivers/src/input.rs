//! Tick-sampled input. Drivers append facts; the runtime encodes wire frames.

use crate::abi;
use alloc::{string::String, vec::Vec};
use core::ops::{BitOr, BitOrAssign};

/// Append-only class bits generated from contracts/spec/input.ts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputClasses(u32);

impl InputClasses {
    pub const NONE: Self = Self(0);
    pub const BUTTONS: Self = Self(abi::POCKET_INPUT_CLASS_BUTTONS);
    pub const AXIS_ABSOLUTE: Self = Self(abi::POCKET_INPUT_CLASS_AXIS_ABSOLUTE);
    pub const AXIS_RELATIVE: Self = Self(abi::POCKET_INPUT_CLASS_AXIS_RELATIVE);
    pub const POINTER: Self = Self(abi::POCKET_INPUT_CLASS_POINTER);
    pub const CONTACT: Self = Self(abi::POCKET_INPUT_CLASS_CONTACT);
    pub const TEXT: Self = Self(abi::POCKET_INPUT_CLASS_TEXT);
    pub const MOTION: Self = Self(abi::POCKET_INPUT_CLASS_MOTION);

    pub const fn bits(self) -> u32 {
        self.0
    }
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
}

impl BitOr for InputClasses {
    type Output = Self;
    fn bitor(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
}
impl BitOrAssign for InputClasses {
    fn bitor_assign(&mut self, other: Self) {
        self.0 |= other.0;
    }
}

/// Stick axes 0..=3 use 0..=255 with 128 at rest; Runtime packs these
/// device samples into legacy axis words without normalizing -1..=1.
/// Other axis IDs use their protocol's units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AxisSample {
    pub id: u32,
    pub value: f32,
}

/// Relative axes preserve signed integer units from the existing input wire
/// contract (including millidegrees for rotating controls).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AxisDelta {
    pub id: u32,
    pub delta: i32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pointer {
    pub surface: u32,
    pub x: f32,
    pub y: f32,
    pub buttons: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Contact {
    pub surface: u32,
    pub id: u32,
    pub x: f32,
    pub y: f32,
    pub cancelled: bool,
}

/// Cancellation names both the surface and contact; identical contact ids on
/// separate screens cannot cancel each other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CancelledContact {
    pub surface: u32,
    pub id: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum TextEvent {
    Key {
        key: String,
        pressed: bool,
        repeat: bool,
    },
    Commit(String),
    Composition {
        text: String,
        selection_start: u32,
        selection_end: u32,
    },
    CompositionEnd,
}

/// Fused motion values and metadata are generated from contracts/spec/motion.ts.
#[derive(Default)]
#[non_exhaustive]
pub struct MotionState {
    pub timestamp: u64,
    pub gravity_direction: Option<abi::PocketMotionGravityDirection>,
    pub inclination: Option<abi::PocketMotionInclination>,
    pub linear_acceleration: Option<abi::PocketMotionLinearAcceleration>,
    pub rotation_rate: Option<abi::PocketMotionRotationRate>,
    pub orientation: Option<abi::PocketMotionOrientation>,
    pub heading: Option<abi::PocketMotionHeading>,
    pub screen_rotation: Option<abi::PocketMotionScreenRotation>,
    pub tilt: Option<abi::PocketMotionTilt>,
    pub angles: Option<abi::PocketMotionAngles>,
}

#[non_exhaustive]
pub struct InputFrame<'a> {
    pub buttons: u32,
    pub axes: &'a [AxisSample],
    pub relative: &'a [AxisDelta],
    pub pointer: Option<Pointer>,
    pub contacts: &'a [Contact],
    pub cancelled: &'a [CancelledContact],
    pub text: &'a [TextEvent],
    pub motion: Option<&'a MotionState>,
}

/// One runtime-owned accumulator reused between ticks. Contributions append
/// to vectors and OR button bits. The program chooses one pointer and motion
/// provider; assigning either singleton replaces the previous contribution.
#[derive(Default)]
#[non_exhaustive]
pub struct InputFrameBuilder {
    pub buttons: u32,
    pub axes: Vec<AxisSample>,
    pub relative: Vec<AxisDelta>,
    pub pointer: Option<Pointer>,
    pub contacts: Vec<Contact>,
    pub cancelled: Vec<CancelledContact>,
    pub text: Vec<TextEvent>,
    pub motion: Option<MotionState>,
}

impl InputFrameBuilder {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn frame(&self) -> InputFrame<'_> {
        InputFrame {
            buttons: self.buttons,
            axes: &self.axes,
            relative: &self.relative,
            pointer: self.pointer,
            contacts: &self.contacts,
            cancelled: &self.cancelled,
            text: &self.text,
            motion: self.motion.as_ref(),
        }
    }
    pub fn clear(&mut self) {
        self.buttons = 0;
        self.axes.clear();
        self.relative.clear();
        self.pointer = None;
        self.contacts.clear();
        self.cancelled.clear();
        self.text.clear();
        self.motion = None;
    }
}

pub trait InputSource {
    fn classes(&self) -> InputClasses;
    fn poll(&mut self, frame: &mut InputFrameBuilder);
}
