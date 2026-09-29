// apps/sortie/gen-assets.ts — bakes the MV's artwork into committed PNGs.
//
//   bun apps/sortie/gen-assets.ts          # rewrites apps/sortie/*.png
//
// Two kinds of art, one script, no runtime dependencies:
//
//   1. Title cards and countdown numerals. Glyph outlines are read out of Zen
//      Old Mincho Black (SIL OFL 1.1, ./ATTRIBUTION.md) with opentype.js and
//      assembled into ONE flattened path per card. The typeface is NOT part of
//      the repository: this script downloads it into .pocket-build/ (ignored),
//      checks it against a pinned SHA-256, and commits only the outlines the
//      MV spells. Text above 54 px cannot come from a baked font atlas
//      (framework/compiler/tailwind.ts pins the slot table at 12..54 px), so a
//      full-bleed 112 px title has to be artwork.
//   2. Geometry — the octagon ring, the hazard stripes and the measurement grid
//      — computed from their vertices here instead of being drawn by hand.
//
// Both go through the repo's own SVG rasterizer (framework/compiler/bake-svg.ts,
// 4x supersampled) and land as straight-alpha RGBA PNGs. The PNG is what ships:
// a mincho card is a few hundred contours, and rasterizing those costs about
// ten seconds each — a cost paid HERE when the art changes, not on every
// `tools/build.ts sortie-main`.
//
// Every output is pow2-sized (framework/compiler/pak.ts: texture dims must be
// pow2 and <= 512) and drawn at 1:1 texel scale by ./app.tsx, so no card is
// ever resampled. A 512 px card on the 480 px screen overhangs 16 px per side.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype, { type Font, type Path } from "opentype.js";
import { bakeSvg } from "../../framework/compiler/bake-svg.ts";
import { encodePNG } from "../../tools/png.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../");
const CACHE = join(ROOT, ".pocket-build/sortie-fonts/");

// Zen Old Mincho Black — a heavy mincho: thin horizontals, slab-heavy verticals,
// flared terminals. The register the cards are cut in.
const FONT_URL =
  "https://raw.githubusercontent.com/google/fonts/main/ofl/zenoldmincho/ZenOldMincho-Black.ttf";
const FONT_FILE = "ZenOldMincho-Black.ttf";
const FONT_SHA256 = "84a80d8bca79d7d9478935045b216ed003ad40fdea5fd9116d524eb26e872cdc";

/** Paper white — the cards are ink on black, not pure #fff. */
const INK = "#f2f0e6";
const INK_DARK = "#0b0b0d";
const HAZARD = "#e8c31a";
/** The field ring is the one graphic that is always red. */
const FIELD = "#d8232a";

interface Card {
  file: string;
  text: string;
  /** Canvas size in px (pow2, <= 512). */
  w: number;
  h: number;
  /** Fraction of the canvas the ink may fill. */
  fitW?: number;
  fitH?: number;
  /** Extra space between glyphs, as a fraction of the glyph size. */
  tracking?: number;
  fill?: string;
}

// The cut list, in screen order. Japanese carries the title cards; every
// readout in ./app.tsx stays Latin, so nothing here duplicates live text.
const CARDS: Card[] = [
  // Countdown numerals — 参 弐 壱 零, the old forms, one glyph per card.
  { file: "count-3.png", text: "参", w: 256, h: 256, fitW: 0.62, fitH: 0.62 },
  { file: "count-2.png", text: "弐", w: 256, h: 256, fitW: 0.62, fitH: 0.62 },
  { file: "count-1.png", text: "壱", w: 256, h: 256, fitW: 0.62, fitH: 0.62 },
  { file: "count-0.png", text: "零", w: 256, h: 256, fitW: 0.62, fitH: 0.62 },
  // Title cards. 512x128 full-bleed, drawn at left-[-16].
  { file: "title-boot.png", text: "起動", w: 512, h: 128, tracking: 0.18 },
  { file: "title-nodom.png", text: "ＤＯＭ、不在", w: 512, h: 128 },
  { file: "title-core.png", text: "錆の核心", w: 512, h: 128, tracking: 0.08 },
  { file: "title-thread.png", text: "一糸、一過程", w: 512, h: 128 },
  { file: "title-sync.png", text: "同期率、六十", w: 512, h: 128 },
  { file: "title-launch.png", text: "全機、発進", w: 512, h: 128, tracking: 0.04 },
  { file: "title-end.png", text: "つづく", w: 512, h: 128, tracking: 0.16 },
  // The one card cut in red: the alert beat before the fleet launches.
  { file: "title-alert.png", text: "警告", w: 512, h: 128, tracking: 0.18, fill: "#d8232a" },
];

