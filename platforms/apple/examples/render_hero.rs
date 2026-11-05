//! Renders a guest bundle through the pocket-apple C ABI and writes PPM
//! snapshots. Build the MOUNTED demo entry first — the bare app name builds a
//! component-only bundle that installs no frame() and cannot boot here:
//!   bun tools/build.ts hero-main
//!   cargo run -p pocket-apple --example render_hero -- ../dist/hero-main.js ../dist/hero-main.pak /tmp/hero
//! A bundle built with --hz=N needs POCKET_TICK_HZ=N in the environment —
//! bundles refuse a host whose declared rate differs from their baked one.
//! Exit is nonzero if two independent instances disagree on the final frame
//! (determinism check) or the frame is blank.

use std::ffi::CString;

use pocket_apple::{
    pocket_apple_create, pocket_apple_destroy, pocket_apple_eval_bundle, pocket_apple_frame,
    pocket_apple_last_error, pocket_apple_load_pak, pocket_apple_render,
    pocket_apple_set_tick_rate, PocketAppleFrame,
};

const WIDTH: u32 = 480;
const HEIGHT: u32 = 272;
const DENSITY: u32 = 2;
const FRAMES: u32 = 180;

fn last_error() -> String {
    unsafe {
        std::ffi::CStr::from_ptr(pocket_apple_last_error())
            .to_string_lossy()
            .into_owned()
    }
}

fn run_instance(bundle: &[u8], pak: &[u8], tick_hz: Option<u32>) -> (Vec<u8>, u32, u32, u64) {
    let handle = pocket_apple_create(DENSITY, WIDTH, HEIGHT);
    assert!(!handle.is_null(), "create failed: {}", last_error());
    assert_eq!(
        pocket_apple_load_pak(handle, pak.as_ptr(), pak.len()),
        0,
        "load_pak failed: {}",
        last_error()
    );
    if let Some(hz) = tick_hz {
        assert_eq!(
            pocket_apple_set_tick_rate(handle, hz),
            0,
            "set_tick_rate({hz}) failed: {}",
            last_error()
        );
    }
    let label = CString::new("hero").unwrap();
    assert_eq!(
        pocket_apple_eval_bundle(handle, bundle.as_ptr(), bundle.len(), label.as_ptr()),
        0,
        "eval failed: {}",
        last_error()
    );

    let mut frame = unsafe { std::mem::zeroed::<PocketAppleFrame>() };
    let mut damage_total: u64 = 0;
    for tick in 0..FRAMES {
        assert_eq!(
            pocket_apple_frame(handle, 0, 0, std::ptr::null(), 0),
            0,
            "frame {tick} failed: {}",
            last_error()
        );
        assert_eq!(
            pocket_apple_render(handle, &mut frame),
            0,
            "render {tick} failed: {}",
            last_error()
        );
        for region in frame.regions.iter().take(frame.region_count as usize) {
            damage_total += (region[2] as u64) * (region[3] as u64);
        }
    }
    let len = (frame.stride_bytes * frame.height_px) as usize;
    let pixels = unsafe { std::slice::from_raw_parts(frame.pixels, len) }.to_vec();
    let (w, h) = (frame.width_px, frame.height_px);
    pocket_apple_destroy(handle);
    (pixels, w, h, damage_total)
}

fn write_ppm(path: &str, argb: &[u8], width: u32, height: u32) {
    let mut out = format!("P6\n{width} {height}\n255\n").into_bytes();
    for chunk in argb.as_chunks::<4>().0 {
        // ARGB32 little-endian in memory: B, G, R, A.
        out.extend_from_slice(&[chunk[2], chunk[1], chunk[0]]);
    }
    std::fs::write(path, out).expect("write ppm");
}

struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        eprintln!("[{}] {}", record.target(), record.args());
    }
    fn flush(&self) {}
}

static LOGGER: StderrLogger = StderrLogger;

fn main() {
    let _ = log::set_logger(&LOGGER).map(|_| log::set_max_level(log::LevelFilter::Debug));
    let args: Vec<String> = std::env::args().collect();
    let bundle_path = args.get(1).map(String::as_str).unwrap_or("../dist/hero-main.js");
    let pak_path = args.get(2).map(String::as_str).unwrap_or("../dist/hero-main.pak");
    let out_base = args.get(3).map(String::as_str).unwrap_or("/tmp/hero");

    let bundle = std::fs::read(bundle_path).expect("read bundle");
    let pak = std::fs::read(pak_path).expect("read pak");
    let tick_hz = std::env::var("POCKET_TICK_HZ")
        .ok()
        .map(|raw| raw.parse::<u32>().expect("POCKET_TICK_HZ must be an integer"));

    let (first, w, h, damage_a) = run_instance(&bundle, &pak, tick_hz);
    let (second, _, _, damage_b) = run_instance(&bundle, &pak, tick_hz);

    let non_blank = first.as_chunks::<4>().0.iter().any(|px| px[0] != 0 || px[1] != 0 || px[2] != 0);
    let deterministic = first == second;

    write_ppm(&format!("{out_base}-frame{FRAMES}.ppm"), &first, w, h);
    println!(
        "rendered {FRAMES} frames at {w}x{h} (density {DENSITY}) | non_blank={non_blank} deterministic={deterministic} damage_px_a={damage_a} damage_px_b={damage_b}"
    );
    if !non_blank || !deterministic {
        std::process::exit(1);
    }
}
