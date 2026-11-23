//! The production interpreter against the per-pixel oracle in `reference`,
//! on seeded random DrawLists, for every target type: equal bytes.

extern crate std;

use super::reference;
use super::surface::interpret_for_test;
use super::{
    render_scaled_clipped, Clip, PremultipliedTarget, RenderTarget, Rgb565Target, RgbaTarget,
};
use pocket_drivers::{DamageRect, PixelFormat, Rect, Surface};
use std::{format, string::String, vec, vec::Vec};

#[path = "../tests/support/mod.rs"]
mod support;
use support::{fixture, random_list, Fixture, Rng};

fn random_clip(rng: &mut Rng, bounds: Clip) -> Clip {
    if rng.chance(40) {
        return bounds;
    }
    let x0 = rng.range(bounds.x0, bounds.x1 - 1);
    let y0 = rng.range(bounds.y0, bounds.y1 - 1);
    Clip {
        x0,
        y0,
        x1: rng.range(x0 + 1, bounds.x1),
        y1: rng.range(y0 + 1, bounds.y1),
    }
}

fn label(seed: u64, case: usize, scale: u32, what: &str) -> String {
    format!("seed={seed:#x} case={case} scale={scale} {what}")
}

fn le_bytes(pixels: &[u16]) -> Vec<u8> {
    pixels
        .iter()
        .flat_map(|pixel| pixel.to_le_bytes())
        .collect()
}

/// Reference bytes of a full frame in `format` after the oracle interprets
/// `words` under `clip` over `background`.
fn oracle_frame(
    fixture: &Fixture,
    words: &[u32],
    scale: u32,
    format: PixelFormat,
    background: &[u8],
    clip: Clip,
    clear: bool,
) -> Vec<u8> {
    let width = fixture.width * scale as i32;
    fn run<T: RenderTarget>(
        fixture: &Fixture,
        words: &[u32],
        target: &mut T,
        width: i32,
        scale: u32,
        clip: Clip,
        clear: bool,
    ) {
        if clear {
            for y in clip.y0..clip.y1 {
                target.fill_opaque(
                    (y * width + clip.x0) as usize,
                    (clip.x1 - clip.x0) as usize,
                    0,
                    0,
                    0,
                );
            }
        }
        reference::render_scaled_clipped(fixture, words, target, width, scale as i32, clip);
    }
    match format {
        PixelFormat::Rgb565 => {
            let mut pixels: Vec<u16> = background
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            let mut target = reference::Rgb565Target {
                pixels: &mut pixels,
            };
            run(fixture, words, &mut target, width, scale, clip, clear);
            le_bytes(&pixels)
        }
        PixelFormat::Rgba8888 => {
            let mut bytes = background.to_vec();
            let mut target = reference::RgbaTarget::<false> { bytes: &mut bytes };
            run(fixture, words, &mut target, width, scale, clip, clear);
            bytes
        }
        PixelFormat::Argb8888 => {
            let mut bytes = background.to_vec();
            let mut target = reference::RgbaTarget::<true> { bytes: &mut bytes };
            run(fixture, words, &mut target, width, scale, clip, clear);
            bytes
        }
        _ => unreachable!(),
    }
}

fn bytes_per_pixel(format: PixelFormat) -> usize {
    match format {
        PixelFormat::Rgb565 => 2,
        _ => 4,
    }
}

const FORMATS: [PixelFormat; 3] = [
    PixelFormat::Rgb565,
    PixelFormat::Rgba8888,
    PixelFormat::Argb8888,
];

