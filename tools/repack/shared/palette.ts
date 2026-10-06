// Palette images for the repack step: the PS Vita's bubble icon is an indexed
// PNG-8 (tools/vita-package.ts checks it). Median cut over the image's
// distinct colours, then an indexed PNG with filter 0 on every row and no
// metadata chunks. Web-platform APIs only (png.ts's deflate).

import { medianCut } from "../../median-cut.ts";
import { crc32 } from "./crc32.ts";
import { deflateZlib, type RgbaImage } from "./png.ts";

/**
 * Reduce an opaque image to at most `limit` colours (median cut over the
 * distinct colours, weighted by pixel count; each pixel takes its box's
 * mean). Alpha is ignored. Returns palette indices and RGB triplets.
 */
export function quantizeRgb(image: RgbaImage, limit = 256): { indices: Uint8Array; palette: Uint8Array } {
  const { width, height, rgba } = image;
  const key = (at: number) => (rgba[at]! << 16) | (rgba[at + 1]! << 8) | rgba[at + 2]!;
  const counts = new Map<number, number>();
  for (let at = 0; at < width * height * 4; at += 4) counts.set(key(at), (counts.get(key(at)) ?? 0) + 1);
  const colours = [...counts]
    .sort((a, b) => a[0] - b[0])
    .map(([k, count]) => ({ r: k >> 16, g: (k >> 8) & 255, b: k & 255, count }));
  const slot = new Map<number, number>();
  const entries: number[] = [];
  for (const box of medianCut(colours, limit)) {
    const total = box.reduce((sum, colour) => sum + colour.count, 0);
    for (const c of ["r", "g", "b"] as const) {
      entries.push(Math.round(box.reduce((sum, colour) => sum + colour[c] * colour.count, 0) / total));
    }
    for (const colour of box) slot.set((colour.r << 16) | (colour.g << 8) | colour.b, entries.length / 3 - 1);
  }
  const indices = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) indices[p] = slot.get(key(p * 4))!;
  return { indices, palette: Uint8Array.from(entries) };
}

function chunk(name: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Indexed PNG-8 (colour type 3, bit depth 8, not interlaced); `palette` holds 1 to 256 RGB triplets. */
export async function encodeIndexedPng(width: number, height: number, indices: Uint8Array, palette: Uint8Array): Promise<Uint8Array> {
  if (palette.length === 0 || palette.length > 768 || palette.length % 3 !== 0) throw new Error("png: a palette holds 1 to 256 colours");
  if (indices.length !== width * height) throw new Error("png: one index per pixel");
  const scanlines = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) scanlines.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 3;
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("PLTE", palette),
    chunk("IDAT", await deflateZlib(scanlines)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
}
