// tests/pointer.test.ts — desktop pointer facts: the frame's tenth argument
// latches a hover position for pointer() (input.pointer), and its scroll
// reaches onScroll handlers newest first in a build whose plan turns
// input.scroll on, and no handler in one that does not.

import { afterEach, describe, expect, test } from "bun:test";
import type { PointerRecord, ScrollEvent } from "../framework/src/pointer.ts";

type PointerModule = typeof import("../framework/src/pointer.ts");

// The module reads the build's feature table (`__POCKET_FEATURES__`, the
// define tools/build.ts writes from the plan) when it loads, so each table
// gets its own bundle.
async function bundlePointer(features: Record<string, boolean>): Promise<PointerModule> {
  const result = await Bun.build({
    entrypoints: [new URL("../framework/src/pointer.ts", import.meta.url).pathname],
    format: "esm",
    target: "bun",
    define: { __POCKET_FEATURES__: JSON.stringify(features) },
  });
  expect(result.success).toBe(true);
  const source = await result.outputs[0]!.text();
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as Promise<PointerModule>;
}

// A host contract that lists input.scroll and the application lists it; and
// one that lists input.pointer only (the plan records input.scroll false).
const scrolling = await bundlePointer({ "input.pointer": true, "input.scroll": true });
const pointerOnly = await bundlePointer({ "input.pointer": true, "input.scroll": false });

afterEach(() => {
  scrolling.__resetPointer();
  pointerOnly.__resetPointer();
});

const frameOf = (module: PointerModule) => (record: PointerRecord | null | undefined) => {
  module.__setPointer(record);
  module.__dispatchScroll();
};
const frame = frameOf(scrolling);

describe("pointer()", () => {
  test("latches a position with no button down, unclamped and fractional", () => {
    const { __setPointer, pointer } = pointerOnly;
    __setPointer({ surface: 0, x: 1500.5, y: -3.25, buttons: 0, scrollX: 0, scrollY: 0 });
    expect(pointer()).toEqual({ surface: "primary", x: 1500.5, y: -3.25, buttons: 0 });
    expect(Object.isFrozen(pointer())).toBe(true);
    __setPointer({ surface: 1, x: 2, y: 3, buttons: 5 });
    expect(pointer()).toEqual({ surface: "auxiliary", x: 2, y: 3, buttons: 5 });
  });

  test("a frame without a pointer, or with a non-finite one, has none", () => {
    const { __setPointer, pointer } = pointerOnly;
    __setPointer({ x: 1, y: 1 });
    __setPointer(null);
    expect(pointer()).toBeNull();
    __setPointer({ x: Number.NaN, y: 1 });
    expect(pointer()).toBeNull();
    __setPointer(undefined);
    expect(pointer()).toBeNull();
  });
});

describe("onScroll() with input.scroll", () => {
  test("handlers run newest first and a true return consumes", () => {
    const { onScroll } = scrolling;
    const seen: string[] = [];
    const outer = onScroll((event) => void seen.push(`outer:${event.dy}`));
    const inner = onScroll((event) => {
      seen.push(`inner:${event.dy}`);
      return event.dy > 10;
    });
    frame({ x: 10, y: 20, scrollY: 40 });
    frame({ x: 10, y: 20, scrollY: 4 });
    expect(seen).toEqual(["inner:40", "inner:4", "outer:4"]);
    inner();
    seen.length = 0;
    frame({ x: 10, y: 20, scrollY: 40 });
    expect(seen).toEqual(["outer:40"]);
    outer();
    frame({ x: 10, y: 20, scrollY: 40 });
    expect(seen).toEqual(["outer:40"]);
  });

  test("the event carries the pointer's surface and position", () => {
    const events: ScrollEvent[] = [];
    scrolling.onScroll((event) => void events.push(event));
    frame({ surface: 1, x: 7.5, y: 8, buttons: 0, scrollX: -2, scrollY: 0 });
    expect(events).toEqual([{ surface: "auxiliary", x: 7.5, y: 8, dx: -2, dy: 0 }]);
  });

  test("a frame without scroll, or without a pointer, dispatches nothing", () => {
    const { __dispatchScroll, __setPointer, onScroll } = scrolling;
    const events: ScrollEvent[] = [];
    onScroll((event) => void events.push(event));
    frame({ x: 1, y: 1, scrollX: 0, scrollY: 0 });
    frame({ x: 1, y: 1, scrollY: Number.POSITIVE_INFINITY });
    __setPointer({ x: 1, y: 1, scrollY: 9 });
    __setPointer(null);
    __dispatchScroll();
    expect(events).toEqual([]);
  });
});

