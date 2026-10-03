// Fs module SDK — the thin guest-side algebra over the `fs` spec
// (contracts/spec/fs.ts). Framework-agnostic (no solid-js, no JSX): the
// same file serves ./fs, ./vue-vapor/fs and ./octane/fs.
//
// The API is the Bun shape — `file(path)` returning a lazy handle with
// `.text()/.bytes()/.json()/.size/.exists()`, `write(path, data)` — plus
// the node:fs sync subset Bun implements (readFileSync, writeFileSync,
// appendFileSync, mkdirSync, readdirSync, rmSync, renameSync, statSync,
// existsSync) — so file code written against Bun runs against the mounted
// module with the async wrappers dropped. One deliberate deviation, from
// the module family's frame contract: everything is synchronous (every op
// completes inside the guest's per-tick turn), so `.text()` returns the
// string, not a Promise. Migration stays painless anyway: `await` unwraps
// a plain value, so Bun-idiomatic code — `await Bun.file(p).text()`,
// `await Bun.write(p, data)` — runs against this SDK unchanged.
//
// Paths are RELATIVE to the app's own data root — the host binds the root
// at mount; there is no way to spell another app's tree (or an absolute
// path) in this vocabulary. The SDK chunks payloads larger than
// FS_MAX_IO_BYTES, so file size is bounded by storage (and any host
// quota), not by the marshaling ceiling.
//
// Like db (and unlike audio), absence does NOT degrade to a no-op: file
// code that silently drops writes is a corruption bug, not a missing
// enhancement. Every entry point throws where `globalThis.fs` is
// unmounted — declare `data.fs` in pocket.json `requires` so admission
// catches it first.

import {
  FS_BLOB_KEY,
  FS_MAX_IO_BYTES,
  FS_READ_TEXT_TOO_LARGE,
  FS_WRITE_APPEND,
  FS_WRITE_TRUNCATE,
} from "../../contracts/spec/fs.ts";
import { base64ToBytes, bytesToBase64, utf8ToString } from "./bytes.ts";

export {
  FS_MAX_DEPTH,
  FS_MAX_DIR_ENTRIES,
  FS_MAX_IO_BYTES,
  FS_MAX_TEXT_BYTES,
  FS_MAX_PATH_BYTES,
  fsValidPath,
} from "../../contracts/spec/fs.ts";

/** The mounted fs namespace — one method per spec op (FS_OP codes). */
export interface FsOps {
  read(path: string, offset: number, maxBytes: number): string;
  /** Optional whole-file UTF-8 fast path (FS_OP.readText). */
  readText?(path: string): string;
  write(path: string, data: string, mode: number): number;
  remove(path: string, recursive: number): number;
  list(path: string, offset: number): string;
  stat(path: string): string;
  mkdir(path: string): number;
  rename(from: string, to: string): number;
  usage(): string;
  lastError(): string;
}

/** The fs module namespace, or null where the host doesn't mount one.
 *  A live lookup (not cached): hosts install `globalThis.fs` before eval
 *  and reset it per app load, exactly like `globalThis.ui`. */
export function fsHost(): FsOps | null {
  const ns = (globalThis as { fs?: unknown }).fs;
  if (!ns || typeof ns !== "object") return null;
  return typeof (ns as FsOps).read === "function" ? (ns as FsOps) : null;
}

function host(): FsOps {
  const ops = fsHost();
  if (!ops) {
    throw new Error("fs: globalThis.fs is not mounted — declare `data.fs` in pocket.json requires");
  }
  return ops;
}

function fail(ops: FsOps, op: string): never {
  throw new Error(`fs: ${op}: ${ops.lastError()}`);
}

// ---------------------------------------------------------------------------
// Payload encoding (the contracts/spec/fs.ts data contract)
// ---------------------------------------------------------------------------

interface ReadResult {
  data?: { [FS_BLOB_KEY]: string };
  size?: number;
  eof?: boolean;
  error?: string;
}

