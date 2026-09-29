// Kinetic scrolling: one axis, one deterministic state machine.
//
// The scroller owns a content offset and integrates it through six states:
//   tracking  finger-follow (gesture pan feeds drag deltas; out-of-bounds
//             travel is rubber-banded with the classic iOS curve)
//   fling     exponential decay from the release velocity
//   spring    edge bounce-back — semi-implicit Euler with the engine's
//             Spring constants (K=170, C=26), CARRYING the incoming velocity
//             (a fling that crosses an edge keeps its momentum into the
//             rubber band). The spring stays in JS because the offset is a
//             reactive cell the app binds, not a node pose; ui.physics
//             anchors are the core's velocity-carrying springs for nodes
//   chase     per-frame ease toward a target — byte-for-byte the apps/im
//             pump (0.3 of the remaining distance, snap under 0.6 px); the
//             d-pad / stick-to-bottom mode
//   tween     programmatic scrollTo with cubic ease-out
//   idle      at rest
//
// The offset is a reactive cell supplied by the per-framework shim (a Solid
// signal in kinetics.ts, a Vue shallowRef in kinetics.vue-vapor.ts); callers
// bind `translateY: -s.offset()` on the content canvas (translate is
// paint-only — one setProp per moving frame, no relayout) and call
// `s.step()` once per frame from onFrame.
//
// Determinism: fling and spring integrate PER CORE TICK (ticksPerFrame()
// iterations of fixed 1/60 s), so a 30 Hz world's trajectory is the 60 Hz
// trajectory subsampled (the clock contract). Chase is per-FRAME by design —
// hz-sensitive, matching shipped apps/im behavior exactly. Every formula is
// IEEE + − * / with literal constants: no Math.pow, no transcendentals —
// trajectories are bit-identical on every host. Decay rates are per-tick
// literals (0.998/ms and 0.99/ms at 16.667 ms, pre-baked).

import { SCREEN_H } from "../../contracts/spec/spec.ts";
import { simulationHz, ticksPerFrame, TICKS_PER_SECOND } from "./clock.ts";

export type ScrollerState = "idle" | "tracking" | "fling" | "spring" | "chase" | "tween";

/** The reactive slot the per-framework shim supplies for the offset. */
export type ScrollerCell = (initial: number) => readonly [() => number, (value: number) => void];

export interface ScrollerOptions {
  /** Scroll range end: max(0, contentH - viewH). Read every step, so a
   *  growing list needs no re-registration. */
  max: () => number;
  /** Viewport extent for the rubber-band scale. Default SCREEN_H. */
  extent?: () => number;
  initial?: number;
  /** Max rubber-band travel in px; 0 = hard clamp at the edges. */
  overscroll?: number;
  /** Fling decay preset: "normal" ≡ iOS 0.998/ms, "fast" ≡ 0.99/ms. */
  decay?: "normal" | "fast";
  /** Applied at endDrag: receives the projected rest position and release
   *  velocity, returns the position to tween to (paging, row alignment). */
  snap?: ((projectedRest: number, velocity: number) => number) | null;
  /** A moving state reached rest. */
  onSettle?: (offset: number) => void;
}

export interface Scroller {
  /** Current offset (logical px). Bind `translateY: -offset()`. */
  offset: () => number;
  /** Instantaneous velocity in px per virtual second (fling/spring only). */
  velocity(): number;
  state(): ScrollerState;
  /** Finger-follow (wire to a gesture pan). */
  beginDrag(): void;
  /** Content-space delta for THIS frame (a vertical list passes -c.fdy). */
  drag(deltaPx: number): void;
  /** Release with the gesture's velocity (the list passes -c.vy). */
  endDrag(releaseVelocity: number): void;
  /** Programmatic scroll. Default tweens over 200 ms. */
  scrollTo(to: number, opts?: { durMs?: number } | { immediate: true }): void;
  scrollBy(delta: number, opts?: { durMs?: number } | { immediate: true }): void;
  /** Freeze in place (no settle callback). */
  stop(): void;
  /** Move the chase target by a delta — the d-pad/analog primitive. */
  nudge(delta: number): void;
  /** Chase an absolute target (focus-follow, stick-to-bottom). */
  chaseTo(to: number): void;
  /** Shift offset AND every in-flight anchor by delta after a prepend, so
   *  backfill never moves what the user is looking at (the im rebase). */
  rebase(delta: number): void;
  /** The position the scroller is heading to: the chase/tween target when
   *  one is in flight, the current offset otherwise. */
  intent(): number;
  /** At the end of the range, judged on INTENT: the chase/tween target when
   *  one is in flight, the position otherwise (the im at-bottom rule). */
  isAtEnd(slackPx?: number): boolean;
  /** Rest position a fling from `v` would reach (for snap functions). */
  projectFling(v: number): number;
  /** Advance one frame. Call once per frame from onFrame. */
  step(): void;
}

