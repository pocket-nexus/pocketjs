"""Print Cargo dependency roots for the selected program; no crate-name allowlist."""
import argparse
import json
import pathlib
import subprocess

p = argparse.ArgumentParser()
p.add_argument("--cargo", required=True)
p.add_argument("--manifest", required=True)
p.add_argument("--target", required=True)
a = p.parse_args()
manifest = pathlib.Path(a.manifest).resolve()
metadata = json.loads(subprocess.check_output([
    a.cargo, "metadata", "--locked", "--no-default-features", "--format-version", "1",
    "--filter-platform", a.target, "--manifest-path", str(manifest),
], cwd=manifest.parent, text=True))
packages = {v["id"]: v for v in metadata["packages"]}
start = next(v["id"] for v in packages.values() if pathlib.Path(v["manifest_path"]).resolve() == manifest)
nodes = {v["id"]: v for v in metadata["resolve"]["nodes"]}
seen = set()

def visit(package):
    if package in seen:
        return
    seen.add(package)
    for dep in nodes[package]["deps"]:
        if any(kind["kind"] != "dev" for kind in dep["dep_kinds"]):
            visit(dep["pkg"])

visit(start)
print(metadata["workspace_root"] + "/Cargo.toml")
print(metadata["workspace_root"] + "/Cargo.lock")
for package in sorted(seen):
    directory = pathlib.Path(packages[package]["manifest_path"]).parent
    # Watch files under every source directory, excluding build outputs before
    # glob expansion. Cargo.toml changes cause CMake to resolve the graph again.
    for child in sorted(directory.iterdir()):
        if child.name in {"target", ".git", ".pocket-build", "dist", "node_modules"} or child.name.startswith("target-"):
            continue
        print(str(child / "*") if child.is_dir() else str(child))
