#!/usr/bin/env python3
"""Verify a release source, vendor via Buildroot, emit an external tree + hashes."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tarfile
import tempfile


def digest(path):
    with open(path, "rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def prepare(index, buildroot, output):
    index, buildroot, output = map(lambda p: pathlib.Path(p).resolve(), (index, buildroot, output))
    release = json.loads(index.read_text())
    version, revision, asset = release["version"], release["revision"], release["source"]
    if release.get("schema") != "pocket-release/1" or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("invalid release identity")
    generation = release["hostAbi"]
    if type(generation) is not int or generation <= 0:
        raise ValueError("invalid binding generation")
    name = f"pocketjs-{version}"
    if asset["file"] != name + ".tar.gz" or asset["format"] != "tar.gz":
        raise ValueError("unexpected release source filename")
    source = index.parent / asset["file"]
    if source.stat().st_size != asset["bytes"] or digest(source) != asset["sha256"]:
        raise ValueError("release source digest/size mismatch")
    with tarfile.open(source) as archive:
        names = set()
        for member in archive:
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != name or not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError("unsafe release archive path")
            if member.issym():
                # Release source symlinks may not escape their source tree.
                destination = pathlib.PurePosixPath(member.linkname)
                if destination.is_absolute() or ".." in destination.parts:
                    raise ValueError("unsafe source symlink")
            names.add(member.name)
        for required in ["Cargo.lock", "Cargo.toml", "programs/linux-kms/Cargo.toml", "LICENSE"]:
            if f"{name}/{required}" not in names:
                raise ValueError("release source is missing " + required)
        license_hash = hashlib.sha256(archive.extractfile(f"{name}/LICENSE").read()).hexdigest()
    processor = buildroot / "support/download/cargo-post-process"
    if not processor.is_file():
        raise ValueError("Buildroot cargo post-processor not found")
    if output.exists():
        raise ValueError("output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pocket-buildroot-", dir=output.parent) as temp:
        temp = pathlib.Path(temp)
        staged = temp / "external"
        shutil.copytree(pathlib.Path(__file__).parent, staged, ignore=shutil.ignore_patterns("__pycache__", "source.mk", "sources"))
        (staged / "sources").mkdir()
        processed = staged / "sources" / (name + "-cargo.tar.gz")
        shutil.copyfile(source, processed)
        environment = dict(os.environ, TAR="tar")
        environment.setdefault("CARGO_HOME", str(pathlib.Path.home() / ".cargo"))
        subprocess.run(["bash", str(processor), "-n", name, "-o", str(processed), "-m", "programs/linux-kms/Cargo.toml"], cwd=temp, env=environment, check=True)
        with tarfile.open(processed) as archive:
            if not any(pathlib.PurePosixPath(member.name).parts[1:2] == ("VENDOR",) for member in archive):
                raise ValueError("Buildroot did not produce vendored sources")
        sha = digest(processed)
        (staged / "package/pocketjs/source.mk").write_text(f"# Source revision: {revision}\nPOCKETJS_VERSION = {version}\nPOCKETJS_BINDING_GENERATION = {generation}\nPOCKETJS_SOURCE = {processed.name}\nPOCKETJS_SITE = file://$(BR2_EXTERNAL_POCKETJS_PATH)/sources\n")
        (staged / "package/pocketjs/pocketjs.hash").write_text(f"# Verified upstream SHA256: {asset['sha256']}\n# Revision: {revision}\nsha256  {sha}  {processed.name}\nsha256  {license_hash}  LICENSE\n")
        provenance = {"format": "pocket-buildroot-source/1", "version": version, "revision": revision, "upstream": asset, "vendored": {"file": processed.name, "sha256": sha, "bytes": processed.stat().st_size}, "processorSha256": digest(processor), "cargo": subprocess.check_output(["cargo", "--version"], text=True).strip()}
        (staged / "source-receipt.json").write_text(json.dumps(provenance, indent=2) + "\n")
        staged.rename(output)
    return provenance


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release_index")
    parser.add_argument("buildroot")
    parser.add_argument("output")
    args = parser.parse_args()
    prepare(args.release_index, args.buildroot, args.output)
