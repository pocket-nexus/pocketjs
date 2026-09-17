//! Bounded leased glyph cells. Disk work belongs to io.offload.
//! Drawing never creates demand; a batch pins its entire set until release.
use crate::{
    text::{Atlas, CmapEntry},
    Ui,
};
use alloc::{format, string::String, vec, vec::Vec};
use core::cell::Cell;

pub const CONFIG_MAGIC: u32 = 0x31534650; // PFS1
pub const GLYPH_MAGIC: u32 = 0x31474650; // PFG1
pub const MAX_ENTRIES: usize = 4096;
pub const BATCH_MAGIC: u32 = 0x31424650; // PFB1
pub const MAX_LEASES: usize = 32;
pub const MAX_PIXELS: usize = 4096;
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_BATCH: usize = 4;

pub(crate) struct Entry {
    cp: u32,
    seen: Cell<u64>,
    ink_width: u32,
}
struct Lease {
    id: u32,
    scalars: Vec<u32>,
}
pub(crate) struct Stream {
    pub generation: u32,
    base: u16,
    base_texture_width: u32,
    base_cell_w: u32,
    base_cell_h: u32,
    entries: Vec<Entry>,
    wanted: Vec<u32>,
    leases: Vec<Lease>,
    absent: Vec<u32>,
    epoch: Cell<u64>,
    request_cursor: Cell<usize>,
    width: usize,
    height: usize,
    pub advance: u8,
    evictions: u64,
    rejected: u64,
}
fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn scalar(cp: u32) -> bool {
    cp >= 32 && cp <= 0x10ffff && !(0xd800..=0xdfff).contains(&cp)
}

impl Atlas {
    pub(crate) fn stream_begin(&self, _frame: u64) {
        if let Some(s) = &self.stream {
            s.epoch.set(s.epoch.get().saturating_add(1));
        }
    }
    pub(crate) fn stream_visible(&self, _cp: u32, gid: u16) -> bool {
        if let Some(s) = &self.stream {
            if gid >= s.base && (gid - s.base) < s.entries.len() as u16 {
                s.entries[(gid - s.base) as usize].seen.set(s.epoch.get());
            }
        }
        true
    }
    fn stream_batch(&mut self, b: &[u8]) -> i32 {
        let Some(s) = self.stream.as_ref() else {
            return -3;
        };
        if u32_at(b, 4) != Some(s.generation) {
            return -3;
        }
        let id = u32_at(b, 12).unwrap();
        if id == 0 {
            return -3;
        }
        let action = b[9];
        if action == 0 {
            if s.leases.len() >= MAX_LEASES {
                return -2;
            }
            if s.leases.iter().any(|l| l.id == id) {
                return -3;
            }
            let mut scalars = Vec::new();
            for chunk in b[16..].chunks_exact(4) {
                let cp = u32::from_le_bytes(chunk.try_into().unwrap());
                if !scalar(cp) {
                    return -3;
                }
                // Baked cells do not consume streamed residency, including gid 0.
                if self.lookup(cp).is_some_and(|(gid, _)| gid < s.base) {
                    continue;
                }
                scalars.push(cp);
            }
            scalars.sort_unstable();
            scalars.dedup();
            let mut union = s.wanted.clone();
            union.extend_from_slice(&scalars);
            union.sort_unstable();
            union.dedup();
            if union.len() > s.entries.len() {
                return -2;
            }
            let s = self.stream.as_mut().unwrap();
            s.wanted = union;
            s.leases.push(Lease { id, scalars });
        } else if b.len() != 16 {
            return -3;
        }
        if action == 2 {
            let s = self.stream.as_mut().unwrap();
            s.leases.retain(|l| l.id != id);
            s.wanted.clear();
            for lease in &s.leases {
                s.wanted.extend_from_slice(&lease.scalars);
            }
            s.wanted.sort_unstable();
            s.wanted.dedup();
            s.absent.retain(|cp| s.wanted.binary_search(cp).is_ok());
            return 1;
        }
        let s = self.stream.as_ref().unwrap();
        let Some(lease) = s.leases.iter().find(|l| l.id == id) else {
            return -3;
        };
        if lease.scalars.iter().any(|cp| s.absent.contains(cp)) {
            return -1;
        }
        if lease.scalars.iter().all(|cp| self.lookup(*cp).is_some()) {
            1
        } else {
            0
        }
    }
    fn stream_bytes(&self) -> usize {
        self.stream.as_ref().map_or(0, |s| {
            s.entries.len() * self.coverage_width() as usize * self.coverage_height() as usize
        })
    }

