use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=POCKETJS_NDS_GENERATED_DIR");
    println!("cargo:rerun-if-env-changed=POCKETJS_NDS_ASSETS");
    let generated = PathBuf::from(
        env::var("POCKETJS_NDS_GENERATED_DIR")
            .expect("build Hero with tools/build-nds.ts: POCKETJS_NDS_GENERATED_DIR is required"),
    );
    let assets = PathBuf::from(
        env::var("POCKETJS_NDS_ASSETS")
            .expect("build Hero with tools/build-nds.ts: POCKETJS_NDS_ASSETS is required"),
    );
    let generated = generated
        .canonicalize()
        .expect("generated MicroTS directory");
    let assets = assets.canonicalize().expect("baked NDS asset pack");
    println!("cargo:rerun-if-changed={}", generated.display());
    println!("cargo:rerun-if-changed={}", assets.display());
    // A shared app.tsx child can make the root's generated name App2. Keep the
    // host's ABI aliases tied to the selected root instead of a basename.
    let root = fs::read_to_string(generated.join("root-name.txt"))
        .expect("build Hero with tools/build-nds.ts: generated root name is required");
    let root = root.trim();
    assert!(
        !root.is_empty()
            && root
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            && !root.as_bytes()[0].is_ascii_digit(),
        "generated root must be a Rust identifier"
    );
    let bridge = format!(
        "#[path = {module:?}]\nmod compiled;\nmod generated {{\n    pub use super::compiled::{{{root}App as AppApp, {root}Props as AppProps, {root}Model as AppModel}};\n}}\nconst STYLES: &[u8] = include_bytes!({styles:?});\nconst ASSETS: &[u8] = include_bytes!({assets:?});\n",
        module = generated.join("mod.rs"), styles = generated.join("styles.bin"), assets = assets,
    );
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("guest.rs"),
        bridge,
    )
    .unwrap();
}
