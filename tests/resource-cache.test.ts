import { expect, test } from "bun:test";
import { createResourceScheduler, type ResourceResult } from "../framework/src/resource-cache.ts";
import { createOffloadClient } from "../framework/src/offload.ts";
import { offloadResource } from "../framework/src/resource-offload.ts";

function setup(overrides = {}) {
  const scheduler = createResourceScheduler({ maxConcurrent: 2, startsPerFrame: 2, completionsPerFrame: 1, maxCollections: 3, ...overrides });
  const requests: { key: string; done: (result: ResourceResult<string>) => void; cancelled: boolean }[] = [];
  const freed: string[] = [], decoded: string[] = [];
  const cache = scheduler.createCache({ key: (key: string) => key, maxEntries: 3, maxResponseBytes: 100, maxCost: 30, cost: () => 10,
    load(key, done) { const request = { key, done, cancelled: false }; requests.push(request); return { cancel() { request.cancelled = true; } }; },
    materialize(raw: string) { decoded.push(raw); return raw; }, dispose(value) { freed.push(value); },
    retry: { attempts: 2, delayFrames: 2, maxDelayFrames: 8 },
  });
  const want = (...keys: string[]) => cache.reconcile(keys.map((input, priority) => ({ input, priority, pin: priority === 0 })));
  return { scheduler, cache, requests, freed, decoded, want };
}

test("identity deduplicates, reads are inert, completions and uploads wait for bounded frame steps", () => {
  const x = setup(); x.cache.state("a"); expect(x.requests.length).toBe(0);
  x.want("a", "a", "b"); x.scheduler.step(); expect(x.requests.map(r => r.key)).toEqual(["a", "b"]);
  x.requests[0].done({ ok: true, value: "A" }); x.requests[0].done({ ok: true, value: "duplicate" });
  x.requests[1].done({ ok: true, value: "B" }); expect(x.decoded).toEqual([]);
  x.scheduler.step(); expect(x.decoded).toEqual(["A"]); expect(x.scheduler.stats().active).toBe(1);
  x.scheduler.step(); expect(x.decoded).toEqual(["A", "B"]); x.want("a", "b"); x.scheduler.step(); expect(x.requests.length).toBe(2);
});

test("shared budgets prioritize visible work across thumbnail, page and tile collections", () => {
  const x = setup({ maxConcurrent: 1 }); const started: string[] = [];
  const page = x.scheduler.createCache({ key: (s: string) => s, maxEntries: 2, maxResponseBytes: 100, maxCost: 2, cost: () => 1,
    load(input) { started.push(input); return { cancel() {} }; }, materialize: (s: string) => s });
  x.cache.reconcile([{ input: "prefetch", priority: 20 }]); page.reconcile([{ input: "visible-page", priority: 0 }]);
  x.scheduler.step(); expect(started).toEqual(["visible-page"]); expect(x.requests).toHaveLength(0);
  page.dispose(); x.scheduler.step(); expect(x.requests[0].key).toBe("prefetch");
});

test("viewport replacement cancels obsolete work and late replies never allocate a texture", () => {
  const x = setup(); x.want("old"); x.scheduler.step(); const old = x.requests[0];
  x.want("new"); expect(old.cancelled).toBe(true); old.done({ ok: true, value: "stale" });
  x.scheduler.step(); expect(x.decoded).toEqual([]); expect(x.requests[1].key).toBe("new");
  x.cache.clear(); x.requests[1].done({ ok: true, value: "after-clear" }); x.scheduler.step(); expect(x.decoded).toEqual([]);
});

test("invalidation retains ready content, fences old generations and disposes replacements once", () => {
  const x = setup(); x.want("a"); x.scheduler.step(); x.requests[0].done({ ok: true, value: "A1" }); x.scheduler.step();
  x.cache.invalidate(); expect(x.cache.snapshot("a").stale).toBe(true); expect(x.cache.state("a")).toEqual({ status: "ready", value: "A1" });
  x.scheduler.step(); x.cache.invalidate(); const obsolete = x.requests[1];
  x.scheduler.step(); obsolete.done({ ok: true, value: "old-generation" }); x.requests[2].done({ ok: true, value: "A2" }); x.scheduler.step();
  expect(x.decoded).toEqual(["A1", "A2"]); expect(x.freed).toEqual(["A1"]);
  x.scheduler.dispose(); x.scheduler.dispose(); expect(x.freed).toEqual(["A1", "A2"]); expect(x.scheduler.stats().active).toBe(0);
});

