import { onScopeDispose } from "vue";
import { createLifecycleScheduler } from "./aot-lifecycle.ts";
import { flushVueUpdates } from "./vue-vapor-flush.ts";
import { reactModelRegions, type ModelRegion } from "./model-reactive.ts";
import { disposeModelTasks, drainModelCommands } from "./model-tasks.ts";

// Vue's queued render effects already defer structure until update() is called.
const scheduler = createLifecycleScheduler(run => { run(); reactModelRegions(); }, flushVueUpdates);
const models = new Map<ModelRegion, { root: boolean; dispose: () => void }>();
export function registerModelLifecycle(region: ModelRegion, root = false): () => void {
  const mount = scheduler.register(() => { if (!region.disposed && region.initial) { region.react(true); region.settle(); } }, "mount");
  const unmount = scheduler.register(() => { region.dispose(); disposeModelTasks(region); models.delete(region); }, "unmount");
  const dispose = () => { mount(); unmount(); };
  models.set(region, { root, dispose }); return dispose;
}
export function disposeRootModelRegions(): void { for (const entry of models.values()) if (entry.root) entry.dispose(); }
export function onMounted(callback: () => void): void { onScopeDispose(scheduler.register(callback, "mount")); }
export function onUnmounted(callback: () => void): void { onScopeDispose(scheduler.register(callback, "unmount")); }
export function flushLifecycleHooks(): void { scheduler.flush(); drainModelCommands(); }
export function flushUnmountedHooks(): void { scheduler.flushUnmounted(); drainModelCommands(); }
export function resetLifecycleHooks(): void {
  scheduler.reset();
  for (const [region, entry] of [...models]) if (!region.disposed && region.initial) registerModelLifecycle(region, entry.root);
}
