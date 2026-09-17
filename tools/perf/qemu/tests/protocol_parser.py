"""Strict parser for the QEMU fixture runner's prefixed NDJSON."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

PREFIX = "POCKETJS_PERF_QEMU "
SCHEMA = "pocketjs.perf.qemu"
VERSION = 1
METRICS = {
    "guest_insn_dispatched",
    "guest_instruction_bytes",
    "guest_insn_size_2",
    "guest_insn_size_4",
    "guest_load_events",
    "guest_store_events",
}


class ProtocolError(ValueError):
    pass


@dataclass(frozen=True)
class ParsedOutput:
    measurements: tuple[dict[str, Any], ...]
    terminal: dict[str, Any]


def parse_output(output: str) -> ParsedOutput:
    records: list[dict[str, Any]] = []

    for line_number, line in enumerate(output.splitlines(), 1):
        if not line.startswith(PREFIX):
            continue
        payload = line[len(PREFIX) :]
        try:
            record = json.loads(payload)
        except json.JSONDecodeError as error:
            raise ProtocolError(
                f"invalid JSON on protocol line {line_number}: {error.msg}"
            ) from error
        if not isinstance(record, dict):
            raise ProtocolError(f"protocol line {line_number} is not an object")
        if record.get("schema") != SCHEMA or record.get("version") != VERSION:
            raise ProtocolError(f"schema mismatch on protocol line {line_number}")
        records.append(record)

    if not records:
        raise ProtocolError("no QEMU perf protocol records")

    terminals = [
        record for record in records if record.get("event") in {"complete", "error"}
    ]
    if len(terminals) != 1:
        raise ProtocolError("expected exactly one complete/error sentinel")
    if records[-1] is not terminals[0]:
        raise ProtocolError("complete/error sentinel is not the final protocol record")

    measurements = tuple(
        record for record in records if record.get("event") == "measurement"
    )
    known_count = len(measurements) + 1
    if len(records) != known_count:
        raise ProtocolError("unknown protocol event")

    for measurement in measurements:
        metrics = measurement.get("metrics")
        if not isinstance(metrics, dict) or set(metrics) != METRICS:
            raise ProtocolError("measurement metric set mismatch")
        if any(type(value) is not int or value < 0 for value in metrics.values()):
            raise ProtocolError("measurement metrics must be non-negative integers")

    terminal = terminals[0]
    if terminal.get("measurements") != len(measurements):
        raise ProtocolError("terminal measurement count mismatch")
    if terminal["event"] == "complete" and not measurements:
        raise ProtocolError("complete sentinel has no measurements")
    if terminal["event"] == "error" and not isinstance(terminal.get("code"), str):
        raise ProtocolError("error sentinel has no code")

    return ParsedOutput(measurements=measurements, terminal=terminal)
