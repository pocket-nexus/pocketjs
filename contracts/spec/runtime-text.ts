/** Runtime font identities and geometry contain no GPU atlas coordinates. */
export const RUNTIME_TEXT = Object.freeze({
  version: 1, maxUnits: 2048, maxBatches: 32, maxGlyphPixels: 256 * 256,
  packetMagic: 0x31465452, bitmapBytes: 2 * 1024 * 1024,
});
export interface RuntimeFontSpec {
  /** Name in the worker's granted static TTF collection. */
  family: string;
  size: number;
  /** Ordered, explicit fallback families. An empty array disables fallback. */
  fallback: readonly string[];
}
export interface RuntimeFontInstance { font: number; ascent: number; descent: number; lineHeight: number }
export type RuntimeGlyphPosition = readonly [glyph: number, x: number, baseline: number, advance: number, from: number, to: number, row: number];
export type RuntimeTextRow = readonly [from: number, to: number, width: number, baseline: number];
export type RuntimeCaret = readonly [offset: number, x: number, top: number, row: number];
export interface RuntimeTextLayout {
  readonly id: number;
  readonly text: string;
  readonly font: RuntimeFontInstance;
  readonly width: number;
  readonly height: number;
  readonly baseline: number;
  readonly truncated: boolean;
  readonly glyphs: readonly RuntimeGlyphPosition[];
  readonly rows: readonly RuntimeTextRow[];
  readonly carets: readonly RuntimeCaret[];
}
export interface RuntimeLayoutOptions {
  width?: number | null;
  maxLines?: number;
  overflow?: "clip" | "ellipsis";
}
export interface RuntimeGlyphBitmap {
  glyph: number; width: number; height: number; left: number; top: number; coverage: Uint8Array;
}

export function runtimeLayoutPacket(node: number, layout: RuntimeTextLayout, instance = layout.font.font): Uint8Array {
  const bytes = new Uint8Array(24 + layout.glyphs.length * 16), view = new DataView(bytes.buffer);
  view.setUint32(0, RUNTIME_TEXT.packetMagic, true); view.setUint32(4, 1, true);
  view.setInt32(8, node, true); view.setUint32(12, layout.glyphs.length, true);
  view.setFloat32(16, layout.width, true); view.setFloat32(20, layout.height, true);
  layout.glyphs.forEach(([glyph, x, y], i) => {
    const at = 24 + i * 16;
    view.setUint32(at, instance, true); view.setUint32(at + 4, glyph, true);
    view.setFloat32(at + 8, x, true); view.setFloat32(at + 12, y, true);
  });
  return bytes;
}
export function runtimeGlyphPacket(font: number, glyph: RuntimeGlyphBitmap): Uint8Array {
  const bytes = new Uint8Array(32 + glyph.coverage.length), view = new DataView(bytes.buffer);
  view.setUint32(0, RUNTIME_TEXT.packetMagic, true); view.setUint32(4, 2, true);
  view.setUint32(8, font, true); view.setUint32(12, glyph.glyph, true);
  view.setUint32(16, glyph.width, true); view.setUint32(20, glyph.height, true);
  view.setInt32(24, glyph.left, true); view.setInt32(28, glyph.top, true);
  bytes.set(glyph.coverage, 32); return bytes;
}
export function runtimeDropPacket(font: number, glyph: number): Uint8Array {
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  view.setUint32(0, RUNTIME_TEXT.packetMagic, true); view.setUint32(4, 3, true);
  view.setUint32(8, font, true); view.setUint32(12, glyph, true); return bytes;
}
export function runtimeClearPacket(node: number): Uint8Array {
  const bytes = new Uint8Array(12), view = new DataView(bytes.buffer);
  view.setUint32(0, RUNTIME_TEXT.packetMagic, true); view.setUint32(4, 4, true);
  view.setInt32(8, node, true); return bytes;
}
