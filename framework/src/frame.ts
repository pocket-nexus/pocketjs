// App-facing lifecycle callbacks.
//
// Hosts still drive one low-level global frame callback per vblank/rAF tick,
// but application code should register component-scoped lifecycle callbacks instead of
// patching mount() with a global per-frame callback.

import { batch, createSignal, onCleanup, useContext, type Accessor } from "solid-js";
import { __resetAnalog } from "./analog.ts";
import { __beginAxisFrame, __endAxisFrame, __resetAxisInput, __axisDelta, RelativeAxis, type RelativeAxisId, type AxisDelta } from "./relative-axis.ts";
import type { i32 } from "./numeric-microts.ts";
import type { NodeMirror } from "./native-tree.ts";
import type { DeferredPress } from "./input.ts";
import { RowContext, nodeRow, withRowSnapshot } from "./solid-row.ts";
import { flushLifecycleHooks, resetLifecycleHooks } from "./lifecycle-solid-aot.ts";
import { reactModelRegions } from "./model-reactive.ts";
import { resumeModelTasks, resetModelTaskClock } from "./model-tasks.ts";
import { pollModelAnimations } from "./model-animation.ts";

export { __setAnalog, analogRaw, analogX, analogY, rightAnalogRaw, rightAnalogX, rightAnalogY } from "./analog.ts";

type FrameCallback = (buttons: number) => void;

const callbacks = new Set<FrameCallback>();
const placedCallbacks = new Map<FrameCallback, NodeMirror>();
let buttonHandlerBlockDepth = 0;

export function resetFrameHooks(): void {
  resetModelTaskClock();
  callbacks.clear();
  placedCallbacks.clear();
  buttonHandlerBlockDepth = 0;
  __resetAnalog();
  __resetAxisInput();
  resetLifecycleHooks();
}

export function runFrameHooks(buttons: number, axisDeltas?: readonly AxisDelta[], resolveInput?: (defer: DeferredPress) => void, beforeHooks?: (defer: DeferredPress) => void): void {
  __beginAxisFrame(axisDeltas);
  try {
    // Freeze registration before any callback can mount another handler.
    const frameCallbacks = [...callbacks];
    const placed = [...placedCallbacks];
    batch(() => {
      pollModelAnimations(); resumeModelTasks();
      const pending = new Map<NodeMirror, (() => void)[]>();
      const enqueue: DeferredPress = (node, invoke) => {
        const entries = pending.get(node);
        if (entries) entries.push(invoke);
        else pending.set(node, [invoke]);
      };
      beforeHooks?.(enqueue);
      for (const cb of frameCallbacks) cb(buttons);
      for (const [callback, node] of placed) enqueue(node, () => callback(buttons));
      resolveInput?.(enqueue);
      const roots = new Set<NodeMirror>();
      for (const node of pending.keys()) {
        if (!(node as NodeMirror & { readonly isConnected: boolean }).isConnected) continue;
        let root = node;
        while (root.parent) root = root.parent;
        roots.add(root);
      }
      const ordered: { node: NodeMirror; invoke: () => void }[] = [];
      const collect = (node: NodeMirror): void => {
        for (const invoke of pending.get(node) ?? []) ordered.push({ node, invoke });
        for (const child of node.children) collect(child);
      };
      for (const root of roots) collect(root);
      for (const { node, invoke } of ordered) withRowSnapshot(nodeRow(node), invoke);
      reactModelRegions();
    });
    flushLifecycleHooks();
  } finally { __endAxisFrame(); }
}

function registerFrame(callback: FrameCallback, placement?: NodeMirror): () => void {
  const row = useContext(RowContext);
  const wrapped: FrameCallback = placement ? callback : buttons => withRowSnapshot(row, () => callback(buttons));
  if (placement) placedCallbacks.set(wrapped, placement);
  else callbacks.add(wrapped);
  const dispose = () => { callbacks.delete(wrapped); placedCallbacks.delete(wrapped); };
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
