//! Copies the compiled app module named by POCKET_MICRO_APP_RS into OUT_DIR
//! so main.rs can `include!` it; the harness itself is app-agnostic.
use std::{env, fs, path::Path};

fn main() {
    println!("cargo:rerun-if-env-changed=POCKET_MICRO_APP_RS");
    let src =
        env::var("POCKET_MICRO_APP_RS").expect("POCKET_MICRO_APP_RS: path to a generated app.rs");
    println!("cargo:rerun-if-changed={src}");
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("app.rs");
    fs::copy(&src, &out).unwrap_or_else(|e| panic!("copy {src}: {e}"));
}
