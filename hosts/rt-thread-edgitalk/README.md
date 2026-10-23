# PocketJS on RT-Thread / Edgi-Talk

Host for PocketJS on the Edgi-Talk board (Infineon PSoC E84, Cortex-M55)
running RT-Thread.

This directory mirrors the intent of [`hosts/esp-idf`](../esp-idf): product
firmware owns tasks, input, display, and storage. PocketJS is integrated as the
UI runtime, not as a vendored board support package.

## Status (P0–P2 landed; P3 = upstream prep)

- **Reuses** the ESP-IDF host C components under
  `hosts/esp-idf/components/{package,guest,ui_*,render_rgb565}` — see
  [`components/README.md`](components/README.md) (do not fork C sources).
- **Rust** UI / render crates rebuild for M55 (`thumbv8m.main-none-eabihf`) via
  `bun tools/rt-thread-edgitalk-native.ts` + [`native/toolchains.json`](native/toolchains.json).
  HyperRAM ≈ SPIRAM via [`native/pocketjs_rt_compat.c`](native/pocketjs_rt_compat.c).
- **Native glue** under [`native/`](native/): ESP→RT shims, QuickJS compat,
  portable host loop with **board hooks** (`pocketjs_host_board.h`), embed
  pattern, SCons fragment, receipts schema.
- **Contracts skeleton:** `contracts/spec/rtt-edgitalk-native.ts` +
  `bun tools/rt-thread-edgitalk-contracts.ts` (shared IDF check + honest
  “not yet enforced” for RTT-only surfaces).
- **App** SoT: [`apps/edgitalk-m55-smoke/`](../../apps/edgitalk-m55-smoke/).
- **Product owns** LCD, touch, Wi-Fi, and BT (same philosophy as the ESP host).
  Product `__edgi` stays outside PocketJS core.
- **Optional** headless smoke outline: [`examples/smoke/`](examples/smoke/)
  (board-CI later; not runnable without RT-Thread BSP).

### Host identity (`platform: "esp-idf"`)

`apps/edgitalk-m55-smoke/pocket.host.json` still declares `platform: "esp-idf"`
and the `pocket-idf-host-1` schema so CLI admission works. That is an intentional
borrow, **not** a claim the firmware is ESP-IDF. The Pocket CLI does not yet
register `platform: "rt-thread"`.

Tracking: **[#2 — replace platform esp-idf with rt-thread / pocket-rtt-host-1](https://github.com/1024971823/pocketjs/issues/2)**.
Do not invent a fake schema URL; keep `platform: "esp-idf"` until a real schema
exists. See also [`apps/edgitalk-m55-smoke/HOST_PROFILE.md`](../../apps/edgitalk-m55-smoke/HOST_PROFILE.md).

## What lives here

- Integration notes for the RT-Thread / Edgi-Talk host.
- Native glue under [`native/`](native/) (shims, host loop, SCons, toolchains).
- Component sharing policy under [`components/`](components/).
- Portable build notes in [`docs/build.md`](docs/build.md).
- Upstream proposal + draft PR body in [`docs/upstream-proposal.md`](docs/upstream-proposal.md) / [`docs/upstream-pr-body.md`](docs/upstream-pr-body.md).
- Headless smoke outline under [`examples/smoke/`](examples/smoke/).

## What does not live here

BSP patches and Bluetooth firmware are not vendored in this repository. They stay in:

- [PocketJS_for_Edgi-Talk](https://github.com/1024971823/PocketJS_for_Edgi-Talk)
  — Edgi overlay (product bridges, board project, docs) and
  [`projects/Edgi_Talk_M55_PocketJS/docs/`](https://github.com/1024971823/PocketJS_for_Edgi-Talk/tree/main/projects/Edgi_Talk_M55_PocketJS/docs)
  (compile / flash / onboard use).
- The RT-Thread BSP for Edgi-Talk / PSoC E84.

## Quick commands

```sh
bun tools/pocket.ts build \
  --host-profile apps/edgitalk-m55-smoke/pocket.host.json \
  --manifest apps/edgitalk-m55-smoke/pocket.json

bun tools/rt-thread-edgitalk-native.ts --help
bun tools/rt-thread-edgitalk-contracts.ts --list
```

## Upstream (P3 draft)

This fork tracks [pocket-nexus/pocketjs](https://github.com/pocket-nexus/pocketjs).
Edgi-Talk host work stays on `host/rt-thread-edgitalk` until pocket-nexus accepts
an RT-Thread / M55 target.

- **Proposal (read this first):** [`docs/upstream-proposal.md`](docs/upstream-proposal.md)
- **Ready-to-paste upstream PR body (not opened):** [`docs/upstream-pr-body.md`](docs/upstream-pr-body.md)
- Fork PR #1: https://github.com/1024971823/pocketjs/pull/1
- Host identity: [#2](https://github.com/1024971823/pocketjs/issues/2)

**No PR has been opened against pocket-nexus** from this work; P3 is honest prep only.