test("entry and byte admission preserve pinned content under pressure", () => {
  const x = setup(); x.want("a", "b", "c"); x.scheduler.step(); x.requests[0].done({ ok: true, value: "A" }); x.scheduler.step();
  x.cache.reconcile([{ input: "a", priority: 0, pin: true }, { input: "d", priority: 1 }, { input: "e", priority: 2 }]);
  expect(x.cache.state("a")).toEqual({ status: "ready", value: "A" }); expect(x.cache.stats().entries).toBe(3); expect(x.cache.stats().cost).toBe(30);
  expect(x.requests.find(r => r.key === "b")?.cancelled).toBe(true); expect(x.freed).toEqual([]);
  expect(() => x.want("a", "b", "c", "d")).toThrow("demand");
});

test("read failures back off per key, exhaust retries, and recover on explicit invalidation", () => {
  const x = setup(); x.want("broken", "healthy"); x.scheduler.step();
  x.requests[0].done({ ok: false, error: "offline" }); x.requests[1].done({ ok: true, value: "ok" });
  x.scheduler.step(); x.scheduler.step(); expect(x.cache.state("healthy")).toEqual({ status: "ready", value: "ok" });
  expect(x.requests.length).toBe(2); x.scheduler.step(); expect(x.requests.length).toBe(3);
  x.requests[2].done({ ok: false, error: "bad" }); for (let n = 0; n < 30; n++) x.scheduler.step(); expect(x.requests.length).toBe(3);
  x.cache.invalidate(s => s === "broken"); x.scheduler.step(); expect(x.requests.length).toBe(4);
});

test("failed revalidation preserves usable content and exposes a refresh error", () => {
  const x = setup(); x.want("a"); x.scheduler.step(); x.requests[0].done({ ok: true, value: "cached" }); x.scheduler.step();
  x.cache.invalidate(); x.scheduler.step(); x.requests[1].done({ ok: false, error: "disconnected" }); x.scheduler.step();
  expect(x.cache.snapshot("a")).toMatchObject({ state: { status: "ready", value: "cached" }, stale: true, error: "disconnected" });
  x.cache.invalidate(() => true, true); expect(x.freed).toEqual(["cached"]); expect(x.cache.state("a").status).toBe("pending");
});

test("synchronous providers are staged, refused starts return credit, throwing decode fails safely", () => {
  const scheduler = setup().scheduler; let allow = false;
  const cache = scheduler.createCache({ key: (s: string) => s, maxEntries: 1, maxResponseBytes: 100, maxCost: 1, cost: () => 1,
    load(_, done) { if (!allow) return false; done({ ok: true, value: "x" }); return { cancel() {} }; },
    materialize() { throw new Error("decode"); } });
  cache.reconcile([{ input: "x", priority: 0 }]); scheduler.step(); expect(scheduler.stats().active).toBe(0);
  allow = true; scheduler.step(); expect(cache.state("x").status).toBe("pending"); scheduler.step(); expect(cache.state("x").status).toBe("error");
});

test("offload adapter obeys session fencing and does not replay command requests", () => {
  let session = 1; let raw: string | undefined; const sent: any[] = [];
  const io = createOffloadClient({ session: () => session, submit(record) { sent.push(JSON.parse(record)); return true; }, take() { const s = raw; raw = undefined; return s; } });
  const scheduler = createResourceScheduler({ maxConcurrent: 1, startsPerFrame: 1, completionsPerFrame: 1, maxCollections: 1, available: () => io.connected() });
  const cache = scheduler.createCache({ key: (s: string) => s, maxEntries: 1, maxResponseBytes: 100, maxCost: 10, cost: () => 10,
    load: offloadResource(io, "read.tile", s => JSON.stringify(s)), materialize: (s: string) => JSON.parse(s) });
  cache.reconcile([{ input: "tile", priority: 0 }]); scheduler.step(); io.step();
  raw = JSON.stringify({ id: sent[0].id, payload: '"texture"' }); io.step(); expect(cache.state("tile").status).toBe("pending"); scheduler.step();
  expect(cache.state("tile")).toEqual({ status: "ready", value: "texture" });
  let commandResults = 0; io.request("document.save", "{}", () => commandResults++); io.step(); session = 2; io.step();
  for (let n = 0; n < 40; n++) { scheduler.step(); io.step(); }
  expect(commandResults).toBe(1); expect(sent.filter(s => s.method === "document.save")).toHaveLength(1);
});

