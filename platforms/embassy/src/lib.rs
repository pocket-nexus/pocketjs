//! Embassy pacing and a CPU display adapter. Programs own Runtime and driver composition.
#![no_std]
extern crate alloc;
pub mod display;
#[cfg(feature = "runner")]
pub mod runner;
