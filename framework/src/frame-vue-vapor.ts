// App-facing lifecycle callbacks for Vue Vapor.

import { computed, onScopeDispose, shallowRef, type ComputedRef } from "vue";
import { __resetAnalog } from "./analog.ts";
import { __beginAxisFrame, __endAxisFrame, __resetAxisInput, __axisDelta, RelativeAxis, type RelativeAxisId, type AxisDelta } from "./relative-axis.ts";
import { __beginMotionFrame, __endMotionFrame, __motionReader, __resetMotionInput, type MotionMinQualityName, type MotionPayload, type MotionState, type MotionValueName } from "./motion.ts";
import type { i32 } from "./numeric-microts.ts";
import type { NodeMirror } from "./native-tree.ts";
import type { DeferredPress } from "./input.ts";
import { dispatchFrame, FrameRegistry, type FrameCallback, type RunPress } from "./frame-dispatch.ts";
import { flushLifecycleHooks, resetLifecycleHooks } from "./lifecycle-vue-aot.ts";
import { reactModelRegions } from "./model-reactive.ts";
import { resumeModelTasks, resetModelTaskClock } from "./model-tasks.ts";
import { pollModelAnimations } from "./model-animation.ts";

export { __setAnalog, analogRaw, analogX, analogY, rightAnalogRaw, rightAnalogX, rightAnalogY } from "./analog.ts";

const registry = new FrameRegistry();
let buttonHandlerBlockDepth = 0;

const runPress: RunPress = (_node, invoke) => invoke();

export function resetFrameHooks(): void {
  resetModelTaskClock();
  registry.clear();
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
    const frame = registry.freeze();
    pollModelAnimations(); resumeModelTasks();
    dispatchFrame(frame, buttons, runPress, beforeHooks, resolveInput);
    reactModelRegions();
    flushLifecycleHooks();
  }
  finally { __endAxisFrame(); __endMotionFrame(); }
}

function registerFrame(callback: FrameCallback, placement?: NodeMirror): () => void {
  const dispose = registry.add(callback, placement);
  onScopeDispose(dispose, true);
  return dispose;
}

export function onFrame(callback: FrameCallback): void {
  registerFrame(callback);
}

export interface ButtonPressOptions {
  allowWhenBlocked?: boolean;
  active?: boolean | (() => boolean);
  /** See framework/src/frame.ts: arm only after the button is seen up for one frame. */
  latched?: boolean;
}

export interface AxisDeltaOptions { active?: boolean | (() => boolean) }
export function onAxisDelta(axis: RelativeAxisId, callback: (delta: i32) => void, options: AxisDeltaOptions = {}, placement?: NodeMirror): () => void {
  if (axis !== RelativeAxis.Primary && axis !== RelativeAxis.Secondary) throw new Error(`Unknown relative axis ${axis}`);
  const listener: FrameCallback = () => {
    const delta = __axisDelta(axis);
    if (delta === 0) return;
    const active = typeof options.active === "function" ? options.active() : options.active ?? true;
    if (active) callback(delta);
  };
  return registerFrame(listener, placement);
}

export interface MotionOptions { active?: boolean | (() => boolean); minQuality?: MotionMinQualityName }
/** See framework/src/frame.ts: fires on frames carrying `value` at `minQuality` or better. */
export function onMotion<V extends MotionValueName>(value: V, callback: (...payload: MotionPayload<V>) => void, options: MotionOptions = {}, placement?: NodeMirror): () => void {
  const read = __motionReader(value, options.minQuality);
  const listener: FrameCallback = () => {
    const payload = read();
    if (!payload) return;
    const active = typeof options.active === "function" ? options.active() : options.active ?? true;
    if (active) (callback as (...payload: number[]) => void)(...payload);
  };
  return registerFrame(listener, placement);
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
    if (!(pressed & mask)) return;
    const active = typeof opts.active === "function" ? opts.active() : opts.active ?? true;
    if (!active) return;
    if (buttonHandlerBlockDepth > 0 && !opts.allowWhenBlocked) return;
    callback(pressed, buttons);
  }, placement);
}

export interface SpriteAnimationOptions {
  frameStep?: number;
}

export function createSpriteAnimation(frames: readonly string[], opts: SpriteAnimationOptions = {}): ComputedRef<string> {
  if (frames.length === 0) {
    throw new Error("PocketJS: createSpriteAnimation() requires at least one frame");
  }
  const frameStep = Math.max(1, Math.floor(opts.frameStep ?? 1));
  const frame = shallowRef(0);
  onFrame(() => {
    frame.value = (frame.value + 1) % (frames.length * frameStep);
  });
  return computed(() => frames[Math.floor(frame.value / frameStep) % frames.length]);
}
