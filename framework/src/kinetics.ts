// Solid flavor of the kinetic scroller. The six-state machine — tracking /
// fling / spring / chase / tween / idle, with the iOS decay and rubber-band
// constants — is framework-neutral and lives in kinetics-core.ts; this shim
// binds the offset to a Solid signal and registers the d-pad pump on the
// Solid frame hook. Vue Vapor builds resolve kinetics.vue-vapor.ts instead.

import { createSignal, type Accessor } from "solid-js";
import { BTN } from "../../contracts/spec/spec.ts";
import { analogY } from "./analog.ts";
import { onFrame } from "./frame.ts";
import {
  createScrollerWith,
  type DpadScrollOptions,
  type Scroller as ScrollerCore,
  type ScrollerOptions,
} from "./kinetics-core.ts";

export type { DpadScrollOptions, ScrollerOptions, ScrollerState } from "./kinetics-core.ts";

export interface Scroller extends ScrollerCore {
  /** Current offset (logical px). Bind `translateY: -offset()`. */
  offset: Accessor<number>;
}

export function createScroller(opts: ScrollerOptions): Scroller {
  return createScrollerWith((initial) => createSignal(initial), opts);
}

/**
 * The apps/im d-pad/analog scroll semantics over a Scroller: held UP/DOWN
 * moves the chase target stepPx per frame, the nub moves it proportionally.
 * Registers an onFrame hook (Solid-scoped); the caller still owns step().
 */
export function bindDpadScroll(s: Scroller, o: DpadScrollOptions = {}): void {
  const step = o.stepPx ?? 6;
  const nubStep = o.nubPx ?? 10;
  onFrame((buttons) => {
    if (o.active && !o.active()) return;
    if (buttons & BTN.UP) s.nudge(-step);
    if (buttons & BTN.DOWN) s.nudge(step);
    const nub = analogY();
    if (nub !== 0) s.nudge(nub * nubStep);
  });
}
