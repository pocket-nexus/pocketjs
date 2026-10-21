//! Borrowed raster resources. Renderers need these views, not the retained
//! tree or the Rust layout of `Ui`. C adapters can implement this contract.
use crate::{TexView, Ui};

pub use pocket_drivers::{FontView, RenderResources};

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
}
