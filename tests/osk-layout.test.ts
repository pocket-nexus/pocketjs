// tests/osk-layout.test.ts — the system keyboard's pure geometry:
// LVGL-style variable-width rows, spatial d-pad navigation, touch mapping.
// Rendering, navigation and touch all consume these same numbers, so this
// is where "the keyboard makes sense" is provable without booting a world.

import { describe, expect, test } from "bun:test";
import {
  clampPos,
  homePos,
  keyAtPoint,
  layoutRows,
  navigate,
  oskLayer,
  oskLayerToggle,
  oskMetrics,
  oskPanelHeight,
  OSK_GAP,
  OSK_H,
  OSK_LAYERS,
  OSK_LAYOUTS,
  OSK_PAD,
  OSK_ROW_H,
  type OskKeyRect,
  type OskLayerName,
} from "../framework/src/osk-layout.ts";
import { SCREEN_W } from "../contracts/spec/spec.ts";

const INNER_W = SCREEN_W - 2 * OSK_PAD;
const LAYERS = Object.keys(OSK_LAYERS) as (keyof typeof OSK_LAYERS)[];

const label = (k: OskKeyRect): string => k.key.label ?? k.key.ch ?? "";
const find = (rows: OskKeyRect[][], want: string): OskKeyRect => {
  for (const row of rows) for (const k of row) if ((k.key.ch ?? k.key.label) === want) return k;
  throw new Error(`no key ${JSON.stringify(want)}`);
};

describe("geometry", () => {
  test("every row of every layer spans exactly the panel width", () => {
    for (const name of LAYERS) {
      const rows = layoutRows(OSK_LAYERS[name], INNER_W);
      for (const row of rows) {
        const last = row[row.length - 1];
        expect(row[0].x).toBe(0);
        expect(last.x + last.w).toBe(INNER_W);
        for (const k of row) expect(k.w).toBeGreaterThan(10);
        for (let c = 1; c < row.length; c++) {
          expect(row[c].x).toBe(row[c - 1].x + row[c - 1].w + OSK_GAP);
        }
      }
    }
  });

  test("panel height covers four rows", () => {
    expect(OSK_H).toBe(4 * OSK_ROW_H + 3 * OSK_GAP + 2 * OSK_PAD);
  });

  test("special keys are wider than letters (the LVGL look)", () => {
    const rows = layoutRows(OSK_LAYERS.lower, INNER_W);
    const q = find(rows, "q");
    expect(rows[0][0].w).toBeGreaterThan(q.w); //     1#
    expect(rows[1][0].w).toBeGreaterThan(q.w); //     ABC
    expect(find(rows, " ").w).toBeGreaterThan(3 * q.w); // space bar
  });
});

describe("navigation", () => {
  const rows = layoutRows(OSK_LAYERS.lower, INNER_W);

  test("left/right wrap within the row", () => {
    const q = find(rows, "q");
    expect(navigate(rows, { row: 0, col: q.col }, "left")).toEqual({ row: 0, col: 0 });
    expect(navigate(rows, { row: 0, col: 0 }, "left")).toEqual({ row: 0, col: rows[0].length - 1 });
    expect(navigate(rows, { row: 0, col: rows[0].length - 1 }, "right")).toEqual({ row: 0, col: 0 });
  });

  test("up/down clamp at the panel edges", () => {
    expect(navigate(rows, { row: 0, col: 3 }, "up")).toEqual({ row: 0, col: 3 });
    expect(navigate(rows, { row: 3, col: 2 }, "down")).toEqual({ row: 3, col: 2 });
  });

  test("down picks the key under the current one, not a column index", () => {
    // 'q' sits over 'a' even though their column indices differ per row.
    const q = find(rows, "q");
    const down = navigate(rows, { row: q.row, col: q.col }, "down");
    expect(label(rows[down.row][down.col])).toBe("a");
    // The wide space bar catches most of row 3.
    const v = find(rows, "v");
    const toSpace = navigate(rows, { row: v.row, col: v.col }, "down");
    expect(rows[toSpace.row][toSpace.col].key.ch).toBe(" ");
  });

  test("up from the space bar returns to a middle letter", () => {
    const sp = find(rows, " ");
    const up = navigate(rows, { row: sp.row, col: sp.col }, "up");
    expect("zxcvbnm".includes(label(rows[up.row][up.col]))).toBe(true);
  });

  test("every key of every layer is reachable from 'q' by d-pad", () => {
    for (const name of LAYERS) {
      const r = layoutRows(OSK_LAYERS[name], INNER_W);
      const seen = new Set<string>();
      const queue = [{ row: 0, col: 1 }];
      while (queue.length) {
        const pos = queue.shift()!;
        const id = `${pos.row}:${pos.col}`;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const d of ["up", "down", "left", "right"] as const) queue.push(navigate(r, pos, d));
      }
      const total = r.reduce((n, row) => n + row.length, 0);
      expect(seen.size).toBe(total);
    }
  });

  test("clampPos survives layer switches", () => {
    const symbols = layoutRows(OSK_LAYERS.symbols, INNER_W);
    const p = clampPos(symbols, { row: 1, col: 10 }); // lower r1 has 11 keys, symbols r1 has 10
    expect(p.row).toBe(1);
    expect(p.col).toBe(symbols[1].length - 1);
  });
});

