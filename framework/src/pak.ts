// QuickJS-safe .pak reader (dreamcart container v1 — constants pinned in
// contracts/spec/spec.ts). Used by web/test hosts to feed styles.bin / font atlases /
// images to the core through ops.loadStyles/loadFontAtlas/uploadTexture; the
// PSP feeds UI assets natively before eval; guests can read runtime data
// from the same read-only pack through this module.
//
// QuickJS constraints honored (precedent: framework/src/pak.ts):
//   - NO TextDecoder — keys are ASCII, decoded via String.fromCharCode.
//   - DataView + unaligned little-endian reads only.
//   - get() returns a FRESH copy (slice), so `.buffer` is exactly the blob.

import {
  PAK_ENTRY_SIZE,
  PAK_HEADER_SIZE,
  PAK_MAGIC,
  PAK_VERSION,
} from "../../contracts/spec/spec.ts";
import { utf8ToString } from "./bytes.ts";

interface Entry {
  off: number; // blob offset from pack start
  len: number; // blob byte length
  dtype: number; // advisory PAK_DTYPE
}

let map: Map<string, Entry> | null = null;
let bytes: Uint8Array | null = null;

// ASCII-only keys (we control them); avoid TextDecoder, which QuickJS lacks.
function readKey(u8: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(u8[off + i]);
  return s;
}

function parse(ab: ArrayBuffer): void {
  const dv = new DataView(ab);
  if (ab.byteLength < PAK_HEADER_SIZE || dv.getUint32(0, true) !== PAK_MAGIC) {
    throw new Error("pak: bad magic");
  }
  const version = dv.getUint16(4, true);
  if (version !== PAK_VERSION) {
    throw new Error("pak: unsupported version " + version);
  }
  const entryCount = dv.getUint32(8, true);
  const dirOff = dv.getUint32(12, true);
  const namesOff = dv.getUint32(16, true);
  const u8 = new Uint8Array(ab);
  const m = new Map<string, Entry>();
  for (let i = 0; i < entryCount; i++) {
    const e = dirOff + i * PAK_ENTRY_SIZE;
    const blobOff = dv.getUint32(e + 4, true);
    const byteLen = dv.getUint32(e + 8, true);
    const nameOff = dv.getUint32(e + 12, true);
    const nameLen = dv.getUint16(e + 16, true);
    const dtype = u8[e + 18];
    m.set(readKey(u8, namesOff + nameOff, nameLen), {
      off: blobOff,
      len: byteLen,
      dtype,
    });
  }
  map = m;
  bytes = u8;
}

/** Explicitly load a pack (web host after fetch; tests). Replaces any prior. */
export function loadPack(ab: ArrayBuffer): void {
  parse(ab);
}

/** Test/dev helper: drop the cached parsed pack. App bundles normally eval fresh. */
export function resetPack(): void {
  map = null;
  bytes = null;
}

function ensureLoaded(): void {
  if (map) return;
  const ab = (globalThis as { __pak?: ArrayBuffer }).__pak;
  if (!ab) return; // no pack — throws only on actual access
  parse(ab);
}

/** True when a pack is present (globalThis.__pak or loadPack). */
export function hasPack(): boolean {
  ensureLoaded();
  return map !== null;
}

/** All entry keys starting with `prefix` (default: every key), sorted. */
export function entries(prefix = ""): string[] {
  ensureLoaded();
  if (!map) return [];
  const out: string[] = [];
  for (const key of map.keys()) {
    if (key.length >= prefix.length && key.slice(0, prefix.length) === prefix) {
      out.push(key);
    }
  }
  out.sort();
  return out;
}

/** Raw bytes (or a bounded byte range) as a fresh copy; throws if absent. */
export function get(key: string, start = 0, end?: number): Uint8Array {
  ensureLoaded();
  const e = map ? map.get(key) : undefined;
  if (!e) {
    throw new Error(
      "pak: missing key " +
        key +
        " (no __pak provided, or the pack is incomplete)",
    );
  }
  // .slice() copies into a fresh, offset-0, length-exact ArrayBuffer.
  const stop = end ?? e.len;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(stop) || start < 0 || stop < start || stop > e.len)
    throw new RangeError("pak: invalid byte range");
  return bytes!.slice(e.off + start, e.off + stop);
}

/** Advisory element dtype (spec PAK_DTYPE) of a blob; throws if absent. */
export function dtypeOf(key: string): number {
  ensureLoaded();
  const e = map ? map.get(key) : undefined;
  if (!e) throw new Error("pak: missing key " + key);
  return e.dtype;
}

/** Decode a runtime data entry as UTF-8, including on QuickJS hosts. */
export function getText(key: string): string {
  return utf8ToString(get(key));
}
