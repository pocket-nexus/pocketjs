// App-facing lifecycle callbacks for Vue Vapor.

import { computed, onScopeDispose, shallowRef, type ComputedRef } from "vue";
import { __resetAnalog } from "./analog.ts";
import { __beginAxisFrame, __endAxisFrame, __resetAxisInput, __axisDelta, RelativeAxis, type RelativeAxisId, type AxisDelta } from "./relative-axis.ts";
import type { i32 } from "./numeric-vue-vapor.ts";
import type { NodeMirror } from "./native-tree.ts";
import type { DeferredPress } from "./input.ts";

export { __setAnalog, analogRaw, analogX, analogY, rightAnalogRaw, rightAnalogX, rightAnalogY } from "./analog.ts";

type FrameCallback = (buttons: number) => void;

const callbacks = new Set<FrameCallback>();
const placedCallbacks = new Map<FrameCallback, NodeMirror>();
let buttonHandlerBlockDepth = 0;

export function resetFrameHooks(): void {
  callbacks.clear();
  placedCallbacks.clear();
  buttonHandlerBlockDepth = 0;
  __resetAnalog();
  __resetAxisInput();
}

export function runFrameHooks(buttons: number, axisDeltas?: readonly AxisDelta[], resolveInput?: (defer: DeferredPress) => void, beforeHooks?: (defer: DeferredPress) => void): void {
  __beginAxisFrame(axisDeltas);
  try {
    const pending = new Map<NodeMirror, (() => void)[]>();
    const enqueue: DeferredPress = (node, invoke) => {
      const entries = pending.get(node);
      if (entries) entries.push(invoke);
      else pending.set(node, [invoke]);
    };
    // Gesture recognition keeps its original phase; its declarative presses
    // join the ordered queue instead of running ahead of all input handlers.
    beforeHooks?.(enqueue);
    // General lifecycle subscriptions preserve their phase before navigation.
    for (const cb of [...callbacks]) cb(buttons);
    for (const [callback, node] of placedCallbacks) enqueue(node, () => callback(buttons));
    resolveInput?.(enqueue);
    // A component's setup order is not its position after a keyed move.
    // Snapshot the live mirror's document order before running any handlers.
    const roots = new Set<NodeMirror>();
    for (const node of pending.keys()) {
      if (!(node as NodeMirror & { readonly isConnected: boolean }).isConnected) continue;
      let root = node;
      while (root.parent) root = root.parent;
      roots.add(root);
    }
    const ordered: (() => void)[] = [];
    const collect = (node: NodeMirror): void => {
      const entries = pending.get(node);
      if (entries) ordered.push(...entries);
      for (const child of node.children) collect(child);
    };
    for (const root of roots) collect(root);
    for (const invoke of ordered) invoke();
  }
  finally { __endAxisFrame(); }
}

function registerFrame(callback: FrameCallback, placement?: NodeMirror): () => void {
  if (placement) placedCallbacks.set(callback, placement);
  else callbacks.add(callback);
  const dispose = () => { callbacks.delete(callback); placedCallbacks.delete(callback); };
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
