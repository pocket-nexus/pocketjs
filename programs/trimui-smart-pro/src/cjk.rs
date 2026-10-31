//! Runtime font-atlas extension, as the note widget does it: text that arrives
//! at run time (a transcript, an agent's words, a game's title) can hold any
//! codepoint, and the pak's baked atlases only cover what the build saw. Missing
//! glyphs rasterize from the firmware's CJK font on first sight, append to the
//! slot's FONT ATLAS blob and reload through `Ui::load_font_atlas`. Only the
//! slots this app's text uses grow: each reload re-uploads the slot.

use std::collections::HashSet;
use std::path::Path;

use ab_glyph::{point, Font, FontRef, PxScale, ScaleFont};

const FONT_MAGIC: u32 = 0x4146_4344; // 'DCFA' LE
const HEADER: usize = 16;
const CMAP_ENTRY: usize = 8;
/// Appended-glyph ceiling per slot — far above any real typing session,
/// well under the u16 gid space and GPU texture limits at 64 columns.
const MAX_GLYPHS: u16 = 6000;
/// text-xs, text-sm, text-base, text-2xs and their bold forms (framework/compiler/tailwind.ts).
const USED_SLOTS: &[u8] = &[0, 1, 2, 7, 8, 9, 19, 20];

/// Font px per slot — mirrors framework/compiler/tailwind.ts FONT_PX (slots 0..6 =
/// 12/14/16/18/20/24/36, bold = +7 at the same px). tests/note.test.ts pins
/// the same table.
fn slot_px(slot: u8) -> f32 {
    match slot {
        // Mono slots (16..18) — mirrors tailwind.ts MONO_FONT_PX; CJK has no
        // separate monospace face, so the system CJK font extends these too.
        19 | 20 => 10.0,
        16 => 12.0,
        17 => 14.0,
        18 => 16.0,
        s => [12.0, 14.0, 16.0, 18.0, 20.0, 24.0, 36.0][(s % 7) as usize],
    }
}

const FONT_CANDIDATES: &[&str] = &["/usr/trimui/res/full.ttf", "/usr/trimui/res/regular.ttf"];

struct GlyphSource {
    map: memmap2::Mmap,
    index: u32,
}

impl GlyphSource {
    fn find() -> Option<(GlyphSource, String)> {
        for path in FONT_CANDIDATES {
            if !Path::new(path).exists() {
                continue;
            }
            let Ok(file) = std::fs::File::open(path) else {
                continue;
            };
            let Ok(map) = (unsafe { memmap2::Mmap::map(&file) }) else {
                continue;
            };
            for index in 0..8u32 {
                let Ok(font) = FontRef::try_from_slice_and_index(&map, index) else {
                    break;
                };
                if font.glyph_id('中').0 != 0 {
                    return Some((GlyphSource { map, index }, format!("{path}#{index}")));
                }
            }
        }
        None
    }

    fn font(&self) -> Option<FontRef<'_>> {
        FontRef::try_from_slice_and_index(&self.map, self.index).ok()
    }
}

/// One slot's parsed FONT ATLAS blob, appendable.
struct SlotAtlas {
    slot: u8,
    cell_w: u8,
    cell_h: u8,
    baseline: u8,
    line_height: u8,
    flags: u8,
    density: u8,
    /// (codepoint, gid, advance, xoff) — serialized codepoint-sorted.
    cmap: Vec<(u32, u16, u8, u8)>,
    /// gid-linear coverage cells.
    coverage: Vec<u8>,
    known: HashSet<u32>,
    dirty: bool,
}

impl SlotAtlas {
    fn parse(blob: &[u8]) -> Option<SlotAtlas> {
        if blob.len() < HEADER {
            return None;
        }
        let u16at = |o: usize| u16::from_le_bytes([blob[o], blob[o + 1]]);
        if u32::from_le_bytes([blob[0], blob[1], blob[2], blob[3]]) != FONT_MAGIC {
            return None;
        }
        let version = u16at(4);
        if version != 2 && version != 3 {
            return None;
        }
        let glyph_count = u16at(6) as usize;
        let (cell_w, cell_h, baseline, line_height, slot, flags) =
            (blob[8], blob[9], blob[10], blob[11], blob[12], blob[13]);
        let density = if version == 3 { blob[14].max(1) } else { 1 };
        let cmap_end = HEADER + glyph_count * CMAP_ENTRY;
        let cell_bytes = cell_w as usize * cell_h as usize * (density as usize).pow(2);
        if blob.len() < cmap_end + glyph_count * cell_bytes {
            return None;
        }
        let mut cmap = Vec::with_capacity(glyph_count);
        let mut known = HashSet::with_capacity(glyph_count);
        for g in 0..glyph_count {
            let o = HEADER + g * CMAP_ENTRY;
            let cp = u32::from_le_bytes([blob[o], blob[o + 1], blob[o + 2], blob[o + 3]]);
            cmap.push((cp, u16at(o + 4), blob[o + 6], blob[o + 7]));
            known.insert(cp);
        }
        Some(SlotAtlas {
            slot,
            cell_w,
            cell_h,
            baseline,
            line_height,
            flags,
            density,
            cmap,
            coverage: blob[cmap_end..cmap_end + glyph_count * cell_bytes].to_vec(),
            known,
            dirty: false,
        })
    }

