import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const outputDir = process.argv[2];
assert.ok(outputDir, "usage: w06c-fixture.ts <output-dir>");

const width = 4;
const height = 2;
const pixels = Uint8Array.from([0x00, 0x07, 0x2a, 0xff, 0x01, 0x80, 0x40, 0x10]);
const palette = new Uint8Array(256 * 4);
const paletteView = new DataView(palette.buffer);
for (let i = 0; i < 256; i++) {
  const color = (((0x40 + i) & 0xff) << 24)
    | (((0x80 + 3 * i) & 0xff) << 16)
    | (((0xc0 + 5 * i) & 0xff) << 8)
    | ((0x10 + 7 * i) & 0xff);
  paletteView.setUint32(i * 4, color >>> 0, true);
}

function cArray(name: string, bytes: Uint8Array): string {
  const rows: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    rows.push(`    ${Array.from(bytes.subarray(i, i + 16), (byte) => `0x${byte.toString(16).padStart(2, "0")}`).join(", ")},`);
  }
  return `static const uint8_t ${name}[] = {\n${rows.join("\n")}\n};`;
}

writeFileSync(
  `${outputDir}/w06c_fixture.h`,
  `#ifndef W06C_FIXTURE_H\n#define W06C_FIXTURE_H\n#include <stdint.h>\n${cArray("w06c_texture", new Uint8Array([...palette, ...pixels]))}\n#endif\n`,
);

const colors = Array.from(pixels, (index) => paletteView.getUint32(index * 4, true).toString(16).padStart(8, "0"));
const drawWords = [
  4, 0, 0x00020003, 0x00020004, 0, 0, 0x3f800000, 0x3f800000, 0xffffffff,
  9, 0, 0x41300000, 0x41100000, 0x41a00000, 0x41000000, 0xff12ab34, 3, 0x00a9c341,
];
console.log(
  `W06C PASS texture=${width}x${height}:5 pixels=${Array.from(pixels, (byte) => byte.toString(16).padStart(2, "0")).join("")} colors=${colors.join(",")} draw=${drawWords.map((word) => word.toString(16).padStart(8, "0")).join(",")}`,
);
