// tools/psp-all.ts — package EVERY PocketJS demo into a PSP memory-stick
// layout, each with a distinct PARAM.SFO title and a procedurally rendered
// ICON0.PNG/PIC1.PNG (box art): a title's accent color is HASHED from its
// own text — no per-demo art asset, no manual box-art authoring. Declare a
// demo's display name once, in its own entry file, and this script does the
// rest.
//
//   bun tools/psp-all.ts [--release|-r]   # default: --release (memory
//                                            # stick builds should be small)
//
// Output: dist/psp/PSP/GAME/PocketJS-<demo>/EBOOT.PBP (one per
// apps/<demo>/main.tsx found). Copy dist/psp/PSP to a memory stick's root to install
// all of them at once. This script only writes under dist/ — it never
// touches a mounted memory stick itself.
//
// Metadata convention: a demo's mounting entry (apps/<name>/main.tsx)
// carries a `// @title <Display Name>` comment (matches the exact tag the
// main dreamcart repo's tools/build-psp-all.ts already uses for its own
// games — same convention, ported standalone since PocketJS stays independent
// of that framework per docs/DESIGN.md). No tag -> falls back to the bare demo
// name.
//
// Box art: hash(title) -> an HSL-derived gradient + a soft diagonal glow (the
// same "ambient streak" look cards.tsx animates, rendered here as a static
// analytic falloff) + real anti-aliased Inter typography — the SAME font
// family + outline pipeline framework/compiler/bake-font.ts uses for the on-device UI
// (opentype.js outlines, flattened to polylines, scanline-rasterized), just
// without that pipeline's 1-bit/cell constraints (this runs on the host at
// build time, not the PSP's real-time renderer, so full coverage-based AA is
// free). No per-demo art asset, no manual box-art authoring: a title's look
// is 100% a pure function of its text.

import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { parse as parseFont, type Font, type Path } from "opentype.js";
import { resolvePspBuildToolchain } from "./psp-toolchain.ts";

const pspUiDir = fileURLToPath(new URL("..", import.meta.url));
const demosDir = join(pspUiDir, "apps");
const outRoot = join(pspUiDir, "dist/psp");
const pspGameRoot = join(outRoot, "PSP/GAME");
const workRoot = join(outRoot, ".work");

const argv = Bun.argv.slice(2);
const release = !argv.includes("--debug"); // memory-stick packaging defaults to --release

const W = 480;
const H = 272;
const ICON_W = 144;
const ICON_H = 80;
const MAIN_SUFFIX = "-main.tsx";

// ---------------------------------------------------------------------------
// Demo discovery + metadata
// ---------------------------------------------------------------------------

function listDemos(): string[] {
  const names = new Set<string>();
  for (const f of readdirSync(demosDir)) {
    const path = join(demosDir, f);
    if (statSync(path).isDirectory() && existsSync(join(path, "main.tsx"))) names.add(f);
    else if (f.endsWith(MAIN_SUFFIX)) names.add(f.slice(0, -MAIN_SUFFIX.length));
  }
  return [...names]
    .sort();
}

function parseTitle(src: string): string | undefined {
  return src.match(/^\/\/\s*@title\s+(.+)$/m)?.[1].trim();
}

async function demoTitle(name: string): Promise<string> {
  const main = existsSync(join(demosDir, name, "main.tsx"))
    ? join(demosDir, name, "main.tsx")
    : join(demosDir, `${name}${MAIN_SUFFIX}`);
  const src = await Bun.file(main).text();
  return (parseTitle(src) ?? name).slice(0, 127);
}

function commandPath(name: string): string | null {
  const path = join(resolvePspBuildToolchain().cargoPspBin, name);
  return existsSync(path) ? path : null;
}