// Fling decay per tick, quoted for a 1/60 s tick. 0.9672 ≡ UIScrollView's
// 0.998/ms at 16.667 ms (0.998^16.667); 0.846 ≡ the 0.99/ms paging rate.
// Literals on purpose — computing them from the per-ms rate would put a
// transcendental in the sim path. A realm on another tick rate re-bases them
// once here, so the decay stays the same per second of virtual time.
const perTick = (at60: number) =>
  TICKS_PER_SECOND === 60 ? at60 : at60 ** (60 / TICKS_PER_SECOND);
const DECAY_NORMAL = perTick(0.9672);
const DECAY_FAST = perTick(0.846);
/** Fling rest threshold, px per virtual second. */
const FLING_MIN_V = 4;
/** Rubber-band slope at the edge (the classic iOS coefficient). */
const RUBBER_COEFF = 0.55;
const DEFAULT_OVERSCROLL = 48;
/** Edge spring — the engine's Spring preset (engine/core anim.rs), which at
 *  C ≈ 2√K is essentially critically damped. */
const SPRING_K = 170;
const SPRING_C = 26;
const SPRING_SETTLE_DIST = 0.5;
const SPRING_SETTLE_V = 8;
/** The apps/im chase pump constants. */
const CHASE_RATE = 0.3;
const CHASE_SNAP = 0.6;
const TICK_DT = 1 / TICKS_PER_SECOND;

/** Displayed rubber travel for `x` px of out-of-bounds drag: asymptote d,
 *  slope RUBBER_COEFF at the edge. */
function rubber(x: number, d: number, cap: number): number {
  if (cap <= 0) return 0;
  const r = (1 - 1 / ((x * RUBBER_COEFF) / d + 1)) * d;
  return r < cap ? r : cap;
}

/** Inverse of rubber() (uncapped) — recovers drag-space travel when a
 *  finger catches the content mid-bounce. */
function rubberInv(e: number, d: number): number {
  return (d * e) / (RUBBER_COEFF * (d - e));
}

/** A non-reactive cell for tests and headless callers. */
export const plainCell: ScrollerCell = (initial) => {
  let value = initial;
  return [() => value, (next) => (value = next)] as const;
};

