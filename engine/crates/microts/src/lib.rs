//! Runtime for Vue SFCs compiled to native Rust. The retained tree belongs to core.
//!
//! # Targets without native 32-bit atomic CAS
//!
//! Model mount identities use `core::sync::atomic::AtomicU32` when the target
//! supports it. Other targets use `portable-atomic`, including the atomics in
//! the re-exported `heapless` containers. **The host selects the fallback.**
//!
//! Hosts with a `critical-section` implementation can enable MicroTS's
//! `critical-section` feature. The final binary must provide an implementation
//! that excludes every context accessing these atomics and restores the prior
//! interrupt state on exit. The feature does not install an implementation.
//!
//! Hosts can instead select another backend supported by `portable-atomic`,
//! such as its `portable_atomic_unsafe_assume_single_core` cfg on supported
//! single-core targets. That cfg must apply to dependencies through rustflags;
//! the host must meet the backend's safety requirements. Do not combine it
//! with the `critical-section` feature. See the
//! [portable-atomic safety requirements](https://docs.rs/portable-atomic/latest/portable_atomic/#optional-featurescfgs).
//!
//! **Targets with native 32-bit atomics keep the native implementation** and
//! do not need a fallback or a critical-section provider.
#![no_std]

extern crate alloc;

pub mod blocks;
pub mod builtins;
pub mod display;
pub mod host;
pub mod input;
pub mod model;
pub mod model_regions;
pub mod motion;
pub mod spec;
mod ui;

pub use alloc::{string::String, vec::Vec};
pub use blocks::{Block, KeyedList, KeyedRow, SlotBlock, SlotHandle, SlotRegistry};
pub use display::format_color;
pub use display::{
    DisplayValue, TemplateOptionDisplay, TextMemo, MicroTsDisplay, display, formatted_eq,
    template_option_display,
};
pub use host::{CoreHost, HasButton, HasButtons, HasMotion, HasRelativeAxis, HasTouch, Host};
pub use input::{ButtonLatch, Dispatch, DispatchCursor, DispatchFn, EventSink, dispatch_fn};
pub use model::{Cmd, NodeSlot, Ready, RequestId, TaskId};
pub use model_regions::{CommandQueue, ModelPhase, ModelRegions, New};
pub use motion::{
    MotionAngles, MotionHeading, MotionOrientation, MotionPair, MotionSample, MotionScalar,
    MotionState, MotionVector,
};
pub use pocketjs_core;
pub use ui::{Input, NodeId, StyleId, Ui};

/// One pending update, regardless of how many handlers or host mutations occurred.
#[derive(Clone, Copy, Debug)]
pub struct Invalidation {
    pending: bool,
}

impl Default for Invalidation {
    fn default() -> Self {
        Self { pending: true }
    }
}

impl Invalidation {
    pub fn invalidate(&mut self) {
        self.pending = true;
    }
    pub fn is_pending(&self) -> bool {
        self.pending
    }
    pub fn take(&mut self) -> bool {
        core::mem::take(&mut self.pending)
    }
}
