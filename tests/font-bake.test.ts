import { describe, expect, test } from "bun:test";
import { parse as parseFont } from "opentype.js";
import { bakeSlot, DEFAULT_REGULAR, type GlyphRasterCache } from "../framework/compiler/bake-font.ts";
import {
  FONT_CMAP_ENTRY_SIZE,
  FONT_HEADER_SIZE,
  FONT_MAGIC,
  FONT_VERSION,
} from "../contracts/spec/spec.ts";

const font = parseFont(await Bun.file(DEFAULT_REGULAR).arrayBuffer());
const codepoints = [0x41, 0x42, 0xee]; // A, B, and a negative-LSB accent.

describe("font atlas density", () => {
  test("v3 increases coverage while preserving logical metrics and cmap", () => {
    const one = bakeSlot(font, 0, 16, false, codepoints, 1);
    const two = bakeSlot(font, 0, 16, false, codepoints, 2);
    const oneView = new DataView(one.bytes.buffer, one.bytes.byteOffset, one.bytes.byteLength);
    const twoView = new DataView(two.bytes.buffer, two.bytes.byteOffset, two.bytes.byteLength);

    expect(oneView.getUint32(0, true)).toBe(FONT_MAGIC);
    expect(oneView.getUint16(4, true)).toBe(FONT_VERSION);
    expect(twoView.getUint16(4, true)).toBe(FONT_VERSION);
    expect(one.bytes[14]).toBe(1);
    expect(two.bytes[14]).toBe(2);

    expect([two.cellW, two.cellH]).toEqual([one.cellW, one.cellH]);
    expect([two.coverageW, two.coverageH]).toEqual([one.cellW * 2, one.cellH * 2]);
    expect(two.rasterDensity).toBe(2);
    // Header logical metrics (cell, baseline, line-height, slot, flags) are
    // identical. Density lives only in byte 14.
    expect([...two.bytes.subarray(8, 14)]).toEqual([...one.bytes.subarray(8, 14)]);

    const cmapEnd = FONT_HEADER_SIZE + one.glyphCount * FONT_CMAP_ENTRY_SIZE;
    expect([...two.bytes.subarray(FONT_HEADER_SIZE, cmapEnd)]).toEqual([
      ...one.bytes.subarray(FONT_HEADER_SIZE, cmapEnd),
    ]);
    expect(two.bytes.length).toBe(
      cmapEnd + two.glyphCount * two.coverageW * two.coverageH,
    );
    expect(two.bytes.length).toBeGreaterThan(one.bytes.length);

    const coverage = two.bytes.subarray(cmapEnd);
    expect(coverage.some((sample) => sample > 0)).toBe(true);
    expect(coverage.some((sample) => sample > 0 && sample < 255)).toBe(true);
  });

  test("rejects densities outside the one-byte v3 contract", () => {
    expect(() => bakeSlot(font, 0, 16, false, codepoints, 0)).toThrow(/rasterDensity/);
    expect(() => bakeSlot(font, 0, 16, false, codepoints, 1.5)).toThrow(/rasterDensity/);
    expect(() => bakeSlot(font, 0, 16, false, codepoints, 256)).toThrow(/rasterDensity/);
  });
});

describe("open contours", () => {
  /**
   * A face whose one glyph is exactly the commands given.
   *
   * The point is the command list, not the face: opentype.js emits no `Z` for
   * either outline format, and a TrueType contour returns to its start point on
   * its own while a CFF contour does not. So the difference between the two
   * formats, as this module sees it, is precisely the presence of that last
   * point — which is what these two paths are.
   */
  const face = (commands: unknown[]): typeof font => {
    const glyph = { advanceWidth: 600, getPath: () => ({ commands }) };
    return {
      unitsPerEm: 1000,
      ascender: 800,
      descender: -200,
      tables: { hhea: { lineGap: 0 } },
      charToGlyphIndex: (ch: string) => (ch === "A" ? 1 : 0),
      glyphs: { get: () => glyph },
    } as unknown as typeof font;
  };

  const SQUARE = [
    { type: "M", x: 2, y: 2 },
    { type: "L", x: 12, y: 2 },
    { type: "L", x: 12, y: 12 },
    { type: "L", x: 2, y: 12 },
  ];
  const CLOSED = [...SQUARE, { type: "L", x: 2, y: 2 }];

  const bake = (commands: unknown[]) => bakeSlot(face(commands), 0, 16, false, [0x41], 1);

  test("bake the same coverage as the closed outline they mean", () => {
    const open = bake(SQUARE);
    const closed = bake(CLOSED);
    expect([...open.bytes]).toEqual([...closed.bytes]);
  });

  test("and that coverage is the filled square, not an empty cell", () => {
    // Without this the assertion above is satisfied by two empty cells.
    const { bytes, glyphCount, coverageW, coverageH } = bake(SQUARE);
    const coverage = bytes.subarray(
      FONT_HEADER_SIZE + glyphCount * FONT_CMAP_ENTRY_SIZE + coverageW * coverageH, // gid 1
    );
    const inked = coverage.filter((sample) => sample > 0).length;
    // 10x10 px of ink, minus antialiasing at the edges; assert the order of
    // magnitude rather than the exact count.
    expect(inked).toBeGreaterThan(80);
    expect(coverage.some((sample) => sample === 255)).toBe(true);
  });
});