#[test]
fn full_frame_targets_match_the_per_pixel_oracle() {
    for seed in 0..6u64 {
        let (width, height) = [(40, 24), (33, 17), (64, 9)][(seed % 3) as usize];
        let fixture = fixture(seed, width, height);
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9) + 1);
        for case in 0..90 {
            let words = random_list(&mut rng, width, height, false);
            for scale in 1..=3u32 {
                let (pw, ph) = (width * scale as i32, height * scale as i32);
                let screen = Clip {
                    x0: 0,
                    y0: 0,
                    x1: pw,
                    y1: ph,
                };
                let clip = random_clip(&mut rng, screen);
                let clear = rng.chance(50);
                let pixels = (pw * ph) as usize;
                let background = rng.bytes(pixels * 4);

                for format in FORMATS {
                    let bpp = bytes_per_pixel(format);
                    let expected = oracle_frame(
                        &fixture,
                        &words,
                        scale,
                        format,
                        &background[..pixels * bpp],
                        clip,
                        clear,
                    );
                    let mut actual = background[..pixels * bpp].to_vec();
                    fn run<T: RenderTarget>(
                        fixture: &Fixture,
                        words: &[u32],
                        target: &mut T,
                        width: i32,
                        scale: u32,
                        clip: Clip,
                        clear: bool,
                    ) {
                        if clear {
                            super::clear_black_rect(target, width, clip);
                        }
                        render_scaled_clipped(fixture, words, target, width, scale as i32, clip);
                    }
                    match format {
                        PixelFormat::Rgb565 => {
                            let mut pixels: Vec<u16> = actual
                                .as_chunks::<2>()
                                .0
                                .iter()
                                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                                .collect();
                            let mut target = Rgb565Target {
                                pixels: &mut pixels,
                            };
                            run(&fixture, &words, &mut target, pw, scale, clip, clear);
                            actual = le_bytes(&pixels);
                        }
                        PixelFormat::Rgba8888 => {
                            let mut target = RgbaTarget::<false> { bytes: &mut actual };
                            run(&fixture, &words, &mut target, pw, scale, clip, clear);
                        }
                        _ => {
                            let mut target = RgbaTarget::<true> { bytes: &mut actual };
                            run(&fixture, &words, &mut target, pw, scale, clip, clear);
                        }
                    }
                    assert!(
                        actual == expected,
                        "{}",
                        label(seed, case, scale, &format!("{format:?} full frame"))
                    );
                }

                // The coverage-keeping target: transparent or untouched start.
                let mut expected = background.clone();
                let mut actual = background.clone();
                if clear {
                    expected.fill(0);
                    actual.fill(0);
                }
                let mut oracle = reference::PremultipliedTarget {
                    bytes: &mut expected,
                };
                reference::render_scaled_clipped(
                    &fixture,
                    &words,
                    &mut oracle,
                    pw,
                    scale as i32,
                    clip,
                );
                let mut target = PremultipliedTarget { bytes: &mut actual };
                render_scaled_clipped(&fixture, &words, &mut target, pw, scale as i32, clip);
                assert!(
                    actual == expected,
                    "{}",
                    label(seed, case, scale, "premultiplied")
                );
            }
        }
    }
}

