---
name: pocketjs-devtools
description: Debug PocketJS apps with Pocket DevTools — deterministic input-tape time travel, component-tree inspection with on-device highlight, pause/step, REPL eval and console on real PSP hardware over PSPLINK, on-demand screenshots, and headless tape replay for regression evidence. Use when asked to debug UI behavior, reproduce or bisect a visual regression, inspect the component tree, capture device screenshots, or verify a fix against a recorded session.
---

# Pocket DevTools

## Overview

PocketJS is fixed-dt deterministic and its entire per-frame input is one
button bitmask, so a recorded input tape replays any session byte-exactly.
DevTools (design: repo `docs/DEVTOOLS.md`) is built into every bundle: a flight
recorder is ALWAYS on (36 000-frame ring), and a JSON-line debug channel
connects the runtime to a desktop panel over WebSocket (browser host) or the
PSPLINK USB mailbox (real PSP).

Prefer the headless tape workflow for agent debugging — every question is
answerable from the terminal. Use the panel when a human is co-driving.

## Headless workflow (no screen needed)

Keep per-run tapes, hashes, captures, and logs in ignored output. For example:

```bash
mkdir -p .pocket-build/validation/devtools
bun run tape record hero-main --frames 180 --input "5:64,40:8192" --out .pocket-build/validation/devtools/t.json
bun run tape replay hero-main .pocket-build/validation/devtools/t.json --hashes .pocket-build/validation/devtools/h.json
bun run tape replay hero-main .pocket-build/validation/devtools/t.json --assert .pocket-build/validation/devtools/h.json --outdir .pocket-build/validation/devtools
bun run tape replay hero-main .pocket-build/validation/devtools/t.json --png 60,120 --outdir .pocket-build/validation/devtools
bun run tape tree   hero-main .pocket-build/validation/devtools/t.json --at 60
bun run tape:check                                       # committed session golden
```

- Input masks are contracts/spec/spec.ts `BTN` values (`CIRCLE=0x2000=8192`, `DOWN=0x40=64`).
- A regression workflow: record/obtain a tape on the OLD build → `--hashes` →
  switch builds → `--assert` names the exact first frame that changed →
  `--png <that frame>` on both builds to see the difference.
- Tapes exported from ANY host (panel "Export", or `__pocketDevtools.dumpTape()`
  in the REPL) replay headlessly. `startFrame > 0` means the ring wrapped —
  replay is then an approximation (warned automatically).
- Committed session goldens live in `tests/tapes/`; regenerate hashes only when
  a visual change is intended.
- A replay capture or exported session is temporary validation output. Promote
  it to a committed fixture only when a named regression test consumes it.
  Put selected screenshots in PR attachments and keep raw captures, logs and
  receipts outside the tracked tree, following `AGENTS.md`/`CLAUDE.md`.

## Panel workflow (one command)

```bash
bun run devtools            # panel + WS hub + mailbox bridge, one process
bun run devtools cards      # + build, USB-link and launch cards on a real PSP
```

Panel at `http://127.0.0.1:8130/devtools`. `bun run devtools` auto-detects an
already-running `bun psplink` / `bun run hw` usbhostfs session and bridges
into it instead of fighting for the cable (relaunch the app there so it
probes the mailbox at boot). Shortcuts: `o` open panel, `r` rebuild+relaunch
(managed sessions), `q` quit.

Panel capabilities: hover tree → highlight ON THE DEVICE SCREEN (core-drawn
overlay, works on real PSP); click pins; pause/step/resume freeze the whole
world; tape strip with click-to-seek (browser host reloads and deterministically
fast-forwards); REPL evals in the app global scope between frames; 📷
screenshot button downloads a PNG (browser: canvas; PSP: raw VRAM dump over
usbhostfs, converted by the bridge — pixels never cross the JSON channel).

## Native desktop (macOS) specifics

- `pocket-ui-wgpu` hosts (OpenStrike desktop, `engine/pocket3d/examples/uihost`)
  carry the same file-mailbox transport as the PSP, pointed at
  `$POCKETJS_DBG_DIR` (else the process cwd). Workflow: `bun run devtools
  --dir <root> --port 8131` FIRST (explicit `--dir` wins over a running
  PSPLINK session, so a PSP panel and a desktop panel can run side by
  side), then launch the app with that cwd — e.g. `cargo run -p openstrike`
  from the open-strike repo root. The app probes `pocketjs-dbg/enable`
  once at mount, like the PSP boot probe.
