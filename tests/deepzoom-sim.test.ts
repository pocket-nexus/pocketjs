// tests/deepzoom-sim.test.ts — the deep-zoom pipeline under the deterministic
// sim host (docs/DETERMINISM.md), driving the zoomlab viewer end to end: baked
// TILESET pak entries -> framework/src/tiles.ts fallback (PackBits decode + PSM_T8
// upload) -> generation-tagged texture streaming/freeing -> the DeepZoom
// per-tick integrator -> the wasm CLUT8 + bilinear rasterizer.
//
// The journey holds the right trigger (zoom in past two mip switches), then
// pans left on the analog nub to the poster's concentric rings, then releases
// into the momentum glide. Events sit on the 1 s grid so they land on exact
// frames at every tested hz.

import { describe, expect, test } from "bun:test";
import { runScenario, type Trace } from "../programs/sim/sim.ts";
import { BTN, SCREEN_H, SCREEN_W } from "../contracts/spec/spec.ts";

const JOURNEY = [
  { at: 1, hold: BTN.RTRIGGER }, // zoom in for 2 s (~12% -> 100%)
  { at: 3, hold: 0 },
  { at: 3, analog: 0x0080 }, // nub full left toward the rings
  { at: 6, analog: 0x8080 }, // release -> momentum glide, then settle
];
const SECONDS = 8;

const scenario = (hz: number) => ({ app: "zoomlab-main", hz, seconds: SECONDS, script: JOURNEY });

const t60: Trace = await runScenario(scenario(60));

describe("deep-zoom determinism", () => {
  test("repeat runs are hash-identical", async () => {
    const again = await runScenario(scenario(60));
    expect(again.hashes).toEqual(t60.hashes);
  });

  test("chaos (sleeps + garbage + GC) changes nothing", async () => {
    const chaos = await runScenario(scenario(60), { maxSleepMs: 3, gcEvery: 40 });
    expect(chaos.hashes).toEqual(t60.hashes);
  }, 30000);

  test("the settled view is byte-equal across simulation rates", async () => {
    // The DeepZoom integrator runs once per 1/60 s tick regardless of the
    // frame rate, so a low-hz world lands on the same center/zoom and, once
    // the tile streamer catches up, the same pixels.
    for (const hz of [15, 5]) {
      const low = await runScenario(scenario(hz));
      expect(Buffer.compare(Buffer.from(low.finalFrame), Buffer.from(t60.finalFrame))).toBe(0);
    }
  }, 30000);

  test("the journey actually went somewhere (zoomed + panned)", () => {
    // First frame (fit view) and settled frame must differ, and the settled
    // frame must show real document ink, not just the HUD bar: the poster
    // background is light gray (0xe8), its rings/cards are saturated inks —
    // count pixels far from the background gray, EXCLUDING the dark HUD rows
    // at the bottom so the bar alone can never satisfy the check.
    expect(t60.hashes[0]).not.toEqual(t60.hashes[t60.hashes.length - 1]);
    let ink = 0;
    const fb = t60.finalFrame;
    const hudTop = SCREEN_H - 28; // the app's h-7 HUD bar
    for (let y = 0; y < hudTop; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        const i = (y * SCREEN_W + x) * 4;
        if (Math.abs(fb[i] - 0xe8) > 24) ink++;
      }
    }
    expect(ink).toBeGreaterThan(5000);
  });
});
