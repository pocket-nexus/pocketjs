use pocket_runtime_cabi::{abi::*, pocket_glyph_page_a8};

#[test]
fn page_query_and_expansion_share_guarded_tool_layout() {
    let bitmap = [10, 20, 30, 40, 50, 60, 70, 80];
    let font = PocketFontView {
        bitmap: bitmap.as_ptr(),
        byte_length: bitmap.len(),
        cell_width: 2,
        cell_height: 2,
        raster_density: 1,
        glyph_count: 2,
        ..PocketFontView::empty()
    };
    let mut page = PocketGlyphPage::empty();
    unsafe {
        assert_eq!(
            pocket_glyph_page_a8(&font, 1, 8, core::ptr::null_mut(), 0, &mut page),
            0
        );
        assert_eq!(
            (page.first, page.count, page.width, page.height),
            (0, 2, 8, 4)
        );
        assert_eq!(page.uv, [5.0 / 8.0, 1.0 / 4.0, 7.0 / 8.0, 3.0 / 4.0]);
        let mut pixels = [255; 36];
        assert_eq!(
            pocket_glyph_page_a8(&font, 1, 8, pixels.as_mut_ptr(), pixels.len(), &mut page),
            0
        );
        assert_eq!(&pixels[9..11], &[10, 20]);
        assert_eq!(&pixels[13..15], &[50, 60]);
        assert_eq!(&pixels[17..19], &[30, 40]);
        assert_eq!(&pixels[21..23], &[70, 80]);
        assert!(pixels[..8].iter().all(|&v| v == 0));
        assert_eq!(&pixels[32..], &[255; 4]);
    }
}

#[test]
fn invalid_prefix_dimensions_or_capacity_leave_outputs_unchanged() {
    let bitmap = [255; 4];
    let mut font = PocketFontView {
        bitmap: bitmap.as_ptr(),
        byte_length: 4,
        cell_width: 2,
        cell_height: 2,
        raster_density: 1,
        glyph_count: 1,
        ..PocketFontView::empty()
    };
    let mut page = PocketGlyphPage {
        page: 123,
        ..PocketGlyphPage::empty()
    };
    let mut pixels = [77; 32];
    unsafe {
        for (gid, limit, capacity) in [(1, 8, 32), (0, 7, 32), (0, 8192, 32), (0, 8, 1)] {
            assert_eq!(
                pocket_glyph_page_a8(&font, gid, limit, pixels.as_mut_ptr(), capacity, &mut page),
                POCKET_STATUS_INVALID
            );
            assert_eq!(page.page, 123);
            assert_eq!(pixels, [77; 32]);
        }
        let mut short = core::mem::size_of::<usize>();
        assert_eq!(
            pocket_glyph_page_a8(
                &font,
                0,
                8,
                pixels.as_mut_ptr(),
                32,
                (&mut short as *mut usize).cast()
            ),
            POCKET_STATUS_INVALID
        );
        font.cell_width = u32::MAX;
        assert_eq!(
            pocket_glyph_page_a8(&font, 0, 8, pixels.as_mut_ptr(), 32, &mut page),
            POCKET_STATUS_INVALID
        );
        font.cell_width = 2;
        font.byte_length = 3;
        assert_eq!(
            pocket_glyph_page_a8(&font, 0, 8, pixels.as_mut_ptr(), 32, &mut page),
            POCKET_STATUS_INVALID
        );
    }
    assert_eq!(page.page, 123);
    assert_eq!(pixels, [77; 32]);
}
