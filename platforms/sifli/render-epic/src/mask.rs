//! CPU construction of A8 coverage planes for glyph runs and alpha-only
//! textures. The formulas match the core rasterizer's coverage and sampling
//! so a hardware A8 blend reproduces the software result.
//!
//! A plane is addressed through a `window`: the physical rectangle whose
//! top-left corner is byte 0 of the plane, `stride` bytes per row. Executors
//! hand out planes smaller than the target, so callers split large runs into
//! windows that fit.

use pocket_drivers::{FontView, TexView};
use pocket_glyph_pages::composite_mask;
use pocket_raster::{coverage_index, linear_sample_coordinates};
use pocket_spec as spec;

use crate::geom::{logical_rect, physical_rect, wh, xy, Clip, Rect};

/// Set the first `window.w * window.h` bytes of a plane (stride `stride`)
/// to `value`.
#[inline]
pub fn fill_mask_window(mask: &mut [u8], stride: u32, window: Rect, value: u8) {
    for y in 0..window.h {
        let start = y as usize * stride as usize;
        mask[start..start + window.w as usize].fill(value);
    }
}

/// Composite one GLYPH_RUN's atlas coverage into the plane window.
///
/// `bounds` limits the composited pixels; `window` is the plane's physical
/// rectangle. `alpha` is the run color's alpha, folded into the coverage.
#[allow(clippy::too_many_arguments)]
pub fn composite_glyph_run(
    atlas: &FontView<'_>,
    op: &[u32],
    bounds: Rect,
    scale: u32,
    alpha: u32,
    mask: &mut [u8],
    stride: u32,
    window: Rect,
) {
    let scale = scale as i32;
    let cell_w = atlas.cell_w as i32;
    let cell_h = atlas.cell_h as i32;
    let density = atlas.raster_density as i32;
    let coverage_w = atlas.coverage_width() as i32;
    let coverage_h = atlas.coverage_height() as i32;
    let bpr = atlas.bytes_per_row();
    let origin_x = window.x as i32;
    let origin_y = window.y as i32;
    for glyph in op[3..].as_chunks::<2>().0 {
        let (gx, gy) = xy(glyph[0]);
        let gid = (glyph[1] & 0xffff) as u16;
        if gid >= atlas.glyph_count {
            continue;
        }
        let rows = atlas.glyph_rows(gid);
        let x0 = (gx * scale).max(bounds.x as i32);
        let y0 = (gy * scale).max(bounds.y as i32);
        let x1 = ((gx + cell_w) * scale).min((bounds.x + bounds.w) as i32);
        let y1 = ((gy + cell_h) * scale).min((bounds.y + bounds.h) as i32);
        for py in y0..y1 {
            let sy = coverage_index(py - gy * scale, scale, density, coverage_h);
            let row = &rows[sy * bpr..];
            let mask_row = (py - origin_y) as usize * stride as usize;
            for px in x0..x1 {
                let sx = coverage_index(px - gx * scale, scale, density, coverage_w);
                composite_mask(
                    &mut mask[mask_row + (px - origin_x) as usize],
                    ((row[sx] as u32 * alpha + 127) / 255) as u8,
                );
            }
        }
    }
}

#[inline]
fn texel_alpha(view: &TexView<'_>, x: i32, y: i32) -> u32 {
    let x = x.clamp(0, view.w as i32 - 1) as usize;
    let y = y.clamp(0, view.h as i32 - 1) as usize;
    let index = y * view.w as usize + x;
    match view.psm {
        spec::psm::PSM_8888 => view.pixels[index * 4 + 3] as u32,
        spec::psm::PSM_4444 => {
            let o = index * 2;
            ((u16::from_le_bytes([view.pixels[o], view.pixels[o + 1]]) >> 12) as u32) * 17
        }
        spec::psm::PSM_T8 => view.palette.map_or(0, |palette| {
            palette[view.pixels[index] as usize * 4 + 3] as u32
        }),
        _ => 0,
    }
}

/// Alpha of a texture at normalized `(u, v)`, nearest or bilinear exactly as
/// the core samples it.
pub fn sample_alpha(view: &TexView<'_>, u: f32, v: f32) -> u8 {
    if !view.linear {
        return texel_alpha(view, (u * view.w as f32) as i32, (v * view.h as f32) as i32) as u8;
    }
    let Some(sample) = linear_sample_coordinates(view.w, view.h, u, v) else {
        return 0;
    };
    let lerp = |a: u32, b: u32, f: u32| (a * (256 - f) + b * f) >> 8;
    let top = lerp(
        texel_alpha(view, sample.x0 as i32, sample.y0 as i32),
        texel_alpha(view, sample.x1 as i32, sample.y0 as i32),
        sample.fx,
    );
    let bottom = lerp(
        texel_alpha(view, sample.x0 as i32, sample.y1 as i32),
        texel_alpha(view, sample.x1 as i32, sample.y1 as i32),
        sample.fx,
    );
    lerp(top, bottom, sample.fy) as u8
}

/// Composite one TEX_QUAD's alpha channel (times `global_alpha`) into the
/// plane window, restricted to the logical `clip`.
#[allow(clippy::too_many_arguments)]
pub fn alpha_quad_into_mask(
    view: &TexView<'_>,
    op: &[u32],
    clip: Clip,
    scale: u32,
    mask: &mut [u8],
    stride: u32,
    global_alpha: u8,
    window: Rect,
) {
    let logical = logical_rect(op[2], op[3]).intersect(clip);
    if logical.is_empty() {
        return;
    }
    let (x, y) = xy(op[2]);
    let (w, h) = wh(op[3]);
    let scale_i = scale as i32;
    let physical = physical_rect(logical, scale);
    let origin_x = window.x as i32;
    let origin_y = window.y as i32;
    let u0 = f32::from_bits(op[4]);
    let v0 = f32::from_bits(op[5]);
    let u1 = f32::from_bits(op[6]);
    let v1 = f32::from_bits(op[7]);
    for py in physical.y..physical.y + physical.h {
        let v = v0 + (v1 - v0) * ((py as i32 - y * scale_i) as f32 + 0.5) / (h * scale_i) as f32;
        let mask_row = (py as i32 - origin_y) as usize * stride as usize;
        for px in physical.x..physical.x + physical.w {
            let u =
                u0 + (u1 - u0) * ((px as i32 - x * scale_i) as f32 + 0.5) / (w * scale_i) as f32;
            let alpha = (sample_alpha(view, u, v) as u32 * global_alpha as u32 + 127) / 255;
            composite_mask(
                &mut mask[mask_row + (px as i32 - origin_x) as usize],
                alpha as u8,
            );
        }
    }
}
