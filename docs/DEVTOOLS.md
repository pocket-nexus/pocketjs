# Pocket DevTools — time travel + inspection as framework primitives

PocketJS is a **closed, deterministic world**: the core ticks a fixed 1/60 s
step (`spec.FIXED_DT`), animation clocks count frames (never wall time), the
runtime bans schedulers/RNG/wall-clock, and the *entire* per-frame input is one
PSP button bitmask passed through `globalThis.frame(buttons)`. Frame content is
a pure function of frame index — that is already what byte-exact goldens rely
on.

DevTools turns that property into debugging capabilities that open-world
frameworks (browser, RN, Flutter) structurally cannot offer:

- **The input tape IS the app state.** Record one `u16` per frame (10 min ≈
  70 KB) and any session is reproducible byte-for-byte — on another host, on
  another build, in CI.
- **A bug report is executable.** `pak + tape + frame index` replays to the
  exact pixel; the same artifact becomes a regression test.
- **Inspection works on the real device.** The highlight overlay is emitted by
  the core into the DrawList, so every backend (sceGu on hardware, the wasm
  software rasterizer, wgpu) renders it for free.

```
┌ DevTools panel (hosts/web/devtools.html) ┐
│ tree · highlight · tape · REPL · logs   │
└──────────────┬──────────────────────────┘
               │ WebSocket  ws://127.0.0.1:8130/ws  (role=panel)
        ┌──────┴──────┐
        │  WS hub     │  hosts/web/serve.ts (dumb JSON-line relay)
        └──────┬──────┘
               │ (role=device)
   ┌───────────┼─────────────────────────────┐
   │ browser   │ headless Bun                │ real PSP
   │ engine.js │ in-process transport        │ tools/devtools-psp.ts bridge
   │ WS client │ (tests + tools/tape.ts)   │   ⇅ usbhostfs (PSPLINK USB)
   │           │                             │ host0:/pocketjs-dbg/{in,out}.jsonl
   └───────────┴─────────────────────────────┘
        all three feed the same runtime shim: framework/src/devtools.ts
```

## Layers

### 1. Core (Rust, spec ops 18–22)

New spec ops — added to `contracts/spec/spec.ts` `OP`, regenerated into
`engine/core/src/spec.rs`, implemented on `Ui`, and exposed by both host bindings
(`hosts/psp/src/ffi.rs`, `engine/wasm/src/lib.rs`). All are **debug-only, default-off,
and unused by tests/goldens**, so shipped behavior is unchanged.

| op | JS (`ui.*`) | semantics |
|---|---|---|
| 18 | `debugInspect(id)` | set (0 = clear) the inspected node. During the next paint walk the core captures the node's **world AABB** (transforms, 3D-adjacent 2.5D path, scroll — whatever the walker composed) and appends a highlight overlay (translucent fill + 2 px edges, screen-space `RECT` ops) after all normal emission, on top, outside any scissor. |
| 19 | `debugRectXY() -> i32` | packed `x \| y<<16` (i16 halves) of the last captured world AABB; `-1` if none was painted. |
| 20 | `debugRectWH() -> i32` | packed `w \| h<<16` of the same AABB. |
| 21 | `debugPause(on)` | freeze the world: `Ui::tick()` becomes a no-op (frame counter, tracks, timelines, sprites all hold). `draw()` still runs, so the highlight stays live while paused. |
| 22 | `debugStep()` | arm exactly one tick while paused. |

Pause lives in the core because hosts call `tick()` unconditionally (the PSP
main loop is Rust; JS cannot intercept it). The JS shim gates its side (frame
hooks, input dispatch, tape) symmetrically, so a paused world is *fully*
quiescent and a step advances everything by exactly one frame.

### 2. Runtime shim (`framework/src/devtools.ts`)

Compiled into every bundle (a few KB, zero-cost branches when disabled).
`mount()` wraps its frame handler through the shim:

```
poll transport → flush outbox → (paused? maybe step : record + run frame)
```

- **Flight recorder (always on, even with no transport):** every frame's mask
  goes into a `Uint16Array` ring (36 000 frames ≈ 10 min ≈ 72 KB). Any crash
  or "what just happened?" moment can be exported after the fact.
- **Component tree:** serialized from the existing JS mirror roots
  (`NodeMirror`), so reads never cross FFI. **A multi-display host reports the
  primary and auxiliary roots together under one DevTools-only `Displays`
  group; the native roots remain independent and node statistics cover both.**
  Semantic names come from
  (a) a `debugName` prop on any host component and (b) the `<Named
  name="MessageCard">` wrapper (tags the mirror nodes it renders) — both
  first-class framework API, exported from `@pocketjs/framework`.
  Mutation hooks in `native-tree.ts` mark the tree dirty; snapshots are
  throttled (≥ 30 frames apart) and sent only when dirty.
- **REPL:** `eval` runs in the app's global scope between frames — the world
  is quiescent there (microtasks drained), which is the honest granularity for
  a retained-mode UI. Results are safe-stringified (depth-capped).
