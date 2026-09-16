import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { createTextTileRenderer } from "../tools/ime/text-tile.ts";
import { createTextProvider } from "../tools/text-glyph-provider.ts";
const inter = resolve(import.meta.dir, "../assets/fonts/Inter-Regular.ttf");
GlobalFonts.registerFromPath(inter, "IME Tile Test");
const cjk = "/System/Library/Fonts/STHeiti Medium.ttc";
if (existsSync(cjk)) GlobalFonts.registerFromPath(cjk, "IME CJK Test");
for (const [font, text, size, bold] of [
  ["IME Tile Test", "Ágj|", 32, false], ["IME Tile Test", "ÉÊÅgj", 40, true],
  ...(existsSync(cjk) ? [["IME CJK Test", "你好高赢", 32, false], ["IME CJK Test", "國富草測", 40, true]] : []),
] as [string, string, number, boolean][]) test(`tile stitching preserves all ink: ${text} ${size}px`, () => {
  const width = 192, render = createTextTileRenderer(font);
  const rows: number[][] = [];
  for (let row = 0; row < 4; row++) {
    const mask = Buffer.from(render(JSON.stringify({text, width, size, row, bold})), "base64");
    expect(mask.length).toBe(width * 4);
    for (let y = 0; y < 16; y++) rows.push(Array.from({length: width}, (_, x) => {
      const i = y * width + x; return mask[i >> 2] >> ((i & 3) * 2) & 3;
    }));
  }
  // Draw in an oversized reference canvas, then compare the ink independent
  // of its vertical origin. A lost top stroke or descender fails this check.
  const context = createCanvas(width, 128).getContext("2d");
  context.font = `${bold ? "bold " : ""}${size}px "${font}"`;
  context.fillStyle = "white"; context.textBaseline = "alphabetic";
  context.fillText(text, 0, 64);
  const pixels = context.getImageData(0, 0, width, 128).data;
  const reference = Array.from({length: 128}, (_, y) => Array.from({length: width}, (_, x) => Math.round(pixels[(y * width + x) * 4 + 3] / 85)));
  const trim = (rows: number[][]) => {
    const first = rows.findIndex(row => row.some(Boolean));
    let end = rows.length; while (end > first && !rows[end - 1].some(Boolean)) end--;
    return rows.slice(first, end);
  };
  expect(rows[0].some(Boolean)).toBe(false);
  expect(rows.at(-1)!.some(Boolean)).toBe(false);
  expect(trim(rows)).toEqual(trim(reference));
  const lineHeight = size + 16;
  expect(rows.slice(lineHeight).some(row => row.some(Boolean))).toBe(false);
});
test("text tiles reject dimensions beyond the bounded record/canvas", () => {
  const render = createTextTileRenderer("IME Tile Test");
  const request = {text:"a", width:120, size:32, row:0, bold:false};
  for (const invalid of [{width:321}, {width:3}, {row:4}, {size:64}, {column:2}, {text:"x".repeat(257)}])
    expect(() => render(JSON.stringify({...request, ...invalid}))).toThrow("Invalid text tile");
});

test("reusable glyph records preserve top strokes and descenders in complete coverage envelopes", () => {
  const font = existsSync(cjk) ? cjk : inter, provider = createTextProvider(font);
  const face = JSON.parse(provider["text.font"]()).id;
  const family = `Pocket-${face}`;
  for (const text of existsSync(cjk) ? ["你", "好", "高", "赢", "g", "Á"] : ["g", "Á"]) for (const size of [12, 14, 16, 20]) {
    const glyph = JSON.parse(provider["text.glyph"](JSON.stringify({ face, text, size, density: 2, bold: size === 20 })));
    const packed = Buffer.from(glyph.mask, "base64"), actual: number[][] = [];
    for (let y = 0; y < glyph.height; y++) actual.push(Array.from({ length: glyph.width }, (_, x) => {
      const i = y * glyph.width + x; return packed[i >> 2] >> ((i & 3) * 2) & 3;
    }));
    const c = createCanvas(160, 160).getContext("2d");
    c.font = `${size === 20 ? "bold " : ""}${size * 2}px "${family}"`; c.fillStyle = "white"; c.textBaseline = "alphabetic"; c.fillText(text, 64, 80);
    const rgba = c.getImageData(0, 0, 160, 160).data;
    const reference = Array.from({ length: 160 }, (_, y) => Array.from({ length: 160 }, (_, x) => Math.round(rgba[(y * 160 + x) * 4 + 3] / 85)));
    function ink(rows: number[][]) {
      let x0 = Infinity, y0 = Infinity, x1 = 0, y1 = 0;
      rows.forEach((row, y) => row.forEach((alpha, x) => { if (alpha) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } }));
      return rows.slice(y0, y1 + 1).map(row => row.slice(x0, x1 + 1));
    }
    expect(ink(actual)).toEqual(ink(reference));
    expect(actual[0].some(Boolean)).toBe(false);
    expect(actual.slice((size + 8) * 2).some(row => row.some(Boolean))).toBe(false);
  }
});
