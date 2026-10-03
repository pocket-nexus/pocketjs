import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  FONT_CMAP_ENTRY_SIZE,
  FONT_HEADER_SIZE,
  FONT_MAGIC,
  FONT_VERSION,
} from "../../../../contracts/spec/spec.ts";
import { compileClasses } from "../../../../framework/compiler/tailwind.ts";

const outputDir = process.argv[2];
assert.ok(outputDir, "usage: w06b-fixture.ts <output-dir>");

const classes = compileClasses([
  "w-[173px] h-[91px] p-3 bg-[#123456] text-xs focus:bg-[#a1b2c3] active:opacity-50",
]);
assert.equal(classes.records.length, 1);
const record = classes.records[0];
assert.ok(record);

// A compact, known v3 atlas: two cmap entries and 48 distinguishable coverage bytes.
const cellW = 3;
const cellH = 2;
const density = 2;
const glyphs = [
  { codepoint: 0x41, gid: 1, advance: 5, xoff: 1 },
  { codepoint: 0xfffd, gid: 0, advance: 7, xoff: 0 },
];
const coverage = Uint8Array.from({ length: glyphs.length * cellW * cellH * density * density }, (_, i) =>
  (i * 37 + 11) & 0xff
);
const font = new Uint8Array(FONT_HEADER_SIZE + glyphs.length * FONT_CMAP_ENTRY_SIZE + coverage.length);
const fontView = new DataView(font.buffer);
fontView.setUint32(0, FONT_MAGIC, true);
fontView.setUint16(4, FONT_VERSION, true);
fontView.setUint16(6, glyphs.length, true);
font[8] = cellW;
font[9] = cellH;
font[10] = 2; // baseline
font[11] = 4; // line height
font[12] = 5; // font slot
font[13] = 1; // bold
font[14] = density;
for (let i = 0; i < glyphs.length; i++) {
  const glyph = glyphs[i];
  const offset = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
  fontView.setUint32(offset, glyph.codepoint, true);
  fontView.setUint16(offset + 4, glyph.gid, true);
  font[offset + 6] = glyph.advance;
  font[offset + 7] = glyph.xoff;
}
const coverageOffset = FONT_HEADER_SIZE + glyphs.length * FONT_CMAP_ENTRY_SIZE;
font.set(coverage, coverageOffset);

function cArray(name: string, bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push(`    ${Array.from(bytes.subarray(i, i + 16), (byte) => `0x${byte.toString(16).padStart(2, "0")}`).join(", ")},`);
  }
  return `static const uint8_t ${name}[] = {\n${lines.join("\n")}\n};`;
}

writeFileSync(
  `${outputDir}/w06b_fixture.h`,
  `#ifndef W06B_FIXTURE_H\n#define W06B_FIXTURE_H\n#include <stdint.h>\n${cArray("w06b_styles", classes.bin)}\n${cArray("w06b_font", font)}\n#endif\n`,
);

const styleText = [["B", record.base], ["F", record.focus], ["A", record.active]]
  .map(([variant, props]) => `${variant}[${(props ?? []).map(({ prop, value }) => `${prop}:${value.toString(16).padStart(8, "0")}`).join(",")}]`)
  .join("/");
const cmapText = glyphs
  .map((_, i) => {
    const offset = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
    return `${fontView.getUint32(offset, true).toString(16).padStart(8, "0")}:${fontView.getUint16(offset + 4, true)}:${font[offset + 6]}:${font[offset + 7]}`;
  })
  .join(",");
const atlasText = [
  font[12], font[13], fontView.getUint16(6, true), font[8], font[9], font[10], font[11],
  font[14], font[8] * density, font[9] * density,
].join(",");
const coverageText = Array.from(font.subarray(coverageOffset), (byte) => byte.toString(16).padStart(2, "0")).join("");
console.log(
  `W06B PASS styles=${classes.records.length} style=${styleText} atlas=${atlasText} cmap=${cmapText} coverage=${coverageText}`,
);
