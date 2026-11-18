#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import struct
from pathlib import Path
import bundle_format as fmt

MAGIC = fmt.BUNDLE_MAGIC
VERSION = fmt.BUNDLE_VERSION
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


def bundle(data: bytes) -> tuple[int, bytes, list[tuple[int, bytes]]]:
    """The binding generation, host contract hash and sections of a bundle,
    with the checks of contracts/spec/bundle.ts."""
    if len(data) < fmt.BUNDLE_HEADER_SIZE + fmt.BUNDLE_FOOTER_SIZE:
        raise ValueError("bundle is truncated")
    magic, version, abi, count, payload_hash = struct.unpack_from("<4IQ", data)
    if magic != MAGIC:
        raise ValueError("bad bundle magic")
    if version != VERSION:
        raise ValueError(f"unsupported bundle version {version}")
    end = len(data) - fmt.BUNDLE_FOOTER_SIZE
    if fnv1a64(data[:end]) != struct.unpack_from("<Q", data, end)[0]:
        raise ValueError("bundle footer hash mismatch")
    if struct.unpack_from("<2I", data, fmt.OFFSET_HEADER_RESERVED) != (0, 0):
        raise ValueError("invalid bundle header")
    profile_hash = data[fmt.OFFSET_HEADER_PROFILE_HASH:fmt.OFFSET_HEADER_PROFILE_HASH + 32]
    if count > (end - fmt.BUNDLE_HEADER_SIZE) // fmt.BUNDLE_SECTION_SIZE:
        raise ValueError("invalid section table")
    align = lambda value: (value + fmt.BUNDLE_ALIGN - 1) & ~(fmt.BUNDLE_ALIGN - 1)
    next_payload = align(fmt.BUNDLE_HEADER_SIZE + count * fmt.BUNDLE_SECTION_SIZE)
    sections = []
    previous_kind = None
    actual_hash = 0xCBF29CE484222325
    for index in range(count):
        kind, reserved, start, size = struct.unpack_from("<4I", data, fmt.BUNDLE_HEADER_SIZE + index * fmt.BUNDLE_SECTION_SIZE)
        if reserved or (previous_kind is not None and previous_kind >= kind) or start != next_payload or start + size > end:
            raise ValueError("invalid payload layout")
        payload = data[start:start + size]
        for byte in payload:
            actual_hash = ((actual_hash ^ byte) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
        sections.append((kind, payload))
        previous_kind = kind
        next_payload = align(start + size)
    if next_payload != end:
        raise ValueError("invalid footer position")
    if actual_hash != payload_hash:
        raise ValueError("bundle payload hash mismatch")
    return abi, profile_hash, sections


def validate(data: bytes) -> None:
    bundle(data)


def host_contract(data: bytes) -> tuple[tuple[int, ...], bytes]:
    abi, profile_hash, sections = bundle(data)
    matches = [payload for kind, payload in sections if kind == fmt.SECTION_HOST_INPUTS]
    if len(matches) != 1:
        raise ValueError("an embedded ESP-IDF bundle carries exactly one hostInputs section")
    payload = matches[0]
    if len(payload) != HOST_INPUTS_SIZE:
        raise ValueError("hostInputs section is malformed")
    fields = struct.unpack_from("<10I", payload)
    if fields[0] != HOST_INPUTS_MAGIC or fields[1] != HOST_INPUTS_VERSION:
        raise ValueError("hostInputs header is unsupported")
    if fields[2] != abi:
        raise ValueError("hostInputs ABI differs from the bundle header")
    if payload[fmt.OFFSET_HOST_INPUTS_PROFILE_HASH:fmt.OFFSET_HOST_INPUTS_PLAN_HASH] != profile_hash:
        raise ValueError("hostInputs profile hash differs from the bundle header")
    return fields, profile_hash


def escaped(path: Path) -> str:
    return str(path.resolve()).replace("\\", "\\\\").replace('"', '\\"')


def read_profile(profile_path: Path) -> dict:
    document = json.loads(profile_path.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or document.get("format") != "pocket-host/2":
        raise ValueError("unsupported pocket.host.json format")
    abi = document.get("hostAbi")
    if type(abi) is not int or not 1 <= abi <= 0xFFFFFFFF:
        raise ValueError("host export carries no hostAbi stamp")
    display = document.get("display")
    if not isinstance(display, dict) or not isinstance(document.get("cadences"), list) or not isinstance(document.get("panel"), dict):
        raise ValueError("host export lacks display, cadences or panel")
    return document


def cadence_for(tick_hz: int, cadences: list) -> int | None:
    """The largest cadence tick_hz is a whole multiple of, at most 60
    (contracts/spec/admission.ts cadenceFor)."""
    if type(tick_hz) is not int or not 1 <= tick_hz <= 240:
        return None
    admitted = [cadence for cadence in cadences
                if type(cadence) is int and cadence > 0 and tick_hz % cadence == 0 and tick_hz // cadence <= 60]
    return max(admitted) if admitted else None


def plan_section(data: bytes) -> dict:
    _abi, _hash, sections = bundle(data)
    for kind, payload in sections:
        if kind == fmt.SECTION_PLAN:
            plan = json.loads(payload.decode("utf-8"))
            if isinstance(plan, dict):
                return plan
    raise ValueError("embedded bundle has no plan")


def validate_profile(profile_path: Path, fields: tuple[int, ...], plan: dict) -> list[int]:
    """Admit the bundle's host inputs by the exported facts (the device rules
    of contracts/spec/admission.ts) and return the physical panel size the
    program presents it on."""
    document = read_profile(profile_path)
    display = document["display"]
    problems = []
    if document["hostAbi"] != fields[2]:
        problems.append("binding generation")
    if display.get("rasterDensity") != fields[8]:
        problems.append("raster density")
    if plan.get("animation") != display.get("animation"):
        problems.append("animation")
    if cadence_for(fields[3], document["cadences"]) is None:
        problems.append(f"rate {fields[3]} Hz")
    logical = [fields[4], fields[5]]
    dynamic = display.get("dynamicViewport")
    if isinstance(dynamic, dict):
        low, high = dynamic.get("min", []), dynamic.get("max", [])
        admitted = len(low) == len(high) == 2 and all(low[index] <= logical[index] <= high[index] for index in range(2))
    else:
        admitted = logical in display.get("logicalViewports", [])
    if not admitted:
        problems.append("viewport")
    presentations = fmt.HOST_PRESENTATIONS
    if fields[9] >= len(presentations) or presentations[fields[9]] not in display.get("presentations", []):
        problems.append("presentation")
    capabilities = set(document.get("capabilities", []))
    features = plan.get("features") if isinstance(plan.get("features"), dict) else {}
    missing = [name for name, value in features.items() if value is True and name not in capabilities]
    if missing:
        problems.append("capability " + missing[0])
    if problems:
        raise ValueError("bundle host inputs are not admitted by host export: " + ", ".join(problems))
    panel = document["panel"].get("primary", [])
    physical = [fields[6], fields[7]]
    if isinstance(dynamic, dict):
        return [n * display["rasterDensity"] for n in logical]
    # The bundle records the panel it was compiled for; this program
    # presents on its own panel, in the bundle's orientation when it fits.
    return physical if physical in (panel, list(reversed(panel))) else panel


def generate(bundle_path: Path, profile: Path, name: str, output_dir: Path) -> None:
    if not NAME.fullmatch(name):
        raise ValueError("NAME must match [a-z][a-z0-9_]*")
    bundle_path = bundle_path.resolve()
    data = bundle_path.read_bytes()
    validate(data)
    host_fields, profile_hash = host_contract(data)
    plan = plan_section(data)
    target = plan.get("target", {}).get("id") if isinstance(plan.get("target"), dict) else None
    if not isinstance(target, str) or not target:
        raise ValueError("the bundle's plan names no target")
    physical = validate_profile(profile.resolve(), host_fields, plan)
    output_dir.mkdir(parents=True, exist_ok=True)
    symbol = f"pocketjs_bundle_{name}"
    (output_dir / f"{symbol}.h").write_text(
        "#pragma once\n\n"
        '#include "pocket/bundle.h"\n\n'
        "#ifdef __cplusplus\nextern \"C\" {\n#endif\n\n"
        f"extern const pocketjs_embedded_bundle_t {symbol};\n"
        f"extern const pocketjs_bundle_host_contract_t {symbol}_contract;\n\n"
        "#ifdef __cplusplus\n}\n#endif\n",
        encoding="utf-8",
    )
    (output_dir / f"{symbol}.c").write_text(
        f'#include "{symbol}.h"\n\n'
        f"extern const uint8_t {symbol}_start[];\n\n"
        f"const pocketjs_embedded_bundle_t {symbol} = {{\n"
        f"    .data = {symbol}_start,\n"
        f"    .size = {len(data)}U,\n"
        "};\n\n"
        f"const pocketjs_bundle_host_contract_t {symbol}_contract = {{\n"
        f"    .struct_size = sizeof({symbol}_contract),\n"
        f"    .target_id = (const char[]){{{','.join(str(byte) for byte in target.encode('utf-8'))},0}},\n"
        f"    .host_abi = {host_fields[2]}U,\n"
        f"    .tick_hz = {host_fields[3]}U,\n"
        f"    .logical_width = {host_fields[4]}U,\n"
        f"    .logical_height = {host_fields[5]}U,\n"
        f"    .physical_width = {physical[0]}U,\n"
        f"    .physical_height = {physical[1]}U,\n"
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
        f'.incbin "{escaped(bundle_path)}"\n'
        f".global {symbol}_end\n"
        f"{symbol}_end:\n"
        f".size {symbol}_start, {symbol}_end - {symbol}_start\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True, help="exported pocket.host.json")
    parser.add_argument("--name", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        generate(args.bundle, args.profile, args.name, args.output_dir)
    except (OSError, ValueError, UnicodeError, TypeError, AttributeError, json.JSONDecodeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
