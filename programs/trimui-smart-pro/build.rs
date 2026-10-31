//! Places the profile `pocket host export` wrote in OUT_DIR, and points the
//! linker at the GLES and EGL stubs tools/trimui-smart-pro.ts generates: the
//! real libraries are the firmware's, resolved on the device at load time.
use std::env;

fn main() {
    pocket_profile_build::emit(pocket_profile_build::Export::Optional);
    println!("cargo:rerun-if-env-changed=TRIMUI_LINK_STUBS");
    if let Ok(directory) = env::var("TRIMUI_LINK_STUBS") {
        println!("cargo:rustc-link-search=native={directory}");
    }
}
