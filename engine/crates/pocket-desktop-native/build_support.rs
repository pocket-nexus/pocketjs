// SPDX-License-Identifier: MIT
// Shared by the desktop host and a native application's build.rs.
// A Rust GPU borrow requires identical dependency versions and features.
pub fn emit_gpu_graph() {
    use sha2::{Digest, Sha256};
    use std::{
        collections::{BTreeMap, BTreeSet},
        env,
        process::Command,
    };
    let manifest =
        std::path::PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("Cargo.toml");
    let output = Command::new(env::var("CARGO").unwrap())
        .args([
            "metadata",
            "--format-version=1",
            "--locked",
            "--offline",
            "--filter-platform",
        ])
        .arg(env::var("TARGET").unwrap())
        .arg("--manifest-path")
        .arg(&manifest)
        .output()
        .expect("cargo metadata");
    assert!(
        output.status.success(),
        "native GPU graph: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let packages: BTreeMap<&str, &serde_json::Value> = data["packages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["id"].as_str().unwrap(), p))
        .collect();
    let nodes: BTreeMap<&str, &serde_json::Value> = data["resolve"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| (n["id"].as_str().unwrap(), n))
        .collect();
    let roots: Vec<_> = packages
        .iter()
        .filter(|(_, p)| p["name"] == "wgpu")
        .map(|(id, _)| *id)
        .collect();
    assert_eq!(roots.len(), 1, "native apps require one wgpu version");
    let mut todo = roots;
    let mut seen = BTreeSet::new();
    let mut graph = BTreeMap::new();
    while let Some(id) = todo.pop() {
        if !seen.insert(id) {
            continue;
        }
        let p = packages[id];
        let n = nodes[id];
        assert!(
            p["source"]
                .as_str()
                .is_some_and(|s| s.starts_with("registry+")),
            "native GPU dependencies must use locked registry sources"
        );
        graph.insert(id, &n["features"]);
        todo.extend(
            n["dependencies"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| d.as_str().unwrap()),
        );
    }
    let lock = std::path::Path::new(data["workspace_root"].as_str().unwrap()).join("Cargo.lock");
    println!("cargo:rerun-if-changed={}", lock.display());
    // Track manifests too: enabling a dependency feature can leave the lock unchanged.
    for p in packages.values() {
        if p["source"].is_null() {
            println!(
                "cargo:rerun-if-changed={}",
                p["manifest_path"].as_str().unwrap()
            );
        }
    }
    println!(
        "cargo:rustc-env=POCKET_NATIVE_GRAPH={:x}",
        Sha256::digest(serde_json::to_vec(&graph).unwrap())
    );
}
