use alloc::{vec, vec::Vec};
use pocket_drivers::TexView;
use pocket_spec as spec;
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
