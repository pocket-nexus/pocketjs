//! The forwarding crate keeps every public path and names the same items.

use core::any::TypeId;
use pocket_drivers::FontView;

#[test]
fn paths_name_the_pocket_render_items() {
    use pocket_render::glyph_pages as render;
    assert_eq!(
        TypeId::of::<pocket_glyph_pages::GlyphPageLayout>(),
        TypeId::of::<render::GlyphPageLayout>()
    );
    assert_eq!(
        TypeId::of::<pocket_glyph_pages::GlyphSampler>(),
        TypeId::of::<render::GlyphSampler>()
    );
    assert_eq!(
        TypeId::of::<pocket_glyph_pages::GlyphSource<'static>>(),
        TypeId::of::<render::GlyphSource<'static>>()
    );
    assert_eq!(
        TypeId::of::<pocket_glyph_pages::FontPage>(),
        TypeId::of::<render::FontPage>()
    );
    assert_eq!(
        TypeId::of::<pocket_glyph_pages::FontPages>(),
        TypeId::of::<render::FontPages>()
    );
    assert_eq!(
        (
            pocket_glyph_pages::MAX_PAGES,
            pocket_glyph_pages::PAGE_DIM,
            pocket_glyph_pages::PAGE_WIDTH
        ),
        (render::MAX_PAGES, render::PAGE_DIM, render::PAGE_WIDTH)
    );

    let mut mask = 0u8;
    pocket_glyph_pages::composite_mask(&mut mask, 255);
    assert_eq!(mask, 255);
    let mut rect = [0u8; 4];
    assert!(pocket_glyph_pages::fill_mask_rect(
        &mut rect, 2, 0, 0, 2, 2, 255
    ));
    assert_eq!(rect, [255; 4]);
    let bitmap = [255u8; 4];
    let font = FontView {
        bitmap: &bitmap,
        cell_w: 2,
        cell_h: 2,
        raster_density: 1,
        glyph_count: 1,
    };
    let page = pocket_glyph_pages::GlyphPageLayout::new(font, 0).unwrap();
    let mut coverage = vec![0; page.coverage_bytes()];
    assert!(page.expand_a8(font, &mut coverage));
    let _ = pocket_glyph_pages::blend_glyph_run;
}
