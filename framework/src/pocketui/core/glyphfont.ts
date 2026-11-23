// PocketUI core/glyphfont.ts — a face that grows: the glyphs of text that
// arrives at run time, kept for as long as the application runs.
//
// PocketJS bakes a font slot's atlas at build time from the text the bundle
// names, which is ASCII. Text from the network in another script needs
// glyphs nobody baked, and a device's companion can draw them: it answers a
// FONT ATLAS (PocketJS contracts/spec/spec.ts, version 3) for the characters
// it is asked for. A slot holds one atlas, loaded whole.
//
// So the face is kept here, glyph by glyph. A reply's cells go into a table;
// only characters the table lacks are ever asked for; and the slot's atlas
// is built again from the whole table when cells arrive. A character drawn
// once is never fetched again and never falls back while its text scrolls
// away and returns, up to a capacity of some thousands of glyphs, past which
// the ones wanted longest ago go first.
//
// What this does not do, on purpose: bidirectional text, joining scripts,
// ligatures, kerning, combining marks placed by the font. A glyph is a
// codepoint, its advance is a whole number of points, and text runs left to
// right. That is what keeps measuring a table lookup and layout a sum.

export const ATLAS_MAGIC = 0x41464344;
export const ATLAS_VERSION = 3;
const HEADER = 16;
const CMAP_ENTRY = 8;
const FLAG_BOLD = 1;
/** The codepoint whose cell (gid 0) the core draws for a character the atlas lacks. */
const TOFU = 0xfffd;

export interface AtlasGlyph {
  cp: number;
  /** logical points */
  advance: number;
  xoff: number;
  /** coverage, one byte a sample: `cellW * density` wide, `cellH * density` tall */
  cell: Uint8Array;
}

export interface ParsedAtlas {
  /** logical cell size */
  cellW: number;
  cellH: number;
  baseline: number;
  lineHeight: number;
  density: number;
  bold: boolean;
  /** every glyph but the tofu box */
  glyphs: AtlasGlyph[];
}

/** The glyphs of a FONT ATLAS blob; null when it is not one. The cells are views into `bytes`. */
export function parseAtlas(bytes: Uint8Array): ParsedAtlas | null {
  if (bytes.length < HEADER) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== ATLAS_MAGIC || view.getUint16(4, true) !== ATLAS_VERSION) return null;
  const count = view.getUint16(6, true);
  const cellW = bytes[8]!;
  const cellH = bytes[9]!;
  const density = bytes[14]!;
  if (count === 0 || cellW === 0 || cellH === 0 || density === 0) return null;
  const cellBytes = cellW * density * cellH * density;
  const cells = HEADER + count * CMAP_ENTRY;
  if (bytes.length < cells + count * cellBytes) return null;
  const glyphs: AtlasGlyph[] = [];
  for (let index = 0; index < count; index++) {
    const entry = HEADER + index * CMAP_ENTRY;
    const gid = view.getUint16(entry + 4, true);
    if (gid === 0 || gid >= count) continue;
    glyphs.push({ cp: view.getUint32(entry, true), advance: bytes[entry + 6]!, xoff: bytes[entry + 7]!, cell: bytes.subarray(cells + gid * cellBytes, cells + (gid + 1) * cellBytes) });
  }
  return { cellW, cellH, baseline: bytes[10]!, lineHeight: bytes[11]!, density, bold: (bytes[13]! & FLAG_BOLD) !== 0, glyphs };
}

interface Held {
  advance: number;
  xoff: number;
  cell: Uint8Array;
  /** the tick it was last wanted at */
  used: number;
}

/** One face's glyphs, and the atlas that holds them all. */
export class GlyphTable {
  cellW = 0;
  cellH = 0;
  baseline = 0;
  lineHeight = 0;
  density = 0;
  private readonly held = new Map<number, Held>();
  /** asked for and answered without: no font the companion has draws them */
  private readonly absent = new Set<number>();
  private tick = 0;
  evictions = 0;

  /** `px`: the face's size, which is also what a character not yet here is taken to advance. `capacity`: glyphs kept. */
  constructor(readonly px: number, readonly capacity = 4096) {}

  get size(): number {
    return this.held.size;
  }

