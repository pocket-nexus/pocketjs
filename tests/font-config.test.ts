import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Font, Glyph, Path } from "opentype.js";
import { readFontConfig } from "../framework/compiler/font-config.ts";
import { bakeAtlases } from "../framework/compiler/bake-font.ts";
import { pack, unpack, PAK_DTYPE } from "../framework/compiler/pak.ts";
import { getText, loadPack, resetPack } from "../framework/src/pak.ts";

const directories: string[] = [];
afterEach(() => { resetPack(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function config(value: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "pocket-font-")); directories.push(dir);
  const path = join(dir, "fonts.json"); writeFileSync(path, JSON.stringify(value));
  return { dir, path };
}

function fallbackFace(path: string, familyName: string, advanceWidth: number) {
  const outline = new Path();
  outline.moveTo(100, 100); outline.lineTo(900, 100); outline.lineTo(900, 700); outline.lineTo(100, 700); outline.close();
  const face = new Font({
    familyName,
    styleName: "Regular",
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs: [
      new Glyph({ name: ".notdef", advanceWidth: 500, path: new Path() }),
      new Glyph({ name: "uni4E00", unicode: 0x4e00, advanceWidth, path: outline }),
    ],
  });
  writeFileSync(path, new Uint8Array(face.toArrayBuffer()));
}

test("runtime character policy tracks external data and preserves supplementary scalars", () => {
  const { dir, path } = config({ characters: "你", characterFiles: ["titles.txt"], ranges: ["U+3042-3044"] });
  writeFileSync(join(dir, "titles.txt"), "気迫\n你好\n𠮷");
  const reads: string[] = [];
  const result = readFontConfig(path, p => reads.push(p));
  expect(result.codepoints).toEqual([...new Set(Array.from("你気迫好𠮷あぃい", c => c.codePointAt(0)!))].sort((a,b) => a-b));
  expect(reads).toEqual([path, join(dir, "titles.txt")]);
});

test("malformed or oversized character policies fail before baking", () => {
  for (const value of [{ ranges: ["U+110000"] }, { ranges: ["U+FFFF-0000"] }, { ranges: ["U+0000-10FFFF"] },
    { characters: 1 }, { characterFiles: ["absent"] }, { charset: "typo" }]) {
    expect(() => readFontConfig(config(value).path)).toThrow();
  }
  const { dir, path } = config({ characterFiles: ["bad.txt"] });
  writeFileSync(join(dir, "bad.txt"), new Uint8Array([0xc0, 0xaf]));
  expect(() => readFontConfig(path)).toThrow();
});

test("fallback size policies reject invalid shapes before reading the face", () => {
  const face = resolve("assets/fonts/NotoSansCJK-Demo.otf");
  for (const [fallback, message] of [
    [1, "fallback must be an array"],
    [null, "fallback must be an array"],
    [[1], "fallback[0] must be a nonempty path string or an object"],
    [[""], "fallback[0] must be a nonempty path string or an object"],
    [[{}], "fallback[0].path must be a nonempty string"],
    [[{ path: face }], "fallback[0].sizes must be a nonempty array"],
    [[{ sizes: [16] }], "fallback[0].path must be a nonempty string"],
    [[{ path: face, sizes: [] }], "fallback[0].sizes must be a nonempty array"],
    [[{ path: face, sizes: [15] }], "fallback[0].sizes contains unsupported font size 15"],
    [[{ path: face, sizes: [16.5] }], "fallback[0].sizes must contain integer font sizes"],
    [[{ path: face, sizes: ["16"] }], "fallback[0].sizes must contain integer font sizes"],
    [[{ path: face, sizes: [16], slots: [2] }], "unknown field fallback[0].slots"],
  ] as const) {
    expect(() => readFontConfig(config({ fallback }).path)).toThrow(message);
  }
});

test("fallback entries preserve the all-size default and normalize explicit sizes", () => {
  const face = resolve("assets/fonts/NotoSansCJK-Demo.otf");
  const { path } = config({ fallback: [face, { path: face, sizes: [16, 12, 16] }] });
  expect(readFontConfig(path).fallbackTtfs).toEqual([
    face,
    { path: face, sizes: [12, 16] },
  ]);
});

test("the direct atlas API rejects unsupported fallback sizes", async () => {
  const face = resolve("assets/fonts/NotoSansCJK-Demo.otf");
  await expect(bakeAtlases({
    slots: [2],
    codepoints: ["你".codePointAt(0)!],
    fallbackTtfs: [{ path: face, sizes: [15] }],
  })).rejects.toThrow("unsupported fallback font size 15");
});

test("size filtering preserves the order of active fallback faces", async () => {
  const { dir } = config({});
  const first = join(dir, "first.otf"), second = join(dir, "second.otf");
  fallbackFace(first, "First fallback", 250);
  fallbackFace(second, "Second fallback", 750);
  const advance = async (firstSizes: number[]) => {
    const [atlas] = await bakeAtlases({
      slots: [2],
      codepoints: [0x4e00],
      fallbackTtfs: [{ path: first, sizes: firstSizes }, second],
    });
    const view = new DataView(atlas.bytes.buffer, atlas.bytes.byteOffset, atlas.bytes.byteLength);
    for (let index = 0; index < atlas.glyphCount; index++) {
      const at = 16 + index * 8;
      if (view.getUint32(at, true) === 0x4e00) return view.getUint8(at + 6);
    }
    throw new Error("test fallback glyph missing");
  };
  expect(await advance([12])).toBe(12);
  expect(await advance([16])).toBe(4);
});

test("declared ranges and dynamic CJK metadata have real baked glyphs", async () => {
  const text = "気迫你好世界" + Array.from({length:256},(_,i)=>String.fromCodePoint(0x4e00+i)).join("");
  const {path}=config({fallback:[resolve("assets/fonts/NotoSansCJK-Demo.otf")],characters:text});
  const settings=readFontConfig(path);
  const atlases=await bakeAtlases({...settings,slots:[0,2]});
  for (const atlas of atlases) {
    const dv = new DataView(atlas.bytes.buffer);
    const mapped = new Map<number, number>();
    for (let i = 0; i < atlas.glyphCount; i++) mapped.set(dv.getUint32(16 + i * 8, true), dv.getUint16(20 + i * 8, true));
    for (const c of text) expect(mapped.get(c.codePointAt(0)!), `slot ${atlas.slot}, ${c}`).toBeGreaterThan(0);
    expect(mapped.has(0x9fff)).toBe(false); // Coverage is explicit, not an all-Unicode claim.
  }
});

test("size-scoped fallbacks bake CJK only into matching slots and leave visible tofu elsewhere", async () => {
  const text = "你好";
  const { path } = config({
    fallback: [{ path: resolve("assets/fonts/NotoSansCJK-Demo.otf"), sizes: [16] }],
    characters: text,
  });
  const atlases = await bakeAtlases({ ...readFontConfig(path), slots: [0, 2, 9, 18] });
  const glyph = (atlas: (typeof atlases)[number], codepoint: number): number | undefined => {
    const view = new DataView(atlas.bytes.buffer, atlas.bytes.byteOffset, atlas.bytes.byteLength);
    for (let i = 0; i < atlas.glyphCount; i++) {
      const at = 16 + i * 8;
      if (view.getUint32(at, true) === codepoint) return view.getUint16(at + 4, true);
    }
  };
  for (const atlas of atlases.filter(atlas => atlas.px === 16)) {
    expect(glyph(atlas, "你".codePointAt(0)!)).toBeGreaterThan(0);
    expect(glyph(atlas, "好".codePointAt(0)!)).toBeGreaterThan(0);
  }
  const excluded = atlases.find(atlas => atlas.slot === 0)!;
  expect(glyph(excluded, "你".codePointAt(0)!)).toBeUndefined();
  expect(glyph(excluded, 0xfffd)).toBe(0);
  const coverageOffset = 16 + excluded.glyphCount * 8;
  const tofu = excluded.bytes.subarray(coverageOffset, coverageOffset + excluded.coverageW * excluded.coverageH);
  expect(tofu.some(sample => sample > 0)).toBe(true);
});

test("runtime UTF-8 data survives a pack round trip without TextDecoder on the guest", () => {
  const source = JSON.stringify([{ filename: "音楽/気迫.mp3" }, { filename: "音乐/你好.flac" }, { filename: "Sommarfågel.flac" }]);
  const bytes = pack([{ key: "library:tracks", dtype: PAK_DTYPE.u8, data: new TextEncoder().encode(source) }]);
  expect(unpack(bytes)).toHaveLength(1);
  loadPack(bytes.buffer as ArrayBuffer);
  const decoder = globalThis.TextDecoder;
  try {
    Object.assign(globalThis, { TextDecoder: undefined });
    expect(getText("library:tracks")).toBe(source);
  } finally { globalThis.TextDecoder = decoder; }
});
