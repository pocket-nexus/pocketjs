// hosts/web/runtime-glyphs.js — text.glyphs.runtime for the browser host.
//
// A guest's font atlases hold the codepoints its build scanned (ASCII always,
// the literals in its source) in the faces its slots name. Text that arrives
// at run time (a title from a server, a translation, a name someone typed)
// can carry codepoints no atlas has, and the core draws those as gid 0, the
// tofu box. This module closes that gap in a browser: it wraps a HostOps,
// keeps a copy of every atlas the guest loads, and before the core reads a
// string it draws each codepoint no atlas has with the browser's own fonts,
// appends the cell to every loaded slot's atlas (FONT ATLAS v3, spec.ts: the
// cmap stays codepoint-sorted, coverage is gid-linear, so a glyph is an
// append) and reloads the grown atlases through `loadFontAtlas`. Codepoints
// the atlases already map keep their baked forms.
//
// What draws a new glyph:
//   - the size comes from the slot's own Latin: the ink height of its "H" is
//     the cap height, and the em is that height / 0.72 (the cap height of
//     the faces PocketJS bakes is 0.70 to 0.73 em), so a kanji stands as tall
//     beside the slot's Latin as it does in a Japanese UI font;
//   - weight from the atlas's bold flag, position from its baseline;
//   - a slot whose baked coverage is all 0 or 255 (a bitmap face, such as
//     Pocket Shell's W95FA) gets its new cells thresholded the same way;
//   - a glyph wider than the slot's cells widens every cell of that atlas
//     (cells are padded on the right; layout reads advances, not cell
//     widths, so nothing moves).
//
// When it runs: `ensure` scans a string for codepoints above U+007E and adds
// what is missing to the copies at once; the grown atlases reach the core at
// `flush`, which the wrapped measureText and wrapText call before they
// measure, and which the realm calls before each tick (app-instance.js).
// Layout re-measures on an atlas reload, so a Text node set before the flush
// lays out with the new glyphs in the same frame.
//
// Pixels depend on the browser's fonts: a Japanese glyph is Hiragino on
// macOS and iOS, Yu Gothic or Meiryo on Windows, Noto Sans CJK on Android
// and ChromeOS. The capability promises coverage, not byte-identical pixels
// across hosts (contracts/spec/platforms.ts, text.glyphs.runtime).

// FONT ATLAS constants (contracts/spec/spec.ts; tests/runtime-glyphs.test.ts
// holds them equal, since this plain module cannot import the .ts spec).
export const FONT_MAGIC = 0x41464344;
export const FONT_HEADER_SIZE = 16;
export const FONT_CMAP_ENTRY_SIZE = 8;

/** Family list for glyphs the baked faces lack, Japanese forms first. */
export const DEFAULT_FALLBACK_FAMILIES = [
  "Hiragino Sans",
  "Hiragino Kaku Gothic ProN",
  "Yu Gothic UI",
  "Yu Gothic",
  "Meiryo UI",
  "Meiryo",
  "Noto Sans CJK JP",
  "Noto Sans JP",
  "PingFang SC",
  "Microsoft YaHei",
  "Apple SD Gothic Neo",
  "Malgun Gothic",
  "sans-serif",
].map((family) => (family.includes(" ") ? `"${family}"` : family)).join(", ");

/** The ceiling of glyphs one atlas grows to; the cmap's gid is a u16. */
export const MAX_GLYPHS = 8000;
/** Coverage at and above which a bitmap slot's new cell is ink. A stroke
 *  of a CJK UI face at 11 to 12 px covers one column fully and its
 *  neighbour by a half or less, so a cut this high keeps strokes one pixel
 *  wide, as a bitmap face draws them. */
export const BITMAP_CUT = 170;
/** Cap height of the baked faces as a share of their em. */
const CAP_SHARE = 0.72;

/**
 * Parse a FONT ATLAS blob (v2 or v3) into an appendable copy, or null when
 * the bytes are not one.
 */
export function parseAtlas(bytes) {
  const blob = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (blob.length < FONT_HEADER_SIZE) return null;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (view.getUint32(0, true) !== FONT_MAGIC) return null;
  const version = view.getUint16(4, true);
  if (version !== 2 && version !== 3) return null;
  const count = view.getUint16(6, true);
  const density = version === 3 ? Math.max(1, blob[14]) : 1;
  const atlas = {
    cellW: blob[8],
    cellH: blob[9],
    baseline: blob[10],
    lineHeight: blob[11],
    slot: blob[12],
    flags: blob[13],
    density,
    /** [codepoint, gid, advance, xoff], one per cell: the cmap has glyphCount entries. */
    glyphs: [],
    known: new Set(),
    coverage: null,
    em: 0,
    bilevel: false,
  };
  const cmapEnd = FONT_HEADER_SIZE + count * FONT_CMAP_ENTRY_SIZE;
  const cell = atlas.cellW * density * atlas.cellH * density;
  if (blob.length < cmapEnd + count * cell) return null;
  for (let i = 0; i < count; i++) {
    const at = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
    const entry = [view.getUint32(at, true), view.getUint16(at + 4, true), blob[at + 6], blob[at + 7]];
    if (entry[1] >= count) return null;
    atlas.glyphs.push(entry);
    atlas.known.add(entry[0]);
  }
  atlas.coverage = blob.slice(cmapEnd, cmapEnd + count * cell);
  atlas.bilevel = isBilevel(atlas.coverage);
  atlas.em = emOf(atlas);
  return atlas;
}

