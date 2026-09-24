# Core Memory PSP Receipt

Status: **PASS**

Receipt schema version: **1**

Both benchmark commands reached the `stats` PSP app under PPSSPPHeadless.

The PSP target is the **`stats` representative workload**, using the existing
fixed input script and PSP JSONL schema. It corresponds to phases in the Rust
synthetic workload profile; the two journeys are not byte-identical event
sequences. No second demo or Taffy A/B run was added.

## Commands

Both commands ran on revision `3e0b772`. The PPSSPP source revision was
`f929a74`.

```bash
git status --short --branch
```

Baseline:

```bash
PSP_SDK="$PSP_SDK" BENCH_PPSSPP_TIMEOUT=60 bun tools/bench-ppsspp.ts --apps=stats --samples=3
```

Status: **PASS**; exit status: `0`.

Memory scan:

```bash
PSP_SDK="$PSP_SDK" BENCH_PPSSPP_TIMEOUT=60 bun tools/bench-ppsspp.ts --apps=stats --samples=3 --memory-scan
```

Status: **PASS**; exit status: `0`.

## Revisions

| item | value |
|---|---|
| git revision | `3e0b772` |
| PPSSPP revision | `f929a74` |
| selected app | `stats` |
| framework | `solid` |
| samples | `3` |
| report path | `dist/bench/ppsspp-bench-2026-09-05T05-07-18-714Z.json` |
| checksum | `c88e7bcedc5d42a5` |

`report_path` points to the authoritative generated JSON report under
`dist/bench/`. `checksum` is the representative workload drawlist checksum.
The PSP checksum `c88e7bcedc5d42a5` differs from the Rust baseline checksum
`cc6a0b00efdba151`; the workloads are not byte-identical.

## Metrics

| metric | value |
|---|---:|
| arena bump | `2,654,944` bytes (`2.53 MiB`) |
| arena tail free | `15,232,288` bytes |
| avg tick | `516us` |
| avg work | `4,686us` |
| max work | `62,816us` |
| uncapped arena bump | `2,654,944` bytes |
| minimum passing arena | `2,883,584` bytes (`2.75 MiB`) |
| safe arena | `3,670,016` bytes (`3.50 MiB`) |

## Environment

The fixed PSP SDK was loaded from `/Users/quake/.cache/pocket-stack/psp/env.sh`.
`PPSSPPHeadless` was built at `/Users/quake/ppsspp-src/build/PPSSPPHeadless`.

**PPSSPP results, when available, are emulator evidence rather than real PSP
hardware proof.** `arena_bump_bytes` is a practical allocator capacity
requirement and includes size-class fragmentation; it is not a precise
live-object heap profile.
