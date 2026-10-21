#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
from pathlib import Path
import package_format as fmt

MAGIC = fmt.POCKET_MAGIC
VERSION = fmt.POCKET_VERSION
NAME = re.compile(r"^[a-z][a-z0-9_]*$")
HOST_INPUTS_MAGIC = fmt.HOST_INPUTS_MAGIC
HOST_INPUTS_VERSION = fmt.HOST_INPUTS_VERSION
HOST_INPUTS_SIZE = fmt.HOST_INPUTS_SIZE


def fnv1a64(data: bytes) -> int:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def validate(data: bytes) -> None:
    if len(data) < 24:
        raise ValueError("package is truncated")
    magic, version = struct.unpack_from("<II", data, 0)
    if magic != MAGIC:
        raise ValueError("bad .pocket magic")
    if version != VERSION:
        raise ValueError(f"unsupported .pocket version {version}")
    expected = struct.unpack_from("<Q", data, len(data) - 8)[0]
    if fnv1a64(data[:-8]) != expected:
        raise ValueError(".pocket footer hash mismatch")
    end = len(data) - fmt.POCKET_FOOTER_SIZE
    manifest, count = struct.unpack_from("<II", data, fmt.OFFSET_HEADER_MANIFEST_SIZE)
    table = (fmt.POCKET_HEADER_SIZE + manifest + fmt.POCKET_ALIGN - 1) & ~(fmt.POCKET_ALIGN - 1)
    if fmt.POCKET_HEADER_SIZE + manifest > end or table + count * fmt.POCKET_VARIANT_SIZE > end:
        raise ValueError("manifest or variant table is truncated")
    for index in range(count):
        entry = table + index * fmt.POCKET_VARIANT_SIZE
        target = data[entry:entry + fmt.POCKET_TARGET_BYTES]
        if target.find(b"\0") <= 0:
            raise ValueError("variant target is not NUL terminated")
        sections, offset = struct.unpack_from("<II", data, entry + fmt.OFFSET_VARIANT_SECTION_COUNT)
        if offset + sections * fmt.POCKET_SECTION_SIZE > end:
            raise ValueError("section table is truncated")
        for section in range(sections):
            at = offset + section * fmt.POCKET_SECTION_SIZE
            start, size = struct.unpack_from("<II", data, at + fmt.OFFSET_SECTION_OFFSET)
            if start + size > end:
                raise ValueError("section payload is truncated")


def host_contract(data: bytes) -> tuple[str, tuple[int, ...], bytes]:
    manifest_size, variant_count = struct.unpack_from("<II", data, 8)
    table = (fmt.POCKET_HEADER_SIZE + manifest_size + fmt.POCKET_ALIGN - 1) & ~(fmt.POCKET_ALIGN - 1)
    matches: list[tuple[str, tuple[int, ...], bytes]] = []
    for index in range(variant_count):
        entry = table + index * fmt.POCKET_VARIANT_SIZE
        if entry + fmt.POCKET_VARIANT_SIZE > len(data) - 8:
            raise ValueError("variant table is truncated")
        raw_target = data[entry : entry + fmt.OFFSET_VARIANT_HOST_ABI]
        end = raw_target.find(b"\0")
        if end <= 0:
            raise ValueError("variant target is not NUL terminated")
        target = raw_target[:end].decode("utf-8")
        variant_abi, section_count, sections = struct.unpack_from("<III", data, entry + fmt.OFFSET_VARIANT_HOST_ABI)
        for section_index in range(section_count):
            section = sections + section_index * fmt.POCKET_SECTION_SIZE
            if section + fmt.POCKET_SECTION_SIZE > len(data) - 8:
                raise ValueError("section table is truncated")
            kind, _, offset, size = struct.unpack_from("<IIII", data, section)
            if kind != fmt.SECTION_HOST_INPUTS:
                continue
            if size != HOST_INPUTS_SIZE or offset + size > len(data) - 8:
                raise ValueError("hostInputs section is malformed")
            payload = data[offset : offset + size]
            fields = struct.unpack_from("<10I", payload, 0)
            if fields[0] != HOST_INPUTS_MAGIC or fields[1] != HOST_INPUTS_VERSION:
                raise ValueError("hostInputs header is unsupported")
            if fields[2] != variant_abi:
                raise ValueError("hostInputs ABI differs from its variant")
            matches.append((target, fields, payload[fmt.OFFSET_HOST_INPUTS_PROFILE_HASH:fmt.OFFSET_HOST_INPUTS_PLAN_HASH]))
    if len(matches) != 1:
        raise ValueError("embedded ESP-IDF package must contain exactly one hostInputs variant")
    return matches[0]


def escaped(path: Path) -> str:
    return str(path.resolve()).replace("\\", "\\\\").replace('"', '\\"')


