import { batch, getOwner, onCleanup as disposeWithOwner, type Owner } from "solid-js";
import { createLifecycleScheduler } from "./aot-lifecycle.ts";

const scheduler = createLifecycleScheduler(batch);
let roots = new WeakSet<Owner>();

function register(callback: () => void, phase: "mount" | "unmount"): void {
  const owner = getOwner();
  if (!owner) throw new Error(`PocketJS: on${phase === "mount" ? "Mount" : "Cleanup"}() requires a Solid owner`);
  let root = owner;
  while (root.owner) root = root.owner;
  if (!roots.has(root)) {
    roots.add(root);
    // Solid runs owner cleanups in reverse order after disposing children.
    // Key may have registered its row disposers before the first app hook, so
    // place the sentinel at the start of the root's public cleanup list.
    (root.cleanups ??= []).unshift(() => scheduler.flushUnmounted());
  }
  disposeWithOwner(scheduler.register(callback, phase));
}

export function onMount(callback: () => void): void { register(callback, "mount"); }
export function onCleanup(callback: () => void): void { register(callback, "unmount"); }
export function flushLifecycleHooks(): void { scheduler.flush(); }
export function flushUnmountedHooks(): void { scheduler.flushUnmounted(); }
export function resetLifecycleHooks(): void { scheduler.reset(); roots = new WeakSet(); }