#[test]
fn public_full_frame_entrypoints_match_the_per_pixel_oracle() {
    for seed in 20..24u64 {
        let (width, height) = [(40, 24), (21, 30)][(seed % 2) as usize];
        let fixture = fixture(seed, width, height);
        let mut rng = Rng(seed.wrapping_mul(0x2545_f491) + 7);
        for case in 0..60 {
            let words = random_list(&mut rng, width, height, false);
            let scale = rng.range(1, 3) as u32;
            let (pw, ph) = (width * scale as i32, height * scale as i32);
            let screen = Clip {
                x0: 0,
                y0: 0,
                x1: pw,
                y1: ph,
            };
            let pixels = (pw * ph) as usize;
            let background = rng.bytes(pixels * 4);

            // Clearing entry points.
            let expected = oracle_frame(
                &fixture,
                &words,
                scale,
                PixelFormat::Rgba8888,
                &background,
                screen,
                true,
            );
            let mut actual = background.clone();
            super::render_scaled(&fixture, &words, &mut actual, scale);
            assert!(actual == expected, "{}", label(seed, case, scale, "rgba"));

            let expected = oracle_frame(
                &fixture,
                &words,
                scale,
                PixelFormat::Argb8888,
                &background,
                screen,
                true,
            );
            let mut actual = background.clone();
            super::render_scaled_argb(&fixture, &words, &mut actual, scale);
            assert!(actual == expected, "{}", label(seed, case, scale, "argb"));

            let expected = oracle_frame(
                &fixture,
                &words,
                scale,
                PixelFormat::Rgb565,
                &background[..pixels * 2],
                screen,
                true,
            );
            let mut actual = vec![0x1234u16; pixels];
            super::render_scaled_rgb565(&fixture, &words, &mut actual, scale);
            assert!(
                le_bytes(&actual) == expected,
                "{}",
                label(seed, case, scale, "rgb565")
            );

            // Over an existing frame.
            let expected = oracle_frame(
                &fixture,
                &words,
                scale,
                PixelFormat::Rgb565,
                &background[..pixels * 2],
                screen,
                false,
            );
            let mut actual: Vec<u16> = background[..pixels * 2]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            super::render_scaled_rgb565_over(&fixture, &words, &mut actual, scale);
            assert!(
                le_bytes(&actual) == expected,
                "{}",
                label(seed, case, scale, "rgb565 over")
            );
            let expected = oracle_frame(
                &fixture,
                &words,
                scale,
                PixelFormat::Rgba8888,
                &background,
                screen,
                false,
            );
            let mut actual = background.clone();
            super::render_scaled_over(&fixture, &words, &mut actual, scale);
            assert!(
                actual == expected,
                "{}",
                label(seed, case, scale, "rgba over")
            );

            // Logical damage regions: each cleared and replayed in order.
            let logical = Clip {
                x0: 0,
                y0: 0,
                x1: width,
                y1: height,
            };
            let regions: Vec<DamageRect> = (0..rng.range(1, 3))
                .map(|_| {
                    let clip = random_clip(&mut rng, logical);
                    DamageRect::new(clip.x0, clip.y0, clip.x1, clip.y1)
                })
                .collect();
            for format in FORMATS {
                let bpp = bytes_per_pixel(format);
                let mut expected = background[..pixels * bpp].to_vec();
                for region in &regions {
                    let clip = Clip {
                        x0: region.x0 * scale as i32,
                        y0: region.y0 * scale as i32,
                        x1: region.x1 * scale as i32,
                        y1: region.y1 * scale as i32,
                    };
                    expected = oracle_frame(&fixture, &words, scale, format, &expected, clip, true);
                }
                let mut actual = background[..pixels * bpp].to_vec();
                match format {
                    PixelFormat::Rgb565 => {
                        let mut pixels: Vec<u16> = actual
                            .as_chunks::<2>()
                            .0
                            .iter()
                            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                            .collect();
                        super::render_scaled_rgb565_regions(
                            &fixture,
                            &words,
                            &mut pixels,
                            scale,
                            &regions,
                        );
                        actual = le_bytes(&pixels);
                    }
                    PixelFormat::Rgba8888 => {
                        super::render_scaled_regions(&fixture, &words, &mut actual, scale, &regions)
                    }
                    _ => super::render_scaled_argb_regions(
                        &fixture,
                        &words,
                        &mut actual,
                        scale,
                        &regions,
                    ),
                }
                assert!(
                    actual == expected,
                    "{}",
                    label(seed, case, scale, &format!("{format:?} regions"))
                );
            }

            // A compact RGB565 window keeps the full-viewport sample phase.
            let window = random_clip(&mut rng, logical);
            let physical = Clip {
                x0: window.x0 * scale as i32,
                y0: window.y0 * scale as i32,
                x1: window.x1 * scale as i32,
                y1: window.y1 * scale as i32,
            };
            let expected = oracle_frame(
                &fixture,
                &words,
                scale,
                PixelFormat::Rgb565,
                &background[..pixels * 2],
                physical,
                false,
            );
            let mut compact = Vec::new();
            let mut wanted = Vec::new();
            for y in physical.y0..physical.y1 {
                for x in physical.x0..physical.x1 {
                    let at = ((y * pw + x) * 2) as usize;
                    compact.push(u16::from_le_bytes([background[at], background[at + 1]]));
                    wanted.push(u16::from_le_bytes([expected[at], expected[at + 1]]));
                }
            }
            super::render_scaled_rgb565_window_over(
                &fixture,
                &words,
                &mut compact,
                scale,
                DamageRect::new(window.x0, window.y0, window.x1, window.y1),
            );
            assert!(
                compact == wanted,
                "{}",
                label(seed, case, scale, "rgb565 window")
            );
        }
    }
}

