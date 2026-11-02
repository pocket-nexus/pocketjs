//! Compatibility adapter from core font atlases to shared coverage pages.
use crate::text::Atlas;
pub use pocket_glyph_pages::{FontPage, MAX_PAGES, PAGE_DIM, PAGE_WIDTH};

pub(crate) fn view(atlas: &Atlas) -> pocket_drivers::FontView<'_> {
    pocket_drivers::FontView {
        bitmap: &atlas.bitmap,
        cell_w: atlas.cell_w,
        cell_h: atlas.cell_h,
        raster_density: atlas.raster_density,
        glyph_count: atlas.glyph_count,
    }
}

#[derive(Default)]
pub struct FontPages(pocket_glyph_pages::FontPages);
impl FontPages {
    /// PSP's legacy adapter has one frame in flight. Call after GE completion.
    pub fn retire_frame(&mut self) {
        self.0.retire(0);
    }
    pub fn resident_bytes(&self) -> usize {
        self.0.resident_bytes()
    }
    pub fn get(&mut self, atlas: &Atlas, revision: u64, gid: u16) -> Option<(&FontPage, bool)> {
        let source = pocket_glyph_pages::GlyphSource::new(
            view(atlas),
            atlas.slot,
            atlas.texture_coverage_width(),
        )?;
        self.0.get(source, revision, gid, 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn atlas(count: u16) -> Atlas {
        let mut bytes = vec![0; 16 + count as usize * (8 + 16 * 16)];
        bytes[..4].copy_from_slice(&crate::spec::font_atlas::MAGIC.to_le_bytes());
        bytes[4..6].copy_from_slice(&2u16.to_le_bytes());
        bytes[6..8].copy_from_slice(&count.to_le_bytes());
        bytes[8..12].copy_from_slice(&[16, 16, 12, 16]);
        for gid in 0..count {
            let at = 16 + gid as usize * 8;
            bytes[at..at + 4].copy_from_slice(&(0x4e00 + u32::from(gid)).to_le_bytes());
            bytes[at + 4..at + 6].copy_from_slice(&gid.to_le_bytes());
            bytes[at + 6] = 16;
            let start = 16 + count as usize * 8 + gid as usize * 256;
            bytes[start..start + 256].fill(((gid % 15) as u8 + 1) * 17);
        }
        Atlas::parse(&bytes).unwrap()
    }

    fn pixel(page: &FontPage, gid: u16) -> u16 {
        let local = u32::from(gid - page.first);
        let at = (local / page.cols * 16 * page.width + local % page.cols * 16) as usize;
        let pixels = unsafe {
            core::slice::from_raw_parts(page.pixels.as_ptr() as *const u16, page.pixels.len() * 8)
        };
        pixels[at]
    }

    #[test]
    fn more_than_140_distinct_glyphs_keep_their_source_identity() {
        let atlas = atlas(4096);
        let mut cache = FontPages::default();
        for gid in 0..256 {
            let (page, _) = cache.get(&atlas, 1, gid).unwrap();
            assert!(page.contains(gid));
            assert_eq!(pixel(page, gid), (((gid % 15) + 1) << 12) | 0x0fff);
        }
        assert!(cache.resident_bytes() <= MAX_PAGES * PAGE_WIDTH as usize * PAGE_DIM as usize * 2);
    }

    #[test]
    fn pressure_cannot_reuse_pixels_in_flight_and_recovers_after_retirement() {
        let atlas = atlas(4096);
        let mut cache = FontPages::default();
        for page in 0..MAX_PAGES {
            assert!(cache.get(&atlas, 1, (page * 64) as u16).is_some());
        }
        let pointer = cache.get(&atlas, 1, 0).unwrap().0.pixels.as_ptr();
        assert!(cache.get(&atlas, 1, 1024).is_none());
        assert_eq!(cache.get(&atlas, 1, 0).unwrap().0.pixels.as_ptr(), pointer);
        assert_eq!(pixel(cache.get(&atlas, 1, 0).unwrap().0, 0), 0x1fff);
        cache.retire_frame();
        assert!(cache.get(&atlas, 1, 1024).unwrap().1);
        assert_eq!(pixel(cache.get(&atlas, 1, 0).unwrap().0, 0), 0x1fff);
    }

    #[test]
    fn same_address_same_size_replacement_obeys_font_revision() {
        let mut atlas = atlas(256);
        let mut cache = FontPages::default();
        let address = atlas.bitmap.as_ptr();
        assert_eq!(pixel(cache.get(&atlas, 1, 1).unwrap().0, 1), 0x2fff);
        cache.retire_frame();
        atlas.bitmap.fill(255);
        assert_eq!(atlas.bitmap.as_ptr(), address);
        let (page, upload) = cache.get(&atlas, 2, 1).unwrap();
        assert!(upload);
        assert_eq!(pixel(page, 1), 0xffff);
    }
    #[test]
    fn transparent_archive_padding_does_not_consume_texture_capacity() {
        let mut source = atlas(512);
        let old = core::mem::take(&mut source.bitmap);
        source.cell_w = 40;
        source.texture_cell_w = 16;
        source.bitmap = alloc::vec![0;512*40*16].into();
        for gid in 0..512 {
            for y in 0..16 {
                source.bitmap[gid * 640 + y * 40..gid * 640 + y * 40 + 16]
                    .copy_from_slice(&old[gid * 256 + y * 16..gid * 256 + y * 16 + 16]);
            }
        }
        let mut cache = FontPages::default();
        for gid in 0..320 {
            let (page, _) = cache
                .get(&source, 1, gid)
                .expect("320 narrow glyphs must fit the bounded GPU cache");
            assert_eq!(page.cell_width, 16);
            assert_eq!(pixel(page, gid), (((gid % 15) + 1) << 12) | 0xfff);
        }
        assert!(cache.resident_bytes() <= 256 * 1024);
    }
}
