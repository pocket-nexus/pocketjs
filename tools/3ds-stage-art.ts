// tools/3ds-stage-art.ts — bakes the agent stage's two pictures
// (hosts/3ds/src/stage.c) into C headers:
//
//   stage_hint.h   the "L+R Ask Claude" pill, drawn at the top screen's own
//                  pixels after both eyes while the mascot is idle. RGBA8 in
//                  the byte order the GPU reads (A, B, G, R).
//   stage_saver.h  the monitor's screensaver: the PocketJS mark, the
//                  wordmark in Fredoka and the line "Create UI on every
//                  screen you love" on the brand's plum, RGB565. The stage moves it about
//                  the monitor with the texture matrix; its plum border is
//                  what the clamped texture shows around it.
//
// Rows run top to bottom; stage.c tiles both with the transfer engine at init.
//
//   bun tools/3ds-stage-art.ts                write the headers
//   bun tools/3ds-stage-art.ts --check        fail when a header is stale
//   bun tools/3ds-stage-art.ts --png <dir>    also write the images

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts, Image } from "@napi-rs/canvas";
import opentype from "opentype.js";
import { bakeSvg } from "../framework/compiler/bake-svg.ts";
import { encodePNG } from "./png.ts";

const ROOT = join(import.meta.dir, "..");
const HINT_OUT = join(ROOT, "hosts/3ds/src/stage_hint.h");
const SAVER_OUT = join(ROOT, "hosts/3ds/src/stage_saver.h");
const TEX_W = 128;
const TEX_H = 32;
/** The lockup is laid out on a 256x128 grid, drawn at four times that and
 *  reduced to the texture: 128x64, about the size the monitor shows it, so
 *  the GPU's linear filter does not minify it. */
const LAYOUT_W = 256;
const LAYOUT_H = 128;
const SAVER_W = 128;
const SAVER_H = 64;
/** The PocketJS mark (the drawing tools/icons.ts rasterizes), the sites'
 *  wordmark face and the brand's plum. */
const BRAND = join(ROOT, "skills/pocketjs-video-outro/assets");
const MARK_SVG = join(BRAND, "pocketjs-mark.svg");
const PLUM = "#171226";
/** The lockup's box on the layout grid: x0, y0, x1, y1. */
const SAVER_CONTENT = [8, 12, 248, 118] as const;

const bold = opentype.parse(readFileSync(join(ROOT, "assets/fonts/Inter-Bold.ttf")).buffer as ArrayBuffer);

const INK = "#2b2722";
const PAPER = "#f7f3eb";
const ORANGE = "#d97757";

function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  const k = r * 0.5523;
  return [
    `M${x + r} ${y}`,
    `L${x + w - r} ${y}`,
    `C${x + w - r + k} ${y} ${x + w} ${y + r - k} ${x + w} ${y + r}`,
    `L${x + w} ${y + h - r}`,
    `C${x + w} ${y + h - r + k} ${x + w - r + k} ${y + h} ${x + w - r} ${y + h}`,
    `L${x + r} ${y + h}`,
    `C${x + r - k} ${y + h} ${x} ${y + h - r + k} ${x} ${y + h - r}`,
    `L${x} ${y + r}`,
    `C${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y}`,
    "Z",
  ].join(" ");
}

// Glyph by glyph: opentype.js does not run Inter's ccmp table, and these
// labels need no shaping.
function textPath(text: string, x: number, baseline: number, size: number): string {
  const scale = size / bold.unitsPerEm;
  let pen = x;
  let d = "";
  for (const ch of text) {
    const glyph = bold.charToGlyph(ch);
    d += glyph.getPath(pen, baseline, size).toPathData(3);
    pen += (glyph.advanceWidth ?? 0) * scale;
  }
  return d;
}

function advance(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += bold.charToGlyph(ch).advanceWidth ?? 0;
  return (w * size) / bold.unitsPerEm;
}

