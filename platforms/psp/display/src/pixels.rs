//! PSP packed display pixels to the RGBA8 screenshot wire format.
/// Formats 0/1/2 are RGB565, RGBA5551 and RGBA4444.
pub fn rgba16(pixel: u16, format: u32) -> [u8; 4] {
    let five = |v: u16| ((v << 3) | (v >> 2)) as u8;
    match format {
        0 => {
            let g = (pixel >> 5) & 63;
            [
                five(pixel & 31),
                ((g << 2) | (g >> 4)) as u8,
                five(pixel >> 11),
                255,
            ]
        }
        1 => [
            five(pixel & 31),
            five((pixel >> 5) & 31),
            five((pixel >> 10) & 31),
            if pixel & 0x8000 != 0 { 255 } else { 0 },
        ],
        2 => [
            (pixel as u8 & 15) * 17,
            ((pixel >> 4) as u8 & 15) * 17,
            ((pixel >> 8) as u8 & 15) * 17,
            (pixel >> 12) as u8 * 17,
        ],
        _ => unreachable!(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn display_channels_and_alpha() {
        assert_eq!(rgba16(0x001f, 0), [255, 0, 0, 255]);
        assert_eq!(rgba16(0x07e0, 0), [0, 255, 0, 255]);
        assert_eq!(rgba16(0xf800, 0), [0, 0, 255, 255]);
        assert_eq!(rgba16(0x7fff, 1), [255, 255, 255, 0]);
        assert_eq!(rgba16(0xffff, 1), [255, 255, 255, 255]);
        assert_eq!(rgba16(0x4321, 2), [17, 34, 51, 68]);
    }
}
