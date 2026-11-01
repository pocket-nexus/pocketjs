// @pocketjs/framework/game2d — buttons as game actions, plus a focus stack for menus.
//
// PSP buttons are the model; hosts with keyboards map keys onto them. `press` is an edge,
// `repeat` adds key-repeat for menu navigation, `held` is level. Menus push onto a stack and
// only the top consumes input; a modal entry also holds input while dialogue is waiting.

import { BTN } from "../../../contracts/spec/spec.ts";
import { analogX, analogY } from "../lifecycle.ts";

export { BTN };
export type Dir = "up" | "down" | "left" | "right";

export interface NavOptions {
  index?: number;
  /** 'list' vertical (default), 'grid' with `cols`, 'cycle' any direction walks. */
  mode?: "list" | "grid" | "cycle";
  cols?: number;
  modal?: boolean;
  disabled?: (i: number) => boolean;
  onChange?: (i: number) => void;
  onPick?: (i: number) => void;
  onBack?: () => void;
}
export interface Nav { index: number; closed: boolean; suspended: boolean; set(i: number): void; move(d: Dir): void; pick(i?: number): void; close(): void; suspend(): void; resume(): void; o: NavOptions; count: number }

export interface Input {
  /** Call first thing each frame. */
  update(buttons: number): void;
  held(mask: number): boolean;
  pressed(mask: number): boolean;
  /** Pressed, or held past the repeat delay. */
  repeat(mask: number): boolean;
  /** Direction from d-pad or stick (dir pad wins). */
  axis(): { x: number; y: number };
  nav(count: number, o?: NavOptions): Nav;
  navTop(): Nav | null;
  /** Route the frame's input to the top menu. Returns true if a menu consumed it. */
  routeNav(confirm: number, back: number, dialogWaiting: boolean): boolean;
  clear(): void;
  /** Drop every menu (chapter jump). */
  reset(): void;
}

const REPEAT_DELAY = 22, REPEAT_EVERY = 6;
const STICK = 0.5;

export function createInput(): Input {
  let now = 0, prev = 0;
  const heldFor = new Map<number, number>();
  let stack: Nav[] = [];
  const i: Input = {
    update(b) {
      prev = now; now = b;
      for (const k of [BTN.UP, BTN.DOWN, BTN.LEFT, BTN.RIGHT]) heldFor.set(k, b & k ? (heldFor.get(k) ?? 0) + 1 : 0);
    },
    held: (m) => (now & m) !== 0,
    pressed: (m) => (now & m) !== 0 && (prev & m) === 0,
    repeat(m) {
      if (i.pressed(m)) return true;
      const n = heldFor.get(m) ?? 0;
      return n > REPEAT_DELAY && (n - REPEAT_DELAY) % REPEAT_EVERY === 0;
    },
    axis() {
      let x = (now & BTN.RIGHT ? 1 : 0) - (now & BTN.LEFT ? 1 : 0), y = (now & BTN.DOWN ? 1 : 0) - (now & BTN.UP ? 1 : 0);
      if (!x && !y) { const ax = analogX(), ay = analogY(); x = Math.abs(ax) > STICK ? Math.sign(ax) : 0; y = Math.abs(ay) > STICK ? Math.sign(ay) : 0; }
      return { x, y };
    },
    nav(count, o = {}) {
      const on = (k: number) => k >= 0 && k < count && !o.disabled?.(k);
      const h: Nav = {
        index: -1, closed: false, suspended: false, o, count,
        set(k) { if (!on(k) || k === h.index) return; h.index = k; o.onChange?.(k); },
        move(d) {
          const back = d === "up" || d === "left", step = back ? -1 : 1;
          if (o.mode === "grid" && (o.cols ?? 1) > 1) {
            const cols = o.cols!;
            const horizontal = d === "left" || d === "right";
            const delta = horizontal ? step : step * cols;
            for (let k = h.index + delta, tries = 0; tries < count; k += delta, tries++) {
              // Down into a shorter last row lands on its last item instead of doing nothing.
              if (!horizontal && k >= count && Math.floor(k / cols) === Math.floor((count - 1) / cols)) k = count - 1;
              if (k < 0 || k >= count) return;
              if (horizontal && Math.floor(k / cols) !== Math.floor(h.index / cols)) return;
              if (on(k)) { h.set(k); return; }
            }
            return;
          }
          if ((o.mode ?? "list") === "list" && (d === "left" || d === "right")) return;
          for (let n = 1; n <= count; n++) { const k = (((h.index + step * n) % count) + count) % count; if (on(k)) { h.set(k); return; } }
        },
        pick(k = h.index) { if (on(k)) o.onPick?.(k); },
        close() { h.closed = true; stack = stack.filter((x) => x !== h); },
        suspend() { h.suspended = true; },
        resume() { h.suspended = false; },
      };
      stack.push(h);
      let first = o.index ?? 0; if (!on(first)) { first = 0; while (first < count && !on(first)) first++; }
      if (first < count) h.set(first);
      return h;
    },
    navTop() {
      for (let k = stack.length - 1; k >= 0; k--) if (!stack[k].suspended) return stack[k];
      return null;
    },
    routeNav(confirm, back, dialogWaiting) {
      const t = i.navTop();
      if (!t || (dialogWaiting && !t.o.modal)) return false;
      if (i.repeat(BTN.UP)) t.move("up");
      if (i.repeat(BTN.DOWN)) t.move("down");
      if (i.repeat(BTN.LEFT)) t.move("left");
      if (i.repeat(BTN.RIGHT)) t.move("right");
      if (i.pressed(confirm)) t.pick();
      else if (i.pressed(back) && t.o.onBack) t.o.onBack();
      return true;
    },
    clear() { heldFor.clear(); now = 0; prev = 0; },
    reset() { stack = []; },
  };
  return i;
}
