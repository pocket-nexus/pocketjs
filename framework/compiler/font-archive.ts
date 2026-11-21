import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import opentype from "opentype.js";
import { bakeAtlases } from "./bake-font.ts";
import { fontSlotInfo } from "./tailwind.ts";
import { FONT_ARCHIVE as F } from "../../contracts/spec/font-archive.ts";

export function glyphChecksum(bytes: Uint8Array): number {
  let h = 2166136261;
  for (const b of bytes) h = Math.imul(h ^ b, 16777619);
  return h >>> 0;
}
/** Produces a separate archive; callers must not place it in the embedded PAK. */
export async function bakeFontArchive(options: {
  font: string;
  slots: number[];
  codepoints?: number[];
  onStrike?: (slot: number, count: number) => void;
}): Promise<Uint8Array> {
  const source = readFileSync(options.font);
  const parsed = opentype.parse(
    source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    ),
  );
  const codepoints =
    options.codepoints ??
    Object.keys((parsed.tables as any).cmap.glyphIndexMap)
      .map(Number)
      .filter(
        (cp) => cp >= 32 && cp !== 127 && !(cp >= 0xd800 && cp <= 0xdfff),
      );
  const slots = [...new Set(options.slots)].sort((a, b) => a - b);
  if (
    !slots.length ||
    slots.length > F.maxStrikes ||
    codepoints.some((cp) => !Number.isInteger(cp) || cp < 0 || cp > 0x10ffff)
  )
    throw new Error("Invalid font archive selection");
  const chunks: {
    descriptor: Uint8Array;
    index: Uint8Array;
    cells: Uint8Array;
  }[] = [];
  let cursor = F.headerBytes + slots.length * F.strikeBytes;
  for (const slot of slots) {
    const [atlas] = await bakeAtlases({
      slots: [slot],
      codepoints,
      fallbackTtfs: [options.font],
    });
    if (atlas.cellW * atlas.cellH > F.maxPixels)
      throw new Error(`Font slot ${slot} exceeds cell budget`);
    const view = new DataView(
      atlas.bytes.buffer,
      atlas.bytes.byteOffset,
      atlas.bytes.byteLength,
    );
    const count = atlas.glyphCount,
      cell = atlas.cellW * atlas.cellH,
      stride = Math.ceil(cell / 4);
    const index = new Uint8Array(count * F.entryBytes),
      iv = new DataView(index.buffer),
      cells = new Uint8Array(count * stride);
    const src = 16 + count * 8;
    for (let gid = 0; gid < count; gid++)
      for (let p = 0; p < cell; p++)
        cells[gid * stride + (p >> 2)] |=
          Math.min(
            3,
            Math.floor((atlas.bytes[src + gid * cell + p] + 42) / 85),
          ) <<
          (6 - 2 * (p % 4));
    for (let i = 0; i < count; i++) {
      const at = 16 + i * 8,
        gid = view.getUint16(at + 4, true);
      index.set(atlas.bytes.subarray(at, at + 8), i * 12);
      iv.setUint32(
        i * 12 + 8,
        glyphChecksum(cells.subarray(gid * stride, (gid + 1) * stride)),
        true,
      );
    }
    const descriptor = new Uint8Array(F.strikeBytes),
      dv = new DataView(descriptor.buffer);
    descriptor.set([
      slot,
      atlas.cellW,
      atlas.cellH,
      atlas.bytes[10],
      atlas.bytes[11],
      fontSlotInfo(slot).px,
      1,
      atlas.bytes[13],
    ]);
    dv.setUint32(8, count, true);
    dv.setUint32(12, cursor, true);
    cursor += index.length;
    dv.setUint32(16, cursor, true);
    dv.setUint32(20, cells.length, true);
    cursor += cells.length;
    chunks.push({ descriptor, index, cells });
    options.onStrike?.(slot, count);
  }
  if (cursor > F.maxBytes)
    throw new Error("Font archive exceeds storage budget");
  const out = new Uint8Array(cursor),
    dv = new DataView(out.buffer);
  dv.setUint32(0, F.magic, true);
  dv.setUint32(4, F.version, true);
  dv.setUint32(8, cursor, true);
  dv.setUint32(12, slots.length, true);
  chunks.forEach((chunk, i) => {
    out.set(chunk.descriptor, F.headerBytes + i * F.strikeBytes);
    const d = new DataView(chunk.descriptor.buffer);
    out.set(chunk.index, d.getUint32(12, true));
    out.set(chunk.cells, d.getUint32(16, true));
  });
  out.set(createHash("sha256").update(out).digest(), 16);
  return out;
}
