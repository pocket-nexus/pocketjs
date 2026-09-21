import { batch, getOwner, onCleanup as disposeWithOwner, type Owner } from "solid-js";
import { createLifecycleScheduler } from "./aot-lifecycle.ts";
import { reactModelRegions, type ModelRegion } from "./model-reactive.ts";
import { disposeModelTasks, drainModelCommands } from "./model-tasks.ts";

const scheduler = createLifecycleScheduler(run => batch(() => { run(); reactModelRegions(); }));
let roots = new WeakSet<Owner>();
const models = new Map<ModelRegion, { root: boolean; dispose: () => void }>();
export function registerModelLifecycle(region: ModelRegion, root = false): () => void {
  const mount = scheduler.register(() => { if (!region.disposed && region.initial) { region.react(true); region.settle(); } }, "mount");
  const unmount = scheduler.register(() => { region.dispose(); disposeModelTasks(region); models.delete(region); }, "unmount");
  const dispose = () => { mount(); unmount(); };
  models.set(region, { root, dispose });
  return dispose;
}
export function disposeRootModelRegions(): void { for (const entry of models.values()) if (entry.root) entry.dispose(); }

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
export function flushLifecycleHooks(): void { scheduler.flush(); drainModelCommands(); }
export function flushUnmountedHooks(): void { scheduler.flushUnmounted(); drainModelCommands(); }
export function resetLifecycleHooks(): void {
  scheduler.reset(); roots = new WeakSet();
  for (const [region, entry] of [...models]) if (!region.disposed && region.initial) registerModelLifecycle(region, entry.root);
}
