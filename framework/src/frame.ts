// App-facing lifecycle callbacks.
//
// Hosts still drive one low-level global frame callback per vblank/rAF tick,
// but application code should register component-scoped lifecycle callbacks instead of
// patching mount() with a global per-frame callback.

import { batch, createContext, createSignal, onCleanup, useContext, type Accessor } from "solid-js";
import { __resetAnalog } from "./analog.ts";
import { __beginAxisFrame, __endAxisFrame, __resetAxisInput, __axisDelta, RelativeAxis, type RelativeAxisId, type AxisDelta } from "./relative-axis.ts";
import { __beginMotionFrame, __endMotionFrame, __motionReader, __resetMotionInput, type MotionMinQualityName, type MotionPayload, type MotionState, type MotionValueName } from "./motion.ts";
import type { i32 } from "./numeric-microts.ts";
import type { NodeMirror } from "./native-tree.ts";
import type { DeferredPress } from "./input.ts";
import { dispatchFrame, FrameRegistry, type FrameCallback, type FrameSnapshot, type RunPress } from "./frame-dispatch.ts";
import { RowContext, nodeRow, withRowSnapshot } from "./solid-row.ts";
import { flushLifecycleHooks, resetLifecycleHooks } from "./lifecycle-solid-aot.ts";
import { reactModelRegions } from "./model-reactive.ts";
import { resumeModelTasks, resetModelTaskClock } from "./model-tasks.ts";
import { pollModelAnimations } from "./model-animation.ts";

export { __setAnalog, analogRaw, analogX, analogY, rightAnalogRaw, rightAnalogX, rightAnalogY } from "./analog.ts";

const registry = new FrameRegistry();
/** Callbacks of the system layer (the agent's overlay): they run while the
 * app is suspended. */
const systemRegistry = new FrameRegistry();
let appSuspended = false;
let merged: { app: FrameSnapshot; system: FrameSnapshot; frame: FrameSnapshot } | null = null;
const NO_FRAME: FrameSnapshot = { callbacks: [], placed: [] };
let buttonHandlerBlockDepth = 0;

/** Frame callbacks registered under a true value belong to the system layer. */
export const SystemFrameContext = createContext(false);

/** Stop (or resume) the app's frame callbacks, button handlers included.
 *  The system layer's keep running; native animations, timers and service
 *  deliveries are not affected. */
export function suspendApp(suspended: boolean): void {
  appSuspended = suspended;
}

export function isAppSuspended(): boolean {
  return appSuspended;
}

function frameSnapshot(): FrameSnapshot {
  const app = appSuspended ? NO_FRAME : registry.freeze();
  const system = systemRegistry.freeze();
  if (system.callbacks.length === 0 && system.placed.length === 0) return app;
  if (merged?.app !== app || merged.system !== system) {
    merged = {
      app,
      system,
      frame: { callbacks: [...app.callbacks, ...system.callbacks], placed: [...app.placed, ...system.placed] },
    };
  }
  return merged.frame;
}

/** Deferred presses run inside the list row their node was created in. */
const runInRow: RunPress = (node, invoke) => withRowSnapshot(nodeRow(node), invoke);

export function resetFrameHooks(): void {
  resetModelTaskClock();
  registry.clear();
  systemRegistry.clear();
  appSuspended = false;
  merged = null;
  buttonHandlerBlockDepth = 0;
  __resetAnalog();
  __resetAxisInput();
  __resetMotionInput();
  resetLifecycleHooks();
}

export function runFrameHooks(buttons: number, axisDeltas?: readonly AxisDelta[], resolveInput?: (defer: DeferredPress) => void, beforeHooks?: (defer: DeferredPress) => void, motion?: MotionState | null): void {
  __beginAxisFrame(axisDeltas);
  try {
    __beginMotionFrame(motion);
    const frame = frameSnapshot();
    batch(() => {
      pollModelAnimations(); resumeModelTasks();
      dispatchFrame(frame, buttons, runInRow, beforeHooks, resolveInput);
      reactModelRegions();
    });
    flushLifecycleHooks();
  } finally { __endAxisFrame(); __endMotionFrame(); }
}

function registerFrame(callback: FrameCallback, placement?: NodeMirror): () => void {
  const row = useContext(RowContext);
  const target = useContext(SystemFrameContext) ? systemRegistry : registry;
  // Outside a list row there is no snapshot to take, so the wrapper calls
  // straight through instead of allocating a closure every frame. It stays a
  // distinct function so registering one callback twice still runs it twice.
  const wrapped: FrameCallback = placement
    ? callback
    : row
      ? buttons => withRowSnapshot(row, () => callback(buttons))
      : buttons => callback(buttons);
  const dispose = target.add(wrapped, placement);
  onCleanup(dispose);
  return dispose;
}

export function onFrame(callback: FrameCallback): void { registerFrame(callback); }

export interface AxisDeltaOptions { active?: boolean | (() => boolean) }

export function onAxisDelta(axis: RelativeAxisId, callback: (delta: i32) => void, options: AxisDeltaOptions = {}, placement?: NodeMirror): () => void {
  if (axis !== RelativeAxis.Primary && axis !== RelativeAxis.Secondary) throw new Error(`Unknown relative axis ${axis}`);
  return registerFrame(() => {
    const delta = __axisDelta(axis);
    if (delta === 0) return;
    const active = typeof options.active === "function" ? options.active() : options.active ?? true;
    if (active) callback(delta);
  }, placement);
}

export interface MotionOptions { active?: boolean | (() => boolean); minQuality?: MotionMinQualityName }

/** Fires once per frame whose motion state carries `value` at `minQuality` or better. */
export function onMotion<V extends MotionValueName>(value: V, callback: (...payload: MotionPayload<V>) => void, options: MotionOptions = {}, placement?: NodeMirror): () => void {
  const read = __motionReader(value, options.minQuality);
  return registerFrame(() => {
    const payload = read();
    if (!payload) return;
    const active = typeof options.active === "function" ? options.active() : options.active ?? true;
    if (active) (callback as (...payload: number[]) => void)(...payload);
  }, placement);
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
  placement?: NodeMirror,
): void {
  let prevButtons = opts.latched ? ~0 : 0; // latched: "everything held" until released
  registerFrame((buttons) => {
    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;
    const active = typeof opts.active === "function" ? opts.active() : opts.active ?? true;
    if (!active) return;
    if (buttonHandlerBlockDepth > 0 && !opts.allowWhenBlocked) return;
    if (pressed & mask) callback(pressed, buttons);
  }, placement);
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
