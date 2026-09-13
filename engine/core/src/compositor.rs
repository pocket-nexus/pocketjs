//! Portable Pocket System composition. The same Rust painter runs on native
//! workers and WASM, preserving scissor and surface painter order.

use crate::{raster, Ui};
use alloc::vec::Vec;

/// A host-owned raster, outside the guest texture namespace.
#[derive(Clone)]
pub struct CompositorRaster {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Pixels per logical unit. Width and height remain logical dimensions.
    pub density: u32,
}

pub fn draw_op_len(words: &[u32], at: usize) -> Option<usize> {
    let op = *words.get(at)?;
    Some(match op {
        crate::spec::draw_op::RECT => 4,
        crate::spec::draw_op::GRAD_RECT => 6,
        crate::spec::draw_op::GLYPH_RUN => 3 + 2 * ((*words.get(at + 1)? >> 16) as usize),
        crate::spec::draw_op::TEX_QUAD => 9,
        crate::spec::draw_op::SCISSOR => 3,
        crate::spec::draw_op::SCISSOR_POP => 1,
        crate::spec::draw_op::TRI => 7,
        crate::spec::draw_op::TEX_TRI => 12,
        crate::spec::draw_op::TEXT_RUN => 8 + (*words.get(at + 7)? as usize).div_ceil(4),
        crate::spec::draw_op::SURFACE_QUAD => 9,
        _ => return None,
    })
}

fn render_segment(
    ui: &Ui,
    inherited_scissors: &[[u32; 3]],
    words: &[u32],
    framebuffer: &mut [u8],
    scale: u32,
) {
    if words.is_empty() {
        return;
    }
    let mut staged = Vec::with_capacity(inherited_scissors.len() * 3 + words.len());
    for scissor in inherited_scissors {
        staged.extend_from_slice(scissor);
    }
    staged.extend_from_slice(words);
    raster::render_scaled_over(ui, &staged, framebuffer, scale);
}

fn blend_surface(
    entry: &CompositorRaster,
    op: &[u32],
    framebuffer: &mut [u8],
    viewport_width: u32,
    viewport_height: u32,
    scale: u32,
) {
    let full_x = f32::from_bits(op[2]);
    let full_y = f32::from_bits(op[3]);
    let full_w = f32::from_bits(op[4]).min(entry.width as f32).max(0.0);
    let full_h = f32::from_bits(op[5]).min(entry.height as f32).max(0.0);
    let clip_xy = op[6];
    let clip_wh = op[7];
    let clip_x = clip_xy as u16 as i16 as i32;
    let clip_y = (clip_xy >> 16) as u16 as i16 as i32;
    let clip_w = (clip_wh & 0xffff) as i32;
    let clip_h = (clip_wh >> 16) as i32;
    let scale_i = scale as i32;
    let density = entry.density.max(1);
    let source_width = entry.width.saturating_mul(density);
    let source_height = entry.height.saturating_mul(density);
    let Some(expected) = (source_width as usize)
        .checked_mul(source_height as usize)
        .and_then(|n| n.checked_mul(4))
    else {
        return;
    };
    if entry.pixels.len() != expected {
        return;
    }
    let width = viewport_width as i32 * scale_i;
    let height = viewport_height as i32 * scale_i;
    let x0 = (clip_x * scale_i).max(ceil(full_x * scale as f32)).max(0);
    let y0 = (clip_y * scale_i).max(ceil(full_y * scale as f32)).max(0);
    let x1 = ((clip_x + clip_w) * scale_i)
        .min(ceil((full_x + full_w) * scale as f32))
        .min(width);
    let y1 = ((clip_y + clip_h) * scale_i)
        .min(ceil((full_y + full_h) * scale as f32))
        .min(height);
    if x0 >= x1 || y0 >= y1 {
        return;
    }

    for y in y0..y1 {
        let source_y = floor((((y as f32 + 0.5) / scale as f32) - full_y) * density as f32);
        if !(0..source_height as i32).contains(&source_y) {
            continue;
        }
        for x in x0..x1 {
            let source_x = floor((((x as f32 + 0.5) / scale as f32) - full_x) * density as f32);
            if !(0..source_width as i32).contains(&source_x) {
                continue;
            }
            let source = (source_y as usize * source_width as usize + source_x as usize) * 4;
            let destination = (y as usize * width as usize + x as usize) * 4;
            let alpha = entry.pixels[source + 3] as u32;
            if alpha == 0 {
                continue;
            }
            if alpha == 255 {
                framebuffer[destination..destination + 4]
                    .copy_from_slice(&entry.pixels[source..source + 4]);
                continue;
            }
            let inverse = 255 - alpha;
            for channel in 0..3 {
                framebuffer[destination + channel] = ((entry.pixels[source + channel] as u32
                    * alpha
                    + framebuffer[destination + channel] as u32 * inverse
                    + 127)
                    / 255) as u8;
            }
            framebuffer[destination + 3] =
                (alpha + (framebuffer[destination + 3] as u32 * inverse + 127) / 255) as u8;
        }
    }
}

/// Composite arbitrary-size child rasters at their SURFACE_QUAD painter
/// positions without entering the guest image texture namespace.
pub fn render(
    ui: &Ui,
    words: &[u32],
    framebuffer: &mut [u8],
    scale: u32,
    surfaces: &[Option<CompositorRaster>],
) {
    let (viewport_width, viewport_height) = ui.viewport();
    raster::render_scaled(ui, &[], framebuffer, scale);
    let mut inherited_scissors: Vec<[u32; 3]> = Vec::new();
    let mut segment_scissors: Vec<[u32; 3]> = Vec::new();
    let mut segment_start = 0usize;
    let mut at = 0usize;
    while at < words.len() {
        let Some(len) = draw_op_len(words, at) else {
            break;
        };
        let Some(end) = at.checked_add(len) else {
            break;
        };
        if end > words.len() {
            break;
        }
        match words[at] {
            crate::spec::draw_op::SURFACE_QUAD => {
                render_segment(
                    ui,
                    &segment_scissors,
                    &words[segment_start..at],
                    framebuffer,
                    scale,
                );
                let surface = words[at + 1] as usize;
                if let Some(entry) = surfaces.get(surface).and_then(Option::as_ref) {
                    blend_surface(
                        entry,
                        &words[at..end],
                        framebuffer,
                        viewport_width as u32,
                        viewport_height as u32,
                        scale,
                    );
                }
                segment_start = end;
                segment_scissors = inherited_scissors.clone();
            }
            crate::spec::draw_op::SCISSOR => {
                inherited_scissors.push([words[at], words[at + 1], words[at + 2]]);
            }
            crate::spec::draw_op::SCISSOR_POP => {
                inherited_scissors.pop();
            }
            _ => {}
        }
        at = end;
    }
    render_segment(
        ui,
        &segment_scissors,
        &words[segment_start..],
        framebuffer,
        scale,
    );
}

fn floor(v: f32) -> i32 {
    let n = v as i32;
    if v < n as f32 {
        n.saturating_sub(1)
    } else {
        n
    }
}
fn ceil(v: f32) -> i32 {
    let n = v as i32;
    if v > n as f32 {
        n.saturating_add(1)
    } else {
        n
    }
}
