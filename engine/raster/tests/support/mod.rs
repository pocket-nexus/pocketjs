//! Seeded random DrawLists and resources shared by the differential tests
//! inside the crate (`src/differential_tests.rs`) and over its public API
//! (`tests/differential.rs`).
#![allow(dead_code, unused_imports)]

// The crate itself is `no_std`: name the standard library where this file is
// its unit-test module.
extern crate std;

use pocket_drivers::{FontView, RenderResources, TexView};
use pocket_spec::{draw_op, psm};
use std::vec::Vec;

pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    pub fn below(&mut self, n: u32) -> u32 {
        self.next() % n
    }
    pub fn range(&mut self, low: i32, high: i32) -> i32 {
        low + self.below((high - low + 1) as u32) as i32
    }
    pub fn chance(&mut self, percent: u32) -> bool {
        self.below(100) < percent
    }
    pub fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| self.next() as u8).collect()
    }
}

pub struct Tex {
    /// Texel bytes after `offset` bytes of padding: odd offsets give the
    /// rasterizer storage that starts off a word boundary.
    pixels: Vec<u8>,
    offset: usize,
    palette_offset: usize,
    w: u32,
    h: u32,
    psm: u32,
    palette: Option<Vec<u8>>,
    linear: bool,
}

pub struct Font {
    bitmap: Vec<u8>,
    cell_w: u32,
    cell_h: u32,
    density: u8,
    count: u16,
}

pub struct Fixture {
    pub width: i32,
    pub height: i32,
    textures: Vec<Tex>,
    fonts: Vec<Font>,
}

impl RenderResources for Fixture {
    fn viewport(&self) -> (f32, f32) {
        (self.width as f32, self.height as f32)
    }
    fn raster_revision(&self) -> u64 {
        0
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        let tex = self.textures.get(usize::try_from(handle).ok()?)?;
        Some(TexView {
            pixels: &tex.pixels[tex.offset..],
            w: tex.w,
            h: tex.h,
            psm: tex.psm,
            palette: tex
                .palette
                .as_deref()
                .map(|palette| &palette[tex.palette_offset..]),
            linear: tex.linear,
        })
    }
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>> {
        let font = self.fonts.get(slot as usize)?;
        Some(FontView {
            bitmap: &font.bitmap,
            cell_w: font.cell_w,
            cell_h: font.cell_h,
            raster_density: font.density,
            glyph_count: font.count,
        })
    }
}

/// Handles `VALID_TEXTURES..` are degenerate views every routine skips.
const VALID_TEXTURES: i32 = 20;
const TEXTURES: i32 = 24;
const FONTS: u32 = 3;

pub fn fixture(seed: u64, width: i32, height: i32) -> Fixture {
    let mut rng = Rng(seed ^ 0x51ed_270b);
    let mut textures = Vec::new();
    let mut texture = |rng: &mut Rng, w: u32, h: u32, format: u32, linear: bool, palette: bool| {
        let bpp = match format {
            psm::PSM_8888 => 4,
            psm::PSM_T8 => 1,
            _ => 2,
        };
        // Every other texture starts one to three bytes into its storage.
        let offset = [0, 1, 0, 2, 0, 3][textures.len() % 6];
        let mut pixels = rng.bytes(offset + (w * h) as usize * bpp);
        if format == psm::PSM_8888 {
            // Opaque, transparent and translucent texels.
            for texel in pixels[offset..].as_chunks_mut::<4>().0.iter_mut() {
                match rng.below(4) {
                    0 => texel[3] = 255,
                    1 => texel[3] = 0,
                    _ => {}
                }
            }
        }
        let palette_offset = [0, 1][textures.len() % 2];
        let palette = palette.then(|| {
            let mut entries = rng.bytes(palette_offset + 1024);
            for entry in entries[palette_offset..].as_chunks_mut::<4>().0.iter_mut() {
                match rng.below(4) {
                    0 => entry[3] = 255,
                    1 => entry[3] = 0,
                    _ => {}
                }
            }
            entries
        });
        textures.push(Tex {
            pixels,
            offset,
            palette_offset,
            w,
            h,
            psm: format,
            palette,
            linear,
        });
    };
    texture(&mut rng, 5, 3, psm::PSM_8888, false, false);
    texture(&mut rng, 8, 8, psm::PSM_8888, true, false);
    texture(&mut rng, 7, 4, psm::PSM_5650, false, false);
    texture(&mut rng, 16, 16, psm::PSM_5650, true, false);
    texture(&mut rng, 6, 6, psm::PSM_4444, false, false);
    texture(&mut rng, 3, 9, psm::PSM_4444, true, false);
    texture(&mut rng, 8, 5, psm::PSM_T8, false, true);
    texture(&mut rng, 4, 4, psm::PSM_T8, true, true);
    texture(&mut rng, 1, 1, psm::PSM_8888, false, false);
    texture(&mut rng, 1, 1, psm::PSM_8888, true, false);
    texture(&mut rng, 64, 64, psm::PSM_8888, false, false);
    texture(&mut rng, 32, 32, psm::PSM_5650, false, false);
    texture(&mut rng, 31, 2, psm::PSM_4444, false, false);
    texture(&mut rng, 2, 33, psm::PSM_T8, false, true);
    texture(&mut rng, 9, 9, psm::PSM_8888, true, false);
    texture(&mut rng, 12, 5, psm::PSM_5650, true, false);
    texture(&mut rng, 5, 12, psm::PSM_4444, true, false);
    texture(&mut rng, 6, 7, psm::PSM_T8, true, true);
    texture(&mut rng, 10, 3, psm::PSM_5650, false, false);
    texture(&mut rng, 3, 10, psm::PSM_4444, false, false);
    assert_eq!(textures.len() as i32, VALID_TEXTURES);
    // Degenerate views: an unknown format and T8 without its palette. (A
    // view without texels panics in the nearest clamp, in the oracle too.)
    let mut texture = |rng: &mut Rng, w: u32, h: u32, format: u32, linear: bool| {
        textures.push(Tex {
            pixels: rng.bytes((w * h * 4) as usize),
            offset: 0,
            palette_offset: 0,
            w,
            h,
            psm: format,
            palette: None,
            linear,
        });
    };
    texture(&mut rng, 4, 4, 1, false);
    texture(&mut rng, 4, 4, 1, true);
    texture(&mut rng, 4, 4, psm::PSM_T8, false);
    texture(&mut rng, 4, 4, psm::PSM_T8, true);
    assert_eq!(textures.len() as i32, TEXTURES);

    let mut fonts = Vec::new();
    for (cell_w, cell_h, density, count) in [(5, 7, 1u8, 5u16), (4, 6, 2, 3), (3, 3, 3, 2)] {
        let len = (cell_w * density as u32 * cell_h * density as u32) as usize * count as usize;
        let bitmap = (0..len)
            .map(|_| match rng.below(4) {
                0 => 0,
                1 => 255,
                _ => rng.next() as u8,
            })
            .collect();
        fonts.push(Font {
            bitmap,
            cell_w,
            cell_h,
            density,
            count,
        });
    }
    assert_eq!(fonts.len() as u32, FONTS);
    Fixture {
        width,
        height,
        textures,
        fonts,
    }
}

