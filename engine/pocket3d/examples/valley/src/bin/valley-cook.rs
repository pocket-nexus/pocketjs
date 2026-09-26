//! Cook the River Valley scene to a `.p3sn`, and optionally render reference
//! stills of it with the CPU rasterizer.
//!
//! ```sh
//! cargo run -p pocket3d-valley --bin valley-cook -- --out dist/valley.p3sn
//! cargo run --release -p pocket3d-valley --bin valley-cook -- \
//!     --out dist/valley.p3sn --preview out/ --frames 0,0.35,0.7
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use pocket3d_valley::scene::{ValleyOptions, build};

fn main() -> ExitCode {
    let mut options = ValleyOptions::default();
    let mut out: Option<PathBuf> = None;
    let mut preview: Option<PathBuf> = None;
    let mut frames = vec![0.0f32];
    let mut width = 960u32;
    let mut height = 544u32;

    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        let mut value = || args.next().unwrap_or_default();
        match argument.as_str() {
            "--out" | "-o" => out = Some(PathBuf::from(value())),
            "--preview" => preview = Some(PathBuf::from(value())),
            "--seed" => options.seed = value().parse().unwrap_or(options.seed),
            "--texture-size" => {
                options.texture_size = value().parse().unwrap_or(options.texture_size)
            }
            "--near-spacing" => {
                options.near_tree_spacing = value().parse().unwrap_or(options.near_tree_spacing)
            }
            "--mid-spacing" => {
                options.mid_tree_spacing = value().parse().unwrap_or(options.mid_tree_spacing)
            }
            "--frames" => {
                frames = value()
                    .split(',')
                    .filter_map(|part| part.trim().parse().ok())
                    .collect();
            }
            "--size" => {
                let text = value();
                if let Some((w, h)) = text.split_once('x') {
                    width = w.parse().unwrap_or(width);
                    height = h.parse().unwrap_or(height);
                }
            }
            "--help" | "-h" => {
                println!(
                    "valley-cook [--out FILE] [--preview DIR] [--frames a,b,c] \
                     [--size WxH] [--seed N] [--texture-size N] \
                     [--near-spacing M] [--mid-spacing M]"
                );
                return ExitCode::SUCCESS;
            }
            other => {
                eprintln!("valley-cook: unknown argument {other}");
                return ExitCode::FAILURE;
            }
        }
    }

    let started = std::time::Instant::now();
    let (bytes, report) = match build(&options) {
        Ok(result) => result,
        Err(error) => {
            eprintln!("valley-cook: {}", error.0);
            return ExitCode::FAILURE;
        }
    };
    let elapsed = started.elapsed();

    println!(
        "cooked in {:.2}s: {} chunks, {} triangles, {} vertices, {} materials, \
         {} textures ({:.2} MB), {} near trees, {} billboards, {:.2} MB total",
        elapsed.as_secs_f32(),
        report.chunks,
        report.triangles,
        report.vertices,
        report.materials,
        report.textures,
        report.texture_bytes as f32 / (1024.0 * 1024.0),
        report.near_trees,
        report.billboards,
        report.bytes as f32 / (1024.0 * 1024.0),
    );

    if let Some(path) = &out {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(error) = std::fs::write(path, &bytes) {
            eprintln!("valley-cook: cannot write {}: {error}", path.display());
            return ExitCode::FAILURE;
        }
        println!("wrote {}", path.display());
    }

    if let Some(directory) = &preview {
        if let Err(error) = std::fs::create_dir_all(directory) {
            eprintln!("valley-cook: cannot create {}: {error}", directory.display());
            return ExitCode::FAILURE;
        }
        let scene = match pocket3d_scene::format::Scene::parse(&bytes) {
            Ok(scene) => scene,
            Err(error) => {
                eprintln!("valley-cook: cooked scene does not parse: {error:?}");
                return ExitCode::FAILURE;
            }
        };
        for (index, time) in frames.iter().enumerate() {
            let image = pocket3d_valley::preview::render(&scene, &options, *time, width, height);
            let path = directory.join(format!("frame-{index:02}.png"));
            if let Err(error) = pocket3d_valley::preview::write_png(&path, &image, width, height) {
                eprintln!("valley-cook: cannot write {}: {error}", path.display());
                return ExitCode::FAILURE;
            }
            println!("wrote {}", path.display());
        }
    }

    ExitCode::SUCCESS
}
