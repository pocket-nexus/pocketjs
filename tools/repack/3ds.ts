// tools/repack/3ds.ts — a game's Nintendo 3DS `.3dsx` from the generic
// runtime (tools/runtime/3ds.ts) and the game's `.pocket`, in TypeScript.
//
// A .3dsx (devkitPro 3dstools `3dsx.h`) is a 44-byte header with the extended
// fields, three relocation headers, the code, rodata and data segments, their
// relocation tables, then the SMDH and the RomFS the extended header points
// at. The repack keeps everything from the relocation headers to the end of
// the relocation tables byte for byte (the runtime's program), and writes a
// new SMDH (title, description, author, 24 and 48 px icons) and a new RomFS
// holding `app.pocket`. The host reads the game's surfaces and its state
// directory from that package at boot (hosts/3ds/src/main.c).
//
// The SMDH and RomFS writers follow smdhtool and 3dsxtool (3dstools 1.3.1):
// tests/repack-3ds.test.ts holds byte-compared fixtures of both.
//
// Never a CIA: a .3dsx starts from the Homebrew Launcher on any console with
// custom firmware, and nothing is installed into the system.

import { decodePng, type RgbaImage } from "./shared/png.ts";
import { squareIcon } from "./shared/scale.ts";
import {
  admitPocket,
  checkIdentity,
  planFeatures,
  readRuntime,
  type RepackInput,
} from "./shared/runtime.ts";

export const THREE_DS_RUNTIME_TARGET = "3ds-dev";
/** The runtime's program inside dist/runtime/3ds/. */
export const THREE_DS_RUNTIME_FILE = "runtime.3dsx";

const MAGIC_3DSX = 0x58534433; // "3DSX"
const HEADER_BYTES = 32;
const EXTENDED_HEADER_BYTES = 44;
const SMDH_BYTES = 0x36c0;
const SMDH_ICONS = 0x2040;

/** Features the runtime build leaves out; a plan that asks for one is refused. */
const UNSUPPORTED_FEATURES = ["io.offload", "media.playback"] as const;

// ---------------------------------------------------------------------------
// .3dsx
// ---------------------------------------------------------------------------

export interface ThreeDsx {
  /** The first 32 header bytes: magic, sizes and segment lengths. */
  readonly header: Uint8Array;
  /** Relocation headers, segments and relocation tables, verbatim. */
  readonly program: Uint8Array;
  readonly smdh: Uint8Array | null;
  readonly romfs: Uint8Array | null;
}

export function parse3dsx(bytes: Uint8Array): ThreeDsx {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < HEADER_BYTES || view.getUint32(0, true) !== MAGIC_3DSX) {
    throw new Error("3dsx: not a .3dsx (bad magic)");
  }
  const headerSize = view.getUint16(4, true);
  const relocationHeaderSize = view.getUint16(6, true);
  if (headerSize < HEADER_BYTES || relocationHeaderSize < 8 || relocationHeaderSize % 4 !== 0) {
    throw new Error("3dsx: header or relocation header size is invalid");
  }
  const code = view.getUint32(16, true);
  const rodata = view.getUint32(20, true);
  const data = view.getUint32(24, true);
  const bss = view.getUint32(28, true);
  if (bss > data) throw new Error("3dsx: BSS is larger than the data segment");
  let at = headerSize;
  let relocations = 0;
  for (let segment = 0; segment < 3; segment++) {
    if (at + relocationHeaderSize > bytes.length) throw new Error("3dsx: truncated relocation headers");
    // Every field of a relocation header is a count of 4-byte entries.
    for (let field = 0; field < relocationHeaderSize; field += 4) relocations += view.getUint32(at + field, true);
    at += relocationHeaderSize;
  }
  const end = at + code + rodata + (data - bss) + relocations * 4;
  if (end > bytes.length) throw new Error("3dsx: truncated segments or relocation tables");
  let smdh: Uint8Array | null = null;
  let romfs: Uint8Array | null = null;
  if (headerSize >= EXTENDED_HEADER_BYTES) {
    const smdhOffset = view.getUint32(32, true);
    const smdhSize = view.getUint32(36, true);
    const romfsOffset = view.getUint32(40, true);
    if (smdhOffset !== 0) {
      if (smdhOffset < end || smdhOffset + smdhSize > bytes.length) throw new Error("3dsx: SMDH out of bounds");
      smdh = bytes.subarray(smdhOffset, smdhOffset + smdhSize);
    }
    if (romfsOffset !== 0) {
      if (romfsOffset < end || romfsOffset > bytes.length) throw new Error("3dsx: RomFS out of bounds");
      romfs = bytes.subarray(romfsOffset);
    }
  }
  return { header: bytes.subarray(0, HEADER_BYTES), program: bytes.subarray(headerSize, end), smdh, romfs };
}