describe("touch mapping", () => {
  const rows = layoutRows(OSK_LAYERS.lower, INNER_W);

  test("the center of every key resolves to that key", () => {
    for (const row of rows) {
      for (const k of row) {
        const pos = keyAtPoint(rows, k.x + k.w / 2, k.row * (OSK_ROW_H + OSK_GAP) + OSK_ROW_H / 2);
        expect(pos).toEqual({ row: k.row, col: k.col });
      }
    }
  });

  test("a touch in the gap snaps to the nearest key; far misses are null", () => {
    const q = find(rows, "q");
    const inGap = keyAtPoint(rows, q.x - OSK_GAP / 2, OSK_ROW_H / 2);
    expect(inGap === null || inGap.row === 0).toBe(true);
    expect(keyAtPoint(rows, 40, -30)).toBeNull();
    expect(keyAtPoint(rows, 40, 4 * (OSK_ROW_H + OSK_GAP) + 20)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The staggered (phone) layout the contact modality renders
// ---------------------------------------------------------------------------

describe("staggered layout", () => {
  const AUX_W = 320 - 2 * OSK_PAD; // the 3DS bottom screen
  const STAGGERED_LAYERS: OskLayerName[] = ["lower", "upper", "numbers", "symbols"];

  test("every row of every layer spans the panel width and spacers emit no key", () => {
    for (const name of STAGGERED_LAYERS) {
      const rows = layoutRows(oskLayer("staggered", name), AUX_W);
      expect(rows.length).toBe(4);
      rows.forEach((row, r) => {
        const last = row[row.length - 1];
        // A row that ends in a half-key spacer stops short of the panel
        // edge by that spacer; every other row reaches it exactly.
        const trailingSpacer = oskLayer("staggered", name)[r].at(-1)?.spacer === true;
        if (trailingSpacer) expect(last.x + last.w).toBeLessThan(AUX_W);
        else expect(last.x + last.w).toBe(AUX_W);
        for (const k of row) {
          expect(k.key.spacer).toBeUndefined();
          expect(k.w).toBeGreaterThanOrEqual(24);
        }
        row.forEach((k, c) => expect(k.col).toBe(c));
      });
    }
  });

  test("the home row is inset by half a key on both sides", () => {
    const rows = layoutRows(oskLayer("staggered", "lower"), AUX_W);
    const q = rows[0][0], a = rows[1][0];
    expect(a.x).toBeGreaterThan(q.x + q.w / 3);
    expect(a.x).toBeLessThan(q.x + q.w);
    const p = rows[0][rows[0].length - 1], l = rows[1][rows[1].length - 1];
    expect(l.x + l.w).toBeLessThan(p.x + p.w);
    expect(rows[1].length).toBe(9);
  });

  test("letters are 30 px rows; the grid keeps 18", () => {
    expect(oskPanelHeight(oskMetrics("staggered"))).toBe(4 * 30 + 3 * OSK_GAP + 2 * OSK_PAD);
    expect(oskPanelHeight(oskMetrics("grid"))).toBe(OSK_H);
    expect(oskPanelHeight(oskMetrics("staggered", 30, 14))).toBe(14 + 4 * 30 + 3 * OSK_GAP + 2 * OSK_PAD);
  });

  test("the layer keys route letters -> numbers -> symbols -> letters", () => {
    expect(oskLayerToggle("staggered", "lower")).toBe("numbers");
    expect(oskLayerToggle("staggered", "upper")).toBe("numbers");
    expect(oskLayerToggle("staggered", "numbers")).toBe("lower");
    expect(oskLayerToggle("staggered", "symbols")).toBe("lower");
    expect(oskLayerToggle("grid", "lower")).toBe("symbols");
    expect(oskLayerToggle("grid", "symbols")).toBe("lower");
    const numbers = layoutRows(oskLayer("staggered", "numbers"), AUX_W);
    const toSymbols = numbers[2][0];
    expect(toSymbols.key.action).toBe("layer");
    expect(toSymbols.key.to).toBe("symbols");
    // The grid has no numbers layer: a request for it lands on the home layer.
    expect(oskLayer("grid", "numbers")).toBe(OSK_LAYOUTS.grid.lower!);
  });

  test("every key of every layer is reachable from 'q' by d-pad", () => {
    for (const name of STAGGERED_LAYERS) {
      const r = layoutRows(oskLayer("staggered", name), AUX_W);
      const seen = new Set<string>();
      const queue = [homePos(r)];
      while (queue.length) {
        const pos = queue.shift()!;
        const id = `${pos.row}:${pos.col}`;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const d of ["up", "down", "left", "right"] as const) queue.push(navigate(r, pos, d));
      }
      expect(seen.size).toBe(r.reduce((n, row) => n + row.length, 0));
    }
  });

  test("home is 'q' on the letter layers and the first key elsewhere", () => {
    expect(homePos(layoutRows(oskLayer("staggered", "lower"), AUX_W))).toEqual({ row: 0, col: 0 });
    expect(homePos(layoutRows(oskLayer("grid", "lower"), INNER_W))).toEqual({ row: 0, col: 1 });
    expect(homePos(layoutRows(oskLayer("grid", "symbols"), INNER_W))).toEqual({ row: 0, col: 0 });
  });

  test("touch centres resolve to their key at 30 px rows", () => {
    const rows = layoutRows(oskLayer("staggered", "lower"), AUX_W);
    for (const row of rows) {
      for (const k of row) {
        expect(keyAtPoint(rows, k.x + k.w / 2, k.row * (30 + OSK_GAP) + 15, 30)).toEqual({ row: k.row, col: k.col });
      }
    }
  });
});
