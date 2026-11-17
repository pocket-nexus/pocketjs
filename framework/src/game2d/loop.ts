// @pocketjs/framework/game2d — a fixed-step update loop.
//
// Game logic advances in steps of one fixed length. A frame runs as many steps as the time since
// the previous frame covers, at most `maxSteps`, and carries the remainder to the next frame.
//
// That time is the larger of the wall-clock interval and the frame's virtual interval
// (1 / simulationHz, docs/DETERMINISM.md):
//   - a host that drops to 30 fps runs two steps a frame, so the game keeps full speed;
//   - a 120 Hz display runs a step every other frame, so the game does not run fast;
//   - a driver that steps frames faster than real time (a test, a bot) runs one step per frame,
//     so the run is a function of its input tape.

import { simulationHz } from "../clock.ts";

export interface LoopConfig {
  /** Steps per second. Default 60. */
  hz?: number;
  /** Most steps one frame may run; the rest of a long hitch is dropped. Default 4. */
  maxSteps?: number;
  /** Wall clock in milliseconds. Default `Date.now`. */
  now?: () => number;
}

export interface Loop {
  /** Step length in milliseconds. */
  readonly stepMs: number;
  /** Run this frame's steps: `step(dtMs, first)` per step; `first` marks the step that should see
   *  this frame's input edges. `elapsedMs` overrides the measured interval. Returns the number of
   *  steps run, which can be 0. */
  frame(step: (dtMs: number, first: boolean) => void, elapsedMs?: number): number;
  /** Forget accumulated time and the last wall-clock reading (after a pause or a load). */
  reset(): void;
}

export function createLoop(cfg: LoopConfig = {}): Loop {
  const stepMs = 1000 / (cfg.hz ?? 60), maxSteps = cfg.maxSteps ?? 4, now = cfg.now ?? Date.now;
  let acc = 0, last = -1;
  return {
    stepMs,
    frame(step, elapsedMs) {
      let elapsed = elapsedMs;
      if (elapsed === undefined) {
        const t = now(), wall = last < 0 ? 0 : t - last, virtual = 1000 / simulationHz();
        last = t;
        elapsed = wall > virtual ? wall : virtual;
      }
      acc += elapsed > 0 ? (elapsed < stepMs * maxSteps ? elapsed : stepMs * maxSteps) : 0;
      let n = Math.floor(acc / stepMs);
      if (n > maxSteps) n = maxSteps;
      acc -= n * stepMs;
      for (let i = 0; i < n; i++) step(stepMs, i === 0);
      return n;
    },
    reset() { acc = 0; last = -1; },
  };
}
