// apps/zoomlab/gen-assets.ts — bake the synthetic deep-zoom test document.
//
//   bun apps/zoomlab/gen-assets.ts
//
// Offline baker (run MANUALLY, like apps/gallery/gen-assets.ts) with NO
// external inputs: it procedurally rasterizes two synthetic pages — nested
// rounded rects, a grid of numbered cells, concentric rings, a stepped
// gradient bar — straight into RGBA buffers (hand-rolled aliased fills; no
// canvas dependency), quantizes to a small shared palette, and writes TILESET
// pak entries (contracts/spec/spec.ts 'PKTS') that the viewer app streams one tile at a
// time through the loadTileTexture op.
//
// This demo exists so the DeepZoom engine keeps first-party coverage of every
// tile kind — '.' background, lettered solids, textured '#', multi-level
// pyramids, two-page doc switching — in a few dozen KB of committed bytes.
// (The real-world consumer, the Figma viewer, lives at
// github.com/pocket-nexus/pocket-figma and vendors this repo.)
//
// Outputs are COMMITTED (the bake is deterministic; a re-run is byte-identical):
//   apps/zoomlab/tiles/<page>.<level>.bin  TILESET blobs
//   apps/zoomlab/pak.json                  pak key -> file map (tools/build.ts
//                                           splices these into dist/zoomlab-main.pak)
//   apps/zoomlab/tiles.ts                  hand-readable manifest the viewer
//                                           reads INSTEAD of parsing binary at
//                                           runtime (plain .ts, not *.generated.ts,
//                                           so the pass-1 scanner walks it)
//
// Size discipline: everything is flat aliased fill (no AA, no dithering), so
// CLUT8 + PackBits RLE crushes it; most of each page is deliberately empty so
// whitespace exercises the solid-tile path and costs 8 directory bytes.

import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { encodeTilesetEntry, keyTileset, type TilesetTile } from "../../framework/compiler/pak.ts";
import {
  TILESET_DIR_ENTRY_SIZE,
  TILESET_FLAG_LINEAR,
  TILESET_FLAG_RLE,
  TILESET_MAGIC,
  TILESET_VERSION,
  packbitsDecode,
} from "../../contracts/spec/spec.ts";

const HERE = new URL(".", import.meta.url).pathname; // apps/zoomlab/
const TILE = 256;
const SCREEN_W = 480; // PSP screen — the overview level must fit inside it
const SCREEN_H = 272;
const BUDGET = 150 * 1024; // hard cap on total committed tile bytes

// ---------------------------------------------------------------------------
// Palette — every color the rasterizer may emit, index 0 = page background.
// Quantization is EXACT match (the renderer never blends), so the palette is
// simply "the ink set" plus the 32 gradient steps.
// ---------------------------------------------------------------------------

const abgr = (r: number, g: number, b: number): number => ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;

const BG = abgr(0xe8, 0xe8, 0xe8); // light paper gray
const INK = abgr(0x30, 0x30, 0x30); // near-black outlines / digits
const INDIGO = abgr(0x63, 0x66, 0xf1);
const AMBER = abgr(0xf5, 0x9e, 0x0b);
const TEAL = abgr(0x14, 0xb8, 0xa6);
const ROSE = abgr(0xf4, 0x3f, 0x5e);
const PANEL = abgr(0x37, 0x41, 0x51); // slate-700 flat panel (lettered solid tiles)
const CARD = abgr(0xff, 0xff, 0xff); // white card fill
const DARK_BG = abgr(0x1e, 0x29, 0x3b); // page 2 background (slate-800)

/** 32-step horizontal gradient ramp, indigo -> rose (integer lerp — exact). */
const GRAD: number[] = [];
for (let i = 0; i < 32; i++) {
  const t = i / 31;
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * t);
  GRAD.push(abgr(mix(0x63, 0xf4), mix(0x66, 0x3f), mix(0xf1, 0x5e)));
}

