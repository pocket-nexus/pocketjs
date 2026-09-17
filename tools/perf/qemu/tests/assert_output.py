#!/usr/bin/env python3
"""Validate a captured fixture run against its expected terminal and metrics."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from protocol_parser import ProtocolError, parse_output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("log", type=Path)
    parser.add_argument("--complete", action="store_true")
    parser.add_argument("--error")
    parser.add_argument("--metrics", type=Path)
    parser.add_argument("--target")
    args = parser.parse_args()

    try:
        parsed = parse_output(args.log.read_text(encoding="utf-8"))
    except ProtocolError as error:
        parser.error(str(error))

    if args.complete and parsed.terminal["event"] != "complete":
        parser.error(f"expected complete, got {parsed.terminal!r}")
    if args.error is not None:
        actual = parsed.terminal.get("code")
        if parsed.terminal["event"] != "error" or actual != args.error:
            parser.error(f"expected error {args.error!r}, got {parsed.terminal!r}")
    if args.target is not None and parsed.terminal.get("target") != args.target:
        parser.error(f"expected target {args.target!r}, got {parsed.terminal!r}")
    if args.metrics is not None:
        expected = json.loads(args.metrics.read_text(encoding="utf-8"))
        if len(parsed.measurements) != 1:
            parser.error(f"expected one measurement, got {len(parsed.measurements)}")
        actual = parsed.measurements[0]["metrics"]
        if actual != expected:
            parser.error(f"metric mismatch: expected {expected!r}, got {actual!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
