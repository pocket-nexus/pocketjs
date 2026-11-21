import { createContext, useContext } from "solid-js";
import type { NodeMirror } from "./native-tree.ts";

export interface RowSnapshot<T> { item: T; index: number }
export interface RowContextValue<T = unknown> {
  parent?: RowContextValue;
  resolve: () => RowSnapshot<T> | undefined;
  snapshot?: RowSnapshot<T>;
}
export const RowContext = createContext<RowContextValue>();
const nodeRows = new WeakMap<NodeMirror, RowContextValue>();

export function captureNodeRow(node: NodeMirror): void {
  const row = useContext(RowContext);
  if (row) nodeRows.set(node, row);
}

export function nodeRow(node: NodeMirror): RowContextValue | undefined { return nodeRows.get(node); }

// A Rust row snapshot owns its record. Copy the plain data admitted by AOT so
// in-place model mutations followed by a signal write cannot change a running
// handler's fields. Keep opaque objects intact for ordinary Solid applications.
function snapshotValue(value: unknown, copies = new Map<object, unknown>()): unknown {
  if (!value || typeof value !== "object") return value;
  if (copies.has(value)) return copies.get(value);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  copies.set(value, copy);
  for (const key of Object.keys(value)) (copy as Record<string, unknown>)[key] = snapshotValue((value as Record<string, unknown>)[key], copies);
  return copy;
}

/** Resolve outer rows first so nested list sources read the current outer item. */
export function withRowSnapshot(row: RowContextValue | undefined, invoke: () => void): void {
  if (!row) { invoke(); return; }
  const chain: RowContextValue[] = [];
  for (let current: RowContextValue | undefined = row; current; current = current.parent) chain.unshift(current);
  const previous = chain.map(context => context.snapshot);
  try {
    for (const context of chain) {
      const resolved = context.resolve();
      if (!resolved) return;
      context.snapshot = { item: snapshotValue(resolved.item), index: resolved.index };
    }
    invoke();
  } finally {
    for (let i = 0; i < chain.length; i++) chain[i]!.snapshot = previous[i];
  }
}
