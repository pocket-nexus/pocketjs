import { expect, test } from "bun:test";
import { createComputed, createRoot, createSignal, type JSX } from "solid-js";
import { createResourceRuntime, createResourceView } from "../framework/src/resource-view.ts";
import { ResourceBoundary } from "../framework/src/resource.ts";
import { runFrameHooks, resetFrameHooks, onFrame } from "../framework/src/frame.ts";
import type { ResourceResult } from "../framework/src/resource-cache.ts";

if (Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js")) throw new Error("Resource view tests require --conditions=browser");

function setup(overrides = {}) {
  const runtime = createResourceRuntime({ maxConcurrent: 3, startsPerFrame: 3, completionsPerFrame: 1, maxCollections: 2 });
  const requests: { key: string; done: (r: ResourceResult<string>) => void; cancelled: boolean }[] = [];
  const decoded: string[] = [], freed: string[] = [];
  const collection = runtime.createCollection({ key: (s: string) => s, maxEntries: 3, maxCost: 30, cost: () => 10,
    maxResponseBytes: 100, maxViews: 3, maxDemandsPerView: 3,
    load(key, done) { const req = { key, done, cancelled: false }; requests.push(req); return { cancel() { req.cancelled = true; } }; },
    materialize(raw: string) { decoded.push(raw); return raw; }, dispose: value => freed.push(value), ...overrides });
  return { runtime, collection, requests, decoded, freed };
}
const demand = (...keys: string[]) => keys.map(input => ({ input, priority: 0, pin: true }));

test("independent owners merge overlapping keys and withdraw only their own requests", () => {
  createRoot(dispose => {
    const x = setup();
    const left = createResourceView(x.collection, { demand: () => demand("a", "b") });
    let closeRight!: () => void;
    createRoot(close => { closeRight = close; createResourceView(x.collection, { demand: () => demand("b", "c") }); });
    x.runtime.step(); expect(x.requests.map(r => r.key)).toEqual(["a", "b", "c"]);
    closeRight(); expect(x.requests.map(r => r.cancelled)).toEqual([false, false, true]);
    x.requests[2].done({ ok: true, value: "late-c" });
    x.requests[1].done({ ok: true, value: "B" }); x.runtime.step();
    expect(left.value("b")).toBe("B"); expect(x.decoded).toEqual(["B"]);
    expect(x.collection.stats()).toMatchObject({ views: 1, demands: 2 });
    dispose(); expect(x.freed).toEqual(["B"]); expect(x.runtime.stats().active).toBe(0);
  });
});

test("key subscriptions reveal boundaries without notifying unrelated rows or starting work in render", () => {
  createRoot(dispose => {
    const x = setup(), view = createResourceView(x.collection, { demand: () => demand("a", "b") });
    let a = 0, b = 0;
    createComputed(() => { view.state("a"); a++; }); createComputed(() => { view.state("b"); b++; });
    const boundary = ResourceBoundary({ state: () => view.state("a"), fallback: () => "skeleton",
      children: value => (() => value()) as unknown as JSX.Element });
    const read = () => { let value: unknown = boundary; while (typeof value === "function") value = value(); return value; };
    expect(read()).toBe("skeleton"); expect(x.requests).toHaveLength(0);
    for (let n = 0; n < 1000; n++) view.state(`unrequested-${n}`);
    expect(x.collection.stats().demands).toBe(0);
    x.runtime.step(); const beforeA = a, beforeB = b;
    x.requests[0].done({ ok: true, value: "A" }); expect(read()).toBe("skeleton");
    x.runtime.step(); expect(read()).toBe("A"); expect(a).toBeGreaterThan(beforeA); expect(b).toBe(beforeB);
    x.runtime.step(); expect(a).toBe(beforeA + 1); expect(b).toBe(beforeB);
    dispose();
  });
});

test("dynamic keys fence obsolete replies and unmounted views release subscription storage", () => {
  createRoot(dispose => {
    const x = setup(); const [key, setKey] = createSignal("old");
    const view = createResourceView(x.collection, { demand: () => demand(key()) });
    x.runtime.step(); setKey("new"); expect(x.requests).toHaveLength(1);
    x.runtime.step(); expect(x.requests[0].cancelled).toBe(true);
    x.requests[0].done({ ok: true, value: "old" }); x.requests[1].done({ ok: true, value: "new" }); x.runtime.step();
    expect(view.value("new")).toBe("new"); expect(view.state("old").status).toBe("pending");
    for (let n = 0; n < 40; n++) { setKey(`key-${n}`); x.runtime.step(); expect(x.collection.stats().demands).toBe(1); }
    view.dispose(); view.dispose(); expect(x.collection.stats()).toMatchObject({ views: 0, demands: 0 });
    dispose(); expect(x.freed).toEqual(["new"]);
  });
});

test("shared demand inherits higher priority and pins; releasing one view keeps cached native ownership", () => {
  createRoot(dispose => {
    const x = setup();
    createResourceView(x.collection, { demand: () => [{ input: "shared", priority: 20 }] });
    const visible = createResourceView(x.collection, { demand: () => [{ input: "shared", priority: 0, pin: true }, { input: "other", priority: 10 }] });
    x.runtime.step(); expect(x.requests.map(r => r.key)).toEqual(["shared", "other"]);
    x.requests[0].done({ ok: true, value: "texture" }); x.runtime.step(); visible.dispose();
    expect(x.freed).toEqual([]); expect(x.requests[1].cancelled).toBe(true);
    x.collection.invalidate(); x.runtime.step(); x.requests[2].done({ ok: true, value: "replacement" }); x.runtime.step();
    expect(x.freed).toEqual(["texture"]); dispose(); expect(x.freed).toEqual(["texture", "replacement"]);
  });
});

test("view unions stay bounded and unadmitted content can enter when another view closes", () => {
  createRoot(dispose => {
    const x = setup({ maxEntries: 1, maxCost: 10, maxDemandsPerView: 1 });
    const foreground = createResourceView(x.collection, { demand: () => [{ input: "a", priority: 0, pin: true }] });
    const background = createResourceView(x.collection, { demand: () => [{ input: "b", priority: 10, pin: true }] });
    x.runtime.step(); expect(x.requests.map(r => r.key)).toEqual(["a"]);
    expect(x.collection.stats()).toMatchObject({ entries: 1, cost: 10, demands: 2 });
    expect(background.state("b").status).toBe("pending");
    foreground.dispose(); x.runtime.step(); expect(x.requests[1].key).toBe("b");
    expect(x.collection.stats().cost).toBe(10); dispose();
  });
});

test("invalid demand is rejected before replacing a collection's working set", () => {
  createRoot(dispose => {
    const x = setup({ maxViews: 1, maxDemandsPerView: 1 }); let inputs = demand("a");
    createResourceView(x.collection, { demand: () => inputs }); x.runtime.step();
    expect(() => createResourceView(x.collection, { demand: () => [] })).toThrow("view budget");
    inputs = demand("b", "c"); expect(() => x.runtime.step()).toThrow("demand");
    expect(x.requests[0].cancelled).toBe(false); expect(x.collection.stats().demands).toBe(1);
    inputs = [{ input: "bad", priority: NaN, pin: true }]; expect(() => x.runtime.step()).toThrow("priority");
    expect(x.requests[0].cancelled).toBe(false); dispose();
  });
});

test("page projection preserves errors and maps absent items to pending", () => {
  createRoot(dispose => {
    const x = setup(); const view = createResourceView(x.collection, { demand: () => demand("page") });
    x.runtime.step(); x.requests[0].done({ ok: false, error: "offline" }); x.runtime.step();
    expect(view.state("page", s => s.length)).toEqual({ status: "error", error: "offline" });
    x.collection.invalidate(); x.runtime.step(); x.requests[1].done({ ok: true, value: "ABC" }); x.runtime.step();
    expect(view.state("page", s => s.length)).toEqual({ status: "ready", value: 3 });
    expect(view.state("page", () => undefined).status).toBe("pending"); dispose();
  });
});

test("runtime installs one frame hook after input setup and tears it down with its owner", () => {
  resetFrameHooks(); let dispose!: () => void; let key = "before"; let x!: ReturnType<typeof setup>;
  createRoot(close => { dispose = close; x = setup(); createResourceView(x.collection, { demand: () => demand(key) }); onFrame(() => { key = "after"; }); });
  runFrameHooks(0); expect(x.requests.map(r => r.key)).toEqual(["after"]); expect(x.runtime.stats().frame).toBe(1);
  dispose(); runFrameHooks(0); expect(x.runtime.stats().frame).toBe(1); expect(x.requests[0].cancelled).toBe(true);
  resetFrameHooks();
});

test("a reusable disposer does not erase the decoded value's type", () => {
  createRoot(dispose => {
    const runtime = createResourceRuntime({ maxConcurrent: 1, startsPerFrame: 1, completionsPerFrame: 1, maxCollections: 1 });
    const freed: number[] = [];
    const freeHandle = (value: { handle: number }) => { freed.push(value.handle); };
    const collection = runtime.createCollection({ key: (s: string) => s, maxViews: 1, maxEntries: 1, maxCost: 20, cost: () => 20, maxResponseBytes: 10,
      load(_, done) { done({ ok: true, value: "x" }); return { cancel() {} }; },
      materialize: (_raw: string) => ({ handle: 7, width: 256, height: 16, row: 42 }), dispose: freeHandle });
    const view = createResourceView(collection, { demand: () => demand("tile") });
    runtime.step(); runtime.step();
    const tile: { handle: number; width: number; height: number; row: number } | undefined = view.value("tile");
    expect(tile?.row).toBe(42); dispose(); expect(freed).toEqual([7]);
  });
});