function isBilevel(coverage) {
  let ink = 0;
  for (let i = 0; i < coverage.length; i++) {
    const b = coverage[i];
    if (b !== 0 && b !== 255) return false;
    if (b) ink++;
  }
  return ink > 0;
}

/** The em in logical px, from the ink height of the slot's "H". */
function emOf(atlas) {
  const entry = atlas.glyphs.find((glyph) => glyph[0] === 0x48);
  const fallback = Math.max(1, Math.round(atlas.lineHeight / 1.25));
  if (!entry) return fallback;
  const w = atlas.cellW * atlas.density, h = atlas.cellH * atlas.density;
  const cell = atlas.coverage.subarray(entry[1] * w * h, (entry[1] + 1) * w * h);
  let top = -1, bottom = -1;
  for (let y = 0; y < h; y++) {
    let inked = false;
    for (let x = 0; x < w && !inked; x++) inked = cell[y * w + x] >= 64;
    if (inked) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) return fallback;
  return Math.max(1, (bottom - top + 1) / atlas.density / CAP_SHARE);
}

/** Grow every cell of `atlas` to `cellW` logical px, padding on the right. */
export function widenAtlas(atlas, cellW) {
  if (cellW <= atlas.cellW) return;
  const d = atlas.density, h = atlas.cellH * d;
  const oldW = atlas.cellW * d, newW = Math.min(255, cellW) * d;
  const count = atlas.glyphs.length;
  const out = new Uint8Array(count * newW * h);
  for (let g = 0; g < count; g++) {
    for (let y = 0; y < h; y++) {
      const from = (g * h + y) * oldW;
      out.set(atlas.coverage.subarray(from, from + oldW), (g * h + y) * newW);
    }
  }
  atlas.coverage = out;
  atlas.cellW = Math.min(255, cellW);
}

/**
 * Append one glyph. `glyph` is { advance, width, coverage } in the atlas's
 * terms: `advance` and `width` in logical px, `coverage` `width * density`
 * samples wide and `cellH * density` tall. Returns false when the atlas is full.
 */
export function appendGlyph(atlas, codepoint, glyph) {
  if (atlas.known.has(codepoint)) return true;
  if (atlas.glyphs.length >= MAX_GLYPHS) return false;
  if (glyph.width > atlas.cellW) widenAtlas(atlas, glyph.width);
  const d = atlas.density, w = atlas.cellW * d, h = atlas.cellH * d;
  const srcW = Math.min(glyph.width * d, w);
  const cell = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < srcW; x++) {
      const v = glyph.coverage[y * glyph.width * d + x] ?? 0;
      cell[y * w + x] = atlas.bilevel ? (v >= BITMAP_CUT ? 255 : 0) : v;
    }
  }
  const grown = new Uint8Array(atlas.coverage.length + cell.length);
  grown.set(atlas.coverage);
  grown.set(cell, atlas.coverage.length);
  atlas.coverage = grown;
  atlas.glyphs.push([codepoint, atlas.glyphs.length, Math.max(0, Math.min(255, Math.round(glyph.advance))), 0]);
  atlas.known.add(codepoint);
  return true;
}

/** Serialize an atlas back to a v3 blob, cmap sorted by codepoint. */
export function serializeAtlas(atlas) {
  const count = atlas.glyphs.length;
  const cmap = [...atlas.glyphs].sort((a, b) => a[0] - b[0]);
  const out = new Uint8Array(FONT_HEADER_SIZE + count * FONT_CMAP_ENTRY_SIZE + atlas.coverage.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, FONT_MAGIC, true);
  view.setUint16(4, 3, true);
  view.setUint16(6, count, true);
  out.set([atlas.cellW, atlas.cellH, atlas.baseline, atlas.lineHeight, atlas.slot, atlas.flags, atlas.density, 0], 8);
  cmap.forEach(([cp, gid, advance, xoff], i) => {
    const at = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
    view.setUint32(at, cp, true);
    view.setUint16(at + 4, gid, true);
    out[at + 6] = advance;
    out[at + 7] = xoff;
  });
  out.set(atlas.coverage, FONT_HEADER_SIZE + count * FONT_CMAP_ENTRY_SIZE);
  return out;
}

/**
 * A rasterizer over a 2D canvas: draws one codepoint white on a transparent
 * canvas in `families` and reads its alpha back as coverage.
 */
