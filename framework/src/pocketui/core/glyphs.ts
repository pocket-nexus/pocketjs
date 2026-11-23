// PocketUI core/glyphs.ts — the art of marks, as data: strokes and pixel
// rows turned into the rectangles ui/glyph.ts draws.
import type { GlyphArt, GlyphName, GlyphShape } from "./theme.ts";

/** A mark that draws nothing: a theme's answer for a mark its tradition leaves out. */
export const NO_GLYPH: GlyphArt = { w: 0, h: 0, shapes: [] };

/** A stroke `len` long and `t` thick, centred at (cx, cy), turned `rot` degrees clockwise. */
export function stroke(cx: number, cy: number, len: number, t: number, rot = 0): GlyphShape {
  return { x: cx - len / 2, y: cy - t / 2, w: len, h: t, rot, r: t / 2 };
}

/** A mark from rows of pixels: "#" is ink. Each run of ink in a row is one rectangle `cell` points a side. */
export function bitmap(rows: readonly string[], cell = 1, color?: string): GlyphArt {
  const shapes: GlyphShape[] = [];
  let width = 0;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!;
    if (row.length > width) width = row.length;
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "#") {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end] === "#") end++;
      shapes.push({ x: x * cell, y: y * cell, w: (end - x) * cell, h: cell, color });
      x = end;
    }
  }
  return { w: width * cell, h: rows.length * cell, shapes };
}

/** The stock marks: strokes in a box `s` points a side. */
export function stockGlyph(name: GlyphName, s: number): GlyphArt {
  const t = Math.max(1.5, s * 0.15);
  const arm = s * 0.5;
  const shapes: GlyphShape[] = [];
  switch (name) {
    case "close":
      shapes.push(stroke(s / 2, s / 2, s * 1.05, t, 45), stroke(s / 2, s / 2, s * 1.05, t, -45));
      break;
    case "back":
    case "left":
      shapes.push(stroke(s * 0.47, s * 0.33, arm, t, -45), stroke(s * 0.47, s * 0.67, arm, t, 45));
      break;
    case "forward":
    case "right":
    case "disclosure":
      shapes.push(stroke(s * 0.53, s * 0.33, arm, t, 45), stroke(s * 0.53, s * 0.67, arm, t, -45));
      break;
    case "up":
      shapes.push(stroke(s * 0.33, s * 0.5, arm, t, -45), stroke(s * 0.67, s * 0.5, arm, t, 45));
      break;
    case "down":
      shapes.push(stroke(s * 0.33, s * 0.5, arm, t, 45), stroke(s * 0.67, s * 0.5, arm, t, -45));
      break;
    case "check":
      shapes.push(stroke(s * 0.28, s * 0.66, s * 0.4, t, 45), stroke(s * 0.63, s * 0.5, s * 0.78, t, -51));
      break;
    case "dot":
      shapes.push({ x: s * 0.25, y: s * 0.25, w: s * 0.5, h: s * 0.5, r: s * 0.25 });
      break;
    case "more": {
      const d = Math.max(2, s * 0.22);
      for (let i = 0; i < 3; i++) shapes.push({ x: s * (0.5 + (i - 1) * 0.36) - d / 2, y: s / 2 - d / 2, w: d, h: d, r: d / 2 });
      break;
    }
    case "menu":
      for (let i = 0; i < 3; i++) shapes.push({ x: s * 0.1, y: s * (0.22 + i * 0.28) - t / 2, w: s * 0.8, h: t, r: t / 2 });
      break;
    case "minimize":
      shapes.push({ x: s * 0.15, y: s * 0.72, w: s * 0.7, h: t });
      break;
    case "zoom":
      shapes.push({ x: s * 0.12, y: s * 0.12, w: s * 0.76, h: s * 0.76, ring: t * 0.8 });
      break;
    case "plus":
      shapes.push(stroke(s / 2, s / 2, s * 0.84, t, 0), stroke(s / 2, s / 2, s * 0.84, t, 90));
      break;
    case "updown": {
      // two solid arrowheads pointing apart, a clear gap between their bases
      const half = s * 0.27;
      shapes.push({ x: s / 2 - half, y: s * 0.08, w: half * 2, h: s * 0.3, tri: [s / 2, s * 0.08, s / 2 + half, s * 0.38, s / 2 - half, s * 0.38] });
      shapes.push({ x: s / 2 - half, y: s * 0.62, w: half * 2, h: s * 0.3, tri: [s / 2 - half, s * 0.62, s / 2 + half, s * 0.62, s / 2, s * 0.92] });
      break;
    }
    case "grip":
      for (let i = 0; i < 3; i++) shapes.push({ x: s * 0.2, y: s * (0.25 + i * 0.25) - 0.5, w: s * 0.6, h: 1 });
      break;
  }
  return { w: s, h: s, shapes };
}