pub fn xy(x: i32, y: i32) -> u32 {
    (x as i16 as u16 as u32) | ((y as i16 as u16 as u32) << 16)
}

pub fn wh(w: i32, h: i32) -> u32 {
    (w as u16 as u32) | ((h as u16 as u32) << 16)
}

fn coordinate(rng: &mut Rng, extent: i32) -> i32 {
    match rng.below(100) {
        0..=84 => rng.range(-6, extent + 6),
        85..=95 => rng.range(-200, 200),
        _ => [-32768, 32767, -20000, 20000, 0][rng.below(5) as usize],
    }
}

fn color(rng: &mut Rng) -> u32 {
    let alpha = match rng.below(4) {
        0 => 0xff,
        1 => 0,
        _ => rng.below(256),
    };
    (alpha << 24) | (rng.next() & 0x00ff_ffff)
}

fn uv(rng: &mut Rng) -> f32 {
    match rng.below(9) {
        0 => 0.0,
        1 => 1.0,
        2 => 0.5,
        3 => -0.25,
        4 => 1.5,
        5 => 0.999_999,
        _ => rng.below(1001) as f32 / 1000.0,
    }
}

fn modulate(rng: &mut Rng) -> u32 {
    match rng.below(4) {
        0 | 1 => 0xffff_ffff,
        2 => (rng.below(256) << 24) | 0x00ff_ffff,
        _ => rng.next(),
    }
}

/// A texture handle. `strict` leaves out the views the surface entry points
/// reject with an error (T8 without a palette, no texels).
fn handle(rng: &mut Rng, strict: bool) -> u32 {
    if strict {
        // Valid views, the two of an unknown format, or no texture.
        [rng.below(VALID_TEXTURES as u32 + 2), TEXTURES as u32][(rng.below(12) == 0) as usize]
    } else {
        rng.below(TEXTURES as u32 + 1)
    }
}

