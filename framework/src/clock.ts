// The virtual clock — the runtime's ONLY notion of time (docs/DETERMINISM.md).
//
// PocketJS time is not the wall clock. It is a frame counter: every host
// drives one `globalThis.frame(buttons)` call per VIRTUAL frame, and the
// world advances `TICKS_PER_SECOND / simulationHz` core ticks per virtual
// frame. `virtualNow()` is derived from that counter, so two runs that see
// the same input tape see the same time — on a PSP, in a browser, or in a
// headless CI process running as fast as the CPU allows.
//
// The simulation rate is a HOST policy, not app code: hosts publish it as
// `globalThis.__simHz` before the bundle evals (the same contract slot as
// `__pak`/`__pocketApp`), and render() latches it. Apps that want to stay
// hz-portable express time in seconds — `after(seconds, cb)` here, ms-based
// animation/transition classes in styles — never in raw frame counts.

// Replaced by tools/build.ts (`--hz=`). `typeof` keeps bundles built by
// anything else, and the test/sim runs that import this module directly,
// valid at the spec rate.
declare const __POCKET_TICK_HZ__: number;

/**
 * Core ticks per second of virtual time. The realm's tick rate is baked into
 * the bundle, so a bundle only runs correctly on a surface driven at the same
 * rate. Spec default is FIXED_DT = 1/60 s per tick; 120 is the ProMotion rate.
 * A number that is not a whole 1..240 rate throws HERE, at boot: downstream,
 * divisorsOf(59.94) is [] and every tick loop would silently no-op.
 */
export const TICKS_PER_SECOND = validTickHz(
  typeof __POCKET_TICK_HZ__ === "number" ? __POCKET_TICK_HZ__ : 60,
);

function validTickHz(hz: number): number {
  if (!Number.isInteger(hz) || hz < 1 || hz > 240) {
    throw new Error(
      `PocketJS: __POCKET_TICK_HZ__ must be an integer from 1 through 240, got ${hz}`,
    );
  }
  return hz;
}

/** The simulation rates that divide the core tick rate exactly. */
export const VALID_HZ: readonly number[] = divisorsOf(TICKS_PER_SECOND);

function divisorsOf(n: number): number[] {
  const out: number[] = [];
  for (let d = 1; d <= n; d++) {
    if (n % d === 0) out.push(d);
  }
  return out;
}

let hz = TICKS_PER_SECOND;
let frame = -1; // advanced to 0 on the first pump; -1 = "before boot frame"
let timerSeq = 0;
interface Timer {
  at: number; // virtual frame index the callback fires on
  seq: number; // insertion order — the tiebreak that keeps firing deterministic
  cb: () => void;
}
let timers: Timer[] = [];
/** No timer is due before this frame. Cancelling leaves it early, which only
 *  costs one extra scan. */
let nextDue = Infinity;

/** Snap an arbitrary rate to the nearest exact divisor of TICKS_PER_SECOND. */
export function normalizeHz(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return TICKS_PER_SECOND;
  let best = VALID_HZ[0];
  for (const v of VALID_HZ) {
    if (Math.abs(v - raw) < Math.abs(best - raw)) best = v;
  }
  return best;
}

/** The active simulation rate in virtual frames per second. */
export function simulationHz(): number {
  return hz;
}

/** Core ticks the host runs per virtual frame (TICKS_PER_SECOND / hz, exact). */
export function ticksPerFrame(): number {
  return TICKS_PER_SECOND / hz;
}

/** The current virtual frame index (0-based; 0 before the first frame). */
export function virtualFrame(): number {
  return frame < 0 ? 0 : frame;
}

/** Virtual seconds elapsed since boot: virtualFrame() / simulationHz(). */
export function virtualNow(): number {
  return virtualFrame() / hz;
}

/**
 * Run `cb` once, `seconds` of VIRTUAL time from now (rounded to the nearest
 * virtual frame, at least one frame away). This is the deterministic
 * replacement for setTimeout: the deadline is a frame index, so it fires at
 * the same point of the same trajectory on every run and every host.
 * Returns a disposer. Not lifecycle-scoped — wrap in onCleanup(after(...))
 * from component code if the owner may unmount first.
 */
export function after(seconds: number, cb: () => void): () => void {
  const t: Timer = {
    at: virtualFrame() + Math.max(1, Math.round(seconds * hz)),
    seq: timerSeq++,
    cb,
  };
  timers.push(t);
  if (t.at < nextDue) nextDue = t.at;
  return () => {
    const i = timers.indexOf(t);
    if (i >= 0) timers.splice(i, 1);
  };
}

/** Fresh clock for a fresh mount; latches the host's `__simHz` policy. */
export function resetClock(): void {
  const raw = (globalThis as { __simHz?: unknown }).__simHz;
  hz = typeof raw === "number" ? normalizeHz(raw) : TICKS_PER_SECOND;
  frame = -1;
  timers = [];
  nextDue = Infinity;
  timerSeq = 0;
}

/**
 * Advance one virtual frame and fire due timers, in (deadline, insertion)
 * order. Called by the frame pump FIRST, before effect delivery and app
 * hooks — "time reached t" happens before anything scheduled at t observes t.
 */
export function __advanceClock(): void {
  frame = frame < 0 ? 0 : frame + 1;
  if (timers.length === 0 || frame < nextDue) return;
  const due = timers.filter((t) => t.at <= frame).sort((a, b) => a.at - b.at || a.seq - b.seq);
  if (due.length > 0) timers = timers.filter((t) => t.at > frame);
  nextDue = Infinity;
  for (const t of timers) if (t.at < nextDue) nextDue = t.at;
  for (const t of due) t.cb();
}
