//! Deterministic memory accounting for parse-time glyph span indexes.
//!
//! Usage: `cargo run --example glyph_span_stats --features std -- app.pak ...`

use std::{
    alloc::{GlobalAlloc, Layout, System},
    env, fs, process,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use pocketjs_core::{pak, raster, spec, text, text::Atlas, Ui};

struct CountingAllocator;

static COUNTING: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static DEALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static LIVE_BYTES: AtomicUsize = AtomicUsize::new(0);
static PEAK_BYTES: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() && COUNTING.load(Ordering::Relaxed) {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            let live = LIVE_BYTES.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK_BYTES.fetch_max(live, Ordering::Relaxed);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if COUNTING.load(Ordering::Relaxed) {
            DEALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            LIVE_BYTES.fetch_sub(layout.size(), Ordering::Relaxed);
        }
        System.dealloc(ptr, layout);
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

#[derive(Clone, Copy)]
struct AllocationStats {
    allocations: usize,
    deallocations: usize,
    resident_bytes: usize,
    peak_bytes: usize,
}

fn measure<T>(f: impl FnOnce() -> T) -> (T, AllocationStats) {
    COUNTING.store(false, Ordering::SeqCst);
    ALLOCATIONS.store(0, Ordering::Relaxed);
    DEALLOCATIONS.store(0, Ordering::Relaxed);
    LIVE_BYTES.store(0, Ordering::Relaxed);
    PEAK_BYTES.store(0, Ordering::Relaxed);
    COUNTING.store(true, Ordering::SeqCst);
    let value = f();
    COUNTING.store(false, Ordering::SeqCst);
    let stats = AllocationStats {
        allocations: ALLOCATIONS.load(Ordering::Relaxed),
        deallocations: DEALLOCATIONS.load(Ordering::Relaxed),
        resident_bytes: LIVE_BYTES.load(Ordering::Relaxed),
        peak_bytes: PEAK_BYTES.load(Ordering::Relaxed),
    };
    (value, stats)
}

fn xy_word(x: i16, y: i16) -> u32 {
    x as u16 as u32 | ((y as u16 as u32) << 16)
}

fn median(mut samples: Vec<Duration>) -> Duration {
    samples.sort_unstable();
    samples[samples.len() / 2]
}

fn parse_benchmark(entries: &[&[u8]]) {
    const SAMPLES: usize = 31;
    const ITERATIONS: usize = 50;
    for _ in 0..5 {
        for &blob in entries {
            std::hint::black_box(Atlas::parse(blob));
        }
    }
    let mut samples = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let start = Instant::now();
        for _ in 0..ITERATIONS {
            for &blob in entries {
                std::hint::black_box(Atlas::parse(blob));
            }
        }
        samples.push(start.elapsed());
    }
    let elapsed = median(samples);
    println!(
        "parse_bench samples={} iterations={} atlases_per_iteration={} median_ms={:.3} median_us_per_iteration={:.3}",
        SAMPLES,
        ITERATIONS,
        entries.len(),
        elapsed.as_secs_f64() * 1_000.0,
        elapsed.as_secs_f64() * 1_000_000.0 / ITERATIONS as f64,
    );
}

fn render_benchmark(ui: &Ui, words: &[u32], glyph_count: usize, framebuffer: &mut [u8]) {
    const SAMPLES: usize = 31;
    const ITERATIONS: usize = 100;
    for _ in 0..10 {
        raster::render(ui, words, framebuffer);
    }
    let mut samples = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let start = Instant::now();
        for _ in 0..ITERATIONS {
            raster::render(
                std::hint::black_box(ui),
                std::hint::black_box(words),
                std::hint::black_box(framebuffer),
            );
        }
        samples.push(start.elapsed());
    }
    let elapsed = median(samples);
    println!(
        "render_bench samples={} iterations={} glyphs={} median_ms={:.3} median_us_per_render={:.3}",
        SAMPLES,
        ITERATIONS,
        glyph_count,
        elapsed.as_secs_f64() * 1_000.0,
        elapsed.as_secs_f64() * 1_000_000.0 / ITERATIONS as f64,
    );
}

