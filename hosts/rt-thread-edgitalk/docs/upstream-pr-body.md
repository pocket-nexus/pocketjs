# Draft PR body — pocket-nexus/pocketjs (DO NOT OPEN YET)

Paste into a future PR against **pocket-nexus/pocketjs** only after maintainers
agree to review. This file is a draft; **no PR has been opened upstream**.

---

## Title (suggested)

`draft: add hosts/rt-thread-edgitalk (shared ESP UI stack on RT-Thread / M55)`

## Body

### Summary

Propose a first-class RT-Thread host tree for PocketJS, proven on Edgi-Talk
(PSoC E84, Cortex-M55, HyperRAM, 800×480). Product firmware still owns LCD,
touch, Wi-Fi, and BT — same philosophy as `hosts/esp-idf`.

This PR (when opened) would add reusable host docs, native glue, SCons include,
M55 toolchain/receipt scripting, and shared **consume** of existing
`hosts/esp-idf/components/{package,guest,ui_*,render_rgb565}`. It does **not**
vendor BSP patches, CYW BT firmware, KitProg3 scripts, or product `__edgi` bridges.

Full write-up: `hosts/rt-thread-edgitalk/docs/upstream-proposal.md` (also on fork
[1024971823/pocketjs](https://github.com/1024971823/pocketjs) branch
`host/rt-thread-edgitalk`).

### Motivation

Edgi-Talk already runs package / guest / ui_core / ui_qjs / render_rgb565 on M55
via an overlay. Promoting the reusable pieces into the monorepo avoids forever
forking ESP components and gives pocket-nexus a documented third native target
(`thumbv8m.main-none-eabihf`) or an explicit source-build-only policy.

### In this PR (intended paths)

- `hosts/rt-thread-edgitalk/` — README, docs, `native/`, components sharing policy, optional smoke outline
- Tooling: `tools/rt-thread-edgitalk-native.ts`, `tools/rt-thread-edgitalk-contracts.ts` (names flexible)
- Contracts notes aligned with shared GuestOps/HostOps
- Optional: `apps/edgitalk-m55-smoke/` if maintainers want an in-tree example app (product natives stay out)

### Out of scope (will not be added)

- BSP patches, CYW BT FW, KitProg3 / flash scripts
- Full RT-Thread board project / Infineon-specific bring-up
- Product Wi-Fi / BT / game / `__edgi` APIs

### Asks for reviewers

1. Accept or rename host directory (`rt-thread-edgitalk` vs generic `rt-thread`).
2. Native target: document `thumbv8m.main-none-eabihf` **or** mark source-build only (no Registry archives).
3. Docs: `/docs/rt-thread/` (or equivalent).
4. Host profile: path toward `pocket-rtt-host-1` / `platform: "rt-thread"` (today apps still borrow `pocket-idf-host-1` — tracked on the fork).
5. Preference: reduce `esp_err` / `heap_caps` coupling upstream vs bless a thin host OSAL.

### Test plan

- [ ] `bun tools/rt-thread-edgitalk-native.ts --help` / `--check-prereqs` (and build if CI has Rust M55 target)
- [ ] `bun tools/rt-thread-edgitalk-contracts.ts --check` (shared ABIs; RTT-only items honest)
- [ ] Docs link check; no absolute private machine paths
- [ ] Confirm no BT blobs / BSP patches in the diff
- [ ] Hardware gates (frame hash, heap, present cadence @ 800×480) — follow-up, not blocking draft

### Prior art / fork status

- Fork PR: https://github.com/1024971823/pocketjs/pull/1
- Host identity issue: https://github.com/1024971823/pocketjs/issues/2
- Overlay (board only): https://github.com/1024971823/PocketJS_for_Edgi-Talk

P0–P2 on the fork landed app SoT, native glue, shared-component policy, native
script + contracts skeleton. This upstream PR is the P3 ask — not a claim of
Registry/CI parity yet.