describe("monospace slots", () => {
  test("font-mono resolves to the mono slot family and bakes uniform advances", async () => {
    const { fontSlotFor, fontSlotInfo } = await import("../framework/compiler/tailwind.ts");
    const { DEFAULT_MONO } = await import("../framework/compiler/bake-font.ts");
    expect(fontSlotFor(14, false, true)).toBe(17);
    expect(fontSlotFor(14, true, true)).toBe(17); // bold-under-mono lands on the mono slot
    expect(fontSlotInfo(17)).toEqual({ px: 14, bold: false, mono: true });
    // Existing slots are untouched by the widening (byte-stability).
    expect(fontSlotFor(14, false)).toBe(1);
    expect(fontSlotFor(54, true)).toBe(15);

    // The monospace PROPERTY, asserted on the baked atlas: every glyph
    // advance equal — exactly what code-column alignment relies on — where
    // the proportional face over the same chars must differ.
    const mono = parseFont(await Bun.file(DEFAULT_MONO).arrayBuffer());
    const chars = [0x69, 0x6c, 0x6d, 0x57, 0x2e]; // i l m W .
    // cmap entries: u32 cp, u16 gid, u8 advance, u8 xoff (spec.ts); the
    // tofu (0xfffd) advance is the cell width, so it is excluded.
    const glyphAdvances = (baked: ReturnType<typeof bakeSlot>): Set<number> => {
      const view = new DataView(baked.bytes.buffer, baked.bytes.byteOffset);
      const out = new Set<number>();
      for (let g = 0; g < chars.length + 1; g++) {
        const at = FONT_HEADER_SIZE + g * FONT_CMAP_ENTRY_SIZE;
        if (view.getUint32(at, true) === 0xfffd) continue;
        out.add(view.getUint8(at + 6));
      }
      return out;
    };
    expect(glyphAdvances(bakeSlot(mono, 17, 14, false, chars, 1)).size).toBe(1);
    expect(glyphAdvances(bakeSlot(font, 1, 14, false, chars, 1)).size).toBeGreaterThan(1);
  });
});

describe("fill rule", () => {
  // W95FA (a bitmap-font conversion) builds glyphs from stroke rectangles
  // that SHARE EDGES — under the old even-odd pairing the shared spans
  // cancelled and 'h' lost its ascender (rendered identical to 'n').
  // Nonzero winding is the TrueType/CFF rule; this pins it.
  test("edge-sharing strokes survive (nonzero winding, not even-odd)", async () => {
    const w95 = parseFont(
      await Bun.file(new URL("../assets/fonts/W95FA.otf", import.meta.url)).arrayBuffer(),
    );
    const chars = ["h", "n"].map((c) => c.codePointAt(0)!);
    const atlas = bakeSlot(w95, 0, 12.5, false, chars, 2);
    const view = new DataView(atlas.bytes.buffer, atlas.bytes.byteOffset, atlas.bytes.byteLength);
    const cellBytes = atlas.coverageW * atlas.coverageH;
    const cellsOff = FONT_HEADER_SIZE + atlas.glyphCount * FONT_CMAP_ENTRY_SIZE;
    const cellOf = (cp: number): Uint8Array => {
      for (let i = 0; i < atlas.glyphCount; i++) {
        const e = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
        if (view.getUint32(e, true) === cp) {
          const gid = view.getUint16(e + 4, true);
          return atlas.bytes.subarray(cellsOff + gid * cellBytes, cellsOff + (gid + 1) * cellBytes);
        }
      }
      throw new Error(`codepoint ${cp} missing`);
    };
    const h = cellOf(chars[0]);
    const n = cellOf(chars[1]);
    expect(h.some((b) => b > 0)).toBe(true);
    expect(Buffer.from(h).equals(Buffer.from(n))).toBe(false);
    // The ascender: 'h' must have ink strictly above 'n''s topmost row.
    const topInk = (cell: Uint8Array): number => {
      for (let y = 0; y < atlas.coverageH; y++) {
        for (let x = 0; x < atlas.coverageW; x++) {
          if (cell[y * atlas.coverageW + x] > 0) return y;
        }
      }
      return atlas.coverageH;
    };
    expect(topInk(h)).toBeLessThan(topInk(n));
  });
});

describe("glyph raster cache", () => {
  test("a cached bake is byte-identical to an uncached one, whatever the set's cell width", () => {
    const narrow = [0x41, 0x42, 0x69, 0xee];
    const wide = [0x41, 0x42, 0x57, 0x69, 0xee, 0x40];
    for (const density of [1, 2]) {
      const cache: GlyphRasterCache = new Map();
      // the narrow set fills the cache; the wide set reuses it in wider cells
      expect(bakeSlot(font, 0, 16, false, narrow, density, [], cache).bytes).toEqual(bakeSlot(font, 0, 16, false, narrow, density).bytes);
      const held = cache.size;
      const reused = bakeSlot(font, 0, 16, false, wide, density, [], cache);
      expect(reused.bytes).toEqual(bakeSlot(font, 0, 16, false, wide, density).bytes);
      expect(cache.size).toBe(held + 2);
      expect(bakeSlot(font, 0, 16, false, narrow, density, [], cache).bytes).toEqual(bakeSlot(font, 0, 16, false, narrow, density).bytes);
    }
  });
});
