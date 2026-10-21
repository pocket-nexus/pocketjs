use crate::raw::*;
use alloc::{vec, vec::Vec};
use core::ffi::c_void;
use pocket_drivers::TexView;
use pocket_spec as spec;
#[inline]
pub(crate) fn xy(word: u32) -> (f32, f32) {
    (
        (word as u16 as i16) as f32,
        ((word >> 16) as u16 as i16) as f32,
    )
}

#[inline]
pub(crate) fn wh(word: u32) -> (f32, f32) {
    ((word & 0xffff) as f32, ((word >> 16) & 0xffff) as f32)
}

/// Drain stale context errors before an operation whose result we inspect.
///
/// A finite bound avoids hanging forever on a broken/lost context whose
/// implementation keeps reporting an error without clearing it.
pub(crate) unsafe fn clear_errors() {
    for _ in 0..32 {
        if glGetError() == GL_NO_ERROR {
            break;
        }
    }
}

pub(crate) unsafe fn upload_texture(
    pixels: &[u8],
    width: u32,
    height: u32,
    format: GLenum,
    linear: bool,
) -> Option<GLuint> {
    if width == 0 || height == 0 || pixels.is_empty() {
        return None;
    }
    clear_errors();
    let mut name = 0;
    glGenTextures(1, &mut name);
    if name == 0 {
        return None;
    }
    glBindTexture(GL_TEXTURE_2D, name);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    let filter = if linear { GL_LINEAR } else { GL_NEAREST };
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, filter);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, filter);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glTexImage2D(
        GL_TEXTURE_2D,
        0,
        format as GLint,
        width as GLsizei,
        height as GLsizei,
        0,
        format,
        GL_UNSIGNED_BYTE,
        pixels.as_ptr() as *const c_void,
    );
    if glGetError() == GL_NO_ERROR {
        Some(name)
    } else {
        glDeleteTextures(1, &name);
        clear_errors();
        None
    }
}

pub(crate) fn texture_rgba(view: TexView<'_>) -> Option<Vec<u8>> {
    let count = (view.w as usize).checked_mul(view.h as usize)?;
    let channels = match view.psm {
        spec::psm::PSM_5650 | spec::psm::PSM_4444 => 2,
        spec::psm::PSM_8888 => 4,
        spec::psm::PSM_T8 if view.palette.is_some_and(|palette| palette.len() >= 1024) => 1,
        _ => return None,
    };
    if view.pixels.len() < count.checked_mul(channels)? {
        return None;
    }
    let mut rgba = vec![0u8; count.checked_mul(4)?];
    match view.psm {
        spec::psm::PSM_5650 => {
            if view.pixels.len() < count * 2 {
                return None;
            }
            for (index, bytes) in view.pixels[..count * 2]
                .as_chunks::<2>()
                .0
                .iter()
                .enumerate()
            {
                let pixel = u16::from_le_bytes([bytes[0], bytes[1]]) as u32;
                let red = pixel & 0x1f;
                let green = (pixel >> 5) & 0x3f;
                let blue = (pixel >> 11) & 0x1f;
                rgba[index * 4] = ((red << 3) | (red >> 2)) as u8;
                rgba[index * 4 + 1] = ((green << 2) | (green >> 4)) as u8;
                rgba[index * 4 + 2] = ((blue << 3) | (blue >> 2)) as u8;
                rgba[index * 4 + 3] = 255;
            }
        }
        spec::psm::PSM_8888 => {
            if view.pixels.len() < rgba.len() {
                return None;
            }
            rgba.copy_from_slice(&view.pixels[..count * 4]);
        }
        spec::psm::PSM_4444 => {
            if view.pixels.len() < count * 2 {
                return None;
            }
            for (index, bytes) in view.pixels[..count * 2]
                .as_chunks::<2>()
                .0
                .iter()
                .enumerate()
            {
                let pixel = u16::from_le_bytes([bytes[0], bytes[1]]) as u32;
                rgba[index * 4] = ((pixel & 0x0f) * 17) as u8;
                rgba[index * 4 + 1] = (((pixel >> 4) & 0x0f) * 17) as u8;
                rgba[index * 4 + 2] = (((pixel >> 8) & 0x0f) * 17) as u8;
                rgba[index * 4 + 3] = (((pixel >> 12) & 0x0f) * 17) as u8;
            }
        }
        spec::psm::PSM_T8 => {
            let palette = view.palette?;
            if palette.len() < 1024 || view.pixels.len() < count {
                return None;
            }
            for (index, &palette_index) in view.pixels[..count].iter().enumerate() {
                let source = palette_index as usize * 4;
                rgba[index * 4..index * 4 + 4].copy_from_slice(&palette[source..source + 4]);
            }
        }
        _ => return None,
    }
    Some(rgba)
}

// Coverage-only indexed images (including shared glyph pages) need two
// GPU bytes per pixel, not four. Preserve arbitrary palette alpha values;
// colored palettes retain the RGBA upload path.
pub(crate) fn coverage_luminance_alpha(view: TexView<'_>) -> Option<Vec<u8>> {
    if view.psm != spec::psm::PSM_T8 {
        return None;
    }
    let palette = view.palette?;
    let count = (view.w as usize).checked_mul(view.h as usize)?;
    if palette.len() < 1024
        || view.pixels.len() < count
        || !palette[..1024]
            .as_chunks::<4>()
            .0
            .iter()
            .all(|color| color[..3] == [255, 255, 255])
    {
        return None;
    }
    let mut pixels = Vec::with_capacity(count.checked_mul(2)?);
    for &index in &view.pixels[..count] {
        pixels.extend_from_slice(&[255, palette[index as usize * 4 + 3]]);
    }
    Some(pixels)
}

// A constant UV in an existing opaque white block can draw solid fills
// without switching away from an image or rounded-corner mask. Four texels
// provide a guard for bilinear filtering and mediump UV interpolation.
// Inspect once when uploading; never alter the source pixels.
#[cfg(test)]
pub(crate) fn image_white_patch(rgba: &[u8], width: u32, height: u32) -> Option<[f32; 2]> {
    white_patch(rgba, width, height, 4)
}

pub(crate) fn white_patch(
    pixels: &[u8],
    width: u32,
    height: u32,
    channels: usize,
) -> Option<[f32; 2]> {
    let required = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(channels)?;
    if width < 4 || height < 4 || channels == 0 || pixels.len() < required {
        return None;
    }
    let stride = width as usize * channels;
    for y in 0..height - 3 {
        for x in 0..width - 3 {
            let offset = y as usize * stride + x as usize * channels;
            if (0..4).all(|row| {
                pixels[offset + row * stride..offset + row * stride + 4 * channels]
                    .iter()
                    .all(|&channel| channel == 255)
            }) {
                return Some([
                    (x as f32 + 2.0) / width as f32,
                    (y as f32 + 2.0) / height as f32,
                ]);
            }
        }
    }
    None
}
