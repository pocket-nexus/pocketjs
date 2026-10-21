//! Native program composition and the generated UI compatibility surface.
//!
//! [`UiProgram`] owns a `pocket_runtime::Runtime`, package admission, a device
//! input source and the adapter for a host-owned QuickJS realm. A program
//! registers its renderer and display before boot. [`UiSurface`] exposes the
//! same operation context for services, compositor metadata and inspection.
//! Its standalone constructor remains available to low-level harnesses.
//! This crate has no renderer dependency.

mod dbg;
mod pak;
mod program;
mod surface;
pub use pocket_package::profile as program_profile;
pub use program::{ProgramConfig, UiProgram};

pub use pak::{find_pak, walk_pak, PakEntry};
pub use surface::UiSurface;

pub mod offload;
