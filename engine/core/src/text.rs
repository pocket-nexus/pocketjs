//! Font atlas registry + text measurement + inline-run layout.
//!
//! Parses font-atlas blobs (spec.ts "FONT ATLAS binary format", constants in
//! spec::font_atlas) into a MAX_FONT_SLOTS registry. cmap lookups binary
//! search (entries are sorted ascending by codepoint); a miss resolves to
//! gid 0 (the tofu box) and bumps the per-core miss counter.
//!
//! v1 line model (documented limitation): NO automatic word wrap — a run
//! breaks only on explicit '\n'. Measurement is the max line width (sum of
//! advances + tracking per glyph) by lines x line height.

#[cfg(any(
    test,
    all(
        feature = "glyph-skip-zero",
        not(any(
            target_os = "psp",
            target_os = "horizon",
            target_os = "espidf"
        ))
    )
))]
use alloc::boxed::Box;
use alloc::vec::Vec;
use core::cell::Cell;

use crate::spec;

/// Inline bytes added to every font-registry slot by the optional span
/// index. This is `2 * size_of::<usize>()` where enabled and zero on PSP,
/// Nintendo 3DS, ESP-IDF, or in a dense-reference build. Heap payload is
/// reported per [`Atlas`].
pub const fn glyph_span_inline_bytes_per_slot() -> usize {
    #[cfg(all(
        feature = "glyph-skip-zero",
        not(any(
            target_os = "psp",
            target_os = "horizon",
            target_os = "espidf"
        ))
    ))]
    {
        core::mem::size_of::<Box<[u8]>>()
    }
    #[cfg(any(
        not(feature = "glyph-skip-zero"),
        target_os = "psp",
        target_os = "horizon",
        target_os = "espidf"
    ))]
    {
        0
    }
}

#[inline]
fn rd_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

#[inline]
fn rd_u32(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(off)?,
        *b.get(off + 1)?,
        *b.get(off + 2)?,
        *b.get(off + 3)?,
    ]))
}

/// One cmap entry (sorted ascending by codepoint in the blob).
#[derive(Clone, Copy, Debug)]
pub struct CmapEntry {
    pub codepoint: u32,
    pub gid: u16,
    /// Logical px advance; independent of atlas raster density.
    pub advance: u8,
    /// Left-side-bearing shift (cmap byte +7): logical px the outline was shifted
    /// RIGHT at bake so negative-LSB ink stays inside the cell. The cell is
    /// placed at penX - xoff when drawing.
    pub xoff: u8,
}

/// One parsed font atlas (a (family-weight, px) bake bound to a slot).
pub struct Atlas {
    /// Logical cell dimensions. Coverage dimensions are these times
    /// `raster_density`.
    pub cell_w: u32,
    pub cell_h: u32,
    pub(crate) texture_cell_w: u32,
    /// Logical px from cell top to the baseline.
    pub baseline: u32,
    /// Default logical line advance in px.
    pub line_height: u32,
    /// Raster samples per logical pixel (v2 atlases resolve to 1).
    pub raster_density: u8,
    pub slot: u8,
    pub flags: u8,
    pub glyph_count: u16,
    pub(crate) cmap: Vec<CmapEntry>,
    pub(crate) stream: Option<crate::font_stream::Stream>,
    /// Coverage cells: glyphCount x (cellH*density) x (cellW*density)
    /// alpha bytes, left-to-right.
    pub bitmap: Vec<u8>,
    /// One allocation containing per-glyph, per-row nonzero `(start, len)`
    /// coverage spans. The first `glyph_count + 1` u32 values are byte
    /// offsets; rows then hold a span count followed by pairs. Coordinates
    /// use u8 when coverage width fits and u16 otherwise. Coverage values
    /// remain in `bitmap`, so this table stores no duplicate alpha bytes.
    ///
    /// PSP and Nintendo 3DS compile this field out because their GPU renderers
    /// consume `bitmap` as a texture. ESP-IDF compiles it out because its
    /// renderer receives font resources through an ABI that does not expose the
    /// index. Tests retain it with default features off for the dense/sparse matrix.
    #[cfg(any(
        test,
        all(
            feature = "glyph-skip-zero",
            not(any(
                target_os = "psp",
                target_os = "horizon",
                target_os = "espidf"
            ))
        )
    ))]
    spans: Box<[u8]>,
}