/** Read the whole file as bytes, chunking past FS_MAX_IO_BYTES. */
function readAll(ops: FsOps, path: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const result = JSON.parse(ops.read(path, offset, FS_MAX_IO_BYTES)) as ReadResult;
    if (result.error !== undefined) throw new Error(`fs: read ${path}: ${result.error}`);
    const chunk = base64ToBytes(result.data![FS_BLOB_KEY]);
    chunks.push(chunk);
    offset += chunk.length;
    if (result.eof) break;
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(offset);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Read the whole file as strict UTF-8. New hosts return the raw string;
 *  older hosts keep the byte/base64 path for compatibility. */
function readTextAll(ops: FsOps, path: string): string {
  if (typeof ops.readText === "function") {
    const text = ops.readText(path);
    const error = ops.lastError();
    if (error === FS_READ_TEXT_TOO_LARGE) return utf8ToString(readAll(ops, path));
    if (error !== "") throw new Error(`fs: read ${path}: ${error}`);
    return text;
  }
  return utf8ToString(readAll(ops, path));
}

/** Write `data` in <= FS_MAX_IO_BYTES payloads: one truncate, then appends.
 *  A string payload crosses as the JSON string itself (stored as UTF-8);
 *  bytes cross base64. Returns bytes written. */
function writeAll(ops: FsOps, path: string, data: string | Uint8Array, mode: number): number {
  if (typeof data === "string") {
    // JS string length bounds UTF-8 length only within 3x; slice by
    // codepoint-safe chunks conservatively sized so the encoded payload
    // stays under the ceiling.
    const step = Math.floor(FS_MAX_IO_BYTES / 3);
    if (data.length <= step && mode === FS_WRITE_TRUNCATE) {
      if (ops.write(path, JSON.stringify(data), mode) !== 0) fail(ops, `write ${path}`);
      return utf8Length(data);
    }
    let m = mode;
    let i = 0;
    do {
      let end = Math.min(i + step, data.length);
      // Never split a surrogate pair across payloads.
      if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) end--;
      if (ops.write(path, JSON.stringify(data.slice(i, end)), m) !== 0) {
        fail(ops, `write ${path}`);
      }
      i = end;
      m = FS_WRITE_APPEND;
    } while (i < data.length);
    return utf8Length(data);
  }
  let m = mode;
  let i = 0;
  do {
    const chunk = data.subarray(i, Math.min(i + FS_MAX_IO_BYTES, data.length));
    const payload = JSON.stringify({ [FS_BLOB_KEY]: bytesToBase64(chunk) });
    if (ops.write(path, payload, m) !== 0) fail(ops, `write ${path}`);
    i += chunk.length;
    m = FS_WRITE_APPEND;
  } while (i < data.length);
  return data.length;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (c >= 0x10000) i++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// file / write (the Bun shape)
// ---------------------------------------------------------------------------

interface StatResult {
  kind?: "file" | "dir";
  size?: number;
  error?: string;
}

function statOf(ops: FsOps, path: string): StatResult {
  return JSON.parse(ops.stat(path)) as StatResult;
}

/** A lazy handle on one path — the Bun.file shape, synchronous. */
export class PocketFile {
  constructor(readonly path: string) {}

  /** File size in bytes; 0 when the file does not exist (Bun's behavior). */
  get size(): number {
    const s = statOf(host(), this.path);
    return s.kind === "file" ? s.size! : 0;
  }

  exists(): boolean {
    return statOf(host(), this.path).kind === "file";
  }

  bytes(): Uint8Array {
    return readAll(host(), this.path);
  }

  text(): string {
    return readTextAll(host(), this.path);
  }

  json(): unknown {
    return JSON.parse(this.text());
  }

  /** Delete the file (Bun.file(...).delete()). */
  delete(): void {
    const ops = host();
    if (ops.remove(this.path, 0) !== 0) fail(ops, `remove ${this.path}`);
  }
}

/** `file(path)` — a lazy handle; nothing is read until a method call. */
export function file(path: string): PocketFile {
  return new PocketFile(path);
}

/** `write(path, data)` — replace the file atomically, creating parent
 *  directories (Bun.write semantics). Returns bytes written. */
export function write(path: string, data: string | Uint8Array): number {
  return writeAll(host(), path, data, FS_WRITE_TRUNCATE);
}

/** `usage()` — the app's storage footprint and budget (0 = unmetered). */
export function usage(): { usedBytes: number; quotaBytes: number } {
  return JSON.parse(host().usage()) as { usedBytes: number; quotaBytes: number };
}

// ---------------------------------------------------------------------------
// The node:fs sync subset (the spelling Bun also implements)
// ---------------------------------------------------------------------------

export function readFileSync(path: string): Uint8Array;
export function readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
export function readFileSync(path: string, encoding?: string): Uint8Array | string {
  const ops = host();
  return encoding === "utf8" || encoding === "utf-8"
    ? readTextAll(ops, path)
    : readAll(ops, path);
}

export function writeFileSync(path: string, data: string | Uint8Array): void {
  writeAll(host(), path, data, FS_WRITE_TRUNCATE);
}

export function appendFileSync(path: string, data: string | Uint8Array): void {
  writeAll(host(), path, data, FS_WRITE_APPEND);
}

/** Always recursive (every missing ancestor is created), idempotent. */
export function mkdirSync(path: string): void {
  const ops = host();
  if (ops.mkdir(path) !== 0) fail(ops, `mkdir ${path}`);
}

export interface DirEntry {
  name: string;
  kind: "file" | "dir";
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

interface ListResult {
  entries?: { name: string; kind: "file" | "dir"; size: number }[];
  eof?: boolean;
  error?: string;
}

export function readdirSync(path: string): string[];
export function readdirSync(path: string, options: { withFileTypes: true }): DirEntry[];
export function readdirSync(
  path: string,
  options?: { withFileTypes?: boolean },
): string[] | DirEntry[] {
  const ops = host();
  const entries: DirEntry[] = [];
  let offset = 0;
  for (;;) {
    const result = JSON.parse(ops.list(path, offset)) as ListResult;
    if (result.error !== undefined) throw new Error(`fs: readdir ${path}: ${result.error}`);
    for (const e of result.entries!) {
      entries.push({
        ...e,
        isFile: () => e.kind === "file",
        isDirectory: () => e.kind === "dir",
      });
    }
    offset += result.entries!.length;
    if (result.eof) break;
  }
  return options?.withFileTypes ? entries : entries.map((e) => e.name);
}

/** `force` swallows "not found" (node semantics); `recursive` removes a
 *  directory tree. */
export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void {
  const ops = host();
  if (ops.remove(path, options?.recursive ? 1 : 0) !== 0) {
    if (options?.force && ops.lastError() === "not found") return;
    fail(ops, `rm ${path}`);
  }
}

export function renameSync(from: string, to: string): void {
  const ops = host();
  if (ops.rename(from, to) !== 0) fail(ops, `rename ${from} -> ${to}`);
}

export interface Stats {
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export function statSync(path: string): Stats {
  const s = statOf(host(), path);
  if (s.error !== undefined) throw new Error(`fs: stat ${path}: ${s.error}`);
  return {
    size: s.size!,
    isFile: () => s.kind === "file",
    isDirectory: () => s.kind === "dir",
  };
}

export function existsSync(path: string): boolean {
  return statOf(host(), path).kind !== undefined;
}