function folderName(name: string): string {
  return `PocketJS-${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

// ---------------------------------------------------------------------------
// Typography: opentype.js outlines -> flattened polylines -> supersampled
// scanline fill, same shape as framework/compiler/bake-font.ts's rasterizer but
// emitting CONTINUOUS coverage (this composites straight onto the box-art
// RGBA canvas, not into 1-bit atlas cells) [R].
// ---------------------------------------------------------------------------

const FONTS_DIR = join(pspUiDir, "assets/fonts");
// InterDisplay is Inter's large-size-optimized cut (tighter, more "designed"
// at the sizes box art titles render at); plain Inter for the small badge —
// the same two families the real on-device UI is baked from.
const TITLE_FONT = join(FONTS_DIR, "InterDisplay-Bold.ttf");
const BADGE_FONT = join(FONTS_DIR, "Inter-Regular.ttf");

const fontCache = new Map<string, Promise<Font>>();
function loadFont(path: string): Promise<Font> {
  let p = fontCache.get(path);
  if (!p) {
    p = Bun.file(path)
      .arrayBuffer()
      .then((buf) => parseFont(buf));
    fontCache.set(path, p);
  }
  return p;
}

type Pt = { x: number; y: number };
type Contour = Pt[];
const CURVE_STEPS = 10;

/** Flatten an opentype path (already positioned in absolute px space via
 *  glyph.getPath(x, y, fontSize)) into closed contours — verbatim copy of
 *  framework/compiler/bake-font.ts's flatten() (same Bezier subdivision). */
function flatten(path: Path): Contour[] {
  const contours: Contour[] = [];
  let cur: Contour = [];
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  const close = () => {
    if (cur.length > 1) contours.push(cur);
    cur = [];
  };
  for (const cmd of path.commands) {
    switch (cmd.type) {
      case "M":
        close();
        sx = cx = cmd.x;
        sy = cy = cmd.y;
        cur.push({ x: cx, y: cy });
        break;
      case "L":
        cx = cmd.x;
        cy = cmd.y;
        cur.push({ x: cx, y: cy });
        break;
      case "Q":
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS;
          const u = 1 - t;
          cur.push({
            x: u * u * cx + 2 * u * t * cmd.x1 + t * t * cmd.x,
            y: u * u * cy + 2 * u * t * cmd.y1 + t * t * cmd.y,
          });
        }
        cx = cmd.x;
        cy = cmd.y;
        break;
      case "C":
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS;
          const u = 1 - t;
          cur.push({
            x: u * u * u * cx + 3 * u * u * t * cmd.x1 + 3 * u * t * t * cmd.x2 + t * t * t * cmd.x,
            y: u * u * u * cy + 3 * u * u * t * cmd.y1 + 3 * u * t * t * cmd.y2 + t * t * t * cmd.y,
          });
        }
        cx = cmd.x;
        cy = cmd.y;
        break;
      case "Z":
        cur.push({ x: sx, y: sy });
        cx = sx;
        cy = sy;
        close();
        break;
    }
  }
  close();
  return contours;
}

function mix(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

type RGB = [number, number, number];

/** Supersampled coverage fill, composited straight onto the RGBA canvas at
 *  `alpha` (0..1) — the anti-aliased counterpart of bake-font.ts's 1-bit
 *  rasterize(), scoped to the glyph's own bounding box for speed. */
function compositeContours(buf: Uint8Array, w: number, h: number, contours: Contour[], color: RGB, alpha: number): void {
  if (contours.length === 0 || alpha <= 0) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of contours) {
    for (const p of c) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const x0 = Math.max(0, Math.floor(minX));
  const x1 = Math.min(w - 1, Math.ceil(maxX));
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(h - 1, Math.ceil(maxY));
  const bw = x1 - x0 + 1;
  if (bw <= 0 || y1 < y0) return;

  const SS = 4; // 4x4 supersample grid per pixel
  const counts = new Uint16Array(bw);
  const xs: number[] = [];
  for (let py = y0; py <= y1; py++) {
    counts.fill(0);
    for (let sub = 0; sub < SS; sub++) {
      const y = py + (sub + 0.5) / SS;
      xs.length = 0;
      for (const c of contours) {
        for (let i = 0; i < c.length - 1; i++) {
          const p0 = c[i];
          const p1 = c[i + 1];
          if ((p0.y <= y && p1.y > y) || (p1.y <= y && p0.y > y)) {
            xs.push(p0.x + ((y - p0.y) * (p1.x - p0.x)) / (p1.y - p0.y));
          }
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let s0 = Math.ceil((xs[k] - x0) * SS - 0.5);
        let s1 = Math.floor((xs[k + 1] - x0) * SS - 0.5);
        if (s0 < 0) s0 = 0;
        const maxS = bw * SS - 1;
        if (s1 > maxS) s1 = maxS;
        for (let s = s0; s <= s1; s++) {
          const center = x0 + (s + 0.5) / SS;
          if (center >= xs[k] && center < xs[k + 1]) counts[(s / SS) | 0]++;
        }
      }
    }
    for (let px = 0; px < bw; px++) {
      const cov = counts[px] / (SS * SS);
      if (cov <= 0) continue;
      const a = cov * alpha;
      const o = (py * w + (x0 + px)) * 4;
      buf[o] = mix(buf[o], color[0], a);
      buf[o + 1] = mix(buf[o + 1], color[1], a);
      buf[o + 2] = mix(buf[o + 2], color[2], a);
      buf[o + 3] = 255;
    }
  }
}

function textWidthPx(font: Font, text: string, px: number): number {
  const scale = px / font.unitsPerEm;
  let w = 0;
  for (const ch of text) w += (font.glyphs.get(font.charToGlyphIndex(ch)).advanceWidth ?? 0) * scale;
  return w;
}

/** Draw one line, left edge at x, baseline at y. Returns the pen's final x
 *  (unused here, kept for symmetry with textWidthPx). `tracking` adds fixed
 *  px between glyphs (small-caps badge wordmarks read better with a little
 *  air between letters). Draws a soft multi-sample shadow first when
 *  `shadowAlpha` > 0 — cheap blur: several 1px-offset low-alpha passes
 *  instead of a real kernel, good enough at these sizes. */
function drawLine(
  buf: Uint8Array,
  w: number,
  h: number,
  font: Font,
  text: string,
  x: number,
  y: number,
  px: number,
  color: RGB,
  opts: { alpha?: number; tracking?: number; shadowAlpha?: number; shadowColor?: RGB } = {},
): void {
  const alpha = opts.alpha ?? 1;
  const tracking = opts.tracking ?? 0;
  const shadowAlpha = opts.shadowAlpha ?? 0;
  const shadowColor = opts.shadowColor ?? [0, 0, 0];
  const scale = px / font.unitsPerEm;

  const glyphs: { path: Path; contours: Contour[] }[] = [];
  let penX = x;
  for (const ch of text) {
    const glyph = font.glyphs.get(font.charToGlyphIndex(ch));
    const path = glyph.getPath(penX, y, px);
    glyphs.push({ path, contours: flatten(path) });
    penX += (glyph.advanceWidth ?? 0) * scale + tracking;
  }

  if (shadowAlpha > 0) {
    // A symmetric ring (not just a downward drop-shadow) — reads as a soft
    // shadow behind dark shadowColor, or a legibility halo behind a light
    // one, without needing two separate code paths.
    const offsets: Pt[] = [
      { x: 0, y: 1.6 },
      { x: 1.4, y: 0.8 },
      { x: 1.4, y: -0.8 },
      { x: 0, y: -1.6 },
      { x: -1.4, y: -0.8 },
      { x: -1.4, y: 0.8 },
    ];
    for (const off of offsets) {
      for (const g of glyphs) {
        const shifted = g.contours.map((c) => c.map((p) => ({ x: p.x + off.x, y: p.y + off.y })));
        compositeContours(buf, w, h, shifted, shadowColor, shadowAlpha);
      }
    }
  }
  for (const g of glyphs) compositeContours(buf, w, h, g.contours, color, alpha);
}

function wrapByWidth(font: Font, text: string, px: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (textWidthPx(font, next, px) <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [text];
}

function hashText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** HSL -> RGB (h in [0,360), s/l in [0,1]) — a single hue family reads as
 *  "designed"; independently-randomized RGB channels (the old scheme) can
 *  land on muddy, uncoordinated combinations. */
function hsl(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** hash(title) -> a vivid, bright analogous pair (PSP-era box art / XMB
 *  chrome reads as saturated + glossy, never muted) plus a near-white
 *  specular tint for the glass-sheen highlight. Same title -> same palette,
 *  every time. */
/** Light-mode mesh: a near-white, softly hue-tinted base (calibrated against
 *  open-source design-system references like nexu-io/open-design's
 *  "gradient" system: bg #f7f3ff, or "vibrant": bg #fff8d7 — pale, not
 *  stark white) with TWO vivid, fully-saturated blooms (same pairing logic
 *  as "neon"'s primary/secondary: #BBF351 + #00BCFF-class contrast) —
 *  medium lightness, never washed toward pale, so they read as genuinely
 *  colorful pops against the light field rather than another dark glow. */
function paletteFor(title: string): { base: RGB; glowA: RGB; glowB: RGB; ink: RGB } {
  const hash = hashText(title);
  const hueA = hash % 360;
  const hueB = (hueA + 80 + ((hash >> 9) % 100)) % 360; // 80-180deg apart
  return {
    base: hsl(hueA, 0.4, 0.95),
    glowA: hsl(hueA, 0.88, 0.64),
    glowB: hsl(hueB, 0.88, 0.64),
    ink: hsl(hueA, 0.35, 0.16), // dark, hue-tinted text color (not flat black)
  };
}

/** hash(title) -> a light, softly-tinted base crossed by TWO vivid radial
 *  glows (a mesh-gradient pair, not one monochromatic spotlight) blooming
 *  from off-center points, each a genuinely different hue — plus real
 *  anti-aliased Inter typography in a dark ink color with a soft white
 *  legibility halo (no backing panel). Every step is a pure function of
 *  `title` — no per-demo art asset, no manual authoring.
 */
export async function renderBoxArt(title: string, w: number, h: number): Promise<Uint8Array> {
  const { base, glowA, glowB, ink } = paletteFor(title);
  const buf = new Uint8Array(w * h * 4);
  const hash = hashText(title);
  // Two off-center bloom points, kept apart (one upper-left-ish, one
  // lower-right-ish) so both colors stay individually readable.
  const axA = (0.08 + ((hash >> 3) % 40) / 100) * w; // 0.08..0.48 * w
  const ayA = (0.08 + ((hash >> 9) % 40) / 100) * h; // 0.08..0.48 * h
  const axB = (0.52 + ((hash >> 15) % 42) / 100) * w; // 0.52..0.94 * w
  const ayB = (0.5 + ((hash >> 21) % 44) / 100) * h; // 0.50..0.94 * h
  const radius = 0.4 * Math.hypot(w, h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dA = Math.hypot(x - axA, y - ayA) / radius;
      const dB = Math.hypot(x - axB, y - ayB) / radius;
      const bloomA = Math.exp(-dA * dA * 2.4);
      const bloomB = Math.exp(-dB * dB * 2.4);
      const total = bloomA + bloomB;
      const o = (y * w + x) * 4;
      if (total <= 0.001) {
        buf[o] = base[0];
        buf[o + 1] = base[1];
        buf[o + 2] = base[2];
      } else {
        const tb = bloomB / total; // 0 = pure glowA, 1 = pure glowB
        const glow: RGB = [mix(glowA[0], glowB[0], tb), mix(glowA[1], glowB[1], tb), mix(glowA[2], glowB[2], tb)];
        const coverage = Math.min(1, total);
        buf[o] = mix(base[0], glow[0], coverage);
        buf[o + 1] = mix(base[1], glow[1], coverage);
        buf[o + 2] = mix(base[2], glow[2], coverage);
      }
      buf[o + 3] = 255;
    }
  }

  const [titleFont, badgeFont] = await Promise.all([loadFont(TITLE_FONT), loadFont(BADGE_FONT)]);
  const margin = Math.max(8, Math.round(w * 0.06));

  const badgePx = Math.max(7, Math.round(h * 0.085));
  drawLine(buf, w, h, badgeFont, "PocketJS", margin, Math.round(h * 0.24), badgePx, ink, {
    alpha: 0.92,
    tracking: badgePx * 0.14,
    shadowAlpha: 0.55,
    shadowColor: [255, 255, 255],
  });

  // Drop the redundant "PocketJS:" lead-in from the big title — the badge
  // already establishes the brand.
  const displayTitle = title.replace(/^PocketJS:\s*/i, "");
  const titlePx = Math.max(11, Math.round(h * 0.155));
  const maxWidth = w - margin * 2;
  let lines = wrapByWidth(titleFont, displayTitle, titlePx, maxWidth);
  let px = titlePx;
  // Shrink (rather than truncate) if a tight icon size still overflows.
  while (lines.length > 3 && px > 8) {
    px -= 1;
    lines = wrapByWidth(titleFont, displayTitle, px, maxWidth);
  }
  const lineHeight = px * 1.16;
  const startY = h * 0.68 - ((lines.length - 1) * lineHeight) / 2;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineW = textWidthPx(titleFont, line, px);
    const x = Math.max(margin, (w - lineW) / 2);
    drawLine(buf, w, h, titleFont, line, x, startY + i * lineHeight, px, ink, {
      shadowAlpha: 0.6,
      shadowColor: [255, 255, 255],
    });
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Minimal deterministic PNG encoder (dreamcart/scripts/build-psp-all.ts copy)
// ---------------------------------------------------------------------------

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function encodePng(rgba: Uint8Array, w: number, h: number): Buffer {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// PBP repack: pull DATA.PSP/DATA.PSAR out of the plain cargo-psp EBOOT, drop
// in a generated PARAM.SFO + ICON0.PNG + PIC1.PNG, repack with pack-pbp.
// ---------------------------------------------------------------------------

async function extractPbpSection(pbpPath: string, section: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(await Bun.file(pbpPath).arrayBuffer());
  if (bytes.length < 40 || bytes[0] !== 0 || bytes[1] !== 0x50 || bytes[2] !== 0x42 || bytes[3] !== 0x50) {
    throw new Error(`not a PBP file: ${pbpPath}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets: number[] = [];
  for (let i = 0; i < 8; i++) offsets.push(dv.getUint32(8 + i * 4, true));
  const start = offsets[section];
  const end = section === 7 ? bytes.length : offsets[section + 1];
  if (start < 40 || end < start || end > bytes.length) {
    throw new Error(`invalid PBP section ${section}: ${pbpPath}`);
  }
  return bytes.slice(start, end);
}

