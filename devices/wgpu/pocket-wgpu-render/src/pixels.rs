use pocket_drivers::TexView;
use pocket_spec as spec;

/// Expand a resource texture (PSM 5650/8888/4444/T8) to tightly-packed RGBA8.
pub(crate) fn to_rgba8(view: &TexView) -> Option<Vec<u8>> {
    let count = (view.w as usize).checked_mul(view.h as usize)?;
    count.checked_mul(4)?;
    let pixels = view.pixels;
    match view.psm {
        spec::psm::PSM_5650 => {
            if pixels.len() < count * 2 {
                return None;
            }
            let mut out = Vec::with_capacity(count * 4);
            for px in pixels[..count * 2].as_chunks::<2>().0 {
                let v = u16::from_le_bytes([px[0], px[1]]) as u32;
                let r = v & 0x1f;
                let g = (v >> 5) & 0x3f;
                let b = (v >> 11) & 0x1f;
                out.push(((r << 3) | (r >> 2)) as u8);
                out.push(((g << 2) | (g >> 4)) as u8);
                out.push(((b << 3) | (b >> 2)) as u8);
                out.push(255);
            }
            Some(out)
        }
        spec::psm::PSM_8888 => {
            let bytes = count * 4;
            (pixels.len() >= bytes).then(|| pixels[..bytes].to_vec())
        }
        spec::psm::PSM_4444 => {
            // u16 LE, nibbles A<<12 | B<<8 | G<<4 | R; expand n -> n*17.
            if pixels.len() < count * 2 {
                return None;
            }
            let mut out = Vec::with_capacity(count * 4);
            for px in pixels[..count * 2].as_chunks::<2>().0 {
                let v = u16::from_le_bytes([px[0], px[1]]) as u32;
                out.push(((v & 0xf) * 17) as u8);
                out.push((((v >> 4) & 0xf) * 17) as u8);
                out.push((((v >> 8) & 0xf) * 17) as u8);
                out.push((((v >> 12) & 0xf) * 17) as u8);
            }
            Some(out)
        }
        spec::psm::PSM_T8 => {
            // Indices through the 1024-byte CLUT (256 x u32 ABGR — LE byte
            // order is r,g,b,a in memory, i.e. exactly the 8888 layout).
            let palette = view.palette?;
            if palette.len() < 1024 || pixels.len() < count {
                return None;
            }
            let mut out = Vec::with_capacity(count * 4);
            for &idx in &pixels[..count] {
                let p = idx as usize * 4;
                out.extend_from_slice(&palette[p..p + 4]);
            }
            Some(out)
        }
        _ => None,
    }
}