test("oversized payloads are rejected before materialization", () => {
  const x = setup(); x.want("x"); x.scheduler.step(); x.requests[0].done({ ok: true, value: "x".repeat(51) }); x.scheduler.step();
  expect(x.decoded).toEqual([]); expect(x.cache.state("x")).toEqual({ status: "error", error: "Resource response exceeds budget" });
});

test("visible demand preempts speculative requests without consuming retry attempts", () => {
  const x = setup({ maxConcurrent: 1 });
  x.cache.reconcile([{ input: "prefetch", priority: 30 }]); x.scheduler.step();
  x.cache.reconcile([{ input: "visible", priority: 0, pin: true }, { input: "prefetch", priority: 30 }]); x.scheduler.step();
  expect(x.requests[0].cancelled).toBe(true); expect(x.requests[1].key).toBe("visible");
  x.requests[1].done({ ok: true, value: "V" }); x.scheduler.step(); expect(x.requests[2].key).toBe("prefetch");
});

test("frame expiry revalidates only desired entries and keeps the old value visible", () => {
  const x = setup(); let loads = 0;
  const cache = x.scheduler.createCache({ key: (s: string) => s, maxEntries: 1, maxCost: 4, maxResponseBytes: 4, cost: () => 4, maxAgeFrames: 2,
    load(_, done) { done({ ok: true, value: `${++loads}` }); return { cancel() {} }; }, materialize: (s: string) => s });
  cache.reconcile([{ input: "live", priority: 0 }]); x.scheduler.step(); x.scheduler.step(); x.scheduler.step();
  expect(loads).toBe(1); x.scheduler.step(); expect(loads).toBe(2); expect(cache.state("live")).toEqual({ status: "ready", value: "1" });
  cache.reconcile([]); for (let i = 0; i < 5; i++) x.scheduler.step(); expect(loads).toBe(2);
});


test("invalid demand costs leave the previous working set and request intact", () => {
  const scheduler = createResourceScheduler({ maxConcurrent: 1, startsPerFrame: 1, completionsPerFrame: 1, maxCollections: 1 });
  let cancelled = false;
  const cache = scheduler.createCache({ key: (s: string) => s, maxEntries: 2, maxCost: 2, maxResponseBytes: 2,
    cost: s => s === "bad" ? NaN : 1, load: () => ({ cancel() { cancelled = true; } }), materialize: (s: string) => s });
  cache.reconcile([{ input: "active", priority: 0, pin: true }]); scheduler.step();
  expect(() => cache.reconcile([{ input: "bad", priority: 0 }])).toThrow("cost");
  expect(cancelled).toBe(false); expect(cache.snapshot("active").refreshing).toBe(true);
  expect(cache.stats().entries).toBe(1); scheduler.dispose();
});

test("completed responses are delivered across collections despite continuous early-cache refreshes", () => {
  const scheduler = createResourceScheduler({ maxConcurrent: 3, startsPerFrame: 3, completionsPerFrame: 1, maxCollections: 2 });
  const config = { key: (s: string) => s, maxEntries: 2, maxCost: 2, cost: () => 1, maxResponseBytes: 20,
    load(s: string, done: (result: ResourceResult<string>) => void) { done({ ok: true, value: s }); return { cancel() {} }; }, materialize: (s: string) => s };
  const early = scheduler.createCache({ ...config, maxAgeFrames: 1 });
  const visible = scheduler.createCache(config);
  early.reconcile([{ input: "a", priority: 20 }, { input: "b", priority: 20 }]);
  scheduler.step();
  visible.reconcile([{ input: "visible", priority: 0, pin: true }]);
  for (let n = 0; n < 5; n++) scheduler.step();
  expect(visible.state("visible")).toEqual({ status: "ready", value: "visible" });
  // Completion order, rather than registration or refresh rate, also protects a
  // lower-priority response already waiting behind a continuously refreshing one.
  visible.invalidate(); for (let n = 0; n < 5; n++) scheduler.step();
  expect(visible.snapshot("visible").refreshing).toBe(false);
  scheduler.dispose();
});