/** The pill's geometry, shared with stage.c through the header. */
export function hintSvg(): { svg: string; width: number; height: number } {
  const height = 22;
  const top = 0;
  const cap = { w: 17, h: 14, y: top + 4 };
  const capL = 5;
  const plusX = capL + cap.w + 2;
  const capR = plusX + 9;
  const labelX = capR + cap.w + 6;
  const labelSize = 11;
  const label = "Ask Claude";
  const width = Math.ceil(labelX + advance(label, labelSize) + 9);
  const keySize = 9.5;
  const key = (letter: string, x: number) => {
    const w = advance(letter, keySize);
    return [
      // The cap's lower lip, then its face.
      `<path fill="#b9ad9b" d="${roundRect(x, cap.y + 1, cap.w, cap.h, 4)}"/>`,
      `<path fill="${PAPER}" d="${roundRect(x, cap.y, cap.w, cap.h - 1, 4)}"/>`,
      `<path fill="${INK}" d="${textPath(letter, x + (cap.w - w) / 2, cap.y + 10, keySize)}"/>`,
    ].join("");
  };
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TEX_W}" height="${TEX_H}">`,
    `<path fill="${INK}" fill-opacity="0.82" d="${roundRect(0, top, width, height, height / 2)}"/>`,
    key("L", capL),
    `<path fill="${ORANGE}" d="${textPath("+", plusX, top + 15.5, 11)}"/>`,
    key("R", capR),
    `<path fill="${PAPER}" d="${textPath(label, labelX, top + 15, labelSize)}"/>`,
    `</svg>`,
  ].join("");
  return { svg, width, height };
}

function byteRows(bytes: string[], perRow: number): string[] {
  const rows: string[] = [];
  for (let i = 0; i < bytes.length; i += perRow) rows.push(`  ${bytes.slice(i, i + perRow).join(", ")},`);
  return rows;
}

function hintHeader(): { text: string; rgba: Uint8Array; width: number; height: number } {
  const { svg, width, height } = hintSvg();
  if (width > TEX_W) throw new Error(`stage hint: ${width} px does not fit the ${TEX_W} px texture`);
  const image = bakeSvg(svg);
  const bytes: string[] = [];
  for (let i = 0; i < image.rgba.length; i += 4) {
    const [r, g, b, a] = [image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!, image.rgba[i + 3]!];
    bytes.push(`0x${a.toString(16).padStart(2, "0")}`, `0x${b.toString(16).padStart(2, "0")}`, `0x${g.toString(16).padStart(2, "0")}`, `0x${r.toString(16).padStart(2, "0")}`);
  }
  const text = [
    "/* Generated by tools/3ds-stage-art.ts; do not edit. */",
    "#ifndef POCKET_STAGE_HINT_H",
    "#define POCKET_STAGE_HINT_H",
    "",
    "#include <stdint.h>",
    "",
    `#define STAGE_HINT_TEX_W ${TEX_W}`,
    `#define STAGE_HINT_TEX_H ${TEX_H}`,
    "/* The pill inside the texture, from its top-left corner. */",
    `#define STAGE_HINT_W ${width}`,
    `#define STAGE_HINT_H ${height}`,
    "",
    "/* RGBA8 as the GPU reads it (A, B, G, R), rows top to bottom. */",
    `static const uint8_t stage_hint_pixels[${TEX_W * TEX_H * 4}] __attribute__((aligned(4))) = {`,
    ...byteRows(bytes, 16),
    "};",
    "",
    "#endif",
    "",
  ].join("\n");
  return { text, rgba: image.rgba, width: TEX_W, height: TEX_H };
}

/** The screensaver: the mark and the wordmark on one line, the tagline under
 *  them, centred on plum. The plum margin is what the clamped edge repeats. */