impl Atlas {
    /// Parse a font-atlas blob (copies the bytes it keeps). `None` on bad
    /// magic/version/slot or truncation.
    pub fn parse(bytes: &[u8]) -> Option<Atlas> {
        use spec::font_atlas as fa;
        if rd_u32(bytes, 0)? != fa::MAGIC {
            return None;
        }
        let version = rd_u16(bytes, 4)?;
        // Atlas v2 used bytes 14..15 as reserved and had one coverage sample
        // per logical pixel. Keep loading it so old packs remain usable.
        let raster_density = if version == 2 {
            1
        } else if version == fa::VERSION {
            let density = *bytes.get(14)?;
            if density == 0 {
                return None;
            }
            density
        } else {
            return None;
        };
        let glyph_count = rd_u16(bytes, 6)?;
        let cell_w = *bytes.get(8)? as u32;
        let cell_h = *bytes.get(9)? as u32;
        let baseline = *bytes.get(10)? as u32;
        let line_height = *bytes.get(11)? as u32;
        let slot = *bytes.get(12)?;
        let flags = *bytes.get(13)?;
        if slot as usize >= spec::MAX_FONT_SLOTS || glyph_count == 0 || cell_w == 0 || cell_h == 0 {
            return None;
        }
        let cmap_off = fa::HEADER_SIZE;
        let bitmap_off = (glyph_count as usize)
            .checked_mul(fa::CMAP_ENTRY_SIZE)?
            .checked_add(cmap_off)?;
        let coverage_w = (cell_w as usize).checked_mul(raster_density as usize)?;
        let coverage_h = (cell_h as usize).checked_mul(raster_density as usize)?;
        let bitmap_len = (glyph_count as usize)
            .checked_mul(coverage_h)?
            .checked_mul(coverage_w)?;
        let bitmap_end = bitmap_off.checked_add(bitmap_len)?;
        if bytes.len() < bitmap_end {
            return None;
        }
        let mut cmap = Vec::with_capacity(glyph_count as usize);
        for i in 0..glyph_count as usize {
            let o = cmap_off + i * fa::CMAP_ENTRY_SIZE;
            let gid = rd_u16(bytes, o + 4)?;
            if gid >= glyph_count {
                return None;
            }
            cmap.push(CmapEntry {
                codepoint: rd_u32(bytes, o)?,
                gid,
                advance: *bytes.get(o + 6)?,
                xoff: *bytes.get(o + 7)?,
            });
        }
        let bitmap_src = &bytes[bitmap_off..bitmap_end];
        #[cfg(any(
            test,
            all(
                feature = "glyph-skip-zero",
                not(any(
                    target_os = "psp",
                    target_os = "horizon",
                    target_os = "espidf"
                ))
            )
        ))]
        let spans = build_glyph_spans(
            bitmap_src,
            glyph_count,
            coverage_w,
            coverage_h,
            !cfg!(test),
        )?;
        let mut bitmap = Vec::with_capacity(bitmap_len);
        bitmap.extend_from_slice(bitmap_src);
        Some(Atlas {
            cell_w,
            cell_h,
            baseline,
            line_height,
            raster_density,
            slot,
            flags,
            glyph_count,
            cmap,
            stream: None,
            texture_cell_w: cell_w,
            bitmap,
            #[cfg(any(
                test,
                all(
                    feature = "glyph-skip-zero",
                    not(any(
                        target_os = "psp",
                        target_os = "horizon",
                        target_os = "espidf"
                    ))
                )
            ))]
            spans,
        })
    }

    /// GPU cells omit transparent right-hand archive padding. Source coverage
    /// retains its fixed row stride; this width includes every resident ink pixel.
    pub fn texture_coverage_width(&self) -> u32 {
        self.texture_cell_w * self.raster_density as u32
    }

    /// Binary-search the cmap. `None` = unmapped codepoint (caller decides
    /// whether that bumps the miss counter).
    pub fn lookup(&self, codepoint: u32) -> Option<(u16, u8)> {
        self.lookup_entry(codepoint).map(|e| (e.gid, e.advance))
    }

    /// Full cmap entry for a codepoint (gid + advance + xoff).
    pub fn lookup_entry(&self, codepoint: u32) -> Option<&CmapEntry> {
        self.cmap
            .binary_search_by(|e| e.codepoint.cmp(&codepoint))
            .ok()
            .map(|i| &self.cmap[i])
    }

    #[inline]
    pub fn bytes_per_row(&self) -> usize {
        self.coverage_width() as usize
    }

    #[inline]
    pub fn coverage_width(&self) -> u32 {
        self.cell_w * self.raster_density as u32
    }

    #[inline]
    pub fn coverage_height(&self) -> u32 {
        self.cell_h * self.raster_density as u32
    }

    /// The density-scaled coverage bytes of one glyph (top row first).
    pub fn glyph_rows(&self, gid: u16) -> &[u8] {
        let per_glyph = self.coverage_height() as usize * self.bytes_per_row();
        let start = gid as usize * per_glyph;
        &self.bitmap[start..start + per_glyph]
    }

    /// Resident heap bytes requested for the transparent-pixel span table.
    /// This is zero for atlases where compact encoding would not beat the
    /// bitmap, when the feature is disabled, and on PSP, Nintendo 3DS, or
    /// ESP-IDF. Allocator metadata or size-class rounding is deliberately not
    /// included.
    pub fn glyph_span_storage_bytes(&self) -> usize {
        #[cfg(any(
            test,
            all(
                feature = "glyph-skip-zero",
                not(any(
                    target_os = "psp",
                    target_os = "horizon",
                    target_os = "espidf"
                ))
            )
        ))]
        {
            self.spans.len()
        }
        #[cfg(not(any(
            test,
            all(
                feature = "glyph-skip-zero",
                not(any(
                    target_os = "psp",
                    target_os = "horizon",
                    target_os = "espidf"
                ))
            )
        )))]
        {
            0
        }
    }

    /// Borrow the compact span index for software raster resources. `None`
    /// selects the dense scanner for disabled, hardware-only, or per-atlas
    /// fallback cases.
    pub(crate) fn glyph_span_index(&self) -> Option<&[u8]> {
        #[cfg(any(
            test,
            all(
                feature = "glyph-skip-zero",
                not(any(
                    target_os = "psp",
                    target_os = "horizon",
                    target_os = "espidf"
                ))
            )
        ))]
        {
            (!self.spans.is_empty()).then_some(&self.spans)
        }
        #[cfg(not(any(
            test,
            all(
                feature = "glyph-skip-zero",
                not(any(
                    target_os = "psp",
                    target_os = "horizon",
                    target_os = "espidf"
                ))
            )
        )))]
        {
            None
        }
    }

    /// Number of persistent allocations owned by the span index. The compact
    /// encoding is one boxed slice; a dense fallback, disabled build, PSP build,
    /// Nintendo 3DS build, or ESP-IDF build owns none. Rendering never mutates
    /// or allocates it.
    pub fn glyph_span_allocation_count(&self) -> usize {
        usize::from(self.glyph_span_storage_bytes() != 0)
    }

    /// Number of encoded nonzero spans. Intended for deterministic memory
    /// accounting and diagnostics; rasterization uses the row iterator.
    pub fn glyph_span_count(&self) -> usize {
        #[cfg(any(
            test,
            all(
                feature = "glyph-skip-zero",
                not(any(
                    target_os = "psp",
                    target_os = "horizon",
                    target_os = "espidf"
                ))
            )
        ))]
        {
            let mut count = 0;
            for gid in 0..self.glyph_count {
                if let Some(rows) = self.glyph_span_rows(gid) {
                    for row in rows {
                        count += row.spans().count();
                    }
                }
            }
            count
        }
        #[cfg(not(any(
            test,
            all(
                feature = "glyph-skip-zero",
                not(any(
                    target_os = "psp",
                    target_os = "horizon",
                    target_os = "espidf"
                ))
            )
        )))]
        {
            0
        }
    }

    #[cfg(any(
        test,
        all(
            feature = "glyph-skip-zero",
            not(any(
                target_os = "psp",
                target_os = "horizon",
                target_os = "espidf"
            ))
        )
    ))]
    pub(crate) fn glyph_span_rows(&self, gid: u16) -> Option<GlyphSpanRows<'_>> {
        glyph_span_rows_from_index(
            &self.spans,
            gid,
            self.glyph_count,
            self.coverage_width(),
            self.coverage_height(),
        )
    }

    /// Average one logical pixel's density×density coverage samples. This is
    /// the reference reduction for logical-resolution software/CPU fallback
    /// renderers; density 1 returns the original byte exactly.
    pub fn logical_coverage(&self, gid: u16, x: u32, y: u32) -> u8 {
        if gid >= self.glyph_count || x >= self.cell_w || y >= self.cell_h {
            return 0;
        }
        let density = self.raster_density as usize;
        let rows = self.glyph_rows(gid);
        let bpr = self.bytes_per_row();
        let x0 = x as usize * density;
        let y0 = y as usize * density;
        let mut sum = 0u32;
        for sample_y in 0..density {
            let row = (y0 + sample_y) * bpr;
            for sample_x in 0..density {
                sum += rows[row + x0 + sample_x] as u32;
            }
        }
        let samples = (density * density) as u32;
        ((sum + samples / 2) / samples) as u8
    }
}

