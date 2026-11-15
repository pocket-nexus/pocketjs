// System on-screen-keyboard layout model (@pocketjs/framework/osk).
//
// Pure data + math, no components: a key grid is rows of variable-width
// keys measured in relative units, normalized per row so every row spans
// the full panel width. Because the panel computes its own pixel geometry
// (the JS side has no layout read-back), the same numbers drive rendering,
// d-pad spatial navigation and touch hit-testing, and they can never
// disagree.
//
// Two layouts ship, one per keyboard modality:
//   - "grid": the LVGL-style panel for a keyboard driven by focus. Every
//     editing action (caret, hide, commit) is a key, so a d-pad reaches it.
//   - "staggered": the phone-style panel for a keyboard driven by contacts.
//     Rows are offset by half a key, shift and backspace flank the bottom
//     letter row, and caret movement is the hold-space trackpad, not keys.
//
// Every typable glyph below is a source literal on purpose: the build's
// font bake harvests codepoints from literals across the module graph, so
// importing the OSK is what guarantees its keys can render.

/** Non-typing key behaviors. Keys with `ch` set insert it. */
export type OskAction =
  | "shift" // lower <-> upper (sticky on the grid, one-shot on the staggered layout)
  | "layer" // switch to `to` (default: letters <-> symbols)
  | "backspace"
  | "enter" // commit (↵ and ✓ both)
  | "left" // caret left
  | "right" // caret right
  | "hide"; // cancel/close

export type OskLayerName = "lower" | "upper" | "symbols" | "numbers";

export interface OskKeyDef {
  /** Literal text this key inserts (typing keys). */
  ch?: string;
  action?: OskAction;
  /** Layer a "layer" action switches to. */
  to?: OskLayerName;
  /** Key-cap label; defaults to `ch`. */
  label?: string;
  /** Relative width in row units (normalized per row). */
  w: number;
  /** Consumes width, renders nothing, takes no focus and no contact. */
  spacer?: boolean;
}

export type OskLayoutKind = "grid" | "staggered";

// ---------------------------------------------------------------------------
// Panel metrics (logical pixels)
// ---------------------------------------------------------------------------

export const OSK_ROW_H = 18;
export const OSK_GAP = 4;
export const OSK_PAD = 4;
/** Docked grid panel height at the default row height: 4 rows + 3 gaps + padding. */
export const OSK_H = 4 * OSK_ROW_H + 3 * OSK_GAP + 2 * OSK_PAD; // 92

export interface OskMetrics {
  readonly rowH: number;
  readonly gap: number;
  readonly pad: number;
  /** Legend strip above the rows (0 = none). */
  readonly hint: number;
}

/** Row height a layout defaults to: a focus ring needs 18 px, a finger 30. */
export const OSK_LAYOUT_ROW_H: Readonly<Record<OskLayoutKind, number>> = { grid: OSK_ROW_H, staggered: 30 };

export function oskMetrics(kind: OskLayoutKind, rowH: number = OSK_LAYOUT_ROW_H[kind], hint = 0): OskMetrics {
  return { rowH, gap: OSK_GAP, pad: OSK_PAD, hint };
}

/** Panel height for a metric set: hint strip + 4 rows + 3 gaps + padding. */
export function oskPanelHeight(metrics: OskMetrics): number {
  return metrics.hint + 4 * metrics.rowH + 3 * metrics.gap + 2 * metrics.pad;
}

