//! The per-pixel interpreter this crate shipped before its span and
//! fast-path loops, kept as the oracle of `differential_tests`: every routine
//! below writes one pixel per `RenderTarget::blend` call (flat opaque
//! triangles one pixel per `fill_opaque` call) and evaluates each sample with
//! the arithmetic the goldens were pinned on, the top-left fill rule of
//! `edge_bias` included. The targets are the full-frame ones; their fills
//! write pixel by pixel.
//!
//! Change this file only together with the goldens.
#![allow(dead_code, clippy::all)]

use super::{Clip, RenderTarget};
use pocket_drivers::{RenderResources, TexView};
use pocket_spec::{self as spec, draw_op};

#[inline]
fn xy(word: u32, scale: i32) -> (i32, i32) {
    let (x, y) = pocket_render::xy(word);
    (x * scale, y * scale)
}

#[inline]
fn wh(word: u32, scale: i32) -> (i32, i32) {
    let (width, height) = pocket_render::wh(word);
    (width * scale, height * scale)
}

#[inline]
fn channels(color: u32) -> (u32, u32, u32, u32) {
    (
        color & 0xff,
        (color >> 8) & 0xff,
        (color >> 16) & 0xff,
        color >> 24,
    )
}

#[inline]
fn pixel_bytes<const ARGB: bool>(r: u32, g: u32, b: u32) -> [u8; 4] {
    if ARGB {
        [b as u8, g as u8, r as u8, 255]
    } else {
        [r as u8, g as u8, b as u8, 255]
    }
}

pub(crate) struct RgbaTarget<'a, const ARGB: bool> {
    pub(crate) bytes: &'a mut [u8],
}

impl<const ARGB: bool> RenderTarget for RgbaTarget<'_, ARGB> {
    #[inline]
    fn pixel_len(&self) -> usize {
        assert_eq!(
            self.bytes.len() & 3,
            0,
            "scaled framebuffer byte length must be a multiple of four"
        );
        self.bytes.len() / 4
    }

    #[inline]
    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32) {
        let o = offset * 4;
        let (ri, gi, bi, ai) = if ARGB { (2, 1, 0, 3) } else { (0, 1, 2, 3) };
        if a >= 255 {
            self.bytes[o + ri] = r as u8;
            self.bytes[o + gi] = g as u8;
            self.bytes[o + bi] = b as u8;
            self.bytes[o + ai] = 255;
            return;
        }
        if a == 0 {
            return;
        }
        let ia = 255 - a;
        let mix = |s: u32, d: u8| ((s * a + d as u32 * ia + 127) / 255) as u8;
        self.bytes[o + ri] = mix(r, self.bytes[o + ri]);
        self.bytes[o + gi] = mix(g, self.bytes[o + gi]);
        self.bytes[o + bi] = mix(b, self.bytes[o + bi]);
        self.bytes[o + ai] = 255;
    }

    #[inline]
    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32) {
        let bytes = pixel_bytes::<ARGB>(r, g, b);
        for pixel in start..start + len {
            self.bytes[pixel * 4..pixel * 4 + 4].copy_from_slice(&bytes);
        }
    }
}

pub(crate) struct PremultipliedTarget<'a> {
    pub(crate) bytes: &'a mut [u8],
}