#[cfg(any(
    test,
    all(
        feature = "glyph-skip-zero",
        not(any(
            target_os = "psp",
            target_os = "horizon",
            target_os = "espidf"
        ))
    )
))]
#[inline]
fn span_keeps_coverage(coverage: u8) -> bool {
    // Deliberate mutation for the byte-exact matrix: baked hero/note atlases
    // have no bytes 1..8 (their minimum nonzero byte is 9), so a <=1 mutant
    // would be invisible end to end. The 64 threshold changes real frames.
    #[cfg(feature = "glyph-skip-zero-mutant")]
    {
        coverage >= 64
    }
    #[cfg(not(feature = "glyph-skip-zero-mutant"))]
    {
        coverage != 0
    }
}

/// Build one compact allocation: u32 glyph offsets, then row span counts and
/// `(start, len)` pairs. Width-derived coordinates are u8 where possible and
/// u16 otherwise. A production atlas falls back to the dense scanner when
/// the encoded table would be no smaller than its bitmap; tests always build
/// the table so their synthetic counterexamples exercise the sparse code.
#[cfg(any(
    test,
    all(
        feature = "glyph-skip-zero",
        not(any(
            target_os = "psp",
            target_os = "horizon",
            target_os = "espidf"
        ))
    )
))]
fn build_glyph_spans(
    bitmap: &[u8],
    glyph_count: u16,
    coverage_w: usize,
    coverage_h: usize,
    dense_fallback: bool,
) -> Option<Box<[u8]>> {
    let glyphs = glyph_count as usize;
    let coord_bytes = if coverage_w <= u8::MAX as usize { 1 } else { 2 };
    let offsets_bytes = glyphs.checked_add(1)?.checked_mul(core::mem::size_of::<u32>())?;
    let rows = glyphs.checked_mul(coverage_h)?;
    let mut span_count = 0usize;
    for row in bitmap.chunks_exact(coverage_w) {
        let mut in_span = false;
        for &coverage in row {
            let ink = span_keeps_coverage(coverage);
            if ink && !in_span {
                span_count = span_count.checked_add(1)?;
            }
            in_span = ink;
        }
    }
    let encoded_bytes = rows
        .checked_add(span_count.checked_mul(2)?)?
        .checked_mul(coord_bytes)?
        .checked_add(offsets_bytes)?;
    if dense_fallback && encoded_bytes >= bitmap.len() {
        return Some(Vec::new().into_boxed_slice());
    }

    let mut encoded = Vec::with_capacity(encoded_bytes);
    encoded.resize(offsets_bytes, 0);
    let write_u32 = |bytes: &mut [u8], at: usize, value: usize| -> Option<()> {
        let value = u32::try_from(value).ok()?.to_le_bytes();
        bytes.get_mut(at..at + 4)?.copy_from_slice(&value);
        Some(())
    };
    let push_coord = |bytes: &mut Vec<u8>, value: usize| -> Option<()> {
        if coord_bytes == 1 {
            bytes.push(u8::try_from(value).ok()?);
        } else {
            bytes.extend_from_slice(&u16::try_from(value).ok()?.to_le_bytes());
        }
        Some(())
    };
    let write_coord = |bytes: &mut [u8], at: usize, value: usize| -> Option<()> {
        if coord_bytes == 1 {
            *bytes.get_mut(at)? = u8::try_from(value).ok()?;
        } else {
            bytes
                .get_mut(at..at + 2)?
                .copy_from_slice(&u16::try_from(value).ok()?.to_le_bytes());
        }
        Some(())
    };

    for gid in 0..glyphs {
        let glyph_offset = encoded.len();
        write_u32(&mut encoded, gid * 4, glyph_offset)?;
        let glyph_start = gid.checked_mul(coverage_h)?.checked_mul(coverage_w)?;
        for sy in 0..coverage_h {
            let row_start = glyph_start.checked_add(sy.checked_mul(coverage_w)?)?;
            let row = bitmap.get(row_start..row_start + coverage_w)?;
            let count_at = encoded.len();
            push_coord(&mut encoded, 0)?;
            let mut count = 0usize;
            let mut sx = 0usize;
            while sx < coverage_w {
                if !span_keeps_coverage(row[sx]) {
                    sx += 1;
                    continue;
                }
                let start = sx;
                sx += 1;
                while sx < coverage_w && span_keeps_coverage(row[sx]) {
                    sx += 1;
                }
                push_coord(&mut encoded, start)?;
                push_coord(&mut encoded, sx - start)?;
                count += 1;
            }
            write_coord(&mut encoded, count_at, count)?;
        }
    }
    let end_offset = encoded.len();
    write_u32(&mut encoded, glyphs * 4, end_offset)?;
    debug_assert_eq!(encoded.len(), encoded_bytes);
    Some(encoded.into_boxed_slice())
}