// ---------------------------------------------------------------------------
// Font source
// ---------------------------------------------------------------------------

async function loadFont(): Promise<Font> {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, FONT_FILE);
  if (!existsSync(path)) {
    console.log(`sortie: downloading ${FONT_FILE} -> ${path.slice(ROOT.length)}`);
    const response = await fetch(FONT_URL);
    if (!response.ok) throw new Error(`sortie: font download failed (HTTP ${response.status})`);
    await Bun.write(path, await response.arrayBuffer());
  }
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  console.log(`sortie: ${FONT_FILE} ${bytes.length} bytes sha256=${digest}`);
  if (FONT_SHA256 !== digest) {
    throw new Error(
      `sortie: ${FONT_FILE} sha256 ${digest} does not match the pinned ${FONT_SHA256}. ` +
        `Upstream changed the file: verify it, then update FONT_SHA256.`,
    );
  }
  return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

// ---------------------------------------------------------------------------
// Outlines -> one <path> per card
// ---------------------------------------------------------------------------

type Cmd = Path["commands"][number];

/** Ink bounds of `commands` (curve control points included — a safe cover). */
function bounds(commands: Cmd[]): { x1: number; y1: number; x2: number; y2: number } {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const see = (x: number, y: number) => {
    if (x < x1) x1 = x;
    if (y < y1) y1 = y;
    if (x > x2) x2 = x;
    if (y > y2) y2 = y;
  };
  for (const c of commands) {
    if (c.type === "Z") continue;
    see(c.x, c.y);
    if (c.type === "Q" || c.type === "C") see(c.x1, c.y1);
    if (c.type === "C") see(c.x2, c.y2);
  }
  return { x1, y1, x2, y2 };
}

/** Map every coordinate through scale-then-translate, at 1-decimal precision. */
function pathData(commands: Cmd[], k: number, dx: number, dy: number): string {
  const n = (v: number, offset: number): string => {
    const out = Math.round((v * k + offset) * 10) / 10;
    return Object.is(out, -0) ? "0" : String(out);
  };
  const x = (v: number) => n(v, dx);
  const y = (v: number) => n(v, dy);
  const out: string[] = [];
  for (const c of commands) {
    if (c.type === "M") out.push(`M${x(c.x)} ${y(c.y)}`);
    else if (c.type === "L") out.push(`L${x(c.x)} ${y(c.y)}`);
    else if (c.type === "Q") out.push(`Q${x(c.x1)} ${y(c.y1)} ${x(c.x)} ${y(c.y)}`);
    else if (c.type === "C")
      out.push(`C${x(c.x1)} ${y(c.y1)} ${x(c.x2)} ${y(c.y2)} ${x(c.x)} ${y(c.y)}`);
    else out.push("Z");
  }
  return out.join("");
}

/**
 * One card: lay the run out at a nominal size, then scale the whole outline so
 * the ink fills the canvas to `fitW`/`fitH` and centers on both axes. Centering
 * on ink (not on the advance box) is what keeps a card with an ideographic
 * comma — 「ＤＯＭ、不在」 — optically centered.
 */