/** The 3dsxtool layout: header with extended fields, program, SMDH, 4-byte pad, RomFS. */
export function write3dsx(program: { header: Uint8Array; program: Uint8Array }, smdh: Uint8Array, romfs: Uint8Array | null): Uint8Array {
  const smdhOffset = EXTENDED_HEADER_BYTES + program.program.length;
  const romfsOffset = romfs ? (smdhOffset + smdh.length + 3) & ~3 : 0;
  const total = romfs ? romfsOffset + romfs.length : (smdhOffset + smdh.length + 3) & ~3;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(program.header, 0);
  view.setUint16(4, EXTENDED_HEADER_BYTES, true);
  view.setUint32(32, smdhOffset, true);
  view.setUint32(36, smdh.length, true);
  view.setUint32(40, romfsOffset, true);
  out.set(program.program, EXTENDED_HEADER_BYTES);
  out.set(smdh, smdhOffset);
  if (romfs) out.set(romfs, romfsOffset);
  return out;
}

// ---------------------------------------------------------------------------
// SMDH (smdhtool --create)
// ---------------------------------------------------------------------------

/** UTF-16LE code units, cut where the next character would not fit. */
function utf16Units(text: string, limit: number): number[] {
  const units: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0)!;
    const encoded = code < 0x10000 ? [code] : [(code >> 10) + 0xd7c0, (code & 0x3ff) + 0xdc00];
    if (units.length + encoded.length > limit) break;
    units.push(...encoded);
  }
  return units;
}

// The 8x8 tile's pixel order (Morton order), from 3ds_hb_menu via smdhtool.
const TILE_ORDER = [
  0, 1, 8, 9, 2, 3, 10, 11, 16, 17, 24, 25, 18, 19, 26, 27,
  4, 5, 12, 13, 6, 7, 14, 15, 20, 21, 28, 29, 22, 23, 30, 31,
  32, 33, 40, 41, 34, 35, 42, 43, 48, 49, 56, 57, 50, 51, 58, 59,
  36, 37, 44, 45, 38, 39, 46, 47, 52, 53, 60, 61, 54, 55, 62, 63,
];

/** RGBA to tiled RGB565, colour premultiplied by alpha over black as smdhtool does. */
export function tiledRgb565(image: RgbaImage): Uint8Array {
  const { width, height, rgba } = image;
  if (width % 8 !== 0 || height % 8 !== 0) throw new Error("smdh: icon sides must be multiples of 8");
  const out = new Uint8Array(width * height * 2);
  const view = new DataView(out.buffer);
  let n = 0;
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      for (let k = 0; k < 64; k++) {
        const xx = TILE_ORDER[k]! & 7, yy = TILE_ORDER[k]! >> 3;
        const at = ((y + yy) * width + (x + xx)) * 4;
        const alpha = rgba[at + 3]!;
        // smdhtool: r = 1.0f*r*a/255.0f in single precision, truncated to u8.
        const scale = (value: number) => Math.trunc(Math.fround(Math.fround(value * alpha) / 255));
        const r = scale(rgba[at]!) >> 3, g = scale(rgba[at + 1]!) >> 2, b = scale(rgba[at + 2]!) >> 3;
        view.setUint16(n, (r << 11) | (g << 5) | b, true);
        n += 2;
      }
    }
  }
  return out;
}

export interface SmdhFields {
  /** Short description: the title the Homebrew Launcher shows (0x40 units). */
  readonly title: string;
  /** Long description (0x80 units). */
  readonly description: string;
  /** Publisher (0x40 units). */
  readonly author: string;
  /** 48x48 and 24x24 RGBA, or both already tiled (another SMDH's 0x1680 icon bytes). */
  readonly icons: { readonly large: RgbaImage; readonly small: RgbaImage } | Uint8Array;
}

export function writeSmdh(fields: SmdhFields): Uint8Array {
  const out = new Uint8Array(SMDH_BYTES);
  const view = new DataView(out.buffer);
  out.set([0x53, 0x4d, 0x44, 0x48], 0); // "SMDH", version 0
  const strings: ReadonlyArray<readonly [string, number, number]> = [
    [fields.title, 0x00, 0x40],
    [fields.description, 0x80, 0x80],
    [fields.author, 0x180, 0x40],
  ];
  for (let language = 0; language < 16; language++) {
    const base = 8 + language * 0x200;
    for (const [text, offset, limit] of strings) {
      utf16Units(text, limit).forEach((unit, index) => view.setUint16(base + offset + index * 2, unit, true));
    }
  }
  // Application settings at 0x2008: every rating board enabled with no
  // restriction, region-free, visible + record usage + region rating used.
  const settings = 0x2008;
  for (const board of [0, 1, 3, 4, 6, 7, 8, 9, 10]) out[settings + board] = 0x80 | 0x20;
  view.setUint32(settings + 0x10, 0xffffffff, true);
  view.setUint32(settings + 0x20, 0x1 | 0x100 | 0x40, true);
  if (fields.icons instanceof Uint8Array) {
    if (fields.icons.length !== SMDH_BYTES - SMDH_ICONS) throw new Error("smdh: tiled icons are 0x1680 bytes");
    out.set(fields.icons, SMDH_ICONS);
    return out;
  }
  const { large, small } = fields.icons;
  if (large.width !== 48 || large.height !== 48) throw new Error("smdh: the large icon is 48x48");
  if (small.width !== 24 || small.height !== 24) throw new Error("smdh: the small icon is 24x24");
  out.set(tiledRgb565(small), SMDH_ICONS);
  out.set(tiledRgb565(large), SMDH_ICONS + 24 * 24 * 2);
  return out;
}

