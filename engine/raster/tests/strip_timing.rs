//! Timing of strip workloads on a 466 x 466 RGB565 display drawn in 32-row
//! strips, the shape of an SPI panel on a microcontroller. Not a correctness
//! test and not run by default:
//!
//! ```sh
//! cargo test -p pocket-raster --release --test strip_timing -- --ignored --nocapture
//! ```
//!
//! Host times rank the paths; they do not predict a 32-bit target.

use pocket_drivers::{
    DrawList, FontView, FrameInput, PixelFormat, Rect, RenderResources, Renderer, Surface, Target,
    TexView,
};
use pocket_raster::RasterRenderer;
use pocket_spec::{draw_op, psm};
use std::time::Instant;

const WIDTH: u32 = 466;
const HEIGHT: u32 = 466;
const STRIP: u32 = 32;
const TEXTURE: u32 = 256;

struct Resources {
    rgba: Vec<u8>,
    rgb565: Vec<u8>,
    rgba4444: Vec<u8>,
    font: Vec<u8>,
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    fn range(&mut self, low: i32, high: i32) -> i32 {
        low + (self.next() % (high - low + 1) as u32) as i32
    }
}

impl Resources {
    fn new() -> Self {
        let mut rng = Rng(7);
        let texels = (TEXTURE * TEXTURE) as usize;
        let mut rgba = Vec::with_capacity(texels * 4);
        for index in 0..texels {
            let (x, y) = (index as u32 % TEXTURE, index as u32 / TEXTURE);
            // An icon-like alpha: opaque centre, soft edge, transparent rim.
            let dx = x as i32 - 128;
            let dy = y as i32 - 128;
            let distance = dx * dx + dy * dy;
            let alpha = if distance < 100 * 100 {
                255
            } else if distance < 118 * 118 {
                (rng.next() % 255) as u8
            } else {
                0
            };
            rgba.extend([x as u8, y as u8, (x ^ y) as u8, alpha]);
        }
        let rgb565 = (0..texels * 2).map(|_| rng.next() as u8).collect();
        let rgba4444 = (0..texels * 2).map(|_| rng.next() as u8).collect();
        let font = (0..12 * 20 * 64)
            .map(|_| match rng.next() % 3 {
                0 => 0,
                1 => 255,
                _ => rng.next() as u8,
            })
            .collect();
        Self {
            rgba,
            rgb565,
            rgba4444,
            font,
        }
    }
}

impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (WIDTH as f32, HEIGHT as f32)
    }
    fn raster_revision(&self) -> u64 {
        0
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        let (pixels, format, linear) = match handle {
            0 => (&self.rgba, psm::PSM_8888, false),
            1 => (&self.rgba, psm::PSM_8888, true),
            2 => (&self.rgb565, psm::PSM_5650, false),
            3 => (&self.rgba4444, psm::PSM_4444, false),
            _ => return None,
        };
        Some(TexView {
            pixels,
            w: TEXTURE,
            h: TEXTURE,
            psm: format,
            palette: None,
            linear,
        })
    }
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>> {
        (slot == 0).then_some(FontView {
            bitmap: &self.font,
            cell_w: 12,
            cell_h: 20,
            raster_density: 1,
            glyph_count: 64,
        })
    }
}

fn xy(x: i32, y: i32) -> u32 {
    (x as i16 as u16 as u32) | ((y as i16 as u16 as u32) << 16)
}

fn wh(w: i32, h: i32) -> u32 {
    (w as u16 as u32) | ((h as u16 as u32) << 16)
}

fn background(words: &mut Vec<u32>) {
    words.extend([
        draw_op::RECT,
        xy(0, 0),
        wh(WIDTH as i32, HEIGHT as i32),
        0xff20_1810,
    ]);
}

fn quad(words: &mut Vec<u32>, handle: u32, x: i32, y: i32, size: i32, modulate: u32) {
    words.extend([
        draw_op::TEX_QUAD,
        handle,
        xy(x, y),
        wh(size, size),
        0f32.to_bits(),
        0f32.to_bits(),
        1f32.to_bits(),
        1f32.to_bits(),
        modulate,
    ]);
}

