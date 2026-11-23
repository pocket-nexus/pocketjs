import { describe, expect, test } from "bun:test";
import { encodeAtlas, GlyphTable, needsRuntime, parseAtlas, planParts, splitRuns, type AtlasGlyph } from "../../framework/src/pocketui/core/glyphfont.ts";

/** A glyph whose cell is filled with a value of its own, so a cell can be told from another after a round trip. */
const glyph = (cp: number, cellW: number, cellH: number, density: number, advance = cellW): AtlasGlyph => ({ cp, advance, xoff: 0, cell: new Uint8Array(cellW * density * cellH * density).fill(cp % 251) });
const atlas = (cps: number[], options: { cellW?: number; cellH?: number; density?: number; baseline?: number; advance?: number } = {}) => {
  const cellW = options.cellW ?? 13;
  const cellH = options.cellH ?? 18;
  const density = options.density ?? 2;
  return encodeAtlas({ slot: 21, cellW, cellH, baseline: options.baseline ?? 14, lineHeight: 18, density, glyphs: cps.map((cp) => glyph(cp, cellW, cellH, density, options.advance)) });
};
const cps = (text: string) => [...text].map((ch) => ch.codePointAt(0)!);

describe("parseAtlas", () => {
  test("reads the geometry and each glyph's cell", () => {
    const parsed = parseAtlas(atlas(cps("你好"), { density: 3 }))!;
    expect([parsed.cellW, parsed.cellH, parsed.baseline, parsed.lineHeight, parsed.density]).toEqual([13, 18, 14, 18, 3]);
    expect(parsed.glyphs.map((g) => g.cp)).toEqual(cps("你好").sort((a, b) => a - b));
    expect(parsed.glyphs[0]!.cell.length).toBe(13 * 3 * 18 * 3);
    expect(parsed.glyphs[0]!.cell[0]).toBe(parsed.glyphs[0]!.cp % 251);
  });
  test("refuses what is not an atlas", () => {
    expect(parseAtlas(new Uint8Array(4))).toBeNull();
    const bytes = atlas(cps("你"));
    expect(parseAtlas(bytes.subarray(0, bytes.length - 10))).toBeNull();
    bytes[0] = 0;
    expect(parseAtlas(bytes)).toBeNull();
  });
});

describe("GlyphTable", () => {
  test("grows by what each reply adds and keeps what it had", () => {
    const table = new GlyphTable(13);
    expect(table.add(parseAtlas(atlas(cps("你好")))!, cps("你好"))).toBe(2);
    expect(table.add(parseAtlas(atlas(cps("好世界")))!, cps("世界"))).toBe(2);
    expect(table.size).toBe(4);
    expect(table.covers("你好世界")).toBe(true);
    expect(table.missing(["你好吗"])).toEqual(cps("吗"));
  });
  test("its atlas holds every glyph with the cell it arrived with", () => {
    const table = new GlyphTable(13);
    table.add(parseAtlas(atlas(cps("你好")))!);
    table.add(parseAtlas(atlas(cps("世界A")))!);
    const built = parseAtlas(table.build(21, false)!)!;
    expect(built.glyphs.map((g) => g.cp)).toEqual(cps("A你好世界").sort((a, b) => a - b));
    for (const g of built.glyphs) expect(g.cell.every((value) => value === g.cp % 251)).toBe(true);
    expect([built.cellW, built.cellH, built.baseline, built.density]).toEqual([13, 18, 14, 2]);
  });
  test("a character the service has no glyph for is asked for once", () => {
    const table = new GlyphTable(13);
    table.add(parseAtlas(atlas(cps("你")))!, cps("你\u{10ffff}"));
    expect(table.missing(["你\u{10ffff}"])).toEqual([]);
    expect(table.covers("\u{10ffff}")).toBe(true);
    expect(table.has(0x10ffff)).toBe(false);
  });
  test("measures by advance, a character not here yet at the face's size", () => {
    const table = new GlyphTable(13);
    table.add(parseAtlas(atlas(cps("a"), { advance: 7 }))!);
    table.add(parseAtlas(atlas(cps("你")))!);
    expect(table.measure("a你a")).toBe(7 + 13 + 7);
    expect(table.measure("好")).toBe(13);
  });
  test("a wider reply widens the table and pads the cells it had", () => {
    const table = new GlyphTable(13);
    table.add(parseAtlas(atlas(cps("你"), { cellW: 13 }))!);
    table.add(parseAtlas(atlas([0x1f600], { cellW: 16 }))!);
    expect(table.cellW).toBe(16);
    const built = parseAtlas(table.build(21, false)!)!;
    const ni = built.glyphs.find((g) => g.cp === 0x4f60)!;
    // the first row: 26 samples of the glyph, then the padding
    expect([...ni.cell.subarray(0, 32)]).toEqual([...new Array(26).fill(0x4f60 % 251), ...new Array(6).fill(0)]);
    // a narrower reply after it is padded as it arrives
    table.add(parseAtlas(atlas(cps("好"), { cellW: 13 }))!);
    expect(parseAtlas(table.build(21, false)!)!.glyphs.find((g) => g.cp === 0x597d)!.cell.length).toBe(32 * 36);
  });
  test("refuses a reply of another density", () => {
    const table = new GlyphTable(13);
    table.add(parseAtlas(atlas(cps("你")))!);
    expect(table.add(parseAtlas(atlas(cps("好"), { density: 3 }))!)).toBe(-1);
    expect(table.size).toBe(1);
  });
  test("past its capacity the glyphs named longest ago go", () => {
    const table = new GlyphTable(13, 12);
    const first = Array.from({ length: 10 }, (_, i) => 0x4e00 + i);
    table.add(parseAtlas(atlas(first))!);
    expect(table.evict()).toBe(0);
    // the first five are named again; five more arrive
    table.missing([String.fromCodePoint(...first.slice(0, 5))]);
    table.add(parseAtlas(atlas([0x5000, 0x5001, 0x5002, 0x5003, 0x5004]))!);
    expect(table.evict()).toBe(5);
    expect(table.size).toBe(10);
    for (const cp of first.slice(0, 5)) expect(table.has(cp)).toBe(true);
    expect(first.slice(5).filter((cp) => table.has(cp)).length).toBe(0);
    expect(table.evictions).toBe(5);
  });
  test("the box for a missing character is empty and one size wide", () => {
    const table = new GlyphTable(13);
    table.add(parseAtlas(atlas(cps("你")))!);
    const bytes = table.build(21, true)!;
    expect(bytes[13]).toBe(1);
    const view = new DataView(bytes.buffer);
    // two cmap entries, ascending: the glyph, then U+FFFD as glyph 0
    expect(view.getUint32(16, true)).toBe(0x4f60);
    expect(view.getUint32(24, true)).toBe(0xfffd);
    expect(view.getUint16(28, true)).toBe(0);
    expect(bytes[30]).toBe(13);
    const cell = 26 * 36;
    expect(bytes.subarray(32, 32 + cell).every((value) => value === 0)).toBe(true);
  });
});

