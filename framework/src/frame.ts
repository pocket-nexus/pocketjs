// App-facing lifecycle callbacks.
//
// Hosts still drive one low-level global frame callback per vblank/rAF tick,
// but application code should register component-scoped lifecycle callbacks instead of
// patching mount() with a global per-frame callback.

import { createSignal, onCleanup, type Accessor } from "solid-js";
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

export function onFrame(callback: FrameCallback): void {
  callbacks.add(callback);
  onCleanup(() => callbacks.delete(callback));
}

export interface ButtonPressOptions {
  /**
   * Modal/system handlers can opt out of the background action block. Normal
   * app handlers should stay blocked while a modal owns input.
   */
  allowWhenBlocked?: boolean;
  active?: boolean | (() => boolean);
  /**
   * Require the button to be seen UP for at least one frame before its next
   * edge counts. A component that mounts UNDER the user's held finger (a
   * screen opened by a Focusable press, an on-screen-keyboard chord) would
   * otherwise read the still-held button as a fresh press one frame later.
   * Scripted tapes/goldens pulse buttons for single frames and are unaffected.
   */
  latched?: boolean;
}

/** Whether a modal (keyboard, sheet) holds the button-handler block. */
export function isButtonHandlerBlocked(): boolean {
  return buttonHandlerBlockDepth > 0;
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

export function onButtonPress(
  mask: number,
  callback: (pressed: number, buttons: number) => void,
  opts: ButtonPressOptions = {},
): void {
  let prevButtons = opts.latched ? ~0 : 0; // latched: "everything held" until released
  onFrame((buttons) => {
    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;
    const active = typeof opts.active === "function" ? opts.active() : opts.active ?? true;
    if (!active) return;
    if (buttonHandlerBlockDepth > 0 && !opts.allowWhenBlocked) return;
    if (pressed & mask) callback(pressed, buttons);
  });
}

export interface SpriteAnimationOptions {
  /** Number of host frames each sprite frame remains visible. */
  frameStep?: number;
}

export function createSpriteAnimation(frames: readonly string[], opts: SpriteAnimationOptions = {}): Accessor<string> {
  if (frames.length === 0) {
    throw new Error("PocketJS: createSpriteAnimation() requires at least one frame");
  }
  const frameStep = Math.max(1, Math.floor(opts.frameStep ?? 1));
  const [frame, setFrame] = createSignal(0);
  onFrame(() => {
    setFrame((frame() + 1) % (frames.length * frameStep));
  });
  return () => frames[Math.floor(frame() / frameStep) % frames.length];
}