- Everything except 📷 screenshots works identically (desktop `__dbgShot`
  is unimplemented; the panel button logs a warning). `hello` reports
  `host:"desktop"` via `ui.__host`.

## Real-PSP specifics

- Transport = `pocketjs-dbg/{enable,in,out}.jsonl` on the usbhostfs share
  (`host0:`). The app probes `enable` ONCE at boot — start the bridge before
  launching the app, or relaunch after. No PSPLINK → zero cost.
- Shim polls every 10 frames on PSP (~166 ms hover latency); every frame on
  other hosts.
- `console.log` on PSP: the shim installs a safe no-op console at mount
  (QuickJS has none) and upgrades it to a channel mirror when a transport
  attaches.
- PPSSPP finds the mailbox via `host0:` = the EBOOT's own directory (so
  `bun run devtools <app>` bridging the target dir works for PPSSPP loading
  that EBOOT too); the `ms0:` fallback also exists (memstick root).

## Protocol quick reference (JSON lines)

Panel→device: `inspect{id}` (0 clears) · `pause` · `resume` · `step` ·
`getTree` · `eval{id,code}` · `dumpTape` · `screenshot` · `seek{frame}` /
`replay{tape}` (browser host-level).
Device→panel: `hello{app,host,frame}` · `tree{root:{i,t,n,c,x,k}}` ·
`inspect{id,rect|null}` · `stats{frame,nodes,tapeLen,paused}` ·
`log` · `error{frame,message}` · `evalResult{id,ok,value}` · `tape{tape}` ·
`screenshot{frame,data}`.

## Gotchas

- `rect: null` / `debugRectXY() === -1` = the node is never painted
  (display:none, detached, or inside a `paint_3d` perspective subtree — 3D
  interiors aren't captured; the perspective ROOT is).
- Adding spec ops: edit `contracts/spec/spec.ts` → `bun contracts/spec/gen-rust.ts` → implement
  on `Ui` + BOTH hosts (`hosts/psp/src/ffi.rs`, `engine/wasm/src/lib.rs`) + `hosts/web/
  wasm-ops.js` + `HostOps` (optional members) — `tests/contract.ts` locks the
  spec halves together.
- `debugName` / `<Named>` are JS-mirror-only: provably zero pixel impact
  (goldens + tape hashes unchanged). Name every function component's root
  element; the tree panel and `tape tree` output read like the source.
- Shim tests live in `tests/devtools.test.ts` (mock ops + in-process
  transport; `--conditions=browser` required). Core pause/inspect tests in
  `engine/core/src/tests.rs`.
- Missing QuickJS symbols (vendored libquickjs-sys is minimal): declare a
  local `extern "C"` block — precedent in `hosts/psp/src/main.rs` and `ffi.rs`.
- NEVER hand VRAM addresses (`0x4xxxxxxx` uncached mirror) to usbhostfs IO:
  its send path runs dcache writeback + USB bulk DMA on the caller's buffer
  and hangs the device on the first 64 KB block (frozen PSP, 0-byte file).
  Bounce through a cached-RAM buffer in chunks (`dbg::shot`). ms0: (Memory
  Stick driver) tolerates VRAM-direct writes — that's why cap_dump_frame
  gets away with it and why PPSSPP won't reproduce the hang.
- The GE writes framebuffer alpha as 0: any raw-framebuffer consumer must
  force alpha opaque (bridge `convertShot`, e2e's `-alpha off`) or the PNG
  renders fully transparent.
- When hardware behavior "mysteriously regresses" after running e2e scripts,
  check WHICH build is on disk before debugging anything else: e2e capture
  specs rebuild the EBOOT/PRX in place, and capture builds
  `sceKernelExitGame()` after their window — reloading one on the PSP looks
  exactly like a freeze/hang a few seconds after boot. Rebuild your intended
  feature set first; only then trust symptoms. (Cost an hour on the
  OpenStrike bring-up: a phantom "mailbox freeze" was a self-exiting e2e
  build the whole time.)
- The whole device-side path (eval, console, screenshot) is testable
  without hardware, at host0: fidelity: **PPSSPP maps the EBOOT's own
  directory as `host0:`**, so a mailbox in
  `hosts/psp/target/mipsel-sony-psp/debug/pocketjs-dbg/` is found by the SAME
  probe hardware uses. Create enable/in/out there, run PPSSPPHeadless with
  a timeout, append commands to in.jsonl mid-run, read out.jsonl. (This
  also means a stale hardware-session mailbox hijacks emulator runs —
  tests/e2e/ppsspp.ts removes it before each golden run.)
