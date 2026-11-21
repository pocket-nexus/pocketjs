import { batch, createSignal, getOwner, onCleanup, onMount, untrack, type Accessor } from "solid-js";
import { onFrame } from "./lifecycle.ts";
import { createResourceScheduler, type ResourceBytes, type ResourceCacheOptions, type ResourceDemand, type ResourceSchedulerOptions } from "./resource-cache.ts";
import { pending, ready, type ResourceState } from "./resource-state.ts";

export interface ResourceCollectionOptions<I, R extends ResourceBytes, T> extends Omit<ResourceCacheOptions<I, R, T>, "changed"> {
  maxViews: number;
  /** Defaults to maxEntries. The union can contain at most maxViews times this many keys. */
  maxDemandsPerView?: number;
}
export interface ResourceViewOptions<I> { demand: Accessor<readonly ResourceDemand<I>[]> }
export interface ResourceView<I, T> {
  state(input: I): ResourceState<T>;
  /** An absent item in a loaded page remains pending; page errors are preserved. */
  state<U>(input: I, select: (value: T) => U | undefined): ResourceState<U>;
  value(input: I): T | undefined;
  dispose(): void;
}
export interface ResourceCollection<I, T> {
  /** Prefer createResourceView() in component setup. */
  view(options: ResourceViewOptions<I>): ResourceView<I, T>;
  invalidate(matches?: (input: I) => boolean, dropValue?: boolean): void;
  clear(): void;
  cancel(): void;
  dispose(): void;
  stats(): { entries: number; cost: number; ready: number; views: number; demands: number };
}

