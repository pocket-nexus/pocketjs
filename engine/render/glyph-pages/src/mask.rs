use crate::GlyphSource;
use pocket_drivers::{DamageRect, FontView};

/// Integer source-over for A8 coverage; each blend rounds once.
#[inline]
pub fn composite_mask(destination: &mut u8, source: u8) {
    let d = *destination as u32;
    let s = source as u32;
    *destination = (s + (d * (255 - s) + 127) / 255) as u8;
}

/// Fill a rectangle in a row-major A8 mask. Validation precedes writes.
#[allow(clippy::too_many_arguments)]
pub fn fill_mask_rect(
    mask: &mut [u8],
    stride: usize,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    value: u8,
) -> bool {
    let Some(x1) = (x as usize).checked_add(width as usize) else {
        return false;
    };
    let Some(y1) = (y as usize).checked_add(height as usize) else {
        return false;
    };
    if stride == 0 || x1 > stride || y1 > mask.len() / stride {
        return false;
    }
    for row in y as usize..y1 {
        let start = row * stride + x as usize;
        mask[start..start + width as usize].fill(value);
    }
    true
}

/// Expand glyph pairs from a DrawList GLYPH_RUN into an A8 mask. Coordinates
/// and clip are physical after scale; origin locates a strip's first pixel in
/// the full target. Existing coverage is blended in painter order.
#[allow(clippy::too_many_arguments)]
pub fn blend_glyph_run(
    font: FontView<'_>,
    glyphs: &[u32],
    mask: &mut [u8],
    stride: usize,
    origin: [i32; 2],
    clip: DamageRect,
    scale: u32,
    alpha: u8,
) -> bool {
    let Some(source) = GlyphSource::from_font(font, 0) else {
        return false;
    };
    if scale == 0 || stride == 0 || !glyphs.len().is_multiple_of(2) {
        return false;
    }
    let Ok(width) = i64::try_from(stride) else {
        return false;
    };
    let Ok(height) = i64::try_from(mask.len() / stride) else {
        return false;
    };
    let ox = i64::from(origin[0]);
    let oy = i64::from(origin[1]);
    let Some(right) = ox.checked_add(width) else {
        return false;
    };
    let Some(bottom) = oy.checked_add(height) else {
        return false;
    };
    let x0 = i64::from(clip.x0).max(ox);
    let y0 = i64::from(clip.y0).max(oy);
    let x1 = i64::from(clip.x1).min(right);
    let y1 = i64::from(clip.y1).min(bottom);
    let scale = i64::from(scale);
    let density = i64::from(font.raster_density);
    let Some(glyph_width) = i64::from(font.cell_w).checked_mul(scale) else {
        return false;
    };
    let Some(glyph_height) = i64::from(font.cell_h).checked_mul(scale) else {
        return false;
    };
    // Validate every placement before writes, including unused glyph ids.
    for glyph in glyphs.as_chunks::<2>().0 {
        let gx = i64::from(glyph[0] as u16 as i16) * scale;
        let gy = i64::from((glyph[0] >> 16) as u16 as i16) * scale;
        if gx.checked_add(glyph_width).is_none() || gy.checked_add(glyph_height).is_none() {
            return false;
        }
    }
    for glyph in glyphs.as_chunks::<2>().0 {
        let gid = (glyph[1] & 0xffff) as u16;
        let Some(rows) = source.glyph_rows(gid) else {
            continue;
        };
        let gx = i64::from(glyph[0] as u16 as i16) * scale;
        let gy = i64::from((glyph[0] >> 16) as u16 as i16) * scale;
        let right = gx + glyph_width;
        let bottom = gy + glyph_height;
        if density == scale {
            let left = x0.max(gx);
            let right = x1.min(right);
            if left < right {
                let count = (right - left) as usize;
                for py in y0.max(gy)..y1.min(bottom) {
                    let source = (py - gy) as usize * source.stride + (left - gx) as usize;
                    let target = (py - oy) as usize * stride + (left - ox) as usize;
                    for (pixel, &coverage) in mask[target..target + count]
                        .iter_mut()
                        .zip(&rows[source..source + count])
                    {
                        if coverage == 0 {
                            continue;
                        }
                        let coverage = ((u32::from(coverage) * u32::from(alpha) + 127) / 255) as u8;
                        if *pixel == 0 {
                            *pixel = coverage;
                        } else {
                            composite_mask(pixel, coverage);
                        }
                    }
                }
            }
            continue;
        }
        for py in y0.max(gy)..y1.min(bottom) {
            let sy = (((2 * (py - gy) + 1) * density) / (2 * scale))
                .clamp(0, i64::from(source.height) - 1) as usize;
            for px in x0.max(gx)..x1.min(right) {
                let sx = (((2 * (px - gx) + 1) * density) / (2 * scale))
                    .clamp(0, source.stride as i64 - 1) as usize;
                let coverage = ((u32::from(rows[sy * source.stride + sx]) * u32::from(alpha) + 127)
                    / 255) as u8;
                let offset = (py - oy) as usize * stride + (px - ox) as usize;
                composite_mask(&mut mask[offset], coverage);
            }
        }
    }
    true
}
