//! The C SDK archive: one definition of every `pocket_runtime.h` symbol, over
//! the bodies in `pocket_runtime::abi` and the tool crates, with the allocator,
//! panic handler and `pocket_host_*` implementations a link unit needs.
#![cfg_attr(not(feature = "std"), no_std)]
extern crate alloc;
mod glyph;
mod hooks;
#[cfg(feature = "physics")]
mod physics;
mod raster;
mod runtime;
mod timing;
pub use glyph::*;
pub use raster::*;
pub use runtime::*;
pub use timing::*;
