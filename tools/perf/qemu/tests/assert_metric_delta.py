#!/usr/bin/env python3
"""Require a deterministic injected workload to increase one guest counter."""

from __future__ import annotations

import argparse
from pathlib import Path

from protocol_parser import parse_output


def metric(path: Path, name: str) -> int:
    parsed = parse_output(path.read_text(encoding="utf-8"))
    if parsed.terminal["event"] != "complete" or len(parsed.measurements) != 1:
        raise ValueError(f"{path} is not one complete measurement")
    return int(parsed.measurements[0]["metrics"][name])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--metric", required=True)
    parser.add_argument("--minimum-delta", required=True, type=int)
    args = parser.parse_args()
    delta = metric(args.candidate, args.metric) - metric(args.base, args.metric)
    if delta <= args.minimum_delta:
        parser.error(
            f"{args.metric} delta {delta} did not exceed {args.minimum_delta}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
