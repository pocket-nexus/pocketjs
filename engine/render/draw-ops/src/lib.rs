//! Forwarding crate for the DrawList decoder in `pocket-render`.
//!
//! Every item keeps its `pocket_draw_ops` path and is the `pocket_render`
//! item itself. New code depends on `pocket-render`.

#![no_std]

pub use pocket_render::{
    append_batch, batch, build, gradient_corners, logical_rect, quad, record, triangle, validate,
    wh, word_len, xy, Backend, Batch, Corners, DecodeError, DrawOps, Emit, Fill, GlyphCell,
    Operation, Record, Source, Vertex, DRAW_LIST_VERSION, MAX_CLIP_DEPTH,
};
