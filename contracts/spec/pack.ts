// PocketJS pack spec — the boundary of the PACK module (`globalThis.pack`).
//
// A pack is a read-only file under the app's game data root, opened at
// runtime: chapter textures and streamed music that do not ship in the
// program image. It is its own namespace, independent of the `ui` op table,
// with capability id `data.pack` in contracts/spec/platform-types.ts.
//
// The four parts of the boundary:
//
//   ops            guest -> host intent (numeric codes below, append-only)
//   events         none — every op is synchronous. A host that cannot answer
//                  open() yet returns PACK_OPEN_PENDING and the guest calls
//                  open() again on a later frame.
//   data contract  the path grammar below; loadImg's byte range is one IMG
//                  entry (framework/compiler/pak.ts, the uploadImgEntry
//                  layout)
//   frame contract every op completes inside the guest's single per-tick
//                  turn, and read/loadImg cost device I/O on that turn. The
//                  guest bounds the bytes it asks for per frame.
//
// Storage rule: a path is relative and resolves under the game data root the
// host binds. Native hosts look in the directory the program was loaded from
// first, then in the host's fixed fallback directories (docs/PACKS.md). A pack
// is read-only: there is no write op. Read time is the device's: a memory stick
// and a USB share (PSPLINK host0:) differ, so no caller assumes a fixed cost.
//
// If you change ANY value here: run `bun contracts/spec/gen-rust.ts`, commit
// the regenerated engine/spec/src/lib.rs (tests/contract.ts byte-compares).

// ---------------------------------------------------------------------------
// Pack ops (the `pack.*` native contract)
// ---------------------------------------------------------------------------
// Numeric codes are the FFI ABI identity of each op. 0 is reserved
// (invalid/nop). Codes are append-only: never renumber, never reuse.
//
// Signatures (authoritative; hosts marshal them however they like):
//   open(path) -> handle >= 0 | PACK_OPEN_MISSING | PACK_OPEN_PENDING
//                    [PACK_OPEN_MISSING: not found, invalid path, or
//                     PACK_MAX_HANDLES files already open.
//                     PACK_OPEN_PENDING: the host started fetching the file
//                     and will answer on a later call]
//   size(handle) -> bytes | -1
//   read(handle, offset, dst:Uint8Array) -> bytes | -1
//                    [fills dst or stops at end of file; writes into dst's
//                     own storage without an intermediate string or copy
//                     through the JS heap. Offset past the end returns 0]
//   loadImg(handle, offset, length) -> texture handle | -1
//                    [bytes [offset, offset+length) are one IMG entry. The
//                     host decodes them to a texture; the bytes never enter
//                     the JS heap. The caller releases the texture with the
//                     ui op freeTexture]
//   close(handle)    [stale and unknown handles are no-ops]
//   stats() -> string
//                    [one JSON line of diagnostic counters, shape below. Not
//                     a timing source for app logic]

export const PACK_OP = {
  open: 1,
  size: 2,
  read: 3,
  loadImg: 4,
  close: 5,
  stats: 6,
} as const;

/** open(): not found, invalid path, or no free handle. */
export const PACK_OPEN_MISSING = -1;
/** open(): fetch in progress; call again on a later frame. */
export const PACK_OPEN_PENDING = -2;

/** Files open at once per guest. */
export const PACK_MAX_HANDLES = 8;

/**
 * Upper bound of one loadImg byte range: a 512x512 PSM_8888 image is
 * 1 048 584 bytes, and PackBits can expand incompressible input by 1/128.
 */
export const PACK_MAX_IMG_BYTES = 1_114_112;

/** Path grammar ceilings (UTF-8 bytes). */
export const PACK_MAX_PATH_BYTES = 200;
export const PACK_MAX_SEGMENT_BYTES = 64;
export const PACK_MAX_DEPTH = 8;

/**
 * stats() shape. Hosts report what they measure and leave the rest 0.
 *   opens, reads, readBytes, loadImgs: running counts.
 *   readUs{Last,Max,Sum}, loadImgUs{Last,Max,Sum}: microseconds per op.
 *   readBufBytes: capacity of the host's retained loadImg read buffer.
 *   root: where the last open resolved ("program" | "cwd" | "fallback" | "host0" | "url" | "dir" | "").
 */
export interface PackStats {
  opens: number;
  reads: number;
  readBytes: number;
  loadImgs: number;
  readUsLast: number;
  readUsMax: number;
  readUsSum: number;
  loadImgUsLast: number;
  loadImgUsMax: number;
  loadImgUsSum: number;
  readBufBytes: number;
  root: string;
}

/** The mounted pack namespace, one method per PACK_OP. */
export interface PackOps {
  open(path: string): number;
  size(handle: number): number;
  read(handle: number, offset: number, dst: Uint8Array): number;
  loadImg(handle: number, offset: number, length: number): number;
  close(handle: number): void;
  stats?(): string;
}

function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Path grammar: relative, '/'-separated; no empty, "." or ".." segment; no
 * ':' (a device prefix) or '\'; within the ceilings above. Hosts reject
 * anything else with PACK_OPEN_MISSING. The native checks in
 * programs/psp/src/pack_ops.rs and platforms/web/pack.js implement this rule.
 */
export function packValidPath(path: string): boolean {
  if (path.length === 0 || utf8Bytes(path) > PACK_MAX_PATH_BYTES) return false;
  if (path.includes(":") || path.includes("\\")) return false;
  const segments = path.split("/");
  if (segments.length > PACK_MAX_DEPTH) return false;
  return segments.every(
    (s) => s.length > 0 && s !== "." && s !== ".." && utf8Bytes(s) <= PACK_MAX_SEGMENT_BYTES,
  );
}