#[cfg(any(
    test,
    all(
        feature = "glyph-skip-zero",
        not(any(
            target_os = "psp",
            target_os = "horizon",
            target_os = "espidf"
        ))
    )
))]
pub(crate) struct GlyphSpanRows<'a> {
    bytes: &'a [u8],
    coord_bytes: usize,
    rows_left: u32,
}

#[cfg(any(
    test,
    all(
        feature = "glyph-skip-zero",
        not(any(
            target_os = "psp",
            target_os = "horizon",
            target_os = "espidf"
        ))
    )
))]
pub(crate) fn glyph_span_rows_from_index(
    index: &[u8],
    gid: u16,
    glyph_count: u16,
    coverage_width: u32,
    coverage_height: u32,
) -> Option<GlyphSpanRows<'_>> {
    if index.is_empty() || gid >= glyph_count {
        return None;
    }
    let offset_at = |glyph: usize| {
        let at = glyph * core::mem::size_of::<u32>();
        rd_u32(index, at).map(|offset| offset as usize)
    };
    let start = offset_at(gid as usize)?;
    let end = offset_at(gid as usize + 1)?;
    Some(GlyphSpanRows {
        bytes: index.get(start..end)?,
        coord_bytes: if coverage_width <= u8::MAX as u32 {
            1
        } else {
            2
        },
        rows_left: coverage_height,
    })
}

