// Motion in the compact kit: short, local, and run by the core. A control
// declares where a thing goes and the Rust core tweens it per tick, so no
// JavaScript runs while the cursor slides. The target's animation class
// (contracts/spec/animation.ts) sets what a change may cost: on a repaint
// target (the Zero's CPU rasterizer) the kit moves opaque regions and small
// areas and makes large fades cuts; on a composited target it adds the
// fades; on a still target every move is a jump.

import { animate, animationClass, jump, type EasingName } from "../anim.ts";
import type { PropName } from "../../../contracts/spec/spec.ts";
import type { NodeMirror } from "../renderer.ts";

/** Durations in ms. A key press shows within a frame; these finish the
 *  move it started. At the CardputerZero's 30 Hz a move of 150 ms is five
 *  frames: shorter ones read as a jump. */
export const MOTION = {
  /** The focus cursor between rows, the pad's fill between cells. */
  focus: 150,
  /** The section highlight between tabs, and the section's content. */
  section: 180,
  /** A scene sliding in or out. */
  scene: 200,
  /** A toast arriving. */
  toast: 180,
  /** A needle, a ruler, a bubble following a new reading. */
  needle: 120,
  /** A marker or bar following a new value. */
  value: 160,
  /** A list's rows sliding to bring the focused row into view. */
  scroll: 160,
  /** Tiles moving to a new layout: a grid size, a filter, a reorder. */
  reflow: 260,
} as const;

/** How far a section's content travels when the next section slides in. */
export const SECTION_SHIFT = 56;

/** Fades and scales are drawn only where a frame is cheap. */
export const FADES: boolean = animationClass === "composited";

/** Move `prop` of `node` to `to` over `ms`: a tween, or a jump on a still
 *  target. */
export function glide(node: NodeMirror, prop: PropName, to: number | string, ms: number, easing: EasingName = "out"): void {
  if (animationClass === "still" || ms <= 0) jump(node, prop, to);
  else animate(node, prop, to, { dur: ms, easing });
}

/** Set `prop` now; a running tween on it stops. */
export const place = jump;

/** A prop that follows a value: the first placement is a jump (the node
 *  appears where it belongs), every later one glides, over `ms` unless the
 *  call names another duration. */
export function createFollower(prop: PropName, ms: number, easing: EasingName = "out"): (node: NodeMirror | undefined, to: number | string, duration?: number) => void {
  let placed = false;
  return (node, to, duration = ms) => {
    if (!node) return;
    if (!placed) {
      placed = true;
      jump(node, prop, to);
    } else glide(node, prop, to, duration, easing);
  };
}

/** A node's box in its parent's coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Play a layout change as a move: the node is already laid out at `to`;
 *  it starts offset (and scaled, about its centre) back onto `from` and
 *  glides to its own place. A still target shows the new layout at once. */
export function flip(node: NodeMirror, from: Rect, to: Rect, ms: number = MOTION.reflow): void {
  if (animationClass === "still") {
    jump(node, "translateX", 0);
    jump(node, "translateY", 0);
    jump(node, "scale", 1);
    return;
  }
  const dx = from.x + from.w / 2 - (to.x + to.w / 2);
  const dy = from.y + from.h / 2 - (to.y + to.h / 2);
  jump(node, "translateX", dx);
  jump(node, "translateY", dy);
  animate(node, "translateX", 0, { dur: ms, easing: "out" });
  animate(node, "translateY", 0, { dur: ms, easing: "out" });
  const s = to.w > 0 && from.w > 0 ? from.w / to.w : 1;
  if (Math.abs(s - 1) > 0.001) {
    jump(node, "scale", s);
    animate(node, "scale", 1, { dur: ms, easing: "out" });
  }
}

/** A node that appears in a layout already on screen grows into place. */
export function pop(node: NodeMirror, ms: number = MOTION.reflow): void {
  if (animationClass === "still") return;
  jump(node, "scale", 0.6);
  animate(node, "scale", 1, { dur: ms, easing: "out" });
}

/** A pressed cell dips and springs back: the press is seen before what it
 *  does arrives. */
export function bump(node: NodeMirror, ms: number = MOTION.focus): void {
  if (animationClass === "still") return;
  jump(node, "scale", 0.88);
  animate(node, "scale", 1, { dur: ms, easing: "out" });
}

/** Start `prop` offset by `offset` and glide it back to 0: content arriving
 *  from a side. */
export function slideFrom(node: NodeMirror, prop: "translateX" | "translateY", offset: number, ms: number): void {
  if (animationClass === "still") return;
  jump(node, prop, offset);
  animate(node, prop, 0, { dur: ms, easing: "out" });
}

/** Slide a node in from `fromX` to 0 (a push). */
export function slideIn(node: NodeMirror, fromX: number, ms = MOTION.scene): void {
  if (animationClass === "still") {
    jump(node, "translateX", 0);
    return;
  }
  jump(node, "translateX", fromX);
  animate(node, "translateX", 0, { dur: ms, easing: "out" });
}

/** Slide a node out to `toX` (a pop); the caller removes it after `ms`. */
export function slideOut(node: NodeMirror, toX: number, ms = MOTION.scene): void {
  if (animationClass === "still") return;
  animate(node, "translateX", toX, { dur: ms, easing: "in" });
}

/** A small panel arriving: a short rise, with a fade where fades are cheap. */
export function arrive(node: NodeMirror, rise = 8, ms = MOTION.toast): void {
  if (animationClass === "still") return;
  jump(node, "translateY", rise);
  animate(node, "translateY", 0, { dur: ms, easing: "out" });
  if (FADES) {
    jump(node, "opacity", 0);
    animate(node, "opacity", 1, { dur: ms, easing: "out" });
  }
}
