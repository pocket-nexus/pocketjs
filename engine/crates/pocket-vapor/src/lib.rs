//! Runtime for Vue SFCs compiled to native Rust. The retained tree belongs to core.
#![no_std]

extern crate alloc;

pub mod blocks;
pub mod builtins;
pub mod display;
pub mod host;
pub mod input;
pub mod spec;
mod ui;

pub use alloc::{string::String, vec::Vec};
pub use blocks::{Block, KeyedList, KeyedRow, SlotBlock, SlotHandle, SlotRegistry};
pub use display::format_color;
pub use display::{
    DisplayValue, TemplateOptionDisplay, TextMemo, VaporDisplay, display, formatted_eq,
    template_option_display,
};
pub use host::{CoreHost, HasButton, HasButtons, HasRelativeAxis, HasTouch, Host};
pub use input::{ButtonLatch, Dispatch, DispatchCursor, DispatchFn, EventSink, dispatch_fn};
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
