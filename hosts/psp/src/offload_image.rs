//! Native decode of the two bounded image replies the offload capability
//! carries — `uploadCoverage` (2-bit text coverage) and `uploadIndexedImage`
//! (16-colour 4 bpp) — into PSM_T8 textures the core uploads as-is.
//!
//! Both arrive as base64 inside a 4 KiB record. Expanding them in QuickJS
//! costs tens of milliseconds per row on the PSP; here each is one pass over
//! at most 8192 pixels into a CLUT texture: a palette of 256 x u32 ABGR
//! (`TEX_PALETTE_BYTES`) followed by one index byte per envelope pixel. The
//! limits mirror hosts/3ds/src/offload_coverage.h so a companion reply that
//! renders on one device renders on the other.

use alloc::vec::Vec;

/// Palette prefix of a PSM_T8 upload (engine/core spec: 256 x u32 ABGR).
const PALETTE_BYTES: usize = 1024;
const MAX_PIXELS: u32 = 8192;
const MAX_ENVELOPE: u32 = 16384;

fn digit(c: u8) -> Option<u32> {
    Some(match c {
        b'A'..=b'Z' => (c - b'A') as u32,
        b'a'..=b'z' => (c - b'a') as u32 + 26,
        b'0'..=b'9' => (c - b'0') as u32 + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    })
}

fn hex(c: u8) -> Option<u32> {
    Some(match c {
        b'0'..=b'9' => (c - b'0') as u32,
        b'a'..=b'f' => (c - b'a') as u32 + 10,
        b'A'..=b'F' => (c - b'A') as u32 + 10,
        _ => return None,
    })
}

/// Decode standard base64 into `out`; the encoded length must match the
/// byte count exactly (padding included).
fn base64(input: &[u8], bytes: usize, out: &mut Vec<u8>) -> bool {
    if input.len() != ((bytes + 2) / 3) * 4 {
        return false;
    }
    let mut i = 0;
    while i < input.len() {
        let mut value = 0u32;
        for j in 0..4 {
            let c = input[i + j];
            let d = match digit(c) {
                Some(d) => d,
                None => {
                    if c != b'=' || i + 4 != input.len() || j < 2 {
                        return false;
                    }
                    0
                }
            };
            value = (value << 6) | d;
        }
        for byte in (0..3).rev() {
            if out.len() < bytes {
                out.push(((value >> (byte * 8)) & 255) as u8);
            }
        }
        i += 4;
    }
    out.len() == bytes
}

fn envelope(size: u32) -> u32 {
    let mut e = 8;
    while e < size {
        e *= 2;
    }
    e
}

fn put_abgr(palette: &mut [u8], index: usize, abgr: u32) {
    palette[index * 4..index * 4 + 4].copy_from_slice(&abgr.to_le_bytes());
}

/// A decoded upload: the PSM_T8 buffer and its power-of-two envelope.
pub struct Decoded {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Two-bit coverage, four pixels per byte, low bits first, over one
/// foreground colour (ABGR). With `columns`/`palette` each column takes
/// one of up to sixteen RGB colours instead; the four alpha levels stay.
pub fn coverage(
    base64_text: &[u8],
    width: u32,
    height: u32,
    color: u32,
    columns: Option<&[u8]>,
    palette_hex: Option<&[u8]>,
) -> Option<Decoded> {
    if width == 0 || width > 512 || width % 4 != 0 || height == 0 || height > 64 || width * height > MAX_PIXELS {
        return None;
    }
    let (ew, eh) = (envelope(width), envelope(height));
    if ew * eh > MAX_ENVELOPE {
        return None;
    }
    let count = (width * height) as usize;
    let mut packed = Vec::with_capacity(count / 4);
    if !base64(base64_text, count / 4, &mut packed) {
        return None;
    }
    // Column colours: index = colour * 4 + alpha level.
    let mut colors: Vec<u32> = Vec::new();
    let mut column_of: Vec<u8> = Vec::new();
    if let (Some(columns), Some(palette_hex)) = (columns, palette_hex) {
        if columns.len() != width as usize || palette_hex.is_empty() || palette_hex.len() > 96 || palette_hex.len() % 6 != 0 {
            return None;
        }
        for entry in palette_hex.chunks(6) {
            let mut rgb = [0u8; 3];
            for (k, pair) in entry.chunks(2).enumerate() {
                rgb[k] = ((hex(pair[0])? << 4) | hex(pair[1])?) as u8;
            }
            colors.push((rgb[2] as u32) << 16 | (rgb[1] as u32) << 8 | rgb[0] as u32);
        }
        for &c in columns {
            let ink = hex(c)?;
            if ink as usize >= colors.len() {
                return None;
            }
            column_of.push(ink as u8);
        }
    }
    let mut bytes = alloc::vec![0u8; PALETTE_BYTES + (ew * eh) as usize];
    {
        let palette = &mut bytes[..PALETTE_BYTES];
        if colors.is_empty() {
            for level in 0..4u32 {
                put_abgr(palette, level as usize, (color & 0x00ff_ffff) | ((level * 85) << 24));
            }
        } else {
            for (ci, rgb) in colors.iter().enumerate() {
                for level in 0..4u32 {
                    put_abgr(palette, ci * 4 + level as usize, rgb | ((level * 85) << 24));
                }
            }
        }
    }
    let indices = &mut bytes[PALETTE_BYTES..];
    for pixel in 0..count {
        let level = (packed[pixel / 4] >> ((pixel % 4) * 2)) & 3;
        let x = pixel % width as usize;
        let y = pixel / width as usize;
        let base = if column_of.is_empty() { 0 } else { column_of[x] * 4 };
        indices[y * ew as usize + x] = base + level;
    }
    Some(Decoded { bytes, width: ew, height: eh })
}

/// Sixteen-colour 4 bpp image, low nibble first; `palette_hex` holds one to
/// sixteen RRGGBB entries. Opaque.
pub fn indexed(base64_pixels: &[u8], width: u32, height: u32, palette_hex: &[u8]) -> Option<Decoded> {
    if width == 0 || width > 128 || height == 0 || height > 64 || width * height > 4096 {
        return None;
    }
    if palette_hex.is_empty() || palette_hex.len() > 96 || palette_hex.len() % 6 != 0 {
        return None;
    }
    let (ew, eh) = (envelope(width), envelope(height));
    let count = (width * height) as usize;
    let packed_len = (count + 1) / 2;
    let mut packed = Vec::with_capacity(packed_len);
    if !base64(base64_pixels, packed_len, &mut packed) {
        return None;
    }
    let colors = palette_hex.len() / 6;
    let mut bytes = alloc::vec![0u8; PALETTE_BYTES + (ew * eh) as usize];
    {
        let palette = &mut bytes[..PALETTE_BYTES];
        for (ci, entry) in palette_hex.chunks(6).enumerate() {
            let mut rgb = [0u8; 3];
            for (k, pair) in entry.chunks(2).enumerate() {
                rgb[k] = ((hex(pair[0])? << 4) | hex(pair[1])?) as u8;
            }
            put_abgr(palette, ci, 0xff00_0000 | (rgb[2] as u32) << 16 | (rgb[1] as u32) << 8 | rgb[0] as u32);
        }
    }
    let indices = &mut bytes[PALETTE_BYTES..];
    for pixel in 0..count {
        let index = (packed[pixel / 2] >> ((pixel % 2) * 4)) & 15;
        if index as usize >= colors {
            return None;
        }
        let x = pixel % width as usize;
        let y = pixel / width as usize;
        indices[y * ew as usize + x] = index;
    }
    Some(Decoded { bytes, width: ew, height: eh })
}
