// SPDX-License-Identifier: MIT
use sha2::{Digest, Sha256};
use std::{env, fs, path::Path, process::Command};
fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut hash = Sha256::new();
    // GPU borrows are a co-built Rust ABI, not a cross-version Rust interface.
    // Compiler, platform, profile, SDK and engine lock must all match.
    for key in [
        "TARGET",
        "PROFILE",
        "CARGO_ENCODED_RUSTFLAGS",
        "OPT_LEVEL",
        "DEBUG",
        "CARGO_CFG_PANIC",
        "CARGO_CFG_TARGET_FEATURE",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
        hash.update(env::var(key).unwrap_or_default());
    }
    hash.update(
        Command::new(env::var("RUSTC").unwrap())
            .arg("-vV")
            .output()
            .unwrap()
            .stdout,
    );
    for relative in [
        "Cargo.lock",
        "crates/pocket-desktop-native/src/lib.rs",
        "crates/pocket-desktop-native/build_support.rs",
        "pocket3d/crates/pocket3d/src/gpu.rs",
        "crates/pocket-desktop-native/Cargo.toml",
    ] {
        let path = root.join(relative);
        println!("cargo:rerun-if-changed={}", path.display());
        hash.update(fs::read(&path).unwrap());
    }
    println!("cargo:rustc-env=POCKET_NATIVE_BUILD={:x}", hash.finalize());
}
