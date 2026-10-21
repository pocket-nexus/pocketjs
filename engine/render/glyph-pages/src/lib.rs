//! Font coverage expansion and driver-owned page storage.
//!
//! Source views borrow immutable font bytes. A8 output owns its storage; the
//! caller uploads it or blends a mask. ABGR4444 pages retain each submission's
//! references until that submission retires after GPU completion.
#![no_std]
extern crate alloc;

mod layout;
mod mask;
mod page_cache;

pub use layout::{GlyphPageLayout, GlyphSampler, GlyphSource};
pub use mask::{blend_glyph_run, composite_mask, fill_mask_rect};
pub use page_cache::{FontPage, FontPages, MAX_PAGES, PAGE_DIM, PAGE_WIDTH};
