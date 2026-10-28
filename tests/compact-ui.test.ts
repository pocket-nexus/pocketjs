// tests/compact-ui.test.ts — the compact kit's pure parts: the key
// vocabulary and its dispatch (aliases, repeat, the Escape hold, scopes),
// the selection, the stepper and the text helpers that need no host.

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { __feedFrame, __feedKey, __resetCompactInput, navKeyOf, onKeyIn, onNavIn, setActiveScope, type NavEvent } from "../framework/src/compact/input.ts";
import { createSelection, cycle, stepValue } from "../framework/src/compact/select.ts";
import { bytes, clock, fixed, toAscii } from "../framework/src/compact/text.ts";
import { HOME_HOLD_S, REPEAT_DELAY_S, REPEAT_RATE_HZ } from "../framework/src/compact/tokens.ts";

const press = (key: string) => __feedKey({ kind: "key", key, pressed: true, repeat: false });
const release = (key: string) => __feedKey({ kind: "key", key, pressed: false, repeat: false });

describe("compact input", () => {
  test("keys read as the vocabulary: arrows, FXZC, Enter, Escape, slash, space, Tab", () => {
    expect(navKeyOf("ArrowUp")).toBe("up");
    expect(navKeyOf("f")).toBe("up");
    expect(navKeyOf("X")).toBe("down");
    expect(navKeyOf("z")).toBe("left");
    expect(navKeyOf("c")).toBe("right");
    expect(navKeyOf("Shift+ArrowRight")).toBe("right");
    expect(navKeyOf("Enter")).toBe("ok");
    expect(navKeyOf("Backspace")).toBe("back");
    expect(navKeyOf("/")).toBe("search");
    expect(navKeyOf(" ")).toBe("pause");
    expect(navKeyOf("Tab")).toBe("action");
    expect(navKeyOf("Home")).toBe("home");
    expect(navKeyOf("q")).toBeNull();
    expect(navKeyOf("Control+z")).toBeNull();
  });

  test("the active scope hears a press once, Shift makes it fine, a held direction repeats", () => {
    __resetCompactInput();
    const heard: NavEvent[] = [];
    const other: NavEvent[] = [];
    onNavIn(1, event => void heard.push(event));
    onNavIn(2, event => void other.push(event));
    setActiveScope(1);
    press("f");
    expect(heard.map(e => e.key)).toEqual(["up"]);
    expect(other).toEqual([]);
    // Held: nothing until the delay, then one repeat per REPEAT_RATE_HZ.
    const hz = 60;
    const delay = Math.round(REPEAT_DELAY_S * hz);
    const every = Math.round(hz / REPEAT_RATE_HZ);
    for (let i = 0; i < delay - 1; i++) __feedFrame();
    expect(heard.length).toBe(1);
    __feedFrame();
    expect(heard.length).toBe(2);
    expect(heard[1]).toEqual({ key: "up", fine: false, repeat: true });
    for (let i = 0; i < every; i++) __feedFrame();
    expect(heard.length).toBe(3);
    release("f");
    for (let i = 0; i < every * 3; i++) __feedFrame();
    expect(heard.length).toBe(3);
    // Shift held: fine steps.
    press("Shift");
    press("c");
    expect(heard.at(-1)).toEqual({ key: "right", fine: true, repeat: false });
    release("c");
    release("Shift");
    press("c");
    expect(heard.at(-1)!.fine).toBe(false);
    release("c");
    // The kernel's own repeat events do not add presses.
    __feedKey({ kind: "key", key: "x", pressed: true, repeat: true });
    expect(heard.filter(e => e.key === "down").length).toBe(0);
  });

  test("Escape is back on release, home when held; raw key handlers consume first", () => {
    __resetCompactInput();
    const heard: string[] = [];
    onNavIn(1, event => void heard.push(event.key));
    setActiveScope(1);
    press("Escape");
    expect(heard).toEqual([]);
    release("Escape");
    expect(heard).toEqual(["back"]);
    press("Escape");
    for (let i = 0; i < Math.round(HOME_HOLD_S * 60); i++) __feedFrame();
    expect(heard).toEqual(["back", "home"]);
    release("Escape");
    expect(heard).toEqual(["back", "home"]);
    // A field takes the letters while it is active; its scope still hears
    // what it leaves.
    const typed: string[] = [];
    const off = onKeyIn(1, event => {
      if (event.kind === "key" && event.pressed && event.key.length === 1) {
        typed.push(event.key);
        return true;
      }
      return;
    });
    press("f");
    release("f");
    press("Enter");
    expect(typed).toEqual(["f"]);
    expect(heard).toEqual(["back", "home", "ok"]);
    off();
    press("f");
    expect(heard.at(-1)).toBe("up");
  });

  test("an Escape a field takes closes the field only: its release is not back", () => {
    __resetCompactInput();
    const heard: string[] = [];
    onNavIn(1, event => void heard.push(event.key));
    setActiveScope(1);
    let open = true;
    const off = onKeyIn(1, event => {
      if (open && event.kind === "key" && event.pressed && event.key === "Escape") {
        open = false;
        return true;
      }
      return;
    });
    press("Escape");
    release("Escape");
    expect(open).toBe(false);
    expect(heard).toEqual([]);
    // The next Escape, with the field closed, is back again.
    press("Escape");
    release("Escape");
    expect(heard).toEqual(["back"]);
    off();
  });

  test("a d-pad speaks the vocabulary when there is no keyboard", () => {
    __resetCompactInput();
    // hasTextInput is false in this test build, so buttons drive the frame.
    const heard: NavEvent[] = [];
    onNavIn(1, event => void heard.push(event));
    setActiveScope(1);
    __feedFrame(0x0040); // DOWN
    expect(heard.map(e => e.key)).toEqual(["down"]);
    __feedFrame(0x0040 | 0x0100); // held with L
    for (let i = 0; i < 40; i++) __feedFrame(0x0040 | 0x0100);
    expect(heard.length).toBeGreaterThan(1);
    expect(heard.at(-1)).toEqual({ key: "down", fine: true, repeat: true });
    __feedFrame(0);
    __feedFrame(0x2000); // CIRCLE
    expect(heard.at(-1)!.key).toBe("ok");
    __feedFrame(0);
    __feedFrame(0x4000); // CROSS
    expect(heard.at(-1)!.key).toBe("back");
  });
});

