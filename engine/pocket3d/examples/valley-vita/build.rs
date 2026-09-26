//! Cook the scene at build time and hand the bytes to `include_bytes!`.
//!
//! The generator runs on the host, so the checkout carries no binary blob and
//! the VPK carries no side files: a build is reproducible from its seed alone.

use std::path::PathBuf;

use pocket3d_valley::scene::{ValleyOptions, build};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=VALLEY_SEED");
    println!("cargo:rerun-if-env-changed=VALLEY_TEXTURE_SIZE");

    let mut options = ValleyOptions::default();
    if let Ok(seed) = std::env::var("VALLEY_SEED") {
        if let Ok(seed) = seed.parse() {
            options.seed = seed;
        }
    }
    if let Ok(size) = std::env::var("VALLEY_TEXTURE_SIZE") {
        if let Ok(size) = size.parse() {
            options.texture_size = size;
        }
    }

    let (bytes, report) = build(&options).expect("cooking the valley");
    println!(
        "cargo:warning=valley: {} chunks, {} triangles, {} textures, {:.2} MB",
        report.chunks,
        report.triangles,
        report.textures,
        report.bytes as f32 / (1024.0 * 1024.0)
    );

    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("valley.p3sn");
    std::fs::write(&out, &bytes).expect("writing the cooked scene");
}
