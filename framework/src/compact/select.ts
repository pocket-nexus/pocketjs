// The selection and the arithmetic the compact controls share: a clamped
// index over a list, a stepped value, a cycle through choices. No host and
// no JSX, so a test reads them as they are.

import { createMemo, createSignal, type Accessor } from "solid-js";
import type { Tone } from "./tokens.ts";

export interface Selection {
  index: Accessor<number>;
  set(index: number): void;
  /** True when the index moved. */
  move(delta: number): boolean;
  count: Accessor<number>;
  /** Counts presses of the focused item: a view that draws the selection
   *  bumps the pressed cell when it changes. */
  pressed: Accessor<number>;
  press(): void;
}

/** A clamped index over `count` items; the index follows a shrinking list. */
export function createSelection(count: Accessor<number>, initial = 0): Selection {
  const [raw, setRaw] = createSignal(initial);
  const [pressed, setPressed] = createSignal(0);
  const index = createMemo(() => Math.max(0, Math.min(raw(), count() - 1)));
  return {
    index,
    count,
    pressed,
    press: () => setPressed(n => n + 1),
    set: value => setRaw(Math.max(0, Math.min(value, Math.max(0, count() - 1)))),
    move: delta => {
      const next = Math.max(0, Math.min(index() + delta, count() - 1));
      if (next === index()) return false;
      setRaw(next);
      return true;
    },
  };
}

/** A number stepped by `step` (and `fineStep` with Shift) inside a range,
 *  rounded to the step's decimals. */
export function stepValue(value: number, direction: -1 | 1, step: number, min: number, max: number, fine = false, fineStep = step / 10): number {
  const used = fine ? fineStep : step;
  const next = value + direction * used;
  const decimals = Math.max(0, Math.ceil(-Math.log10(used)));
  return Math.max(min, Math.min(max, Number(next.toFixed(decimals))));
}

/** The next entry of a cycle in `direction`. */
export function cycle<T>(items: readonly T[], current: T, direction: -1 | 1): T {
  const at = items.indexOf(current);
  const next = (at + direction + items.length) % items.length;
  return items[next]!;
}

// ---- app grid layout ------------------------------------------------------------

export interface GridTile {
  id: string;
  /** A baked image name (`icons/level.svg`), drawn at the size's icon size. */
  icon: string;
  label: string;
  /** One glance value under the label: a time, a percentage, a state word. */
  value?: () => string;
  tone?: () => Tone;
  /** A state dot at the tile's corner. */
  dot?: () => Tone | null;
}

export interface PlacedTile {
  tile: GridTile;
  index: number;
  x: number;
  y: number;
  row: number;
  col: number;
}

export interface GridLayout {
  tiles: PlacedTile[];
  /** The tiles of each row, by row number. */
  rows: PlacedTile[][];
  height: number;
}

/** The sizes a grid lays out with, in panel pixels. */
export interface GridMetrics {
  columns: number;
  cellW: number;
  cellH: number;
  gap: number;
}

/** One size of the grid: tiles a row, the tile's height, the icon's size,
 *  and how much text a tile carries (a name in 12 px bold and the glance
 *  value; a name in 10 px and the value; none, the line under the grid
 *  names the focused tile). */
export interface GridSize {
  name: "large" | "medium" | "small";
  columns: number;
  cellH: number;
  gap: number;
  iconSize: number;
  text: "large" | "small" | "none";
}

/** The panel's three grid sizes, largest first. In a 304 px row: four tiles
 *  of 74 px (two rows fill the 120 px grid), five of 59 px, eight of 36 px
 *  (two rows hold every tool of Pocket Tools). */
export const GRID_SIZES: readonly GridSize[] = [
  { name: "large", columns: 4, cellH: 59, gap: 2, iconSize: 32, text: "large" },
  { name: "medium", columns: 5, cellH: 50, gap: 2, iconSize: 24, text: "small" },
  { name: "small", columns: 8, cellH: 36, gap: 2, iconSize: 24, text: "none" },
];

/** The medium size, the grid's default. */
export const GRID: GridSize = GRID_SIZES[1]!;

/** A size's metrics in a row `width` px wide: the tiles share the row
 *  equally. */
export function gridMetrics(size: GridSize, width: number): GridMetrics {
  const columns = Math.max(1, size.columns);
  return { columns, cellW: Math.floor((width - size.gap * (columns - 1)) / columns), cellH: size.cellH, gap: size.gap };
}

/** Lay tiles out in rows of `columns`, every column at one x, so tiles line
 *  up down the grid; only the last row may be short. */
export function layoutTiles(tiles: readonly GridTile[], metrics: GridMetrics): GridLayout {
  const { columns, cellW, cellH, gap } = metrics;
  const placed: PlacedTile[] = [];
  const rows: PlacedTile[][] = [];
  tiles.forEach((tile, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const at: PlacedTile = { tile, index, x: col * (cellW + gap), y: row * (cellH + gap), row, col };
    (rows[row] ??= []).push(at);
    placed.push(at);
  });
  return { tiles: placed, rows, height: rows.length ? rows.length * (cellH + gap) - gap : 0 };
}
