// App-facing lifecycle callbacks for Octane.
//
// This module is compiled by the Octane compiler (framework=octane walks it),
// so the hook calls below get call-site slots and callers may invoke these
// custom hooks any number of times per component. `useEffectEvent` keeps the
// registered frame callback identity stable across re-renders while always
// running the latest closure.

import { useEffect, useEffectEvent, useRef, useState } from "octane";
import { __resetAnalog } from "./analog.ts";

export { __setAnalog, analogRaw, analogX, analogY, rightAnalogRaw, rightAnalogX, rightAnalogY } from "./analog.ts";

type FrameCallback = (buttons: number) => void;

const callbacks = new Set<FrameCallback>();
let buttonHandlerBlockDepth = 0;

export function resetFrameHooks(): void {
  callbacks.clear();
  buttonHandlerBlockDepth = 0;
  __resetAnalog();
}

export function runFrameHooks(buttons: number): void {
  for (const cb of [...callbacks]) cb(buttons);
}

export function useFrame(callback: FrameCallback): void {
  const stable = useEffectEvent(callback);
  useEffect(() => {
    callbacks.add(stable);
    return () => {
      callbacks.delete(stable);
    };
  }, []);
}

export interface ButtonPressOptions {
  allowWhenBlocked?: boolean;
  active?: boolean | (() => boolean);
  /** See framework/src/frame.ts: arm only after the button is seen up for one frame. */
  latched?: boolean;
}

export function pushButtonHandlerBlock(): () => void {
  buttonHandlerBlockDepth++;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    buttonHandlerBlockDepth = Math.max(0, buttonHandlerBlockDepth - 1);
  };
}

export function useButtonPress(
  mask: number,
  callback: (pressed: number, buttons: number) => void,
  opts: ButtonPressOptions = {},
): void {
  const prevButtons = useRef(opts.latched ? ~0 : 0); // latched: "everything held" until released
  const handler = useEffectEvent((buttons: number) => {
    const pressed = buttons & ~prevButtons.current;
    prevButtons.current = buttons;
    const active = typeof opts.active === "function" ? opts.active() : opts.active ?? true;
    if (!active) return;
    if (buttonHandlerBlockDepth > 0 && !opts.allowWhenBlocked) return;
    if (pressed & mask) callback(pressed, buttons);
  });
  useEffect(() => {
    callbacks.add(handler);
    return () => {
      callbacks.delete(handler);
    };
  }, []);
}

export interface SpriteAnimationOptions {
  frameStep?: number;
}

export function useSpriteAnimation(
  frames: readonly string[],
  opts: SpriteAnimationOptions = {},
): string {
  if (frames.length === 0) {
    throw new Error("PocketJS: useSpriteAnimation() requires at least one frame");
  }
  const frameStep = Math.max(1, Math.floor(opts.frameStep ?? 1));
  // The raw tick lives in a ref: state (and therefore a re-render) only
  // commits when the visible sprite index actually changes — 1/frameStep of
  // the ticks — and never for single-frame sprites. On the PSP a re-render
  // is the expensive unit, so this is a frame-budget contract, not a nicety.
  const tick = useRef(0);
  const shown = useRef(0);
  const [index, setIndex] = useState(0);
  useFrame(() => {
    if (frames.length === 1) return;
    tick.current = (tick.current + 1) % (frames.length * frameStep);
    const next = Math.floor(tick.current / frameStep) % frames.length;
    if (next !== shown.current) {
      shown.current = next;
      setIndex(next);
    }
  });
  return frames[index % frames.length];
}