- **Console bridge:** when a transport is up, `console.log/warn/error` mirror
  to the channel. On PSP — which has *no* console today (`framework/src/prelude.ts`
  stubs it) — this is the first working `console.log` on hardware.
- **Errors:** exceptions thrown inside the frame are reported to the channel
  (with the current frame index — which, with the tape, makes them
  reproducible), then rethrown.

### 3. Transports

The shim needs only `{ send(line), recv() -> line | null }`:

- **Browser / desktop:** `hosts/web/engine.js` connects a WebSocket to the dev
  server (`/ws?role=device`) and injects the transport before the bundle
  evaluates. Latency: same-frame.
- **Real PSP over the PSPLINK USB cable:** a file mailbox on the usbhostfs
  share — the exact channel trace/bench already use. `hosts/psp/src/dbg.rs`
  reads `host0:/pocketjs-dbg/in.jsonl` from a running offset and appends to
  `out.jsonl`; QuickJS sees `ui.__dbgPoll()` / `ui.__dbgSend()`. Enabled only
  if `host0:/pocketjs-dbg/enable` exists at boot (one failed `sceIoOpen` and
  the app never touches IO again — zero cost without PSPLINK). The shim polls
  every 10 frames on PSP (~166 ms hover latency; each poll is a few USB
  round-trips). `tools/devtools-psp.ts` bridges the mailbox to the WS hub.
  The same mailbox works under the PPSSPP GUI via the `ms0:` fallback path.
- **Nintendo 3DS over Wi-Fi:** Pocket Runtime listens on a paired TCP
  connection. `bun run 3ds:dev pair --host <ip>` installs the one-time 32-byte
  key through ftpd. After that, `bun run 3ds:dev dev --app <app>` discovers the
  paired Runtime over UDP and bridges the existing JSON-line control protocol
  directly to the panel. `--host <ip>` remains available when LAN broadcast is
  unavailable. **`L+R+SELECT` opens a Runtime-owned menu on the 3DS bottom
  screen with its IP, pairing and connection state, generation, package hash,
  and counters.** The host replaces the bottom guest DrawList with its own menu
  DrawList and blocks guest input until the menu keys are released; it is not
  an application capability. **The desktop `dev` command waits for a paired
  Runtime, reconnects after a Wi-Fi interruption, and rediscovers the same
  pairing-derived device ID if its DHCP address changed. `.pocket` updates and
  dual-screen RGB8 captures use bounded binary frames on the same
  ordered TCP connection and never enter QuickJS. A missing PONG closes a
  half-open desktop socket after eight seconds.** The TCP and UDP listeners
  are absent when `sdmc:/pocketjs/runtime/dev.key` is absent. Package updates
  reuse the Runtime's target/ABI admission, immutable storage,
  retired-frame acceptance and rollback path. **The pairing key authenticates
  but does not encrypt the LAN connection. The channel updates `.pocket`
  guests; native `.3dsx` or CIA host changes still require deployment and
  restart.**
- **Native desktop (macOS et al., `pocket-ui-wgpu`):** the same file mailbox,
  minus the USB cable — `engine/crates/pocket-ui-wgpu/src/dbg.rs` is the
  std twin of the PSP transport. Probed once at `UiSurface::mount`: root =
  `$POCKETJS_DBG_DIR`, else the process cwd; active only if
  `pocketjs-dbg/enable` exists. Arm it with `bun run devtools --dir <root>`
  (an explicit `--dir` always beats a detected PSPLINK session), then launch
  the host from that cwd. Tree, highlight, pause/step, eval, and tapes work
  identically. Hosts without a native screenshot path return a warning.
- **Headless (tests, `tools/tape.ts`):** an in-process queue pair. The CLI
  and the test suite are just DevTools clients — the whole protocol is
  drivable without a screen.

### 4. Protocol (JSON lines, panel ⇄ device via the hub)

Panel → device:
`{t:"inspect", id}` · `{t:"pause"}` · `{t:"resume"}` · `{t:"step"}` ·
`{t:"getTree"}` · `{t:"eval", id, code}` · `{t:"dumpTape"}` ·
`{t:"devStats"}` (device diagnostic counters + build identity, OP.debugStats) ·
`{t:"seek", frame}` / `{t:"replay", tape}` (handled by the *host*, not the
shim: the browser host reloads the demo and fast-forwards tick-only — no
render — to the target frame, then pauses).

Device → panel:
`{t:"hello", app, host, frame}` ·
`{t:"tree", frame, root:{i,t,n?,c?,x?,k:[…]}}` (id/type/name/class/text/kids) ·
`{t:"inspect", id, rect:[x,y,w,h]|null}` ·
`{t:"stats", frame, nodes, tapeLen, paused}` ·
`{t:"devStats", frame, data}` (data: `{app, bundle, audio:{starved, reserveGiveups,
lastReserveErr, releaseTimeouts, pushedFrames}, vid:{presented, torn, lapped,
epochs, hdrFails, bytes}, svc:{truncResets}}` from hosts/psp/src/stats.rs, or
null when the host lacks the op; `bundle` is the FNV-1a64 of the embedded
js+pak — the PSPLINK bridge requests this on every hello and compares it
against `dist/` via tools/bundle-hash.ts, flagging a stale embed loudly) ·
`{t:"log", level, args}` · `{t:"error", frame, message, stack?}` ·
`{t:"evalResult", id, ok, value}` ·
`{t:"tape", tape:{v:1, app, frames, masks:[[mask,count],…]}}` (RLE).

