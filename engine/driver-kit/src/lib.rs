#![no_std]
//! Driver conformance checks for use in a driver's own CI.
//!
//! Device stop events must come from an independent completion probe, not from
//! the return of `wait` alone. No host test proves a physical device stopped.
//! The crate requires `alloc`; it has no platform or core UI dependencies.
extern crate alloc;

pub mod lifecycle;
pub mod pixels;
pub mod sources;
pub mod test_device;

pub use lifecycle::{Event, Lifecycle, Violation, ViolationKind};
pub use pixels::{check_cpu_frame, PixelViolation};
pub use sources::{
    check_input, check_package_admission, check_package_source, check_package_transfer,
    SourceViolation,
};
