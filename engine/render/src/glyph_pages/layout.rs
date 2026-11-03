use pocket_drivers::FontView;

/// Validated font storage plus the width the GPU needs. FontView itself keeps
/// its original field set so external struct literals remain valid.
#[derive(Clone, Copy)]
pub struct GlyphSource<'a> {
    pub(crate) font: FontView<'a>,
    pub(crate) slot: u8,
    pub(crate) texture_width: u32,
    pub(crate) stride: usize,
    pub(crate) height: u32,
}
impl<'a> GlyphSource<'a> {
    pub fn new(font: FontView<'a>, slot: u8, texture_width: u32) -> Option<Self> {
        let width = font.cell_w.checked_mul(font.raster_density as u32)?;
        let height = font.cell_h.checked_mul(font.raster_density as u32)?;
        if width == 0 || height == 0 || texture_width == 0 || texture_width > width {
            return None;
        }
        let stride = usize::try_from(width).ok()?;
        let bytes = stride
            .checked_mul(height as usize)?
            .checked_mul(font.glyph_count as usize)?;
        if font.bitmap.len() < bytes {
            return None;
        }
        Some(Self {
            font,
            slot,
            texture_width,
            stride,
            height,
        })
    }
    pub fn from_font(font: FontView<'a>, slot: u8) -> Option<Self> {
        let width = font.cell_w.checked_mul(font.raster_density as u32)?;
        Self::new(font, slot, width)
    }
    pub fn font(&self) -> FontView<'a> {
        self.font
    }
    pub fn slot(&self) -> u8 {
        self.slot
    }
    pub fn texture_width(&self) -> u32 {
        self.texture_width
    }
    pub fn glyph_rows(&self, gid: u16) -> Option<&'a [u8]> {
        if gid >= self.font.glyph_count {
            return None;
        }
        let len = self.stride.checked_mul(self.height as usize)?;
        let start = len.checked_mul(gid as usize)?;
        self.font.bitmap.get(start..start.checked_add(len)?)
    }
}

/// One guarded A8 page. Each cell has a transparent one-texel border so linear
/// sampling cannot bleed a neighboring glyph. The layout preserves the core's
/// existing transformed-text page and guarded-white-patch byte representation.
#[derive(Clone, Copy, Debug)]
pub struct GlyphPageLayout {
    page: u32,
    first: u32,
    count: u32,
    columns: u32,
    stride_x: u32,
    stride_y: u32,
    width: u32,
    height: u32,
}
impl GlyphPageLayout {
    pub fn new(font: FontView<'_>, gid: u16) -> Option<Self> {
        Self::with_limit(font, gid, pocket_spec::TEX_MAX_DIM)
    }
    pub fn with_limit(font: FontView<'_>, gid: u16, max_dimension: u32) -> Option<Self> {
        let source = GlyphSource::from_font(font, 0)?;
        if gid >= font.glyph_count {
            return None;
        }
        let stride_x = u32::try_from(source.stride).ok()?.checked_add(2)?;
        let stride_y = source.height.checked_add(2)?;
        let columns = max_dimension / stride_x;
        let rows = max_dimension / stride_y;
        if columns == 0 || rows == 0 {
            return None;
        }
        let capacity = columns.checked_mul(rows)?;
        let page = gid as u32 / capacity;
        let first = page.checked_mul(capacity)?;
        let count = (font.glyph_count as u32 - first).min(capacity);
        let width = columns
            .min(count)
            .checked_mul(stride_x)?
            .checked_next_power_of_two()?;
        let height = count
            .div_ceil(columns)
            .checked_mul(stride_y)?
            .checked_next_power_of_two()?;
        if width > max_dimension || height > max_dimension {
            return None;
        }
        Some(Self {
            page,
            first,
            count,
            columns,
            stride_x,
            stride_y,
            width,
            height,
        })
    }
    pub fn page(&self) -> u32 {
        self.page
    }
    pub fn first(&self) -> u32 {
        self.first
    }
    pub fn count(&self) -> u32 {
        self.count
    }
    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn coverage_bytes(&self) -> usize {
        self.width as usize * self.height as usize
    }
    pub fn sampler(&self, handle: u32) -> GlyphSampler {
        GlyphSampler {
            handle,
            first: self.first,
            end: self.first + self.count,
            columns: self.columns,
            stride_x: self.stride_x,
            stride_y: self.stride_y,
            width: self.width,
            height: self.height,
        }
    }
    /// Write the full page and its transparent padding. Returns false without
    /// writing when the caller's font dimensions or output capacity differ.
    pub fn expand_a8(&self, font: FontView<'_>, output: &mut [u8]) -> bool {
        let Some(source) = GlyphSource::from_font(font, 0) else {
            return false;
        };
        if source.stride + 2 != self.stride_x as usize
            || source.height + 2 != self.stride_y
            || self.first + self.count > font.glyph_count as u32
            || output.len() < self.coverage_bytes()
        {
            return false;
        }
        let bytes = &mut output[..self.coverage_bytes()];
        bytes.fill(0);
        for n in 0..self.count {
            let source_rows = source.glyph_rows((self.first + n) as u16).unwrap();
            let x = n % self.columns * self.stride_x + 1;
            let y = n / self.columns * self.stride_y + 1;
            for row in 0..source.height {
                let from = row as usize * source.stride;
                let to = (y + row) as usize * self.width as usize + x as usize;
                bytes[to..to + source.stride]
                    .copy_from_slice(&source_rows[from..from + source.stride]);
            }
        }
        let used_rows = self.count.div_ceil(self.columns) * self.stride_y;
        if self.height >= used_rows + 6 && self.width >= 6 {
            for y in used_rows + 2..used_rows + 6 {
                let start = (y * self.width + 2) as usize;
                bytes[start..start + 4].fill(255);
            }
        } else if !self.count.is_multiple_of(self.columns)
            && self.stride_x >= 8
            && self.stride_y >= 8
        {
            let x = self.count % self.columns * self.stride_x + 2;
            let y = self.count / self.columns * self.stride_y + 2;
            if x + 4 <= self.width && y + 4 <= self.height {
                for row in y..y + 4 {
                    let start = (row * self.width + x) as usize;
                    bytes[start..start + 4].fill(255);
                }
            }
        }
        true
    }
}

#[derive(Clone, Copy, Debug)]
pub struct GlyphSampler {
    pub handle: u32,
    first: u32,
    end: u32,
    columns: u32,
    stride_x: u32,
    stride_y: u32,
    width: u32,
    height: u32,
}
impl GlyphSampler {
    pub fn contains(&self, gid: u16) -> bool {
        gid as u32 >= self.first && (gid as u32) < self.end
    }
    pub fn uv(&self, gid: u16) -> [f32; 4] {
        assert!(self.contains(gid), "glyph does not belong to this page");
        let n = gid as u32 - self.first;
        let x = n % self.columns * self.stride_x + 1;
        let y = n / self.columns * self.stride_y + 1;
        [
            x as f32 / self.width as f32,
            y as f32 / self.height as f32,
            (x + self.stride_x - 2) as f32 / self.width as f32,
            (y + self.stride_y - 2) as f32 / self.height as f32,
        ]
    }
}
