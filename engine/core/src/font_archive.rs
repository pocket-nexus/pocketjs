//! Allocation-free reader for external PJFA/1 font archives. The owner calls
//! this on an I/O worker. Eight 4 KiB cmap pages and one glyph scratch suffice.
use crate::font_stream::{GLYPH_MAGIC, MAX_BATCH, MAX_PIXELS};
pub const MAGIC: u32 = 0x41464a50;
pub const HEADER: usize = 64;
pub const MAX_STRIKES: usize = 24;
const PAGE: usize = 4096;
const PAGES: usize = 8;
const MAX_FILE: u32 = 128 * 1024 * 1024;

pub trait ReadAt {
    fn read_at(&mut self, offset: u32, out: &mut [u8]) -> bool;
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Io,
    Header,
    Bounds,
    Strike,
    Corrupt,
    Capacity,
}
impl Error {
    pub fn message(self) -> &'static str {
        match self {
            Self::Io => "Font archive read failed",
            Self::Header => "Invalid font archive header",
            Self::Bounds => "Font archive bounds invalid",
            Self::Strike => "Font strike unavailable",
            Self::Corrupt => "Font glyph checksum mismatch",
            Self::Capacity => "Font reply exceeds budget",
        }
    }
}
#[derive(Clone, Copy, Default, Debug)]
pub struct Strike {
    pub slot: u8,
    pub width: u8,
    pub height: u8,
    pub baseline: u8,
    pub line_height: u8,
    pub advance: u8,
    pub density: u8,
    pub flags: u8,
    pub count: u32,
    pub index: u32,
    pub data: u32,
    pub data_bytes: u32,
}
impl Strike {
    pub fn packed(&self) -> usize {
        (self.width as usize * self.height as usize).div_ceil(4)
    }
}
struct Page {
    offset: u32,
    len: usize,
    used: u64,
    bytes: [u8; PAGE],
}
impl Page {
    const fn empty() -> Self {
        Self {
            offset: u32::MAX,
            len: 0,
            used: 0,
            bytes: [0; PAGE],
        }
    }
}
#[derive(Default, Clone, Copy)]
pub struct Stats {
    pub reads: u64,
    pub bytes: u64,
    pub index_hits: u64,
    pub glyphs: u64,
    pub missing: u64,
    pub failures: u64,
}
pub struct Archive<R> {
    reader: R,
    len: u32,
    pub identity: [u8; 32],
    pub strikes: [Strike; MAX_STRIKES],
    pub count: usize,
    pages: [Page; PAGES],
    clock: u64,
    pub stats: Stats,
}
fn word(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}
fn put(b: &mut [u8], at: usize, value: u32) {
    b[at..at + 4].copy_from_slice(&value.to_le_bytes());
}
fn hash(b: &[u8]) -> u32 {
    b.iter()
        .fold(2166136261, |h, v| (h ^ *v as u32).wrapping_mul(16777619))
}
impl<R: ReadAt> Archive<R> {
    pub fn open(mut reader: R, len: u32) -> Result<Self, Error> {
        if !(HEADER as u32..=MAX_FILE).contains(&len) {
            return Err(Error::Bounds);
        }
        let mut header = [0; HEADER];
        if !reader.read_at(0, &mut header) {
            return Err(Error::Io);
        }
        let count = word(&header, 12) as usize;
        if word(&header, 0) != MAGIC
            || word(&header, 4) != 1
            || word(&header, 8) != len
            || count == 0
            || count > MAX_STRIKES
            || header[48..].iter().any(|v| *v != 0)
        {
            return Err(Error::Header);
        }
        let mut identity = [0; 32];
        identity.copy_from_slice(&header[16..48]);
        let mut strikes = [Strike::default(); MAX_STRIKES];
        let mut end = HEADER as u32 + count as u32 * 32;
        let mut mask = 0u32;
        for (i, s) in strikes.iter_mut().take(count).enumerate() {
            let mut b = [0; 32];
            if !reader.read_at(HEADER as u32 + i as u32 * 32, &mut b) {
                return Err(Error::Io);
            }
            *s = Strike {
                slot: b[0],
                width: b[1],
                height: b[2],
                baseline: b[3],
                line_height: b[4],
                advance: b[5],
                density: b[6],
                flags: b[7],
                count: word(&b, 8),
                index: word(&b, 12),
                data: word(&b, 16),
                data_bytes: word(&b, 20),
            };
            let pixels = s.width as usize * s.height as usize;
            if s.slot >= 24
                || mask & (1 << s.slot) != 0
                || pixels == 0
                || pixels > MAX_PIXELS
                || s.density != 1
                || s.advance == 0
                || s.baseline > s.height
                || s.line_height == 0
                || s.count == 0
                || s.count > 65535
                || b[24..].iter().any(|v| *v != 0)
            {
                return Err(Error::Header);
            }
            mask |= 1 << s.slot;
            if s.index != end
                || s.data != s.index.checked_add(s.count * 12).ok_or(Error::Bounds)?
                || s.data_bytes != s.count * s.packed() as u32
            {
                return Err(Error::Bounds);
            }
            end = s.data.checked_add(s.data_bytes).ok_or(Error::Bounds)?;
            if end > len {
                return Err(Error::Bounds);
            }
        }
        if end != len {
            return Err(Error::Bounds);
        }
        Ok(Self {
            reader,
            len,
            identity,
            strikes,
            count,
            pages: [const { Page::empty() }; PAGES],
            clock: 0,
            stats: Stats {
                reads: 1 + count as u64,
                bytes: (HEADER + count * 32) as u64,
                ..Stats::default()
            },
        })
    }
    fn read(&mut self, offset: u32, out: &mut [u8]) -> Result<(), Error> {
        if offset as u64 + out.len() as u64 > self.len as u64 {
            return Err(Error::Bounds);
        }
        self.stats.reads += 1;
        self.stats.bytes += out.len() as u64;
        if !self.reader.read_at(offset, out) {
            self.stats.failures += 1;
            return Err(Error::Io);
        }
        Ok(())
    }
    fn index_bytes(&mut self, mut offset: u32, mut out: &mut [u8]) -> Result<(), Error> {
        while !out.is_empty() {
            let page_offset = offset / PAGE as u32 * PAGE as u32;
            self.clock = self.clock.saturating_add(1);
            let index = if let Some(i) = self.pages.iter().position(|p| p.offset == page_offset) {
                self.stats.index_hits += 1;
                i
            } else {
                let i = self
                    .pages
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, p)| p.used)
                    .unwrap()
                    .0;
                let size = (self.len - page_offset).min(PAGE as u32) as usize;
                self.stats.reads += 1;
                self.stats.bytes += size as u64;
                // ReadAt can modify a prefix before failing. The old page key
                // must no longer identify these bytes, including on retry.
                self.pages[i].offset = u32::MAX;
                self.pages[i].len = 0;
                self.pages[i].used = 0;
                if !self
                    .reader
                    .read_at(page_offset, &mut self.pages[i].bytes[..size])
                {
                    self.stats.failures += 1;
                    return Err(Error::Io);
                }
                self.pages[i].offset = page_offset;
                self.pages[i].len = size;
                i
            };
            let page = &mut self.pages[index];
            page.used = self.clock;
            let at = (offset - page_offset) as usize;
            if at >= page.len {
                return Err(Error::Bounds);
            }
            let n = out.len().min(page.len - at);
            out[..n].copy_from_slice(&page.bytes[at..at + n]);
            out = &mut out[n..];
            offset += n as u32;
        }
        Ok(())
    }
    fn glyph(&mut self, s: Strike, cp: u32, out: &mut [u8]) -> Result<Option<(u8, u8)>, Error> {
        let (mut lo, mut hi) = (0, s.count);
        let mut entry = [0; 12];
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            self.index_bytes(s.index + mid * 12, &mut entry)?;
            let key = word(&entry, 0);
            if key < cp {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo == s.count {
            self.stats.missing += 1;
            return Ok(None);
        }
        self.index_bytes(s.index + lo * 12, &mut entry)?;
        if word(&entry, 0) != cp {
            self.stats.missing += 1;
            return Ok(None);
        }
        let gid = u16::from_le_bytes([entry[4], entry[5]]) as u32;
        if gid >= s.count || entry[7] > s.width {
            return Err(Error::Bounds);
        }
        self.read(s.data + gid * s.packed() as u32, &mut out[..s.packed()])?;
        if hash(&out[..s.packed()]) != word(&entry, 8) {
            self.stats.failures += 1;
            return Err(Error::Corrupt);
        }
        self.stats.glyphs += 1;
        Ok(Some((entry[6], entry[7])))
    }
    pub fn batch(
        &mut self,
        generation: u32,
        slot: u8,
        cps: &[u32],
        out: &mut [u8],
    ) -> Result<usize, Error> {
        let s = *self.strikes[..self.count]
            .iter()
            .find(|s| s.slot == slot)
            .ok_or(Error::Strike)?;
        let stride = 8 + s.packed();
        let len = 12 + cps.len() * stride;
        if cps.is_empty() || cps.len() > MAX_BATCH || len > 1250 || out.len() < len {
            return Err(Error::Capacity);
        }
        if cps
            .iter()
            .any(|cp| *cp < 32 || *cp > 0x10ffff || (0xd800..=0xdfff).contains(cp))
        {
            return Err(Error::Bounds);
        }
        out[..len].fill(0);
        put(out, 0, GLYPH_MAGIC);
        put(out, 4, generation);
        out[8] = slot;
        out[9] = cps.len() as u8;
        out[10] = s.width;
        out[11] = s.height;
        for (i, cp) in cps.iter().enumerate() {
            let at = 12 + i * stride;
            put(out, at, *cp);
            if let Some((advance, xoff)) = self.glyph(s, *cp, &mut out[at + 8..at + stride])? {
                out[at + 4] = advance;
                out[at + 5] = xoff;
                out[at + 6] = 1;
            }
        }
        Ok(len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::{vec, vec::Vec};
    struct Memory {
        bytes: Vec<u8>,
        fail: bool,
    }
    impl ReadAt for Memory {
        fn read_at(&mut self, at: u32, out: &mut [u8]) -> bool {
            if self.fail {
                return false;
            }
            let Some(src) = self.bytes.get(at as usize..at as usize + out.len()) else {
                return false;
            };
            out.copy_from_slice(src);
            true
        }
    }
    fn fixture(count: u32) -> Vec<u8> {
        let data = 96 + count as usize * 12;
        let mut b = vec![0; data + count as usize * 16];
        let len = b.len() as u32;
        put(&mut b, 0, MAGIC);
        put(&mut b, 4, 1);
        put(&mut b, 8, len);
        put(&mut b, 12, 1);
        b[64..72].copy_from_slice(&[2, 8, 8, 7, 10, 8, 1, 0]);
        put(&mut b, 72, count);
        put(&mut b, 76, 96);
        put(&mut b, 80, data as u32);
        put(&mut b, 84, count * 16);
        for i in 0..count as usize {
            let at = 96 + i * 12;
            put(&mut b, at, 0x4e00 + i as u32);
            b[at + 4..at + 6].copy_from_slice(&(i as u16).to_le_bytes());
            b[at + 6] = 8;
            b[data + i * 16..data + (i + 1) * 16].fill(i as u8);
            let h = hash(&b[data + i * 16..data + (i + 1) * 16]);
            put(&mut b, at + 8, h);
        }
        b
    }
    #[test]
    fn pages_and_cross_boundary_entries_preserve_glyph_identity() {
        let b = fixture(1500);
        let n = b.len() as u32;
        let mut a = Archive::open(
            Memory {
                bytes: b,
                fail: false,
            },
            n,
        )
        .unwrap();
        let mut out = [0; 1250];
        for i in [0, 333, 334, 335, 674, 1015, 1499] {
            assert_eq!(a.batch(7, 2, &[0x4e00 + i], &mut out), Ok(36));
            assert_eq!(word(&out, 4), 7);
            assert!(out[20..36].iter().all(|v| *v == i as u8));
        }
        assert!(a.stats.index_hits > 0);
        assert!(a.stats.bytes < n as u64);
        a.batch(7, 2, &[0x10ffff], &mut out).unwrap();
        assert_eq!(out[18], 0);
    }
    #[test]
    fn corrupted_cells_and_read_failures_are_retryable() {
        let mut b = fixture(1);
        let n = b.len() as u32;
        b[108] ^= 1;
        let mut a = Archive::open(
            Memory {
                bytes: b,
                fail: false,
            },
            n,
        )
        .unwrap();
        let mut out = [0; 1250];
        assert_eq!(a.batch(1, 2, &[0x4e00], &mut out), Err(Error::Corrupt));
        a.reader.bytes[108] ^= 1;
        // Glyph data bypasses the index cache, so a repaired cell is read again.
        a.reader.fail = true;
        assert_eq!(a.batch(1, 2, &[0x4e00], &mut out), Err(Error::Io));
        a.reader.fail = false;
        assert_eq!(a.batch(1, 2, &[0x4e00], &mut out), Ok(36));
        assert_eq!(a.batch(1, 2, &[0xd800], &mut out), Err(Error::Bounds));
        assert_eq!(a.batch(1, 2, &[0x4e00; 5], &mut out), Err(Error::Capacity));
    }
    #[test]
    fn truncated_or_overlapping_archives_fail_before_lookup() {
        let b = fixture(2);
        for n in 0..b.len() {
            assert!(Archive::open(
                Memory {
                    bytes: b[..n].to_vec(),
                    fail: false
                },
                n as u32
            )
            .is_err());
        }
        for offset in [0, 4, 8, 12, 64, 65, 66, 70, 76, 80, 84, 88] {
            let mut bad = b.clone();
            bad[offset] = 0xff;
            assert!(
                Archive::open(
                    Memory {
                        bytes: bad,
                        fail: false
                    },
                    b.len() as u32
                )
                .is_err(),
                "offset {offset}"
            );
        }
    }

    #[test]
    fn partially_overwritten_index_page_is_not_reused_after_read_failure() {
        struct ShortRead {
            bytes: Vec<u8>,
            fail_at: Option<u32>,
        }
        impl ReadAt for ShortRead {
            fn read_at(&mut self, at: u32, out: &mut [u8]) -> bool {
                if self.fail_at == Some(at) {
                    let partial = out.len().min(12);
                    out[..partial].fill(0xee);
                    return false;
                }
                out.copy_from_slice(&self.bytes[at as usize..at as usize + out.len()]);
                true
            }
        }
        let bytes = fixture(4000);
        let len = bytes.len() as u32;
        let mut a = Archive::open(
            ShortRead {
                bytes,
                fail_at: None,
            },
            len,
        )
        .unwrap();
        let mut out = [0; 12];
        // Fill all eight cache pages, then fail partway through the ninth read.
        for page in 0..PAGES {
            a.index_bytes((page * PAGE) as u32, &mut out).unwrap();
        }
        let ninth = (PAGES * PAGE) as u32;
        a.reader.fail_at = Some(ninth);
        assert_eq!(a.index_bytes(ninth, &mut out), Err(Error::Io));
        a.reader.fail_at = None;
        let reads = a.stats.reads;
        a.index_bytes(0, &mut out).unwrap();
        assert_eq!(out, a.reader.bytes[..12]);
        assert_eq!(
            a.stats.reads,
            reads + 1,
            "a poisoned page must be read again"
        );
        a.index_bytes(ninth, &mut out).unwrap();
        assert_eq!(out, a.reader.bytes[ninth as usize..ninth as usize + 12]);
        let mut glyph = [0; 1250];
        assert_eq!(
            a.batch(1, 2, &[0x4e00 + 333, 0x4e00 + 3999], &mut glyph),
            Ok(60)
        );
        assert!(glyph[20..36].iter().all(|v| *v == 333u32 as u8));
        assert!(glyph[44..60].iter().all(|v| *v == 3999u32 as u8));
        assert_eq!(a.stats.failures, 1);
    }
}