#[cfg(any(
    test,
    all(
        feature = "glyph-skip-zero",
        not(any(
            target_os = "psp",
            target_os = "horizon",
            target_os = "espidf"
        ))
    )
))]
impl<'a> Iterator for GlyphSpanRows<'a> {
    type Item = GlyphSpanRow<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.rows_left == 0 {
            return None;
        }
        let count = read_span_coord(self.bytes, self.coord_bytes)?;
        self.bytes = self.bytes.get(self.coord_bytes..)?;
        let byte_len = count.checked_mul(2)?.checked_mul(self.coord_bytes)?;
        let row = self.bytes.get(..byte_len)?;
        self.bytes = self.bytes.get(byte_len..)?;
        self.rows_left -= 1;
        Some(GlyphSpanRow {
            bytes: row,
            coord_bytes: self.coord_bytes,
        })
    }
}

#[cfg(any(
    test,
    all(
        feature = "glyph-skip-zero",
        not(any(
            target_os = "psp",
            target_os = "horizon",
            target_os = "espidf"
        ))
    )
))]
pub(crate) struct GlyphSpanRow<'a> {
    bytes: &'a [u8],
    coord_bytes: usize,
}

#[cfg(any(
    test,
    all(
        feature = "glyph-skip-zero",
        not(any(
            target_os = "psp",
            target_os = "horizon",
            target_os = "espidf"
        ))
    )
))]
impl<'a> GlyphSpanRow<'a> {
    pub(crate) fn spans(self) -> GlyphSpans<'a> {
        GlyphSpans {
            bytes: self.bytes,
            coord_bytes: self.coord_bytes,
        }
    }
}

#[cfg(any(
    test,
    all(
        feature = "glyph-skip-zero",
        not(any(
            target_os = "psp",
            target_os = "horizon",
            target_os = "espidf"
        ))
    )
))]
pub(crate) struct GlyphSpans<'a> {
    bytes: &'a [u8],
    coord_bytes: usize,
}

#[cfg(any(
    test,
    all(
        feature = "glyph-skip-zero",
        not(any(
            target_os = "psp",
            target_os = "horizon",
            target_os = "espidf"
        ))
    )
))]
impl Iterator for GlyphSpans<'_> {
    type Item = (usize, usize);

    fn next(&mut self) -> Option<Self::Item> {
        if self.bytes.is_empty() {
            return None;
        }
        let start = read_span_coord(self.bytes, self.coord_bytes)?;
        self.bytes = self.bytes.get(self.coord_bytes..)?;
        let len = read_span_coord(self.bytes, self.coord_bytes)?;
        self.bytes = self.bytes.get(self.coord_bytes..)?;
        Some((start, len))
    }
}

#[cfg(any(
    test,
    all(
        feature = "glyph-skip-zero",
        not(any(
            target_os = "psp",
            target_os = "horizon",
            target_os = "espidf"
        ))
    )
))]
#[inline]
fn read_span_coord(bytes: &[u8], coord_bytes: usize) -> Option<usize> {
    if coord_bytes == 1 {
        Some(*bytes.first()? as usize)
    } else {
        Some(rd_u16(bytes, 0)? as usize)
    }
}

#[cfg(test)]
mod span_tests {
    use super::*;

