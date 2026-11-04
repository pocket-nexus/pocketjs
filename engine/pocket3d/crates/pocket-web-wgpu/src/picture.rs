//! Pictures of 16 bits a texel as textures.
//!
//! A handheld pack stores a picture as `r5 g6 b5` texels in row order, the
//! largest level first and only the first few levels. WebGPU has no texture
//! format of 16 bits with three colours, so a picture goes to the GPU as
//! `rgba8unorm`. The levels the pack leaves out are made here, each texel the
//! mean of the four it covers, in the 16-bit colours: the texels are the ones
//! a handheld's own driver is handed.

use crate::gpu::Gpu;
use wgpu::{Texture, TextureFormat};

/// `r5 g6 b5` as bytes of red, green, blue and a full alpha: each channel in 255ths, rounded.
#[inline]
pub fn rgba_of(texel: u16) -> [u8; 4] {
    let (r, g, b) = ((texel >> 11) as u32, ((texel >> 5) & 63) as u32, (texel & 31) as u32);
    [((r * 255 + 15) / 31) as u8, ((g * 255 + 31) / 63) as u8, ((b * 255 + 15) / 31) as u8, 255]
}

/// A level of 16-bit texels (little-endian bytes) as `rgba8`.
pub fn expand(texels: &[u8], out: &mut Vec<u8>) {
    out.clear();
    out.reserve(texels.len() * 2);
    for pair in texels.as_chunks::<2>().0 {
        out.extend_from_slice(&rgba_of(u16::from_le_bytes(*pair)));
    }
}

/// The level below one of `w` by `h` texels: each texel the mean of the four it covers.
pub fn halve(from: &[u16], w: usize, h: usize) -> (Vec<u16>, usize, usize) {
    let (nw, nh) = (if w > 1 { w / 2 } else { 1 }, if h > 1 { h / 2 } else { 1 });
    let (sx, sy) = ((w > 1) as usize, (h > 1) as usize);
    let mut to = Vec::with_capacity(nw * nh);
    for y in 0..nh {
        for x in 0..nw {
            let p = [from[y * 2 * w + x * 2], from[y * 2 * w + x * 2 + sx], from[(y * 2 + sy) * w + x * 2], from[(y * 2 + sy) * w + x * 2 + sx]];
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            for t in p {
                r += (t >> 11) as u32;
                g += ((t >> 5) & 63) as u32;
                b += (t & 31) as u32;
            }
            to.push((((r + 2) >> 2) << 11 | ((g + 2) >> 2) << 5 | ((b + 2) >> 2)) as u16);
        }
    }
    (to, nw, nh)
}

/// How many levels a picture has down to one texel.
pub fn levels_of(w: u32, h: u32) -> u32 {
    32 - w.max(h).leading_zeros()
}

/// An empty texture for a picture of `w` by `h` texels with every level.
pub fn create(gpu: &Gpu, label: &str, w: u32, h: u32) -> Texture {
    gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: levels_of(w, h),
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    })
}

fn write_level(gpu: &Gpu, texture: &Texture, level: u32, w: u32, h: u32, bytes_per_texel: u32, bytes: &[u8]) {
    gpu.queue.write_texture(
        wgpu::TexelCopyTextureInfo { texture, mip_level: level, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        bytes,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * bytes_per_texel), rows_per_image: Some(h) },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
}

/// Bytes of the first `levels` levels of a picture of 16-bit texels.
pub fn stored_bytes(w: u32, h: u32, levels: u32) -> usize {
    (0..levels).map(|l| ((w >> l).max(1) * (h >> l).max(1) * 2) as usize).sum()
}

/// Writes a picture into a texture made by [`create`] for its size: `levels` levels of 16-bit texels stored
/// largest first, then the levels below them, down to one texel.
pub fn write(gpu: &Gpu, texture: &Texture, texels: &[u8], w: u32, h: u32, levels: u32) {
    let mut rgba = Vec::new();
    let mut at = 0;
    let mut last = (0, 0, 0);
    for l in 0..levels {
        let (lw, lh) = ((w >> l).max(1), (h >> l).max(1));
        let size = (lw * lh * 2) as usize;
        expand(&texels[at..at + size], &mut rgba);
        write_level(gpu, texture, l, lw, lh, 4, &rgba);
        last = (at, lw as usize, lh as usize);
        at += size;
    }
    let (from, mut lw, mut lh) = last;
    let mut level: Vec<u16> = texels[from..from + lw * lh * 2].as_chunks::<2>().0.iter().map(|p| u16::from_le_bytes(*p)).collect();
    for l in levels..levels_of(w, h) {
        (level, lw, lh) = halve(&level, lw, lh);
        rgba.clear();
        for &t in &level {
            rgba.extend_from_slice(&rgba_of(t));
        }
        write_level(gpu, texture, l, lw as u32, lh as u32, 4, &rgba);
    }
}

/// A texture of one byte a texel (`.r` when read), `side` texels square, with one level.
pub fn create_bytes(gpu: &Gpu, label: &str, side: u32) -> Texture {
    gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: TextureFormat::R8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    })
}

/// Rows of such a texture from row `first`.
pub fn write_bytes(gpu: &Gpu, texture: &Texture, side: u32, first: u32, rows: u32, bytes: &[u8]) {
    gpu.queue.write_texture(
        wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d { x: 0, y: first, z: 0 }, aspect: wgpu::TextureAspect::All },
        bytes,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(side), rows_per_image: Some(rows) },
        wgpu::Extent3d { width: side, height: rows, depth_or_array_layers: 1 },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sixteen_bits_to_eight() {
        assert_eq!(rgba_of(0), [0, 0, 0, 255]);
        assert_eq!(rgba_of(0xffff), [255, 255, 255, 255]);
        // Half of each channel's range, rounded as a GPU normalizes it.
        assert_eq!(rgba_of(16 << 11 | 32 << 5 | 16), [132, 130, 132, 255]);
        let mut out = Vec::new();
        expand(&[0x00, 0xf8, 0xe0, 0x07], &mut out);
        assert_eq!(out, [255, 0, 0, 255, 0, 255, 0, 255]);
    }

    #[test]
    fn a_level_is_the_mean_of_four() {
        let red = 31 << 11;
        let (to, w, h) = halve(&[red, red, 0, 0, red, 0, red, 0], 4, 2);
        assert_eq!((w, h), (2, 1));
        // Three reds of four round to 23 of 31; one of four to 8.
        assert_eq!(to, [((31 * 3 + 2) >> 2) << 11, ((31 + 2) >> 2) << 11]);
        // A picture one texel high keeps its height: the mean of the two texels side by side.
        let (to, w, h) = halve(&[red, 0], 2, 1);
        assert_eq!((to, w, h), (vec![16 << 11], 1, 1));
        assert_eq!(levels_of(1024, 128), 11);
        assert_eq!(stored_bytes(256, 256, 3), (256 * 256 + 128 * 128 + 64 * 64) * 2);
    }
}
