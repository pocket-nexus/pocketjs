// Zip archives in TypeScript, for the repack steps (no file system, no
// native tools): read the entries of an existing archive, write a new one.
//
// Determinism: every entry the writer emits carries the DOS date 1980-01-01
// 00:00 and no extra field beyond alignment padding, entries keep the order
// they are given in, and compression is raw deflate from the platform's
// CompressionStream. The same inputs on one runtime give the same bytes.
//
// Not supported: zip64, encryption, data descriptors on read (sizes come
// from the central directory, which every writer fills in).

import { crc32 } from "./crc32.ts";
import { deflateRaw } from "./png.ts";

export const ZIP_STORED = 0;
export const ZIP_DEFLATED = 8;

/** DOS date of 1980-01-01, the earliest a zip entry can carry; time 00:00. */
const DOS_DATE_1980 = (0 << 9) | (1 << 5) | 1;
const DOS_TIME_MIDNIGHT = 0;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/** One entry of an archive, its data as stored (compressed when `method` is deflate). */
export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly crc32: number;
  /** Uncompressed size. */
  readonly size: number;
  /** The entry's data as it sits in the archive. */
  readonly stored: Uint8Array;
  /** Unix mode bits from the central directory's external attributes, when it made by Unix. */
  readonly unixMode?: number;
}

/** An entry to write: its uncompressed bytes, or an entry read from another archive carried over as stored. */
export type ZipInput =
  | {
    readonly name: string;
    readonly data: Uint8Array;
    /** Deflate the data when that makes it smaller (default true); false stores it. */
    readonly compress?: boolean;
    /** Align the data to this many bytes within the archive when the entry is stored. */
    readonly align?: number;
    readonly unixMode?: number;
  }
  | {
    readonly name: string;
    readonly entry: ZipEntry;
    readonly align?: number;
  };

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}
function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** The entries of a zip archive, in central-directory order. */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(view, i) === END_OF_CENTRAL) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("zip: no end-of-central-directory record");
  const count = u16(view, end + 10);
  const directorySize = u32(view, end + 12);
  let cursor = u32(view, end + 16);
  if (cursor === 0xffffffff || count === 0xffff) throw new Error("zip: zip64 archives are not read here");
  if (cursor + directorySize > end) throw new Error("zip: central directory out of bounds");
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (u32(view, cursor) !== CENTRAL_HEADER) throw new Error("zip: bad central directory entry");
    const madeBy = u16(view, cursor + 4) >> 8;
    const flags = u16(view, cursor + 8);
    const method = u16(view, cursor + 10);
    const crc = u32(view, cursor + 16);
    const compressedSize = u32(view, cursor + 20);
    const size = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const external = u32(view, cursor + 38);
    const local = u32(view, cursor + 42);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (flags & 1) throw new Error(`zip: ${name} is encrypted`);
    if (u32(view, local) !== LOCAL_HEADER) throw new Error(`zip: bad local header for ${name}`);
    const dataStart = local + 30 + u16(view, local + 26) + u16(view, local + 28);
    if (dataStart + compressedSize > bytes.length) throw new Error(`zip: ${name} runs past the archive`);
    entries.push({
      name,
      method,
      crc32: crc,
      size,
      stored: bytes.subarray(dataStart, dataStart + compressedSize),
      ...(madeBy === 3 ? { unixMode: external >>> 16 } : {}),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function pipe(bytes: Uint8Array, stream: DecompressionStream): Promise<Uint8Array> {
  const output = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}


/** An entry's uncompressed bytes, checked against its CRC-32. */
export async function unzipEntry(entry: ZipEntry): Promise<Uint8Array> {
  let data: Uint8Array;
  if (entry.method === ZIP_STORED) data = entry.stored;
  else if (entry.method === ZIP_DEFLATED) data = await pipe(entry.stored, new DecompressionStream("deflate-raw"));
  else throw new Error(`zip: ${entry.name} uses compression method ${entry.method}`);
  if (data.length !== entry.size || crc32(data) !== entry.crc32) throw new Error(`zip: ${entry.name} fails its CRC`);
  return data;
}

/** Turns inputs into entries: deflates what asks for it, keeps what is smaller. */
export async function zipEntry(input: ZipInput): Promise<ZipEntry> {
  if ("entry" in input) return { ...input.entry, name: input.name };
  const crc = crc32(input.data);
  const base = { name: input.name, crc32: crc, size: input.data.length, ...(input.unixMode !== undefined ? { unixMode: input.unixMode } : {}) };
  if (input.compress === false) return { ...base, method: ZIP_STORED, stored: input.data };
  const deflated = await deflateRaw(input.data);
  return deflated.length < input.data.length
    ? { ...base, method: ZIP_DEFLATED, stored: deflated }
    : { ...base, method: ZIP_STORED, stored: input.data };
}

/**
 * A zip archive of `inputs` in the given order. A stored entry with `align`
 * gets its data placed at a multiple of `align` from the archive's start by
 * zero padding in the local header's extra field, as zipalign does.
 */
export async function writeZip(inputs: readonly ZipInput[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const names = new Set<string>();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const input of inputs) {
    if (names.has(input.name)) throw new Error(`zip: ${input.name} is named twice`);
    names.add(input.name);
    const entry = await zipEntry(input);
    const name = encoder.encode(entry.name);
    const align = entry.method === ZIP_STORED ? input.align ?? 0 : 0;
    const headerEnd = offset + 30 + name.length;
    const padding = align > 1 ? (align - (headerEnd % align)) % align : 0;
    const local = new Uint8Array(30 + name.length + padding);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_HEADER, true);
    lv.setUint16(4, entry.method === ZIP_DEFLATED ? 20 : 10, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, entry.method, true);
    lv.setUint16(10, DOS_TIME_MIDNIGHT, true);
    lv.setUint16(12, DOS_DATE_1980, true);
    lv.setUint32(14, entry.crc32, true);
    lv.setUint32(18, entry.stored.length, true);
    lv.setUint32(22, entry.size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, padding, true);
    local.set(name, 30);
    const record = new Uint8Array(46 + name.length);
    const cv = new DataView(record.buffer);
    cv.setUint32(0, CENTRAL_HEADER, true);
    cv.setUint16(4, (3 << 8) | 20, true); // made by Unix, zip 2.0
    cv.setUint16(6, entry.method === ZIP_DEFLATED ? 20 : 10, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, entry.method, true);
    cv.setUint16(12, DOS_TIME_MIDNIGHT, true);
    cv.setUint16(14, DOS_DATE_1980, true);
    cv.setUint32(16, entry.crc32, true);
    cv.setUint32(20, entry.stored.length, true);
    cv.setUint32(24, entry.size, true);
    cv.setUint16(28, name.length, true);
    const mode = entry.unixMode ?? (entry.name.endsWith("/") ? 0o40755 : 0o100644);
    cv.setUint32(38, (mode << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    record.set(name, 46);
    parts.push(local, entry.stored);
    central.push(record);
    offset += local.length + entry.stored.length;
  }
  if (inputs.length > 0xffff || offset > 0xffffffff) throw new Error("zip: archive needs zip64");
  const directorySize = central.reduce((sum, record) => sum + record.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_OF_CENTRAL, true);
  ev.setUint16(8, inputs.length, true);
  ev.setUint16(10, inputs.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directorySize + end.length);
  let cursor = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