/** Offset of the first row inside the panel. */
export function oskRowsTop(metrics: OskMetrics): number {
  return metrics.hint + metrics.pad;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const chars = (s: string): OskKeyDef[] => [...s].map((ch) => ({ ch, w: 1 }));
const spacer = (w: number): OskKeyDef => ({ w, spacer: true });

/** Grid bottom row, LVGL-style: hide · caret-left · space · caret-right · OK. */
const GRID_BOTTOM: OskKeyDef[] = [
  { action: "hide", label: "▼", w: 1.5 },
  { action: "left", label: "‹", w: 1.5 },
  { ch: " ", label: "", w: 7 },
  { action: "right", label: "›", w: 1.5 },
  { action: "enter", label: "✓", w: 1.5 },
];

const GRID_LAYERS: Partial<Record<OskLayerName, OskKeyDef[][]>> = {
  lower: [
    [{ action: "layer", to: "symbols", label: "1#", w: 1.5 }, ...chars("qwertyuiop"), { action: "backspace", label: "⌫", w: 1.5 }],
    [{ action: "shift", label: "ABC", w: 2 }, ...chars("asdfghjkl"), { action: "enter", label: "↵", w: 2 }],
    chars("_-zxcvbnm.,:"),
    GRID_BOTTOM,
  ],
  upper: [
    [{ action: "layer", to: "symbols", label: "1#", w: 1.5 }, ...chars("QWERTYUIOP"), { action: "backspace", label: "⌫", w: 1.5 }],
    [{ action: "shift", label: "abc", w: 2 }, ...chars("ASDFGHJKL"), { action: "enter", label: "↵", w: 2 }],
    chars("_-ZXCVBNM.,:"),
    GRID_BOTTOM,
  ],
  symbols: [
    [{ action: "layer", to: "lower", label: "abc", w: 1.5 }, ...chars("1234567890"), { action: "backspace", label: "⌫", w: 1.5 }],
    [...chars("+-*/=%!?@"), { action: "enter", label: "↵", w: 2 }],
    chars("#()[]'\";&$,."),
    GRID_BOTTOM,
  ],
};

/** Every row of the staggered layout spans ten units, so a letter is one
 *  tenth of the panel and the half-unit spacers produce the phone offset. */
function staggeredLetters(row1: string, row2: string, row3: string, shiftLabel: string): OskKeyDef[][] {
  return [
    chars(row1),
    [spacer(0.5), ...chars(row2), spacer(0.5)],
    [{ action: "shift", label: shiftLabel, w: 1.5 }, ...chars(row3), { action: "backspace", label: "⌫", w: 1.5 }],
    STAGGERED_BOTTOM("numbers", "123"),
  ];
}

const STAGGERED_BOTTOM = (to: OskLayerName, label: string): OskKeyDef[] => [
  { action: "layer", to, label, w: 1.5 },
  { action: "hide", label: "▼", w: 1.5 },
  { ch: " ", label: "", w: 5.5 },
  { action: "enter", label: "✓", w: 1.5 },
];

const STAGGERED_LAYERS: Partial<Record<OskLayerName, OskKeyDef[][]>> = {
  lower: staggeredLetters("qwertyuiop", "asdfghjkl", "zxcvbnm", "⇧"),
  upper: staggeredLetters("QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM", "⇧"),
  numbers: [
    chars("1234567890"),
    chars("-/:;()$&@\""),
    [{ action: "layer", to: "symbols", label: "#+=", w: 1.5 }, ...[...".,?!'"].map((ch) => ({ ch, w: 1.4 })), { action: "backspace", label: "⌫", w: 1.5 }],
    STAGGERED_BOTTOM("lower", "ABC"),
  ],
  symbols: [
    chars("[]{}#%^*+="),
    chars("_\\|~<>€£¥•"),
    [{ action: "layer", to: "numbers", label: "123", w: 1.5 }, ...[...".,?!'"].map((ch) => ({ ch, w: 1.4 })), { action: "backspace", label: "⌫", w: 1.5 }],
    STAGGERED_BOTTOM("lower", "ABC"),
  ],
};

/** The grid layers, by name (the historical export). */
export const OSK_LAYERS: Record<Exclude<OskLayerName, "numbers">, OskKeyDef[][]> = GRID_LAYERS as never;

export const OSK_LAYOUTS: Readonly<Record<OskLayoutKind, Partial<Record<OskLayerName, OskKeyDef[][]>>>> = {
  grid: GRID_LAYERS,
  staggered: STAGGERED_LAYERS,
};

/** The layer a keyboard opens on and every layout has. */
export const OSK_HOME_LAYER: OskLayerName = "lower";

/** The layer a "layer" key without `to` switches to from `from`. */
export function oskLayerToggle(kind: OskLayoutKind, from: OskLayerName): OskLayerName {
  if (kind === "grid") return from === "symbols" ? "lower" : "symbols";
  return from === "numbers" || from === "symbols" ? "lower" : "numbers";
}

/** The layer rows for a layout, falling back to the home layer when the
 *  layout does not carry the requested one (the grid has no "numbers"). */
export function oskLayer(kind: OskLayoutKind, layer: OskLayerName): OskKeyDef[][] {
  return OSK_LAYOUTS[kind][layer] ?? OSK_LAYOUTS[kind][OSK_HOME_LAYER]!;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface OskKeyRect {
  key: OskKeyDef;
  row: number;
  /** Column among the row's KEYS (spacers are not columns). */
  col: number;
  /** Pixel offset inside the row (0 = row left edge). */
  x: number;
  w: number;
}

/**
 * Normalize one layer into per-key pixel rects for an `innerW`-wide row box.
 * Cumulative rounding: key edges land on round(prefix-units share), so the
 * widths always sum exactly to `innerW` with no 1-px drift. Spacers take
 * their share of the width and a gap, and emit no rect.
 */
export function layoutRows(layer: readonly OskKeyDef[][], innerW: number, gap: number = OSK_GAP): OskKeyRect[][] {
  return layer.map((row, r) => {
    const units = row.reduce((sum, k) => sum + k.w, 0);
    const keyPx = innerW - gap * (row.length - 1);
    const rects: OskKeyRect[] = [];
    let prefix = 0;
    let left = 0;
    for (let c = 0; c < row.length; c++) {
      const right = Math.round(((prefix + row[c].w) / units) * keyPx);
      if (!row[c].spacer) rects.push({ key: row[c], row: r, col: rects.length, x: left + c * gap, w: right - left });
      prefix += row[c].w;
      left = right;
    }
    return rects;
  });
}

export interface OskPos {
  row: number;
  col: number;
}

/** Clamp a (row, col) into a layer's shape — used across layer switches. */
export function clampPos(rows: readonly OskKeyRect[][], pos: OskPos): OskPos {
  const row = Math.max(0, Math.min(pos.row, rows.length - 1));
  const col = Math.max(0, Math.min(pos.col, rows[row].length - 1));
  return { row, col };
}

/** Where a keyboard opens the first time: the 'q' key, or the row's first key. */
export function homePos(rows: readonly OskKeyRect[][]): OskPos {
  for (const row of rows) for (const k of row) if (k.key.ch === "q") return { row: k.row, col: k.col };
  return { row: 0, col: 0 };
}

/**
 * Spatial d-pad navigation over variable-width rows: left/right wrap within
 * the row; up/down clamp at the edges and pick the key in the adjacent row
 * with the largest horizontal overlap (nearest center on ties/no overlap).
 */
export function navigate(
  rows: readonly OskKeyRect[][],
  pos: OskPos,
  direction: "up" | "down" | "left" | "right",
): OskPos {
  const { row, col } = clampPos(rows, pos);
  if (direction === "left" || direction === "right") {
    const n = rows[row].length;
    const d = direction === "right" ? 1 : -1;
    return { row, col: (col + d + n) % n };
  }
  const target = row + (direction === "down" ? 1 : -1);
  if (target < 0 || target >= rows.length) return { row, col };
  const cur = rows[row][col];
  const c0 = cur.x;
  const c1 = cur.x + cur.w;
  const center = (c0 + c1) / 2;
  let best = 0;
  let bestOverlap = -1;
  let bestDist = Infinity;
  for (let c = 0; c < rows[target].length; c++) {
    const k = rows[target][c];
    const overlap = Math.min(c1, k.x + k.w) - Math.max(c0, k.x);
    const dist = Math.abs((k.x + k.w / 2) - center);
    if (overlap > bestOverlap || (overlap === bestOverlap && dist < bestDist)) {
      best = c;
      bestOverlap = overlap;
      bestDist = dist;
    }
  }
  return { row: target, col: best };
}

/**
 * Point -> key for touch input. `x`/`y` are row-box coordinates (the caller
 * subtracts the panel origin, the hint strip and the padding). Forgiving in
 * x — a touch in a gap resolves to the nearest key of the row; strict in y
 * only across the panel bounds.
 */
export function keyAtPoint(
  rows: readonly OskKeyRect[][],
  x: number,
  y: number,
  rowH: number = OSK_ROW_H,
  gap: number = OSK_GAP,
): OskPos | null {
  if (y < 0) return null;
  const row = Math.min(rows.length - 1, Math.floor(y / (rowH + gap)));
  if (y > row * (rowH + gap) + rowH + gap / 2) return null; // below the last row
  let best: OskPos | null = null;
  let bestDist = Infinity;
  for (let c = 0; c < rows[row].length; c++) {
    const k = rows[row][c];
    const dist = x < k.x ? k.x - x : x > k.x + k.w ? x - (k.x + k.w) : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = { row, col: c };
    }
  }
  return bestDist < 8 ? best : null;
}
