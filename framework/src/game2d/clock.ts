// @pocketjs/framework/game2d — the game clock.
//
// Scripts in a 2D game are long async functions ("say this, wait, fade, fight").
// They wait on this clock, which only advances from the frame callback, so a run
// is a pure function of the input tape on every host. `reset()` drops every waiter
// without resolving it: a chapter jump abandons the running script instead of
// reloading the page, and the abandoned continuation simply never runs again.

export interface Waiter { at: number; resolve: () => void; gated: boolean }

export interface GameClock {
  /** Milliseconds of game time since start (stops while paused). */
  now(): number;
  /** Milliseconds of frame time, paused or not (UI animation). */
  uiNow(): number;
  /** Resolves after `ms` of game time; pause holds it. */
  sleep(ms: number): Promise<void>;
  /** Same but runs during pause (menus, HUD). */
  uiSleep(ms: number): Promise<void>;
  paused: boolean;
  /** Multiplies delays, for test runs (0.01 ≈ instant). */
  speed: number;
  /** Advance one frame of `dtMs`. */
  tick(dtMs: number): void;
  /** Abandon every pending wait. Generation-guard long-lived promises with `generation()`. */
  reset(): void;
  generation(): number;
}

export function createClock(): GameClock {
  let game = 0, ui = 0, gen = 0;
  let waiters: Waiter[] = [];
  const add = (delay: number, gated: boolean) => new Promise<void>((resolve) => {
    waiters.push({ at: (gated ? game : ui) + delay * c.speed, resolve, gated });
  });
  const c: GameClock = {
    paused: false,
    speed: 1,
    now: () => game,
    uiNow: () => ui,
    sleep: (ms) => add(ms, true),
    uiSleep: (ms) => add(ms, false),
    tick(dt) {
      ui += dt;
      if (!c.paused) game += dt;
      let keep = 0;
      const due: Waiter[] = [];
      for (let i = 0; i < waiters.length; i++) {
        const w = waiters[i];
        if ((w.gated ? game : ui) >= w.at) due.push(w); else waiters[keep++] = w;
      }
      waiters.length = keep;
      for (let i = 0; i < due.length; i++) due[i].resolve();
    },
    reset() { waiters = []; gen++; c.paused = false; },
    generation: () => gen,
  };
  return c;
}