async function repackEboot(name: string, title: string, eboot: string, destDir: string): Promise<void> {
  const workDir = join(workRoot, name);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const dataPsp = await extractPbpSection(eboot, 6);
  const dataPsar = await extractPbpSection(eboot, 7);
  const dataPspPath = join(workDir, "DATA.PSP");
  const dataPsarPath = join(workDir, "DATA.PSAR");
  const paramPath = join(workDir, "PARAM.SFO");
  const iconPath = join(workDir, "ICON0.PNG");
  const picPath = join(workDir, "PIC1.PNG");
  const destEboot = join(destDir, "EBOOT.PBP");

  const preview = await renderBoxArt(title, W, H);
  const icon = await renderBoxArt(title, ICON_W, ICON_H);
  await Bun.write(picPath, encodePng(preview, W, H));
  await Bun.write(iconPath, encodePng(icon, ICON_W, ICON_H));
  await Bun.write(dataPspPath, dataPsp);
  if (dataPsar.length > 0) await Bun.write(dataPsarPath, dataPsar);

  const mksfo = commandPath("mksfo");
  const packPbp = commandPath("pack-pbp");
  if (!mksfo || !packPbp) {
    throw new Error("pinned mksfo/pack-pbp not found; run `pocket target add psp`");
  }
  await $`${mksfo} ${title} ${paramPath}`;
  await $`${packPbp} ${destEboot} ${paramPath} ${iconPath} NULL NULL ${picPath} NULL ${dataPspPath} ${dataPsar.length > 0 ? dataPsarPath : "NULL"}`;
}

