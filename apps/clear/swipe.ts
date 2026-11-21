// The horizontal row swipe: complete to the right, delete to the left. This
// module owns every transient visual — 1:1 travel damped to a third past the
// commit bound, the check/cross icons fading in and riding the slider edge,
// the strike-through growing under the finger, and the armed slider look
// (green for a pending row, the restored position tint for a done row). The
// host commits the model mutations.

import { animate, jump } from "@pocketjs/framework/animation";
import { createGesture } from "@pocketjs/framework/gesture";
import type { Todo } from "./model.ts";
import { DONE_FROM, DONE_TO, GREEN_FROM, GREEN_TO, todoRowColors } from "./palette.ts";
import { ROW_H, SCREEN_W, SWIPE_COMMIT, SWITCH_MS } from "./metrics.ts";
import type { RowSlot } from "./rows.tsx";

export interface SwipeHost {
  region(): { x: number; y: number; w: number; h: number } | null;
  /** Display index under a screen y, or -1 outside the rows. */
  rowIndexAt(screenY: number): number;
  rowAt(index: number): { slot: RowSlot | null; todo: Todo } | null;
  /** Toggle done/undone (the slider already animated home). */
  complete(todo: Todo): void;
  /** Remove the todo (the row node already animated off-screen; the host
   *  marks the slot busy and schedules its park). */
  remove(todo: Todo, slot: RowSlot): void;
}

/** 1:1 up to the commit bound, then damped to a third — the reference feel. */
function swipeDisplay(dx: number): number {
  if (dx > SWIPE_COMMIT) return SWIPE_COMMIT + (dx - SWIPE_COMMIT) / 3;
  if (dx < -SWIPE_COMMIT) return -SWIPE_COMMIT + (dx + SWIPE_COMMIT) / 3;
  return dx;
}

/** Past the rightward bound the slider changes its mind: a pending row goes
 *  green, a done row previews its restored position tint. */
function paintArmed(slot: RowSlot, todo: Todo, index: number, armed: boolean): void {
  if (!slot.front) return;
  if (armed) {
    if (todo.done) {
      slot.done.value = false;
      const [from, to] = todoRowColors(Math.min(index, 7), 1);
      jump(slot.front, "gradFrom", from);
      jump(slot.front, "gradTo", to);
    } else {
      jump(slot.front, "gradFrom", GREEN_FROM);
      jump(slot.front, "gradTo", GREEN_TO);
    }
  } else if (todo.done) {
    slot.done.value = true;
    jump(slot.front, "gradFrom", DONE_FROM);
    jump(slot.front, "gradTo", DONE_TO);
  } else {
    jump(slot.front, "gradFrom", slot.gradFrom);
    jump(slot.front, "gradTo", slot.gradTo);
  }
}

export function attachSwipeGesture(host: SwipeHost): void {
  let slot: RowSlot | null = null;
  let todo: Todo | null = null;
  let index = -1;
  let armed = false;

  function settle(current: RowSlot, target: Todo): void {
    animate(current.front!, "translateX", 0, { dur: 160, easing: "out" });
    if (current.strike) jump(current.strike, "scaleX", target.done ? 1 : 0);
    if (armed) {
      armed = false;
      paintArmed(current, target, index, false);
    }
  }

  createGesture({
    axis: "x",
    region: { rect: () => host.region() },
    onPanStart: (c) => {
      index = host.rowIndexAt(c.startY);
      const row = index >= 0 ? host.rowAt(index) : null;
      todo = row?.todo ?? null;
      slot = row?.slot ?? null;
      armed = false;
    },
    onPanMove: (c) => {
      if (!slot?.front || !todo) return;
      const raw = Math.max(-SCREEN_W, Math.min(SCREEN_W, c.dx));
      const disp = swipeDisplay(raw);
      jump(slot.front, "translateX", disp);
      const rightO = Math.max(0, Math.min(1, raw / SWIPE_COMMIT));
      const leftO = Math.max(0, Math.min(1, -raw / SWIPE_COMMIT));
      if (slot.check) {
        jump(slot.check, "opacity", raw > 0 ? (todo.done ? 1 - rightO : rightO) : 0);
        jump(slot.check, "translateX", Math.max(0, disp - SWIPE_COMMIT));
      }
      if (slot.cross) {
        jump(slot.cross, "opacity", leftO);
        jump(slot.cross, "translateX", Math.min(0, disp + SWIPE_COMMIT));
      }
      if (slot.strike) {
        jump(slot.strike, "scaleX", todo.done ? 1 - rightO : rightO);
      }
      const next = raw >= SWIPE_COMMIT;
      if (next !== armed) {
        armed = next;
        paintArmed(slot, todo, index, next);
      }
    },
    onPanEnd: (c) => {
      const current = slot;
      const target = todo;
      slot = null;
      todo = null;
      if (!current?.front || !target) return;
      if (current.check) animate(current.check, "opacity", 0, { dur: 160, easing: "out" });
      if (current.cross) animate(current.cross, "opacity", 0, { dur: 160, easing: "out" });
      if (c.dx >= SWIPE_COMMIT) {
        animate(current.front, "translateX", 0, { dur: 180, easing: "out" });
        armed = false;
        host.complete(target);
        return;
      }
      if (c.dx <= -SWIPE_COMMIT) {
        if (current.node) {
          animate(current.node, "translateX", -(SCREEN_W + ROW_H), { dur: SWITCH_MS, easing: "out" });
        }
        host.remove(target, current);
        return;
      }
      settle(current, target);
    },
    onCancel: () => {
      const current = slot;
      const target = todo;
      slot = null;
      todo = null;
      if (!current?.front || !target) return;
      if (current.check) animate(current.check, "opacity", 0, { dur: 160, easing: "out" });
      if (current.cross) animate(current.cross, "opacity", 0, { dur: 160, easing: "out" });
      settle(current, target);
    },
  });
}