// ---------------------------------------------------------------------------
// RomFS (3dsxtool's level-3 image)
// ---------------------------------------------------------------------------

export interface RomfsFile {
  /** "/"-separated path below the RomFS root, e.g. "app.pocket". */
  readonly path: string;
  readonly bytes: Uint8Array;
}

interface RomfsDirectory {
  name: number[];
  offset: number;
  parent: RomfsDirectory | null;
  directories: RomfsDirectory[];
  files: RomfsEntry[];
  nextHash: number;
}

interface RomfsEntry {
  name: number[];
  offset: number;
  parent: RomfsDirectory;
  bytes: Uint8Array;
  dataOffset: number;
  nextHash: number;
}

const NONE = 0xffffffff;

function hashTableLength(count: number): number {
  // Nintendo's "smallest prime-ish number >= count".
  if (count < 3) return 3;
  if (count < 19) return count | 1;
  let value = count;
  while ([2, 3, 5, 7, 11, 13, 17].some((divisor) => value % divisor === 0)) value++;
  return value;
}

function nameHash(parent: number, name: readonly number[], total: number): number {
  let hash = (parent ^ 123456789) >>> 0;
  for (const unit of name) hash = (((hash >>> 5) | (hash << 27)) ^ unit) >>> 0;
  return hash % total;
}

function utf16(text: string): number[] {
  const units: number[] = [];
  for (let i = 0; i < text.length; i++) units.push(text.charCodeAt(i));
  return units;
}

/**
 * A RomFS image the way 3dsxtool lays it out: directories breadth of the scan
 * order, files in the order given, a directory's children linked newest first,
 * 4-byte alignment for metadata and file data.
 */