fn main() {
    let paths: Vec<_> = env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("usage: glyph_span_stats <app.pak> [...]");
        process::exit(2);
    }
    for path in paths {
        let bytes = fs::read(&path).unwrap_or_else(|error| {
            eprintln!("{path}: {error}");
            process::exit(2);
        });
        let atlas_blobs: Vec<&[u8]> = pak::entries(&bytes)
            .filter(|entry| entry.key.starts_with("ui:font."))
            .map(|entry| entry.blob)
            .collect();
        let mut atlas_count = 0usize;
        let mut allocation_count = 0usize;
        let mut storage_bytes = 0usize;
        println!(
            "pak={path} ui_struct_bytes={} atlas_struct_bytes={} option_atlas_bytes={} pointer_bytes={} inline_bytes_per_slot={} inline_bytes_per_registry={}",
            core::mem::size_of::<Ui>(),
            core::mem::size_of::<Atlas>(),
            core::mem::size_of::<Option<Atlas>>(),
            core::mem::size_of::<usize>(),
            text::glyph_span_inline_bytes_per_slot(),
            text::glyph_span_inline_bytes_per_slot() * spec::MAX_FONT_SLOTS,
        );
        for entry in pak::entries(&bytes).filter(|entry| entry.key.starts_with("ui:font.")) {
            let atlas = Atlas::parse(entry.blob).unwrap_or_else(|| {
                eprintln!("{}: invalid atlas", entry.key);
                process::exit(2);
            });
            let bytes = atlas.glyph_span_storage_bytes();
            let allocations = atlas.glyph_span_allocation_count();
            atlas_count += 1;
            allocation_count += allocations;
            storage_bytes += bytes;
            println!(
                "slot={} glyphs={} coverage={}x{} spans={} bytes={} allocations={}",
                atlas.slot,
                atlas.glyph_count,
                atlas.coverage_width(),
                atlas.coverage_height(),
                atlas.glyph_span_count(),
                bytes,
                allocations,
            );
        }
        println!(
            "total atlases={} bytes={} parse_allocations={} render_allocations=0",
            atlas_count, storage_bytes, allocation_count
        );

        let mut ui = Ui::new();
        let (_, parse) = measure(|| {
            for entry in pak::entries(&bytes).filter(|entry| entry.key.starts_with("ui:font.")) {
                assert!(ui.load_font_atlas(entry.blob));
            }
        });
        ui.set_viewport(480.0, 272.0);
        let mut words = Vec::new();
        let mut x = 0i16;
        for entry in pak::entries(&bytes).filter(|entry| entry.key.starts_with("ui:font.")) {
            let slot = entry.blob[12];
            words.extend_from_slice(&[
                spec::draw_op::GLYPH_RUN,
                (1u32 << 16) | slot as u32,
                0xffff_ffff,
                xy_word(x, 0),
                0,
            ]);
            x += 40;
        }
        let mut framebuffer = vec![0u8; 480 * 272 * 4];
        let (_, render) = measure(|| {
            for _ in 0..180 {
                raster::render(&ui, &words, &mut framebuffer);
            }
        });
        println!(
            "measured parse_allocations={} parse_deallocations={} parse_resident_bytes={} parse_peak_bytes={} render_frames=180 render_allocations={} render_deallocations={} render_resident_bytes={} render_peak_bytes={}",
            parse.allocations,
            parse.deallocations,
            parse.resident_bytes,
            parse.peak_bytes,
            render.allocations,
            render.deallocations,
            render.resident_bytes,
            render.peak_bytes,
        );
        parse_benchmark(&atlas_blobs);

        let mut benchmark_words = Vec::new();
        let mut benchmark_glyph_count = 0usize;
        for blob in &atlas_blobs {
            let atlas = Atlas::parse(blob).unwrap();
            benchmark_glyph_count += atlas.glyph_count as usize;
            benchmark_words.extend_from_slice(&[
                spec::draw_op::GLYPH_RUN,
                (atlas.glyph_count as u32) << 16 | atlas.slot as u32,
                0xffff_ffff,
            ]);
            for gid in 0..atlas.glyph_count {
                let index = gid as i16;
                benchmark_words.push(xy_word((index % 12) * 38, (index / 12) * 30));
                benchmark_words.push(gid as u32);
            }
        }
        render_benchmark(
            &ui,
            &benchmark_words,
            benchmark_glyph_count,
            &mut framebuffer,
        );
    }
}
