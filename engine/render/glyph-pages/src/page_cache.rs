//! Bounded GPU renditions of immutable baked font cells. Source glyph IDs and
//! metrics never change when a texture page is evicted. Call `retire(submission)`
//! only after the GPU has finished reading every page used by that submission. Submission ids are unique until retirement.
use crate::GlyphSource;
use alloc::vec::Vec;

pub const PAGE_DIM: u32 = 128;
pub const PAGE_WIDTH: u32 = 64;
pub const MAX_PAGES: usize = 16;

pub struct FontPage {
    pub slot: u8,
    pub revision: u64,
    pub first: u16,
    pub count: u16,
    pub cols: u32,
    pub cell_width: u32,
    pub width: u32,
    pub height: u32,
    /// Aligned ABGR4444 coverage, white RGB for per-draw modulation.
    pub pixels: Vec<u128>,
    submissions: Vec<u64>,
    used: u64,
}

impl FontPage {
    pub fn contains(&self, gid: u16) -> bool {
        gid >= self.first && u32::from(gid) < u32::from(self.first) + u32::from(self.count)
    }
}

#[derive(Default)]
pub struct FontPages {
    pages: Vec<FontPage>,
    clock: u64,
}

impl FontPages {
    /// Releases GPU ownership; keeps useful pages for the next frame.
    pub fn retire(&mut self, submission: u64) {
        for page in &mut self.pages {
            page.submissions.retain(|id| *id != submission);
        }
    }

    pub fn resident_bytes(&self) -> usize {
        self.pages.iter().map(|page| page.pixels.len() * 16).sum()
    }

    /// Returns a page and whether its pixels need a native cache writeback.
    /// `None` means the caller must use the source glyph's CPU paint path.
    /// In particular, pressure never overwrites a page queued for GPU reads.
    pub fn get(
        &mut self,
        source: GlyphSource<'_>,
        revision: u64,
        gid: u16,
        submission: u64,
    ) -> Option<(&FontPage, bool)> {
        let atlas = source.font;
        let cw = source.texture_width;
        let source_stride = source.stride as u32;
        let ch = source.height;
        if gid >= atlas.glyph_count || cw == 0 || ch == 0 || cw > PAGE_WIDTH || ch > PAGE_DIM {
            return None;
        }
        let cols = PAGE_WIDTH / cw;
        let capacity = cols * (PAGE_DIM / ch);
        let first = u32::from(gid) / capacity * capacity;
        self.clock = self.clock.saturating_add(1);
        if let Some(index) = self.pages.iter().position(|page| {
            page.slot == source.slot && page.revision == revision && page.first == first as u16
        }) {
            let page = &mut self.pages[index];
            if !page.submissions.contains(&submission) {
                page.submissions.push(submission);
            }
            page.used = self.clock;
            return Some((page, false));
        }
        let index = if self.pages.len() < MAX_PAGES {
            self.pages.len()
        } else {
            self.pages
                .iter()
                .enumerate()
                .filter(|(_, page)| page.submissions.is_empty())
                .min_by_key(|(_, page)| page.used)
                .map(|(index, _)| index)?
        };
        let count = capacity.min(u32::from(atlas.glyph_count) - first);
        let width = (cols.min(count) * cw).next_power_of_two();
        let height = (count.div_ceil(cols) * ch).next_power_of_two();
        // Reuse retired storage. No allocation scales with total font coverage.
        let mut pixels = if index < self.pages.len() {
            core::mem::take(&mut self.pages[index].pixels)
        } else {
            Vec::new()
        };
        pixels.resize(((width * height * 2) as usize).div_ceil(16), 0);
        pixels.fill(0);
        let dst = unsafe {
            core::slice::from_raw_parts_mut(pixels.as_mut_ptr() as *mut u16, pixels.len() * 8)
        };
        for local in 0..count {
            let src = source.glyph_rows((first + local) as u16)?;
            let x0 = local % cols * cw;
            let y0 = local / cols * ch;
            for y in 0..ch {
                for x in 0..cw {
                    let alpha = ((u32::from(src[(y * source_stride + x) as usize]) + 8) / 17)
                        .min(15) as u16;
                    if alpha != 0 {
                        dst[((y0 + y) * width + x0 + x) as usize] = (alpha << 12) | 0x0fff;
                    }
                }
            }
        }
        let page = FontPage {
            slot: source.slot,
            revision,
            first: first as u16,
            count: count as u16,
            cols,
            cell_width: cw,
            width,
            height,
            pixels,
            submissions: alloc::vec![submission],
            used: self.clock,
        };
        if index == self.pages.len() {
            self.pages.push(page);
        } else {
            self.pages[index] = page;
        }
        Some((&self.pages[index], true))
    }
}