impl RenderTarget for PremultipliedTarget<'_> {
    #[inline]
    fn pixel_len(&self) -> usize {
        assert_eq!(
            self.bytes.len() & 3,
            0,
            "scaled framebuffer byte length must be a multiple of four"
        );
        self.bytes.len() / 4
    }

    #[inline]
    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32) {
        let o = offset * 4;
        if a >= 255 {
            self.bytes[o] = r as u8;
            self.bytes[o + 1] = g as u8;
            self.bytes[o + 2] = b as u8;
            self.bytes[o + 3] = 255;
            return;
        }
        if a == 0 {
            return;
        }
        let ia = 255 - a;
        let mix = |s: u32, d: u8| ((s * a + d as u32 * ia + 127) / 255) as u8;
        self.bytes[o] = mix(r, self.bytes[o]);
        self.bytes[o + 1] = mix(g, self.bytes[o + 1]);
        self.bytes[o + 2] = mix(b, self.bytes[o + 2]);
        self.bytes[o + 3] = mix(255, self.bytes[o + 3]);
    }

    #[inline]
    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32) {
        let bytes = pixel_bytes::<false>(r, g, b);
        for pixel in start..start + len {
            self.bytes[pixel * 4..pixel * 4 + 4].copy_from_slice(&bytes);
        }
    }

    /// The clear of this target is transparent: nothing is covered yet.
    #[inline]
    fn clear_black(&mut self) {
        self.bytes.fill(0);
    }
}

pub(crate) struct Rgb565Target<'a> {
    pub(crate) pixels: &'a mut [u16],
}

#[inline]
pub(crate) const fn pack_rgb565(r: u32, g: u32, b: u32) -> u16 {
    (((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3)) as u16
}

#[inline]
fn unpack_rgb565(pixel: u16) -> (u32, u32, u32) {
    let r5 = (pixel as u32 >> 11) & 0x1f;
    let g6 = (pixel as u32 >> 5) & 0x3f;
    let b5 = pixel as u32 & 0x1f;
    (
        (r5 << 3) | (r5 >> 2),
        (g6 << 2) | (g6 >> 4),
        (b5 << 3) | (b5 >> 2),
    )
}

#[inline]
/// Blend straight-alpha RGB over one RGB565 pixel with the rasterizer's arithmetic.
pub(crate) fn blend_rgb565_pixel(pixel: &mut u16, r: u32, g: u32, b: u32, a: u32) {
    if a >= 255 {
        *pixel = pack_rgb565(r, g, b);
        return;
    }
    if a == 0 {
        return;
    }
    let (dr, dg, db) = unpack_rgb565(*pixel);
    let ia = 255 - a;
    let mix = |s: u32, d: u32| (s * a + d * ia + 127) / 255;
    *pixel = pack_rgb565(mix(r, dr), mix(g, dg), mix(b, db));
}

impl RenderTarget for Rgb565Target<'_> {
    #[inline]
    fn pixel_len(&self) -> usize {
        self.pixels.len()
    }

    #[inline]
    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32) {
        blend_rgb565_pixel(&mut self.pixels[offset], r, g, b, a);
    }

    #[inline]
    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32) {
        self.pixels[start..start + len].fill(pack_rgb565(r, g, b));
    }
}

fn fill_rect<T: RenderTarget>(target: &mut T, stride: i32, c: Clip, color: u32) {
    let (r, g, b, a) = channels(color);
    if a == 0 {
        return;
    }
    if a >= 255 {
        let row_pixels = (c.x1 - c.x0) as usize;
        for y in c.y0..c.y1 {
            let start = (y * stride + c.x0) as usize;
            target.fill_opaque(start, row_pixels, r, g, b);
        }
        return;
    }
    for y in c.y0..c.y1 {
        for x in c.x0..c.x1 {
            target.blend((y * stride + x) as usize, r, g, b, a);
        }
    }
}

#[inline]
pub(crate) fn lerp_color(from: u32, to: u32, f: f32) -> u32 {
    let mix = |a: u32, b: u32| {
        let af = a as f32;
        (af + (b as f32 - af) * f + 0.5) as u32
    };
    let (fr, fg, fb_, fa) = channels(from);
    let (tr, tg, tb, ta) = channels(to);
    mix(fr, tr) | (mix(fg, tg) << 8) | (mix(fb_, tb) << 16) | (mix(fa, ta) << 24)
}

