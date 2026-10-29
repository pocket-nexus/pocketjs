#!/usr/bin/env python3
"""Check a trusted export before compiling it in; never read application metadata."""
import hashlib
import json
import pathlib
import re
import sys

# contracts/spec/profile.ts PROFILE_HASH_FIELDS; capability lists and
# cadences are sets, sorted before hashing.
HASH_FIELDS = ("id", "platform", "form", "cadences", "display", "capabilities", "roleCapabilities")


def projection(document):
    value = {field: document[field] for field in HASH_FIELDS if field in document}
    value["cadences"] = sorted(value["cadences"])
    value["capabilities"] = sorted(value["capabilities"])
    roles = value.get("roleCapabilities")
    if isinstance(roles, dict) and "systemUI" in roles:
        value["roleCapabilities"] = {"systemUI": sorted(roles["systemUI"])}
    return value


def profile_hash(document):
    """SHA-256 of canonical JSON: sorted keys, no spaces, integers as written."""
    canonical = json.dumps(projection(document), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def validate(path, generation):
    path = pathlib.Path(path)
    data = json.loads(path.read_text())
    if data.get("format") != "pocket-profile/2" or data.get("hostAbi") != generation:
        raise ValueError("unsupported profile export/binding generation")
    if data.get("platform") != "linux":
        raise ValueError("profile export must describe the Linux product")
    digest = profile_hash(data)
    # The program compiles the sibling module in; it must carry the same
    # identity as the document this check read.
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
