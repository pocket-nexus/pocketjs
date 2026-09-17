//! pocket-micro-harness <pak> <tape> <frames> <out-dir> <capture,frames>
//!
//! Frame contract per frame `f`: `rt.frame(app, tape.mask_at(f))`, then one
//! core tick, then (when `f` is a capture frame) `draw()` + `raster::render`
//! into `<out-dir>/f<f>.rgba` (480x272 RGBA8). Prints one JSON line with the
//! final signal state, focus and miss counters.

extern crate alloc;

use std::{env, fs, path::Path};

use pocket_micro::pocketjs_core::raster;
use pocket_micro::{pak, tape, App as MicroApp, Runtime, Ui};

include!(concat!(env!("OUT_DIR"), "/app.rs"));

use app::App;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 6 {
        eprintln!("usage: pocket-micro-harness <pak> <tape> <frames> <out-dir> <capture,frames>");
        std::process::exit(2);
    }
    let pak_bytes = fs::read(&args[1]).expect("read pak");
    let tape_text = args[2].clone();
    let frames: u32 = args[3].parse().expect("frames");
    let out_dir = Path::new(&args[4]);
    let captures: Vec<u32> = args[5]
        .split(',')
        .filter(|s| !s.is_empty())
        .map(|s| s.parse().expect("capture frame"))
        .collect();
    fs::create_dir_all(out_dir).expect("out dir");

    let mut ui = Ui::new();
    let assets = pak::feed(&mut ui, &pak_bytes, |_, _| {});
    let mut rt = Runtime::new(ui, assets);
    let mut app = App::new();
    rt.mount(&mut app);

    let (w, h) = rt.ui.viewport();
    let mut fb = vec![0u8; (w as usize) * (h as usize) * 4];
    for f in 0..frames {
        let mask = tape::mask_at(&tape_text, f).unwrap_or(0);
        rt.frame(&mut app, mask);
        rt.ui.tick();
        if captures.contains(&f) {
            let words = rt.ui.draw().words.clone();
            raster::render(&rt.ui, &words, &mut fb);
            fs::write(out_dir.join(format!("f{f}.rgba")), &fb).expect("write frame");
        }
    }
    let mut state = String::new();
    app.state(&mut state);
    let misses = rt.misses();
    println!(
        "{{\"frames\":{},\"state\":{},\"focused\":{},\"unknownTexture\":{},\"unknownSprite\":{}}}",
        frames,
        state,
        rt.focused().0,
        misses.unknown_texture,
        misses.unknown_sprite
    );
}
