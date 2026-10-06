// text.glyphs.runtime in the browser host (hosts/web/runtime-glyphs.js): the
// atlas copy round-trips, appended glyphs keep the cmap sorted, a wide glyph
// widens the cells, a bitmap slot gets bitmap cells, and the wasm core lays
// out the glyphs the module adds. The rasterizer here is a stand-in: Bun has
// no 2D canvas, so pixels come from a function and the browser's own face is
// exercised by the hosts that run in a page.

import { describe, expect, test } from "bun:test";
import opentype from "opentype.js";
import { bakeSlot } from "../framework/compiler/bake-font.ts";
import { FONT_CMAP_ENTRY_SIZE, FONT_HEADER_SIZE, FONT_MAGIC } from "../contracts/spec/spec.ts";
import * as glyphs from "../hosts/web/runtime-glyphs.js";
import { createWasmUi } from "../hosts/web/wasm-ops.js";

const ASCII = Array.from({ length: 95 }, (_, i) => 32 + i);
const inter = opentype.parse(await Bun.file("assets/fonts/Inter-Regular.ttf").arrayBuffer());
const bake = (slot: number, px: number, density = 1) => bakeSlot(inter, slot, px, false, ASCII, density).bytes;

/** A stand-in rasterizer: a filled box `width` px wide, its advance one px wider. */
function boxes(width: number) {
  return (_cp: number, atlas: { density: number; cellH: number }) => {
    const d = atlas.density;
    return { advance: width + 1, width, coverage: new Uint8Array(width * d * atlas.cellH * d).fill(200) };
  };
}

describe("runtime glyphs: the atlas copy", () => {
  test("the module's format constants are the spec's", () => {
    expect([glyphs.FONT_MAGIC, glyphs.FONT_HEADER_SIZE, glyphs.FONT_CMAP_ENTRY_SIZE]).toEqual([FONT_MAGIC, FONT_HEADER_SIZE, FONT_CMAP_ENTRY_SIZE]);
  });

  test("a baked atlas parses and serializes back to the same bytes", () => {
    for (const density of [1, 2]) {
      const blob = bake(2, 16, density);
      const atlas = glyphs.parseAtlas(blob)!;
      expect(atlas.density).toBe(density);
      expect(atlas.known.has(0x48)).toBe(true);
      expect(Buffer.from(glyphs.serializeAtlas(atlas)).equals(Buffer.from(blob))).toBe(true);
    }
  });

  test("the em comes from the slot's cap height", () => {
    for (const px of [12, 16, 24]) {
      const atlas = glyphs.parseAtlas(bake(2, px))!;
      expect(Math.abs(atlas.em - px)).toBeLessThanOrEqual(1);
    }
  });

  test("an appended glyph keeps the cmap sorted and takes the next gid", () => {
    const atlas = glyphs.parseAtlas(bake(2, 16))!;
    const before = atlas.glyphs.length;
    expect(glyphs.appendGlyph(atlas, 0x65e5, boxes(4)(0x65e5, atlas))).toBe(true);
    expect(glyphs.appendGlyph(atlas, 0x3042, boxes(4)(0x3042, atlas))).toBe(true);
    const blob = glyphs.serializeAtlas(atlas);
    const view = new DataView(blob.buffer);
    expect(view.getUint16(6, true)).toBe(before + 2);
    const cps = Array.from({ length: before + 2 }, (_, i) => view.getUint32(FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE, true));
    expect(cps).toEqual([...cps].sort((a, b) => a - b));
    const again = glyphs.parseAtlas(blob)!;
    expect(again.glyphs.find((g: number[]) => g[0] === 0x65e5)![1]).toBe(before);
    expect(again.glyphs.find((g: number[]) => g[0] === 0x3042)![1]).toBe(before + 1);
  });

  test("a glyph wider than the cells widens every cell and keeps the old ink", () => {
    const blob = bake(2, 12, 2);
    const atlas = glyphs.parseAtlas(blob)!;
    const oldW = atlas.cellW;
    const gidH = atlas.glyphs.find((g: number[]) => g[0] === 0x48)![1];
    const inkOf = (a: typeof atlas, gid: number) => {
      const w = a.cellW * a.density, h = a.cellH * a.density;
      return Array.from(a.coverage.subarray(gid * w * h, (gid + 1) * w * h)).reduce((sum: number, v: number) => sum + v, 0);
    };
    const ink = inkOf(atlas, gidH);
    glyphs.appendGlyph(atlas, 0x6f22, boxes(oldW + 6)(0x6f22, atlas));
    expect(atlas.cellW).toBe(oldW + 6);
    expect(inkOf(atlas, gidH)).toBe(ink);
    expect(glyphs.parseAtlas(glyphs.serializeAtlas(atlas))!.cellW).toBe(oldW + 6);
  });

  test("a bitmap slot gets bitmap cells", () => {
    const blob = bake(2, 16);
    const atlas = glyphs.parseAtlas(blob)!;
    for (let i = 0; i < atlas.coverage.length; i++) atlas.coverage[i] = atlas.coverage[i]! >= 128 ? 255 : 0;
    const bitmap = glyphs.parseAtlas(glyphs.serializeAtlas(atlas))!;
    expect(bitmap.bilevel).toBe(true);
    glyphs.appendGlyph(bitmap, 0x3042, boxes(5)(0x3042, bitmap));
    const w = bitmap.cellW, h = bitmap.cellH, gid = bitmap.glyphs.length - 1;
    const cell = bitmap.coverage.subarray(gid * w * h, (gid + 1) * w * h);
    expect(new Set(cell)).toEqual(new Set([255, 0]));
  });
});

