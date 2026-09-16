import { onScopeDispose } from "vue";
import { createLifecycleScheduler } from "./aot-lifecycle.ts";
import { flushVueUpdates } from "./vue-vapor-flush.ts";

// Vue's queued render effects already defer structure until update() is called.
const scheduler = createLifecycleScheduler(run => run(), flushVueUpdates);
export function onMounted(callback: () => void): void { onScopeDispose(scheduler.register(callback, "mount")); }
export function onUnmounted(callback: () => void): void { onScopeDispose(scheduler.register(callback, "unmount")); }
export function flushLifecycleHooks(): void { scheduler.flush(); }
export function flushUnmountedHooks(): void { scheduler.flushUnmounted(); }
export function resetLifecycleHooks(): void { scheduler.reset(); }
