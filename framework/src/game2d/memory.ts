// @pocketjs/framework/game2d — keeping the JS heap small on a handheld.
//
// Reactive UI graphs are cycles, which reference counting cannot free. Measured on a real PSP: a
// turn-based battle produced about 1.5 KB of cycles per frame, and the heap went from 4 MB to 15 MB
// with nothing collecting it, until allocation failed and scripts died silently. One collection of
// a 4 MB heap takes about 140 ms, far too long to hide inside a moving scene.
//
// So: call `safePoint()` where a pause cannot be seen (screen covered by a transition, the game
// waiting for the player) and `frame()` every frame as a backstop that collects anyway once cycles
// pile up past `hardBytes`.

import { packHost } from "./packs.ts";

export interface MemoryGuard {
  /** A pause is invisible right now: collect if enough garbage has built up. */
  safePoint(): void;
  /** Call once a frame. Samples rarely; collects regardless when over the hard limit. */
  frame(): void;
  stats(): { collections: number; forced: number; maxGcMs: number; lastLive: number; peakLive: number };
}

export function createMemoryGuard(o: { softBytes?: number; hardBytes?: number; sampleEvery?: number } = {}): MemoryGuard {
  const soft = o.softBytes ?? 512 * 1024, hard = o.hardBytes ?? 1536 * 1024, every = o.sampleEvery ?? 90;
  const host = packHost();
  const st = { collections: 0, forced: 0, maxGcMs: 0, lastLive: 0, peakLive: 0 };
  let base = 0, tick = 0, armed = false;
  const live = () => { const m = host?.mem?.(); return m ? (JSON.parse(m) as { qjsLive: number }).qjsLive : 0; };
  const collect = () => {
    const us = host!.gc!();
    st.collections++;
    if (us / 1000 > st.maxGcMs) st.maxGcMs = us / 1000;
    base = live(); st.lastLive = base;
    armed = false;
  };
  return {
    safePoint() { if (armed && host?.gc) collect(); },
    frame() {
      if (!host?.gc || !host.mem) return;
      if (++tick < every) return;
      tick = 0;
      const now = live();
      st.lastLive = now; if (now > st.peakLive) st.peakLive = now;
      if (base === 0) { base = now; return; }
      if (now < base) base = now;
      if (now - base > hard) { st.forced++; collect(); }
      else if (now - base > soft) armed = true;
    },
    stats: () => st,
  };
}
