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
    fn texture_revision(&self, handle: i32) -> Option<u64> {
        Ui::texture_revision(self, handle)
    }
    fn font_revision(&self, slot: u8) -> Option<u64> {
        Ui::font_atlas(self, slot).map(|_| Ui::font_atlas_revision(self, slot))
    }
    fn font_texture_width(&self, slot: u8) -> Option<u32> {
        Ui::font_atlas(self, slot).map(|atlas| atlas.texture_coverage_width())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn individual_texture_revisions_survive_unrelated_resource_mutations() {
        let mut ui = Ui::new();
        let first = ui.upload_texture(&[255; 4], 1, 1, crate::spec::psm::PSM_8888);
        assert!(first >= 0);
        let first_revision = RenderResources::texture_revision(&ui, first).unwrap();
        let global_revision = RenderResources::raster_revision(&ui);
        let second = ui.upload_texture(&[0; 4], 1, 1, crate::spec::psm::PSM_8888);
        assert!(second >= 0);
        assert_ne!(RenderResources::raster_revision(&ui), global_revision);
        assert_eq!(
            RenderResources::texture_revision(&ui, first),
            Some(first_revision)
        );
        ui.free_texture(first);
        assert_eq!(RenderResources::texture_revision(&ui, first), None);
        assert!(RenderResources::texture_revision(&ui, second).is_some());
        assert_eq!(RenderResources::font_revision(&ui, 0), None);
        assert_eq!(RenderResources::font_texture_width(&ui, 0), None);
    }
}
