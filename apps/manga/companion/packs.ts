import { closeSync, openSync, readSync, statSync, fstatSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { crc32, createResourcePack } from "../pack-format.ts";
import { encodeDocument } from "../document.ts";
import type { LibraryIndex } from "../model.ts";
import type { OffloadImage } from "../../../contracts/spec/offload.ts";
import { identity } from "./sources.ts";

export function packPath(root: string, pack: string): string {
  if (!/^[a-z0-9-]{1,48}$/.test(pack)) throw Error("Invalid pack name");
  return join(root, "packs", `${pack}.prp`);
}
const signature = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
export const packSignature = (root: string, pack: string) => signature(statSync(packPath(root, pack), { bigint: true }));
export function readPack(root: string, pack: string, entry: number): { count: number; kind: number; width: number; height: number; bytes: Buffer; signature: string } {
  const path = packPath(root, pack), fd = openSync(path, "r");
  const read = (size: number, at: number) => { const b = Buffer.alloc(size); if (readSync(fd, b, 0, size, at) !== size) throw Error("Truncated resource pack"); return b; };
  try {
    const header = read(64, 0), stat = fstatSync(fd, { bigint: true }), size = Number(stat.size);
    const count = header.readUInt32LE(8);
    if (header.toString("ascii", 0, 4) !== "PRP1" || header.readUInt32LE(4) !== 1 || header.readUInt32LE(12) !== size || count < 1 || count > 65536) throw Error("Invalid resource pack");
    if (!Number.isInteger(entry) || entry < 0 || entry >= count) throw Error("Pack entry out of range");
    const record = read(24, 64 + entry * 24);
    const offset = record.readUInt32LE(0), stored = record.readUInt32LE(4), raw = record.readUInt32LE(8), kind = record.readUInt32LE(16);
    const width = record.readUInt16LE(20), height = record.readUInt16LE(22);
    const side = (n: number) => n >= 16 && n <= 256 && !(n & (n - 1));
    if (offset < 64 + count * 24 || stored < 1 || stored > 131200 || offset + stored > size || raw < 1 || raw > 131072 ||
      (kind === 1 ? raw > 2500 || width !== 0 || height !== 0 : kind !== 2 || !side(width) || !side(height) || raw !== width * height * 2)) throw Error("Invalid pack entry");
    const bytes = inflateSync(read(stored, offset), { maxOutputLength: raw });
    if (bytes.length !== raw || crc32(bytes) !== record.readUInt32LE(12)) throw Error("Pack checksum mismatch");
    return { count, kind, width, height, bytes, signature: signature(stat) };
  } finally { closeSync(fd); }
}
/** Decode prepared PRP texels to the hardware-neutral offload image contract. */
export function packImage(record: ReturnType<typeof readPack>): OffloadImage {
  if (record.kind !== 2) throw Error("Requested entry is not an image");
  const { width, height, bytes } = record, pixels = new Uint8Array(width * height * 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const mx = x & 7, my = y & 7;
    const morton = (mx & 1) | ((my & 1) << 1) | ((mx & 2) << 1) | ((my & 2) << 2) | ((mx & 4) << 2) | ((my & 4) << 3);
    const at = (((y >>> 3) * (width >>> 3) + (x >>> 3)) * 64 + morton) * 2;
    const p = bytes.readUInt16LE(at), v = ((p & 31) << 11) | (p & 0x7e0) | (p >>> 11);
    const to = ((height - 1 - y) * width + x) * 2; pixels[to] = v & 255; pixels[to + 1] = v >>> 8;
  }
  return { width, height, pixels, format: "r5g6b5" };
}
export function publishCatalog(root: string, index: LibraryIndex): string {
  const name = `mc-${identity(JSON.stringify(index))}`;
  const doc = encodeDocument(index, 1);
  const pack = createResourcePack(packPath(root, name), 1 + doc.chunks.length);
  try {
    for (const raw of [doc.head, ...doc.chunks]) pack.add(Buffer.from(raw));
    pack.finish();
  } catch (error) { pack.abort(); throw error; }
  const pointer = createResourcePack(packPath(root, "manga-index"), 1);
  try { pointer.add(Buffer.from(JSON.stringify({ catalog: name }))); pointer.finish(); }
  catch (error) { pointer.abort(); throw error; }
  return name;
}