function saverHeader(): { text: string; rgba: Uint8Array; width: number; height: number } {
  GlobalFonts.registerFromPath(join(BRAND, "Fredoka.ttf"), "Fredoka");
  // Rasterize the SVG at its drawn size, not at its viewBox's 32 units.
  const svg = readFileSync(MARK_SVG, "utf8").replace("<svg ", '<svg width="256" height="256" ');
  const mark = new Image();
  mark.src = Buffer.from(svg);
  const big = createCanvas(LAYOUT_W * 4, LAYOUT_H * 4);
  const g = big.getContext("2d");
  g.scale(4, 4);
  g.fillStyle = PLUM;
  g.fillRect(0, 0, LAYOUT_W, LAYOUT_H);
  g.font = "600 40px Fredoka";
  const name = "PocketJS";
  const markSize = 48;
  const gap = 8;
  const left = (LAYOUT_W - (markSize + gap + g.measureText(name).width)) / 2;
  g.drawImage(mark, left, 18, markSize, markSize);
  g.fillStyle = "#ffffff";
  g.textBaseline = "middle";
  g.fillText(name, left + markSize + gap, 43);
  g.font = "500 21px Fredoka";
  g.fillStyle = "#d9d2ee";
  g.textAlign = "center";
  g.fillText("Create UI on every screen", LAYOUT_W / 2, 86);
  g.fillText("you love", LAYOUT_W / 2, 107);
  // A box filter: each texel is the mean of its 4x4 block.
  const source = g.getImageData(0, 0, LAYOUT_W * 4, LAYOUT_H * 4).data;
  const rgba = new Uint8Array(SAVER_W * SAVER_H * 4);
  const ratio = (LAYOUT_W * 4) / SAVER_W;
  for (let y = 0; y < SAVER_H; y += 1) {
    for (let x = 0; x < SAVER_W; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let sum = 0;
        for (let dy = 0; dy < ratio; dy += 1) {
          for (let dx = 0; dx < ratio; dx += 1) sum += source[((y * ratio + dy) * LAYOUT_W * 4 + x * ratio + dx) * 4 + c]!;
        }
        rgba[(y * SAVER_W + x) * 4 + c] = Math.round(sum / (ratio * ratio));
      }
    }
  }
  const words: string[] = [];
  for (let i = 0; i < rgba.length; i += 4) {
    const v = ((rgba[i]! >> 3) << 11) | ((rgba[i + 1]! >> 2) << 5) | (rgba[i + 2]! >> 3);
    words.push(`0x${v.toString(16).padStart(4, "0")}`);
  }
  const header = [
    "/* Generated by tools/3ds-stage-art.ts; do not edit. */",
    "#ifndef POCKET_STAGE_SAVER_H",
    "#define POCKET_STAGE_SAVER_H",
    "",
    "#include <stdint.h>",
    "",
    `#define STAGE_SAVER_W ${SAVER_W}`,
    `#define STAGE_SAVER_H ${SAVER_H}`,
    "/* Half the lockup's extent about the texture's centre, as fractions of",
    " * the texture's width and height. */",
    `#define STAGE_SAVER_HALF_X ${((SAVER_CONTENT[2] - SAVER_CONTENT[0]) / 2 / LAYOUT_W).toFixed(4)}f`,
    `#define STAGE_SAVER_HALF_Y ${((SAVER_CONTENT[3] - SAVER_CONTENT[1]) / 2 / LAYOUT_H).toFixed(4)}f`,
    "",
    "/* RGB565, rows top to bottom. */",
    `static const uint16_t stage_saver_pixels[${SAVER_W * SAVER_H}] __attribute__((aligned(4))) = {`,
    ...byteRows(words, 16),
    "};",
    "",
    "#endif",
    "",
  ].join("\n");
  return { text: header, rgba, width: SAVER_W, height: SAVER_H };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outputs = [
    { path: HINT_OUT, name: "hint", ...hintHeader() },
    { path: SAVER_OUT, name: "saver", ...saverHeader() },
  ];
  const png = args.indexOf("--png");
  for (const output of outputs) {
    if (png >= 0) writeFileSync(join(args[png + 1]!, `stage-${output.name}.png`), encodePNG(output.rgba, output.width, output.height));
    if (args.includes("--check")) {
      if (readFileSync(output.path, "utf8") !== output.text) {
        console.error(`${output.path} is stale: run bun tools/3ds-stage-art.ts`);
        process.exit(1);
      }
    } else {
      writeFileSync(output.path, output.text);
      console.log(`wrote ${output.path}`);
    }
  }
  if (args.includes("--check")) console.log("stage art up to date");
}