def validate_profile(
    profile_path: Path,
    target: str,
    fields: tuple[int, ...],
    profile_hash: bytes,
) -> None:
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    canonical = json.dumps(profile, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    if hashlib.sha256(canonical.encode("utf-8")).digest() != profile_hash:
        raise ValueError("package host profile hash does not match HOST_PROFILE")
    display = profile.get("display", {})
    presentations = fmt.HOST_PRESENTATIONS
    if (
        profile.get("id") != target
        or profile.get("platform") != "esp-idf"
        or profile.get("tickHz") != fields[3]
        or [fields[4], fields[5]] not in display.get("logicalViewports", [])
        or display.get("physicalViewport") != [fields[6], fields[7]]
        or display.get("rasterDensity") != fields[8]
        or fields[9] >= len(presentations)
        or presentations[fields[9]] not in display.get("presentations", [])
    ):
        raise ValueError("package host inputs are not admitted by HOST_PROFILE")


def generate(package: Path, profile: Path, name: str, output_dir: Path) -> None:
    if not NAME.fullmatch(name):
        raise ValueError("NAME must match [a-z][a-z0-9_]*")
    package = package.resolve()
    data = package.read_bytes()
    validate(data)
    target, host_fields, profile_hash = host_contract(data)
    validate_profile(profile.resolve(), target, host_fields, profile_hash)
    output_dir.mkdir(parents=True, exist_ok=True)
    symbol = f"pocketjs_package_{name}"
    full_profile = json.loads(profile.read_text(encoding="utf-8"))
    projection = {key: full_profile[key] for key in fmt.PROFILE_HASH_FIELDS if key in full_profile}
    runtime_json = json.dumps(projection, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    runtime_hash = hashlib.sha256(runtime_json).digest()
    (output_dir / f"{symbol}.h").write_text(
        "#pragma once\n\n"
        '#include "pocket/package.h"\n\n'
        "#ifdef __cplusplus\nextern \"C\" {\n#endif\n\n"
        f"extern const pocketjs_embedded_package_t {symbol};\n"
        f"extern const uint8_t {symbol}_profile_json[];\n"
        f"extern const uint8_t {symbol}_runtime_profile_hash[32];\n"
        f"extern const size_t {symbol}_profile_json_length;\n"
        f"extern const pocketjs_package_host_contract_t {symbol}_contract;\n\n"
        "#ifdef __cplusplus\n}\n#endif\n",
        encoding="utf-8",
    )
    (output_dir / f"{symbol}.c").write_text(
        f'#include "{symbol}.h"\n\n'
        f"const uint8_t {symbol}_profile_json[] = {{"
        + ",".join(str(b) for b in runtime_json)
        + "};\n"
        + f"const uint8_t {symbol}_runtime_profile_hash[32] = {{" + ",".join(str(b) for b in runtime_hash) + "};\n"
        + f"const size_t {symbol}_profile_json_length = sizeof({symbol}_profile_json);\n"
        +
        f"extern const uint8_t {symbol}_start[];\n\n"
        f"const pocketjs_embedded_package_t {symbol} = {{\n"
        f"    .data = {symbol}_start,\n"
        f"    .size = {len(data)}U,\n"
        "};\n\n"
        f"const pocketjs_package_host_contract_t {symbol}_contract = {{\n"
        f"    .struct_size = sizeof({symbol}_contract),\n"
        f'    .target_id = "{target}",\n'
        f"    .host_abi = {host_fields[2]}U,\n"
        f"    .tick_hz = {host_fields[3]}U,\n"
        f"    .logical_width = {host_fields[4]}U,\n"
        f"    .logical_height = {host_fields[5]}U,\n"
        f"    .physical_width = {host_fields[6]}U,\n"
        f"    .physical_height = {host_fields[7]}U,\n"
        f"    .raster_density = {host_fields[8]}U,\n"
        f"    .presentation = (pocketjs_presentation_t){host_fields[9]}U,\n"
        "    .profile_hash = { "
        + ", ".join(f"0x{byte:02x}" for byte in profile_hash)
        + " },\n"
        "};\n",
        encoding="utf-8",
    )
    (output_dir / f"{symbol}.S").write_text(
        f'.section .rodata.{symbol},"a",@progbits\n'
        ".balign 16\n"
        f".global {symbol}_start\n"
        f".type {symbol}_start, @object\n"
        f"{symbol}_start:\n"
        f'.incbin "{escaped(package)}"\n'
        f".global {symbol}_end\n"
        f"{symbol}_end:\n"
        f".size {symbol}_start, {symbol}_end - {symbol}_start\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--host-profile", type=Path, required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        generate(args.package, args.host_profile, args.name, args.output_dir)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
