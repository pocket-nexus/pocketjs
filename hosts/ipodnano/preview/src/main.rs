//! Host preview of the iPod nano Hero: runs the device crate's `Hero` over a
//! scripted session, checks every frame against a full-tree layout solve,
//! and writes the persistent RGB565 framebuffer as PNG at named frames.
//! Usage: pocketjs-ipodnano-preview <output-directory>

use pocketjs_ipodnano::{button, Hero, HEIGHT, WIDTH};
use std::{fs::File, io::BufWriter, path::Path};

fn write_png(path: &Path, pixels: &[u16]) {
    let mut rgb = Vec::with_capacity(pixels.len() * 3);
    for &p in pixels {
        let (r, g, b) = ((p >> 11) & 31, (p >> 5) & 63, p & 31);
        rgb.extend_from_slice(&[(r << 3 | r >> 2) as u8, (g << 2 | g >> 4) as u8, (b << 3 | b >> 2) as u8]);
    }
    let mut encoder = png::Encoder::new(BufWriter::new(File::create(path).unwrap()), WIDTH as u32, HEIGHT as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().unwrap().write_image_data(&rgb).unwrap();
}

fn main() {
    let out = std::env::args().nth(1).expect("usage: pocketjs-ipodnano-preview <output-directory>");
    let out = Path::new(&out);
    let mut hero = Hero::new();
    // (frame, buttons held) script at 30 Hz: settle, five center presses,
    // a wheel notch, then Play/Pause.
    let mut script = Vec::new();
    for _ in 0..45 {
        script.push(0);
    }
    for _ in 0..5 {
        script.extend_from_slice(&[button::SELECT, button::SELECT, 0, 0, 0, 0]);
    }
    script.extend_from_slice(&[button::SCROLL_FWD, 0, 0, 0]);
    let after_presses = script.len();
    script.extend_from_slice(&[button::PLAY, button::PLAY, 0, 0, 0, 0, 0, 0, 0, 0]);
    let shots = [(0, "00-first"), (44, "01-settled"), (after_presses - 1, "02-count5"), (script.len() - 1, "03-reset")];
    let (mut regions, mut pixels, mut full) = (0usize, 0u64, 0usize);
    for (frame, &buttons) in script.iter().enumerate() {
        let damage = hero.frame(buttons);
        regions += damage.len();
        let area: u64 = damage.iter().map(|r| r.area()).sum();
        if area == (WIDTH * HEIGHT) as u64 {
            full += 1;
        }
        pixels += area;
        let mismatches = hero.app.ui_mut().core_mut().layout_mismatches();
        assert!(mismatches.is_empty(), "frame {frame}: baked layout differs from the full-tree solve: {mismatches:?}");
        if let Some((_, name)) = shots.iter().find(|(at, _)| *at == frame) {
            write_png(&out.join(format!("{name}.png")), hero.pixels());
            println!("{name}: frame {frame}, count {}", hero.count());
        }
    }
    let frames = script.len();
    println!(
        "{frames} frames, {regions} damage regions, {} px/frame average, {full} full redraws, layout oracle clean",
        pixels / frames as u64
    );
    assert_eq!(hero.count(), 0, "Play/Pause resets the counter");
}
