# Determinism: the virtual clock, the effect shell, and the sim host

PocketJS's frame contract makes every app a pure fold over its inputs:

```
state[n+1] = F(state[n], input[n])
pixels[n]  = G(state[n])
```

One `frame(buttons)` call is one **transaction**: clock advance, effect
deliveries, app hooks, input edge-detection, Solid effects, sweep, then
`60/hz` core ticks. Nothing else can touch the world — no wall clock, no
microtask races, no mid-frame callbacks. Same tape in, same trajectory out,
byte for byte. This document covers the three pieces that make the fold
airtight and testable: the **virtual clock**, the **effect shell**, and the
**deterministic sim host**. `tests/sim.test.ts` proves each claim in CI;
`tools/flake-lab.ts` is the control experiment showing what happens to the
same app under a wall clock.

## The virtual clock (`@pocketjs/framework/clock`)

Time is the frame counter. The **simulation rate** — virtual frames per
second — is a *host policy*, not app code:

```
hardware refresh   PSP vblank / browser rAF / none (headless CI)   → pacing only
virtual rate (hz)  1..60, must divide 60                           → the world's clock
core ticks         60 per virtual second, exactly FIXED_DT each    → unchanged, byte-exact
```

A virtual frame at rate `hz` is one JS `frame()` transaction plus `60/hz`
core ticks. The core never changes: ms-based animations, transitions and
baked timelines cover the same **virtual time** at every rate — a 300 ms
tween is 300 ms at 60 Hz and 300 ms at 2 Hz, just sampled coarser.

The 60 above is the **spec default tick rate**, not a constant of the model:
a realm may declare another whole rate (1..240) before its first tick
(`Ui::set_tick_rate`; `tools/build.ts --hz` bakes the same rate into the
bundle), and the step stays fixed at `1/hz` s for the whole run — the frame
counter remains the only clock. The declared rate is part of the mount
contract: the host publishes it as `ui.__tickHz` and a bundle refuses a host
driving any rate but the one it was built with. Everything this document
derives holds per realm with 60 read as that realm's rate; the committed
goldens and tapes all run the default.

Hosts publish the policy as `globalThis.__simHz` before the bundle evals
(web host: `?hz=2`; sim host: scenario option; PSP: standalone packages at
60, multi-app packages at 20). Apps read time through the clock API and stay
hz-portable by expressing time in seconds, never raw frame counts:

```ts
import { after, virtualNow, simulationHz } from "@pocketjs/framework/clock";

after(1.5, () => setPhase("menu")); // fires 1.5 VIRTUAL seconds out —
// frame 90 at 60 Hz, frame 3 at 2 Hz, the same instant of the same journey.
```

`after()` is the deterministic replacement for `setTimeout`: its deadline is
a frame index, its firing order is (deadline, insertion order), and it holds
no reference to the wall clock at all.

**The subsampling theorem** (proved per-frame in `tests/sim.test.ts`): for an
app whose JS state changes only on events and virtual time (no per-frame
counters), the hz-world is not an approximation of the 60 Hz world — it *is*
the 60 Hz trajectory, strictly subsampled:

```
pixels_hz[m] == pixels_60[(60/hz)(m+1) - 1]     for every frame m
```

A 6.5-second journey is 390 observations at 60 Hz and 13 at 2 Hz — same
trajectory, same final screen, byte-equal. That is what makes the low-rate
world the natural habitat for agents and CI: ~30× less to record, replay,
and look at, with nothing semantic lost.

Frame-counted APIs (`onFrame` counters, sprite `frameStep`) are per-rate by
definition — an app that hard-codes "on frame 37" means something different
at each hz. That is a documented boundary, not a bug; write seconds.

## The effect shell (`@pocketjs/framework/effects`)

Buttons were already part of `input[n]`. The effect shell makes *everything
else* part of it too. An app never awaits a promise and never registers a
native callback:

```ts
import { runEffect, installEffectDriver } from "@pocketjs/framework/effects";

runEffect<Receipt>("order", { items }, (receipt) => setReceipt(receipt));
```

