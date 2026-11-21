import { afterEach, describe, expect, test } from "bun:test";
import {
  __packTouch,
  __packTouchWide,
  __resetTouches,
  __setTouches,
  auxiliaryTouches,
  touches,
} from "../framework/src/touch.ts";

afterEach(__resetTouches);

describe("touch frame snapshot", () => {
  test("decodes stable ids and logical coordinates", () => {
    __setTouches([
      __packTouch(7, 12, 34),
      __packTouch(3, 479, 271),
    ]);
    expect(touches()).toEqual([
      { surface: "primary", id: 7, x: 12, y: 34 },
      { surface: "primary", id: 3, x: 479, y: 271 },
    ]);
  });

  test("decodes wide E7 coordinates alongside legacy contacts", () => {
    __setTouches([
      __packTouchWide(9, 639, 359),
      __packTouch(3, 479, 271),
    ]);
    expect(touches()).toEqual([
      { surface: "primary", id: 9, x: 639, y: 359 },
      { surface: "primary", id: 3, x: 479, y: 271 },
    ]);
  });

  test("publishes an immutable per-frame snapshot and clears on release", () => {
    const hostValues = [__packTouch(1, 20, 40)];
    __setTouches(hostValues);
    const first = touches();
    hostValues[0] = __packTouch(1, 99, 99);
    expect(first).toEqual([{ surface: "primary", id: 1, x: 20, y: 40 }]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);

    __setTouches(undefined);
    expect(touches()).toEqual([]);
  });

  test("caps a malformed host frame at the Vita maximum", () => {
    __setTouches(Array.from({ length: 12 }, (_, id) => __packTouch(id, id, id)));
    expect(touches()).toHaveLength(8);
  });

  test("partitions primary and auxiliary contacts without remapping coordinates", () => {
    __setTouches(
      [__packTouch(1, 20, 40), __packTouch(1, 300, 200)],
      [11, 22],
      [0, 1],
    );
    expect(touches()).toEqual([
      { surface: "primary", id: 1, x: 20, y: 40, hit: 11 },
    ]);
    expect(auxiliaryTouches()).toEqual([
      { surface: "auxiliary", id: 1, x: 300, y: 200, hit: 22 },
    ]);
  });
});
