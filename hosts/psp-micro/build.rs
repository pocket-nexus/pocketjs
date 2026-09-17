//! Bakes the compiled app into the EBOOT: the generated Rust module
//! (POCKET_MICRO_APP_RS) is copied into OUT_DIR for `include!`, the app pack
//! (POCKET_MICRO_PAK) for `include_bytes!`, and the build identity, optional
//! input tape and receipt frame become compile-time env values.

use std::{env, fs, path::Path};

fn main() {
    let out = env::var("OUT_DIR").unwrap();
    let out = Path::new(&out);
    for var in [
        "POCKET_MICRO_APP_RS",
        "POCKET_MICRO_PAK",
        "POCKET_MICRO_APP",
        "POCKET_MICRO_TITLE",
        "POCKET_MICRO_BUILD",
        "POCKET_MICRO_TAPE",
        "POCKET_MICRO_RECEIPT_FRAME",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
    }
    let app_rs = env::var("POCKET_MICRO_APP_RS").expect("POCKET_MICRO_APP_RS: path to the generated app.rs (bun micro/compiler/cli.ts build <app> --psp)");
    let pak = env::var("POCKET_MICRO_PAK").expect("POCKET_MICRO_PAK: path to the app pack");
    println!("cargo:rerun-if-changed={app_rs}");
    println!("cargo:rerun-if-changed={pak}");
    fs::copy(&app_rs, out.join("app.rs")).unwrap_or_else(|e| panic!("copy {app_rs}: {e}"));
    fs::copy(&pak, out.join("app.pak")).unwrap_or_else(|e| panic!("copy {pak}: {e}"));
    let receipt = env::var("POCKET_MICRO_RECEIPT_FRAME")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "240".into());
    receipt
        .parse::<u32>()
        .expect("POCKET_MICRO_RECEIPT_FRAME must be an integer frame index");
    println!(
        "cargo:rustc-env=POCKET_MICRO_APP={}",
        env::var("POCKET_MICRO_APP").unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=POCKET_MICRO_TITLE={}",
        env::var("POCKET_MICRO_TITLE").unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=POCKET_MICRO_BUILD={}",
        env::var("POCKET_MICRO_BUILD").unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=POCKET_MICRO_TAPE={}",
        env::var("POCKET_MICRO_TAPE").unwrap_or_default()
    );
    println!("cargo:rustc-env=POCKET_MICRO_RECEIPT_FRAME={receipt}");
}