describe("runtime glyphs: the core lays them out", () => {
  test("text with codepoints no atlas maps measures with the added advances", async () => {
    const wasm = await createWasmUi(await Bun.file("hosts/web/pocketjs.wasm").arrayBuffer());
    wasm.init(1);
    const plain = await createWasmUi(await Bun.file("hosts/web/pocketjs.wasm").arrayBuffer());
    plain.init(1);
    const installed = glyphs.installRuntimeGlyphs(wasm.ops, { rasterize: boxes(10), now: () => 0 });
    wasm.ops.loadFontAtlas(bake(2, 16));
    plain.ops.loadFontAtlas(bake(2, 16));

    const tofu = plain.ops.measureText("日本語", 2);
    expect(wasm.ops.measureText("日本語", 2)).toBe(3 * 11);
    expect(tofu).not.toBe(3 * 11);
    // ASCII keeps the baked advances.
    expect(wasm.ops.measureText("Pocket", 2)).toBe(plain.ops.measureText("Pocket", 2));
    expect(installed.stats()).toMatchObject({ glyphs: 3, cells: 3, slots: 1 });
  });

  test("an atlas loaded later gets the glyphs already drawn, and set text flushes before the next measure", async () => {
    const wasm = await createWasmUi(await Bun.file("hosts/web/pocketjs.wasm").arrayBuffer());
    wasm.init(1);
    const installed = glyphs.installRuntimeGlyphs(wasm.ops, { rasterize: boxes(8), now: () => 0 });
    wasm.ops.loadFontAtlas(bake(2, 16));
    installed.ensure("かな");
    wasm.ops.loadFontAtlas(bake(9, 16));
    expect(wasm.ops.measureText("かな", 9)).toBe(2 * 9);
    expect(wasm.ops.measureText("かな", 2)).toBe(2 * 9);
    expect(installed.stats().cells).toBe(4);
  });

  test("text that the atlases cover adds nothing", async () => {
    const wasm = await createWasmUi(await Bun.file("hosts/web/pocketjs.wasm").arrayBuffer());
    wasm.init(1);
    let drawn = 0;
    const installed = glyphs.installRuntimeGlyphs(wasm.ops, { rasterize: (cp: number, atlas: { density: number; cellH: number }) => (drawn++, boxes(6)(cp, atlas)), now: () => 0 });
    wasm.ops.loadFontAtlas(bake(2, 16));
    wasm.ops.measureText("Plain ASCII, 123.", 2);
    installed.flush();
    expect(drawn).toBe(0);
    expect(installed.stats().reloads).toBe(0);
  });
});
