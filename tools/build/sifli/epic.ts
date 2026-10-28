#!/usr/bin/env bun
// tools/build/sifli/epic.ts — bake a package's images into the EPIC native
// texture table that platforms/sifli/render-epic registers with the executor.
//
//   bun tools/build/sifli/epic.ts --pocket <app.pocket> [--target <variant>] --out <app.epic> [--opaque RRGGBB]
//   bun tools/build/sifli/epic.ts --pak <assets.pak> --out <app.epic> [--opaque RRGGBB]
//
// Table (little-endian, payloads 64-byte aligned):
//   header 16 B   u32 magic "EPIC", u16 version 1, u16 count, u32 total bytes, u32 0
//   entry  32 B   u64 source, u32 offset, u32 length, u16 width, u16 height,
//                 u8 format, u8 flags (IMG flags without RLE), u16 0, u64 0
// Entries are sorted by source, one per distinct source. The source is the
// FNV-1a 64 of the texture as the core holds it: u16 width, u16 height, u8
// psm, the 1024-byte palette for PSM_T8, then the decoded pixel bytes. The
// renderer computes the same digest from the texture view to find a native
// copy, so software fallback keeps reading the portable bytes.
//   PSM_5650 -> RGB565 (red in the high bits)
//   PSM_8888 -> BGRA8888, or RGB565 composited over --opaque at bake time
//   PSM_4444 -> BGRA8888 (4-bit channels expanded)
//   PSM_T8   -> L8: a 1024-byte BGRA palette, then the indices

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { IMG_FLAG_RLE, PSM, TEX_MAX_DIM, packbitsDecode } from "../../../contracts/spec/spec.ts";
import { POCKET_SECTION, decodePocketPackage, findSection, fnv1a64 } from "../../../contracts/spec/pocket-package.ts";
import { unpack } from "../../../framework/compiler/pak.ts";

export const EPIC_MAGIC = 0x43495045; // "EPIC" as LE u32
export const EPIC_VERSION = 1;
export const EPIC_HEADER_SIZE = 16;
export const EPIC_ENTRY_SIZE = 32;
export const EPIC_ALIGN = 64;
export const EPIC_RGB565 = 0;
export const EPIC_BGRA8888 = 1;
export const EPIC_L8 = 2;
const PALETTE_BYTES = 1024;
const IMG_HEADER = 8;

/** A texture as the core uploads it: palette and pixels after RLE decoding. */
export interface PortableTexture {
  readonly width: number;
  readonly height: number;
  readonly psm: number;
  readonly flags: number;
  readonly palette: Uint8Array | null;
  readonly pixels: Uint8Array;
}

export interface BakeOptions {
  /** Composite PSM_8888 over this color and store opaque RGB565. */
  readonly opaque?: readonly [number, number, number];
}

