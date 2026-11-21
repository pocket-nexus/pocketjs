//! Forwarding crate for `pocket_render::tex_cache`.
//!
//! Every item keeps its `pocket_tex_cache` path and is the `pocket_render`
//! item itself. New code depends on `pocket-render`.

#![no_std]

pub use pocket_render::tex_cache::*;
