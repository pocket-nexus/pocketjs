// tools/pocket3d-icon.ts — bake the app icon of a Pocket3D game.
//
//   bun tools/pocket3d-icon.ts            write the icons
//   bun tools/pocket3d-icon.ts --check    fail when a committed icon is not this drawing
//   bun tools/pocket3d-icon.ts --preview  also write a contact sheet to .pocket-build/pocket3d-icon/
//
// site/pocket3d/mark.svg is the drawing. Each console's launcher shows the mark
// on the plum ground of the title card, in the size and the file form that
// launcher reads:
//
//   engine/pocket3d/icon/psp/ICON0.PNG        144 x 80    XMB
//   engine/pocket3d/icon/vita/icon0.png       128 x 128   LiveArea bubble, 8-bit indexed
//   engine/pocket3d/icon/3ds/icon.png          48 x 48    Homebrew Launcher, SMDH large
//   engine/pocket3d/icon/3ds/icon-small.png    24 x 24    SMDH small
//   engine/pocket3d/icon/ios/Icon.png          57 x 57    SpringBoard, iPod touch 4
//   engine/pocket3d/icon/ios/Icon@2x.png      114 x 114   SpringBoard, Retina
//   engine/pocket3d/icon/android/mdpi.png      48 x 48    Android launcher, 160 dpi
//   engine/pocket3d/icon/android/hdpi.png      72 x 72    Android launcher, 240 dpi
//   engine/pocket3d/icon/android/xhdpi.png     96 x 96    Android launcher, 320 dpi
//   engine/pocket3d/icon/android/xxhdpi.png   144 x 144   Android launcher, 480 dpi
//
// The rasterizer is the one tools/device-icons.ts uses, so the command needs
// no browser and no network. The outputs are committed: a game's build reads
// them through POCKET3D_ICON or by path. Importing this module for the paths
// loads no rasterizer and names none in its types; `bake` loads it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { medianCut } from "./median-cut.ts";
import { decodePNG, encodeIndexedPNG, encodePNG } from "./png.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const MARK = `${ROOT}site/pocket3d/mark.svg`;
const OUT = `${ROOT}engine/pocket3d/icon/`;
/** The ground of the title card: the icon and the card that follows it share it. */
export const GROUND = [0x17, 0x12, 0x26] as const;

/** Where each console's build takes the icon. */
export const POCKET3D_ICON = {
  psp: `${OUT}psp/ICON0.PNG`,
  vita: `${OUT}vita/icon0.png`,
  n3ds: `${OUT}3ds/icon.png`,
  n3dsSmall: `${OUT}3ds/icon-small.png`,
  ios: `${OUT}ios/Icon.png`,
  ios2x: `${OUT}ios/Icon@2x.png`,
  androidMdpi: `${OUT}android/mdpi.png`,
  androidHdpi: `${OUT}android/hdpi.png`,
  androidXhdpi: `${OUT}android/xhdpi.png`,
  androidXxhdpi: `${OUT}android/xxhdpi.png`,
} as const;

/** The Android files by the density qualifier of the resource directory each goes into (`res/drawable-<density>/`). */
export const POCKET3D_ICON_ANDROID = {
  mdpi: POCKET3D_ICON.androidMdpi,
  hdpi: POCKET3D_ICON.androidHdpi,
  xhdpi: POCKET3D_ICON.androidXhdpi,
  xxhdpi: POCKET3D_ICON.androidXxhdpi,
} as const;

type Icon = {
  file: string;
  width: number;
  height: number;
  /** The mark's longer side, as a share of the icon's shorter side. */
  fit: number;
  /** PS Vita: at most 256 colours, stored as palette indices. */
  indexed?: boolean;
};