export function parseOpaque(hex: string): readonly [number, number, number] {
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new Error("--opaque expects six hexadecimal digits");
  return [0, 2, 4].map(at => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

const bytesPerPixel = (psm: number): number | undefined =>
  psm === PSM.PSM_5650 || psm === PSM.PSM_4444 ? 2 : psm === PSM.PSM_8888 ? 4 : psm === PSM.PSM_T8 ? 1 : undefined;

/** Decode one IMG entry the way Ui::upload_img_entry does. */
export function decodeImageEntry(key: string, blob: Uint8Array): PortableTexture {
  if (blob.length < IMG_HEADER) throw new Error(`${key}: truncated IMG header`);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const width = view.getUint16(0, true);
  const height = view.getUint16(2, true);
  const psm = blob[4]!;
  const flags = blob[5]!;
  const bpp = bytesPerPixel(psm);
  if (bpp === undefined) throw new Error(`${key}: unsupported PSM ${psm}`);
  const pow2 = (value: number) => value > 0 && value <= TEX_MAX_DIM && (value & (value - 1)) === 0;
  if (!pow2(width) || !pow2(height)) throw new Error(`${key}: ${width}x${height} is not a power of two <= ${TEX_MAX_DIM}`);
  let stream = blob.subarray(IMG_HEADER);
  let palette: Uint8Array | null = null;
  if (psm === PSM.PSM_T8) {
    if (stream.length < PALETTE_BYTES) throw new Error(`${key}: truncated PSM_T8 palette`);
    palette = stream.subarray(0, PALETTE_BYTES);
    stream = stream.subarray(PALETTE_BYTES);
  }
  const length = width * height * bpp;
  let pixels: Uint8Array | null;
  if (flags & IMG_FLAG_RLE) pixels = packbitsDecode(stream, length);
  else pixels = stream.length >= length ? stream.subarray(0, length) : null;
  if (!pixels) throw new Error(`${key}: pixel stream does not hold ${length} bytes`);
  return { width, height, psm, flags, palette, pixels };
}

/** The digest the renderer computes from the core's texture view. */
export function sourceDigest(texture: PortableTexture): bigint {
  const header = new Uint8Array([texture.width & 0xff, texture.width >> 8, texture.height & 0xff, texture.height >> 8, texture.psm]);
  return texture.palette ? fnv1a64(header, texture.palette, texture.pixels) : fnv1a64(header, texture.pixels);
}

const rgb565 = (red: number, green: number, blue: number) => ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3);

/** The EPIC-order payload for one texture. */
export function convert(texture: PortableTexture, options: BakeOptions = {}): { format: number; payload: Uint8Array } {
  const { pixels } = texture;
  const count = texture.width * texture.height;
  const source = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  if (texture.psm === PSM.PSM_8888 && options.opaque) {
    const [red, green, blue] = options.opaque;
    const payload = new Uint8Array(count * 2);
    const out = new DataView(payload.buffer);
    for (let index = 0; index < count; index++) {
      const at = index * 4;
      const alpha = pixels[at + 3]!;
      const inverse = 255 - alpha;
      out.setUint16(index * 2, rgb565(
        Math.round((pixels[at]! * alpha + red * inverse) / 255),
        Math.round((pixels[at + 1]! * alpha + green * inverse) / 255),
        Math.round((pixels[at + 2]! * alpha + blue * inverse) / 255)), true);
    }
    return { format: EPIC_RGB565, payload };
  }
  if (texture.psm === PSM.PSM_8888) {
    const payload = pixels.slice();
    for (let at = 0; at < payload.length; at += 4) [payload[at], payload[at + 2]] = [payload[at + 2]!, payload[at]!];
    return { format: EPIC_BGRA8888, payload };
  }
  if (texture.psm === PSM.PSM_5650) {
    const payload = new Uint8Array(count * 2);
    const out = new DataView(payload.buffer);
    for (let index = 0; index < count; index++) {
      const value = source.getUint16(index * 2, true);
      out.setUint16(index * 2, ((value & 0x001f) << 11) | (value & 0x07e0) | ((value & 0xf800) >> 11), true);
    }
    return { format: EPIC_RGB565, payload };
  }
  if (texture.psm === PSM.PSM_4444) {
    const payload = new Uint8Array(count * 4);
    for (let index = 0; index < count; index++) {
      const value = source.getUint16(index * 2, true);
      payload[index * 4] = ((value >> 8) & 0xf) * 17;
      payload[index * 4 + 1] = ((value >> 4) & 0xf) * 17;
      payload[index * 4 + 2] = (value & 0xf) * 17;
      payload[index * 4 + 3] = ((value >> 12) & 0xf) * 17;
    }
    return { format: EPIC_BGRA8888, payload };
  }
  const payload = new Uint8Array(PALETTE_BYTES + count);
  payload.set(texture.palette!, 0);
  for (let at = 0; at < PALETTE_BYTES; at += 4) [payload[at], payload[at + 2]] = [payload[at + 2]!, payload[at]!];
  payload.set(pixels, PALETTE_BYTES);
  return { format: EPIC_L8, payload };
}

const alignUp = (value: number) => Math.ceil(value / EPIC_ALIGN) * EPIC_ALIGN;

/** The native texture table for every `ui:img.*` entry of a pak. */
export function bakeEpicTable(pak: Uint8Array, options: BakeOptions = {}): { bytes: Uint8Array; images: number } {
  const bySource = new Map<bigint, { source: bigint; texture: PortableTexture; format: number; payload: Uint8Array }>();
  let images = 0;
  for (const blob of unpack(pak)) {
    if (!blob.key.startsWith("ui:img.")) continue;
    images++;
    const texture = decodeImageEntry(blob.key, blob.data);
    const source = sourceDigest(texture);
    if (!bySource.has(source)) bySource.set(source, { source, texture, ...convert(texture, options) });
  }
  const entries = [...bySource.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  if (entries.length > 0xffff) throw new Error(`${entries.length} textures exceed the table's u16 count`);
  let cursor = alignUp(EPIC_HEADER_SIZE + entries.length * EPIC_ENTRY_SIZE);
  const offsets = entries.map(entry => {
    const offset = cursor;
    cursor = alignUp(offset + entry.payload.length);
    return offset;
  });
  const bytes = new Uint8Array(cursor);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, EPIC_MAGIC, true);
  view.setUint16(4, EPIC_VERSION, true);
  view.setUint16(6, entries.length, true);
  view.setUint32(8, bytes.length, true);
  entries.forEach((entry, index) => {
    const at = EPIC_HEADER_SIZE + index * EPIC_ENTRY_SIZE;
    view.setBigUint64(at, entry.source, true);
    view.setUint32(at + 8, offsets[index]!, true);
    view.setUint32(at + 12, entry.payload.length, true);
    view.setUint16(at + 16, entry.texture.width, true);
    view.setUint16(at + 18, entry.texture.height, true);
    bytes[at + 20] = entry.format;
    bytes[at + 21] = entry.texture.flags & ~IMG_FLAG_RLE;
    bytes.set(entry.payload, offsets[index]!);
  });
  return { bytes, images };
}

/** The pak section of one package variant; the only variant when `target` is omitted. */
export function packagePak(pocket: Uint8Array, target?: string): Uint8Array {
  const { variants } = decodePocketPackage(pocket);
  const variant = target === undefined
    ? (variants.length === 1 ? variants[0] : undefined)
    : variants.find(candidate => candidate.target === target);
  if (!variant) {
    const names = variants.map(candidate => candidate.target).join(", ");
    throw new Error(target === undefined ? `the package has variants ${names}; pass --target` : `no variant ${target} (have ${names})`);
  }
  const pak = findSection(variant, POCKET_SECTION.pak);
  if (!pak) throw new Error(`variant ${variant.target} has no pak section`);
  return pak;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const take = (name: string): string | undefined => {
    const at = args.indexOf("--" + name);
    if (at < 0) return undefined;
    const value = args[at + 1];
    if (!value || value.startsWith("--")) throw new Error("--" + name + " requires a value");
    args.splice(at, 2);
    return value;
  };
  const pocket = take("pocket");
  const pakPath = take("pak");
  const target = take("target");
  const out = take("out");
  const opaque = take("opaque");
  if (args.length || !out || (pocket === undefined) === (pakPath === undefined) || (pakPath && target)) {
    throw new Error("usage: epic.ts (--pocket <app.pocket> [--target <variant>] | --pak <assets.pak>) --out <app.epic> [--opaque RRGGBB]");
  }
  const pak = pocket ? packagePak(readFileSync(resolve(pocket)), target) : readFileSync(resolve(pakPath!));
  const baked = bakeEpicTable(pak, { opaque: opaque ? parseOpaque(opaque) : undefined });
  writeFileSync(resolve(out), baked.bytes);
  console.log(`epic: ${baked.images} image(s), ${baked.bytes.length} bytes -> ${out}`);
}