export function createScrollerWith(cell: ScrollerCell, opts: ScrollerOptions): Scroller {
  const extent = opts.extent ?? (() => SCREEN_H);
  const overscroll = opts.overscroll ?? DEFAULT_OVERSCROLL;
  const decay = opts.decay === "fast" ? DECAY_FAST : DECAY_NORMAL;

  const [offset, setOffset] = cell(opts.initial ?? 0);
  let pos = opts.initial ?? 0;
  let state: ScrollerState = "idle";
  let v = 0; // px per virtual second (fling/spring)
  let dragPos = 0; // unrubbered drag-space position while tracking
  let target = 0; // chase target
  let springBound = 0; // the edge a spring is heading to
  let tweenFrom = 0;
  let tweenTo = 0;
  let tweenFrames = 1;
  let tweenAt = 0;

  function emit(p: number): void {
    if (p !== pos) {
      pos = p;
      setOffset(p);
    }
  }

  function settle(p: number): void {
    // Round to 1/64 px so settled framebuffers hash identically.
    const r = Math.round(p * 64) / 64;
    emit(r);
    v = 0;
    state = "idle";
    opts.onSettle?.(r);
  }

  function clampRange(x: number): number {
    const m = opts.max();
    return x < 0 ? 0 : x > m ? m : x;
  }

  function displayedFromDrag(): number {
    const m = opts.max();
    if (dragPos < 0) return -rubber(-dragPos, extent(), overscroll);
    if (dragPos > m) return m + rubber(dragPos - m, extent(), overscroll);
    return dragPos;
  }

  function startTween(to: number, durMs: number): void {
    tweenFrom = pos;
    tweenTo = clampRange(to);
    tweenFrames = Math.max(1, Math.round((durMs * simulationHz()) / 1000));
    tweenAt = 0;
    state = tweenTo === pos ? "idle" : "tween";
  }

  function projectFling(v0: number): number {
    // Geometric series of per-tick steps: Σ v·D^n·dt = v·dt·D/(1−D).
    return pos + (v0 * TICK_DT * decay) / (1 - decay);
  }

  return {
    offset,
    velocity: () => v,
    state: () => state,

    beginDrag(): void {
      const m = opts.max();
      v = 0;
      state = "tracking";
      if (pos < 0) dragPos = -rubberInv(-pos, extent());
      else if (pos > m) dragPos = m + rubberInv(pos - m, extent());
      else dragPos = pos;
    },

    drag(deltaPx: number): void {
      if (state !== "tracking") this.beginDrag();
      dragPos += deltaPx;
      emit(displayedFromDrag());
    },

    endDrag(releaseVelocity: number): void {
      if (state !== "tracking") return;
      const m = opts.max();
      if (pos < 0 || pos > m) {
        springBound = pos < 0 ? 0 : m;
        v = releaseVelocity;
        state = "spring";
        return;
      }
      if (opts.snap) {
        const to = opts.snap(projectFling(releaseVelocity), releaseVelocity);
        const dist = to - pos;
        const durMs = Math.min(450, Math.max(150, 150 + (dist < 0 ? -dist : dist) * 0.6));
        startTween(to, durMs);
        return;
      }
      if (releaseVelocity > FLING_MIN_V || releaseVelocity < -FLING_MIN_V) {
        v = releaseVelocity;
        state = "fling";
        return;
      }
      settle(pos);
    },

    scrollTo(to: number, o?: { durMs?: number } | { immediate: true }): void {
      if (o && "immediate" in o && o.immediate) {
        v = 0;
        state = "idle";
        emit(clampRange(to));
        return;
      }
      startTween(to, (o as { durMs?: number } | undefined)?.durMs ?? 200);
    },

    scrollBy(delta: number, o?: { durMs?: number } | { immediate: true }): void {
      const base = state === "tween" ? tweenTo : state === "chase" ? target : pos;
      this.scrollTo(base + delta, o);
    },

    stop(): void {
      v = 0;
      state = "idle";
    },

    nudge(delta: number): void {
      const base = state === "chase" ? target : pos;
      this.chaseTo(base + delta);
    },

    chaseTo(to: number): void {
      target = clampRange(to);
      if (state !== "chase" && target === pos) return;
      v = 0;
      state = "chase";
    },

    rebase(delta: number): void {
      dragPos += delta;
      target += delta;
      springBound += delta;
      tweenFrom += delta;
      tweenTo += delta;
      emit(pos + delta);
    },

    intent(): number {
      return state === "chase" ? target : state === "tween" ? tweenTo : pos;
    },

    isAtEnd(slackPx = 1): boolean {
      return this.intent() >= opts.max() - slackPx;
    },

    projectFling,

    step(): void {
      if (state === "idle" || state === "tracking") return;

      if (state === "chase") {
        // Per FRAME (hz-sensitive by design — im parity).
        target = clampRange(target);
        const d = target - pos;
        if (d === 0 || (d < CHASE_SNAP && d > -CHASE_SNAP)) {
          emit(target);
          state = "idle";
          opts.onSettle?.(pos);
          return;
        }
        emit(pos + d * CHASE_RATE);
        return;
      }

      if (state === "tween") {
        tweenAt++;
        if (tweenAt >= tweenFrames) {
          emit(tweenTo);
          state = "idle";
          v = 0;
          opts.onSettle?.(pos);
          return;
        }
        const t = tweenAt / tweenFrames;
        const inv = 1 - t;
        const eased = 1 - inv * inv * inv; // cubic ease-out, polynomial only
        emit(tweenFrom + (tweenTo - tweenFrom) * eased);
        return;
      }

      // fling / spring integrate PER TICK, and settle/transition checks run
      // inside the tick loop — the stop tick is the same at every hz, which
      // is what makes the 30 Hz trajectory the 60 Hz one subsampled.
      let p = pos;
      const ticks = ticksPerFrame();
      for (let i = 0; i < ticks; i++) {
        if (state === "fling") {
          v *= decay;
          p += v * TICK_DT;
          const m = opts.max();
          if (p < 0 || p > m) {
            // Carry the momentum into the edge spring mid-tick.
            springBound = p < 0 ? 0 : m;
            state = "spring";
            continue;
          }
          if (v < FLING_MIN_V && v > -FLING_MIN_V) {
            settle(p);
            return;
          }
        } else {
          const b = clampRange(springBound);
          const a = SPRING_K * (b - p) - SPRING_C * v;
          v += a * TICK_DT;
          p += v * TICK_DT;
          const dist = b - p;
          if (
            dist < SPRING_SETTLE_DIST &&
            dist > -SPRING_SETTLE_DIST &&
            v < SPRING_SETTLE_V &&
            v > -SPRING_SETTLE_V
          ) {
            settle(b);
            return;
          }
        }
      }
      emit(p);
    },
  };
}

export interface DpadScrollOptions {
  /** px per held-frame of UP/DOWN. Default 6 (apps/im SCROLL_STEP). */
  stepPx?: number;
  /** px per frame at full analog deflection. Default 10 (im NUB_STEP). */
  nubPx?: number;
  /** Gate (e.g. `() => !osk.isOpen()` — raw button reads are not muted by
   *  the OSK's modal block). Default: always on. */
  active?: () => boolean;
}