// A launcher that masks the icon (the Vita's round bubble, SpringBoard's
// rounded square, an Android launcher that cuts every icon to its own shape)
// gets a smaller mark; one that shows the whole rectangle (XMB, Homebrew
// Launcher) gets a larger one. The 24-pixel icon is drawn
// larger again so the lens and the keys keep a pixel each.
export const ICONS: readonly Icon[] = [
  { file: POCKET3D_ICON.psp, width: 144, height: 80, fit: 0.86 },
  { file: POCKET3D_ICON.vita, width: 128, height: 128, fit: 0.7, indexed: true },
  { file: POCKET3D_ICON.n3ds, width: 48, height: 48, fit: 0.86 },
  { file: POCKET3D_ICON.n3dsSmall, width: 24, height: 24, fit: 0.92 },
  { file: POCKET3D_ICON.ios, width: 57, height: 57, fit: 0.76 },
  { file: POCKET3D_ICON.ios2x, width: 114, height: 114, fit: 0.76 },
  { file: POCKET3D_ICON.androidMdpi, width: 48, height: 48, fit: 0.76 },
  { file: POCKET3D_ICON.androidHdpi, width: 72, height: 72, fit: 0.76 },
  { file: POCKET3D_ICON.androidXhdpi, width: 96, height: 96, fit: 0.76 },
  { file: POCKET3D_ICON.androidXxhdpi, width: 144, height: 144, fit: 0.76 },
];

/** The mark's own drawing: its view box and what is inside the <svg> element. */
function mark(): { box: [number, number, number, number]; body: string } {
  const svg = readFileSync(MARK, "utf8");
  const open = svg.match(/<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>/);
  if (!open) throw new Error("site/pocket3d/mark.svg has no viewBox");
  const box = open[1].trim().split(/\s+/).map(Number) as [number, number, number, number];
  const body = svg.slice(svg.indexOf(open[0]) + open[0].length, svg.lastIndexOf("</svg>"));
  return { box, body };
}

/** The part of the view box the mark covers, measured from a raster of it. */
async function extent(rasterizeIconSvg: Rasterize, box: [number, number, number, number], body: string): Promise<[number, number, number, number]> {
  const size = 256;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${box.join(" ")}">${body}</svg>`;
  const canvas = await rasterizeIconSvg(svg, size, size, false);
  const pixels = canvas.getContext("2d").getImageData(0, 0, size, size).data;
  let left = size, top = size, right = -1, bottom = -1;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (pixels[(y * size + x) * 4 + 3] < 8) continue;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  if (right < 0) throw new Error("site/pocket3d/mark.svg draws nothing");
  const unit = box[2] / size;
  return [box[0] + left * unit, box[1] + top * unit, (right + 1 - left) * unit, (bottom + 1 - top) * unit];
}

/** One icon as RGBA: the ground, and the mark centred on it. */
async function draw(rasterizeIconSvg: Rasterize, icon: Icon, box: [number, number, number, number], body: string, covered: [number, number, number, number]): Promise<Uint8Array> {
  const scale = (Math.min(icon.width, icon.height) * icon.fit) / Math.max(covered[2], covered[3]);
  // place the view box so the covered part sits in the middle of the icon
  const x = icon.width / 2 - (covered[0] + covered[2] / 2 - box[0]) * scale;
  const y = icon.height / 2 - (covered[1] + covered[3] / 2 - box[1]) * scale;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${icon.width}" height="${icon.height}" viewBox="0 0 ${icon.width} ${icon.height}">` +
    `<rect width="${icon.width}" height="${icon.height}" fill="rgb(${GROUND.join(",")})"/>` +
    `<svg x="${x.toFixed(4)}" y="${y.toFixed(4)}" width="${(box[2] * scale).toFixed(4)}" height="${(box[3] * scale).toFixed(4)}" viewBox="${box.join(" ")}">${body}</svg></svg>`;
  const canvas = await rasterizeIconSvg(svg, icon.width, icon.height);
  return new Uint8Array(canvas.getContext("2d").getImageData(0, 0, icon.width, icon.height).data);
}

/** Reduce RGBA to palette indices. Entry 0 is the ground, kept exact. */
function index(rgba: Uint8Array, width: number, height: number): { indices: Uint8Array; palette: Uint8Array } {
  const key = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
  const ground = key(GROUND[0], GROUND[1], GROUND[2]);
  const counts = new Map<number, number>();
  for (let i = 0; i < width * height; i++) {
    const k = key(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  counts.delete(ground);
  const colours = [...counts].map(([k, count]) => ({ r: k >> 16, g: (k >> 8) & 255, b: k & 255, count }));
  const entries: number[] = [...GROUND];
  const slot = new Map<number, number>([[ground, 0]]);
  for (const box of medianCut(colours, 255)) {
    const total = box.reduce((sum, colour) => sum + colour.count, 0);
    for (const c of ["r", "g", "b"] as const) entries.push(Math.round(box.reduce((sum, colour) => sum + colour[c] * colour.count, 0) / total));
    for (const colour of box) slot.set(key(colour.r, colour.g, colour.b), entries.length / 3 - 1);
  }
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) indices[i] = slot.get(key(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]))!;
  return { indices, palette: Uint8Array.from(entries) };
}