// ---------------------------------------------------------------------------
// Scene rasterizer — aliased fills into a u32 ABGR buffer at a given scale.
// Every primitive takes DOC coordinates and multiplies by `s` at the edge, so
// each mip level is an independent, deterministic rasterization of the same
// scene description (no downsampling pass, no blending, no AA).
// ---------------------------------------------------------------------------

interface Raster {
  w: number;
  h: number;
  px: Uint32Array;
  s: number;
}

function fillRect(r: Raster, x: number, y: number, w: number, h: number, color: number): void {
  const x0 = Math.max(0, Math.round(x * r.s));
  const y0 = Math.max(0, Math.round(y * r.s));
  const x1 = Math.min(r.w, Math.round((x + w) * r.s));
  const y1 = Math.min(r.h, Math.round((y + h) * r.s));
  for (let py = y0; py < y1; py++) {
    r.px.fill(color, py * r.w + x0, py * r.w + x1);
  }
}

/** Rounded rect, radius in doc px; per-pixel corner-circle test (aliased). */
function fillRoundRect(r: Raster, x: number, y: number, w: number, h: number, rad: number, color: number): void {
  const x0 = Math.max(0, Math.round(x * r.s));
  const y0 = Math.max(0, Math.round(y * r.s));
  const x1 = Math.min(r.w, Math.round((x + w) * r.s));
  const y1 = Math.min(r.h, Math.round((y + h) * r.s));
  const rr = rad * r.s;
  const cx0 = x * r.s + rr;
  const cy0 = y * r.s + rr;
  const cx1 = (x + w) * r.s - rr;
  const cy1 = (y + h) * r.s - rr;
  for (let py = y0; py < y1; py++) {
    for (let pxx = x0; pxx < x1; pxx++) {
      const fx = pxx + 0.5;
      const fy = py + 0.5;
      const dx = fx < cx0 ? cx0 - fx : fx > cx1 ? fx - cx1 : 0;
      const dy = fy < cy0 ? cy0 - fy : fy > cy1 ? fy - cy1 : 0;
      if (dx * dx + dy * dy <= rr * rr) r.px[py * r.w + pxx] = color;
    }
  }
}

/** Ring (annulus) centered at (cx, cy), doc-px radii [r0, r1). */
function fillRing(r: Raster, cx: number, cy: number, r0: number, r1: number, color: number): void {
  const x0 = Math.max(0, Math.floor((cx - r1) * r.s));
  const y0 = Math.max(0, Math.floor((cy - r1) * r.s));
  const x1 = Math.min(r.w, Math.ceil((cx + r1) * r.s));
  const y1 = Math.min(r.h, Math.ceil((cy + r1) * r.s));
  const sc = r.s;
  const lo = r0 * sc * (r0 * sc);
  const hi = r1 * sc * (r1 * sc);
  for (let py = y0; py < y1; py++) {
    for (let pxx = x0; pxx < x1; pxx++) {
      const dx = pxx + 0.5 - cx * sc;
      const dy = py + 0.5 - cy * sc;
      const d = dx * dx + dy * dy;
      if (d >= lo && d < hi) r.px[py * r.w + pxx] = color;
    }
  }
}

// 3x5 digit bitmaps, row-major, 1 bit per cell.
const DIGITS: number[][] = [
  [0b111, 0b101, 0b101, 0b101, 0b111], // 0
  [0b010, 0b110, 0b010, 0b010, 0b111], // 1
  [0b111, 0b001, 0b111, 0b100, 0b111], // 2
  [0b111, 0b001, 0b111, 0b001, 0b111], // 3
  [0b101, 0b101, 0b111, 0b001, 0b001], // 4
  [0b111, 0b100, 0b111, 0b001, 0b111], // 5
  [0b111, 0b100, 0b111, 0b101, 0b111], // 6
  [0b111, 0b001, 0b010, 0b010, 0b010], // 7
  [0b111, 0b101, 0b111, 0b101, 0b111], // 8
  [0b111, 0b101, 0b111, 0b001, 0b111], // 9
];

