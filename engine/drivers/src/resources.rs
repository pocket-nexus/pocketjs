//! Borrowed resource views, independent of the retained UI tree.

/// Borrowed view of one live texture. Core-owned storage is 16-byte aligned;
/// external resource providers may supply byte-aligned storage. Drivers check
/// alignment before passing pointers to device APIs that require it.
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
    /// [`raster_revision`](Self::raster_revision) less in-place texture
    /// pixel writes. Resources that do not report
    /// [`texture_revision`](Self::texture_revision) per texture keep the
    /// default: every change repaints the whole target.
    fn resource_revision(&self) -> u64 {
        self.raster_revision()
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>>;
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>>;
    /// Version of a live texture's content. The default invalidates on any
    /// raster mutation; drivers must pair this with the generation-tagged handle.
    fn texture_revision(&self, handle: i32) -> Option<u64> {
        self.texture(handle).map(|_| self.raster_revision())
    }
    /// Version of a live font atlas; a replacement must change this value.
    fn font_revision(&self, slot: u8) -> Option<u64> {
        self.font_atlas(slot).map(|_| self.raster_revision())
    }
    /// Coverage width excluding transparent right-hand archive padding.
    /// The bitmap row stride remains FontView::coverage_width().
    fn font_texture_width(&self, slot: u8) -> Option<u32> {
        self.font_atlas(slot).map(|font| font.coverage_width())
    }
}
