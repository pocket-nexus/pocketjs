import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { TEXT, validTextGlyph, type TextGlyph } from "../contracts/spec/text.ts";

/** The worker owns font I/O and rasterization. No IME or app dependency. */
export function createTextProvider(path: string) {
  const id = createHash("sha256").update(`pocket-scalar-coverage-${TEXT.rasterizerRevision}\0`).update(readFileSync(path)).digest("hex");
  const family = `Pocket-${id}`;
  if (!GlobalFonts.registerFromPath(path, family)) throw new Error("Text font unavailable");
  const context = createCanvas(TEXT.maxWidth, TEXT.maxHeight).getContext("2d");
  return {
    "text.font": () => JSON.stringify({ id, mapping: "scalar" }),
    "text.glyph": (payload: string) => {
      const v = JSON.parse(payload);
      if (!validTextGlyph(v) || v.face !== id) throw new Error("Invalid text glyph");
      context.clearRect(0, 0, TEXT.maxWidth, TEXT.maxHeight);
      const pixels = v.size * v.density;
      context.font = `${v.bold ? "bold " : ""}${pixels}px "${family}"`;
      context.textBaseline = "alphabetic"; context.fillStyle = "white";
      const m = context.measureText(v.text), lineHeight = (v.size + 8) * v.density;
      const leading = Math.max(2, (lineHeight - m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2);
      const baseline = Math.ceil(Math.max(m.fontBoundingBoxAscent, m.actualBoundingBoxAscent) + leading);
      const xoff = Math.ceil(Math.max(0, m.actualBoundingBoxLeft)) + 2;
      const width = Math.ceil((Math.max(m.width, m.actualBoundingBoxRight) + xoff + 2) / 4) * 4;
      const height = Math.max(16, 2 ** Math.ceil(Math.log2(lineHeight)));
      if (width > TEXT.maxWidth || height > TEXT.maxHeight || baseline + m.actualBoundingBoxDescent > lineHeight)
        throw new Error("Glyph exceeds coverage bounds");
      context.fillText(v.text, xoff, baseline);
      const rgba = context.getImageData(0, 0, width, height).data, mask = Buffer.alloc(width * height / 4);
      for (let i = 0; i < width * height; i++) mask[i >> 2] |= Math.round(rgba[i * 4 + 3] / 85) << ((i & 3) * 2);
      const result: TextGlyph = { face: id, advance: m.width / v.density, xoff: xoff / v.density, width, height, mask: mask.toString("base64") };
      return JSON.stringify(result);
    },
  };
}
