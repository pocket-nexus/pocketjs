//! Worker-produced static TTF layouts and incremental grayscale glyph pages.
//!
//! RTF1 packets enter through `font_stream_commit`, shared by every host.
//! Font parsing, shaping and rasterization are absent from this module. A
//! layout owns immutable resource IDs and pen positions; page removal only
//! changes paint. The lease owner drops pages after releasing its batches.
use crate::{rd_u32, spec, Ui};
use alloc::vec::Vec;

pub const MAGIC: u32 = 0x3146_5452;
pub const DEFAULT_PAGE_BUDGET: usize = 4 * 1024 * 1024;
pub const MAX_PAGE_BUDGET: usize = 16 * 1024 * 1024;
pub const MAX_LAYOUT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_GLYPHS: usize = 16_384;
pub const MAX_GLYPH_PIXELS: usize = 65_536;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RuntimePlacement {
    pub instance: u32,
    pub glyph: u32,
    pub x: f32,
    pub baseline: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeLayout {
    pub width: f32,
    pub height: f32,
    pub glyphs: Vec<RuntimePlacement>,
}

pub(crate) struct GlyphPage {
    key: u64,
    pub handle: i32,
    pub width: u32,
    pub height: u32,
    pub left: i32,
    pub top: i32,
    bytes: usize,
    signature: u64,
}

pub(crate) struct RuntimeFonts {
    pages: Vec<GlyphPage>,
    pub bytes: usize,
    pub budget: usize,
    pub uploaded_bytes: u64,
    pub uploads: u64,
    pub rejected: u64,
}

impl Default for RuntimeFonts {
    fn default() -> Self {
        Self {
            pages: Vec::new(),
            bytes: 0,
            budget: DEFAULT_PAGE_BUDGET,
            uploaded_bytes: 0,
            uploads: 0,
            rejected: 0,
        }
    }
}

fn key(instance: u32, glyph: u32) -> u64 {
    (u64::from(instance) << 32) | u64::from(glyph)
}

impl RuntimeFonts {
    pub fn page(&self, instance: u32, glyph: u32) -> Option<&GlyphPage> {
        let at = self
            .pages
            .binary_search_by_key(&key(instance, glyph), |p| p.key)
            .ok()?;
        Some(&self.pages[at])
    }
    pub fn resident(&self) -> usize {
        self.pages.len()
    }
}

fn number(b: &[u8], at: usize) -> Option<f32> {
    let n = f32::from_bits(rd_u32(b, at)?);
    n.is_finite().then_some(n)
}

impl Ui {
    /// RTF1 little-endian packets, dispatched by `font_stream_commit`:
    /// 1: node i32, count u32, width/height f32, then (instance/glyph u32,x/baseline f32).
    /// 2: instance/glyph/width/height u32, left/top i32, then width*height alpha8.
    /// 3: instance/glyph u32 (drop); 4: node i32 (clear layout);
    /// 5: GPU page budget u32; 6: reset service identity namespace.
    /// Every packet is atomic. Zero-sized coverage still names a valid glyph.
    pub fn runtime_text_commit(&mut self, b: &[u8]) -> bool {
        if rd_u32(b, 0) != Some(MAGIC) {
            return false;
        }
        let ok = match rd_u32(b, 4) {
            Some(1) => self.runtime_layout_commit(b),
            Some(2) => self.runtime_glyph_commit(b),
            Some(3) if b.len() == 16 => {
                let wanted = key(rd_u32(b, 8).unwrap(), rd_u32(b, 12).unwrap());
                if let Ok(at) = self
                    .fonts
                    .runtime
                    .pages
                    .binary_search_by_key(&wanted, |p| p.key)
                {
                    let page = self.fonts.runtime.pages.remove(at);
                    self.fonts.runtime.bytes -= page.bytes;
                    self.free_texture(page.handle);
                }
                true
            }
            Some(4) if b.len() == 12 => {
                if let Some(slot) = self.tree.resolve(rd_u32(b, 8).unwrap() as i32) {
                    if self.tree.slots[slot as usize].runtime_text.take().is_some() {
                        self.mark_layout_dirty();
                    }
                    true
                } else {
                    false
                }
            }
            Some(5) if b.len() == 12 => {
                let budget = rd_u32(b, 8).unwrap() as usize;
                if budget > MAX_PAGE_BUDGET || budget < self.fonts.runtime.bytes {
                    false
                } else {
                    self.fonts.runtime.budget = budget;
                    true
                }
            }
            Some(6) if b.len() == 8 => {
                let pages = core::mem::take(&mut self.fonts.runtime.pages);
                for page in pages {
                    self.free_texture(page.handle);
                }
                self.fonts.runtime.bytes = 0;
                for node in &mut self.tree.slots {
                    node.runtime_text = None;
                }
                self.mark_layout_dirty();
                true
            }
            _ => false,
        };
        if !ok {
            self.fonts.runtime.rejected += 1;
        }
        ok
    }

    fn runtime_layout_commit(&mut self, b: &[u8]) -> bool {
        if b.len() < 24 {
            return false;
        }
        let Some(slot) = self.tree.resolve(rd_u32(b, 8).unwrap() as i32) else {
            return false;
        };
        if self.tree.slots[slot as usize].node_type != spec::NodeType::Text as u8 {
            return false;
        }
        let count = rd_u32(b, 12).unwrap() as usize;
        if count > MAX_GLYPHS || b.len() != 24 + count * 16 {
            return false;
        }
        let (Some(width), Some(height)) = (number(b, 16), number(b, 20)) else {
            return false;
        };
        if width < 0.0 || height < 0.0 {
            return false;
        }
        let used: usize = self
            .tree
            .slots
            .iter()
            .enumerate()
            .filter(|(i, n)| *i != slot as usize && n.alive)
            .filter_map(|(_, n)| n.runtime_text.as_ref())
            .map(|l| l.glyphs.len() * 16)
            .sum();
        if used + count * 16 > MAX_LAYOUT_BYTES {
            return false;
        }
        let mut glyphs = Vec::with_capacity(count);
        for at in (24..b.len()).step_by(16) {
            let (Some(x), Some(baseline)) = (number(b, at + 8), number(b, at + 12)) else {
                return false;
            };
            glyphs.push(RuntimePlacement {
                instance: rd_u32(b, at).unwrap(),
                glyph: rd_u32(b, at + 4).unwrap(),
                x,
                baseline,
            });
        }
        let layout = RuntimeLayout {
            width,
            height,
            glyphs,
        };
        if self.tree.slots[slot as usize].runtime_text.as_ref() != Some(&layout) {
            let measure_changed = self.tree.slots[slot as usize]
                .runtime_text
                .as_ref()
                .is_none_or(|old| old.width != width || old.height != height);
            self.tree.slots[slot as usize].runtime_text = Some(layout);
            if measure_changed {
                self.mark_layout_dirty();
            }
        }
        true
    }

    fn runtime_glyph_commit(&mut self, b: &[u8]) -> bool {
        if b.len() < 32 {
            return false;
        }
        let (instance, glyph) = (rd_u32(b, 8).unwrap(), rd_u32(b, 12).unwrap());
        let (width, height) = (rd_u32(b, 16).unwrap(), rd_u32(b, 20).unwrap());
        let (left, top) = (rd_u32(b, 24).unwrap() as i32, rd_u32(b, 28).unwrap() as i32);
        if width > spec::TEX_MAX_DIM
            || height > spec::TEX_MAX_DIM
            || width as usize * height as usize > MAX_GLYPH_PIXELS
            || b.len() != 32 + width as usize * height as usize
        {
            return false;
        }
        let wanted = key(instance, glyph);
        // A resource ID is immutable. Retries cannot replace queued texture bytes.
        let signature = b[16..].iter().fold(0xcbf29ce484222325u64, |h, v| {
            (h ^ u64::from(*v)).wrapping_mul(0x100000001b3)
        });
        let at = match self
            .fonts
            .runtime
            .pages
            .binary_search_by_key(&wanted, |p| p.key)
        {
            Ok(at) => return self.fonts.runtime.pages[at].signature == signature,
            Err(at) => at,
        };
        if self.fonts.runtime.pages.len() >= MAX_GLYPHS {
            return false;
        }
        let (tw, th) = (
            width.max(1).next_power_of_two(),
            height.max(1).next_power_of_two(),
        );
        let bytes = if width == 0 || height == 0 {
            0
        } else {
            tw as usize * th as usize * 4
        };
        if bytes
            > self
                .fonts
                .runtime
                .budget
                .saturating_sub(self.fonts.runtime.bytes)
        {
            return false;
        }
        let handle = if bytes == 0 {
            -1
        } else {
            let mut rgba = alloc::vec![0u8; bytes];
            // Transparent padding keeps white RGB so filtering coverage at
            // a glyph edge cannot introduce a black fringe.
            for pixel in rgba.chunks_exact_mut(4) {
                pixel[..3].fill(255);
            }
            for y in 0..height as usize {
                for x in 0..width as usize {
                    let dst = (y * tw as usize + x) * 4;
                    rgba[dst + 3] = b[32 + y * width as usize + x];
                }
            }
            let handle = self.upload_texture_flags(
                &rgba,
                tw,
                th,
                spec::psm::PSM_8888,
                spec::img::FLAG_LINEAR,
            );
            if handle < 0 {
                return false;
            }
            handle
        };
        let runtime = &mut self.fonts.runtime;
        runtime.pages.insert(
            at,
            GlyphPage {
                key: wanted,
                handle,
                width,
                height,
                left,
                top,
                bytes,
                signature,
            },
        );
        runtime.bytes += bytes;
        runtime.uploaded_bytes += bytes as u64;
        runtime.uploads += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn packet(op: u32, words: &[u32]) -> Vec<u8> {
        [MAGIC, op]
            .into_iter()
            .chain(words.iter().copied())
            .flat_map(u32::to_le_bytes)
            .collect()
    }
    fn glyph(id: u32, alpha: u8) -> Vec<u8> {
        let mut b = packet(2, &[1, id, 2, 2, (-1i32) as u32, 3]);
        b.extend_from_slice(&[alpha; 4]);
        b
    }
    fn node(ui: &mut Ui) -> i32 {
        ui.set_viewport(16.0, 16.0);
        let node = ui.create_node(spec::NodeType::Text as u8);
        ui.set_text(node, "fi A\u{301}");
        ui.set_prop(node, spec::prop::TEXT_COLOR, 0xff00_00ffu32 as f64);
        ui.insert_before(spec::ROOT_ID, node, 0);
        node
    }
    fn layout(node: i32, glyph: u32) -> Vec<u8> {
        packet(
            1,
            &[
                node as u32,
                1,
                10f32.to_bits(),
                6f32.to_bits(),
                1,
                glyph,
                3f32.to_bits(),
                4f32.to_bits(),
            ],
        )
    }

    #[test]
    fn ordinary_text_uses_worker_geometry_and_paint_color() {
        let mut ui = Ui::new();
        let n = node(&mut ui);
        assert_eq!(ui.font_stream_commit(&glyph(7, 255)), 1);
        assert_eq!(ui.font_stream_commit(&layout(n, 7)), 1);
        let words = ui.draw().words.clone();
        assert_eq!(words[0], spec::draw_op::TEX_QUAD);
        assert_eq!(words[2], 2 | (1 << 16)); // negative bearing preserved
        assert_eq!(words[8], 0xff00_00ff);
        let mut fb = vec![0; 16 * 16 * 4];
        crate::raster::render(&ui, &words, &mut fb);
        assert_eq!(&fb[(16 + 2) * 4..(16 + 3) * 4], &[255, 0, 0, 255]);
        let before = ui.layout_of(n);
        ui.set_prop(n, spec::prop::TEXT_COLOR, 0xff00_ff00u32 as f64);
        assert!(!ui.layout.needs(), "color must not invalidate geometry");
        let recolored = ui.draw().words.clone();
        assert_eq!(recolored[8], 0xff00_ff00);
        assert_eq!(ui.layout_of(n), before);
        assert_eq!(ui.fonts.runtime.uploads, 1);
    }

    #[test]
    fn bitmap_arrival_and_eviction_cannot_change_layout_or_alias_old_draws() {
        let mut ui = Ui::new();
        let n = node(&mut ui);
        assert!(ui.runtime_text_commit(&layout(n, 7)));
        assert!(ui.draw().words.is_empty());
        let before = ui.layout_of(n);
        assert!(ui.runtime_text_commit(&glyph(7, 255)));
        assert!(!ui.layout.needs());
        let words = ui.draw().words.clone();
        let handle = words[1] as i32;
        assert!(ui.runtime_text_commit(&packet(3, &[1, 7])));
        assert!(!ui.layout.needs());
        assert!(ui.runtime_text_commit(&glyph(8, 64)));
        assert!(
            ui.texture(handle).is_none(),
            "a stale draw must not sample another glyph"
        );
        assert!(ui.draw().words.is_empty());
        assert_eq!(ui.layout_of(n), before);
        assert!(ui.runtime_text_commit(&glyph(7, 255)));
        assert_ne!(ui.draw().words[1] as i32, handle);
        assert_eq!(ui.layout_of(n), before);
    }

    #[test]
    fn incremental_upload_is_idempotent_and_keeps_unrelated_resources() {
        let mut ui = Ui::new();
        let n = node(&mut ui);
        assert!(ui.runtime_text_commit(&layout(n, 7)));
        ui.draw();
        ui.set_text(n, "AV");
        assert!(!ui.layout.needs(), "string edits wait for worker geometry");
        assert!(ui.runtime_text_commit(&layout(n, 8)));
        assert!(
            !ui.layout.needs(),
            "a new run with the same size does not resize the tree"
        );
        assert!(ui.runtime_text_commit(&glyph(7, 255)));
        let handle = ui.fonts.runtime.page(1, 7).unwrap().handle;
        let revision = ui.raster_revision();
        assert!(ui.runtime_text_commit(&glyph(7, 255)));
        assert_eq!(ui.raster_revision(), revision);
        assert!(
            !ui.runtime_text_commit(&glyph(7, 128)),
            "immutable resource cannot be overwritten"
        );
        assert!(ui.runtime_text_commit(&glyph(8, 128)));
        assert_eq!(ui.fonts.runtime.page(1, 7).unwrap().handle, handle);
        assert_eq!(
            ui.fonts.runtime.uploaded_bytes, 32,
            "only each new 2x2 glyph is uploaded"
        );
        assert_eq!(ui.font_atlas_revision(0), 0);
    }

    #[test]
    fn budgets_and_invalid_packets_reject_without_partial_mutation() {
        let mut ui = Ui::new();
        let n = node(&mut ui);
        assert!(ui.runtime_text_commit(&packet(5, &[16])));
        assert!(ui.runtime_text_commit(&glyph(7, 255)));
        assert!(!ui.runtime_text_commit(&glyph(8, 255)));
        assert_eq!(ui.fonts.runtime.resident(), 1);
        assert!(!ui.runtime_text_commit(&packet(5, &[15])));
        assert_eq!(ui.fonts.runtime.budget, 16);
        assert!(ui.runtime_text_commit(&packet(5, &[2 * 1024 * 1024])));
        let mut oversized = packet(2, &[1, 8, 512, 512, 0, 0]);
        oversized.resize(32 + 512 * 512, 255);
        assert!(!ui.runtime_text_commit(&oversized));
        assert_eq!(ui.fonts.runtime.resident(), 1);
        let valid = layout(n, 7);
        for len in 0..valid.len() {
            assert!(!ui.runtime_text_commit(&valid[..len]));
        }
        let mut invalid = valid.clone();
        invalid[32..36].copy_from_slice(&f32::NAN.to_bits().to_le_bytes());
        assert!(!ui.runtime_text_commit(&invalid));
        assert!(ui.tree.get(n).unwrap().runtime_text.is_none());
        assert!(ui.runtime_text_commit(&valid));
        ui.destroy_node(n);
        assert!(
            !ui.runtime_text_commit(&valid),
            "stale async response cannot attach to a reused node"
        );
        assert!(ui.runtime_text_commit(&packet(6, &[])));
        assert_eq!(ui.fonts.runtime.bytes, 0);
    }
}