  /** The bytes of the cells held. */
  get bytes(): number {
    return this.held.size * this.cellW * this.density * this.cellH * this.density;
  }

  has(cp: number): boolean {
    return this.held.has(cp);
  }

  /** Here, or known not to exist: nothing to ask for. */
  settled(cp: number): boolean {
    return this.held.has(cp) || this.absent.has(cp);
  }

  /** A character's advance in points: its glyph's, or the face's size for one not here yet (which is what the atlas's empty box advances, so text draws where it was measured). */
  advance(cp: number): number {
    const glyph = this.held.get(cp);
    return glyph ? glyph.advance : this.px;
  }

  /** The width of `text` in points. */
  measure(text: string): number {
    let width = 0;
    for (let at = 0; at < text.length; at++) {
      let cp = text.charCodeAt(at);
      if (cp >= 0xd800 && cp <= 0xdbff) {
        const low = text.charCodeAt(at + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          cp = (cp - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
          at++;
        }
      }
      if (cp === 0x0a) continue;
      const glyph = this.held.get(cp);
      width += glyph ? glyph.advance : this.px;
    }
    return width;
  }

  /** The codepoints of `texts` that are neither here nor known absent, each once; the ones here are marked used now. */
  missing(texts: readonly string[], out: number[] = []): number[] {
    const tick = ++this.tick;
    // no set while nothing is missing: the usual case, once a face has warmed up
    let seen: Set<number> | null = out.length > 0 ? new Set(out) : null;
    for (const text of texts) {
      for (let at = 0; at < text.length; at++) {
        let cp = text.charCodeAt(at);
        if (cp >= 0xd800 && cp <= 0xdbff) {
        const low = text.charCodeAt(at + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          cp = (cp - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
          at++;
        }
      }
        // a control character has no glyph, nor has half of a surrogate pair
        if (cp < 0x20 || (cp >= 0xd800 && cp <= 0xdfff)) continue;
        const glyph = this.held.get(cp);
        if (glyph) glyph.used = tick;
        else if (!this.absent.has(cp) && !seen?.has(cp)) {
          (seen ??= new Set()).add(cp);
          out.push(cp);
        }
      }
    }
    return out;
  }

  /** Whether every character of `text` is here (or exists nowhere). */
  covers(text: string): boolean {
    for (let at = 0; at < text.length; at++) {
      let cp = text.charCodeAt(at);
      if (cp >= 0xd800 && cp <= 0xdbff) {
        const low = text.charCodeAt(at + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          cp = (cp - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
          at++;
        }
      }
      if (cp < 0x20 || (cp >= 0xd800 && cp <= 0xdfff)) continue;
      if (!this.held.has(cp) && !this.absent.has(cp)) return false;
    }
    return true;
  }

  /** Take a reply's glyphs. `asked`: the codepoints the request named; one the reply lacks exists in no font there. Returns how many were new, or -1 for a reply of another geometry than the face's. */
  add(atlas: ParsedAtlas, asked: readonly number[] = []): number {
    if (this.density === 0) {
      this.density = atlas.density;
      this.cellH = atlas.cellH;
      this.baseline = atlas.baseline;
      this.lineHeight = atlas.lineHeight;
    } else if (atlas.density !== this.density || atlas.baseline !== this.baseline) return -1;
    // a cell is as wide as the widest glyph of its reply: the table's is the widest seen, and the rest are padded to it
    if (atlas.cellW > this.cellW || atlas.cellH > this.cellH) this.resize(Math.max(atlas.cellW, this.cellW), Math.max(atlas.cellH, this.cellH));
    const same = atlas.cellW === this.cellW && atlas.cellH === this.cellH;
    const tick = ++this.tick;
    let added = 0;
    for (const glyph of atlas.glyphs) {
      if (glyph.cp === TOFU || this.held.has(glyph.cp)) continue;
      const cell = same ? glyph.cell : pad(glyph.cell, atlas.cellW * atlas.density, atlas.cellH * atlas.density, this.cellW * this.density, this.cellH * this.density);
      this.held.set(glyph.cp, { advance: glyph.advance, xoff: glyph.xoff, cell, used: tick });
      this.absent.delete(glyph.cp);
      added++;
    }
    for (const cp of asked) if (!this.held.has(cp)) this.absent.add(cp);
    return added;
  }

  private resize(cellW: number, cellH: number): void {
    const fromW = this.cellW * this.density;
    const fromH = this.cellH * this.density;
    for (const glyph of this.held.values()) glyph.cell = pad(glyph.cell, fromW, fromH, cellW * this.density, cellH * this.density);
    this.cellW = cellW;
    this.cellH = cellH;
  }

  /** Past the capacity, drop the glyphs wanted longest ago, down to nine tenths of it. Returns how many went. */
  evict(): number {
    if (this.held.size <= this.capacity) return 0;
    const keep = Math.floor(this.capacity * 0.9);
    const order = [...this.held.entries()].sort((a, b) => a[1].used - b[1].used);
    const drop = order.length - keep;
    for (let index = 0; index < drop; index++) this.held.delete(order[index]![0]);
    this.evictions += drop;
    return drop;
  }

  /** The atlas of everything held, for font slot `slot`. Its box for a missing character is empty and advances the face's size. Null while nothing is held. */
  build(slot: number, bold: boolean): Uint8Array | null {
    if (this.density === 0 || this.cellW === 0) return null;
    const cellBytes = this.cellW * this.density * this.cellH * this.density;
    const cps = [...this.held.keys()].sort((a, b) => a - b);
    const count = cps.length + 1;
    const cells = HEADER + count * CMAP_ENTRY;
    const out = new Uint8Array(cells + count * cellBytes);
    const view = new DataView(out.buffer);
    view.setUint32(0, ATLAS_MAGIC, true);
    view.setUint16(4, ATLAS_VERSION, true);
    view.setUint16(6, count, true);
    out[8] = this.cellW;
    out[9] = this.cellH;
    out[10] = this.baseline;
    out[11] = this.lineHeight;
    out[12] = slot;
    out[13] = bold ? FLAG_BOLD : 0;
    out[14] = this.density;
    // the cmap, ascending; the empty box's entry sits where U+FFFD sorts
    let entry = HEADER;
    let gid = 1;
    let boxed = false;
    const box = () => {
      view.setUint32(entry, TOFU, true);
      view.setUint16(entry + 4, 0, true);
      out[entry + 6] = Math.min(255, this.px);
      entry += CMAP_ENTRY;
      boxed = true;
    };
    for (const cp of cps) {
      if (!boxed && cp > TOFU) box();
      const glyph = this.held.get(cp)!;
      view.setUint32(entry, cp, true);
      view.setUint16(entry + 4, gid, true);
      out[entry + 6] = glyph.advance;
      out[entry + 7] = glyph.xoff;
      out.set(glyph.cell, cells + gid * cellBytes);
      entry += CMAP_ENTRY;
      gid++;
    }
    if (!boxed) box();
    return out;
  }
}

/** A cell of `fromW` x `fromH` samples in the top-left of one `toW` x `toH`. */
function pad(cell: Uint8Array, fromW: number, fromH: number, toW: number, toH: number): Uint8Array {
  const out = new Uint8Array(toW * toH);
  const rows = Math.min(fromH, toH);
  const columns = Math.min(fromW, toW);
  for (let y = 0; y < rows; y++) out.set(cell.subarray(y * fromW, y * fromW + columns), y * toW);
  return out;
}

// ---------------------------------------------------------------------------
// Which text needs the face
// ---------------------------------------------------------------------------

/** A run of one paragraph: text the baked faces draw (ASCII), or text the run-time face draws. */
export interface ScriptRun {
  text: string;
  runtime: boolean;
}

const ASCII = /^[\x00-\x7f]*$/;

/** Whether any of `text` is outside what the baked faces hold. */
export const needsRuntime = (text: string): boolean => !ASCII.test(text);

/** `text` as runs by who draws them. A wide character (CJK, kana, hangul,
 *  an emoji) is the run-time face's. A word with any character outside ASCII
 *  is the run-time face's whole, so a word is never set in two fonts. Spaces
 *  and line breaks stay with the baked face. */
export function splitRuns(text: string): ScriptRun[] {
  if (ASCII.test(text)) return text.length > 0 ? [{ text, runtime: false }] : [];
  const runs: ScriptRun[] = [];
  let from = 0;
  let runtime = false;
  const cut = (to: number, next: boolean) => {
    if (next === runtime) return;
    if (to > from) runs.push({ text: text.slice(from, to), runtime });
    from = to;
    runtime = next;
  };
  const end = text.length;
  let at = 0;
  while (at < end) {
    const c = text.charCodeAt(at);
    if (c === 0x20 || c === 0x0a || c === 0x09) {
      cut(at, false);
      at++;
    } else if (c >= 0x2e80) {
      // a wide character, or a surrogate pair (an emoji, a rare ideograph)
      cut(at, true);
      at += c >= 0xd800 && c <= 0xdbff && at + 1 < end ? 2 : 1;
    } else {
      // a word: up to a space or a wide character
      let stop = at;
      let outside = false;
      while (stop < end) {
        const n = text.charCodeAt(stop);
        if (n === 0x20 || n === 0x0a || n === 0x09 || n >= 0x2e80) break;
        if (n >= 0x80) outside = true;
        stop++;
      }
      cut(at, outside);
      at = stop;
    }
  }
  if (end > from) runs.push({ text: text.slice(from, end), runtime });
  return runs;
}

/** UTF-8 bytes of a codepoint. */
const utf8 = (cp: number): number => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/** `cps` as the texts of requests: each at most `textBytes` of UTF-8 (what a request can name) and `maxGlyphs` characters (what a reply can carry). */
export function planParts(cps: readonly number[], textBytes: number, maxGlyphs: number): number[][] {
  const parts: number[][] = [];
  let part: number[] = [];
  let bytes = 0;
  for (const cp of cps) {
    const cost = utf8(cp);
    if (part.length > 0 && (bytes + cost > textBytes || part.length >= maxGlyphs)) {
      parts.push(part);
      part = [];
      bytes = 0;
    }
    part.push(cp);
    bytes += cost;
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

/** Printable ASCII: what a run-time face holds from the start, for the words it draws whole and for a field that types in it. */
export const ASCII_CODEPOINTS: readonly number[] = Array.from({ length: 0x7f - 0x20 }, (_, index) => 0x20 + index);

/** An atlas of the given glyphs, for tests and for a stand-in companion. */
export function encodeAtlas(spec: { slot: number; bold?: boolean; cellW: number; cellH: number; baseline: number; lineHeight: number; density: number; glyphs: readonly AtlasGlyph[] }): Uint8Array {
  const cellBytes = spec.cellW * spec.density * spec.cellH * spec.density;
  const glyphs = [...spec.glyphs].filter((glyph) => glyph.cp !== TOFU).sort((a, b) => a.cp - b.cp);
  const count = glyphs.length + 1;
  const cells = HEADER + count * CMAP_ENTRY;
  const out = new Uint8Array(cells + count * cellBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, ATLAS_MAGIC, true);
  view.setUint16(4, ATLAS_VERSION, true);
  view.setUint16(6, count, true);
  out.set([spec.cellW, spec.cellH, spec.baseline, spec.lineHeight, spec.slot, spec.bold ? FLAG_BOLD : 0, spec.density, 0], 8);
  const entries = glyphs.map((glyph, index) => ({ cp: glyph.cp, gid: index + 1, advance: glyph.advance, xoff: glyph.xoff }));
  entries.push({ cp: TOFU, gid: 0, advance: Math.max(4, Math.round(spec.cellW * 0.55)), xoff: 0 });
  entries.sort((a, b) => a.cp - b.cp);
  entries.forEach((glyph, index) => {
    const entry = HEADER + index * CMAP_ENTRY;
    view.setUint32(entry, glyph.cp, true);
    view.setUint16(entry + 4, glyph.gid, true);
    out[entry + 6] = glyph.advance;
    out[entry + 7] = glyph.xoff;
  });
  glyphs.forEach((glyph, index) => out.set(glyph.cell.subarray(0, cellBytes), cells + (index + 1) * cellBytes));
  // the box: an outline
  const w = spec.cellW * spec.density;
  const h = spec.cellH * spec.density;
  for (let y = 0; y < h; y++) for (let x = 0; x < Math.min(w, 6 * spec.density); x++) if (y === 0 || y === h - 1 || x === 0 || x === Math.min(w, 6 * spec.density) - 1) out[cells + y * w + x] = 255;
  return out;
}
