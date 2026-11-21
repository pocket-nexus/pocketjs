// tests/pointer.test.ts — desktop pointer facts (input.pointer): the frame's
// tenth argument latches a hover position for pointer(), and its scroll
// reaches onScroll handlers newest first.

import { afterEach, describe, expect, test } from "bun:test";
import { __dispatchScroll, __resetPointer, __setPointer, onScroll, pointer, type PointerRecord, type ScrollEvent } from "../framework/src/pointer.ts";

afterEach(__resetPointer);

const frame = (record: PointerRecord | null | undefined) => {
  __setPointer(record);
  __dispatchScroll();
};

describe("pointer()", () => {
  test("latches a position with no button down, unclamped and fractional", () => {
    __setPointer({ surface: 0, x: 1500.5, y: -3.25, buttons: 0, scrollX: 0, scrollY: 0 });
    expect(pointer()).toEqual({ surface: "primary", x: 1500.5, y: -3.25, buttons: 0 });
    expect(Object.isFrozen(pointer())).toBe(true);
    __setPointer({ surface: 1, x: 2, y: 3, buttons: 5 });
    expect(pointer()).toEqual({ surface: "auxiliary", x: 2, y: 3, buttons: 5 });
  });

  test("a frame without a pointer, or with a non-finite one, has none", () => {
    __setPointer({ x: 1, y: 1 });
    __setPointer(null);
    expect(pointer()).toBeNull();
    __setPointer({ x: Number.NaN, y: 1 });
    expect(pointer()).toBeNull();
    __setPointer(undefined);
    expect(pointer()).toBeNull();
  });
});

describe("onScroll()", () => {
  test("handlers run newest first and a true return consumes", () => {
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
    onScroll((event) => void events.push(event));
    frame({ surface: 1, x: 7.5, y: 8, buttons: 0, scrollX: -2, scrollY: 0 });
    expect(events).toEqual([{ surface: "auxiliary", x: 7.5, y: 8, dx: -2, dy: 0 }]);
  });

  test("a frame without scroll, or without a pointer, dispatches nothing", () => {
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