// tools/icon-raster.ts's rasterizer, typed here and loaded by path: a game
// that imports this module for POCKET3D_ICON type-checks without the
// rasterizer's package (@napi-rs/canvas) installed.
type Raster = { getContext(kind: "2d"): { getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray } } };
type Rasterize = (svg: string, width: number, height?: number, requireOpaque?: boolean) => Promise<Raster>;
const RASTERIZER: string = new URL("./icon-raster.ts", import.meta.url).pathname;

/** Every icon as the bytes of its file and the RGBA those bytes decode to. */
export async function bake(): Promise<{ icon: Icon; png: Buffer; rgba: Uint8Array }[]> {
  const { rasterizeIconSvg } = (await import(RASTERIZER)) as { rasterizeIconSvg: Rasterize };
  const { box, body } = mark();
  const covered = await extent(rasterizeIconSvg, box, body);
  const baked = [];
  for (const icon of ICONS) {
    const rgba = await draw(rasterizeIconSvg, icon, box, body, covered);
    if (icon.indexed) {
      const { indices, palette } = index(rgba, icon.width, icon.height);
      const png = encodeIndexedPNG(indices, palette, icon.width, icon.height);
      baked.push({ icon, png, rgba: decodePNG(png).rgba });
    } else baked.push({ icon, png: encodePNG(rgba, icon.width, icon.height), rgba });
  }
  return baked;
}

/** How far a committed icon is from the drawing: mean and largest channel difference. */
export function distance(a: Uint8Array, b: Uint8Array): { mean: number; max: number } {
  if (a.length !== b.length) return { mean: 255, max: 255 };
  let sum = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
  }
  return { mean: sum / a.length, max };
}

if (import.meta.main) {
  const check = process.argv.includes("--check"), preview = process.argv.includes("--preview");
  const baked = await bake();
  for (const { icon, png, rgba } of baked) {
    const name = icon.file.slice(ROOT.length);
    if (check) {
      const committed = decodePNG(readFileSync(icon.file));
      // A rasterizer on another machine may round an edge pixel differently;
      // another drawing or another placement moves whole shapes.
      const { mean, max } = committed.w === icon.width && committed.h === icon.height ? distance(committed.rgba, rgba) : { mean: 255, max: 255 };
      if (mean > 0.5 || max > 48) throw new Error(`${name} is stale (mean ${mean.toFixed(2)}, max ${max}); run bun tools/pocket3d-icon.ts`);
      console.log(`verified ${name} (${icon.width}x${icon.height})`);
    } else {
      mkdirSync(dirname(icon.file), { recursive: true });
      writeFileSync(icon.file, png);
      console.log(`wrote ${name} (${icon.width}x${icon.height}, ${png.length} bytes)`);
    }
  }
  if (preview) {
    // every icon at four times its size, on one sheet
    const zoom = 4, gap = 16;
    const width = baked.reduce((sum, b) => sum + b.icon.width * zoom + gap, gap);
    const height = Math.max(...baked.map((b) => b.icon.height * zoom)) + gap * 2;
    const sheet = new Uint8Array(width * height * 4).fill(255);
    for (let i = 0; i < width * height; i++) sheet.set([70, 70, 78, 255], i * 4);
    let at = gap;
    for (const { icon, rgba } of baked) {
      for (let y = 0; y < icon.height * zoom; y++) for (let x = 0; x < icon.width * zoom; x++) {
        const from = (Math.floor(y / zoom) * icon.width + Math.floor(x / zoom)) * 4;
        sheet.set(rgba.subarray(from, from + 4), ((y + gap) * width + at + x) * 4);
      }
      at += icon.width * zoom + gap;
    }
    const out = `${ROOT}.pocket-build/pocket3d-icon/`;
    mkdirSync(out, { recursive: true });
    writeFileSync(`${out}sheet.png`, encodePNG(sheet, width, height));
    console.log(`wrote .pocket-build/pocket3d-icon/sheet.png`);
  }
}
