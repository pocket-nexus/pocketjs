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

    def test_prepared_archive_records_upstream_and_vendor_hashes(self):
        index = self.archive()
        result = prepare.prepare(index, self.buildroot, self.path / "external")
        self.assertEqual(result["upstream"]["sha256"], result["vendored"]["sha256"])
        external = self.path / "external"
        self.assertIn(result["vendored"]["sha256"], (external / "package/pocketjs/pocketjs.hash").read_text())
        self.assertIn("POCKETJS_BINDING_GENERATION = 12", (external / "package/pocketjs/source.mk").read_text())
        self.assertTrue((external / "package/pocketjs-app/pocketjs-app.mk").is_file())

    def test_digest_and_paths_are_checked_before_postprocessing(self):
        index = self.archive()
        source = self.path / "pocketjs-0.15.0.tar.gz"
        source.write_bytes(source.read_bytes() + b"corrupt")
        with self.assertRaisesRegex(ValueError, "digest/size"):
            prepare.prepare(index, self.buildroot, self.path / "external")
        index = self.archive({"../escape": b"bad"})
        with self.assertRaisesRegex(ValueError, "unsafe"):
            prepare.prepare(index, self.buildroot, self.path / "external")

    def test_missing_vendor_closure_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "vendored"):
            prepare.prepare(self.archive(vendor=False), self.buildroot, self.path / "external")
        self.assertFalse((self.path / "external").exists())

    def test_profile_is_independent_of_application_and_bound_to_generation(self):
        canonical = '{"platform":"linux"}'
        value = {"format": "pocket-profile/1", "hostAbi": 12, "canonicalProfileJson": canonical, "profile": {"platform": "linux"}, "profileHash": "sha256:" + hashlib.sha256(canonical.encode()).hexdigest()}
        path = self.path / "profile.json"
        path.write_text(json.dumps(value))
        profile.validate(path, 12)
        with self.assertRaises(ValueError):
            profile.validate(path, 11)
        value["canonicalProfileJson"] += "\n"
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "hash"):
            profile.validate(path, 12)

if __name__ == "__main__":
    unittest.main()
