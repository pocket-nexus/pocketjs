//! Links a small C shim (src/compat.c) providing the C23 math symbols
//! (`fmaximum_numf`, `fminimum_numf`, …) that LLVM 19+ lowers `f32::max/min`
//! to but that PocketBook's glibc 2.23 predates. Compiled for the target via
//! the `cc` crate, which cargo-zigbuild routes through zig for the cross-build.
//!
//! Gated to the exact PocketBook target: native builds use the system libm
//! (which already provides these symbols), so compiling the shim there would
//! risk a duplicate-symbol clash.
//!
//! Also places the profile `pocket build` exported for this host in OUT_DIR.
//! A plain workspace build receives a stub, and the host reports the missing
//! profile at startup.

fn main() {
    pocket_profile_build::emit(pocket_profile_build::Export::Optional);
    println!("cargo:rerun-if-changed=src/compat.c");
    let target = std::env::var("TARGET").unwrap_or_default();
    if target == "armv7-unknown-linux-gnueabi" {
        cc::Build::new()
            .file("src/compat.c")
            .compile("pocketbook_compat");
    }
}