    fn glyph_count(&self) -> u16 {
        self.cmap.len() as u16
    }

    /// Rasterize `cp` from `font` into a new appended cell.
    fn append(&mut self, font: &FontRef<'_>, cp: char) {
        if self.glyph_count() >= MAX_GLYPHS {
            return;
        }
        let gid_font = font.glyph_id(cp);
        if gid_font.0 == 0 {
            return; // fallback font lacks it too — the core's tofu handles it
        }
        let px = slot_px(self.slot);
        let density = self.density as f32;
        let advance = font
            .as_scaled(PxScale::from(px))
            .h_advance(gid_font)
            .round()
            .clamp(0.0, 255.0) as u8;

        let cov_w = self.cell_w as usize * self.density as usize;
        let cov_h = self.cell_h as usize * self.density as usize;
        let mut cell = vec![0u8; cov_w * cov_h];
        let glyph = gid_font.with_scale_and_position(
            PxScale::from(px * density),
            point(0.0, self.baseline as f32 * density),
        );
        if let Some(outlined) = font.outline_glyph(glyph) {
            let bounds = outlined.px_bounds();
            outlined.draw(|x, y, c| {
                let cx = bounds.min.x as i32 + x as i32;
                let cy = bounds.min.y as i32 + y as i32;
                if cx >= 0 && (cx as usize) < cov_w && cy >= 0 && (cy as usize) < cov_h {
                    let dst = &mut cell[cy as usize * cov_w + cx as usize];
                    *dst = (*dst).max((c * 255.0) as u8);
                }
            });
        }

        let gid = self.glyph_count();
        self.coverage.extend_from_slice(&cell);
        self.cmap.push((cp as u32, gid, advance, 0));
        self.known.insert(cp as u32);
        self.dirty = true;
    }

    /// Serialize back to a v3 blob (cmap re-sorted by codepoint).
    fn blob(&self) -> Vec<u8> {
        let count = self.glyph_count();
        let mut cmap = self.cmap.clone();
        cmap.sort_by_key(|&(cp, ..)| cp);
        let mut out = Vec::with_capacity(HEADER + cmap.len() * CMAP_ENTRY + self.coverage.len());
        out.extend_from_slice(&FONT_MAGIC.to_le_bytes());
        out.extend_from_slice(&3u16.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&[
            self.cell_w,
            self.cell_h,
            self.baseline,
            self.line_height,
            self.slot,
            self.flags,
            self.density,
            0,
        ]);
        for (cp, gid, adv, xoff) in cmap {
            out.extend_from_slice(&cp.to_le_bytes());
            out.extend_from_slice(&gid.to_le_bytes());
            out.push(adv);
            out.push(xoff);
        }
        out.extend_from_slice(&self.coverage);
        out
    }
}

/// All of a pak's font slots + the system fallback face.
pub struct CjkAtlases {
    source: Option<GlyphSource>,
    slots: Vec<SlotAtlas>,
}

impl CjkAtlases {
    pub fn from_pak(pak: &[u8]) -> CjkAtlases {
        let slots: Vec<SlotAtlas> = pocket_ui_surface::walk_pak(pak)
            .into_iter()
            .filter(|e| e.key.starts_with("ui:font."))
            .filter_map(|e| SlotAtlas::parse(e.blob))
            .filter(|slot| USED_SLOTS.contains(&slot.slot))
            .collect();
        let source = match GlyphSource::find() {
            Some((source, name)) => {
                eprintln!("pocket-studio: glyph fallback {name}");
                Some(source)
            }
            None => {
                eprintln!("pocket-studio: no CJK font found");
                None
            }
        };
        CjkAtlases { source, slots }
    }

    /// Make sure every non-ASCII codepoint in `text` exists in every slot.
    /// Returns the rebuilt blobs of the slots that grew (feed them to
    /// `Ui::load_font_atlas`); empty when nothing was missing.
    pub fn ensure(&mut self, text: &str) -> Vec<Vec<u8>> {
        let missing: Vec<char> = {
            let mut seen = HashSet::new();
            text.chars()
                .filter(|c| (*c as u32) > 0x7f && !c.is_control())
                .filter(|c| self.slots.iter().any(|s| !s.known.contains(&(*c as u32))))
                .filter(|c| seen.insert(*c))
                .collect()
        };
        if missing.is_empty() {
            return Vec::new();
        }
        let Some(font) = self.source.as_ref().and_then(|s| s.font()) else {
            return Vec::new();
        };
        for cp in &missing {
            for slot in &mut self.slots {
                if !slot.known.contains(&(*cp as u32)) {
                    slot.append(&font, *cp);
                }
            }
        }
        let mut blobs = Vec::new();
        for slot in &mut self.slots {
            if std::mem::take(&mut slot.dirty) {
                blobs.push(slot.blob());
            }
        }
        blobs
    }
}
