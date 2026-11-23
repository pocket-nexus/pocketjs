// PocketUI core/focus.ts — which control a d-pad press moves the focus to.
//
// PocketJS's focus moves in document order (framework/src/input.ts): up and
// left are "previous", down and right "next". With two panes side by side
// that sends Right to the next row of the same list. PocketUI knows every
// control's rectangle, so a press moves to the nearest control in that
// direction, as a TV interface does.
//
// A candidate qualifies when its near edge is past the origin's far edge
// (allowing a few points of overlap). Among those, one that overlaps the
// origin's beam (the band the origin sweeps in that direction) beats one
// that does not; then the shorter travel along the axis wins, then the
// smaller offset across it. A candidate outside the beam must lie more
// ahead than aside (its offset across at most 1.5 times its travel, plus 40
// points), so a press never lands on a control far off to one side.

export interface FocusRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Direction = "up" | "down" | "left" | "right";

const OVERLAP = 3;

/** The index of the candidate focus moves to from `from`, or -1. */
export function pickFocus(from: FocusRect, direction: Direction, candidates: readonly FocusRect[]): number {
  const horizontal = direction === "left" || direction === "right";
  const forward = direction === "right" || direction === "down";
  // the origin's far edge and the beam's two sides
  const edge = horizontal ? (forward ? from.x + from.w : from.x) : forward ? from.y + from.h : from.y;
  const beamA = horizontal ? from.y : from.x;
  const beamB = horizontal ? from.y + from.h : from.x + from.w;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const near = horizontal ? (forward ? c.x : c.x + c.w) : forward ? c.y : c.y + c.h;
    const travel = forward ? near - edge : edge - near;
    if (travel < -OVERLAP) continue;
    // a candidate that contains the origin's edge is the origin or its container
    const centre = horizontal ? c.x + c.w / 2 : c.y + c.h / 2;
    const fromCentre = horizontal ? from.x + from.w / 2 : from.y + from.h / 2;
    if (forward ? centre <= fromCentre : centre >= fromCentre) continue;
    const a = horizontal ? c.y : c.x;
    const b = horizontal ? c.y + c.h : c.x + c.w;
    const overlap = Math.min(b, beamB) - Math.max(a, beamA);
    const offset = overlap > 0 ? 0 : Math.max(a - beamB, beamA - b);
    // out of the beam, a control still counts while it is more ahead than aside: Down never lands on something far off to the left
    if (offset > Math.max(0, travel) * 1.5 + 40) continue;
    const across = Math.abs((a + b) / 2 - (beamA + beamB) / 2);
    const score = (overlap > 0 ? 0 : 100000) + Math.max(0, travel) * 4 + offset * 12 + across;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** The candidate focus lands on first: the one nearest the top-left. */
export function firstFocus(candidates: readonly FocusRect[]): number {
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const score = c.y * 4 + c.x;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
