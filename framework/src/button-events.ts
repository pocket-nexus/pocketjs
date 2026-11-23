// ActionHandler's press, hold and release delivery. The Solid and Vue Vapor
// frame modules and the MicroTS tape interpreter share ButtonLatch; compiled
// views use microts::ButtonLatch (engine/microts-runtime/src/input.rs). Both
// follow the same rules:
//
//   - A press is an up-to-down edge of a masked button on a frame where the
//     handler is active. Every frame samples the buttons, so a button held
//     while the handler was inactive, or held at mount by a latched handler,
//     never becomes a press later.
//   - An accepted press arms the handler. When an armed button goes up, the
//     release is delivered even if the handler has become inactive since, so
//     every delivered press has one release while the handler stays mounted.
//   - A hold is delivered holdMs after the accepted press while the button
//     stays down and the handler is active, then every repeatMs when that is
//     set. Deadlines are model-clock milliseconds (virtualNow() * 1000, the
//     clock model `after(ms)` reads). A hold fires at most once per frame and
//     never on the press frame; a late frame does not queue skipped intervals.
//   - At most one event per frame: a release ends the frame's sampling.

import { ACTION_HOLD_DEFAULT_MS } from "../../contracts/spec/microts.ts";
import { virtualNow } from "./clock.ts";
import type { i32 } from "./numeric-microts.ts";

export { ACTION_HOLD_DEFAULT_MS };

export type ButtonEventName = "press" | "hold" | "release";
/** `holdMs` undefined schedules no hold; `repeatMs` undefined fires one hold per press. */
export interface ButtonTiming { holdMs?: number; repeatMs?: number }

export class ButtonLatch {
  private previous: number;
  private armed = 0;
  private holdAt = Infinity;
  private lastEventMs = -Infinity;
  constructor(latched = false) {
    this.previous = latched ? ~0 : 0; // latched: "everything held" until released
  }
  /** Whether `sample` can deliver an event for `mask` at `now`. */
  pending(buttons: number, mask: number, now: number): boolean {
    return (buttons & ~this.previous & mask) !== 0 || (this.armed & ~buttons) !== 0 || this.holdDue(now);
  }
  private holdDue(now: number): boolean {
    return this.armed !== 0 && now >= this.holdAt && now > this.lastEventMs;
  }
  /**
   * Advance to `buttons` and return the frame's event with the buttons it
   * carries. `active` and `timing` are read only when a press or hold is due;
   * `timing().holdMs` is read at an accepted press, `repeatMs` at each hold.
   */
  sample(buttons: number, mask: number, now: number, active: () => boolean, timing: () => ButtonTiming): { name: ButtonEventName; buttons: number } | undefined {
    const pressed = buttons & ~this.previous;
    const released = this.previous & ~buttons;
    this.previous = buttons;
    if (this.armed & ~buttons) {
      this.armed &= buttons;
      this.holdAt = Infinity;
      return { name: "release", buttons: released };
    }
    const pressDue = (pressed & mask) !== 0;
    if (!pressDue && !this.holdDue(now) || !active()) return undefined;
    this.lastEventMs = now;
    if (pressDue) {
      this.armed |= pressed & mask;
      const delay = timing().holdMs;
      this.holdAt = delay === undefined ? Infinity : now + delay;
      return { name: "press", buttons: pressed };
    }
    const interval = timing().repeatMs;
    if (interval === undefined) this.holdAt = Infinity;
    else {
      const next = this.holdAt + interval;
      this.holdAt = next > now ? next : now + interval;
    }
    return { name: "hold", buttons: this.armed };
  }
}

export interface ButtonEventCallbacks {
  onPress?: (pressed: i32, buttons: i32) => void;
  onHold?: (held: i32, buttons: i32) => void;
  onRelease?: (released: i32, buttons: i32) => void;
  /** Read at an accepted press; the default is ACTION_HOLD_DEFAULT_MS. */
  holdMs?: number;
  /** Read at each hold; undefined fires onHold once per press. */
  repeatMs?: number;
}

/**
 * One guest handler's per-frame sampler. `callbacks` is read when an event
 * is due; `accepts` reports whether the handler is active this frame.
 */
export function buttonEvents(
  mask: number,
  latched: boolean | undefined,
  callbacks: () => ButtonEventCallbacks,
): (buttons: number, accepts: () => boolean) => void {
  const latch = new ButtonLatch(latched);
  const timing = (): ButtonTiming => {
    const handlers = callbacks();
    return handlers.onHold ? { holdMs: handlers.holdMs ?? ACTION_HOLD_DEFAULT_MS, repeatMs: handlers.repeatMs } : {};
  };
  return (buttons, accepts) => {
    const event = latch.sample(buttons, mask, virtualNow() * 1000, accepts, timing);
    if (!event) return;
    const handlers = callbacks();
    const callback = event.name === "press" ? handlers.onPress : event.name === "hold" ? handlers.onHold : handlers.onRelease;
    callback?.(event.buttons as i32, buttons as i32);
  };
}
