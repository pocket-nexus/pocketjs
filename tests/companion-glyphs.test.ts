// tests/companion-glyphs.test.ts — the companion's glyphs service
// (tools/companion/services/glyphs.ts): an app posts the text it is about to
// show and gets a FONT ATLAS v3 for its slot holding printable ASCII and
// every codepoint of the text. A fake rasterizer stands in for CoreText.

import { describe, expect, test } from "bun:test";
import { FONT_CMAP_ENTRY_SIZE, FONT_HEADER_SIZE, FONT_MAGIC } from "../contracts/spec/spec.ts";
import { atlasFont, type GlyphCell } from "../tools/companion/glyphs.ts";
import type { ServiceProvider } from "../tools/companion/services.ts";
import { createGlyphsService, glyphCapacity } from "../tools/companion/services/glyphs.ts";
import { call, serviceContext } from "./helpers/companion-service.ts";

const post = (glyphs: ServiceProvider, body: unknown, path = "/atlas", method = "POST", maxBytes = 256 * 1024) =>
  call(glyphs, path, { method, maxBytes, body: typeof body === "string" ? body : JSON.stringify(body) });

/** A rasterizer that draws every codepoint but U+E000 as a full cell. */
function fakeRaster(asked: { px: number; bold: boolean; codepoints: number[] }[]) {
  return (px: number, bold: boolean) => ({
    async cells(codepoints: Iterable<number>) {
      const list = [...codepoints];
      asked.push({ px, bold, codepoints: list });
      const font = atlasFont(px);
      const out = new Map<number, GlyphCell | null>();
      for (const cp of list) out.set(cp, cp === 0xe000 ? null : { advance: cp >= 0x2e80 ? px : Math.round(px * 0.6), xoff: 0, coverage: new Uint8Array(font.cellW * font.cellH).fill(200) });
      return out;
    },
    close() {},
  });
}

function readAtlas(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(6, true);
  const codepoints: number[] = [];
  for (let index = 0; index < count; index++) codepoints.push(view.getUint32(FONT_HEADER_SIZE + index * FONT_CMAP_ENTRY_SIZE, true));
  return { magic: view.getUint32(0, true), count, cellW: bytes[8]!, cellH: bytes[9]!, slot: bytes[12]!, flags: bytes[13]!, codepoints };
}

const context = serviceContext();

describe("the glyphs service", () => {
  test("an atlas for the slot holds ASCII and the text's codepoints, bold flagged", async () => {
    const asked: { px: number; bold: boolean; codepoints: number[] }[] = [];
    const glyphs = createGlyphsService(context, { rasterizer: fakeRaster(asked) });
    const response = await post(glyphs, { px: 13, bold: true, slot: 22, text: "你好 Pocket 🙂\u{e000}" });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/x-pocket-font");
    const atlas = readAtlas(response.body);
    expect(atlas.magic).toBe(FONT_MAGIC);
    expect(atlas.slot).toBe(22);
    expect(atlas.flags & 1).toBe(1);
    expect([atlas.cellW, atlas.cellH]).toEqual([15, 19]);
    for (const ch of ["A", "~", " ", "你", "好", "🙂"]) expect(atlas.codepoints).toContain(ch.codePointAt(0)!);
    // A codepoint no font draws maps to the tofu box (gid 0), not a glyph of its own.
    expect(atlas.codepoints).not.toContain(0xe000);
    expect(asked[0]).toMatchObject({ px: 13, bold: true });
    // The cmap is sorted, as the core's binary search needs.
    expect([...atlas.codepoints].sort((a, b) => a - b)).toEqual(atlas.codepoints);
  });

  test("one rasterizer per size and weight", async () => {
    const asked: { px: number; bold: boolean; codepoints: number[] }[] = [];
    const glyphs = createGlyphsService(context, { rasterizer: fakeRaster(asked) });
    await post(glyphs, { px: 13, bold: false, slot: 21, text: "中" });
    await post(glyphs, { px: 13, bold: true, slot: 22, text: "中" });
    await post(glyphs, { px: 14, bold: false, slot: 21, text: "中" });
    expect(asked.map((call) => `${call.px}${call.bold ? "b" : ""}`)).toEqual(["13", "13b", "14"]);
  });

  test("bad requests are refused: size, slot, method, too many glyphs", async () => {
    const glyphs = createGlyphsService(context, { rasterizer: fakeRaster([]) });
    expect((await post(glyphs, { px: 4, bold: false, slot: 21, text: "" })).status).toBe(400);
    expect((await post(glyphs, { px: 13, bold: false, slot: 24, text: "" })).status).toBe(400);
    expect((await post(glyphs, "not json")).status).toBe(400);
    expect((await post(glyphs, {}, "/atlas", "GET")).status).toBe(404);
  });

  test("an atlas past the request's maxBytes is refused with the count that fits", async () => {
    const glyphs = createGlyphsService(context, { rasterizer: fakeRaster([]) });
    const capacity = glyphCapacity(32, 256 * 1024);
    expect(capacity).toBe(169);
    const many = Array.from({ length: capacity - 95 + 1 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
    const refused = await post(glyphs, { px: 32, bold: false, slot: 21, text: many });
    expect(refused.status).toBe(413);
    expect(refused.json().capacity).toBe(capacity);
    const fits = await post(glyphs, { px: 32, bold: false, slot: 21, text: many.slice(0, -1) });
    expect(fits.status).toBe(200);
    expect(fits.body.length).toBeLessThanOrEqual(256 * 1024);
    const small = await post(glyphs, { px: 13, bold: false, slot: 21, text: "中" }, "/atlas", "POST", 2_000);
    expect(small.status).toBe(413);
  });

  test("a Mac without the CoreText helper says so", async () => {
    const glyphs = createGlyphsService(context, { rasterizer: () => ({ cells: async () => new Map(), close() {} }) });
    expect((await post(glyphs, { px: 13, bold: false, slot: 21, text: "中" })).status).toBe(503);
  });

  test("an atlas of the most glyphs a 13 px slot asks for fits one NET response", async () => {
    const glyphs = createGlyphsService(context, { rasterizer: fakeRaster([]) });
    // The console's cap (shells' ui/glyphs.ts glyphCap): 891 at 13 px.
    const cap = Math.floor((256 * 1024 - 16 - 1024) / (8 + 15 * 19));
    const text = Array.from({ length: cap - 95 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
    const response = await post(glyphs, { px: 13, bold: false, slot: 21, text });
    expect(response.status).toBe(200);
    expect(response.body.length).toBeLessThanOrEqual(256 * 1024);
  });
});
