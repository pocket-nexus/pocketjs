import { writeFileSync } from "node:fs";
import { compileClasses } from "../../../../framework/compiler/tailwind.ts";
import { encodeImageEntry, pack } from "../../../../framework/compiler/pak.ts";
import {
  FONT_CMAP_ENTRY_SIZE,
  FONT_HEADER_SIZE,
  FONT_MAGIC,
  FONT_VERSION,
  PSM,
} from "../../../../contracts/spec/spec.ts";

const output = process.argv[2];
if (!output) throw new Error("usage: fixture.ts <output-dir>");

const styles = compileClasses(["w-[173px] h-[91px] p-3 bg-[#123456] text-xs"]);
const glyphs = [
  { codepoint: 0x41, gid: 1, advance: 5, xoff: 1 },
  { codepoint: 0xfffd, gid: 0, advance: 7, xoff: 0 },
];
const font = new Uint8Array(FONT_HEADER_SIZE + glyphs.length * FONT_CMAP_ENTRY_SIZE + 48);
const view = new DataView(font.buffer);
view.setUint32(0, FONT_MAGIC, true);
view.setUint16(4, FONT_VERSION, true);
view.setUint16(6, glyphs.length, true);
font.set([3, 2, 2, 4, 5, 1, 2], 8); // cells, baseline, line height, slot, bold, density
for (let i = 0; i < glyphs.length; i++) {
  const glyph = glyphs[i];
  const offset = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
  view.setUint32(offset, glyph.codepoint, true);
  view.setUint16(offset + 4, glyph.gid, true);
  font[offset + 6] = glyph.advance;
  font[offset + 7] = glyph.xoff;
}
for (let i = 0; i < 48; i++) font[FONT_HEADER_SIZE + glyphs.length * FONT_CMAP_ENTRY_SIZE + i] = (i * 37 + 11) & 0xff;

const image = encodeImageEntry({
  width: 2,
  height: 2,
  rgba: Uint8Array.of(
    0x12, 0x34, 0x56, 0xff, 0x78, 0x9a, 0xbc, 0xff,
    0xde, 0xf0, 0x12, 0xff, 0x34, 0x56, 0x78, 0xff,
  ),
}, PSM.PSM_8888);
const pak = pack([
  { key: "ui:styles", dtype: 0, data: styles.bin },
  { key: "ui:font.5", dtype: 0, data: font },
  { key: "ui:img.pixel", dtype: 0, data: image },
]);

const lines: string[] = [];
for (let i = 0; i < pak.length; i += 16) {
  lines.push(`  ${Array.from(pak.subarray(i, i + 16), (byte) => `0x${byte.toString(16).padStart(2, "0")}`).join(", ")},`);
}
writeFileSync(`${output}/fixture.h`, `#include <stdint.h>\nstatic const uint8_t w13b_pak[] = {\n${lines.join("\n")}\n};\n`);
