use pocket_drivers::{DamageRect, FontView};
use pocket_glyph_pages::{
    blend_glyph_run, fill_mask_rect, FontPages, GlyphPageLayout, GlyphSource, MAX_PAGES,
};

fn font(bitmap: &[u8], w: u32, h: u32, count: u16) -> FontView<'_> {
    FontView {
        bitmap,
        cell_w: w,
        cell_h: h,
        raster_density: 1,
        glyph_count: count,
    }
}

#[test]
fn a8_expansion_has_transparent_guards_and_exact_cell_pixels() {
    let view = font(&[10, 20, 30, 40, 50, 60, 70, 80], 2, 2, 2);
    let page = GlyphPageLayout::with_limit(view, 1, 8).unwrap();
    assert_eq!((page.width(), page.height(), page.count()), (8, 4, 2));
    let mut output = [99; 34];
    assert!(page.expand_a8(view, &mut output));
    assert_eq!(
        &output[..32],
        &[
            0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 20, 0, 0, 50, 60, 0, 0, 30, 40, 0, 0, 70, 80, 0, 0, 0,
            0, 0, 0, 0, 0, 0
        ]
    );
    assert_eq!(&output[32..], &[99, 99]);
    let sampler = page.sampler(17);
    assert!(sampler.contains(1));
    assert!(!sampler.contains(2));
    assert_eq!(sampler.uv(1), [5.0 / 8.0, 0.25, 7.0 / 8.0, 0.75]);
    let mut short = [99; 31];
    assert!(!page.expand_a8(view, &mut short));
    assert_eq!(short, [99; 31]);
}

#[test]
fn incomplete_or_overflowing_font_storage_is_rejected() {
    assert!(GlyphSource::from_font(font(&[1, 2, 3], 2, 2, 1), 0).is_none());
    let mut bad = font(&[], u32::MAX, 2, 1);
    bad.raster_density = 2;
    assert!(GlyphSource::from_font(bad, 0).is_none());
    assert!(GlyphPageLayout::with_limit(font(&[1], 1, 1, 1), 0, 2).is_none());
}

#[test]
fn a8_mask_preserves_strip_origin_clip_and_painter_alpha() {
    let view = font(&[255, 128, 64, 0], 2, 2, 1);
    let mut mask = [0; 8];
    let xy = 10u32 | (20 << 16);
    assert!(blend_glyph_run(
        view,
        &[xy, 0, xy, 0],
        &mut mask,
        4,
        [9, 20],
        DamageRect::new(10, 20, 12, 22),
        1,
        128
    ));
    assert_eq!(mask, [0, 192, 112, 0, 0, 60, 0, 0]);
    assert!(!fill_mask_rect(&mut mask, 4, 3, 0, 2, 1, 9));
    assert_eq!(mask, [0, 192, 112, 0, 0, 60, 0, 0]);
}

#[test]
fn compressed_psp_pages_use_original_stride_and_abgr4444_rounding() {
    let view = font(&[0, 8, 9, 255, 17, 128, 254, 255], 4, 1, 2);
    let source = GlyphSource::new(view, 3, 3).unwrap();
    let mut cache = FontPages::default();
    let (page, _) = cache.get(source, 7, 0, 100).unwrap();
    assert_eq!(page.cell_width, 3);
    let pixels = unsafe {
        std::slice::from_raw_parts(page.pixels.as_ptr() as *const u16, page.pixels.len() * 8)
    };
    assert_eq!(&pixels[..6], &[0, 0, 0x1fff, 0x1fff, 0x8fff, 0xffff]);
}

#[test]
fn psp_pages_keep_both_displays_and_versions_pinned_until_individual_retirement() {
    let data = vec![255; 64 * 128];
    let source = GlyphSource::from_font(font(&data, 64, 128, 1), 0).unwrap();
    let mut cache = FontPages::default();
    for revision in 0..MAX_PAGES as u64 {
        cache.get(source, revision, 0, 100 + revision).unwrap();
    }
    cache.get(source, 0, 0, 200).unwrap();
    assert!(cache.get(source, 99, 0, 999).is_none());
    cache.retire(100);
    assert!(cache.get(source, 99, 0, 999).is_none());
    cache.retire(200);
    assert!(cache.get(source, 99, 0, 999).is_some());
    assert!(cache.resident_bytes() <= MAX_PAGES * 64 * 128 * 2);
}

#[test]
fn scaled_placement_overflow_is_rejected_before_mask_writes() {
    let mut mask = [33; 4];
    let clip = DamageRect::new(0, 0, 2, 2);
    assert!(!blend_glyph_run(
        font(&[], u32::MAX, 1, 0),
        &[0, 0],
        &mut mask,
        2,
        [0, 0],
        clip,
        u32::MAX,
        255
    ));
    assert!(!blend_glyph_run(
        font(&[], 1 << 31, 1, 0),
        &[32767, 0],
        &mut mask,
        2,
        [0, 0],
        clip,
        u32::MAX,
        255
    ));
    assert_eq!(mask, [33; 4]);
}
