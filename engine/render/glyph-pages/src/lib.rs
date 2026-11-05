//! Forwarding crate for `pocket_render::glyph_pages`.
//!
//! Every item keeps its `pocket_glyph_pages` path and is the `pocket_render`
//! item itself. New code depends on `pocket-render`.

#![no_std]

pub use pocket_render::glyph_pages::*;
