// The GBA ROM ships the font 1bpp (760 B) and expands it to 4bpp tiles during
// upload_font(). That trade is only safe if the bytes reaching VRAM are the
// ones the old 3040 B vp_font_tiles table used to carry, so the load-bearing
// assertion here reads the real font charblock out of a booted ROM in mgba and
// compares all 3040 bytes against the reference encoding. The parity suite
// cannot cover this: its GBA rig probes the screenblock at 0x6004000, which
// holds tile indices and palette banks, never glyph pixels.

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { compileVaporApp, gbaFontTileBytes } from "../compiler/compile.ts";
import { buildRom } from "../compiler/rom.ts";
import { FONT8 } from "../compiler/font.gen.ts";

const HERE = import.meta.dir;
const ENTRY = join(HERE, "..", "examples", "todo", "todo.tsx");
const OUT = join(HERE, "..", "..", "dist", "vapor");
const MGBA_RUNNER = join(HERE, "harness", "mgba_runner");

/** Tile 0 stays blank, so glyph tiles start one 32 B tile into charblock 0. */
const FONT_VRAM_ADDR = 0x06000020;
const FONT_VRAM_BYTES = 95 * 32;

let vram: Uint8Array;

beforeAll(async () => {
  if (!existsSync(MGBA_RUNNER)) await $`bun ${join(HERE, "harness", "build.ts")}`.quiet();
  const source = await Bun.file(ENTRY).text();
  const app = compileVaporApp(ENTRY, source, "VAPOR TODO", "gba");
  const rom = join(OUT, "gba-font.gba");
  await buildRom(app, "gba", rom);

  const scenario = join(OUT, "gba-font.txt");
  await Bun.write(scenario, `A 5\nD font 0x${FONT_VRAM_ADDR.toString(16)} ${FONT_VRAM_BYTES}\n`);
  const out = await $`${MGBA_RUNNER} ${rom} ${scenario}`.text();
  const parsed = JSON.parse(out) as { ok: boolean; reads: Record<string, string> };
  expect(parsed.ok).toBe(true);
  vram = Uint8Array.from(Buffer.from(parsed.reads.font, "hex"));
}, 120000);

describe("gba font ships 1bpp and expands at boot", () => {
  test("the emitted table is the 1bpp bitmap, not the 4bpp expansion", async () => {
    const source = await Bun.file(ENTRY).text();
    const app = compileVaporApp(ENTRY, source, "VAPOR TODO", "gba");
    const font = app.c.match(/const u8 vp_font_tiles\[\] = \{ ([^}]*) \};/);
    expect(font).not.toBeNull();
    const bytes = font![1].split(",").map(Number);
    expect(bytes).toHaveLength(95 * 8);
    expect(bytes).toEqual(FONT8.flat());
    expect(app.plan).toContain("760 B font");
  });

  test("upload_font writes every one of the 3040 4bpp bytes the old table held", () => {
    const want = gbaFontTileBytes();
    expect(want).toHaveLength(FONT_VRAM_BYTES);
    expect(vram).toHaveLength(FONT_VRAM_BYTES);
    // Compare as hex so a mismatch names the offset instead of dumping 3040 numbers.
    const hex = (a: ArrayLike<number>) =>
      Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex(vram)).toBe(hex(want));
  });

  test("every expanded pixel is ink(1) or paper(2), matching the glyph bitmap", () => {
    // Independent of gbaFontTileBytes: walks FONT8 and checks the nibble that
    // upload_font must have produced for each of the 95x8x8 pixels.
    for (let g = 0; g < 95; g++) {
      for (let y = 0; y < 8; y++) {
        const row = FONT8[g][y];
        for (let x = 0; x < 8; x++) {
          const at = g * 32 + y * 4 + (x >> 1);
          const nibble = x % 2 === 0 ? vram[at] & 0x0f : vram[at] >> 4;
          const set = (row & (0x80 >> x)) !== 0;
          if (nibble !== (set ? 1 : 2)) {
            throw new Error(
              `glyph ${g} row ${y} pixel ${x}: bitmap ${set ? "set" : "clear"} but VRAM nibble ${nibble}`,
            );
          }
        }
      }
    }
  });
});
