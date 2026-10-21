//! Borrowed resource views, independent of the retained UI tree.

/// Borrowed view of one live texture (what backends sample — see
/// `Ui::texture` / `Ui::texture_at`). All byte slices are 16-byte aligned.
#[derive(Clone, Copy)]
pub struct TexView<'a> {
    pub pixels: &'a [u8],
    pub w: u32,
    pub h: u32,
    /// spec::psm::* pixel format.
    pub psm: u32,
    /// 1024-byte CLUT (256 x u32 ABGR) — Some exactly when psm == PSM_T8.
    pub palette: Option<&'a [u8]>,
    /// Bilinear sampling hint (spec::img::FLAG_LINEAR); nearest otherwise.
    pub linear: bool,
}

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
}