    fn atlas_blob(cell_w: u8, cell_h: u8, density: u8, bitmap: &[u8]) -> Vec<u8> {
        let mut atlas = Vec::new();
        atlas.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
        atlas.extend_from_slice(&spec::font_atlas::VERSION.to_le_bytes());
        atlas.extend_from_slice(&1u16.to_le_bytes());
        atlas.extend_from_slice(&[cell_w, cell_h, cell_h, cell_h, 0, 0, density, 0]);
        while atlas.len() < spec::font_atlas::HEADER_SIZE {
            atlas.push(0);
        }
        atlas.extend_from_slice(&65u32.to_le_bytes());
        atlas.extend_from_slice(&0u16.to_le_bytes());
        atlas.extend_from_slice(&[cell_w, 0]);
        atlas.extend_from_slice(bitmap);
        atlas
    }

    #[test]
    fn glyph_spans_use_one_exact_allocation_and_preserve_row_boundaries() {
        let atlas = Atlas::parse(&atlas_blob(8, 3, 1, &[
            0, 7, 8, 0, 9, 10, 11, 0,
            0, 0, 0, 0, 0, 0, 0, 0,
            1, 0, 2, 0, 3, 0, 4, 0,
        ]))
        .unwrap();
        let rows: Vec<Vec<(usize, usize)>> = atlas
            .glyph_span_rows(0)
            .unwrap()
            .map(|row| row.spans().collect())
            .collect();
        assert_eq!(rows, vec![vec![(1, 2), (4, 3)], vec![], vec![(0, 1), (2, 1), (4, 1), (6, 1)]]);
        // 2 u32 offsets + 3 u8 row counts + 6 (u8,u8) span pairs.
        assert_eq!(atlas.glyph_span_storage_bytes(), 23);
        assert_eq!(atlas.glyph_span_allocation_count(), 1);
        assert_eq!(atlas.glyph_span_count(), 6);
    }

    #[test]
    fn glyph_spans_support_u16_coordinates() {
        let mut bitmap = vec![0; 256 * 2];
        bitmap[255] = 99;
        let atlas = Atlas::parse(&atlas_blob(128, 1, 2, &bitmap)).unwrap();
        let rows: Vec<Vec<(usize, usize)>> = atlas
            .glyph_span_rows(0)
            .unwrap()
            .map(|row| row.spans().collect())
            .collect();
        assert_eq!(rows, vec![vec![(255, 1)], vec![]]);
        // 2 u32 offsets + 2 u16 row counts + one (u16,u16) pair.
        assert_eq!(atlas.glyph_span_storage_bytes(), 16);
    }

    #[test]
    fn glyph_spans_fall_back_when_encoding_is_not_smaller() {
        let alternating = [1, 0, 1, 0, 1, 0, 1, 0];
        let encoded = build_glyph_spans(&alternating, 1, 8, 1, true).unwrap();
        assert!(encoded.is_empty());
    }
}

/// A placed glyph from inline-run layout: cell top-left relative to the box
/// origin.
#[derive(Clone, Copy, Debug)]
pub struct GlyphPos {
    pub gid: u16,
    pub codepoint: u32,
    pub x: f32,
    pub y: f32,
}

/// A host-installed native text measurer: `(text, slot, tracking,
/// line_h_override) -> (max line width, total height)` in logical px, with the
/// same `'\n'`-only line-break contract as [`Fonts::measure_run`]
/// (`line_h_override` NAN = the measurer's default for the slot). Installed by
/// native-text backends (docs/BACKENDS.md) through `Ui::set_text_measure`
/// before the guest mounts; fixed-function hosts never install one.
pub type MeasureFn = alloc::boxed::Box<dyn Fn(&str, u8, f32, f32) -> (f32, f32)>;

/// A host-installed native line wrapper: `(text, slot, max_w) -> soft-break
/// columns` (ascending, in UTF-16 code units — the guest slices JS strings
/// with them). Installed by native-text backends through `Ui::set_text_wrap`
/// next to the measurer, so break positions and measured advances always
/// come from the same provider; without one, `wrap_text` computes greedy
/// breaks over whatever provider `measure_run` resolves to.
pub type WrapFn = alloc::boxed::Box<dyn Fn(&str, u8, f32) -> alloc::vec::Vec<u32>>;

/// The per-core atlas registry.
pub struct Fonts {
    slots: [Option<Atlas>; spec::MAX_FONT_SLOTS],
    /// cmap-miss counter (Cell: measurement is `&self` per the pinned `Ui`
    /// signature but a miss must still count).
    pub misses: Cell<u32>,
    /// Native measurer; when present, tracking-0 runs measure through it
    /// (and draw.rs emits TEXT_RUN instead of GLYPH_RUN for them). Tracked
    /// runs keep the baked path on BOTH sides so a node's measured metrics
    /// always match its painted glyphs.
    native: Option<MeasureFn>,
    /// Native line wrapper (OP wrapText); absent = greedy over `measure_run`.
    wrap_native: Option<WrapFn>,
}

