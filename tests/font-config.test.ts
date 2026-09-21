import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

test("runtime fonts are explicit, tracked static TTF assets independent of baked coverage", () => {
  const font = resolve("assets/fonts/Inter-Regular.ttf");
  const { path } = config({ runtime: [font, font] });
  const reads: string[] = [];
  const settings = readFontConfig(path, p => reads.push(p));
  expect(settings.runtimeTtfs).toEqual([font]);
  expect(settings.fallbackTtfs).toEqual([]);
  expect(settings.codepoints).toEqual([]);
  expect(reads).toContain(font);
  expect(() => readFontConfig(config({ runtime: [resolve("assets/fonts/NotoSansCJK-Demo.otf")] }).path)).toThrow("static TrueType");
  expect(() => readFontConfig(config({ runtime: ["missing.ttf"] }).path)).toThrow("file not found");
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
