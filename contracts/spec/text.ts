/** Reusable scalar-font coverage, matching the core's baked cmap model.
 * Shaped glyph IDs and clusters are a separate provider contract (docs/TEXT_RESOURCES.md). */
export const TEXT = Object.freeze({ rasterizerRevision: 1, maxCodeUnits: 256, maxGlyphs: 96, maxRasterSize: 48, maxWidth: 64, maxHeight: 128, maxPixels: 8192 });
export interface TextFace { id: string; mapping: "scalar" }
export interface TextGlyphRequest { face: string; text: string; size: number; density: number; bold: boolean }
export interface TextGlyph { face: string; advance: number; xoff: number; width: number; height: number; mask: string }
export function validTextGlyph(value: unknown): value is TextGlyphRequest {
  const v = value as TextGlyphRequest | null;
  return !!v && typeof v.face === "string" && /^[a-f0-9]{64}$/.test(v.face) && typeof v.text === "string" &&
    Array.from(v.text).length === 1 && !/[\uD800-\uDFFF]/u.test(v.text) && Number.isInteger(v.size) && v.size >= 8 &&
    Number.isInteger(v.density) && v.density >= 1 && v.density <= 3 && v.size * v.density <= TEXT.maxRasterSize && typeof v.bold === "boolean";
}
