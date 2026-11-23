#!/usr/bin/env bun
// bun tools/pocketui-pixel-font.ts [--out <dir>]
//
// Bake PocketUI's pixel face (@pocketjs/framework/ui, the Classic theme's): W95FA (assets/fonts/W95FA.otf, SIL OFL 1.1, a
// redrawing of an 8-point bitmap sans by FontsArena) into PocketJS font
// atlases, one for the regular weight and one for the bold, at raster
// densities 1 to 4.
//
// The font's outlines are squares on a grid of 80 units a pixel, so this
// does not rasterize with coverage: it asks, for the centre of each grid square,
// whether it is inside the glyph, and writes that pixel as a block of
// density x density full-coverage samples. A font pixel is a logical pixel
// on every device, and a hard one. The bold is the regular drawn twice, a
// pixel apart, which is how a bitmap face is emboldened.
//
// The atlases are raw pak entries in assets/fonts/pocketui/: an
// application's pak.json names them under the keys `ui:font.<slot>`
// (docs/POCKETUI.md, "The pixel face").
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** What this reads of opentype.js, which it takes from the PocketJS checkout's packages. */
type PathCommand = { type: "M"; x: number; y: number } | { type: "L"; x: number; y: number } | { type: "Q"; x1: number; y1: number; x: number; y: number } | { type: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number } | { type: "Z" };
interface Glyph {
  index: number;
  name: string | null;
  advanceWidth?: number;
  getPath(x: number, y: number, size: number): { commands: PathCommand[] };
}
interface Font {
  unitsPerEm: number;
  charToGlyph(character: string): Glyph;
}

/** PocketJS's font atlas (contracts/spec/spec.ts, FONT ATLAS binary format, version 3). */
const FONT_MAGIC = 0x41464344;
const FONT_VERSION = 3;
const HEADER = 16;
const CMAP_ENTRY = 8;
const FLAG_BOLD = 1;
const TOFU = 0xfffd;

/** The font's grid: units a pixel, and where its first column starts. */
const UNIT = 80;
const PHASE = 50;

export const PIXEL_REGULAR_SLOT = 20;
export const PIXEL_BOLD_SLOT = 23;

interface Bits {
  cp: number;
  /** rows top to bottom from `top` rows above the baseline; each a list of lit columns */
  rows: boolean[][];
  width: number;
  advance: number;
}

type Point = [number, number];

/** A glyph's contours as polygons, in font units with y up. */
function contours(glyph: Glyph, upm: number): Point[][] {
  const out: Point[][] = [];
  let current: Point[] = [];
  for (const command of glyph.getPath(0, 0, upm).commands) {
    if (command.type === "M") {
      if (current.length > 2) out.push(current);
      current = [[command.x, -command.y]];
    } else if (command.type === "L") current.push([command.x, -command.y]);
    else if (command.type === "Z") {
      if (current.length > 2) out.push(current);
      current = [];
    } else {
      // the few glyphs drawn with curves (a section sign): eight chords each
      const [x0, y0] = current[current.length - 1] ?? [0, 0];
      for (let step = 1; step <= 8; step++) {
        const t = step / 8;
        const u = 1 - t;
        if (command.type === "Q") current.push([u * u * x0 + 2 * u * t * command.x1 + t * t * command.x, u * u * y0 + 2 * u * t * -command.y1 + t * t * -command.y]);
        else current.push([u * u * u * x0 + 3 * u * u * t * command.x1 + 3 * u * t * t * command.x2 + t * t * t * command.x, u * u * u * y0 + 3 * u * u * t * -command.y1 + 3 * u * t * t * -command.y2 + t * t * t * -command.y]);
      }
    }
  }
  if (current.length > 2) out.push(current);
  return out;
}

/** Nonzero winding number of a point. */
function inside(polygons: Point[][], x: number, y: number): boolean {
  let winding = 0;
  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i++) {
      const [x0, y0] = polygon[i]!;
      const [x1, y1] = polygon[(i + 1) % polygon.length]!;
      if (y0 <= y) {
        if (y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) winding++;
      } else if (y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) winding--;
    }
  }
  return winding !== 0;
}

function read(font: Font, cp: number, top: number, bottom: number): Bits | null {
  const glyph = font.charToGlyph(String.fromCodePoint(cp));
  if (glyph.index === 0) return null;
  const polygons = contours(glyph, font.unitsPerEm);
  const advance = Math.max(1, Math.round((glyph.advanceWidth ?? 0) / UNIT));
  let width = 0;
  const rows: boolean[][] = [];
  for (let row = top - 1; row >= -bottom; row--) {
    const line: boolean[] = [];
    for (let column = 0; column < advance + 2; column++) {
      const lit = inside(polygons, PHASE + (column + 0.5) * UNIT, (row + 0.5) * UNIT);
      line.push(lit);
      if (lit && column + 1 > width) width = column + 1;
    }
    rows.push(line);
  }
  return { cp, rows, width, advance };
}

