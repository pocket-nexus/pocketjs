// tests/sim.test.ts — the determinism proof (docs/DETERMINISM.md).
//
// Runs the café journey — an async menu fetch, focus navigation, an order
// mutation with latency, a timer-driven auto-dismiss; everything that makes
// ordinary UI tests flake — through the deterministic sim host and asserts
// the architectural claims directly:
//
//   1. IDENTITY    same tape -> byte-identical per-frame pixel trace, run
//                  after run.
//   2. CHAOS       real wall-clock sleeps, allocation churn and forced GC
//                  injected between frames change NOTHING — the wall clock
//                  is not an input to this world.
//   3. LOW HZ      the same journey runs at 4 Hz and 2 Hz (13 frames instead
//                  of 390) and is just as deterministic.
//   4. SUBSAMPLING a low-rate world is not an approximation: frame m of the
//                  hz-world equals frame (60/hz)(m+1)-1 of the 60 Hz world,
//                  byte for byte, for EVERY m.
//   5. ALIGNMENT   effects land at the same virtual second at every rate,
//                  and the settled final screen is byte-equal across rates.

import { describe, expect, test } from "bun:test";
import { runScenario, treeHasText, type Trace } from "../programs/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";

// The user journey, in virtual seconds (one script drives every rate; the
// 0.5 s grid lands on an exact frame at 60/4/2 Hz).
const JOURNEY = [
  { at: 1.0, press: BTN.CIRCLE }, // add ESPRESSO (autofocused row 0)
  { at: 1.5, press: BTN.DOWN }, // focus OAT LATTE
  { at: 2.0, press: BTN.CIRCLE }, // add it
  { at: 3.0, press: BTN.CIRCLE }, // and again (x2)
  { at: 3.5, press: BTN.START }, // place the order
];
const SECONDS = 6.5; // menu@0.5, order placed@3.5, confirmed@4.5, reset@6.0

const scenario = (hz: number) => ({ app: "cafe-main", hz, seconds: SECONDS, script: JOURNEY });

// One shared set of reference traces; individual tests re-run and compare.
const t60: Trace = await runScenario(scenario(60));
const t4: Trace = await runScenario(scenario(4));
const t2: Trace = await runScenario(scenario(2));

describe("determinism", () => {
  test("same tape, same world: repeat runs are hash-identical", async () => {
    for (let i = 0; i < 2; i++) {
      const again = await runScenario(scenario(60));
      expect(again.hashes).toEqual(t60.hashes);
      expect(again.effects).toEqual(t60.effects);
    }
  }, 30000);

  test("chaos cannot reach the world: sleeps + garbage + GC change nothing", async () => {
    const chaos = await runScenario(scenario(60), { maxSleepMs: 8, gcEvery: 60 });
    expect(chaos.hashes).toEqual(t60.hashes);
    expect(chaos.effects).toEqual(t60.effects);
  }, 30000);

  test("the low-rate worlds are deterministic too", async () => {
    expect((await runScenario(scenario(4))).hashes).toEqual(t4.hashes);
    expect((await runScenario(scenario(2))).hashes).toEqual(t2.hashes);
  }, 30000);
});

describe("the virtual clock", () => {
  test("an hz-world is the 60 Hz trajectory, strictly subsampled", () => {
    for (const t of [t4, t2]) {
      const k = 60 / t.hz;
      for (let m = 0; m < t.frames; m++) {
        expect(t.hashes[m]).toBe(t60.hashes[k * (m + 1) - 1]);
      }
    }
    // 6.5 virtual seconds is 390 observations at 60 Hz — and 13 at 2 Hz.
    expect(t60.frames).toBe(390);
    expect(t2.frames).toBe(13);
  });

  test("effects land at the same virtual second at every rate", () => {
    const seconds = (t: Trace) => t.effects.map((e) => ({ t: e.t as string, kind: e.kind, sec: e.frame / t.hz }));
    const want = [
      { t: "command", kind: "menu", sec: 0 },
      { t: "delivery", kind: "menu", sec: 0.5 },
      { t: "command", kind: "order", sec: 3.5 },
      { t: "delivery", kind: "order", sec: 4.5 },
    ];
    expect(seconds(t60)).toEqual(want);
    expect(seconds(t4)).toEqual(want);
    expect(seconds(t2)).toEqual(want);
  });

  test("the settled final screen is byte-equal across rates", () => {
    expect(Buffer.from(t4.finalFrame).equals(Buffer.from(t60.finalFrame))).toBe(true);
    expect(Buffer.from(t2.finalFrame).equals(Buffer.from(t60.finalFrame))).toBe(true);
  });
});

describe("the journey actually happened", () => {
  test("order placed, cart reset, world settled", () => {
    // The trace's tree probe (a DevTools getTree after the final frame) is
    // the sim's selector query — assert on content, not just pixels.
    expect(treeHasText(t60.tree, "ORDERS PLACED 1")).toBe(true);
    expect(treeHasText(t60.tree, "TOTAL $0.00")).toBe(true);
    expect(treeHasText(t60.tree, "OAT LATTE")).toBe(true);
    expect(treeHasText(t2.tree, "ORDERS PLACED 1")).toBe(true);
  });
});