    fn stream_configure(&mut self, b: &[u8]) -> bool {
        let generation = u32_at(b, 4).unwrap();
        let base = self.stream.as_ref().map_or(self.glyph_count, |s| s.base);
        let base_texture_width = self
            .stream
            .as_ref()
            .map_or(self.texture_cell_w, |s| s.base_texture_width);
        let (base_cell_w, base_cell_h) = self
            .stream
            .as_ref()
            .map_or((self.cell_w, self.cell_h), |s| {
                (s.base_cell_w, s.base_cell_h)
            });
        let capacity = u16::from_le_bytes([b[16], b[17]]) as usize;
        if generation == 0 && capacity == 0 {
            // Streaming may pad baked cells. Compact them before releasing the
            // allocation so detaching also restores the original atlas stride.
            let old_w = self.coverage_width() as usize;
            let old_h = self.coverage_height() as usize;
            let w = base_cell_w as usize * self.raster_density as usize;
            let h = base_cell_h as usize * self.raster_density as usize;
            for g in 0..base as usize {
                for y in 0..h {
                    let from = g * old_w * old_h + y * old_w;
                    self.bitmap.copy_within(from..from + w, g * w * h + y * w);
                }
            }
            self.cell_w = base_cell_w;
            self.cell_h = base_cell_h;
            self.texture_cell_w = base_texture_width;
            self.stream = None;
            self.glyph_count = base;
            self.cmap.retain(|e| e.gid < base);
            self.cmap.shrink_to_fit();
            self.bitmap.truncate(base as usize * w * h);
            self.bitmap.shrink_to_fit();
            return true;
        }
        let (w, h) = (b[9] as usize, b[10] as usize);
        if generation == 0
            || capacity == 0
            || capacity > MAX_ENTRIES
            || base as usize + capacity > u16::MAX as usize
            || w == 0
            || h == 0
            || w * h > MAX_PIXELS
            || b[11] as u32 != self.baseline
            || b[12] as u32 != self.line_height
            || b[14] != self.raster_density
            || b[14] != 1
            || b[13] == 0
        {
            return false;
        }
        let old_w = self.cell_w as usize;
        let old_h = self.cell_h as usize;
        let cw = w.max(old_w);
        let ch = h.max(old_h);
        if cw * ch > MAX_PIXELS {
            return false;
        }
        let mut pixels = vec![0; (base as usize + capacity) * cw * ch];
        for g in 0..base as usize {
            for y in 0..old_h {
                pixels[g * cw * ch + y * cw..g * cw * ch + y * cw + old_w].copy_from_slice(
                    &self.bitmap
                        [g * old_w * old_h + y * old_w..g * old_w * old_h + (y + 1) * old_w],
                );
            }
        }
        self.bitmap = pixels;
        self.cell_w = cw as u32;
        self.cell_h = ch as u32;
        self.glyph_count = base + capacity as u16;
        self.cmap.retain(|e| e.gid < base);
        self.cmap.reserve(capacity);
        self.texture_cell_w = base_texture_width;
        self.stream = Some(Stream {
            generation,
            base,
            base_texture_width,
            base_cell_w,
            base_cell_h,
            entries: (0..capacity)
                .map(|_| Entry {
                    cp: u32::MAX,
                    seen: Cell::new(0),
                    ink_width: 0,
                })
                .collect(),
            wanted: Vec::new(),
            leases: Vec::new(),
            absent: Vec::with_capacity(capacity),
            epoch: Cell::new(1),
            request_cursor: Cell::new(0),
            width: w,
            height: h,
            advance: b[13],
            evictions: 0,
            rejected: 0,
        });
        true
    }
    fn stream_commit(&mut self, b: &[u8]) -> usize {
        let Some(s) = self.stream.as_mut() else {
            return 0;
        };
        let n = b[9] as usize;
        let cell = s.width * s.height;
        let packed = cell.div_ceil(4);
        if u32_at(b, 4) != Some(s.generation)
            || n == 0
            || n > MAX_BATCH
            || b[10] as usize != s.width
            || b[11] as usize != s.height
            || b.len() != 12 + n * (8 + packed)
        {
            return 0;
        }
        // Validate the entire batch before changing the atlas.
        for i in 0..n {
            let at = 12 + i * (8 + packed);
            if !scalar(u32_at(b, at).unwrap())
                || b[at + 6] > 1
                || b[at + 7] != 0
                || b[at + 5] as usize > s.width
            {
                return 0;
            }
        }
        let mut changed = 0;
        for i in 0..n {
            let at = 12 + i * (8 + packed);
            let cp = u32_at(b, at).unwrap();
            if s.wanted.binary_search(&cp).is_err()
                || self.cmap.binary_search_by_key(&cp, |e| e.codepoint).is_ok()
            {
                continue;
            }
            if b[at + 6] == 0 {
                if !s.absent.contains(&cp) {
                    if s.absent.len() == s.entries.len() {
                        s.absent.remove(0);
                    }
                    s.absent.push(cp);
                }
                continue;
            }
            let candidate = s.entries.iter().position(|e| e.cp == u32::MAX).or_else(|| {
                s.entries
                    .iter()
                    .enumerate()
                    .filter(|(_, e)| s.wanted.binary_search(&e.cp).is_err())
                    .min_by_key(|(_, e)| e.seen.get())
                    .map(|(i, _)| i)
            });
            let Some(index) = candidate else {
                s.rejected += 1;
                continue;
            };
            let entry = &mut s.entries[index];
            if entry.cp != u32::MAX {
                let old = entry.cp;
                self.cmap.retain(|e| e.codepoint != old);
                s.evictions += 1;
            }
            entry.cp = cp;
            entry.seen.set(s.epoch.get());
            let gid = s.base + index as u16;
            let dest_cell = (self.cell_w * self.cell_h) as usize;
            let dest = &mut self.bitmap[gid as usize * dest_cell..(gid as usize + 1) * dest_cell];
            dest.fill(0);
            entry.ink_width = 0;
            for p in 0..cell {
                let alpha = ((b[at + 8 + p / 4] >> (6 - 2 * (p % 4))) & 3) * 85;
                dest[p / s.width * self.cell_w as usize + p % s.width] = alpha;
                if alpha != 0 {
                    entry.ink_width = entry.ink_width.max((p % s.width + 1) as u32);
                }
            }
            let point = self
                .cmap
                .binary_search_by_key(&cp, |e| e.codepoint)
                .unwrap_err();
            self.cmap.insert(
                point,
                CmapEntry {
                    codepoint: cp,
                    gid,
                    advance: b[at + 4],
                    xoff: b[at + 5],
                },
            );
            changed += 1;
        }
        self.texture_cell_w = s
            .entries
            .iter()
            .map(|e| e.ink_width)
            .max()
            .unwrap_or(0)
            .max(s.base_texture_width);
        changed
    }
}