/** Draw a decimal number with the 3x5 font; `cell` is one bit's doc-px size. */
function drawNumber(r: Raster, n: number, x: number, y: number, cell: number, color: number): void {
  const digits = String(n);
  for (let i = 0; i < digits.length; i++) {
    const glyph = DIGITS[digits.charCodeAt(i) - 48];
    const gx = x + i * cell * 4;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (glyph[row] & (1 << (2 - col))) {
          fillRect(r, gx + col * cell, y + row * cell, cell, cell, color);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Page scenes (doc coordinates)
// ---------------------------------------------------------------------------

interface PageSpec {
  name: string;
  slug: string;
  w: number;
  h: number;
  bg: number;
  /** Finest bake scale (halved per level until the page fits one screen). */
  cap: number;
  draw: (r: Raster) => void;
}

// Page 0 — "Poster": 4096x2304. Content clusters left-center and center so
// the outer tiles stay background-solid; the flat slate panel spans exact
// level-0 tile boundaries to force LETTERED solid tiles at several levels.
const drawPoster = (r: Raster): void => {
  // concentric rings, left-center (the sim journey's pan-left destination)
  fillRing(r, 900, 1152, 390, 450, INK);
  fillRing(r, 900, 1152, 310, 370, INDIGO);
  fillRing(r, 900, 1152, 230, 290, AMBER);
  fillRing(r, 900, 1152, 150, 210, INK);
  fillRing(r, 900, 1152, 70, 130, TEAL);
  fillRing(r, 900, 1152, 0, 50, ROSE);

  // nested rounded rects, center
  fillRoundRect(r, 1600, 500, 900, 1100, 96, INK);
  fillRoundRect(r, 1640, 540, 820, 1020, 72, CARD);
  fillRoundRect(r, 1700, 600, 700, 400, 48, INDIGO);
  fillRoundRect(r, 1740, 640, 620, 320, 32, CARD);
  fillRoundRect(r, 1700, 1080, 320, 440, 48, TEAL);
  fillRoundRect(r, 2080, 1080, 320, 440, 48, AMBER);

  // numbered cell grid, right of center: 4x3 white cards with ink digits
  for (let cy = 0; cy < 3; cy++) {
    for (let cx = 0; cx < 4; cx++) {
      const n = cy * 4 + cx + 1;
      const x = 2600 + cx * 180;
      const y = 1240 + cy * 180;
      fillRect(r, x, y, 160, 160, INK);
      fillRect(r, x + 8, y + 8, 144, 144, CARD);
      drawNumber(r, n, x + (n < 10 ? 58 : 34), y + 40, 16, INK);
    }
  }

  // flat slate panel, top right — spans doc x [3072,4096) x y [0,1024), i.e.
  // whole 512-doc-px (level-0) tiles: uniform -> lettered solid tiles.
  fillRect(r, 3072, 0, 1024, 1024, PANEL);
  // a small white card ON the panel so the panel keeps textured tiles too —
  // kept inside doc y < 512 so the panel's LOWER tile row stays uniform
  // (that row is the lettered-solid coverage this demo exists to exercise)
  fillRoundRect(r, 3400, 300, 368, 180, 40, CARD);
  drawNumber(r, 60, 3480, 340, 20, INK);

  // stepped gradient bar along the bottom center (32 exact-color steps)
  fillRect(r, 1592, 1992, 2064, 176, INK);
  for (let i = 0; i < 32; i++) {
    fillRect(r, 1600 + i * 64, 2000, 64, 160, GRAD[i]);
  }
};

// Page 1 — "Counter Sheet": 2048x1536 on a dark ground, a coarser grid of
// numbered cards plus one flat teal block. Different bg + level count from
// page 0, so TRIANGLE/SQUARE switching exercises doc re-init and freeing.
const drawCells = (r: Raster): void => {
  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 3; cx++) {
      const n = cy * 3 + cx + 1;
      const x = 288 + cx * 400;
      const y = 288 + cy * 480;
      fillRoundRect(r, x, y, 336, 400, 40, CARD);
      fillRoundRect(r, x + 24, y + 24, 288, 288, 24, [INDIGO, AMBER, TEAL, ROSE, INDIGO, AMBER][n - 1]);
      drawNumber(r, n, x + 140, y + 328, 12, INK);
    }
  }
  // flat teal block spanning exact level-0 tiles: doc x [1536,2048) y [0,512)
  fillRect(r, 1536, 0, 512, 512, TEAL);
};

const PAGES: PageSpec[] = [
  { name: "Poster", slug: "poster", w: 4096, h: 2304, bg: BG, cap: 0.5, draw: drawPoster },
  { name: "Counter Sheet", slug: "cells", w: 2048, h: 1536, bg: DARK_BG, cap: 0.5, draw: drawCells },
];

// ---------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------

const SOLID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

interface LevelBake {
  scale: number;
  cols: number;
  rows: number;
  key: string;
  file: string;
  grid: string[];
  solids: number[];
  bytes: number;
  textured: number;
  solid: number;
}

interface BakedPage {
  name: string;
  w: number;
  h: number;
  bg: number;
  levels: LevelBake[];
}

const tilesDir = HERE + "tiles/";
mkdirSync(tilesDir, { recursive: true });
for (const f of readdirSync(tilesDir)) {
  if (f.endsWith(".bin")) unlinkSync(tilesDir + f);
}

const baked: BakedPage[] = [];
let totalBytes = 0;

for (let p = 0; p < PAGES.length; p++) {
  const page = PAGES[p];

  // Shared page palette: index 0 = bg, then every ink color in a fixed order.
  const paletteList = [page.bg, INK, INDIGO, AMBER, TEAL, ROSE, PANEL, CARD, DARK_BG, BG, ...GRAD]
    .filter((c, i, a) => a.indexOf(c) === i); // dedupe, order-stable
  const palette = new Uint32Array(256).fill(page.bg >>> 0);
  const index = new Map<number, number>();
  for (let i = 0; i < paletteList.length; i++) {
    palette[i] = paletteList[i] >>> 0;
    index.set(paletteList[i] >>> 0, i);
  }

  const scales: number[] = [page.cap];
  while (page.w * scales[scales.length - 1] > SCREEN_W || page.h * scales[scales.length - 1] > SCREEN_H) {
    scales.push(scales[scales.length - 1] / 2);
  }
  console.log(`page ${p} ${JSON.stringify(page.name)}: ${page.w}x${page.h}, cap ${page.cap}, ${scales.length} level(s)`);

  const levels: LevelBake[] = [];
  for (let l = 0; l < scales.length; l++) {
    const scale = scales[l];
    const cols = Math.ceil((page.w * scale) / TILE);
    const rows = Math.ceil((page.h * scale) / TILE);

    // Rasterize the whole level in one buffer (largest is 2048x1280 u32 =
    // 10 MB — fine for a build step), padded to the tile grid with bg.
    const r: Raster = { w: cols * TILE, h: rows * TILE, px: new Uint32Array(cols * TILE * rows * TILE), s: scale };
    r.px.fill(page.bg >>> 0);
    // Content beyond the doc rect stays bg (the grid covers [0,w]x[0,h] only
    // up to tile granularity; DeepZoom clamps the view to the doc rect).
    page.draw(r);

    const tiles: TilesetTile[] = [];
    const grid: string[] = [];
    const solids: number[] = [];
    const solidChar = new Map<number, string>(); // palette index -> grid char
    const texturedIdx: number[] = [];
    let sampleTile: { index: number; indices: Uint8Array } | null = null;

    for (let ty = 0; ty < rows; ty++) {
      let rowChars = "";
      for (let tx = 0; tx < cols; tx++) {
        const base = ty * TILE * r.w + tx * TILE;
        const first = r.px[base];
        let uniform = true;
        for (let y = 0; y < TILE && uniform; y++) {
          const rowBase = base + y * r.w;
          for (let x = 0; x < TILE; x++) {
            if (r.px[rowBase + x] !== first) {
              uniform = false;
              break;
            }
          }
        }
        if (uniform) {
          const idx = index.get(first);
          if (idx === undefined) throw new Error(`bake: unknown color ${first.toString(16)}`);
          tiles.push({ kind: "solid", paletteIndex: idx });
          if (idx === 0) {
            rowChars += ".";
          } else {
            let ch = solidChar.get(idx);
            if (ch === undefined) {
              ch = SOLID_CHARS[solidChar.size];
              solidChar.set(idx, ch);
              solids.push(palette[idx]);
            }
            rowChars += ch;
          }
        } else {
          const indices = new Uint8Array(TILE * TILE);
          for (let y = 0; y < TILE; y++) {
            const rowBase = base + y * r.w;
            for (let x = 0; x < TILE; x++) {
              const idx = index.get(r.px[rowBase + x]);
              if (idx === undefined) throw new Error(`bake: unknown color ${r.px[rowBase + x].toString(16)}`);
              indices[y * TILE + x] = idx;
            }
          }
          tiles.push({ kind: "pixels", indices });
          texturedIdx.push(tiles.length - 1);
          rowChars += "#";
        }
      }
      grid.push(rowChars);
    }

    // Deterministic self-check sample: the middle textured tile of the level.
    if (texturedIdx.length > 0) {
      const idx = texturedIdx[Math.floor(texturedIdx.length / 2)];
      const t = tiles[idx];
      if (t.kind === "pixels") sampleTile = { index: idx, indices: t.indices.slice() };
    }

    const blob = encodeTilesetEntry({
      tileW: TILE,
      tileH: TILE,
      cols,
      rows,
      flags: TILESET_FLAG_RLE | TILESET_FLAG_LINEAR,
      palette,
      tiles,
    });
    selfCheck(blob, cols, rows, sampleTile);

    const file = `tiles/${page.slug}.${l}.bin`;
    await Bun.write(HERE + file, blob);
    totalBytes += blob.length;
    levels.push({
      scale,
      cols,
      rows,
      key: keyTileset(`zoom.${p}.${l}`),
      file,
      grid,
      solids,
      bytes: blob.length,
      textured: texturedIdx.length,
      solid: cols * rows - texturedIdx.length,
    });
    console.log(
      `  level ${l}: scale ${scale}, ${cols}x${rows} = ${cols * rows} tiles ` +
        `(${texturedIdx.length} textured, ${cols * rows - texturedIdx.length} solid), ${(blob.length / 1024).toFixed(1)} KB`,
    );
  }
  baked.push({ name: page.name, w: page.w, h: page.h, bg: page.bg, levels });
}

// ---------------------------------------------------------------------------
// Self-check: the blob must round-trip through the spec decoder
// ---------------------------------------------------------------------------

function selfCheck(blob: Uint8Array, cols: number, rows: number, sample: { index: number; indices: Uint8Array } | null): void {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (dv.getUint32(0, true) !== TILESET_MAGIC) throw new Error("self-check: bad magic");
  if (dv.getUint16(4, true) !== TILESET_VERSION) throw new Error("self-check: bad version");
  if (dv.getUint16(12, true) !== cols || dv.getUint16(14, true) !== rows) throw new Error("self-check: bad grid");
  if (!sample) return; // all-solid level (the tiny overviews can be)
  const dirOff = dv.getUint32(20, true);
  const dataOff = dv.getUint32(24, true);
  const e = dirOff + sample.index * TILESET_DIR_ENTRY_SIZE;
  const off = dv.getUint32(e, true);
  const len = dv.getUint32(e + 4, true);
  if (len === 0) throw new Error(`self-check: tile ${sample.index} should be a pixel stream`);
  const decoded = packbitsDecode(blob.subarray(dataOff + off, dataOff + off + len), TILE * TILE);
  if (!decoded || decoded.length !== TILE * TILE) throw new Error(`self-check: tile ${sample.index} failed to decode`);
  for (let i = 0; i < decoded.length; i++) {
    if (decoded[i] !== sample.indices[i]) throw new Error(`self-check: tile ${sample.index} mismatch at index ${i}`);
  }
}

// ---------------------------------------------------------------------------
// pak.json — spliced into dist/<app>.pak by tools/build.ts
// ---------------------------------------------------------------------------

const pakEntries = baked
  .flatMap((pg) => pg.levels.map((l) => ({ key: l.key, file: l.file })))
  .sort((a, b) => (a.key < b.key ? -1 : 1));
await Bun.write(HERE + "pak.json", JSON.stringify(pakEntries, null, 2) + "\n");

// ---------------------------------------------------------------------------
// tiles.ts — the manifest the viewer reads (no binary parsing at runtime)
// ---------------------------------------------------------------------------

const hex = (n: number): string => "0x" + (n >>> 0).toString(16).padStart(8, "0");
let ts = `// AUTO-GENERATED by apps/zoomlab/gen-assets.ts (bun apps/zoomlab/gen-assets.ts).
// Deep-zoom tile manifest for the synthetic zoomlab pages. The viewer
// positions and streams tiles from THIS data alone — solid tiles never touch
// the tileset blobs (they draw as plain background/solids[] colored rects),
// only '#' tiles go through the loadTileTexture op. Plain .ts (not
// *.generated.ts) so the build's pass-1 scanner walks it.

export const TILE = ${TILE};

export interface ZoomLevel {
  /** doc-px -> level-px scale; level pixel = docCoord * scale */
  scale: number;
  cols: number;
  rows: number;
  /** pak key of this level's TILESET entry (tile index = row * cols + col) */
  key: string;
  /**
   * Row-major tile map, one string per row, one char per tile:
   *   '.'                 solid tile of the page background color (bg)
   *   '#'                 textured tile — stream it via loadTileTexture
   *   'a'..'z' 'A'..'Z'   solid tile of color solids[i], i = a:0 .. z:25, A:26 .. Z:51
   */
  grid: string[];
  /** ABGR colors for the lettered solid tiles above. */
  solids: number[];
}

export interface ZoomPage {
  name: string;
  /** content size in doc px */
  w: number;
  h: number;
  /** page background, ABGR u32 */
  bg: number;
  levels: ZoomLevel[];
}

export const PAGES: ZoomPage[] = [
`;
for (const pg of baked) {
  ts += `  {\n`;
  ts += `    name: ${JSON.stringify(pg.name)},\n`;
  ts += `    w: ${pg.w}, h: ${pg.h}, bg: ${hex(pg.bg)},\n`;
  ts += `    levels: [\n`;
  for (const l of pg.levels) {
    ts += `      {\n`;
    ts += `        scale: ${l.scale}, cols: ${l.cols}, rows: ${l.rows}, key: ${JSON.stringify(l.key)},\n`;
    ts += `        solids: [${l.solids.map(hex).join(", ")}],\n`;
    ts += `        grid: [\n`;
    for (const row of l.grid) ts += `          ${JSON.stringify(row)},\n`;
    ts += `        ],\n`;
    ts += `      },\n`;
  }
  ts += `    ],\n`;
  ts += `  },\n`;
}
ts += `];\n`;
await Bun.write(HERE + "tiles.ts", ts);

// ---------------------------------------------------------------------------
// Size report
// ---------------------------------------------------------------------------

console.log("\nsize report:");
for (const pg of baked) {
  const total = pg.levels.reduce((n, l) => n + l.bytes, 0);
  console.log(`  ${pg.name.padEnd(16)} ${(total / 1024).toFixed(1).padStart(8)} KB`);
}
console.log(`  TOTAL ${(totalBytes / 1024).toFixed(1)} KB (budget ${(BUDGET / 1024).toFixed(0)} KB)`);
if (totalBytes > BUDGET) {
  console.error("gen-assets: OVER BUDGET — shrink the scene or lower a cap and re-run");
  process.exit(1);
}
console.log(`gen-assets: wrote ${pakEntries.length} tileset(s), pak.json, tiles.ts`);