function card(font: Font, c: Card): string {
  const NOMINAL = 200;
  const tracking = (c.tracking ?? 0) * NOMINAL;
  const commands: Cmd[] = [];
  let pen = 0;
  for (const ch of c.text) {
    const glyph = font.charToGlyph(ch);
    if (glyph.index === 0) throw new Error(`sortie: ${FONT_FILE} has no glyph for "${ch}"`);
    const path = glyph.getPath(pen, 0, NOMINAL);
    commands.push(...path.commands);
    pen += (glyph.advanceWidth ?? font.unitsPerEm) * (NOMINAL / font.unitsPerEm) + tracking;
  }
  const ink = bounds(commands);
  const k = Math.min(
    (c.w * (c.fitW ?? 0.84)) / (ink.x2 - ink.x1),
    (c.h * (c.fitH ?? 0.8)) / (ink.y2 - ink.y1),
  );
  const dx = (c.w - (ink.x2 - ink.x1) * k) / 2 - ink.x1 * k;
  const dy = (c.h - (ink.y2 - ink.y1) * k) / 2 - ink.y1 * k;
  const d = pathData(commands, k, dx, dy);
  return svg(c.w, c.h, `<path d="${d}" fill="${c.fill ?? INK}"/>`);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function svg(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${body}\n</svg>\n`;
}

/** A regular octagon's vertices, flat-top, inscribed in a radius-`r` circle. */
function octagon(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i + Math.PI / 8;
    const x = Math.round((cx + r * Math.cos(a)) * 10) / 10;
    const y = Math.round((cy + r * Math.sin(a)) * 10) / 10;
    pts.push(`${i === 0 ? "M" : "L"}${x} ${y}`);
  }
  return pts.join("") + "Z";
}

/**
 * The field ring: an octagon with a smaller octagon subtracted. `fill="hole"`
 * is bake-svg's alpha-subtract, so the ring is one texture with a genuinely
 * transparent middle — scale it up and the ring expands over what is behind it.
 */
function fieldRing(): string {
  const size = 256;
  const c = size / 2;
  return svg(
    size,
    size,
    `<path d="${octagon(c, c, 127)}" fill="${FIELD}"/>\n` +
      `<path d="${octagon(c, c, 124)}" fill="hole"/>\n` +
      `<path d="${octagon(c, c, 104)}" fill="${FIELD}"/>\n` +
      `<path d="${octagon(c, c, 102)}" fill="hole"/>\n` +
      `<path d="${octagon(c, c, 66)}" fill="${FIELD}"/>\n` +
      `<path d="${octagon(c, c, 64)}" fill="hole"/>`,
  );
}

/** 45° hazard stripes on a 256x64 tile: parallelograms, no strokes. */
function hazard(): string {
  const w = 256;
  const h = 64;
  const period = 32;
  const bars: string[] = [`<rect x="0" y="0" width="${w}" height="${h}" fill="${INK_DARK}"/>`];
  for (let x = -h; x < w + h; x += period) {
    const d =
      `M${x} ${h}L${x + h} 0L${x + h + period / 2} 0L${x + period / 2} ${h}Z`;
    bars.push(`<path d="${d}" fill="${HAZARD}"/>`);
  }
  return svg(w, h, bars.join("\n"));
}

/**
 * The measurement grid behind the core diagram: a 512x256 field of hairlines,
 * one every 16 px, with heavier rules every 64. Baked instead of built from
 * Views so a full-screen grid costs one node.
 */
function grid(): string {
  const w = 512;
  const h = 256;
  const rects: string[] = [];
  for (let x = 0; x <= w; x += 16) {
    const heavy = x % 64 === 0;
    rects.push(
      `<rect x="${x}" y="0" width="1" height="${h}" fill="${heavy ? "#2c3440" : "#171b22"}"/>`,
    );
  }
  for (let y = 0; y <= h; y += 16) {
    const heavy = y % 64 === 0;
    rects.push(
      `<rect x="0" y="${y}" width="${w}" height="1" fill="${heavy ? "#2c3440" : "#171b22"}"/>`,
    );
  }
  return svg(w, h, rects.join("\n"));
}

// ---------------------------------------------------------------------------

async function write(file: string, source: string): Promise<number> {
  const image = bakeSvg(source);
  const png = encodePNG(image.rgba, image.width, image.height);
  await Bun.write(join(HERE, file), png);
  console.log(`sortie: ${file} ${image.width}x${image.height} ${(png.length / 1024).toFixed(1)} KiB`);
  return png.length;
}

const font = await loadFont();
let bytes = 0;
for (const c of CARDS) bytes += await write(c.file, card(font, c));
bytes += await write("at-field.png", fieldRing());
bytes += await write("hazard.png", hazard());
bytes += await write("grid.png", grid());
console.log(`sortie: ${CARDS.length + 3} assets, ${(bytes / 1024).toFixed(1)} KiB total`);
