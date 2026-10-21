#!/usr/bin/env python3
"""Check a trusted export before installing it; never read application metadata."""
import hashlib
import json
import pathlib
import sys


def validate(path, generation):
    data = json.loads(pathlib.Path(path).read_text())
    if data.get("format") != "pocket-profile/1" or data.get("hostAbi") != generation:
        raise ValueError("unsupported profile export/binding generation")
    canonical = data["canonicalProfileJson"]
    if data["profileHash"] != "sha256:" + hashlib.sha256(canonical.encode()).hexdigest():
        raise ValueError("profile export hash mismatch")
    value = json.loads(canonical)
    if value != data["profile"] or value["platform"] != "linux":
        raise ValueError("profile export must describe the Linux product")
    return data


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: validate_profile.py pocket-profile.json binding-generation")
    validate(sys.argv[1], int(sys.argv[2]))
