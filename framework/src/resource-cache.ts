import { failed, pending, ready, type ResourceState } from "./resource-state.ts";

export type ResourceBytes = string | Uint8Array;
/** A loader result. `revalidated` means a conditional refresh confirmed the
 * resident value is current (e.g. HTTP-style 304 / relay notModified): the
 * cache keeps the existing materialized value and must not materialize the
 * empty confirmation or dispose the held bytes. Valid only while an entry is
 * already `ready`. */
export type ResourceResult<T> =
  | { ok: true; value: T }
  | { ok: true; revalidated: true }
  | { ok: false; error: unknown };
export type ResourceLoad<I, R> = (input: I, complete: (result: ResourceResult<R>) => void) => { cancel(): void } | false;
export interface ResourceDemand<I> { input: I; /** Lower runs first. */ priority: number; /** Cannot be evicted while desired. */ pin?: boolean }
export interface ResourceSnapshot<T> { state: ResourceState<T>; stale: boolean; refreshing: boolean; error?: unknown }
export interface ResourceCacheOptions<I, R extends ResourceBytes, T> {
  /** Explicit identity: include provider/account, revision and rendition parameters. */
  key(input: I): string;
  maxEntries: number;
  /** Reserved upper bounds, including native texture memory. No post-allocation admission. */
  maxCost: number;
  /** UTF-16 bytes for strings, byteLength for binary replies. */
  maxResponseBytes: number;
  cost(input: I): number;
  load: ResourceLoad<I, R>;
  /** Bounded decoding/upload only; executed by step(), never by a transport callback. */
  materialize(raw: R, input: I): T;
  dispose?(value: NoInfer<T>): void;
  changed?(input: I): void;
  maxAgeFrames?: number;
  retry?: { attempts: number; delayFrames: number; maxDelayFrames: number };
}
export interface ResourceSchedulerOptions {
  maxConcurrent: number;
  startsPerFrame: number;
  completionsPerFrame: number;
  maxCollections: number;
  /** Transport readiness/credit; commands can use the same transport directly. */
  available?: () => boolean;
}
interface Job { priority: number; order: number; start(): boolean }
interface Collection {
  candidate(): Job | undefined;
  speculative(): { priority: number; cancel(): void } | undefined;
  completion(): { order: number; run(): void } | undefined;
  cancel(): void;
  dispose(): void;
}
const positive = (n: number, name: string) => {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid resource ${name}`);
  return n;
};

/** One explicitly stepped, framework-neutral budget shared by heterogeneous caches.
 * Only reproducible reads belong here. Commands are never replayed by this API. */
export function createResourceScheduler(options: ResourceSchedulerOptions) {
  for (const name of ["maxConcurrent", "startsPerFrame", "completionsPerFrame", "maxCollections"] as const) positive(options[name], name);
  const collections = new Set<Collection>();
  let frame = 0, order = 0, completionOrder = 0, active = 0, disposed = false, stepping = false;
  function createCache<I, R extends ResourceBytes, T>(config: ResourceCacheOptions<I, R, T>) {
    if (disposed || collections.size >= options.maxCollections) throw new Error("Resource collection budget exceeded");
    positive(config.maxEntries, "maxEntries"); positive(config.maxCost, "maxCost"); positive(config.maxResponseBytes, "maxResponseBytes");
    if (config.maxAgeFrames !== undefined) positive(config.maxAgeFrames, "maxAgeFrames");
    const retry = config.retry ?? { attempts: 3, delayFrames: 30, maxDelayFrames: 300 };
    positive(retry.attempts, "attempts"); positive(retry.delayFrames, "delayFrames"); positive(retry.maxDelayFrames, "maxDelayFrames");
    type Entry = {
      key: string; input: I; cost: number; state: ResourceState<T>; stale: boolean;
      desired: boolean; pin: boolean; priority: number; touched: number; order: number;
      generation: number; busy: boolean; cancel?: () => void; result?: ResourceResult<R>;
      attempts: number; retryAt: number; loadedAt: number; error?: unknown;
      declinedAt: number; resultOrder: number; charged: boolean;
    };
    const entries = new Map<string, Entry>();
    let cost = 0, dead = false;
    const notify = (entry: Entry) => config.changed?.(entry.input);
    function stop(entry: Entry) {
      entry.generation++;
      if (entry.busy) {
        if (entry.charged) entry.attempts--;
        entry.charged = false; entry.busy = false; active--;
      }
      const cancel = entry.cancel; entry.cancel = undefined; entry.result = undefined;
      cancel?.();
    }
    function drop(entry: Entry) {
      stop(entry); entries.delete(entry.key); cost -= entry.cost;
      const state = entry.state; entry.state = pending(); notify(entry);
      if (state.status === "ready") config.dispose?.(state.value);
    }
    function clear() { for (const entry of entries.values()) drop(entry); }
    function cancel() { for (const entry of entries.values()) if (entry.busy) { stop(entry); notify(entry); } }
    function start(entry: Entry) {
      entry.busy = true; entry.stale = true; active++; const generation = ++entry.generation;
      try {
        const task = config.load(entry.input, result => {
          // Raw bounded data only. No decoding, texture allocation or UI publication here.
          if (!dead && entry.busy && entry.generation === generation && !entry.result) {
            // A revalidation confirmation carries no new bytes; the resident
            // value is kept and re-confirmed.
            let bytes: number;
            if (!result.ok) bytes = 0;
            else if ("value" in result) {
              const v = result.value;
              bytes = typeof v === "string" ? v.length * 2 : v instanceof Uint8Array ? v.byteLength : Infinity;
            } else bytes = 0;
            entry.result = bytes <= config.maxResponseBytes ? result : { ok: false, error: "Resource response exceeds budget" };
            entry.resultOrder = completionOrder++;
          }
        });
        if (!task) { stop(entry); entry.declinedAt = frame; return false; }
        entry.cancel = task.cancel; entry.attempts++; entry.charged = true; notify(entry); return true;
      } catch (error) {
        entry.result = { ok: false, error }; entry.resultOrder = completionOrder++;
        entry.attempts++; entry.charged = true; return true;
      }
    }
    function invalidateEntry(entry: Entry, dropValue: boolean) {
      stop(entry); entry.stale = true; entry.attempts = 0; entry.retryAt = 0; entry.error = undefined;
      const previous = entry.state;
      if (dropValue || previous.status === "error") entry.state = pending();
      notify(entry);
      if (dropValue && previous.status === "ready") config.dispose?.(previous.value);
    }
    const collection: Collection = {
      candidate() {
        let chosen: Entry | undefined;
        for (const entry of entries.values()) {
          if (!entry.desired || entry.busy || entry.declinedAt === frame || entry.attempts >= retry.attempts || frame < entry.retryAt) continue;
          if (!entry.stale && entry.state.status === "ready" && (config.maxAgeFrames === undefined || frame - entry.loadedAt < config.maxAgeFrames)) continue;
          if (!chosen || entry.priority < chosen.priority || entry.priority === chosen.priority && entry.order < chosen.order) chosen = entry;
        }
        return chosen && { priority: chosen.priority, order: chosen.order, start: () => start(chosen!) };
      },
      speculative() {
        let worst: Entry | undefined;
        for (const entry of entries.values()) if (entry.busy && !entry.pin && !entry.result && (!worst || entry.priority > worst.priority)) worst = entry;
        return worst && { priority: worst.priority, cancel: () => { stop(worst!); notify(worst!); } };
      },
      completion() {
        let chosen: Entry | undefined;
        for (const entry of entries.values()) if (entry.result && (!chosen || entry.resultOrder < chosen.resultOrder)) chosen = entry;
        if (!chosen) return;
        const entry = chosen;
        return { order: entry.resultOrder, run() {
          const result = entry.result!; entry.result = undefined; entry.cancel = undefined; entry.busy = false; entry.charged = false; active--;
          try {
            if (!result.ok) throw result.error;
            if ("value" in result) {
              const next = ready(config.materialize(result.value, entry.input));
              const previous = entry.state; entry.state = next; entry.stale = false; entry.error = undefined;
              entry.attempts = 0; entry.loadedAt = frame; notify(entry);
              if (previous.status === "ready" && next.status === "ready" && previous.value !== next.value) config.dispose?.(previous.value);
            } else {
              // Conditional refresh confirmed the resident value is current.
              // Keep it without materializing the empty confirmation or
              // disposing the held bytes (§3.8 TTL revalidate). A revalidated
              // result with no resident value is a loader protocol violation.
              if (entry.state.status !== "ready") throw new Error("revalidated result with no resident value");
              entry.stale = false; entry.error = undefined;
              entry.attempts = 0; entry.loadedAt = frame; notify(entry);
            }
          }
          catch (error) {
            entry.error = error; entry.stale = true;
            entry.retryAt = frame + Math.min(retry.maxDelayFrames, retry.delayFrames * 2 ** Math.min(20, entry.attempts - 1));
            if (entry.state.status !== "ready") entry.state = failed(error);
            notify(entry); return;
          }
        } };
      },
      cancel,
      dispose() { if (dead) return; dead = true; clear(); collections.delete(collection); },
    };
    collections.add(collection);
    return {
      /** Replaces this cache's bounded working set. Readers do not start work.
       * The planner supplies highest-priority demands first for admission. */
      reconcile(demands: readonly ResourceDemand<I>[]) {
        if (dead) return;
        if (demands.length > config.maxEntries) throw new Error("Resource demand exceeds entry budget");
        // Validate before altering the previous working set.
        const wanted = new Map<string, ResourceDemand<I> & { reserved: number }>();
        for (const demand of demands) {
          const key = config.key(demand.input);
          if (typeof key !== "string" || key.length > 1024 || !key.length || !Number.isFinite(demand.priority)) throw new Error("Invalid resource identity or priority");
          const reserved = entries.get(key)?.cost ?? positive(config.cost(demand.input), "cost");
          const old = wanted.get(key);
          if (!old || demand.priority < old.priority) wanted.set(key, { ...demand, reserved, pin: !!(old?.pin || demand.pin) });
          else if (demand.pin) old.pin = true;
        }
        for (const entry of entries.values()) {
          const demand = wanted.get(entry.key); entry.desired = !!demand; entry.pin = !!demand?.pin;
          if (demand) { entry.priority = demand.priority; entry.touched = frame; }
          else if (entry.busy) { stop(entry); notify(entry); }
        }
        let admitted = 0;
        for (const [key, demand] of wanted) {
          if (entries.has(key)) { admitted++; continue; }
          const reserved = demand.reserved;
          if (reserved > config.maxCost) continue;
          while (entries.size >= config.maxEntries || cost + reserved > config.maxCost) {
            let victim: Entry | undefined;
            for (const candidate of entries.values()) {
              if (candidate.pin || candidate.desired && candidate.priority <= demand.priority) continue;
              if (!victim || !candidate.desired && victim.desired || candidate.desired === victim.desired &&
                (candidate.priority > victim.priority || candidate.priority === victim.priority && candidate.touched < victim.touched)) victim = candidate;
            }
            if (!victim) break;
            drop(victim);
          }
          if (entries.size >= config.maxEntries || cost + reserved > config.maxCost) continue;
          entries.set(key, { key, input: demand.input, cost: reserved, state: pending(), stale: true, desired: true,
            pin: !!demand.pin, priority: demand.priority, touched: frame, order: order++, generation: 0,
            busy: false, attempts: 0, retryAt: 0, loadedAt: 0, declinedAt: -1, resultOrder: 0, charged: false });
          cost += reserved; admitted++;
        }
        return admitted;
      },
      state(input: I): ResourceState<T> { return entries.get(config.key(input))?.state ?? pending(); },
      snapshot(input: I): ResourceSnapshot<T> {
        const entry = entries.get(config.key(input));
        return entry ? { state: entry.state, stale: entry.stale, refreshing: entry.busy, error: entry.error }
          : { state: pending(), stale: true, refreshing: false };
      },
      /** A new provider session or explicit recovery grants failed reads a
       * fresh retry budget. Healthy resident entries keep their identity. */
      retryFailed(matches: (input: I) => boolean = () => true) {
        for (const entry of entries.values()) if (matches(entry.input) &&
            (entry.state.status === "error" || entry.error !== undefined ||
              (!entry.busy && entry.stale && entry.attempts > 0))) invalidateEntry(entry, false);
      },
      /** Retain stale content by default; drop when the identity is unsafe to display. */
      invalidate(matches: (input: I) => boolean = () => true, dropValue = false) {
        for (const entry of entries.values()) if (matches(entry.input)) invalidateEntry(entry, dropValue);
      },
      cancel, clear, dispose: collection.dispose,
      stats: () => ({ entries: entries.size, cost, ready: [...entries.values()].reduce((n, e) => n + (e.state.status === "ready" ? 1 : 0), 0) }),
    };
  }
  return {
    createCache,
    /** Call once per UI frame after planning demand, also while offline. */
    step() {
      if (disposed || stepping) return;
      stepping = true; frame++;
      try {
        for (let n = 0; n < options.completionsPerFrame; n++) {
          let oldest: ReturnType<Collection["completion"]>;
          for (const collection of collections) {
            const candidate = collection.completion();
            if (candidate && (!oldest || candidate.order < oldest.order)) oldest = candidate;
          }
          if (!oldest) break;
          oldest.run();
        }
        // Each declined entry is skipped for this frame. The scan is bounded by
        // resident entries plus startsPerFrame, including across different loaders.
        for (let n = 0; n < options.startsPerFrame;) {
          let chosen: Job | undefined;
          for (const collection of collections) {
            const candidate = collection.candidate();
            if (candidate && (!chosen || candidate.priority < chosen.priority || candidate.priority === chosen.priority && candidate.order < chosen.order)) chosen = candidate;
          }
          if (!chosen) break;
          if (active >= options.maxConcurrent) {
            let worst: ReturnType<Collection["speculative"]>;
            for (const collection of collections) { const candidate = collection.speculative(); if (candidate && (!worst || candidate.priority > worst.priority)) worst = candidate; }
            if (!worst || worst.priority <= chosen.priority) break;
            worst.cancel();
          }
          if (options.available && !options.available()) break;
          if (chosen.start()) n++;
        }
      } finally { stepping = false; }
    },
    cancel() { for (const collection of collections) collection.cancel(); },
    dispose() { if (disposed) return; disposed = true; for (const collection of collections) collection.dispose(); },
    stats: () => ({ frame, active, collections: collections.size }),
  };
}