impl Default for Fonts {
    fn default() -> Self {
        Self::new()
    }
}

impl Fonts {
    pub(crate) fn merge_atlases(&mut self, staged: &mut Fonts) {
        for (destination, source) in self.slots.iter_mut().zip(staged.slots.iter_mut()) {
            if source.is_some() {
                *destination = source.take();
            }
        }
    }

    pub fn new() -> Fonts {
        Fonts {
            slots: Default::default(),
            misses: Cell::new(0),
            native: None,
            wrap_native: None,
        }
    }

    /// Install (or clear) the native measurer. Callers relayout afterwards —
    /// every text leaf's metrics change provider.
    pub fn set_native_measure(&mut self, f: Option<MeasureFn>) {
        self.native = f;
    }

    /// Install (or clear) the native line wrapper (OP wrapText).
    pub fn set_native_wrap(&mut self, f: Option<WrapFn>) {
        self.wrap_native = f;
    }

    /// True when a native measurer is installed.
    #[inline]
    pub fn native_active(&self) -> bool {
        self.native.is_some()
    }

    /// Parse + register an atlas at the slot in its header.
    pub fn load(&mut self, bytes: &[u8]) -> bool {
        match Atlas::parse(bytes) {
            Some(a) => {
                let slot = a.slot as usize;
                self.slots[slot] = Some(a);
                true
            }
            None => false,
        }
    }

    #[inline]
    pub fn atlas(&self, slot: u8) -> Option<&Atlas> {
        self.slots.get(slot as usize)?.as_ref()
    }

    pub(crate) fn atlas_mut(&mut self, slot: u8) -> Option<&mut Atlas> {
        self.slots.get_mut(slot as usize)?.as_mut()
    }

    /// (gid, advance, xoff) for a codepoint; a miss resolves to gid 0 (tofu,
    /// cell width advance) and bumps the miss counter.
    fn glyph(&self, atlas: &Atlas, cp: u32) -> (u16, f32, f32) {
        match atlas.lookup_entry(cp) {
            Some(e) => (e.gid, e.advance as f32, e.xoff as f32),
            None => {
                self.misses.set(self.misses.get().wrapping_add(1));
                (0, atlas.stream.as_ref().map_or(atlas.cell_w as f32, |s| s.advance as f32), 0.0)
            }
        }
    }

    /// Measure a run: (max line width, line count x line height). Empty text
    /// or an unregistered slot measures (0, 0). With a native measurer
    /// installed, tracking-0 runs route to it — the auto-gate the JS-facing
    /// `measureText` op uses. Layout does NOT call this: it picks a provider
    /// per node and records it (`measure_run_provider`; layout.rs build()).
    pub fn measure_run(
        &self,
        text: &str,
        slot: u8,
        tracking: f32,
        line_h_override: f32,
    ) -> (f32, f32) {
        self.measure_run_provider(
            self.native.is_some() && tracking == 0.0,
            text,
            slot,
            tracking,
            line_h_override,
        )
    }

    /// Measure with an EXPLICIT provider choice. `native: true` requires an
    /// installed measurer (falls back to the atlas without one); layout
    /// records the choice on the node so paint always uses the provider
    /// that sized the box (docs/BACKENDS.md).
    pub fn measure_run_provider(
        &self,
        native: bool,
        text: &str,
        slot: u8,
        tracking: f32,
        line_h_override: f32,
    ) -> (f32, f32) {
        if text.is_empty() {
            return (0.0, 0.0);
        }
        if native {
            if let Some(f) = &self.native {
                return f(text, slot, tracking, line_h_override);
            }
        }
        let Some(atlas) = self.atlas(slot) else {
            return (0.0, 0.0);
        };
        let lh = if line_h_override.is_nan() {
            atlas.line_height as f32
        } else {
            line_h_override
        };
        let mut max_w = 0.0f32;
        let mut line_w = 0.0f32;
        let mut lines = 1u32;
        for ch in text.chars() {
            if ch == '\n' {
                max_w = max_w.max(line_w);
                line_w = 0.0;
                lines += 1;
                continue;
            }
            let (_, adv, _) = self.glyph(atlas, ch as u32);
            line_w += adv + tracking;
        }
        max_w = max_w.max(line_w);
        (max_w, lines as f32 * lh)
    }