/// Two quads that share an edge, each fanned into two triangles that share
/// a diagonal, with vertices on the pixel grid and sides at 0, 45 or about
/// 18 and 27 degrees: pixel centres lie on the shared edges and diagonals,
/// where the top-left fill rule decides the one triangle that covers them.
/// The triangles are translucent, so a centre covered twice or not at all
/// differs from one covered once.
fn fans(rng: &mut Rng, words: &mut Vec<u32>, width: i32, height: i32, strict: bool) {
    let (x, y) = (rng.range(-4, width), rng.range(-4, height));
    let k = rng.range(1, 6);
    let (e, f) = match rng.below(4) {
        0 => ((k, 0), (0, k)),
        1 => ((k, k), (-k, k)),
        2 => ((3 * k, k), (-k, 3 * k)),
        _ => ((2 * k, -k), (k, 2 * k)),
    };
    let reverse = rng.chance(50);
    let textured = rng.chance(50);
    let texture = handle(rng, strict);
    let translucent = |rng: &mut Rng| ((0x40 + rng.below(0x80)) << 24) | (rng.next() & 0x00ff_ffff);
    let flat = rng.chance(50);
    let first = translucent(rng);
    let colors: [u32; 4] = core::array::from_fn(|_| if flat { first } else { translucent(rng) });
    let modulate = if rng.chance(50) {
        0xffff_ffff
    } else {
        translucent(rng) | 0x00ff_ffff
    };
    for neighbour in 0..2 {
        let origin = (x + neighbour * e.0, y + neighbour * e.1);
        let mut corners = [
            (origin, (0.0f32, 0.0f32)),
            ((origin.0 + e.0, origin.1 + e.1), (1.0, 0.0)),
            ((origin.0 + e.0 + f.0, origin.1 + e.1 + f.1), (1.0, 1.0)),
            ((origin.0 + f.0, origin.1 + f.1), (0.0, 1.0)),
        ];
        if reverse {
            corners.swap(1, 3);
        }
        for triangle in [[0, 1, 2], [0, 2, 3]] {
            if textured {
                words.extend([draw_op::TEX_TRI, texture]);
                for corner in triangle {
                    let ((px, py), (u, v)) = corners[corner];
                    words.extend([xy(px, py), u.to_bits(), v.to_bits()]);
                }
                words.push(modulate);
            } else {
                words.push(draw_op::TRI);
                words.extend(triangle.map(|corner| xy(corners[corner].0 .0, corners[corner].0 .1)));
                words.extend(triangle.map(|corner| colors[corner]));
            }
        }
    }
}

/// A DrawList the decoder accepts: balanced scissors, at most 32 deep.
pub fn random_list(rng: &mut Rng, width: i32, height: i32, strict: bool) -> Vec<u32> {
    let mut words = Vec::new();
    let mut depth = 0;
    for _ in 0..rng.range(1, 28) {
        let (x, y) = (coordinate(rng, width), coordinate(rng, height));
        match rng.below(23) {
            20..=22 => fans(rng, &mut words, width, height, strict),
            0..=2 => words.extend([
                draw_op::RECT,
                xy(x, y),
                wh(rng.range(0, width + 8), rng.range(0, height + 8)),
                color(rng),
            ]),
            3 | 4 => words.extend([
                draw_op::GRAD_RECT,
                xy(x, y),
                wh(rng.range(0, width + 8), rng.range(0, height + 8)),
                color(rng),
                color(rng),
                rng.below(5),
            ]),
            5..=8 => {
                let first = color(rng);
                let (first, second, third) = match rng.below(3) {
                    0 => (first, first, first),
                    1 => {
                        let opaque = first | 0xff00_0000;
                        (opaque, opaque, opaque)
                    }
                    _ => (first, color(rng), color(rng)),
                };
                words.extend([
                    draw_op::TRI,
                    xy(x, y),
                    xy(coordinate(rng, width), coordinate(rng, height)),
                    xy(coordinate(rng, width), coordinate(rng, height)),
                    first,
                    second,
                    third,
                ]);
            }
            9..=11 => words.extend([
                draw_op::TEX_QUAD,
                handle(rng, strict),
                xy(x, y),
                wh(rng.range(0, width + 8), rng.range(0, height + 8)),
                uv(rng).to_bits(),
                uv(rng).to_bits(),
                uv(rng).to_bits(),
                uv(rng).to_bits(),
                modulate(rng),
            ]),
            12..=14 => words.extend([
                draw_op::TEX_TRI,
                handle(rng, strict),
                xy(x, y),
                uv(rng).to_bits(),
                uv(rng).to_bits(),
                xy(coordinate(rng, width), coordinate(rng, height)),
                uv(rng).to_bits(),
                uv(rng).to_bits(),
                xy(coordinate(rng, width), coordinate(rng, height)),
                uv(rng).to_bits(),
                uv(rng).to_bits(),
                modulate(rng),
            ]),
            15 | 16 => {
                let count = rng.below(5);
                words.extend([
                    draw_op::GLYPH_RUN,
                    rng.below(FONTS + 1) | (count << 16),
                    color(rng),
                ]);
                for _ in 0..count {
                    words.extend([
                        xy(coordinate(rng, width), coordinate(rng, height)),
                        rng.below(7),
                    ]);
                }
            }
            17 if depth < 6 => {
                depth += 1;
                words.extend([
                    draw_op::SCISSOR,
                    xy(rng.range(-3, width), rng.range(-3, height)),
                    wh(rng.range(0, width + 4), rng.range(0, height + 4)),
                ]);
            }
            18 if depth > 0 => {
                depth -= 1;
                words.push(draw_op::SCISSOR_POP);
            }
            _ => {
                let payload = rng.below(7);
                words.extend([draw_op::TEXT_RUN, 0, 0, 0, 0, 0, 0, payload]);
                for _ in 0..payload.div_ceil(4) {
                    words.push(rng.next());
                }
            }
        }
    }
    words.extend(core::iter::repeat_n(draw_op::SCISSOR_POP, depth));
    words
}
