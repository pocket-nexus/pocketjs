//! Links a small C shim (src/compat.c) providing the C23 math symbols
//! (`fmaximum_numf`, `fminimum_numf`, …) that LLVM 19+ lowers `f32::max/min`
//! to but that PocketBook's glibc 2.23 predates. Compiled for the target via
//! the `cc` crate, which cargo-zigbuild routes through zig for the cross-build.
//!
//! Gated to the exact PocketBook target: native builds use the system libm
//! (which already provides these symbols), so compiling the shim there would
//! risk a duplicate-symbol clash.

fn main() {
    println!("cargo:rerun-if-changed=src/compat.c");
    let target = std::env::var("TARGET").unwrap_or_default();
    if target == "armv7-unknown-linux-gnueabi" {
        cc::Build::new()
            .file("src/compat.c")
            .compile("pocketbook_compat");
    }
}