pub(crate) fn render_scaled_clipped<T: RenderTarget>(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    target: &mut T,
    width: i32,
    scale: i32,
    screen: Clip,
) {
    let mut stack: [Clip; 32] = [screen; 32];
    let mut depth: usize = 0;
    let mut clip = screen;

    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            draw_op::RECT => {
                if i + 4 > words.len() {
                    return;
                }
                let (x, y) = xy(words[i + 1], scale);
                let (w, h) = wh(words[i + 2], scale);
                let c = clip.intersect(Clip {
                    x0: x,
                    y0: y,
                    x1: x + w,
                    y1: y + h,
                });
                if c.x0 < c.x1 && c.y0 < c.y1 {
                    fill_rect(target, width, c, words[i + 3]);
                }
                i += 4;
            }
            draw_op::GRAD_RECT => {
                if i + 6 > words.len() {
                    return;
                }
                let (x, y) = xy(words[i + 1], scale);
                let (w, h) = wh(words[i + 2], scale);
                grad_rect(
                    target,
                    width,
                    clip,
                    x,
                    y,
                    w,
                    h,
                    words[i + 3],
                    words[i + 4],
                    words[i + 5],
                );
                i += 6;
            }
            draw_op::GLYPH_RUN => {
                if i + 3 > words.len() {
                    return;
                }
                let slot = (words[i + 1] & 0xff) as u8;
                let n = (words[i + 1] >> 16) as usize;
                let color = words[i + 2];
                if i + 3 + 2 * n > words.len() {
                    return;
                }
                glyph_run(
                    ui,
                    target,
                    width,
                    scale,
                    clip,
                    slot,
                    color,
                    &words[i + 3..i + 3 + 2 * n],
                );
                i += 3 + 2 * n;
            }
            draw_op::TEX_QUAD => {
                if i + 9 > words.len() {
                    return;
                }
                tex_quad(ui, target, width, scale, clip, &words[i + 1..i + 9]);
                i += 9;
            }
            draw_op::SCISSOR => {
                if i + 3 > words.len() || depth >= stack.len() {
                    return;
                }
                stack[depth] = clip;
                depth += 1;
                let (x, y) = xy(words[i + 1], scale);
                let (w, h) = wh(words[i + 2], scale);
                // The core emits scissor rects already intersected with every
                // enclosing scissor — SET (still guard against the screen).
                clip = screen.intersect(Clip {
                    x0: x,
                    y0: y,
                    x1: x + w,
                    y1: y + h,
                });
                i += 3;
            }
            draw_op::SCISSOR_POP => {
                if depth > 0 {
                    depth -= 1;
                    clip = stack[depth];
                } else {
                    clip = screen;
                }
                i += 1;
            }
            draw_op::TRI => {
                if i + 7 > words.len() {
                    return;
                }
                tri(target, width, scale, clip, &words[i + 1..i + 7]);
                i += 7;
            }
            draw_op::TEX_TRI => {
                if i + 12 > words.len() {
                    return;
                }
                tex_tri(ui, target, width, scale, clip, &words[i + 1..i + 12]);
                i += 12;
            }
            draw_op::TEXT_RUN => {
                // Native-text op (host text system shapes the run); the
                // software rasterizer has no shaper, so hosts that raster run
                // with baked measurement and never receive it. Skipped, not a
                // stop: the op is a known member of the closed set. Variable
                // length: 8 header words + the packed UTF-8 payload.
                if i + 8 > words.len() {
                    return;
                }
                let payload = (words[i + 7] as usize).div_ceil(4);
                i += 8 + payload;
            }
            // The op set is closed per DrawList version; anything else means
            // corrupt data — stop instead of misinterpreting the stream.
            _ => return,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn grad_rect<T: RenderTarget>(
    target: &mut T,
    stride: i32,
    clip: Clip,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    from: u32,
    to: u32,
    dir: u32,
) {
    if w <= 0 || h <= 0 {
        return;
    }
    let c = clip.intersect(Clip {
        x0: x,
        y0: y,
        x1: x + w,
        y1: y + h,
    });
    if c.x0 >= c.x1 || c.y0 >= c.y1 {
        return;
    }
    let horizontal = dir == spec::GradDir::ToLeft as u32 || dir == spec::GradDir::ToRight as u32;
    // "from" sits at the axis start for ToBottom/ToRight, at the axis end for
    // ToTop/ToLeft (matches core draw.rs corner_color()).
    let reversed = dir == spec::GradDir::ToTop as u32 || dir == spec::GradDir::ToLeft as u32;
    let (a, b) = if reversed { (to, from) } else { (from, to) };
    if horizontal {
        let inv = 1.0f32 / w as f32;
        for px in c.x0..c.x1 {
            let f = ((px - x) as f32 + 0.5) * inv;
            let col = lerp_color(a, b, f);
            let (r, g, bb, al) = channels(col);
            if al == 0 {
                continue;
            }
            for py in c.y0..c.y1 {
                target.blend((py * stride + px) as usize, r, g, bb, al);
            }
        }
    } else {
        let inv = 1.0f32 / h as f32;
        for py in c.y0..c.y1 {
            let f = ((py - y) as f32 + 0.5) * inv;
            let col = lerp_color(a, b, f);
            let (r, g, bb, al) = channels(col);
            if al == 0 {
                continue;
            }
            if al >= 255 {
                let start = (py * stride + c.x0) as usize;
                target.fill_opaque(start, (c.x1 - c.x0) as usize, r, g, bb);
                continue;
            }
            for px in c.x0..c.x1 {
                target.blend((py * stride + px) as usize, r, g, bb, al);
            }
        }
    }
}

#[inline]
pub(crate) fn orient(ax: i64, ay: i64, bx: i64, by: i64, px: i64, py: i64) -> i64 {
    (bx - ax) * (py - ay) - (by - ay) * (px - ax)
}

/// Smallest edge weight a covered pixel centre may have on edge `u -> v` of a
/// counter-clockwise triangle (top-left rule): 0 on a left edge (the weight
/// grows with x) or a top edge (horizontal, the weight grows with y), 1 on
/// every other edge. A centre exactly on an edge shared by two triangles is
/// covered by one of them, so a fanned quad blends each pixel once.
#[inline]
pub(crate) fn edge_bias(u: (i64, i64), v: (i64, i64)) -> i64 {
    let left = v.1 < u.1;
    let top = v.1 == u.1 && v.0 > u.0;
    if left || top {
        0
    } else {
        1
    }
}

pub(crate) struct TriangleRow {
    x: i32,
    end: i32,
    weights: [i64; 3],
    step: [i64; 3],
}

impl TriangleRow {
    pub(crate) fn new(a: (i64, i64), b: (i64, i64), c: (i64, i64), y: i32, min_x: i32, max_x: i32) -> Self {
        let sx = 2 * min_x as i64 + 1;
        let sy = 2 * y as i64 + 1;
        let mut weights = [
            orient(b.0, b.1, c.0, c.1, sx, sy),
            orient(c.0, c.1, a.0, a.1, sx, sy),
            orient(a.0, a.1, b.0, b.1, sx, sy),
        ];
        let step = [-2 * (c.1 - b.1), -2 * (a.1 - c.1), -2 * (b.1 - a.1)];
        let bias = [edge_bias(b, c), edge_bias(c, a), edge_bias(a, b)];
        let mut first = 0i64;
        let mut end = (max_x as i64 - min_x as i64).max(0);
        for ((&w, &dx), &bias) in weights.iter().zip(&step).zip(&bias) {
            if dx > 0 {
                if w < bias {
                    first = first.max((bias - w + dx - 1) / dx);
                }
            } else if dx < 0 {
                if w < bias {
                    end = 0;
                } else {
                    end = end.min((w - bias) / -dx + 1);
                }
            } else if w < bias {
                end = 0;
            }
        }
        if first >= end {
            return Self {
                x: min_x,
                end: min_x,
                weights,
                step,
            };
        }
        for (w, &dx) in weights.iter_mut().zip(&step) {
            *w += first * dx;
        }
        Self {
            x: min_x + first as i32,
            end: min_x + end as i32,
            weights,
            step,
        }
    }
}

impl Iterator for TriangleRow {
    type Item = (i32, [i64; 3]);
    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        if self.x >= self.end {
            return None;
        }
        let item = (self.x, self.weights);
        self.x += 1;
        for (w, &dx) in self.weights.iter_mut().zip(&self.step) {
            *w += dx;
        }
        Some(item)
    }
}

