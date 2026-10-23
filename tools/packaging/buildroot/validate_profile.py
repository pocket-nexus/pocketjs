#!/usr/bin/env python3
"""Check a trusted export before compiling it in; never read application metadata."""
import hashlib
import json
import pathlib
import re
import sys


def validate(path, generation):
    path = pathlib.Path(path)
    data = json.loads(path.read_text())
    if data.get("format") != "pocket-profile/1" or data.get("hostAbi") != generation:
        raise ValueError("unsupported profile export/binding generation")
    canonical = data["canonicalProfileJson"]
    digest = hashlib.sha256(canonical.encode()).hexdigest()
    if data["profileHash"] != "sha256:" + digest:
        raise ValueError("profile export hash mismatch")
    value = json.loads(canonical)
    if value != data["profile"] or value["platform"] != "linux":
        raise ValueError("profile export must describe the Linux product")
    # The program compiles the sibling module in; it must carry the same
    # identity as the sidecar this check read.
    module = path.with_name("pocket_profile.rs")
    if not module.is_file():
        raise ValueError("profile export is missing pocket_profile.rs")
    text = module.read_text()
    found = re.search(r"pub const PROFILE_HASH: \[u8; 32\] = \[([^\]]*)\];", text)
    if f"pub const HOST_ABI: u32 = {generation};" not in text or not found:
        raise ValueError("pocket_profile.rs does not match the binding generation")
    if bytes(int(byte) for byte in found.group(1).split(",")).hex() != digest:
        raise ValueError("pocket_profile.rs does not match pocket-profile.json")
    return data


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: validate_profile.py pocket-profile.json binding-generation")
    validate(sys.argv[1], int(sys.argv[2]))
