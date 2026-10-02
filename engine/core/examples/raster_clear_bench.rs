use std::hint::black_box;
use std::time::Instant;

use pocketjs_core::raster;
use pocketjs_core::spec::draw_op;
use pocketjs_core::Ui;

const SAMPLES: usize = 31;
const ITERATIONS: usize = 2_000;

fn xy_word(x: i16, y: i16) -> u32 {
    x as u16 as u32 | ((y as u16 as u32) << 16)
}

fn wh_word(width: u16, height: u16) -> u32 {
    width as u32 | ((height as u32) << 16)
}

fn measure(ui: &Ui, words: &[u32], framebuffer: &mut [u8]) -> Vec<f64> {
    for _ in 0..100 {
        raster::render(black_box(ui), black_box(words), black_box(framebuffer));
    }

    let mut samples = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let start = Instant::now();
        for _ in 0..ITERATIONS {
            raster::render(black_box(ui), black_box(words), black_box(framebuffer));
        }
        samples.push(start.elapsed().as_nanos() as f64 / ITERATIONS as f64);
    }
    samples
}

fn median(samples: &[f64]) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[sorted.len() / 2]
}

fn main() {
    let mut ui = Ui::new();
    ui.set_viewport(480.0, 272.0);
    let mut framebuffer = vec![0x5a; 480 * 272 * 4];
    let full_opaque = [
        draw_op::RECT,
        xy_word(0, 0),
        wh_word(480, 272),
        0xff33_2211,
    ];
    let partial_opaque = [
        draw_op::RECT,
        xy_word(0, 0),
        wh_word(240, 272),
        0xff33_2211,
    ];
    let accepted = measure(&ui, &full_opaque, &mut framebuffer);
    let fallback = measure(&ui, &partial_opaque, &mut framebuffer);
    println!(
        "{{\"samples\":{SAMPLES},\"iterationsPerSample\":{ITERATIONS},\"acceptedNs\":{accepted:?},\"acceptedMedianNs\":{},\"fallbackNs\":{fallback:?},\"fallbackMedianNs\":{}}}",
        median(&accepted),
        median(&fallback),
    );
}