describe("onScroll() without input.scroll", () => {
  const expectNoScroll = (module: PointerModule) => {
    const events: ScrollEvent[] = [];
    const release = module.onScroll((event) => void events.push(event));
    frameOf(module)({ surface: 0, x: 4, y: 5, buttons: 0, scrollX: 3, scrollY: 24 });
    expect(events).toEqual([]);
    expect(module.pointer()).toEqual({ surface: "primary", x: 4, y: 5, buttons: 0 });
    expect(() => release()).not.toThrow();
  };

  test("a host contract with input.pointer only: no handler runs, pointer() reads the position", () => {
    expectNoScroll(pointerOnly);
  });

  test("a build without a plan: no handler runs", async () => {
    const unplanned = await bundlePointer({});
    expectNoScroll(unplanned);
    unplanned.__resetPointer();
  });
});

describe("hover", () => {
  // pointer.ts with the host it asks for hitTest and setHover, in one bundle.
  async function bundleHover(features: Record<string, boolean>) {
    const entry = `${import.meta.dir}/../.pocket-build/pointer-hover-entry.ts`;
    await Bun.write(entry, `export * from "${new URL("../framework/src/pointer.ts", import.meta.url).pathname}";\nexport { installHost } from "${new URL("../framework/src/host.ts", import.meta.url).pathname}";\n`);
    const result = await Bun.build({ entrypoints: [entry], format: "esm", target: "bun", define: { __POCKET_FEATURES__: JSON.stringify(features) } });
    expect(result.success).toBe(true);
    const source = await result.outputs[0]!.text();
    return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  }
  const host = (calls: number[]) => ({
    kind: "injected", target: "injected", strict: true,
    ops: { hitTest: (x: number) => (x < 10 ? 7 : 0), setHover: (id: number) => calls.push(id), layoutOf: (id: number) => {
      const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
      [1, 2, 30, 40].forEach((v, i) => view.setFloat32(i * 4, v, true));
      return id === 7 ? bytes : new Uint8Array();
    } },
  });

  test("the node under the pointer is hovered once per change, and cleared when the pointer leaves", async () => {
    const module = await bundleHover({ "input.pointer": true });
    const calls: number[] = [];
    module.installHost(host(calls));
    module.__setPointer({ surface: 0, x: 3, y: 3, buttons: 0 });
    module.__setPointer({ surface: 0, x: 4, y: 3, buttons: 0 });
    module.__setPointer({ surface: 0, x: 40, y: 3, buttons: 0 });
    module.__setPointer({ surface: 0, x: 3, y: 3, buttons: 0 });
    module.__setPointer(null);
    expect(calls).toEqual([7, 0, 7, 0]);
    expect(module.nodeLayout({ id: 7 })).toEqual({ x: 1, y: 2, w: 30, h: 40 });
    expect(module.nodeLayout({ id: 8 })).toBeNull();
  });

  test("a build without input.pointer never hovers", async () => {
    const module = await bundleHover({ "input.pointer": false });
    const calls: number[] = [];
    module.installHost(host(calls));
    module.__setPointer({ surface: 0, x: 3, y: 3, buttons: 0 });
    expect(calls).toEqual([]);
  });
});
