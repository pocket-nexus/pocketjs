//! Device contracts shared by the UI core, runtime, and external drivers.
//!
//! This crate has no platform or runtime dependency. The `abi` module is
//! generated from `contracts/spec`; the remaining modules provide borrowed
//! Rust interfaces. Driver registration and presentation scheduling belong
//! to the runtime and are not implemented here.

#![no_std]

extern crate alloc;

pub mod abi;
pub mod clock;
pub mod damage_rect;
pub mod display;
pub mod draw;
pub mod input;
pub mod package;
pub mod render;
pub mod resources;

pub use clock::Clock;
pub use damage_rect::DamageRect;
pub use display::*;
pub use draw::{DrawList, TextBox};
pub use input::*;
pub use package::{PackageSource, SourceError};
pub use pocket_spec as spec;
pub use render::*;
pub use resources::{FontView, RenderResources, TexView};
