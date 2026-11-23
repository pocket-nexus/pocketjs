//! Strip rendering through the driver entry points against the full-frame
//! entry points, on seeded random DrawLists: equal bytes for every pixel
//! format, strip height and damage subset. The crate's unit tests compare
//! both against the per-pixel oracle (`src/differential_tests.rs`).

mod support;

use pocket_drivers::{
    DamageRect, DrawList, FrameInput, PixelFormat, Rect, Renderer, Surface, Target,
};
use pocket_raster::RasterRenderer;
use support::{fixture, random_list, Fixture, Rng};

const FORMATS: [PixelFormat; 3] = [
    PixelFormat::Rgb565,
    PixelFormat::Rgba8888,
    PixelFormat::Argb8888,
];

fn bytes_per_pixel(format: PixelFormat) -> usize {
    match format {
        PixelFormat::Rgb565 => 2,
        _ => 4,
    }
}

/// The full-frame entry point of `format`: all of the frame cleared and
/// drawn, or the logical `damage` rectangles cleared and replayed.
fn full_frame(
    fixture: &Fixture,
    words: &[u32],
    format: PixelFormat,
    scale: u32,
    background: &[u8],
    damage: Option<&[DamageRect]>,
) -> Vec<u8> {
    let mut bytes = background.to_vec();
    match format {
        PixelFormat::Rgb565 => {
            let mut pixels: Vec<u16> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            match damage {
                Some(regions) => pocket_raster::render_scaled_rgb565_regions(
                    fixture,
                    words,
                    &mut pixels,
                    scale,
                    regions,
                ),
                None => pocket_raster::render_scaled_rgb565(fixture, words, &mut pixels, scale),
            }
            bytes = pixels
                .iter()
                .flat_map(|pixel| pixel.to_le_bytes())
                .collect();
        }
        PixelFormat::Rgba8888 => match damage {
            Some(regions) => {
                pocket_raster::render_scaled_regions(fixture, words, &mut bytes, scale, regions)
            }
            None => pocket_raster::render_scaled(fixture, words, &mut bytes, scale),
        },
        _ => match damage {
            Some(regions) => pocket_raster::render_scaled_argb_regions(
                fixture, words, &mut bytes, scale, regions,
            ),
            None => pocket_raster::render_scaled_argb(fixture, words, &mut bytes, scale),
        },
    }
    bytes
}

/// The frame drawn strip by strip through `RasterRenderer`, as a strip
/// display acquires it: full-width regions of `strip` rows, tightly packed.
#[allow(clippy::too_many_arguments)]
fn strips(
    fixture: &Fixture,
    list: &DrawList,
    format: PixelFormat,
    scale: u32,
    background: &[u8],
    damage: &[Rect],
    strip: u32,
    width: u32,
    height: u32,
) -> Vec<u8> {
    let bpp = bytes_per_pixel(format);
    let mut bytes = background.to_vec();
    let mut renderer = RasterRenderer::new(scale).unwrap();
    let mut y = 0;
    while y < height {
        let rows = strip.min(height - y);
        let from = (y * width) as usize * bpp;
        let to = ((y + rows) * width) as usize * bpp;
        let surface = Surface::new(
            &mut bytes[from..to],
            Rect::new(0, y, width, rows),
            width as usize * bpp,
            format,
        )
        .unwrap();
        let mut frame = FrameInput::new(list, fixture, damage, Target::CpuVisible(surface));
        renderer.render(&mut frame).unwrap();
        y += rows;
    }
    bytes
}

#[test]
fn strips_of_every_height_match_the_full_frame_in_every_format() {
    for seed in 100..106u64 {
        let (width, height) = [(40, 24), (33, 17), (48, 40)][(seed % 3) as usize];
        let fixture = fixture(seed, width, height);
        let mut rng = Rng(seed.wrapping_mul(0x3c6e_f372) + 5);
        for case in 0..80 {
            let mut list = DrawList::new();
            list.words = random_list(&mut rng, width, height, true);
            let scale = rng.range(1, 3) as u32;
            let (pw, ph) = (width as u32 * scale, height as u32 * scale);
            for format in FORMATS {
                let background = rng.bytes((pw * ph) as usize * bytes_per_pixel(format));

                // The whole frame: an empty damage list redraws each region.
                let expected = full_frame(&fixture, &list.words, format, scale, &background, None);
                for strip in [1, 7, 32, ph] {
                    let actual = strips(
                        &fixture,
                        &list,
                        format,
                        scale,
                        &background,
                        &[],
                        strip,
                        pw,
                        ph,
                    );
                    assert!(
                        actual == expected,
                        "seed={seed:#x} case={case} scale={scale} {format:?} strip={strip}"
                    );
                }

                // Damage subsets: pixels outside them keep the background.
                let logical: Vec<DamageRect> = (0..rng.range(1, 3))
                    .map(|_| {
                        let x0 = rng.range(0, width - 1);
                        let y0 = rng.range(0, height - 1);
                        DamageRect::new(x0, y0, rng.range(x0 + 1, width), rng.range(y0 + 1, height))
                    })
                    .collect();
                let physical: Vec<Rect> = logical
                    .iter()
                    .map(|rect| {
                        Rect::new(
                            rect.x0 as u32 * scale,
                            rect.y0 as u32 * scale,
                            (rect.x1 - rect.x0) as u32 * scale,
                            (rect.y1 - rect.y0) as u32 * scale,
                        )
                    })
                    .collect();
                let expected = full_frame(
                    &fixture,
                    &list.words,
                    format,
                    scale,
                    &background,
                    Some(&logical),
                );
                for strip in [1, 7, 32, ph] {
                    let actual = strips(
                        &fixture,
                        &list,
                        format,
                        scale,
                        &background,
                        &physical,
                        strip,
                        pw,
                        ph,
                    );
                    assert!(
                        actual == expected,
                        "seed={seed:#x} case={case} scale={scale} {format:?} strip={strip} damage"
                    );
                }
            }
        }
    }
}
