# Upstream proposal: RT-Thread / Edgi-Talk host for pocket-nexus

**Status:** Draft for discussion (P3). Not an opened PR against
[pocket-nexus/pocketjs](https://github.com/pocket-nexus/pocketjs).

**Audience:** pocket-nexus maintainers and anyone evaluating a third native
target beside ESP32-P4 / ESP32-S3.

**Related (this fork):**

- Branch / PR: [`host/rt-thread-edgitalk`](https://github.com/1024971823/pocketjs/tree/host/rt-thread-edgitalk) · [PR #1](https://github.com/1024971823/pocketjs/pull/1)
- Host identity tracking: [issue #2](https://github.com/1024971823/pocketjs/issues/2) (`platform: "esp-idf"` borrow → `pocket-rtt-host-1`)
- Overlay (board product, not proposed for monorepo): [PocketJS_for_Edgi-Talk](https://github.com/1024971823/PocketJS_for_Edgi-Talk)
- BSP (referenced, not vendored): [sdk-bsp-psoc_e84-edgi-talk](https://github.com/RT-Thread-Studio/sdk-bsp-psoc_e84-edgi-talk)

---

## 1. What Edgi already runs (honest)

Edgi-Talk (Infineon PSoC E84, Cortex-M55, RT-Thread, 800×480 LCD, HyperRAM) already
runs a large subset of the **ESP-IDF PocketJS UI stack**, compiled into an RT-Thread
SCons product project — not as a first-class peer of `hosts/esp-idf`.

| Layer | What runs today |
| --- | --- |
| Shared C | `hosts/esp-idf/components/{pocketjs_package,guest,ui_core,ui_qjs,render_rgb565}` sources linked from the product / host `SConscript` (no forked copies of those ABIs) |
| Rust | `ui-core` + `render-rgb565` rebuilt for **`thumbv8m.main-none-eabihf`** (M55); HyperRAM mapped ≈ SPIRAM (`MALLOC_CAP_SPIRAM` → memheap @ `0x64400000`) |
| Guest | QuickJS-ng (local tree / sibling checkout, not IDF Component Manager) |
| Present | Same `prepare → render_strip → commit/abort` RGB565 transaction; product owns ST7102 touch → `pocketjs_ui_input_t` and LCD damage present |
| Host loop | Caller-driven RT-Thread task (S3-class software path; no PPA / no required `pocketjs_runner`) |
| Package | `.pocket` built with Pocket CLI; admission still ESP-shaped (`pocket-idf-host-1`, `platform: "esp-idf"` — tracked in issue #2) |

**Product-owned (same philosophy as ESP):** tasks, LCD, touch, Wi-Fi, BT, flash
layout, and any `__edgi` / dashboard / game natives. PocketJS is the UI runtime,
not a board firmware.

This is a **working borrowed port**, not Registry packaging, not an official
native toolchain entry, and not a clean RT-Thread host ABI yet.

---

## 2. Proposed monorepo addition

Add a first-class host tree, after P0–P2 on this fork are reviewable:

**Preferred name:** `hosts/rt-thread-edgitalk`  
**Alternative:** generic `hosts/rt-thread` with Edgi as the first documented board
profile (same split: reusable glue in monorepo, board BSP outside).

### In scope for upstream monorepo

- Host docs and build notes (portable paths; no private machine absolutes)
- Shared **consume** of `hosts/esp-idf/components/{package,guest,ui_*,render_rgb565}` — prefer sharing C ABIs over forking files
- Host-owned native glue: ESP→RT thin shims / OSAL, QuickJS platform compat, portable host loop + board hooks, SCons (or CMake) include fragment
- Native toolchain entry + build script for `thumbv8m.main-none-eabihf` (receipts analogous to `tools/esp-idf-native.ts`)
- Contracts check aligned with GuestOps/HostOps (reuse shared IDF contract verification where ABIs are shared)
- Example / smoke outline that is headless or minimal (RAM framebuffer); optional app under `apps/` that is not product Wi-Fi/BT
- Host profile schema / CLI recognition for `platform: "rt-thread"` (working name `pocket-rtt-host-1`)

### Explicitly **out of scope** for upstream

Do **not** ask pocket-nexus to vendor:

- BSP patches (LCD partial present, BT uart4, Wi-Fi `btc_mode`, etc.)
- CYW / Infineon Bluetooth controller firmware blobs
- KitProg3 / OpenOCD flash scripts and board-private paths
- Full RT-Thread project tree / `rtconfig` / linker scripts for PSoC E84
- Product Wi-Fi REST + UDP discovery, BT status channel, game/synth/music storage, dashboard / `__edgi` bridges

Those remain in [PocketJS_for_Edgi-Talk](https://github.com/1024971823/PocketJS_for_Edgi-Talk) + the RT-Thread BSP — the same product-vs-runtime split ESP documents.

---

## 3. Asks for pocket-nexus

Honest requests; any subset is useful. Rejection or “source-build only” is an
acceptable outcome.

1. **Third native target**  
   Document `thumbv8m.main-none-eabihf` beside
   `riscv32imafc-unknown-none-elf` (P4) and `xtensa-esp32s3-none-elf` (S3) in
   native toolchains / build tooling.

2. **Registry vs source-build-only**  
   Either publish M55 `ui-core` / `render-rgb565` archives in the component
   Registry, **or** state an explicit policy that RT-Thread / M55 is
   **source-build only** (`POCKETJS_RUST_FROM_SOURCE`-style) with no Registry
   pretence.

3. **Docs page**  
   A docs page like `/docs/rt-thread/` (or `/docs/edgi-talk/`) mirroring
   https://pocketjs.dev/docs/esp-idf/ — architecture, shared components, native
   build, host profile, what product firmware must own.

4. **Host profile schema**  
   Publish `pocket-rtt-host-1` (name TBD) with `platform: "rt-thread"`, covering
   tick, viewport, density, presentation, capabilities, HostOps as needed for
   `.pocket` admission — so apps stop borrowing `pocket-idf-host-1` /
   `platform: "esp-idf"` (see fork [issue #2](https://github.com/1024971823/pocketjs/issues/2)).

5. **Reduce `esp_err` / `heap_caps` coupling — or accept a thin OSAL**  
   Today the shared C/Rust path assumes ESP error types and heap capability bits;
   Edgi supplies shims (`esp_err.h`, `esp_heap_caps.h` → HyperRAM). Prefer either:
   - upstream guest/render tolerate injectable allocator / error hooks, or
   - document that a **thin portable OSAL** in the RT-Thread host is the supported
     integration (what this fork already sketches under `native/`).

---

## 4. Hardware gates (future; analogous to ESP)

Not required to open a discussion PR; listed so expectations match ESP-class
validation later:

- Frame hash / retained UI smoke on **800×480** (physical; logical often 400×240 @ density 2)
- Heap steady-state with guest `prefer_psram` / HyperRAM (~6 MiB guest heap class)
- Present cadence / damage commit under RT-Thread task (caller-driven, S3-like)

Until then, CI can stay at contracts + optional headless outline without LCD.

---

## 5. Current fork status (P0–P2 landed summary)

Work lives on fork branch `host/rt-thread-edgitalk` ([PR #1](https://github.com/1024971823/pocketjs/pull/1)); overlay stays the board product repo.

| Phase | Summary |
| --- | --- |
| **P0** | App SoT synced to `apps/edgitalk-m55-smoke/`; portable `docs/build.md`; host README documents borrowed ESP stack + HyperRAM/shims; no absolute private paths |
| **P1** | Native glue under `hosts/rt-thread-edgitalk/native/` (shims, host loop + board hooks, SCons fragment); overlay thins toward product bridges; issue #2 tracks `platform` / schema honesty |
| **P2** | Shared-components policy; `bun tools/rt-thread-edgitalk-native.ts` + `toolchains.json` + receipts; contracts skeleton (`rtt-edgitalk-native` + shared IDF check); headless smoke outline |
| **P3** | This document + optional ready-to-paste PR body — **no** PR opened against pocket-nexus yet |

Until pocket-nexus accepts an M55 / RT-Thread target, the fork remains the source of
truth for reusable host work; the overlay remains board/BT/patches.

---

## 6. Suggested review path (when maintainers want a PR)

1. Read this proposal and the host tree on the fork (no BSP blobs).
2. Decide Registry vs source-build-only and whether the host directory is
   Edgi-named or generic `hosts/rt-thread`.
3. Agree schema/`platform` naming before flipping `pocket.host.json`.
4. Open a **draft** PR to pocket-nexus with only in-scope paths (use
   [`upstream-pr-body.md`](upstream-pr-body.md) as a starting point).

Contact / discussion can start from the fork issues and this doc; opening an
upstream PR is a separate, explicit step.
