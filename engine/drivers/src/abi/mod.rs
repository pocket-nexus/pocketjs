//! The C ABI of the driver and runtime contracts.
//!
//! `generated` holds the records, constants, callback types and function
//! declarations that `tools/driver-contracts.ts` writes from `contracts/spec`.
//! The primitives check a foreign pointer, count and record prefix before any
//! Rust reference is formed. The adapters cross the boundary in both
//! directions: `CDisplay`, `CRenderer`, `CInputSource`, `CPackageSource` and
//! `CResources` implement the device traits over a C vtable, and
//! `ResourceBridge` presents a Rust `RenderResources` to a C renderer.
//! Adapter constructors are unsafe because callbacks and storage must remain
//! valid and obey the driver ABI through adapter destruction.
mod generated;
pub use generated::*;

mod primitives;
pub use primitives::{borrowed, pixel_format, rect, writable, AdapterError};
use primitives::{c_rect, check, display_error, ownership, record_array, render_error, vsync};

mod display;
mod input;
mod package;
mod renderer;
mod resources;
pub use display::CDisplay;
pub use input::{decode_input_frame, CInputSource};
pub use package::CPackageSource;
pub use renderer::CRenderer;
pub use resources::{CResources, ResourceBridge};
