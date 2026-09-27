// Pocket Chan ships baked art and a baked CJK face: both are generated
// artefacts that a source edit can silently invalidate. These cases fail the
// two ways that happens — a clip renamed out from under the sheet, and a
// string edited without re-subsetting the font (which ships tofu, not an
// error).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import opentype from "opentype.js";
import { decodePng } from "../framework/compiler/pak.ts";
import { PALETTE, POSES, SET_NAME, UI, type Say } from "../apps/pocket-chan/chan.ts";

const APP = resolve(import.meta.dir, "../apps/pocket-chan");
const CELL = 128;

interface SpriteMeta { cols: number; rows: number; frames: number; step: number; psm?: number }
const sprites = JSON.parse(readFileSync(`${APP}/sprites.json`, "utf8")) as Record<string, SpriteMeta>;

test("every clip on the sheet has an atlas, and every atlas is on the sheet", () => {
  expect(POSES.map((p) => p.sprite).sort()).toEqual(Object.keys(sprites).sort());
  for (const pose of POSES) expect(pose.sprite).toBe(`chan-${pose.key}.png`);
});

test("atlases are pow2, fit their grid, and keep every frame inside its cell", () => {
  const pow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;
  for (const [name, meta] of Object.entries(sprites)) {
    const img = decodePng(new Uint8Array(readFileSync(`${APP}/${name}`)));
    expect(pow2(img.width)).toBe(true);
    expect(pow2(img.height)).toBe(true);
    expect(img.width).toBe(meta.cols * CELL);
    expect(img.height).toBe(meta.rows * CELL);
    expect(meta.frames).toBeLessThanOrEqual(meta.cols * meta.rows);
    expect(meta.step).toBeGreaterThan(0);

    // A frame that touches its cell edge bleeds into the neighbouring frame,
    // because the atlas samples adjacent cells with no gutter.
    for (let f = 0; f < meta.frames; f += 1) {
      const ox = (f % meta.cols) * CELL;
      const oy = Math.floor(f / meta.cols) * CELL;
      let inked = 0;
      for (let y = 0; y < CELL; y += 1) {
        for (let x = 0; x < CELL; x += 1) {
          const a = img.rgba[((oy + y) * img.width + ox + x) * 4 + 3];
          if (a === 0) continue;
          inked += 1;
          expect(x).toBeGreaterThan(0);
          expect(y).toBeGreaterThan(0);
          expect(x).toBeLessThan(CELL - 1);
          expect(y).toBeLessThan(CELL - 1);
        }
      }
      expect(inked).toBeGreaterThan(500); // a blank cell is a baking failure
    }
  }
});

test("the baked subset covers every character the sheet spells", () => {
  const font = opentype.parse(
    readFileSync(`${APP}/chan-cjk.otf`).buffer as ArrayBuffer,
  );
  const wanted = new Set<number>();
  for (const file of ["chan.ts", "app.tsx"]) {
    for (const ch of readFileSync(`${APP}/${file}`, "utf8")) {
      const cp = ch.codePointAt(0)!;
      // The primary face (Inter) covers Latin; the fallback only has to carry
      // what Inter lacks, which is everything above the Latin-1 block.
      if (cp > 0x2e7f) wanted.add(cp);
    }
  }
  expect(wanted.size).toBeGreaterThan(100);
  const missing = [...wanted].filter((cp) => font.charToGlyphIndex(String.fromCodePoint(cp)) <= 0);
  expect(missing.map((cp) => `U+${cp.toString(16).toUpperCase()} ${String.fromCodePoint(cp)}`)).toEqual([]);
});

test("every string is present in all three languages", () => {
  const rows: Say[] = [
    ...SET_NAME,
    ...Object.values(UI),
    ...PALETTE.map((s) => s.name),
    ...POSES.map((p) => p.name),
    ...POSES.flatMap((p) => p.lines),
  ];
  for (const row of rows) {
    expect(row).toHaveLength(3);
    for (const value of row) expect(value.trim().length).toBeGreaterThan(0);
  }
  for (const pose of POSES) expect(pose.lines.length).toBeGreaterThan(0);
});