/// A `size` square of the texture turned by `degrees` about its centre, as
/// the two triangles the core emits for a rotated image.
fn rotated(words: &mut Vec<u32>, handle: u32, cx: f32, cy: f32, size: f32, degrees: f32) {
    let (sin, cos) = degrees.to_radians().sin_cos();
    let corner = |u: f32, v: f32| {
        let (x, y) = ((u - 0.5) * size, (v - 0.5) * size);
        (
            xy(
                (cx + x * cos - y * sin).round() as i32,
                (cy + x * sin + y * cos).round() as i32,
            ),
            u.to_bits(),
            v.to_bits(),
        )
    };
    for triangle in [
        [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)],
        [(0.0, 0.0), (1.0, 1.0), (0.0, 1.0)],
    ] {
        words.extend([draw_op::TEX_TRI, handle]);
        for (u, v) in triangle {
            let (position, u, v) = corner(u, v);
            words.extend([position, u, v]);
        }
        words.push(0xffff_ffff);
    }
}

fn workloads() -> Vec<(&'static str, Vec<u32>)> {
    let mut rng = Rng(11);
    let mut all = Vec::new();

    let mut words = Vec::new();
    background(&mut words);
    for _ in 0..24 {
        words.extend([
            draw_op::RECT,
            xy(rng.range(0, 400), rng.range(0, 400)),
            wh(rng.range(40, 200), rng.range(40, 200)),
            0xff00_0000 | rng.next(),
        ]);
    }
    all.push(("opaque rects", words));

    let mut words = Vec::new();
    background(&mut words);
    for _ in 0..12 {
        words.extend([
            draw_op::RECT,
            xy(rng.range(0, 400), rng.range(0, 400)),
            wh(rng.range(40, 200), rng.range(40, 200)),
            0x8000_0000 | (rng.next() & 0x00ff_ffff),
        ]);
    }
    all.push(("translucent rects", words));

    for (name, handle, modulate) in [
        ("tex_quad 8888 1:1", 0, 0xffff_ffff),
        ("tex_quad 8888 1:1 modulated", 0, 0xc0ff_ffff),
        ("tex_quad 5650 1:1", 2, 0xffff_ffff),
        ("tex_quad 4444 1:1", 3, 0xffff_ffff),
    ] {
        let mut words = Vec::new();
        background(&mut words);
        for (x, y) in [(0, 0), (210, 0), (0, 210), (210, 210)] {
            quad(&mut words, handle, x, y, TEXTURE as i32, modulate);
        }
        all.push((name, words));
    }

    let mut words = Vec::new();
    background(&mut words);
    quad(&mut words, 1, 0, 0, 300, 0xffff_ffff);
    quad(&mut words, 1, 166, 166, 300, 0xffff_ffff);
    all.push(("tex_quad 8888 linear scaled", words));

    for (name, handle) in [
        ("tex_tri 8888 rotated", 0),
        ("tex_tri 8888 rotated linear", 1),
        ("tex_tri 5650 rotated", 2),
    ] {
        let mut words = Vec::new();
        background(&mut words);
        for (cx, cy) in [
            (128.0, 128.0),
            (338.0, 128.0),
            (128.0, 338.0),
            (338.0, 338.0),
        ] {
            rotated(&mut words, handle, cx, cy, TEXTURE as f32, 17.0);
        }
        all.push((name, words));
    }

    let mut words = Vec::new();
    background(&mut words);
    for _ in 0..800 {
        let (x, y) = (rng.range(0, 440), rng.range(0, 440));
        let color = 0xff00_0000 | rng.next();
        words.extend([
            draw_op::TRI,
            xy(x, y),
            xy(x + rng.range(6, 30), y + rng.range(-4, 4)),
            xy(x + rng.range(-4, 4), y + rng.range(6, 30)),
            color,
            color,
            color,
        ]);
    }
    all.push(("flat opaque tris, small", words));

    let mut words = Vec::new();
    background(&mut words);
    for _ in 0..40 {
        let (x, y) = (rng.range(0, 300), rng.range(0, 300));
        let color = 0xff00_0000 | rng.next();
        words.extend([
            draw_op::TRI,
            xy(x, y),
            xy(x + rng.range(60, 160), y + rng.range(-30, 30)),
            xy(x + rng.range(-30, 30), y + rng.range(60, 160)),
            color,
            color,
            color,
        ]);
    }
    all.push(("flat opaque tris, large", words));

    let mut words = Vec::new();
    background(&mut words);
    for _ in 0..40 {
        let (x, y) = (rng.range(0, 300), rng.range(0, 300));
        let color = 0x9000_0000 | (rng.next() & 0x00ff_ffff);
        words.extend([
            draw_op::TRI,
            xy(x, y),
            xy(x + rng.range(60, 160), y + rng.range(-30, 30)),
            xy(x + rng.range(-30, 30), y + rng.range(60, 160)),
            color,
            color,
            color,
        ]);
    }
    all.push(("flat translucent tris", words));

    let mut words = Vec::new();
    background(&mut words);
    for _ in 0..40 {
        let (x, y) = (rng.range(0, 300), rng.range(0, 300));
        words.extend([
            draw_op::TRI,
            xy(x, y),
            xy(x + rng.range(60, 160), y + rng.range(-30, 30)),
            xy(x + rng.range(-30, 30), y + rng.range(60, 160)),
            0xff00_0000 | rng.next(),
            0xff00_0000 | rng.next(),
            0x8000_0000 | (rng.next() & 0x00ff_ffff),
        ]);
    }
    all.push(("gouraud tris", words));

    let mut words = Vec::new();
    background(&mut words);
    for line in 0..20 {
        words.extend([draw_op::GLYPH_RUN, 36 << 16, 0xffe0_e0e0]);
        for column in 0..36 {
            words.extend([xy(8 + column * 12, 8 + line * 22), rng.next() % 64]);
        }
    }
    all.push(("glyph runs", words));

    let mut words = Vec::new();
    for (from, to, direction) in [
        (0xff10_2040u32, 0xff40_2010u32, 1u32),
        (0x8000_ff00, 0x80ff_0000, 3),
    ] {
        words.extend([
            draw_op::GRAD_RECT,
            xy(0, 0),
            wh(WIDTH as i32, HEIGHT as i32),
            from,
            to,
            direction,
        ]);
    }
    all.push(("gradient rects", words));
    all
}