    /// Soft-wrap break columns for ONE line of text under `max_w` px
    /// (ascending, UTF-16 code units; empty = the line fits). With a native
    /// wrapper installed it decides; otherwise greedy word wrap over
    /// whatever provider `measure_run` resolves to (atlas advances, or the
    /// native measurer for tracking-0 native apps) — break positions always
    /// derive from the metrics that size and paint the text.
    ///
    /// Greedy rules (pinned by the JS-fallback parity test): break BEFORE
    /// the word that overflows; space runs never break — they hang past
    /// `max_w` on the row they follow (classic Notepad); a word wider than a
    /// whole row splits at character level.
    pub fn wrap_text(&self, text: &str, slot: u8, max_w: f32) -> Vec<u32> {
        if let Some(f) = &self.wrap_native {
            return f(text, slot, max_w);
        }
        self.wrap_greedy(text, slot, max_w)
    }

    fn wrap_greedy(&self, text: &str, slot: u8, max_w: f32) -> Vec<u32> {
        let mut breaks = Vec::new();
        if text.is_empty() || max_w.is_nan() || max_w <= 0.0 {
            return breaks;
        }
        let width = |a: usize, b: usize| self.measure_run(&text[a..b], slot, 0.0, f32::NAN).0;
        if width(0, text.len()) <= max_w {
            return breaks;
        }
        // Per-char byte offsets + running UTF-16 columns (the guest slices
        // JS strings, whose indices are UTF-16 code units).
        let chars: Vec<(usize, char)> = text.char_indices().collect();
        let n = chars.len();
        let mut u16_at = Vec::with_capacity(n + 1);
        let mut acc = 0u32;
        for &(_, c) in &chars {
            u16_at.push(acc);
            acc += c.len_utf16() as u32;
        }
        u16_at.push(acc);
        let byte_at = |ci: usize| if ci < n { chars[ci].0 } else { text.len() };
        let w = |a: usize, b: usize| width(byte_at(a), byte_at(b));

        let mut seg_from = 0usize; // char index of the current visual row start
        let mut x = 0f32; // committed row width (hanging spaces included)
        let mut i = 0usize;
        while i < n {
            if chars[i].1 == ' ' {
                let mut j = i;
                while j < n && chars[j].1 == ' ' {
                    j += 1;
                }
                x += w(i, j);
                i = j;
                continue;
            }
            let mut j = i;
            while j < n && chars[j].1 != ' ' {
                j += 1;
            }
            let word_w = w(i, j);
            if i > seg_from && x + word_w > max_w {
                breaks.push(u16_at[i]);
                seg_from = i;
                x = 0.0;
            }
            if word_w > max_w {
                // A word wider than a whole row: hard character chunks.
                let mut cw = 0f32;
                for k in i..j {
                    let ch_w = w(k, k + 1);
                    if k > seg_from && cw + ch_w > max_w {
                        breaks.push(u16_at[k]);
                        seg_from = k;
                        cw = 0.0;
                    }
                    cw += ch_w;
                }
                x = cw;
                i = j;
                continue;
            }
            x += word_w;
            i = j;
        }
        breaks
    }

    /// Inline-run layout: place every glyph (cell top-left, relative to the
    /// box origin) honoring text-align within `box_w` and per-line vertical
    /// centering of the glyph cell inside the line box.
    pub fn layout_run(
        &self,
        text: &str,
        slot: u8,
        tracking: f32,
        line_h_override: f32,
        align: u8,
        box_w: f32,
        out: &mut Vec<GlyphPos>,
    ) {
        let Some(atlas) = self.atlas(slot) else {
            return;
        };
        if text.is_empty() {
            return;
        }
        let lh = if line_h_override.is_nan() {
            atlas.line_height as f32
        } else {
            line_h_override
        };
        let cell_h = atlas.cell_h as f32;
        let mut line_top = 0.0f32;
        for line in text.split('\n') {
            // Single glyph pass per line (so cmap misses count once): place
            // at pen-from-0, then shift the whole line by the align offset.
            let line_start = out.len();
            let mut pen = 0.0f32;
            let y = line_top + (lh - cell_h) * 0.5;
            for ch in line.chars() {
                let (gid, adv, xoff) = self.glyph(atlas, ch as u32);
                // The cell holds the outline shifted right by xoff (negative
                // LSB accents) — place it at pen - xoff so ink lands at pen.
                out.push(GlyphPos {
                    gid,
                    codepoint: ch as u32,
                    x: pen - xoff,
                    y,
                });
                pen += adv + tracking;
            }
            let offset = match align {
                a if a == spec::TextAlign::Center as u8 => (box_w - pen) * 0.5,
                a if a == spec::TextAlign::Right as u8 => box_w - pen,
                _ => 0.0,
            };
            if offset != 0.0 {
                for g in &mut out[line_start..] {
                    g.x += offset;
                }
            }
            line_top += lh;
        }
    }
}