impl crate::text::Fonts {
    pub(crate) fn stream_begin(&self, frame: u64) {
        for slot in 0..crate::spec::MAX_FONT_SLOTS {
            if let Some(a) = self.atlas(slot as u8) {
                a.stream_begin(frame);
            }
        }
    }
}
impl Ui {
    /// PFS1 descriptor, fixed 20 bytes. Generation zero/capacity zero detaches.
    pub fn font_stream_configure(&mut self, b: &[u8]) -> bool {
        if b.len() != 20
            || u32_at(b, 0) != Some(CONFIG_MAGIC)
            || b[8] as usize >= crate::spec::MAX_FONT_SLOTS
            || b[15] != 0
            || b[18] != 0
            || b[19] != 0
        {
            return false;
        }
        let slot = b[8];
        let Some(a) = self.fonts.atlas(slot) else {
            return false;
        };
        let capacity = u16::from_le_bytes([b[16], b[17]]) as usize;
        let other: usize = (0..crate::spec::MAX_FONT_SLOTS)
            .filter(|i| *i != slot as usize)
            .filter_map(|i| self.fonts.atlas(i as u8))
            .map(Atlas::stream_bytes)
            .sum();
        if other + capacity * (a.cell_w.max(b[9] as u32) * a.cell_h.max(b[10] as u32)) as usize
            > MAX_BYTES
        {
            return false;
        }
        let ok = self.fonts.atlas_mut(slot).unwrap().stream_configure(b);
        if ok {
            self.font_revisions[slot as usize] = self.font_revisions[slot as usize].wrapping_add(1);
            self.mark_layout_dirty();
            self.bump_raster_revision();
        }
        ok
    }
    /// PFB1: generation, slot, action (retain/query/release), two reserved bytes,
    /// nonzero lease id, then at most MAX_ENTRIES Unicode scalars on retain.
    /// 1 ready, 0 pending, -1 missing, -2 budget, -3 invalid/stale.
    pub fn font_stream_batch(&mut self, b: &[u8]) -> i32 {
        if b.len() < 16
            || b.len() > 16 + MAX_ENTRIES * 4
            || b.len() % 4 != 0
            || u32_at(b, 0) != Some(BATCH_MAGIC)
            || b[9] > 2
            || b[10] != 0
            || b[11] != 0
        {
            return -3;
        }
        self.fonts.atlas_mut(b[8]).map_or(-3, |a| a.stream_batch(b))
    }
    /// Explicit batch demand only. The scheduler filters in-flight requests.
    pub fn font_stream_requests(&self) -> String {
        use core::fmt::Write;
        let mut out = String::from("[");
        let mut count = 0;
        let mut starts = [0; crate::spec::MAX_FONT_SLOTS];
        let mut visited = [0; crate::spec::MAX_FONT_SLOTS];
        for slot in 0..crate::spec::MAX_FONT_SLOTS {
            if let Some(s) = self.fonts.atlas(slot as u8).and_then(|a| a.stream.as_ref()) {
                starts[slot] = s.request_cursor.get();
            }
        }
        loop {
            let mut progress = false;
            for slot in 0..crate::spec::MAX_FONT_SLOTS {
                if count == 32 {
                    break;
                }
                let Some(a) = self.fonts.atlas(slot as u8) else {
                    continue;
                };
                let Some(s) = &a.stream else { continue };
                let wanted = &s.wanted;
                while visited[slot] < wanted.len() {
                    let cp = wanted[(starts[slot] + visited[slot]) % wanted.len()];
                    visited[slot] += 1;
                    s.request_cursor
                        .set((starts[slot] + visited[slot]) % wanted.len());
                    if a.lookup(cp).is_some() || s.absent.contains(&cp) {
                        continue;
                    }
                    if count > 0 {
                        out.push(',');
                    }
                    let _ = write!(out, "[{},{},{}]", s.generation, slot, cp);
                    count += 1;
                    progress = true;
                    break;
                }
            }
            if count == 32 || !progress {
                break;
            }
        }
        out.push(']');
        out
    }
    /// PFG1 batch: at most four glyphs; no filesystem or GPU calls.
    pub fn font_stream_commit(&mut self, b: &[u8]) -> usize {
        if b.len() < 12 || b.len() > 1250 || u32_at(b, 0) != Some(GLYPH_MAGIC) {
            return 0;
        }
        let slot = b[8];
        let Some(a) = self.fonts.atlas_mut(slot) else {
            return 0;
        };
        let n = a.stream_commit(b);
        if n > 0 {
            self.font_revisions[slot as usize] = self.font_revisions[slot as usize].wrapping_add(1);
            self.mark_layout_dirty();
            self.bump_raster_revision();
        }
        n
    }
    pub fn font_stream_stats(&self) -> String {
        let (mut resident, mut bytes, mut pending, mut evictions, mut rejected, mut absent) =
            (0, 0, 0, 0, 0, 0);
        for slot in 0..crate::spec::MAX_FONT_SLOTS {
            if let Some(a) = self.fonts.atlas(slot as u8) {
                if let Some(s) = &a.stream {
                    resident += s.entries.iter().filter(|e| e.cp != u32::MAX).count();
                    bytes += a.stream_bytes();
                    pending += s
                        .wanted
                        .iter()
                        .filter(|cp| a.lookup(**cp).is_none() && !s.absent.contains(cp))
                        .count();
                    evictions += s.evictions;
                    rejected += s.rejected;
                    absent += s.absent.len();
                }
            }
        }
        format!("{{\"resident\":{},\"bytes\":{},\"pending\":{},\"evictions\":{},\"rejected\":{},\"unsupported\":{}}}",resident,bytes,pending,evictions,rejected,absent)
    }
}