describe("compact controls", () => {
  test("a selection counts presses for the views that draw it", () => {
    createRoot(dispose => {
      const selection = createSelection(() => 3);
      expect(selection.pressed()).toBe(0);
      selection.press();
      selection.press();
      expect(selection.pressed()).toBe(2);
      dispose();
    });
  });

  test("a selection clamps and follows a shrinking list", () => {
    createRoot(dispose => {
      const [count, setCount] = createSignal(5);
      const selection = createSelection(count);
      expect(selection.index()).toBe(0);
      expect(selection.move(-1)).toBe(false);
      expect(selection.move(3)).toBe(true);
      expect(selection.index()).toBe(3);
      selection.move(10);
      expect(selection.index()).toBe(4);
      setCount(2);
      expect(selection.index()).toBe(1);
      setCount(0);
      expect(selection.index()).toBe(0);
      dispose();
    });
  });

  test("stepValue rounds to the step and stays in range; cycle wraps", () => {
    expect(stepValue(38.0, 1, 0.5, 32, 42)).toBe(38.5);
    expect(stepValue(38.0, 1, 0.5, 32, 42, true)).toBe(38.05);
    expect(stepValue(41.8, 1, 0.5, 32, 42)).toBe(42);
    expect(stepValue(0, -1, 5, 0, 100)).toBe(0);
    expect(stepValue(0.1 + 0.2, 1, 0.1, 0, 1)).toBe(0.4);
    expect(cycle(["a", "b", "c"] as const, "c", 1)).toBe("a");
    expect(cycle(["a", "b", "c"] as const, "a", -1)).toBe("c");
  });

  test("text helpers fold, size and time", () => {
    expect(toAscii("café — “ok” 25°")).toBe('cafe - "ok" 25 deg');
    expect(bytes(512)).toBe("512 B");
    expect(bytes(590_000)).toBe("590 KB");
    expect(bytes(1_200_000)).toBe("1.2 MB");
    expect(clock(65)).toBe("1:05");
    expect(clock(3725)).toBe("1:02:05");
    expect(fixed(-1.25, 1)).toBe("-1.3");
    expect(fixed(1.25, 1, true)).toBe("+1.3");
  });
});

describe("compact app grid", () => {
  test("tiles line up in fixed columns at every size; only the last row is short", async () => {
    const { layoutTiles, gridMetrics, GRID_SIZES } = await import("../framework/src/compact/select.ts");
    const tiles = Array.from({ length: 13 }, (_, i) => ({ id: `t${i}`, icon: "x.svg", label: `t${i}` }));
    const [large, medium, small] = GRID_SIZES.map(size => gridMetrics(size!, 304));
    // Four, five and eight tiles share the 304 px row.
    expect([large!.cellW, medium!.cellW, small!.cellW]).toEqual([74, 59, 36]);
    const big = layoutTiles(tiles, large!);
    expect(big.rows.map(row => row.length)).toEqual([4, 4, 4, 1]);
    // Every column keeps one x down the grid.
    for (const row of big.rows) row.forEach((t, col) => expect(t.x).toBe(col * 76));
    expect(big.tiles[5]).toMatchObject({ x: 76, y: 61, row: 1, col: 1 });
    // Two large rows fill the 120 px grid.
    expect(2 * (large!.cellH + large!.gap) - large!.gap).toBe(120);
    expect(layoutTiles(tiles, medium!).rows.map(row => row.length)).toEqual([5, 5, 3]);
    const tiny = layoutTiles(tiles, small!);
    expect(tiny.rows.map(row => row.length)).toEqual([8, 5]);
    expect(tiny.height).toBe(36 + 2 + 36);
    expect(layoutTiles([], medium!)).toMatchObject({ tiles: [], rows: [], height: 0 });
  });
});