describe("splitRuns", () => {
  const show = (text: string) => splitRuns(text).map((run) => `${run.runtime ? "R" : "B"}:${run.text}`);
  test("ASCII is one baked run", () => {
    expect(show("plain text")).toEqual(["B:plain text"]);
    expect(show("")).toEqual([]);
  });
  test("wide characters go to the run-time face, the Latin beside them stays", () => {
    expect(show("运行 bun test 然后提交")).toEqual(["R:运行", "B: bun test ", "R:然后提交"]);
    expect(show("修复sync的问题")).toEqual(["R:修复", "B:sync", "R:的问题"]);
  });
  test("a word with a letter outside ASCII goes whole", () => {
    expect(show("a naïve café test")).toEqual(["B:a ", "R:naïve", "B: ", "R:café", "B: test"]);
    expect(show("Привет, world")).toEqual(["R:Привет,", "B: world"]);
  });
  test("an emoji is a wide character, both halves of it", () => {
    expect(show("ok 😀 done")).toEqual(["B:ok ", "R:😀", "B: done"]);
  });
  test("line breaks stay with the baked face", () => {
    expect(show("你好\n世界")).toEqual(["R:你好", "B:\n", "R:世界"]);
  });
  test("needsRuntime", () => {
    expect(needsRuntime("abc\n\t~")).toBe(false);
    expect(needsRuntime("abc é")).toBe(true);
  });
});

describe("planParts", () => {
  test("cuts by the bytes a request can name and the glyphs a reply can carry", () => {
    const wide = Array.from({ length: 10 }, (_, i) => 0x4e00 + i);
    expect(planParts(wide, 9, 100).map((part) => part.length)).toEqual([3, 3, 3, 1]);
    expect(planParts(wide, 1000, 4).map((part) => part.length)).toEqual([4, 4, 2]);
    expect(planParts([0x41, 0xe9, 0x4e00, 0x1f600], 6, 100)).toEqual([[0x41, 0xe9, 0x4e00], [0x1f600]]);
    expect(planParts([], 10, 10)).toEqual([]);
  });
});

describe("characters that have no glyph", () => {
  test("half a surrogate pair and control characters are never asked for", () => {
    const table = new GlyphTable(13);
    expect(table.missing(["a\ud800b\n\t"])).toEqual([0x61, 0x62]);
    expect(table.covers("\udc00\n")).toBe(true);
  });
});
