// @pocketjs/framework/game2d — input as game actions, plus a focus stack for menus.
//
// A game names its actions and binds each to a mask of buttons (spec BTN); a host with a keyboard
// or another button layout maps onto BTN, and `bind` changes a binding at run time. The four
// directions are actions of their own, and `axis()` also reads the analog stick.
//
// `update(buttons)` runs once per frame. A press is latched until a fixed step consumes it
// (`endStep()`), so a frame that runs no step (a 120 Hz display at 60 steps a second) loses no
// press. `pressed` is that edge, `held` the level, `repeat` adds key repeat for menus.
//
// Menus push onto a stack and only the top consumes input; a modal entry also holds input while
// dialogue is waiting. Nothing here allocates per frame.

import { BTN } from "../../../contracts/spec/spec.ts";
import { analogX, analogY } from "../lifecycle.ts";

export { BTN };
export type Dir = "up" | "down" | "left" | "right";
type DirAction = Dir;

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

export interface InputConfig<A extends string> {
  /** Each action's buttons. The directions default to the d-pad. */
  bindings: Record<A, number> & Partial<Record<DirAction, number>>;
  /** The actions menus pick and leave with. */
  confirm: NoInfer<A>;
  back: NoInfer<A>;
}

export interface Input<A extends string> {
  /** Call once per frame, before the frame's steps. */
  update(buttons: number): void;
  /** Call at the end of each fixed step: the latched presses have been seen. */
  endStep(): void;
  held(action: A | Dir): boolean;
  pressed(action: A | Dir): boolean;
  /** Pressed, or held past the repeat delay. */
  repeat(action: A | Dir): boolean;
  /** Direction from the d-pad, or the stick when no direction is held. The object is reused. */
  axis(): { readonly x: number; readonly y: number };
  /** Rebind an action. */
  bind(action: A | Dir, buttons: number): void;
  nav(count: number, o?: NavOptions): Nav;
  navTop(): Nav | null;
  /** Route this step's input to the top menu. Returns true if a menu consumed it. */
  routeNav(dialogWaiting: boolean): boolean;
  /** Forget held and latched buttons. */
  clear(): void;
  /** Drop every menu (chapter jump). */
  reset(): void;
}

const REPEAT_DELAY = 22, REPEAT_EVERY = 6;
const STICK = 0.5;
const DIRS: readonly Dir[] = ["up", "down", "left", "right"];

export function createInput<A extends string>(cfg: InputConfig<A>): Input<A> {
  // Actions are slots: masks, hold counters and latched edges live in typed arrays.
  const names: string[] = [...DIRS];
  for (const k of Object.keys(cfg.bindings)) if (!names.includes(k)) names.push(k);
  // A property read, not a Map lookup: on a PSP that is 2 µs against 8.
  const slot: Record<string, number> = Object.create(null);
  names.forEach((k, i) => { slot[k] = i; });
  const masks = new Int32Array(names.length), heldFor = new Int32Array(names.length);
  masks[0] = BTN.UP; masks[1] = BTN.DOWN; masks[2] = BTN.LEFT; masks[3] = BTN.RIGHT;
  for (const [k, m] of Object.entries(cfg.bindings) as [string, number][]) masks[slot[k]] = m;
  let now = 0, latched = 0; // latched: bit i = action i was pressed since the last step
  let stack: Nav[] = [];
  const axisOut = { x: 0, y: 0 };
  const at = (a: string) => { const i = slot[a]; if (i === undefined) throw new Error(`game2d input: no action "${a}"`); return i; };
  const UP = 0, DOWN = 1, LEFT = 2, RIGHT = 3, CONFIRM = at(cfg.confirm), BACK = at(cfg.back);
  const isHeld = (i: number) => (now & masks[i]) !== 0;
  const isPressed = (i: number) => (latched & (1 << i)) !== 0;
  const isRepeat = (i: number) => { if (isPressed(i)) return true; const n = heldFor[i]; return n > REPEAT_DELAY && (n - REPEAT_DELAY) % REPEAT_EVERY === 0; };

  const input: Input<A> = {
    update(b) {
      const prev = now; now = b;
      for (let i = 0; i < masks.length; i++) {
        const m = masks[i], down = (b & m) !== 0;
        heldFor[i] = down ? heldFor[i] + 1 : 0;
        if (down && (prev & m) === 0) latched |= 1 << i;
      }
    },
    endStep() { latched = 0; },
    held: (a) => isHeld(at(a)),
    pressed: (a) => isPressed(at(a)),
    repeat: (a) => isRepeat(at(a)),
    axis() {
      let x = (isHeld(RIGHT) ? 1 : 0) - (isHeld(LEFT) ? 1 : 0), y = (isHeld(DOWN) ? 1 : 0) - (isHeld(UP) ? 1 : 0);
      if (!x && !y) { const ax = analogX(), ay = analogY(); x = ax > STICK ? 1 : ax < -STICK ? -1 : 0; y = ay > STICK ? 1 : ay < -STICK ? -1 : 0; }
      axisOut.x = x; axisOut.y = y;
      return axisOut;
    },
    bind(a, buttons) { masks[at(a)] = buttons; },
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
            if (!horizontal) {
              // Up or down lands on the nearest enabled item of the next row that has one, so a disabled
              // cell or a shorter last row never blocks the way.
              const col = h.index % cols, last = Math.floor((count - 1) / cols);
              for (let row = Math.floor(h.index / cols) + step; row >= 0 && row <= last; row += step) {
                for (let dist = 0; dist < cols; dist++) {
                  for (let side = 0; side < (dist ? 2 : 1); side++) {
                    const c = side ? col + dist : col - dist, k = row * cols + c;
                    if (c >= 0 && c < cols && on(k)) { h.set(k); return; }
                  }
                }
              }
              return;
            }
            for (let k = h.index + step; k >= 0 && k < count && Math.floor(k / cols) === Math.floor(h.index / cols); k += step) {
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
    routeNav(dialogWaiting) {
      const t = input.navTop();
      if (!t || (dialogWaiting && !t.o.modal)) return false;
      if (isRepeat(UP)) t.move("up");
      if (isRepeat(DOWN)) t.move("down");
      if (isRepeat(LEFT)) t.move("left");
      if (isRepeat(RIGHT)) t.move("right");
      if (isPressed(CONFIRM)) t.pick();
      else if (isPressed(BACK) && t.o.onBack) t.o.onBack();
      return true;
    },
    clear() { heldFor.fill(0); now = 0; latched = 0; },
    reset() { stack = []; },
  };
  if (names.length > 31) throw new Error("game2d input: at most 31 actions");
  return input;
}
