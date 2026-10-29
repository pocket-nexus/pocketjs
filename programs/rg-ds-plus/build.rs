//! Places the profile `pocket build` exported for this program in OUT_DIR. A
//! Linux build links libmali (EGL, GLES and GBM); when cross-compiling,
//! POCKETJS_RG_DS_PLUS_GL_LIBS names a directory holding libmali.so, taken
//! from the device, for the linker.
fn main() {
    pocket_profile_build::emit(pocket_profile_build::Export::Required);
    println!("cargo:rerun-if-env-changed=POCKETJS_RG_DS_PLUS_GL_LIBS");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        if let Ok(dir) = std::env::var("POCKETJS_RG_DS_PLUS_GL_LIBS") {
            println!("cargo:rustc-link-search=native={dir}");
        }
    }
}
