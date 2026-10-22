// tools/3ds-stage-art.ts — bakes the agent stage's two pictures
// (hosts/3ds/src/stage.c) into C headers:
//
//   stage_hint.h   two pills drawn at the top screen's own pixels after both
//                  eyes while the mascot is idle: "L+R Ask Claude" (row 0)
//                  and "SELECT Home" (row STAGE_SELECT_Y, shown while an
//                  applet other than the launcher runs). RGBA8 in the byte
//                  order the GPU reads (A, B, G, R).
//   stage_saver.h  the monitor's screensaver: the PocketJS mark with a small
//                  "PocketJS" in Fredoka under it, on the brand's plum, RGB565. The stage moves it about
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
const TEX_H = 64;
/** The SELECT pill's row in the hint texture. */
const SELECT_Y = 32;
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
/** The mark's side and the name's size on the layout grid. */
const SAVER_MARK = 60;
const SAVER_NAME_PX = 20;

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

/** The pills' geometry, shared with stage.c through the header. */
export function hintSvg(): { svg: string; width: number; height: number; selectWidth: number } {
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
  // A key cap: its lower lip, its face, then its name at `textX` (centred by
  // default) on the baseline `y + baseline`.
  const key = (
    name: string,
    x: number,
    { y = cap.y, w = cap.w, size = keySize, baseline = 10, textX = x + (w - advance(name, size)) / 2 } = {},
  ) =>
    [
      `<path fill="#b9ad9b" d="${roundRect(x, y + 1, w, cap.h, 4)}"/>`,
      `<path fill="${PAPER}" d="${roundRect(x, y, w, cap.h - 1, 4)}"/>`,
      `<path fill="${INK}" d="${textPath(name, textX, y + baseline, size)}"/>`,
    ].join("");
  // The SELECT pill: one wide cap with the button's name, then "Home".
  const selectSize = 7.5;
  const selectCap = { x: 5, y: SELECT_Y + 4, w: Math.ceil(advance("SELECT", selectSize) + 8) };
  const homeX = selectCap.x + selectCap.w + 6;
  const selectWidth = Math.ceil(homeX + advance("Home", labelSize) + 9);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TEX_W}" height="${TEX_H}">`,
    `<path fill="${INK}" fill-opacity="0.82" d="${roundRect(0, top, width, height, height / 2)}"/>`,
    key("L", capL),
    `<path fill="${ORANGE}" d="${textPath("+", plusX, top + 15.5, 11)}"/>`,
    key("R", capR),
    `<path fill="${PAPER}" d="${textPath(label, labelX, top + 15, labelSize)}"/>`,
    `<path fill="${INK}" fill-opacity="0.82" d="${roundRect(0, SELECT_Y, selectWidth, height, height / 2)}"/>`,
    key("SELECT", selectCap.x, { y: selectCap.y, w: selectCap.w, size: selectSize, baseline: 9.5, textX: selectCap.x + 4 }),
    `<path fill="${PAPER}" d="${textPath("Home", homeX, SELECT_Y + 15, labelSize)}"/>`,
    `</svg>`,
  ].join("");
  return { svg, width, height, selectWidth };
}

function byteRows(bytes: string[], perRow: number): string[] {
  const rows: string[] = [];
  for (let i = 0; i < bytes.length; i += perRow) rows.push(`  ${bytes.slice(i, i + perRow).join(", ")},`);
  return rows;
}

function hintHeader(): { text: string; rgba: Uint8Array; width: number; height: number } {
  const { svg, width, height, selectWidth } = hintSvg();
  if (width > TEX_W || selectWidth > TEX_W) throw new Error(`stage hint: ${Math.max(width, selectWidth)} px does not fit the ${TEX_W} px texture`);
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
    "/* The L+R pill inside the texture, from its top-left corner, and the",
    " * SELECT pill from (0, STAGE_SELECT_Y); both are STAGE_HINT_H tall. */",
    `#define STAGE_HINT_W ${width}`,
    `#define STAGE_HINT_H ${height}`,
    `#define STAGE_SELECT_W ${selectWidth}`,
    `#define STAGE_SELECT_Y ${SELECT_Y}`,
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

/** The screensaver: the mark, and the name in small type under it, centred
 *  on plum. The plum margin is what the clamped edge repeats. */
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
  g.font = `500 ${SAVER_NAME_PX}px Fredoka`;
  const name = "PocketJS";
  const nameWidth = g.measureText(name).width;
  const gap = 6;
  const top = (LAYOUT_H - (SAVER_MARK + gap + SAVER_NAME_PX)) / 2;
  g.drawImage(mark, (LAYOUT_W - SAVER_MARK) / 2, top, SAVER_MARK, SAVER_MARK);
  g.fillStyle = "#d9d2ee";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(name, LAYOUT_W / 2, top + SAVER_MARK + gap + SAVER_NAME_PX / 2);
  // The lockup's half extents: the wider of the mark and the name, and the
  // whole column's height (the mark's drawing spans its square's width).
  const halfX = Math.max(SAVER_MARK, nameWidth) / 2 / LAYOUT_W;
  const halfY = (SAVER_MARK + gap + SAVER_NAME_PX) / 2 / LAYOUT_H;
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
    `#define STAGE_SAVER_HALF_X ${halfX.toFixed(4)}f`,
    `#define STAGE_SAVER_HALF_Y ${halfY.toFixed(4)}f`,
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