fn frame(resources: &Resources, list: &DrawList, bytes: &mut [u8]) {
    let mut renderer = RasterRenderer::new(1).unwrap();
    let mut y = 0;
    while y < HEIGHT {
        let rows = STRIP.min(HEIGHT - y);
        let damage = [Rect::new(0, y, WIDTH, rows)];
        let surface = Surface::new(
            &mut bytes[..(WIDTH * rows * 2) as usize],
            Rect::new(0, y, WIDTH, rows),
            WIDTH as usize * 2,
            PixelFormat::Rgb565,
        )
        .unwrap();
        let mut input = FrameInput::new(list, resources, &damage, Target::CpuVisible(surface));
        renderer.render(&mut input).unwrap();
        y += rows;
    }
}

#[test]
#[ignore = "timing; run with --release -- --ignored --nocapture"]
fn strip_workload_times() {
    let resources = Resources::new();
    let mut bytes = vec![0u8; (WIDTH * STRIP * 2) as usize];
    println!("{:<34} {:>12} {:>10}", "workload", "us/frame", "ns/pixel");
    let mut checksum = 0u64;
    for (name, words) in workloads() {
        let mut list = DrawList::new();
        list.words = words;
        for _ in 0..3 {
            frame(&resources, &list, &mut bytes);
        }
        let mut best = f64::MAX;
        for _ in 0..5 {
            let started = Instant::now();
            let mut frames = 0u32;
            while started.elapsed().as_millis() < 120 {
                frame(&resources, &list, &mut bytes);
                frames += 1;
            }
            let per_frame = started.elapsed().as_secs_f64() * 1e6 / frames as f64;
            best = best.min(per_frame);
        }
        checksum = checksum
            .wrapping_mul(31)
            .wrapping_add(bytes.iter().map(|&byte| byte as u64).sum::<u64>());
        println!(
            "{:<34} {:>12.1} {:>10.2}",
            name,
            best,
            best * 1000.0 / (WIDTH * HEIGHT) as f64
        );
    }
    println!("checksum {checksum:#x}");
}
