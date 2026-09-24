//! Borrowed raster resources. Renderers need these views, not the retained
//! tree or the Rust layout of `Ui`. C adapters can implement this contract.
use crate::{TexView, Ui};

#[derive(Clone, Copy)]
pub struct FontView<'a> {
    pub bitmap: &'a [u8],
    pub cell_w: u32,
    pub cell_h: u32,
    pub raster_density: u8,
    pub glyph_count: u16,
}

impl FontView<'_> {
    pub fn coverage_width(&self) -> u32 {
        self.cell_w * self.raster_density as u32
    }
    pub fn coverage_height(&self) -> u32 {
        self.cell_h * self.raster_density as u32
    }
    pub fn bytes_per_row(&self) -> usize {
        self.coverage_width() as usize
    }
    pub fn glyph_rows(&self, gid: u16) -> &[u8] {
        let size = self.coverage_height() as usize * self.bytes_per_row();
        let start = gid as usize * size;
        &self.bitmap[start..start + size]
    }
}

pub trait RenderResources {
    fn viewport(&self) -> (f32, f32);
    fn raster_revision(&self) -> u64;
    fn texture(&self, handle: i32) -> Option<TexView<'_>>;
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>>;
    /// Optional parse-time index of nonzero glyph coverage spans. Resource
    /// adapters that do not own the index retain the dense reference path.
    fn glyph_span_index(&self, _slot: u8) -> Option<&[u8]> {
        None
    }
}

impl RenderResources for Ui {
    fn viewport(&self) -> (f32, f32) {
        Ui::viewport(self)
    }
    fn raster_revision(&self) -> u64 {
        Ui::raster_revision(self)
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        Ui::texture(self, handle)
    }
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>> {
        Ui::font_atlas(self, slot).map(|atlas| FontView {
            bitmap: &atlas.bitmap,
            cell_w: atlas.cell_w,
            cell_h: atlas.cell_h,
            raster_density: atlas.raster_density,
            glyph_count: atlas.glyph_count,
        })
    }
    fn glyph_span_index(&self, slot: u8) -> Option<&[u8]> {
        Ui::font_atlas(self, slot).and_then(|atlas| atlas.glyph_span_index())
    }
}
