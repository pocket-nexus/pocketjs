//! Rust source compatibility for the legacy IDF renderer.
#![cfg_attr(not(feature="std"),no_std)]
pub use pocket_runtime_cabi::compat::idf::render::*;
