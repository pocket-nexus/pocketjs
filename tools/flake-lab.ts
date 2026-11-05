// tools/flake-lab.ts — the control experiment (docs/DETERMINISM.md, and the
// "Time Is an Input" post): ONE app bundle, ONE user journey, TWO clocks.
//
// Runtime W ("wall") drives the café app the way ordinary UI runtimes run
// apps: a rAF-style accumulator loop paced by real setTimeout (with the
// timer jitter every OS delivers), occasional injected main-thread stalls
// (the GC/raster/contention pauses every real machine has), and network
// latency delivered by real wall-clock timers with jitter. Nothing here is
// exotic — this is a NORMAL day for a browser test.
//
// Runtime V ("virtual") runs the identical bundle and journey through the
// deterministic sim host: the same 60 Hz world, but time is the frame
// counter and the backend answers in virtual seconds.
//
// Both runtimes measure the same two things:
//   - the frame index at which the order confirmation ENTERS the world
//     (the effect shell's delivery event for kind "order"), and
//   - a Playwright-style assertion: "the confirmation is visible by t=2.5s".
//
//   bun tools/flake-lab.ts [--runs 60] [--out dist/flake-lab.json]
//
// Expected shape of the result: W's delivery frame is a DISTRIBUTION and its
// assertion sometimes fails; V's delivery frame is one number, every run.
// Same code. The only difference is what "time" means.

import { writeFileSync } from "node:fs";
import { bootWorld, runScenario } from "../programs/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";

const RUNS = Number(argValue("--runs") ?? 60);
const OUT = argValue("--out") ?? new URL("../dist/flake-lab.json", import.meta.url).pathname;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// The journey, in seconds since boot (wall seconds in W, virtual in V):
// add the autofocused espresso, place the order.
const JOURNEY = [
  { at: 1.0, press: BTN.CIRCLE },
  { at: 1.4, press: BTN.START },
];
const RUN_SECONDS = 3.2;
const ASSERT_AT_MS = 2500; // "confirmation visible by 2.5 s"

// W's network model: the same base latencies the virtual backend uses, plus
// the jitter a real network has. menu 0.5s ± 150ms, order 1.0s ± 350ms.
const JITTER_MS: Record<string, number> = { menu: 150, order: 350 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RunResult {
  deliveryFrame: number;
  deliveryMs: number; // wall ms in W, virtual ms in V
  assertPass: boolean;
}

// ---------------------------------------------------------------------------
// Runtime W: the wall-clock runtime
// ---------------------------------------------------------------------------

async function runWall(): Promise<RunResult> {
  let t0 = 0;
  let order: { frame: number; ms: number } | null = null;
  const world = await bootWorld("cafe-main", 60, {
    // Real-time effect delivery: latency arrives whenever the OS timer fires.
    __pocketEffectDriver: (
      cmd: { kind: string; payload: unknown },
      deliver: (r: unknown) => void,
    ) => {
      const backend = (globalThis as Record<string, never>).__cafeBackend as {
        respond: (kind: string, payload: unknown) => unknown;
        latencySeconds: (kind: string) => number;
      };
      const ms = backend.latencySeconds(cmd.kind) * 1000 + Math.random() * (JITTER_MS[cmd.kind] ?? 0);
      setTimeout(() => deliver(backend.respond(cmd.kind, cmd.payload)), ms);
    },
    __pocketEffectTrace: (e: { t: string; kind: string; frame: number }) => {
      if (e.t === "delivery" && e.kind === "order" && !order) {
        order = { frame: e.frame, ms: performance.now() - t0 };
      }
    },
  });

  // A rAF-accumulator main loop on a normal machine: ~16.7 ms wakeups with
  // timer jitter, catch-up steps capped at 4, and the occasional stall.
  t0 = performance.now();
  const applied = new Set<number>();
  let last = t0;
  let acc = 0;
  const STEP = 1000 / 60;
  while (performance.now() - t0 < RUN_SECONDS * 1000) {
    const stall = Math.random() < 0.03 ? 40 + Math.random() * 80 : 0;
    await sleep(STEP + Math.random() * 6 + stall);
    const now = performance.now();
    acc += Math.min(now - last, 250);
    last = now;
    let steps = 0;
    while (acc >= STEP && steps < 4) {
      let mask = 0;
      JOURNEY.forEach((ev, i) => {
        if (!applied.has(i) && ev.at * 1000 <= now - t0) {
          applied.add(i);
          mask |= ev.press;
        }
      });
      world.frame(mask);
      world.tick();
      acc -= STEP;
      steps++;
    }
  }
  if (!order) return { deliveryFrame: -1, deliveryMs: Infinity, assertPass: false };
  const o = order as { frame: number; ms: number };
  return { deliveryFrame: o.frame, deliveryMs: o.ms, assertPass: o.ms <= ASSERT_AT_MS };
}

// ---------------------------------------------------------------------------
// Runtime V: the virtual-clock runtime
// ---------------------------------------------------------------------------

async function runVirtual(): Promise<RunResult> {
  const trace = await runScenario({ app: "cafe-main", hz: 60, seconds: RUN_SECONDS, script: JOURNEY });
  const d = trace.effects.find((e) => e.t === "delivery" && e.kind === "order");
  if (!d) return { deliveryFrame: -1, deliveryMs: Infinity, assertPass: false };
  const ms = (d.frame / 60) * 1000;
  return { deliveryFrame: d.frame, deliveryMs: ms, assertPass: ms <= ASSERT_AT_MS };
}

// ---------------------------------------------------------------------------

function summarize(name: string, results: RunResult[]) {
  const frames = results.map((r) => r.deliveryFrame);
  const pass = results.filter((r) => r.assertPass).length;
  const hist: Record<number, number> = {};
  for (const f of frames) hist[f] = (hist[f] ?? 0) + 1;
  console.log(
    `${name}: ${results.length} runs — delivery frame ` +
      `min ${Math.min(...frames)} / max ${Math.max(...frames)}, ` +
      `${Object.keys(hist).length} distinct value(s); ` +
      `assertion "visible by ${ASSERT_AT_MS} ms" passed ${pass}/${results.length}`,
  );
  return { frames, hist, assertPass: pass, runs: results.length };
}

console.log(`flake-lab: ${RUNS} runs per runtime (wall runs take ~${RUN_SECONDS}s each)…`);
const wall: RunResult[] = [];
for (let i = 0; i < RUNS; i++) wall.push(await runWall());
const virt: RunResult[] = [];
for (let i = 0; i < RUNS; i++) virt.push(await runVirtual());

const summary = {
  runs: RUNS,
  assertAtMs: ASSERT_AT_MS,
  journey: JOURNEY,
  wall: summarize("wall   ", wall),
  virtual: summarize("virtual", virt),
};
writeFileSync(OUT, JSON.stringify(summary, null, 2) + "\n");
console.log(`flake-lab: wrote ${OUT}`);