function owner() {
  if (!getOwner()) throw new Error("Resources require a Solid owner");
}
function positive(n: number, name: string) {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid resource ${name}`);
  return n;
}

/** One runtime per shared work budget. Mount registers one frame hook after
 * component setup; teardown releases all collections, requests and native values. */
export function createResourceRuntime(options: ResourceSchedulerOptions) {
  owner();
  const scheduler = createResourceScheduler(options);
  const collections = new Set<{ plan(): void; flush(): void; dispose(): void }>();
  let dead = false, stepping = false;

  function createCollection<I, R extends ResourceBytes, T>(config: ResourceCollectionOptions<I, R, T>): ResourceCollection<I, T> {
    if (dead) throw new Error("Resource runtime is disposed");
    positive(config.maxViews, "maxViews");
    const maxDemands = positive(config.maxDemandsPerView ?? config.maxEntries, "maxDemandsPerView");
    type Demand = ResourceDemand<I> & { reserved: number };
    type View = { wanted: Map<string, Demand>; plan: ResourceViewOptions<I>["demand"]; notify(): void; dispose(): void };
    const views = new Set<View>();
    const lanes = new Map<string, { read: Accessor<number>; notify(): void }>();
    const dirty = new Set<string>();
    let disposed = false;
    const cache = scheduler.createCache({ ...config, changed(input) { dirty.add(config.key(input)); } });

    function flush() {
      const keys = [...dirty]; dirty.clear();
      for (const key of keys) lanes.get(key)?.notify();
    }
    function validate(demands: readonly ResourceDemand<I>[]) {
      if (demands.length > maxDemands) throw new Error("Resource view demand exceeds budget");
      const wanted = new Map<string, Demand>();
      for (const demand of demands) {
        const key = config.key(demand.input);
        if (typeof key !== "string" || !key.length || key.length > 1024 || !Number.isFinite(demand.priority)) throw new Error("Invalid resource identity or priority");
        const reserved = positive(config.cost(demand.input), "cost");
        const previous = wanted.get(key);
        if (!previous || demand.priority < previous.priority) wanted.set(key, { ...demand, reserved, pin: !!(previous?.pin || demand.pin) });
        else if (demand.pin) previous.pin = true;
      }
      return wanted;
    }
    function reconcile() {
      if (disposed) return;
      const union = new Map<string, Demand>();
      for (const view of views) for (const [key, demand] of view.wanted) {
        const previous = union.get(key);
        if (!previous || demand.priority < previous.priority) union.set(key, { ...demand, pin: !!(previous?.pin || demand.pin) });
        else if (demand.pin) previous.pin = true;
      }
      for (const key of union.keys()) if (!lanes.has(key)) {
        const [read, write] = createSignal(0);
        lanes.set(key, { read, notify: () => write(n => n + 1) });
      }
      for (const [key, lane] of lanes) if (!union.has(key)) { lane.notify(); lanes.delete(key); }
      // Demand storage and resident values have separate bounds. Views that do
      // not fit retain their pending state; they cannot increase the cache budget.
      const admitted: ResourceDemand<I>[] = [];
      let reserved = 0;
      for (const demand of [...union.values()].sort((a, b) => a.priority - b.priority)) {
        if (admitted.length >= config.maxEntries) break;
        if (reserved + demand.reserved > config.maxCost) continue;
        admitted.push(demand); reserved += demand.reserved;
      }
      cache.reconcile(admitted);
    }
    const collection = {
      plan() {
        // Validate every view before replacing any of this collection's demand.
        const planned = [...views].map(view => ({ view, wanted: validate(untrack(view.plan)) }));
        for (const { view, wanted } of planned) {
          const changed = wanted.size !== view.wanted.size || [...wanted.keys()].some(key => !view.wanted.has(key));
          view.wanted = wanted;
          if (changed) view.notify();
        }
        reconcile();
      },
      flush,
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const view of [...views]) view.dispose();
        cache.dispose(); dirty.clear(); lanes.clear(); collections.delete(collection);
      },
    };
    collections.add(collection);
    function update(action: () => void) { batch(() => { action(); flush(); }); }
    return {
      view(options) {
        owner();
        if (disposed || views.size >= config.maxViews) throw new Error("Resource view budget exceeded");
        const [membership, notify] = createSignal(0);
        let closed = false;
        const view: View = {
          wanted: new Map(), plan: options.demand, notify: () => notify(n => n + 1),
          dispose() {
            if (closed) return;
            closed = true;
            update(() => { views.delete(view); view.wanted.clear(); view.notify(); reconcile(); });
          },
        };
        views.add(view); onCleanup(view.dispose);
        function state(input: I): ResourceState<T>;
        function state<U>(input: I, select: (value: T) => U | undefined): ResourceState<U>;
        function state<U>(input: I, select?: (value: T) => U | undefined): ResourceState<T | U> {
          membership();
          const key = config.key(input);
          if (closed || !view.wanted.has(key)) return pending();
          lanes.get(key)?.read();
          const current = cache.state(input);
          if (current.status !== "ready" || !select) return current;
          const value = select(current.value);
          return value === undefined ? pending() : ready(value);
        }
        return { state, value(input) { const current = state(input); return current.status === "ready" ? current.value : undefined; }, dispose: view.dispose };
      },
      invalidate: (matches, dropValue) => update(() => cache.invalidate(matches, dropValue)),
      clear: () => update(cache.clear), cancel: () => update(cache.cancel),
      dispose: () => update(collection.dispose),
      stats: () => ({ ...cache.stats(), views: views.size, demands: lanes.size }),
    };
  }
  function step() {
    if (dead || stepping) return;
    stepping = true;
    try {
      batch(() => {
        for (const collection of collections) collection.plan();
        scheduler.step();
        for (const collection of collections) collection.flush();
      });
    } finally { stepping = false; }
  }
  function dispose() {
    if (dead) return;
    dead = true;
    batch(() => { for (const collection of [...collections]) collection.dispose(); scheduler.dispose(); });
  }
  onCleanup(dispose);
  onMount(() => { if (!dead) onFrame(step); });
  return { createCollection, step, dispose, stats: scheduler.stats,
    cancel() { batch(() => { scheduler.cancel(); for (const collection of collections) collection.flush(); }); },
  };
}

/** Reads subscribe by key but never add demand or start IO. Each Solid owner
 * withdraws only its own view on cleanup; cached values belong to the collection. */
export function createResourceView<I, T>(collection: ResourceCollection<I, T>, options: ResourceViewOptions<I>): ResourceView<I, T> {
  return collection.view(options);
}
