//! Worker-owned text services shared by native, WASM, and PSP workers.
#![cfg_attr(not(feature = "legacy"), no_std)]

extern crate alloc;
#[cfg(test)]
extern crate std;

#[cfg(feature = "legacy")]
mod legacy;
#[cfg(feature = "runtime")]
pub mod runtime;
#[cfg(feature = "legacy")]
pub use legacy::*;
#[cfg(all(feature = "legacy", target_arch = "wasm32"))]
mod wasm;