fn tri<T: RenderTarget>(target: &mut T, stride: i32, scale: i32, clip: Clip, p: &[u32]) {
    let (x0, y0) = xy(p[0], scale);
    let (x1, y1) = xy(p[1], scale);
    let (x2, y2) = xy(p[2], scale);
    let c0 = p[3];
    let (mut c1, mut c2) = (p[4], p[5]);
    // Doubled coords: vertices at 2*v, sample points at 2*px+1 (pixel center).
    let (ax, ay) = (2 * x0 as i64, 2 * y0 as i64);
    let (mut bx, mut by) = (2 * x1 as i64, 2 * y1 as i64);
    let (mut cx, mut cy) = (2 * x2 as i64, 2 * y2 as i64);
    let mut area = orient(ax, ay, bx, by, cx, cy);
    if area == 0 {
        return;
    }
    if area < 0 {
        // Wind CCW-positive so all edge functions share the sign of `area`.
        core::mem::swap(&mut bx, &mut cx);
        core::mem::swap(&mut by, &mut cy);
        core::mem::swap(&mut c1, &mut c2);
        area = -area;
    }
    let min_x = x0.min(x1).min(x2).max(clip.x0);
    let max_x = x0.max(x1).max(x2).min(clip.x1);
    let min_y = y0.min(y1).min(y2).max(clip.y0);
    let max_y = y0.max(y1).max(y2).min(clip.y1);
    let (r0, g0, b0, a0) = channels(c0);
    let (r1, g1, b1, a1) = channels(c1);
    let (r2, g2, b2, a2) = channels(c2);
    let flat = c0 == c1 && c1 == c2;
    let flat_opaque = flat && a0 >= 255;
    let half = area / 2;
    for py in min_y..max_y {
        for (px, [w0, w1, w2]) in TriangleRow::new((ax, ay), (bx, by), (cx, cy), py, min_x, max_x) {
            if flat_opaque {
                target.fill_opaque((py * stride + px) as usize, 1, r0, g0, b0);
            } else if flat {
                target.blend((py * stride + px) as usize, r0, g0, b0, a0);
            } else {
                // Integer barycentric interpolation, round-to-nearest.
                let mix = |v0: u32, v1: u32, v2: u32| {
                    ((v0 as i64 * w0 + v1 as i64 * w1 + v2 as i64 * w2 + half) / area) as u32
                };
                target.blend(
                    (py * stride + px) as usize,
                    mix(r0, r1, r2),
                    mix(g0, g1, g2),
                    mix(b0, b1, b2),
                    mix(a0, a1, a2),
                );
            }
        }
    }
}