The hub (`hosts/web/serve.ts`) is a dumb relay: device lines go to every panel,
panel lines to every device, plus join/leave notices. No state, no parsing.

### 5. Panel (`hosts/web/devtools.html`)

Component tree (hover → `inspect` → the region lights up **on the device
screen**, PSP included; click → pin + details: type, `debugName`, classes,
world rect) · pause/step/resume · tape strip (input activity per frame, click
→ seek on browser hosts) · record/export/import-replay · REPL with log/error
stream · 📷 on-demand screenshot (`{t:"screenshot"}` → browser hosts answer
with a canvas PNG; the PSP dumps raw VRAM to `pocketjs-dbg/shot.raw`, while the
3DS sends both PICA targets as binary RGB8 chunks. Each bridge converts its
bulk representation to the `{t:"screenshot", frame, data}` PNG the panel
expects. Pixels do not travel in the JSON channel). Served at
`http://127.0.0.1:8130/devtools`.

### 6. One command (`bun run devtools [app]`)

`tools/devtools.ts` owns the whole loop in one process: the dev server
(panel + hub), the mailbox bridge, and — given an app — the PSP session
itself (build the EBOOT, serve `host0:` over usbhostfs, `ldstart` via
pspsh). An already-running `bun psplink` / `bun run hw` session is detected
(pgrep + ps args) and bridged into instead of fought for the cable.
Shortcuts: `o` open panel · `r` rebuild + relaunch · `q` quit. Also exposed
as `pocket devtools` in @pocketjs/cli.

## The agent story (why this is core infrastructure)

An AI agent working on PocketJS cannot look at the screen or feel the d-pad.
Every capability here exists to make debugging questions *answerable from a
terminal*:

- `bun tools/tape.ts replay <app> <tape> --hashes` — deterministic per-frame
  framebuffer hashes; `--png N` renders any frame to a PNG I can actually read.
- `bun tools/tape.ts diff <app> <tape> --against hashes.json` — first
  divergent frame between two builds: a regression bisected to the exact frame
  *and* the exact input history that reaches it.
- `bun tools/tape.ts tree <app> <tape> --at N` — the component tree as JSON
  at any frame, via the same protocol the panel uses.
- Tapes checked into `tests/` become **session goldens**: real interaction
  sequences replayed against every future build.

## Breakpoint feasibility (assessed, deferred)

True line breakpoints in QuickJS on PSP require a bytecode-level debugger hook
(upstream QuickJS has none; the known patches — e.g. quickjs-debugger — add an
opcode-dispatch callback), a DAP-ish protocol on top of the mailbox, and
source maps through the two-pass Babel+Bun build (currently `sourcemap:none`).
All three are tractable (the mailbox transport built here would carry DAP
fine), but it's a multi-week vendored-interpreter change with per-opcode
overhead when armed. **Deferred.** What ships instead covers most UI
debugging at the honest granularity of a retained-mode framework:
frame-boundary pause (the world is quiescent between frames), single-step,
REPL eval over live state, tape time-travel, and console/error streaming from
hardware.

## Roadmap (designed for, not yet built)

I-frame memory snapshots (wasm linear-memory copies every N frames → O(1)
scrubbing; tape frames are the P-frames) · seek-on-PSP (multiple tick-only
steps per vblank ≈ 10× fast-forward) · tape-in-URL for the playground
(replays as shareable content) · causality index (pixel → DrawList op → node →
signal → input edge) · cross-device state teleport (PSP heap → browser wasm).


The optional `rightAnalog` tape track uses the same packed coordinates and RLE
pairs as `analog`. **Absent right-stick samples replay as centered**, including
when live hardware moves during replay. The recorder allocates this track only
after the first noncenter sample. The sixth frame argument carries the raw right
stick; the touch, hit and surface arguments keep their existing positions.

**Relative-axis input uses a sparse `axes` track in v4 tapes.** Each entry is
`[frameIndex, [{ axis, delta }]]`; `delta` is a signed i32 millidegree value.
The seventh frame argument carries these samples. Recordings without axis
motion retain their existing tape version and omit the track. Replay supplies
an empty axis array for absent samples and older tapes, so queued live motion
cannot enter the replay. `tools/tape.ts` reads the same track as the browser
DevTools replay path.

**Fused motion state uses a sparse `motion` track in v5 tapes.** Each entry is
`[frameIndex, MotionState]`, with the state's numbers rounded to f32 and
unsigned (JSON has no -0) as the eighth frame argument delivered them. Recordings without motion retain their
existing tape version and omit the track. Replay owns the track: frames
without a recorded state receive none, so live driver estimates cannot enter
the replay.