/// One acquired region of a strided surface against the same rectangle of
/// the oracle's full frame; bytes outside the region rows keep their value.
#[allow(clippy::too_many_arguments)]
fn check_surface(
    fixture: &Fixture,
    words: &[u32],
    scale: u32,
    format: PixelFormat,
    region: Clip,
    padding: usize,
    clip: Clip,
    clear: bool,
    lead: usize,
    background: &[u8],
    what: &str,
) {
    let bpp = bytes_per_pixel(format);
    let pw = fixture.width * scale as i32;
    let expected = oracle_frame(fixture, words, scale, format, background, clip, clear);
    let row_bytes = (region.x1 - region.x0) as usize * bpp;
    let stride = row_bytes + padding;
    let rows = (region.y1 - region.y0) as usize;
    // `lead` bytes in front move the pixels off the allocation's alignment.
    let mut storage = vec![0xa5u8; lead + stride * (rows - 1) + row_bytes];
    let bytes = &mut storage[lead..];
    for row in 0..rows {
        let from = (((region.y0 + row as i32) * pw + region.x0) as usize) * bpp;
        bytes[row * stride..row * stride + row_bytes]
            .copy_from_slice(&background[from..from + row_bytes]);
    }
    {
        let mut surface = Surface::new(
            bytes,
            Rect::new(
                region.x0 as u32,
                region.y0 as u32,
                (region.x1 - region.x0) as u32,
                rows as u32,
            ),
            stride,
            format,
        )
        .unwrap();
        interpret_for_test(fixture, words, &mut surface, scale, clip, clear);
    }
    for row in 0..rows {
        let from = (((region.y0 + row as i32) * pw + region.x0) as usize) * bpp;
        assert!(
            bytes[row * stride..row * stride + row_bytes] == expected[from..from + row_bytes],
            "{what} row {row}"
        );
        if row + 1 < rows {
            assert!(
                bytes[row * stride + row_bytes..(row + 1) * stride]
                    .iter()
                    .all(|&byte| byte == 0xa5),
                "{what} padding after row {row}"
            );
        }
    }
}

#[test]
fn acquired_surfaces_match_the_per_pixel_oracle() {
    for seed in 40..46u64 {
        let (width, height) = [(40, 24), (33, 17), (48, 40)][(seed % 3) as usize];
        let fixture = fixture(seed, width, height);
        let mut rng = Rng(seed.wrapping_mul(0x6a09_e667) + 3);
        for case in 0..70 {
            let words = random_list(&mut rng, width, height, false);
            for scale in 1..=3u32 {
                let (pw, ph) = (width * scale as i32, height * scale as i32);
                let background = rng.bytes((pw * ph) as usize * 4);
                for format in FORMATS {
                    let bpp = bytes_per_pixel(format);
                    let background = &background[..(pw * ph) as usize * bpp];
                    // Full-width strips of several heights, tightly packed:
                    // the layout of a strip display.
                    for strip in [1, 7, 32, ph] {
                        let y0 = rng.range(0, ph - 1);
                        let region = Clip {
                            x0: 0,
                            y0,
                            x1: pw,
                            y1: (y0 + strip).min(ph),
                        };
                        let clip = random_clip(&mut rng, region);
                        check_surface(
                            &fixture,
                            &words,
                            scale,
                            format,
                            region,
                            0,
                            clip,
                            rng.chance(50),
                            rng.below(4) as usize,
                            background,
                            &label(seed, case, scale, &format!("{format:?} strip {strip}")),
                        );
                    }
                    // Padded rows and regions narrower than the viewport.
                    let screen = Clip {
                        x0: 0,
                        y0: 0,
                        x1: pw,
                        y1: ph,
                    };
                    for _ in 0..2 {
                        let region = random_clip(&mut rng, screen);
                        let clip = random_clip(&mut rng, region);
                        check_surface(
                            &fixture,
                            &words,
                            scale,
                            format,
                            region,
                            rng.range(0, 5) as usize,
                            clip,
                            rng.chance(50),
                            rng.below(4) as usize,
                            background,
                            &label(seed, case, scale, &format!("{format:?} region")),
                        );
                    }
                    let region = Clip {
                        x0: 0,
                        y0: rng.range(0, ph - 1),
                        x1: pw,
                        y1: ph,
                    };
                    check_surface(
                        &fixture,
                        &words,
                        scale,
                        format,
                        region,
                        rng.range(1, 6) as usize,
                        random_clip(&mut rng, region),
                        rng.chance(50),
                        rng.below(4) as usize,
                        background,
                        &label(seed, case, scale, &format!("{format:?} padded rows")),
                    );
                }
            }
        }
    }
}

