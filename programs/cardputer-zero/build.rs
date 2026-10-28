//! Places the profile `pocket build` exported for this program in OUT_DIR, and
//! compiles engine/worker's C runtime against the QuickJS-NG source Cargo
//! resolved for rquickjs, so the worker realm and the UI realm link one engine.
use std::{env, path::PathBuf, process::Command};

fn main() {
    pocket_profile_build::emit(pocket_profile_build::Export::Required);
    let root =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR")).join("../..");
    let worker = root.join("engine/worker");
    println!("cargo:rerun-if-changed={}", worker.join("src").display());
    println!(
        "cargo:rerun-if-changed={}",
        worker.join("include").display()
    );
    let mut build = cc::Build::new();
    build
        .include(worker.join("include"))
        .include(quickjs(&root))
        .define("_GNU_SOURCE", None)
        .flag_if_supported("-std=c11");
    for name in ["worker.c", "quickjs.c", "quickjs_ui.c", "runner.c"] {
        build.file(worker.join("src").join(name));
    }
    build.compile("pocket_worker");
}

/// The `quickjs/` directory of the rquickjs-sys package in the workspace lock
/// (tools/test-quickjs-guest.ts finds it the same way).
fn quickjs(root: &std::path::Path) -> PathBuf {
    let target = env::var("TARGET").expect("TARGET");
    let output = Command::new(env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .args([
            "metadata",
            "--locked",
            "--format-version=1",
            "--filter-platform",
            &target,
        ])
        .arg("--manifest-path")
        .arg(root.join("Cargo.toml"))
        .output()
        .expect("run cargo metadata");
    assert!(
        output.status.success(),
        "cargo metadata: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("cargo metadata is JSON");
    let manifest = metadata["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|package| package["name"] == "rquickjs-sys")
        .and_then(|package| package["manifest_path"].as_str())
        .expect("cargo metadata has no rquickjs-sys package");
    PathBuf::from(manifest)
        .parent()
        .expect("rquickjs-sys manifest directory")
        .join("quickjs")
}
