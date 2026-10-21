//! Legacy IDF entry points, implemented by the instance runtime archive.
#![cfg_attr(not(feature="std"),no_std)]
pub use pocket_runtime_cabi::compat::idf::ui::*;
// Include the legacy render entry points in this one static library.
pub use pocket_runtime_cabi::compat::idf::render::*;
