// tests/launcher-icon.test.ts — the launcher icon set a `.pocket` variant
// carries (contracts/spec/pocket-package.ts section 9, tools/launcher-icon.ts):
// every size cut to the rounded square and centred in its texture, at the
// variant's raster density, and a drawing for every Playset game.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POCKET_ICON_SIZES, decodeIconSet, encodeIconSet } from "../contracts/spec/pocket-package.ts";
import { bakeIconSet, manifestIconPath } from "../tools/launcher-icon.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/** One IMG entry's side and its RGBA texel at (x, y). */
function texel(image: Uint8Array, x: number, y: number): number[] {
  const side = new DataView(image.buffer, image.byteOffset).getUint16(0, true);
  const o = 8 + (y * side + x) * 4;
  return [...image.subarray(o, o + 4)];
}

describe("launcher icon set", () => {
  test("encodes and decodes its rows", () => {
    const entries = [{ icon: 24, texture: 32, image: new Uint8Array([1, 2, 3]) }, { icon: 46, texture: 64, image: new Uint8Array([4]) }];
    expect(decodeIconSet(encodeIconSet(entries))).toEqual(entries);
    expect(() => decodeIconSet(new Uint8Array(8))).toThrow("icon magic");
  });

  test("bakes every size masked and centred, at the raster density", async () => {
    const dir = mkdtempSync(join(tmpdir(), "launcher-icon-"));
    writeFileSync(join(dir, "icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#ff8000"/></svg>`);
    const manifestPath = join(dir, "pocket.json");
    expect(manifestIconPath(manifestPath, {})).toBeNull();
    expect(await bakeIconSet(manifestPath, {}, 1)).toBeUndefined();
    for (const density of [1, 2]) {
      const entries = decodeIconSet((await bakeIconSet(manifestPath, { icon: "icon.svg" }, density))!);
      expect(entries.map(({ icon, texture }) => ({ icon, texture }))).toEqual(POCKET_ICON_SIZES.map(({ icon, texture }) => ({ icon, texture })));
      for (const entry of entries) {
        const tex = entry.texture * density, pad = (tex - entry.icon * density) / 2;
        expect(new DataView(entry.image.buffer, entry.image.byteOffset).getUint16(0, true)).toBe(tex);
        expect(entry.image.length).toBe(8 + tex * tex * 4);
        // The middle is the drawing, the cut corner and the margin are clear.
        expect(texel(entry.image, tex / 2, tex / 2)).toEqual([255, 128, 0, 255]);
        expect(texel(entry.image, pad, pad)[3]).toBe(0);
        if (pad > 0) expect(texel(entry.image, 0, tex / 2)[3]).toBe(0);
        expect(texel(entry.image, pad, tex / 2)[3]).toBe(255);
      }
    }
  });

  test("every Playset game names an icon drawing that bakes", async () => {
    const games = readdirSync(join(ROOT, "apps/playset"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "kit")
      .map((entry) => join(ROOT, "apps/playset", entry.name, "pocket.json"));
    expect(games.length).toBeGreaterThanOrEqual(16);
    for (const manifestPath of games) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifestIconPath(manifestPath, manifest), manifestPath).toEndWith(".svg");
      expect(decodeIconSet((await bakeIconSet(manifestPath, manifest, 1))!)).toHaveLength(POCKET_ICON_SIZES.length);
    }
  }, 60_000);
});
