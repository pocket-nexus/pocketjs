# Build notes — RT-Thread / Edgi-Talk (PSoC E84 M55)

Portable steps for building the PocketJS package, M55 Rust static libs, and
including the host `SConscript` from a product RT-Thread project. Firmware
compile and KitProg3 flash stay in the
[PocketJS_for_Edgi-Talk](https://github.com/1024971823/PocketJS_for_Edgi-Talk)
overlay — this host does not vendor BSP patches, BT firmware, or flash scripts.

## Prerequisites

- [Bun](https://bun.sh/) and the Pocket CLI (`bun tools/pocket.ts` from this repo,
  or `pocket` on `PATH`)
- Optional, only if changing Rust native UI/render crates: Rust toolchain with
  target `thumbv8m.main-none-eabihf` (`rustup target add thumbv8m.main-none-eabihf`)
- Sibling [quickjs-ng](https://github.com/quickjs-ng/quickjs) checkout (override
  with `POCKETJS_QUICKJS_ROOT`)
- RT-Thread BSP for Edgi-Talk / PSoC E84, plus the overlay from
  [PocketJS_for_Edgi-Talk](https://github.com/1024971823/PocketJS_for_Edgi-Talk)

## 1. Build the `.pocket` package

From the **pocketjs** repo root (this fork):

```sh
bun tools/pocket.ts build \
  --host-profile apps/edgitalk-m55-smoke/pocket.host.json \
  --manifest apps/edgitalk-m55-smoke/pocket.json
```

Output: `apps/edgitalk-m55-smoke/dist/edgitalk-m55-smoke.pocket`.

`pocket.host.json` still uses `platform: "esp-idf"` (borrow of `pocket-idf-host-1`).
The Pocket CLI does **not** yet register `platform: "rt-thread"`. Tracking:
https://github.com/1024971823/pocketjs/issues/2 — see
[`HOST_PROFILE.md`](../../../apps/edgitalk-m55-smoke/HOST_PROFILE.md).

Rebuild the package after UI / chart / asset changes before flashing.

Admission path is the same as ESP: host profile → package `PHST` / HostOps checks
at `pocketjs_package_select`. Product `__edgi` (dashboard / music / game natives)
stays outside PocketJS core — installed by the overlay on the guest `JSContext`,
same pattern as ESP product extensions.

## 2. Rust static libs (M55 native script)

Only needed when changing `hosts/esp-idf/native/` (ui-core / render-rgb565). Prefer
the host build script (receipt + toolchain json):

```sh
# Help / planned commands (no rustc required for --help / --dry-run after prereq skip)
bun tools/rt-thread-edgitalk-native.ts --help
bun tools/rt-thread-edgitalk-native.ts --check-prereqs
bun tools/rt-thread-edgitalk-native.ts --dry-run

# Real build (requires cargo + thumbv8m.main-none-eabihf)
rustup target add thumbv8m.main-none-eabihf   # if using rustup
bun tools/rt-thread-edgitalk-native.ts
# optional: --component ui-core|render-rgb565
```

Toolchain receipt: [`../native/toolchains.json`](../native/toolchains.json).
Build receipts: [`../native/receipts/`](../native/receipts/) (example schema
committed; digests gitignored).

Manual equivalent (if you skip the script):

```sh
(cd hosts/esp-idf/native/ui-core && cargo build --release --locked --no-default-features --target thumbv8m.main-none-eabihf)
(cd hosts/esp-idf/native/render-rgb565 && cargo build --release --locked --no-default-features --target thumbv8m.main-none-eabihf)
```

`native/SConscript` adds those `release/` dirs to `LIBPATH` and links
`pocketjs_idf_ui_core` + `pocketjs_idf_render_rgb565`.

## 3. Shared ESP components (do not fork C)

Prefer **sharing** `hosts/esp-idf/components/{package,guest,ui_core,ui_qjs,render_rgb565}`
via the existing SConscript — see [`../components/README.md`](../components/README.md).

## 4. Contracts (honest)

```sh
bun tools/rt-thread-edgitalk-contracts.ts --list
bun tools/rt-thread-edgitalk-contracts.ts --check
```

`--check` reuses the ESP-IDF generated-contract verification for **shared**
headers/crates, then prints RTT-only items as **not yet enforced** (no fake pass).
Spec notes: `contracts/spec/rtt-edgitalk-native.ts`.

## 5. Include the host SCons fragment from the product project

Point the product build at this monorepo (`POCKETJS_ROOT`), then include:

```python
import os
# POCKETJS_ROOT = path to this pocketjs clone (relative or absolute)
SConscript(os.path.join(POCKETJS_ROOT, 'hosts/rt-thread-edgitalk/native/SConscript'))
```

The fragment (paths relative to the pocketjs repo root):

- Compiles shared `hosts/esp-idf/components/{package,guest,ui_core,ui_qjs,render_rgb565}` C sources
- Compiles `native/{pocketjs_host_loop,pocketjs_rt_compat,quickjs_compat}.c`
- Force-includes QuickJS compat headers from `native/include/`
- Links M55 Rust archives under `hosts/esp-idf/native/.../thumbv8m.main-none-eabihf/release`
- Builds QuickJS-ng from `POCKETJS_QUICKJS_ROOT` (default: sibling `../quickjs-ng`)

**Stay in the overlay SConscript:** `pocketjs_wifi*`, `pocketjs_bt*`, game /
synth / music / dashboard, BT firmware `btfw.c`, and product-generated package
blobs. See [`../native/README.md`](../native/README.md).

Env overrides: `POCKETJS_QUICKJS_ROOT`, `POCKETJS_SMOKE_PACKAGE`,
`POCKETJS_DEBUG_TOUCH=1`, `POCKETJS_NATIVE_HOST_LOOP=0`,
`POCKETJS_NATIVE_PACKAGE_STUB=0`.

## 6. Optional headless smoke outline

[`../examples/smoke/`](../examples/smoke/) is a **source outline + README** for a
RAM-framebuffer / fake-present smoke (board-CI later). It does not run on a plain
Linux host without the RT-Thread BSP.

## 7. Firmware + flash

Do **not** copy absolute machine paths here. Follow the overlay docs:

- [编译与烧录.md](https://github.com/1024971823/PocketJS_for_Edgi-Talk/blob/main/projects/Edgi_Talk_M55_PocketJS/docs/%E7%BC%96%E8%AF%91%E4%B8%8E%E7%83%A7%E5%BD%95.md)
- Sibling docs in
  [`projects/Edgi_Talk_M55_PocketJS/docs/`](https://github.com/1024971823/PocketJS_for_Edgi-Talk/tree/main/projects/Edgi_Talk_M55_PocketJS/docs)

Typical flow:

1. Build `.pocket` as above from pocketjs.
2. Run the overlay firmware build for `Edgi_Talk_M55_PocketJS` (embeds the package).
3. Flash M55 with the KitProg3 script (`M55_PROJECT=Edgi_Talk_M55_PocketJS`).

## Upstream proposal (P3)

Honest prep for a future pocket-nexus discussion — **not** an opened upstream PR:

- [`upstream-proposal.md`](upstream-proposal.md) — what Edgi runs, in/out of scope, asks (native target, Registry policy, docs, `pocket-rtt-host-1`, OSAL)
- [`upstream-pr-body.md`](upstream-pr-body.md) — ready-to-paste draft body for a **future** PR to pocket-nexus

Fork tracking: [PR #1](https://github.com/1024971823/pocketjs/pull/1), [issue #2](https://github.com/1024971823/pocketjs/issues/2).
