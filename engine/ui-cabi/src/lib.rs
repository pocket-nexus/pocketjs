//! Compatibility crate for native hosts awaiting instance registration.
//! The implementation and its allocator are owned by pocket-runtime-cabi.
#![cfg_attr(not(feature = "std"), no_std)]
#[cfg(all(feature = "std", feature = "bare-platform"))]
compile_error!("bare-platform requires --no-default-features; enable standalone-extension-provider when using the stock archive");
pub use pocket_runtime_cabi::compat::ui::*;
#[cfg(not(feature = "std"))]
mod host_hooks;
