// vapor/tests/gb-font.test.ts — the bytes the GB font actually puts in VRAM.
//
// The compiler emits FONT8 as 1bpp and vapor_gb.c's upload_font() expands it to
// the DMG's 2bpp interleaved tile format, twice: style 0 = ink shade 3 on paper
// 0, style 1 = the inverse. This test does not trust either side. It boots a
// real todo.gb in headless libmgba, reads all 3040 B of tile data the runtime
// wrote at 0x8010, and compares it byte for byte against a reference expansion
// built here from FONT8 and the DMG pixel-format rule alone.
//
// Any bit the expansion drops, duplicates, or inverts wrongly shows up as a
// byte mismatch with its glyph, style, row and plane named.

import { beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { compileVaporApp } from "../compiler/compile.ts";
import { buildRom } from "../compiler/rom.ts";
import { FONT8 } from "../compiler/font.gen.ts";

const HERE = import.meta.dir;
const ENTRY = join(HERE, "..", "examples", "todo", "todo.tsx");
const OUT = join(HERE, "..", "..", "dist", "vapor");
const MGBA_RUNNER = join(HERE, "harness", "mgba_runner");

const GLYPHS = 95;
const TILE_BYTES = 16; // 8 rows x 2 planes
const FONT_VRAM = 0x8010; // tile 0 stays blank
const FONT_BYTES = 2 * GLYPHS * TILE_BYTES; // 3040

/** DMG 2bpp interleaved, from FONT8 and the hardware rule only: per row,
 * byte 0 holds bit 0 of every pixel and byte 1 holds bit 1, MSB leftmost.
 * Style 0 paints set pixels shade 3 on shade 0; style 1 swaps them. */
function referenceFontVram(): number[] {
  const out: number[] = [];
  for (const [ink, paper] of [
    [3, 0],
    [0, 3],
  ]) {
    for (let g = 0; g < GLYPHS; g++) {
      for (let y = 0; y < 8; y++) {
        let plane0 = 0;
        let plane1 = 0;
        for (let x = 0; x < 8; x++) {
          const shade = FONT8[g][y] & (0x80 >> x) ? ink : paper;
          if (shade & 1) plane0 |= 0x80 >> x;
          if (shade & 2) plane1 |= 0x80 >> x;
        }
        out.push(plane0, plane1);
      }
    }
  }
  return out;
}

/** Names a byte index inside the font region, so a failure reads as a place. */
function locate(i: number): string {
  const style = Math.floor(i / (GLYPHS * TILE_BYTES));
  const within = i % (GLYPHS * TILE_BYTES);
  const glyph = Math.floor(within / TILE_BYTES);
  const row = Math.floor((within % TILE_BYTES) / 2);
  const plane = i % 2;
  const ch = String.fromCharCode(0x20 + glyph);
  return `style ${style} glyph ${glyph} ('${ch}') row ${row} plane ${plane}`;
}

let vram: number[] = [];

beforeAll(async () => {
  if (!existsSync(MGBA_RUNNER)) await $`bun ${join(HERE, "harness", "build.ts")}`.quiet();
  const source = await Bun.file(ENTRY).text();
  const app = compileVaporApp(ENTRY, source, "VAPOR TODO", "gb");
  const rom = join(OUT, "gb-font.gb");
  await buildRom(app, "gb", rom);

  // app_init alone spans ~26 video frames on the 1 MHz SM83; upload_font runs
  // before it, but hold the same generous margin the parity rig uses.
  const scenario = join(OUT, "gb-font-scenario.txt");
  await Bun.write(scenario, `A 90\nD font 0x${FONT_VRAM.toString(16)} ${FONT_BYTES}\n`);
  const out = await $`${MGBA_RUNNER} ${rom} ${scenario}`.text();
  const parsed = JSON.parse(out) as { ok: boolean; reads: Record<string, string> };
  expect(parsed.ok).toBe(true);
  const hex = parsed.reads.font;
  expect(hex).toHaveLength(FONT_BYTES * 2);
  vram = Array.from({ length: FONT_BYTES }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}, 120000);

test("gb: every font byte in real VRAM matches the reference 2bpp expansion", () => {
  const want = referenceFontVram();
  expect(want).toHaveLength(FONT_BYTES);
  const mismatches = want
    .map((b, i) => (b === vram[i] ? null : `${locate(i)}: got 0x${vram[i].toString(16)} want 0x${b.toString(16)}`))
    .filter((m): m is string => m !== null);
  expect(mismatches).toEqual([]);
});

test("gb: the uploaded font carries FONT8's bits, both planes and both styles", () => {
  // Not a restatement of the reference: these are the three structural facts
  // the 1bpp encoding relies on, read off the emulator's VRAM directly.
  for (let g = 0; g < GLYPHS; g++) {
    for (let y = 0; y < 8; y++) {
      const at0 = (g * TILE_BYTES + y * 2) | 0;
      const at1 = GLYPHS * TILE_BYTES + at0;
      const ch = `glyph ${g} ('${String.fromCharCode(0x20 + g)}') row ${y}`;
      // style 0: both planes equal the FONT8 row (shade 3 where a bit is set)
      expect(`${ch} p0 ${vram[at0]}`).toBe(`${ch} p0 ${FONT8[g][y]}`);
      expect(`${ch} p1 ${vram[at0 + 1]}`).toBe(`${ch} p1 ${FONT8[g][y]}`);
      // style 1: the bitwise complement of style 0, in both planes
      expect(`${ch} inv p0 ${vram[at1]}`).toBe(`${ch} inv p0 ${(~FONT8[g][y]) & 0xff}`);
      expect(`${ch} inv p1 ${vram[at1 + 1]}`).toBe(`${ch} inv p1 ${(~FONT8[g][y]) & 0xff}`);
    }
  }
});

test("gb: tile 0 stays blank and the font region ends where the next tile begins", async () => {
  const scenario = join(OUT, "gb-font-edges.txt");
  await Bun.write(
    scenario,
    ["A 90", "D tile0 0x8000 16", `D after 0x${(FONT_VRAM + FONT_BYTES).toString(16)} 16`].join("\n") + "\n",
  );
  const rom = join(OUT, "gb-font.gb");
  const out = await $`${MGBA_RUNNER} ${rom} ${scenario}`.text();
  const parsed = JSON.parse(out) as { ok: boolean; reads: Record<string, string> };
  expect(parsed.ok).toBe(true);
  expect(parsed.reads.tile0).toBe("0".repeat(32));
  // upload_font must not run past its 3040 bytes into the tile after the font.
  expect(parsed.reads.after).toBe("0".repeat(32));
});