#[test]
fn surface_entrypoints_match_the_per_pixel_oracle() {
    for seed in 60..64u64 {
        let (width, height) = [(40, 24), (26, 19)][(seed % 2) as usize];
        let fixture = fixture(seed, width, height);
        let mut rng = Rng(seed.wrapping_mul(0xbb67_ae85) + 9);
        for case in 0..60 {
            let words = random_list(&mut rng, width, height, true);
            let scale = rng.range(1, 3) as u32;
            let (pw, ph) = (width * scale as i32, height * scale as i32);
            let screen = Clip {
                x0: 0,
                y0: 0,
                x1: pw,
                y1: ph,
            };
            let format = FORMATS[rng.below(3) as usize];
            let bpp = bytes_per_pixel(format);
            let background = rng.bytes((pw * ph) as usize * bpp);
            let roots: Vec<Clip> = (0..rng.range(1, 3))
                .map(|_| random_clip(&mut rng, screen))
                .collect();
            let regions: Vec<Rect> = roots
                .iter()
                .map(|root| {
                    Rect::new(
                        root.x0 as u32,
                        root.y0 as u32,
                        (root.x1 - root.x0) as u32,
                        (root.y1 - root.y0) as u32,
                    )
                })
                .collect();
            for strip in [1, 7, 32, ph] {
                let mut expected = background.clone();
                let mut actual = background.clone();
                let mut y = 0;
                while y < ph {
                    let rows = strip.min(ph - y);
                    let acquired = Clip {
                        x0: 0,
                        y0: y,
                        x1: pw,
                        y1: y + rows,
                    };
                    for root in &roots {
                        let root = root.intersect(acquired);
                        if root.x0 < root.x1 && root.y0 < root.y1 {
                            expected = oracle_frame(
                                &fixture, &words, scale, format, &expected, root, true,
                            );
                        }
                    }
                    let from = (y * pw) as usize * bpp;
                    let to = ((y + rows) * pw) as usize * bpp;
                    let mut surface = Surface::new(
                        &mut actual[from..to],
                        Rect::new(0, y as u32, pw as u32, rows as u32),
                        pw as usize * bpp,
                        format,
                    )
                    .unwrap();
                    super::render_surface_regions(&fixture, &words, &mut surface, scale, &regions)
                        .unwrap();
                    y += rows;
                }
                assert!(
                    actual == expected,
                    "{}",
                    label(
                        seed,
                        case,
                        scale,
                        &format!("{format:?} regions strip {strip}")
                    )
                );

                // The whole acquired region, cleared.
                let mut expected = background.clone();
                let mut actual = background.clone();
                let mut y = 0;
                while y < ph {
                    let rows = strip.min(ph - y);
                    let acquired = Clip {
                        x0: 0,
                        y0: y,
                        x1: pw,
                        y1: y + rows,
                    };
                    expected =
                        oracle_frame(&fixture, &words, scale, format, &expected, acquired, true);
                    let from = (y * pw) as usize * bpp;
                    let to = ((y + rows) * pw) as usize * bpp;
                    let mut surface = Surface::new(
                        &mut actual[from..to],
                        Rect::new(0, y as u32, pw as u32, rows as u32),
                        pw as usize * bpp,
                        format,
                    )
                    .unwrap();
                    super::render_surface(&fixture, &words, &mut surface, scale).unwrap();
                    y += rows;
                }
                assert!(
                    actual == expected,
                    "{}",
                    label(
                        seed,
                        case,
                        scale,
                        &format!("{format:?} surface strip {strip}")
                    )
                );
            }
        }
    }
}
