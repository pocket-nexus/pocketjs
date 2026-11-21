// Per-frame callback registry and deferred-press dispatch, shared by the Solid
// (frame.ts) and Vue Vapor (frame-vue-vapor.ts) frame pumps. The pumps own
// their framework's reactive scope and lifecycle; this module owns the order
// in which frame callbacks and deferred presses run.

import type { DeferredPress } from "./input.ts";
import type { NodeMirror } from "./native-tree.ts";

export type FrameCallback = (buttons: number) => void;

/** The registrations one frame runs, frozen when the frame starts. */
export interface FrameSnapshot {
  readonly callbacks: readonly FrameCallback[];
  readonly placed: readonly (readonly [FrameCallback, NodeMirror])[];
}

/** Runs one deferred press; the Solid pump restores the node's list row. */
export type RunPress = (node: NodeMirror, invoke: () => void) => void;

export class FrameRegistry {
  private readonly callbacks = new Set<FrameCallback>();
  private readonly placed = new Map<FrameCallback, NodeMirror>();
  // Rebuilt after a registration changes and never mutated once built, so a
  // frame holding it keeps the set it started with.
  private snapshot: FrameSnapshot | null = null;

  /** Register `callback`; with `placement` its press joins the document-order
   *  queue at that node instead of running in registration order. */
  add(callback: FrameCallback, placement?: NodeMirror): () => void {
    if (placement) this.placed.set(callback, placement);
    else this.callbacks.add(callback);
    this.snapshot = null;
    return () => {
      const removed = this.callbacks.delete(callback);
      if (this.placed.delete(callback) || removed) this.snapshot = null;
    };
  }

  clear(): void {
    this.callbacks.clear();
    this.placed.clear();
    this.snapshot = null;
  }

  /** Freeze registration before any callback can mount another handler. */
  freeze(): FrameSnapshot {
    return (this.snapshot ??= { callbacks: [...this.callbacks], placed: [...this.placed] });
  }
}

/**
 * One frame's input phase: gesture recognition (`beforeHooks`), the frozen
 * frame callbacks in registration order, then every deferred press — placed
 * callbacks and whatever `resolveInput` queued — in the live tree's document
 * order, parents before children and a node's presses in queue order. Presses
 * on nodes that left the tree are dropped.
 */
export function dispatchFrame(
  frame: FrameSnapshot,
  buttons: number,
  run: RunPress,
  beforeHooks?: (defer: DeferredPress) => void,
  resolveInput?: (defer: DeferredPress) => void,
): void {
  // Most frames defer nothing: allocate the queue on the first press.
  let pending: Map<NodeMirror, (() => void)[]> | undefined;
  const enqueue: DeferredPress = (node, invoke) => {
    pending ??= new Map();
    const entries = pending.get(node);
    if (entries) entries.push(invoke);
    else pending.set(node, [invoke]);
  };
  // Gesture recognition keeps its original phase; its declarative presses
  // join the ordered queue instead of running ahead of all input handlers.
  beforeHooks?.(enqueue);
  for (let i = 0; i < frame.callbacks.length; i++) frame.callbacks[i](buttons);
  for (let i = 0; i < frame.placed.length; i++) {
    const [callback, node] = frame.placed[i];
    enqueue(node, () => callback(buttons));
  }
  resolveInput?.(enqueue);
  if (!pending) return;
  // A component's setup order is not its position after a keyed move.
  // Snapshot the live mirror's document order before running any handlers.
  const queued = pending;
  const roots = new Set<NodeMirror>();
  for (const node of queued.keys()) {
    if (!(node as NodeMirror & { readonly isConnected: boolean }).isConnected) continue;
    let root = node;
    while (root.parent) root = root.parent;
    roots.add(root);
  }
  const ordered: [NodeMirror, () => void][] = [];
  const collect = (node: NodeMirror): void => {
    const entries = queued.get(node);
    if (entries) for (const invoke of entries) ordered.push([node, invoke]);
    for (const child of node.children) collect(child);
  };
  for (const root of roots) collect(root);
  for (const [node, invoke] of ordered) run(node, invoke);
}