export function writeRomfs(files: readonly RomfsFile[]): Uint8Array {
  const directories: RomfsDirectory[] = [];
  const entries: RomfsEntry[] = [];
  let directoryBytes = 0, fileBytes = 0, dataBytes = 0;
  const addDirectory = (parent: RomfsDirectory | null, name: string): RomfsDirectory => {
    const directory: RomfsDirectory = {
      name: utf16(name), offset: directoryBytes, parent, directories: [], files: [], nextHash: NONE,
    };
    directoryBytes = (directoryBytes + 0x18 + directory.name.length * 2 + 3) & ~3;
    directories.push(directory);
    parent?.directories.unshift(directory);
    return directory;
  };
  const root = addDirectory(null, "");
  const seen = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..") || seen.has(file.path)) {
      throw new Error(`romfs: bad or repeated path ${JSON.stringify(file.path)}`);
    }
    seen.add(file.path);
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      directory = directory.directories.find((child) => String.fromCharCode(...child.name) === part) ?? addDirectory(directory, part);
    }
    const entry: RomfsEntry = {
      name: utf16(parts.at(-1)!), offset: fileBytes, parent: directory, bytes: file.bytes, dataOffset: dataBytes, nextHash: NONE,
    };
    fileBytes = (fileBytes + 0x20 + entry.name.length * 2 + 3) & ~3;
    dataBytes = (dataBytes + file.bytes.length + 3) & ~3;
    entries.push(entry);
    directory.files.unshift(entry);
  }

  const directoryHashes = new Uint32Array(hashTableLength(directories.length)).fill(NONE);
  const fileHashes = new Uint32Array(hashTableLength(entries.length)).fill(NONE);
  for (const directory of directories) {
    const slot = nameHash((directory.parent ?? directory).offset, directory.name, directoryHashes.length);
    directory.nextHash = directoryHashes[slot]!;
    directoryHashes[slot] = directory.offset;
  }
  for (const entry of entries) {
    const slot = nameHash(entry.parent.offset, entry.name, fileHashes.length);
    entry.nextHash = fileHashes[slot]!;
    fileHashes[slot] = entry.offset;
  }

  const header = 0x28;
  const directoryHashOffset = header;
  const directoryMetaOffset = directoryHashOffset + directoryHashes.length * 4;
  const fileHashOffset = directoryMetaOffset + directoryBytes;
  const fileMetaOffset = fileHashOffset + fileHashes.length * 4;
  const dataOffset = fileMetaOffset + fileBytes;
  const out = new Uint8Array(dataOffset + dataBytes);
  const view = new DataView(out.buffer);
  [header, directoryHashOffset, directoryHashes.length * 4, directoryMetaOffset, directoryBytes,
    fileHashOffset, fileHashes.length * 4, fileMetaOffset, fileBytes, dataOffset]
    .forEach((value, index) => view.setUint32(index * 4, value, true));
  directoryHashes.forEach((value, index) => view.setUint32(directoryHashOffset + index * 4, value, true));
  fileHashes.forEach((value, index) => view.setUint32(fileHashOffset + index * 4, value, true));
  const offset = (item: { offset: number } | null | undefined) => (item ? item.offset : NONE);
  for (const directory of directories) {
    const at = directoryMetaOffset + directory.offset;
    view.setUint32(at, (directory.parent ?? directory).offset, true);
    const siblings = directory.parent?.directories ?? [];
    view.setUint32(at + 4, offset(siblings[siblings.indexOf(directory) + 1]), true);
    view.setUint32(at + 8, offset(directory.directories[0]), true);
    view.setUint32(at + 12, offset(directory.files[0]), true);
    view.setUint32(at + 16, directory.nextHash, true);
    view.setUint32(at + 20, directory.name.length * 2, true);
    directory.name.forEach((unit, index) => view.setUint16(at + 24 + index * 2, unit, true));
  }
  for (const entry of entries) {
    const at = fileMetaOffset + entry.offset;
    const siblings = entry.parent.files;
    view.setUint32(at, entry.parent.offset, true);
    view.setUint32(at + 4, offset(siblings[siblings.indexOf(entry) + 1]), true);
    view.setBigUint64(at + 8, BigInt(entry.dataOffset), true);
    view.setBigUint64(at + 16, BigInt(entry.bytes.length), true);
    view.setUint32(at + 24, entry.nextHash, true);
    view.setUint32(at + 28, entry.name.length * 2, true);
    entry.name.forEach((unit, index) => view.setUint16(at + 32 + index * 2, unit, true));
    out.set(entry.bytes, dataOffset + entry.dataOffset);
  }
  return out;
}

// ---------------------------------------------------------------------------
// repack
// ---------------------------------------------------------------------------

/** The 24 and 48 px icons from the identity's PNG. */
export async function smdhIcons(icon: Uint8Array): Promise<{ large: RgbaImage; small: RgbaImage }> {
  const image = await decodePng(icon);
  return { large: squareIcon(image, 48), small: squareIcon(image, 24) };
}

export async function repack3ds(input: RepackInput): Promise<Uint8Array> {
  checkIdentity(input.identity);
  const runtime = await readRuntime(input.runtime, THREE_DS_RUNTIME_TARGET);
  const program = input.runtime.get(THREE_DS_RUNTIME_FILE);
  if (!program || !(THREE_DS_RUNTIME_FILE in runtime.files)) {
    throw new Error(`repack 3ds: the runtime has no ${THREE_DS_RUNTIME_FILE}`);
  }
  const pocket = admitPocket(input.pocket, runtime, input.identity);
  const features = planFeatures(pocket.plan);
  for (const feature of UNSUPPORTED_FEATURES) {
    if (features[feature] === true) {
      throw new Error(`repack 3ds: the game needs ${feature}, which the 3DS runtime does not carry`);
    }
  }
  const viewport = pocket.plan.viewport as { logical?: number[]; rasterDensity?: number } | undefined;
  if (viewport?.logical?.[0] !== 400 || viewport.logical[1] !== 240 || viewport.rasterDensity !== 1) {
    throw new Error("repack 3ds: the game's 3DS plan is not the 400x240 top screen at density 1");
  }

  const parsed = parse3dsx(program);
  if (!parsed.smdh || parsed.smdh.length !== SMDH_BYTES) {
    throw new Error(`repack 3ds: ${THREE_DS_RUNTIME_FILE} carries no SMDH to take the default icon from`);
  }
  const { title, author, version } = input.identity;
  // Without an icon of its own the game shows the runtime's (the PocketJS mark).
  const icons = input.identity.icon ? await smdhIcons(input.identity.icon) : parsed.smdh.slice(SMDH_ICONS);
  const smdh = writeSmdh({ title, description: `${title} ${version}`, author, icons });
  const romfs = writeRomfs([{ path: "app.pocket", bytes: pocket.bytes }]);
  return write3dsx(parsed, smdh, romfs);
}