/** A glyph drawn here because the font has none: the middle dot that stands for a character still on its way. */
function dot(top: number, bottom: number): Bits {
  const rows: boolean[][] = [];
  for (let row = top - 1; row >= -bottom; row--) rows.push([false, row === 3, false]);
  return { cp: 0xb7, rows, width: 2, advance: 3 };
}

function embolden(glyph: Bits): Bits {
  return { cp: glyph.cp, rows: glyph.rows.map((row) => [...row, false].map((lit, column, all) => lit || (column > 0 && all[column - 1] === true))), width: glyph.width > 0 ? glyph.width + 1 : 0, advance: glyph.advance + 1 };
}

export function bakePixelAtlas(font: Font, slot: number, bold: boolean, density: number): Uint8Array {
  // the rows the face needs: its tallest ascender and its deepest descender over what is baked
  const top = 11;
  const bottom = 3;
  const glyphs: Bits[] = [];
  for (let cp = 0x20; cp <= 0xff; cp++) {
    if (cp >= 0x7f && cp < 0xa0) continue;
    const bits = cp === 0xb7 ? (read(font, cp, top, bottom) ?? dot(top, bottom)) : read(font, cp, top, bottom);
    if (bits) glyphs.push(bold ? embolden(bits) : bits);
  }
  const cellW = Math.max(...glyphs.map((glyph) => Math.max(glyph.width, glyph.advance))) + 1;
  const cellH = top + bottom;
  const count = glyphs.length + 1;
  const coverageW = cellW * density;
  const coverageH = cellH * density;
  const cell = coverageW * coverageH;
  const out = new Uint8Array(HEADER + count * CMAP_ENTRY + count * cell);
  const view = new DataView(out.buffer);
  view.setUint32(0, FONT_MAGIC, true);
  view.setUint16(4, FONT_VERSION, true);
  view.setUint16(6, count, true);
  out[8] = cellW;
  out[9] = cellH;
  out[10] = top;
  out[11] = cellH;
  out[12] = slot;
  out[13] = bold ? FLAG_BOLD : 0;
  out[14] = density;
  // the cmap, ascending by codepoint; gid 0 is the box drawn for a character the face lacks
  const entries = glyphs.map((glyph, index) => ({ cp: glyph.cp, gid: index + 1, advance: glyph.advance }));
  entries.push({ cp: TOFU, gid: 0, advance: 7 });
  entries.sort((a, b) => a.cp - b.cp);
  let at = HEADER;
  for (const entry of entries) {
    view.setUint32(at, entry.cp, true);
    view.setUint16(at + 4, entry.gid, true);
    out[at + 6] = entry.advance;
    out[at + 7] = 0;
    at += CMAP_ENTRY;
  }
  const base = HEADER + count * CMAP_ENTRY;
  const plot = (gid: number, column: number, row: number) => {
    const start = base + gid * cell;
    for (let y = 0; y < density; y++) for (let x = 0; x < density; x++) out[start + (row * density + y) * coverageW + column * density + x] = 255;
  };
  // the box: an outline 5 wide over the capitals' height
  for (let row = top - 9; row < top; row++) for (let column = 0; column < 5; column++) if (row === top - 9 || row === top - 1 || column === 0 || column === 4) plot(0, column, row);
  glyphs.forEach((glyph, index) => {
    for (let row = 0; row < glyph.rows.length; row++) {
      const line = glyph.rows[row]!;
      for (let column = 0; column < line.length && column < cellW; column++) if (line[column]) plot(index + 1, column, row);
    }
  });
  return out;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const at = process.argv.indexOf("--out");
  const outDir = at >= 0 ? resolve(process.argv[at + 1]!) : join(root, "assets/fonts/pocketui");
  const { parse } = (await import(join(root, "node_modules/opentype.js"))) as { parse(buffer: ArrayBuffer): Font };
  const font = parse(await Bun.file(join(root, "assets/fonts/W95FA.otf")).arrayBuffer());
  mkdirSync(outDir, { recursive: true });
  for (const [slot, bold] of [[PIXEL_REGULAR_SLOT, false], [PIXEL_BOLD_SLOT, true]] as const) {
    for (let density = 1; density <= 4; density++) {
      // PocketJS's build takes `<name>@<density>x.bin` beside `<name>.bin` for a denser target (compiler/raster-assets.ts)
      const file = join(outDir, `pixel-${slot}${density === 1 ? "" : `@${density}x`}.bin`);
      const bytes = bakePixelAtlas(font, slot, bold, density);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      console.log(`${file} ${bytes.length} bytes`);
    }
  }
}
