//! Prefix-compatible C boundary for the instance runtime and device drivers.
#![cfg_attr(not(feature = "std"), no_std)]
extern crate alloc;
pub mod adapters;
#[cfg(any(feature = "legacy-ui", feature = "legacy-idf"))]
pub mod compat;
mod guest;
mod hooks;
mod provider;
mod runtime;
pub use runtime::*;
pub mod raster;
pub use pocket_drivers::abi;
