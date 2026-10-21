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


def variants(data: bytes) -> list[tuple[str, int, bytes, list[tuple[int, bytes]]]]:
    if len(data) < fmt.POCKET_HEADER_SIZE + fmt.POCKET_FOOTER_SIZE:
        raise ValueError("package is truncated")
    magic, version, manifest, count, strings, string_size, reserved0, reserved1 = struct.unpack_from("<8I", data)
    if magic != MAGIC:
        raise ValueError("bad .pocket magic")
    if version != VERSION:
        raise ValueError(f"unsupported .pocket version {version}")
    end = len(data) - fmt.POCKET_FOOTER_SIZE
    if fnv1a64(data[:end]) != struct.unpack_from("<Q", data, end)[0]:
        raise ValueError(".pocket footer hash mismatch")
    align = lambda value: (value + fmt.POCKET_ALIGN - 1) & ~(fmt.POCKET_ALIGN - 1)
    table = align(fmt.POCKET_HEADER_SIZE + manifest)
    if reserved0 or reserved1 or table > end or count > (end - table) // fmt.POCKET_VARIANT_SIZE:
        raise ValueError("invalid header or variant table")
    if strings != table + count * fmt.POCKET_VARIANT_SIZE or strings + string_size > end:
        raise ValueError("invalid string table")
    next_string, strings_end = strings, strings + string_size
    next_table = align(strings_end)
    previous_target = None
    records = []
    for index in range(count):
        entry = table + index * fmt.POCKET_VARIANT_SIZE
        target_offset, target_size, abi, sections, offset, reserved, variant_hash = struct.unpack_from("<6IQ", data, entry)
        if target_offset != next_string or not 1 <= target_size <= fmt.POCKET_TARGET_MAX_BYTES or target_offset + target_size > strings_end:
            raise ValueError("invalid target range")
        raw_target = data[target_offset:target_offset + target_size]
        if b"\0" in raw_target or (previous_target is not None and previous_target >= raw_target):
            raise ValueError("invalid target order")
        target = raw_target.decode("utf-8", errors="strict")
        if reserved or offset != next_table or offset > end or sections > (end - offset) // fmt.POCKET_SECTION_SIZE:
            raise ValueError("invalid section table")
        records.append((target, abi, data[entry + fmt.OFFSET_VARIANT_PROFILE_HASH:entry + fmt.OFFSET_VARIANT_PROFILE_HASH + 32], offset, sections, variant_hash))
        previous_target = raw_target
        next_string += target_size
        next_table += sections * fmt.POCKET_SECTION_SIZE
    if next_string != strings_end:
        raise ValueError("unused string table bytes")
    next_payload = align(next_table)
    result = []
    for target, abi, profile_hash, offset, count, variant_hash in records:
        sections = []
        previous_kind = None
        actual_hash = 0xCBF29CE484222325
        for index in range(count):
            kind, reserved, start, size = struct.unpack_from("<4I", data, offset + index * fmt.POCKET_SECTION_SIZE)
            if reserved or (previous_kind is not None and previous_kind >= kind) or start != next_payload or start + size > end:
                raise ValueError("invalid payload layout")
            payload = data[start:start + size]
            for byte in payload:
                actual_hash = ((actual_hash ^ byte) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
            sections.append((kind, payload))
            previous_kind = kind
            next_payload = align(start + size)
        if actual_hash != variant_hash:
            raise ValueError("variant payload hash mismatch")
        result.append((target, abi, profile_hash, sections))
    if next_payload != end:
        raise ValueError("invalid footer position")
    return result


def validate(data: bytes) -> None:
    variants(data)


def host_contract(data: bytes) -> tuple[str, tuple[int, ...], bytes]:
    matches: list[tuple[str, tuple[int, ...], bytes]] = []
    for target, variant_abi, profile_hash, sections in variants(data):
        for kind, payload in sections:
            if kind != fmt.SECTION_HOST_INPUTS:
                continue
            if len(payload) != HOST_INPUTS_SIZE:
                raise ValueError("hostInputs section is malformed")
            fields = struct.unpack_from("<10I", payload)
            if fields[0] != HOST_INPUTS_MAGIC or fields[1] != HOST_INPUTS_VERSION:
                raise ValueError("hostInputs header is unsupported")
            if fields[2] != variant_abi:
                raise ValueError("hostInputs ABI differs from its variant")
            if payload[fmt.OFFSET_HOST_INPUTS_PROFILE_HASH:fmt.OFFSET_HOST_INPUTS_PLAN_HASH] != profile_hash:
                raise ValueError("hostInputs profile hash differs from its variant")
            matches.append((target, fields, profile_hash))
    if len(matches) != 1:
        raise ValueError("embedded ESP-IDF package must contain exactly one hostInputs variant")
    return matches[0]


def escaped(path: Path) -> str:
    return str(path.resolve()).replace("\\", "\\\\").replace('"', '\\"')


def read_profile(profile_path: Path) -> dict:
    sidecar = json.loads(profile_path.read_text(encoding="utf-8"))
    if not isinstance(sidecar, dict) or sidecar.get("format") != "pocket-profile/1":
        raise ValueError("unsupported pocket-profile.json format")
    canonical = sidecar.get("canonicalProfileJson")
    profile = sidecar.get("profile")
    if not isinstance(canonical, str) or not isinstance(profile, dict):
        raise ValueError("profile export is missing canonicalProfileJson/profile")
    # Hash the exporter's exact UTF-8 bytes. Python must not invent a second
    # canonical serializer (number and Unicode spellings belong to the exporter).
    if json.loads(canonical) != profile:
        raise ValueError("profile export JSON differs from canonicalProfileJson")
    expected_hash = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    if sidecar.get("profileHash") != expected_hash:
        raise ValueError("profile export hash does not match canonicalProfileJson")
    abi = sidecar.get("hostAbi")
    if type(abi) is not int or not 1 <= abi <= 0xFFFFFFFF:
        raise ValueError("profile export hostAbi is invalid")
    return sidecar


def validate_profile(
    profile_path: Path,
    target: str,
    fields: tuple[int, ...],
    profile_hash: bytes,
) -> None:
    sidecar = read_profile(profile_path)
    if sidecar["profileHash"] != "sha256:" + profile_hash.hex():
        raise ValueError("package profile hash does not match profile export")
    if sidecar["hostAbi"] != fields[2]:
        raise ValueError("package host ABI does not match profile export")
    profile = sidecar["profile"]
    display = profile.get("display", {})
    logical = [fields[4], fields[5]]
    dynamic = display.get("dynamicViewport")
    admitted = logical in display.get("logicalViewports", [])
    if isinstance(dynamic, dict):
        low, high = dynamic.get("min", []), dynamic.get("max", [])
        admitted = admitted or (len(low) == len(high) == 2 and
            all(low[index] <= logical[index] <= high[index] for index in range(2)))
    physical = display.get("physicalViewport", [])
    physical_options = [physical, list(reversed(physical))]
    if dynamic:
        physical_options.append([n * display.get("rasterDensity", 0) for n in logical])
    presentations = fmt.HOST_PRESENTATIONS
    if (
        profile.get("id") != target
        or profile.get("platform") != "esp-idf"
        or profile.get("tickHz") != fields[3]
        or not admitted
        or [fields[6], fields[7]] not in physical_options
        or display.get("rasterDensity") != fields[8]
        or fields[9] >= len(presentations)
        or presentations[fields[9]] not in display.get("presentations", [])
    ):
        raise ValueError("package host inputs are not admitted by profile export")


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
    (output_dir / f"{symbol}.h").write_text(
        "#pragma once\n\n"
        '#include "pocket/package.h"\n\n'
        "#ifdef __cplusplus\nextern \"C\" {\n#endif\n\n"
        f"extern const pocketjs_embedded_package_t {symbol};\n"
        f"extern const pocketjs_package_host_contract_t {symbol}_contract;\n\n"
        "#ifdef __cplusplus\n}\n#endif\n",
        encoding="utf-8",
    )
    (output_dir / f"{symbol}.c").write_text(
        f'#include "{symbol}.h"\n\n'
        f"extern const uint8_t {symbol}_start[];\n\n"
        f"const pocketjs_embedded_package_t {symbol} = {{\n"
        f"    .data = {symbol}_start,\n"
        f"    .size = {len(data)}U,\n"
        "};\n\n"
        f"const pocketjs_package_host_contract_t {symbol}_contract = {{\n"
        f"    .struct_size = sizeof({symbol}_contract),\n"
        f"    .target_id = (const char[]){{{','.join(str(byte) for byte in target.encode('utf-8'))},0}},\n"
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
    parser.add_argument("--profile", type=Path, required=True, help="exported pocket-profile.json")
    parser.add_argument("--name", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        generate(args.package, args.profile, args.name, args.output_dir)
    except (OSError, ValueError, UnicodeError, TypeError, AttributeError, json.JSONDecodeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