test("a refusing loader cannot block healthy loaders or other keys in its own cache", () => {
  const scheduler = createResourceScheduler({ maxConcurrent: 2, startsPerFrame: 2, completionsPerFrame: 1, maxCollections: 2 });
  const starts: string[] = [], refused: string[] = [];
  const config = { key: (s: string) => s, maxEntries: 3, maxCost: 3, cost: () => 1, maxResponseBytes: 20,
    load(s: string) { if (s.startsWith("blocked")) { refused.push(s); return false as const; } starts.push(s); return { cancel() {} }; }, materialize: (s: string) => s };
  const first = scheduler.createCache(config), second = scheduler.createCache(config);
  first.reconcile([{ input: "blocked-1", priority: 0 }, { input: "blocked-2", priority: 1 }, { input: "healthy-1", priority: 2 }]);
  second.reconcile([{ input: "healthy-2", priority: 3 }]);
  scheduler.step();
  expect(starts).toEqual(["healthy-1", "healthy-2"]);
  expect(refused).toEqual(["blocked-1", "blocked-2"]);
  scheduler.dispose();
});

test("temporary refusals preserve the finite failure budget", () => {
  const scheduler = createResourceScheduler({ maxConcurrent: 1, startsPerFrame: 1, completionsPerFrame: 1, maxCollections: 1 });
  let calls = 0, failures = 0;
  const cache = scheduler.createCache({ key: (s: string) => s, maxEntries: 1, maxCost: 1, cost: () => 1, maxResponseBytes: 20,
    retry: { attempts: 2, delayFrames: 1, maxDelayFrames: 1 },
    load(_, done) { if (++calls % 2 === 0) return false; failures++; done({ ok: false, error: "offline" }); return { cancel() {} }; },
    materialize: (s: string) => s });
  cache.reconcile([{ input: "x", priority: 0 }]);
  for (let n = 0; n < 30; n++) scheduler.step();
  expect(failures).toBe(2); expect(calls).toBe(3);
  expect(cache.state("x").status).toBe("error"); expect(scheduler.stats().active).toBe(0);
  scheduler.dispose();
});

test("retryFailed retains healthy residents and recovers a failed refresh whose error is undefined", () => {
  const x = setup(); x.want("healthy", "refresh"); x.scheduler.step();
  x.requests[0].done({ ok: true, value: "H" }); x.requests[1].done({ ok: true, value: "R" });
  x.scheduler.step(); x.scheduler.step();
  const healthy = x.cache.state("healthy"), refresh = x.cache.state("refresh");
  x.cache.invalidate(key => key === "refresh"); x.scheduler.step();
  x.requests.at(-1)!.done({ ok: false, error: undefined }); x.scheduler.step();
  x.scheduler.step(); x.scheduler.step(); x.requests.at(-1)!.done({ ok: false, error: undefined }); x.scheduler.step();
  for (let i = 0; i < 20; i++) x.scheduler.step();
  expect(x.requests).toHaveLength(4); expect(x.cache.state("refresh")).toBe(refresh);
  x.cache.retryFailed();
  expect(x.cache.state("healthy")).toBe(healthy); expect(x.cache.state("refresh")).toBe(refresh);
  expect(x.freed).toEqual([]); x.scheduler.step();
  expect(x.requests).toHaveLength(5); expect(x.requests.at(-1)!.key).toBe("refresh");
  x.requests.at(-1)!.done({ ok: true, value: "R2" }); x.scheduler.step();
  expect(x.cache.state("refresh")).toEqual({ status: "ready", value: "R2" });
  expect(x.freed).toEqual(["R"]); x.scheduler.dispose();
});