A command goes out; the result comes back as a **frame-boundary delivery** —
queued whenever the driver produces it, applied at the start of the next
virtual frame, before app hooks, FIFO. Physics events (`ui.physics`) enter
the same way: the core records them during the ticks of frame N, and the
service pump drains and dispatches them at the start of frame N+1. Deliveries are data in the frame
transaction, not scheduler weather. The API is callback-based on purpose:
promise resolution is timed by the microtask queue, which is a hidden input
owned by the JS scheduler — exactly what the shell exists to exclude.

Drivers do the real work, and are swappable per host:

- an app-installed driver (`installEffectDriver`) — e.g. the café demo's
  fake backend, which answers in *virtual seconds* via `after()`, making the
  whole app a closed deterministic system on every host including the PSP;
- a host-injected driver (`globalThis.__pocketEffectDriver`, wins) — how a
  harness takes over any bundle: replay a recorded effect tape, or
  deliberately deliver on wall-clock timers (`tools/flake-lab.ts`).

A run's effect activity is observable through `globalThis.__pocketEffectTrace`
— every command and delivery with its frame index. That trace plus the input
tape is the complete causal record of a session.

## The sim host (`hosts/sim/sim.ts`)

A PocketJS host with no screen, no vblank, and no wall clock — it drives
virtual frames as fast as the CPU allows and records everything:

```ts
import { runScenario } from "./hosts/sim/sim.ts";

const trace = await runScenario({
  app: "cafe-main",
  hz: 2,                    // the 2 FPS agent world
  seconds: 6.5,             // 13 virtual frames
  script: [                 // input in virtual SECONDS — one journey, every rate
    { at: 1.0, press: BTN.CIRCLE },
    { at: 3.5, press: BTN.START },
  ],
});
trace.hashes;    // FNV-1a of the framebuffer after every frame
trace.effects;   // every command/delivery with its frame index
trace.tree;      // DevTools component tree after the final frame
trace.finalFrame // raw RGBA, for byte comparison across rates
```

Assertions are equality on traces. A "flake" is impossible by construction,
and `tests/sim.test.ts` demonstrates it the hard way: chaos mode injects real
wall-clock sleeps, allocation churn and forced GC between frames — the trace
must not change by one bit (and doesn't).

The 60 Hz café journey (390 frames, full per-frame pixel hashing) replays in
well under a second — a 6.5-second user session, verified pixel-perfect,
faster than one frame of the real thing takes to show.

`bootWorld()` owns the process-global guest slots used by an evaluated bundle.
**One Bun realm has one active simulated world.** Sequential boots are
supported; a successful boot supersedes the previous world, and calls through
its methods throw a `superseded by a newer boot` error. If boots overlap, the
newest request wins and an older request in its load phase rejects before it
can install globals. **A failed candidate restores the active world's global
descriptors, console bridge, and DOM-constructor properties.** Concurrent
worlds require separate processes or realms.

**`world.render()` returns a borrowed view of that world's wasm framebuffer.**
Any later call into the same wasm instance may grow linear memory and detach
that view. Consume the pixels before the next world call, or retain a copy from
`world.render().slice()`.

## The control experiment (`tools/flake-lab.ts`)

One bundle, one journey, two clocks:

- **Runtime W** paces the same 60 Hz world with real `setTimeout` (rAF-style
  accumulator, timer jitter, occasional injected stalls) and delivers the
  order result on real wall-clock timers with network-like jitter. This is a
  normal day for a browser test — nothing exotic.
- **Runtime V** is the sim host.

Both measure the frame at which the order confirmation enters the world, and
a Playwright-style assertion ("confirmation visible by t=2.5 s"). W produces
a *distribution* of delivery frames and a partial assertion pass rate; V
produces one frame index, every run, forever. Same code. The only difference
is what "time" means.

## What this does NOT claim

- A 2 Hz run validates the 2 Hz world's semantics; it does not re-verify
  every per-frame detail of the 60 Hz world (the subsampling theorem covers
  shared points, not the frames in between — those are covered by running at
  60 Hz, which is just as deterministic).
- Determinism ends where an unrecorded input enters. A LIVE network driver
  is nondeterministic by nature — record its deliveries (frame + payload)
  and replay the tape; the *replay* is then exact. The shell is what makes
  that recording complete.
- `Math.random()`, `Date.now()` and friends are not fenced off by the
  runtime. The contract is: express randomness as seeded state and time as
  the virtual clock. The café demo needs neither.
