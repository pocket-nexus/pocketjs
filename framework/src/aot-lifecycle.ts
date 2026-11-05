// The JS execution classes share the AOT hook rounds and creation ordering.
export interface LifecycleHook {
  sequence: number;
  mount?: () => void;
  unmount?: () => void;
  destroyed: boolean;
  mounted: boolean;
}

export function createLifecycleScheduler(batch: (run: () => void) => void, update: () => void = () => {}) {
  const hooks = new Set<LifecycleHook>();
  let sequence = 0;
  let running = false;
  // Set by register and destroy: without either, flush has nothing to mount
  // or unmount and skips scanning every hook.
  let dirty = false;
  const dead = () => [...hooks].filter(hook => hook.destroyed).sort((a, b) => b.sequence - a.sequence);
  const destroy = (entries: LifecycleHook[]) => {
    for (const hook of entries) {
      hooks.delete(hook);
      hook.unmount?.();
    }
  };
  return {
    register(callback: () => void, phase: "mount" | "unmount"): () => void {
      const hook: LifecycleHook = { sequence: sequence++, [phase]: callback, destroyed: false, mounted: false };
      hooks.add(hook);
      dirty = true;
      return () => { hook.destroyed = true; dirty = true; };
    },
    flush(): void {
      if (running) return;
      running = true;
      try {
        update();
        for (let round = 0; ; round++) {
          if (!dirty) return;
          dirty = false;
          const removed = dead();
          const added = [...hooks].filter(hook => !hook.destroyed && !hook.mounted).sort((a, b) => a.sequence - b.sequence);
          if (removed.length === 0 && added.length === 0) return;
          const ranHooks = removed.some(hook => hook.unmount) || added.some(hook => hook.mount);
          if (ranHooks && round >= 8) throw new Error("PocketJS: AOT lifecycle exceeded eight hook rounds in one frame");
          // Both groups share one batch: a parent mount cannot cancel a child's
          // mount from this round by closing its branch.
          batch(() => {
            destroy(removed);
            for (const hook of added) {
              hook.mounted = true;
              hook.mount?.();
            }
          });
          if (!ranHooks) return;
          update();
        }
      } catch (error) {
        dirty = true; // a hook threw mid-round: rescan on the next flush
        throw error;
      } finally { running = false; }
    },
    flushUnmounted(): void {
      batch(() => destroy(dead()));
    },
    reset(): void { hooks.clear(); sequence = 0; running = false; dirty = false; },
  };
}
