import hashlib
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest

BASE = pathlib.Path(__file__).parent

def module(name):
    spec = importlib.util.spec_from_file_location(name, BASE / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

prepare, profile = module("prepare"), module("validate_profile")

class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = pathlib.Path(self.temp.name)
        self.buildroot = self.path / "buildroot"
        processor = self.buildroot / "support/download/cargo-post-process"
        processor.parent.mkdir(parents=True)
        # Unit boundary for Buildroot's already-vendored early-return branch.
        # The native recipe smoke uses the actual Buildroot processor/macros.
        processor.write_text("#!/bin/sh\nexit 0\n")

    def archive(self, extra=None, vendor=True):
        name = "pocketjs-0.15.0"
        source = self.path / (name + ".tar.gz")
        files = {"Cargo.toml": b"[workspace]\n", "Cargo.lock": b"version = 4\n", "programs/linux-kms/Cargo.toml": b"[package]\n", "LICENSE": b"test license"}
        if vendor:
            files["VENDOR/test/Cargo.toml"] = b"test"
        if extra:
            files.update(extra)
        with tarfile.open(source, "w:gz") as archive:
            for file, data in files.items():
                info = tarfile.TarInfo(name + "/" + file)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        index = {"schema": "pocket-release/1", "version": "0.15.0", "revision": "a" * 40, "hostAbi": 12, "source": {"file": source.name, "format": "tar.gz", "sha256": prepare.digest(source), "bytes": source.stat().st_size}}
        path = self.path / "pocket-release.json"
        path.write_text(json.dumps(index))
        return path

    def test_paths_are_checked_before_postprocessing(self):
        index = self.archive({"../escape": b"bad"})
        with self.assertRaisesRegex(ValueError, "unsafe"):
            prepare.prepare(index, self.buildroot, self.path / "external")

    def test_missing_vendor_closure_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "vendored"):
            prepare.prepare(self.archive(vendor=False), self.buildroot, self.path / "external")
        self.assertFalse((self.path / "external").exists())

    def test_profile_is_independent_of_application_and_bound_to_generation(self):
        value = {"format": "pocket-host/2", "hostAbi": 12, "id": "board", "platform": "linux", "form": "embedded",
                 "cadences": [30, 60], "display": {"logicalViewports": [[8, 6]], "presentations": ["native"], "rasterDensity": 1, "animation": "repaint"},
                 "panel": {"primary": [8, 6]}, "capabilities": ["text.glyphs.baked", "input.buttons"]}
        canonical = '{"cadences":[30,60],"capabilities":["input.buttons","text.glyphs.baked"],"display":{"animation":"repaint","logicalViewports":[[8,6]],"presentations":["native"],"rasterDensity":1},"form":"embedded","id":"board","platform":"linux"}'
        digest = hashlib.sha256(canonical.encode()).digest()
        self.assertEqual(profile.profile_hash(value), digest.hex())
        path = self.path / "pocket.host.json"
        path.write_text(json.dumps(value))
        module = self.path / "pocket_profile.rs"
        def write_module(generation, hash_bytes):
            module.write_text(f"pub const HOST_ABI: u32 = {generation};\npub const PROFILE_HASH: [u8; 32] = [{', '.join(map(str, hash_bytes))}];\n")
        with self.assertRaisesRegex(ValueError, "missing pocket_profile.rs"):
            profile.validate(path, 12)
        write_module(12, digest)
        profile.validate(path, 12)
        with self.assertRaises(ValueError):
            profile.validate(path, 11)
        # The compiled-in module must be the document's export, not another one.
        write_module(11, digest)
        with self.assertRaisesRegex(ValueError, "binding generation"):
            profile.validate(path, 12)
        write_module(12, bytes(32))
        with self.assertRaisesRegex(ValueError, "does not match pocket.host.json"):
            profile.validate(path, 12)

if __name__ == "__main__":
    unittest.main()