#[inline]
pub(crate) fn coverage_index(
    destination_px: i32,
    output_scale: i32,
    atlas_density: i32,
    limit: i32,
) -> usize {
    // Nearest-neighbour at destination pixel centers. This is identical to a
    // 1:1 lookup when output_scale == atlas_density, duplicates coverage when
    // the output is denser, and samples the center of each source interval
    // when a high-density atlas is rendered onto a lower-density surface.
    ((((2 * destination_px + 1) * atlas_density) / (2 * output_scale)).clamp(0, limit - 1)) as usize
}

#[allow(clippy::too_many_arguments)]
fn glyph_run<T: RenderTarget>(
    ui: &(impl RenderResources + ?Sized),
    target: &mut T,
    stride: i32,
    output_scale: i32,
    clip: Clip,
    slot: u8,
    color: u32,
    glyphs: &[u32],
) {
    let Some(atlas) = ui.font_atlas(slot) else {
        return;
    };
    let (r, g, b, a) = channels(color);
    if a == 0 {
        return;
    }
    let cell_w = atlas.cell_w as i32 * output_scale;
    let cell_h = atlas.cell_h as i32 * output_scale;
    let atlas_density = atlas.raster_density as i32;
    let coverage_w = atlas.coverage_width() as i32;
    let coverage_h = atlas.coverage_height() as i32;
    let bpr = atlas.bytes_per_row();
    for pair in glyphs.as_chunks::<2>().0.iter() {
        let (gx, gy) = xy(pair[0], output_scale);
        let gid = (pair[1] & 0xffff) as u16;
        if gid >= atlas.glyph_count {
            continue;
        }
        // Cell-vs-clip pixel window (partial glyphs at scissor edges clip here).
        let x0 = gx.max(clip.x0);
        let x1 = (gx + cell_w).min(clip.x1);
        let y0 = gy.max(clip.y0);
        let y1 = (gy + cell_h).min(clip.y1);
        if x0 >= x1 || y0 >= y1 {
            continue;
        }
        let rows = atlas.glyph_rows(gid);
        for py in y0..y1 {
            let sy = coverage_index(py - gy, output_scale, atlas_density, coverage_h);
            let row = &rows[sy * bpr..];
            for px in x0..x1 {
                let cx = coverage_index(px - gx, output_scale, atlas_density, coverage_w);
                let cov = row[cx] as u32;
                if cov != 0 {
                    target.blend((py * stride + px) as usize, r, g, b, (a * cov + 127) / 255);
                }
            }
        }
    }
}

