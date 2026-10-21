//! Borrowed C font views expanded by the independent glyph page tool.
use crate::adapters::{borrowed, writable};
use pocket_drivers::{abi::*, FontView};
use pocket_glyph_pages::GlyphPageLayout;

/// # Safety
/// All records and byte spans provide their announced storage until return.
/// Font bytes, output pixels and output metadata must be disjoint.
#[no_mangle]
pub unsafe extern "C" fn pocket_glyph_page_a8(
    font: *const PocketFontView,
    glyph: u32,
    max_dimension: u32,
    pixels: *mut u8,
    capacity: usize,
    out: *mut PocketGlyphPage,
) -> i32 {
    let Some(raw) = (unsafe { PocketFontView::read_prefix(font) }) else {
        return POCKET_STATUS_INVALID;
    };
    let Some(output) = (unsafe { PocketGlyphPage::read_prefix(out) }) else {
        return POCKET_STATUS_INVALID;
    };
    if output.struct_size < core::mem::size_of::<PocketGlyphPage>()
        || !(8..=4096).contains(&max_dimension)
        || !max_dimension.is_power_of_two()
        || glyph > u16::MAX as u32
        || raw.glyph_count > u16::MAX as u32
        || raw.raster_density > u8::MAX as u32
    {
        return POCKET_STATUS_INVALID;
    }
    let Ok(bitmap) = (unsafe { borrowed(raw.bitmap, raw.byte_length) }) else {
        return POCKET_STATUS_INVALID;
    };
    let font = FontView {
        bitmap,
        cell_w: raw.cell_width,
        cell_h: raw.cell_height,
        raster_density: raw.raster_density as u8,
        glyph_count: raw.glyph_count as u16,
    };
    let Some(page) = GlyphPageLayout::with_limit(font, glyph as u16, max_dimension) else {
        return POCKET_STATUS_INVALID;
    };
    if !pixels.is_null() || capacity != 0 {
        if capacity < page.coverage_bytes() {
            return POCKET_STATUS_INVALID;
        }
        let Ok(output) = (unsafe { writable(pixels, capacity) }) else {
            return POCKET_STATUS_INVALID;
        };
        if !page.expand_a8(font, output) {
            return POCKET_STATUS_INVALID;
        }
    }
    let value = PocketGlyphPage {
        page: page.page(),
        first: page.first(),
        count: page.count(),
        width: page.width(),
        height: page.height(),
        uv: page.sampler(0).uv(glyph as u16),
        ..PocketGlyphPage::empty()
    };
    unsafe { value.write_prefix(out) };
    POCKET_STATUS_OK
}