// ---------------------------------------------------------------------------
// Main — guarded so other scripts (e.g. a box-art preview tool) can import
// renderBoxArt()/encodePng() without triggering the full build loop.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
    console.log("Usage: bun tools/psp-all.ts [--debug]\n");
    console.log("Builds every apps/<name>/main.tsx into a PSP memory-stick layout:");
    console.log("  dist/psp/PSP/GAME/PocketJS-<name>/EBOOT.PBP\n");
    console.log("Each gets a PARAM.SFO title (from that demo's `// @title` comment,");
    console.log("falling back to the bare demo name) plus a procedurally rendered");
    console.log("ICON0.PNG/PIC1.PNG (hash(title) -> gradient + Inter title text).");
    console.log("Defaults to --release; pass --debug for unstripped debug builds.");
    process.exit(0);
  }

  const demos = listDemos();
  if (demos.length === 0) {
    console.error(`no demos found under ${demosDir} (looking for <name>/main.tsx)`);
    process.exit(1);
  }

  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(pspGameRoot, { recursive: true });
  mkdirSync(workRoot, { recursive: true });

  const profile = release ? "release" : "debug";
  const eboot = join(pspUiDir, "hosts/psp/target/mipsel-sony-psp", profile, "EBOOT.PBP");

  const built: { name: string; title: string; folder: string }[] = [];

  for (const [index, name] of demos.entries()) {
    const title = await demoTitle(name);
    console.log(`[${index + 1}/${demos.length}] building ${name} (${title})`);

    rmSync(eboot, { force: true });
    await $`bun tools/psp.ts ${name} ${release ? "--release" : ""}`.cwd(pspUiDir);

    if (!existsSync(eboot)) {
      console.error(`expected PSP output was not created: ${eboot}`);
      process.exit(1);
    }

    const folder = folderName(name);
    const destDir = join(pspGameRoot, folder);
    mkdirSync(destDir, { recursive: true });
    await repackEboot(name, title, eboot, destDir);
    built.push({ name, title, folder });
  }

  rmSync(workRoot, { recursive: true, force: true });

  await Bun.write(
    join(outRoot, "README.txt"),
    [
      "PocketJS demo bundle",
      "",
      "Copy the PSP directory in this folder to the root of a PSP memory stick.",
      "Each demo is under PSP/GAME/<folder>/EBOOT.PBP.",
      "Each EBOOT includes a generated PARAM.SFO title plus ICON0.PNG/PIC1.PNG box art.",
      "",
      "Demos:",
      ...built.map((b) => `- ${b.folder}: ${b.title}`),
      "",
    ].join("\n"),
  );

  console.log(`\nBuilt ${built.length} PocketJS demo(s): ${pspGameRoot}`);
  console.log("Copy dist/psp/PSP to the root of a PSP memory stick to install all of them.");
}