#[inline]
pub(crate) fn texel(view: &TexView, idx: usize) -> Option<(u32, u32, u32, u32)> {
    match view.psm {
        spec::psm::PSM_5650 => {
            // PSP PSM 5650: u16 LE, B5:G6:R5 (red in the low bits). Always
            // opaque — there is no alpha channel to expand.
            let o = idx * 2;
            let px16 = view.pixels[o] as u32 | ((view.pixels[o + 1] as u32) << 8);
            let r5 = px16 & 0x1f;
            let g6 = (px16 >> 5) & 0x3f;
            let b5 = (px16 >> 11) & 0x1f;
            Some((
                (r5 << 3) | (r5 >> 2),
                (g6 << 2) | (g6 >> 4),
                (b5 << 3) | (b5 >> 2),
                255,
            ))
        }
        spec::psm::PSM_8888 => {
            let o = idx * 4;
            Some((
                view.pixels[o] as u32,
                view.pixels[o + 1] as u32,
                view.pixels[o + 2] as u32,
                view.pixels[o + 3] as u32,
            ))
        }
        spec::psm::PSM_4444 => {
            // u16 LE, nibbles A<<12 | B<<8 | G<<4 | R; expand n -> n*17.
            let o = idx * 2;
            let px16 = view.pixels[o] as u32 | ((view.pixels[o + 1] as u32) << 8);
            Some((
                (px16 & 0xf) * 17,
                ((px16 >> 4) & 0xf) * 17,
                ((px16 >> 8) & 0xf) * 17,
                ((px16 >> 12) & 0xf) * 17,
            ))
        }
        spec::psm::PSM_T8 => {
            // CLUT8: one palette index/px; palette bytes are RGBA in memory
            // (same byte order as 8888 pixels). Index * 4 <= 1020 < 1024, so
            // the lookup can never leave the 1024-byte CLUT.
            let pal = view.palette?;
            let o = view.pixels[idx] as usize * 4;
            Some((
                pal[o] as u32,
                pal[o + 1] as u32,
                pal[o + 2] as u32,
                pal[o + 3] as u32,
            ))
        }
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LinearSample {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
    pub fx: u32,
    pub fy: u32,
}

#[inline]
pub(crate) fn linear_sample_coordinates(width: u32, height: u32, u: f32, v: f32) -> Option<LinearSample> {
    if width == 0 || height == 0 {
        return None;
    }
    let (tw_max, th_max) = (width as i32 - 1, height as i32 - 1);
    let uf = (u * width as f32 * 256.0) as i32 - 128;
    let vf = (v * height as f32 * 256.0) as i32 - 128;
    let x0 = (uf >> 8).clamp(0, tw_max);
    let y0 = (vf >> 8).clamp(0, th_max);
    Some(LinearSample {
        x0: x0 as u32,
        y0: y0 as u32,
        x1: (x0 + 1).min(tw_max) as u32,
        y1: (y0 + 1).min(th_max) as u32,
        fx: (uf & 255) as u32,
        fy: (vf & 255) as u32,
    })
}

#[inline]
fn sample_linear(view: &TexView, u: f32, v: f32) -> Option<(u32, u32, u32, u32)> {
    let sample = linear_sample_coordinates(view.w, view.h, u, v)?;
    let w = view.w as usize;
    let c00 = texel(view, sample.y0 as usize * w + sample.x0 as usize)?;
    let c01 = texel(view, sample.y0 as usize * w + sample.x1 as usize)?;
    let c10 = texel(view, sample.y1 as usize * w + sample.x0 as usize)?;
    let c11 = texel(view, sample.y1 as usize * w + sample.x1 as usize)?;
    let lerp8 = |a: u32, b: u32, f: u32| (a * (256 - f) + b * f) >> 8;
    let mix = |c0: u32, c1: u32, c2: u32, c3: u32| {
        lerp8(
            lerp8(c0, c1, sample.fx),
            lerp8(c2, c3, sample.fx),
            sample.fy,
        )
    };
    Some((
        mix(c00.0, c01.0, c10.0, c11.0),
        mix(c00.1, c01.1, c10.1, c11.1),
        mix(c00.2, c01.2, c10.2, c11.2),
        mix(c00.3, c01.3, c10.3, c11.3),
    ))
}

fn tex_tri<T: RenderTarget>(
    ui: &(impl RenderResources + ?Sized),
    target: &mut T,
    stride: i32,
    scale: i32,
    clip: Clip,
    p: &[u32],
) {
    let handle = p[0] as i32;
    let (x0, y0) = xy(p[1], scale);
    let (u0, v0) = (f32::from_bits(p[2]), f32::from_bits(p[3]));
    let (x1, y1) = xy(p[4], scale);
    let (mut u1, mut v1) = (f32::from_bits(p[5]), f32::from_bits(p[6]));
    let (x2, y2) = xy(p[7], scale);
    let (mut u2, mut v2) = (f32::from_bits(p[8]), f32::from_bits(p[9]));
    let modulate = p[10];
    let Some(view) = ui.texture(handle) else {
        return;
    };
    let (ax, ay) = (2 * x0 as i64, 2 * y0 as i64);
    let (mut bx, mut by) = (2 * x1 as i64, 2 * y1 as i64);
    let (mut cx, mut cy) = (2 * x2 as i64, 2 * y2 as i64);
    let mut area = orient(ax, ay, bx, by, cx, cy);
    if area == 0 {
        return;
    }
    if area < 0 {
        core::mem::swap(&mut bx, &mut cx);
        core::mem::swap(&mut by, &mut cy);
        core::mem::swap(&mut u1, &mut u2);
        core::mem::swap(&mut v1, &mut v2);
        area = -area;
    }
    let min_x = x0.min(x1).min(x2).max(clip.x0);
    let max_x = x0.max(x1).max(x2).min(clip.x1);
    let min_y = y0.min(y1).min(y2).max(clip.y0);
    let max_y = y0.max(y1).max(y2).min(clip.y1);
    let (mr, mg, mb, ma) = channels(modulate);
    let identity = modulate == 0xffff_ffff;
    let (twf, thf) = (view.w as f32, view.h as f32);
    let (tw_max, th_max) = (view.w as i32 - 1, view.h as i32 - 1);
    let inv_area = 1.0f32 / area as f32;
    // Covered weights are in 0..=area. The narrow conversion has the same
    // IEEE-754 result and avoids software i64-to-f32 helpers on Cortex-M.
    let narrow = area <= i32::MAX as i64;
    for py in min_y..max_y {
        for (px, [w0, w1, w2]) in TriangleRow::new((ax, ay), (bx, by), (cx, cy), py, min_x, max_x) {
            let (f0, f1, f2) = if narrow {
                (
                    w0 as i32 as f32 * inv_area,
                    w1 as i32 as f32 * inv_area,
                    w2 as i32 as f32 * inv_area,
                )
            } else {
                (
                    w0 as f32 * inv_area,
                    w1 as f32 * inv_area,
                    w2 as f32 * inv_area,
                )
            };
            let u = u0 * f0 + u1 * f1 + u2 * f2;
            let v = v0 * f0 + v1 * f1 + v2 * f2;
            // Nearest is the golden-pinned default path; linear is opt-in
            // per texture (spec::img::FLAG_LINEAR).
            let sample = if view.linear {
                sample_linear(&view, u, v)
            } else {
                let tx = ((u * twf) as i32).clamp(0, tw_max);
                let ty = ((v * thf) as i32).clamp(0, th_max);
                texel(&view, (ty * view.w as i32 + tx) as usize)
            };
            let Some((mut r, mut g, mut b, mut a)) = sample else {
                return;
            };
            if !identity {
                r = (r * mr + 127) / 255;
                g = (g * mg + 127) / 255;
                b = (b * mb + 127) / 255;
                a = (a * ma + 127) / 255;
            }
            target.blend((py * stride + px) as usize, r, g, b, a);
        }
    }
}

fn tex_quad<T: RenderTarget>(
    ui: &(impl RenderResources + ?Sized),
    target: &mut T,
    stride: i32,
    scale: i32,
    clip: Clip,
    p: &[u32],
) {
    let handle = p[0] as i32;
    let (x, y) = xy(p[1], scale);
    let (w, h) = wh(p[2], scale);
    let u0 = f32::from_bits(p[3]);
    let v0 = f32::from_bits(p[4]);
    let u1 = f32::from_bits(p[5]);
    let v1 = f32::from_bits(p[6]);
    let modulate = p[7];
    if w <= 0 || h <= 0 {
        return;
    }
    let Some(view) = ui.texture(handle) else {
        return;
    };
    let c = clip.intersect(Clip {
        x0: x,
        y0: y,
        x1: x + w,
        y1: y + h,
    });
    if c.x0 >= c.x1 || c.y0 >= c.y1 {
        return;
    }
    let (mr, mg, mb, ma) = channels(modulate);
    let identity = modulate == 0xffff_ffff;
    let (twf, thf) = (view.w as f32, view.h as f32);
    let (tw_max, th_max) = (view.w as i32 - 1, view.h as i32 - 1);
    let inv_w = 1.0f32 / w as f32;
    let inv_h = 1.0f32 / h as f32;
    for py in c.y0..c.y1 {
        let v = v0 + (v1 - v0) * ((py - y) as f32 + 0.5) * inv_h;
        let ty = ((v * thf) as i32).clamp(0, th_max);
        for px in c.x0..c.x1 {
            let u = u0 + (u1 - u0) * ((px - x) as f32 + 0.5) * inv_w;
            // Nearest is the golden-pinned default path; linear is opt-in
            // per texture (spec::img::FLAG_LINEAR).
            let sample = if view.linear {
                sample_linear(&view, u, v)
            } else {
                let tx = ((u * twf) as i32).clamp(0, tw_max);
                texel(&view, (ty * view.w as i32 + tx) as usize)
            };
            let Some((mut r, mut g, mut b, mut a)) = sample else {
                return;
            };
            if !identity {
                // Integer modulate, round-to-nearest (includes alpha).
                r = (r * mr + 127) / 255;
                g = (g * mg + 127) / 255;
                b = (b * mb + 127) / 255;
                a = (a * ma + 127) / 255;
            }
            target.blend((py * stride + px) as usize, r, g, b, a);
        }
    }
}