export function canvasRasterizer({ families = DEFAULT_FALLBACK_FAMILIES, createCanvas } = {}) {
  const make = createCanvas ?? ((w, h) =>
    typeof OffscreenCanvas === "function" ? new OffscreenCanvas(w, h)
      : typeof document === "object" ? Object.assign(document.createElement("canvas"), { width: w, height: h }) : null);
  let canvas = null, g = null;
  return (codepoint, atlas) => {
    const d = atlas.density, size = atlas.em * d;
    const h = atlas.cellH * d;
    if (!canvas) {
      canvas = make(64, 64);
      // A runtime with no 2D canvas (a test under Bun) draws nothing: the core keeps its tofu.
      if (!canvas) return null;
      g = canvas.getContext("2d", { willReadFrequently: true });
    }
    const font = `${atlas.flags & 1 ? 700 : 400} ${size}px ${families}`;
    g.font = font;
    const text = String.fromCodePoint(codepoint);
    const measured = g.measureText(text);
    const advance = measured.width / d;
    const left = Math.max(0, Math.ceil(measured.actualBoundingBoxLeft ?? 0));
    const inkRight = Math.ceil(measured.actualBoundingBoxRight ?? measured.width);
    const width = Math.max(1, Math.ceil((left + Math.max(inkRight, measured.width)) / d));
    if (canvas.width < width * d || canvas.height < h) {
      canvas.width = Math.max(canvas.width, width * d);
      canvas.height = Math.max(canvas.height, h);
    }
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.font = font;
    g.fillStyle = "#fff";
    g.textBaseline = "alphabetic";
    g.fillText(text, left, atlas.baseline * d);
    const pixels = g.getImageData(0, 0, width * d, h).data;
    const coverage = new Uint8Array(width * d * h);
    for (let i = 0; i < coverage.length; i++) coverage[i] = pixels[i * 4 + 3];
    return { advance, width, coverage };
  };
}

/** Codepoints above U+007E that are not line breaks or other controls. */
const BEYOND_ASCII = /[^\x00-\x7e]/;

/**
 * Give `ops` (a HostOps, changed in place) runtime glyphs: codepoints no atlas
 * maps are drawn by `rasterize` and added to every loaded atlas. Returns
 * { ensure, flush, stats }: `flush()` hands grown atlases to the core,
 * `stats()` counts what was added and the milliseconds it took.
 */
export function installRuntimeGlyphs(ops, { rasterize = canvasRasterizer(), now = () => performance.now() } = {}) {
  const load = ops.loadFontAtlas;
  const setText = ops.setText, replaceText = ops.replaceText, measureText = ops.measureText, wrapText = ops.wrapText;
  /** slot -> parsed atlas copy */
  const atlases = new Map();
  /** every codepoint drawn so far, so an atlas loaded later gets them too */
  const added = new Set();
  const dirty = new Set();
  const counters = { glyphs: 0, cells: 0, reloads: 0, ms: 0, full: 0 };

  function grow(atlas, codepoints) {
    for (const cp of codepoints) {
      if (atlas.known.has(cp)) continue;
      const glyph = rasterize(cp, atlas);
      if (!glyph) continue;
      if (!appendGlyph(atlas, cp, glyph)) {
        counters.full++;
        return;
      }
      counters.cells++;
      dirty.add(atlas.slot);
    }
  }

  function ensure(text) {
    if (typeof text !== "string" || !BEYOND_ASCII.test(text) || atlases.size === 0) return;
    const fresh = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp < 0x7f || (cp >= 0x80 && cp < 0xa0) || added.has(cp)) continue;
      added.add(cp);
      fresh.push(cp);
    }
    if (fresh.length === 0) return;
    const start = now();
    counters.glyphs += fresh.length;
    for (const atlas of atlases.values()) grow(atlas, fresh);
    counters.ms += now() - start;
  }

  function flush() {
    if (dirty.size === 0) return;
    const start = now();
    for (const slot of dirty) {
      const atlas = atlases.get(slot);
      if (!atlas) continue;
      load(serializeAtlas(atlas));
      counters.reloads++;
    }
    dirty.clear();
    counters.ms += now() - start;
  }

  ops.loadFontAtlas = (buf) => {
    const atlas = parseAtlas(buf);
    if (!atlas) return load(buf);
    atlases.set(atlas.slot, atlas);
    dirty.delete(atlas.slot);
    const start = now();
    grow(atlas, added);
    counters.ms += now() - start;
    if (!dirty.has(atlas.slot)) return load(buf);
    dirty.delete(atlas.slot);
    counters.reloads++;
    return load(serializeAtlas(atlas));
  };
  ops.setText = (id, str) => {
    ensure(str);
    return setText(id, str);
  };
  ops.replaceText = (id, str) => {
    ensure(str);
    return replaceText(id, str);
  };
  ops.measureText = (str, slot) => {
    ensure(str);
    flush();
    return measureText(str, slot);
  };
  if (wrapText) {
    ops.wrapText = (str, slot, maxW) => {
      ensure(str);
      flush();
      return wrapText(str, slot, maxW);
    };
  }
  return { ensure, flush, stats: () => ({ ...counters, slots: atlases.size }) };
}
