// Classic early-iOS portrait keyboard geometry for the 320-wide screen,
// JSX-free so bun tests can import it. Unlike the system OSK's normalized
// full-width rows, iOS rows keep a FIXED key width from the ten-key rows and
// center shorter rows inside dead margins; the action keys absorb the
// leftover width at the edges. All x/w below are absolute panel pixels.
//
// Layers: lower/upper letters (shift is one-shot), "123" numbers, and "#+="
// symbols. The third-row-left key toggles numbers<->symbols in place while
// the bottom-left key stays "ABC" on both, like the original keyboard.
//
// Every typable glyph is a source literal on purpose: the font bake harvests
// codepoints from literals, so this module is what guarantees the keys (and
// the € £ ¥ • row) can render.

import { KB_GAP, KB_PAD, KB_ROW_H, KB_W } from "./keyboard-metrics.ts";

export type KbAction = "shift" | "backspace" | "num" | "abc" | "sym" | "globe" | "return";

export interface KbKey {
  /** Literal text this key inserts (typing keys). */
  ch?: string;
  /** Key-cap label; defaults to `ch`. */
  label?: string;
  action?: KbAction;
  /** Absolute panel-pixel rect. */
  x: number;
  w: number;
}

export type KbLayerName = "lower" | "upper" | "numbers" | "symbols";

/** Ten-key grid: 28px keys, 4px gaps, 2px side margins. */
const KEY_W = 28;
const PITCH = KEY_W + 4;

function gridRow(chars: string, left: number): KbKey[] {
  return [...chars].map((ch, i) => ({ ch, x: left + i * PITCH, w: KEY_W }));
}

/** Wider third-row punctuation keys on the numbers/symbols layers. */
function punctRow(chars: string): KbKey[] {
  return [...chars].map((ch, i) => ({ ch, x: 52 + i * 44, w: 40 }));
}

const BACKSPACE: KbKey = { action: "backspace", label: "⌫", x: 280, w: 38 };

function bottomRow(left: KbKey): KbKey[] {
  return [
    left,
    { action: "globe", x: 54, w: 38 },
    { ch: " ", label: "space", x: 96, w: 140 },
    { action: "return", label: "return", x: 240, w: 78 },
  ];
}

const TO_NUMBERS: KbKey = { action: "num", label: "123", x: 2, w: 48 };
const TO_LETTERS: KbKey = { action: "abc", label: "ABC", x: 2, w: 48 };

function letters(row1: string, row2: string, row3: string): KbKey[][] {
  return [
    gridRow(row1, 2),
    gridRow(row2, 18),
    [{ action: "shift", label: "⇧", x: 2, w: 38 }, ...gridRow(row3, 50), BACKSPACE],
    bottomRow(TO_NUMBERS),
  ];
}

export const KB_LAYERS: Record<KbLayerName, KbKey[][]> = {
  lower: letters("qwertyuiop", "asdfghjkl", "zxcvbnm"),
  upper: letters("QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"),
  numbers: [
    gridRow("1234567890", 2),
    gridRow('-/:;()$&@"', 2),
    [{ action: "sym", label: "#+=", x: 2, w: 38 }, ...punctRow(".,?!'"), BACKSPACE],
    bottomRow(TO_LETTERS),
  ],
  symbols: [
    gridRow("[]{}#%^*+=", 2),
    gridRow("_\\|~<>€£¥•", 2),
    [{ action: "num", label: "123", x: 2, w: 38 }, ...punctRow(".,?!'"), BACKSPACE],
    bottomRow(TO_LETTERS),
  ],
};

// Preserve the authored key proportions on each logical portrait width.
for (const rows of Object.values(KB_LAYERS)) for (let r = 0; r < rows.length; r++)
  rows[r] = rows[r].map(key => ({ ...key, x: key.x * KB_W / 320, w: key.w * KB_W / 320 }));

export interface KbPos {
  row: number;
  col: number;
}

/**
 * Point -> key for touch input, in PANEL coordinates (y from the panel top).
 * Forgiving in x — a touch in a gap resolves to the nearest key within 8px;
 * strict in y only across the panel bounds.
 */
export function kbKeyAt(layer: readonly KbKey[][], x: number, y: number): KbPos | null {
  const yIn = y - KB_PAD;
  if (yIn < 0) return null;
  const row = Math.min(layer.length - 1, Math.floor(yIn / (KB_ROW_H + KB_GAP)));
  if (yIn > row * (KB_ROW_H + KB_GAP) + KB_ROW_H + KB_GAP / 2) return null;
  let best: KbPos | null = null;
  let bestDist = Infinity;
  for (let c = 0; c < layer[row].length; c++) {
    const k = layer[row][c];
    const dist = x < k.x ? k.x - x : x > k.x + k.w ? x - (k.x + k.w) : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = { row, col: c };
    }
  }
  return bestDist < 8 ? best : null;
}
