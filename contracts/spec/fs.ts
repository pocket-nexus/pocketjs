// PocketJS fs spec — the boundary of the FS module (`globalThis.fs`).
//
// This is a MODULE spec in the docs/RUNTIMES.md §5 sense: a vertical slice
// with its own vocabulary, mounted as its own namespace, pinned here as data.
// It is deliberately NOT part of the `ui` op table — fs evolves append-only
// in its own op space, and a host adopts it independently of the UI surface
// (capability id `data.fs` in contracts/spec/platforms.ts).
//
// The module is a per-app file tree behind nine required synchronous ops and
// one optional text-read acceleration op. The SDK
// (@pocketjs/framework/fs) is the Bun shape — `file()`/`write()` plus the
// node:fs sync subset Bun implements — so file code written against Bun runs
// against the mounted module with the async wrappers dropped.
//
// The four parts of the boundary:
//
//   ops            guest -> core intent (numeric codes below, append-only)
//   events         none — every op is synchronous; the module owns no clock.
//                  There is no watch(): watching needs events and a clock,
//                  and a per-tick guest can poll stat() when it must.
//   data contract  the path grammar + payload encoding below
//   frame contract every op completes inside the guest's single per-tick
//                  turn (law 3 holds unchanged). stat() carries NO mtime —
//                  a timestamp is the fs spelling of Date.now, and a
//                  golden-tested app must not depend on one. An app that
//                  needs a timestamp writes it into content it controls.
//
// Storage rule: every path is RELATIVE and resolves under the app's own
// data root; the host binds that root when it mounts the module, and the
// guest never sees a real path. There is no op that names another app's
// tree — isolation is by construction, not by permission check (the same
// principle as db's "open(name) is the only path to a database" and its
// ATTACH refusal). Hosts MUST NOT follow a symlink out of the root: the
// guest cannot create symlinks through this API, but a host-side actor may
// have (on Pocket Pi the device agent owns the whole workspace and every
// app root under it — that asymmetry is host layout policy, above this
// boundary, see docs/FS.md), so the reference core lstat-checks every
// segment.
//
// If you change ANY value here: run `bun contracts/spec/gen-rust.ts`, commit
// the regenerated engine/core/src/spec.rs (tests/contract.ts byte-compares).

// ---------------------------------------------------------------------------
// Fs ops (the `fs.*` native contract)
// ---------------------------------------------------------------------------
// Numeric codes are the FFI ABI identity of each op. 0 is reserved
// (invalid/nop). Codes are append-only: never renumber, never reuse.
//
// Signatures (authoritative; hosts marshal them however they like). Ops
// returning 0 | 1 report detail through lastError(); ops returning a JSON
// line carry their own {"error": "..."} shape (and set lastError too).
//
//   read(path, offset:number, maxBytes:number) -> string
//                    [one JSON line: {"data":{"$b":"<base64>"},"size":N,
//                     "eof":bool} or {"error":...}. Reads up to maxBytes
//                     bytes at byte offset; maxBytes must be 1..FS_MAX_IO_BYTES
//                     or the op fails. `size` is the file's total byte size,
//                     `eof` is true when offset+data reaches it. Reading a
//                     directory fails]
//   readText(path) -> string
//                    [OPTIONAL acceleration op. Reads the complete file,
//                     validates UTF-8, and returns the decoded text as a raw
//                     string. A successful empty file returns "" and clears
//                     lastError(); failure also returns "" but sets
//                     lastError(), so callers MUST sample lastError()
//                     immediately after the call. Missing paths, directories,
//                     invalid paths, and malformed UTF-8 fail. There is no
//                     offset/eof envelope: success always means the complete
//                     file reached EOF. FS_MAX_IO_BYTES does not apply because
//                     chunking can split a UTF-8 sequence and would recreate
//                     guest-side joining. Files above FS_MAX_TEXT_BYTES fail
//                     with "readText exceeds FS_MAX_TEXT_BYTES"; the SDK then
//                     falls back to paged read(). A host may omit this optional
//                     op and receive the same fallback. The raw string avoids
//                     JSON escaping/parsing and a second full-size copy;
//                     lastError() supplies the otherwise ambiguous error
//                     channel]
//   write(path, data:string, mode:number) -> 0 | 1
//                    [data is the payload encoding below, decoded byte length
//                     <= FS_MAX_IO_BYTES per call (the SDK chunks larger
//                     writes). mode FS_WRITE_TRUNCATE replaces the file
//                     ATOMICALLY — the old content or the new, never a torn
//                     middle (temp + rename; the power-loss contract device
//                     hosts inherit from LittleFS's atomic rename. Temps
//                     live in a host directory outside the bound root, so
//                     the app's tree never shows host machinery).
//                     FS_WRITE_APPEND appends and is not atomic. Parent
//                     directories are created automatically (Bun.write
//                     semantics). Writing over a directory fails]
//   remove(path, recursive:number) -> 0 | 1
//                    [removes a file, or a directory when empty; recursive=1
//                     removes a directory tree. A missing path fails with
//                     "not found" (the SDK's rmSync force option swallows
//                     that one). remove("") — the root — always fails]
//   list(path, offset:number) -> string
//                    [{"entries":[{"name":"a.txt","kind":"file","size":N},
//                     {"name":"sub","kind":"dir","size":0}],"eof":bool} or
//                     {"error":...}. Entries sort by name in Unicode code
//                     point order (= UTF-8 byte order; NOT UTF-16 code unit
//                     order — hosts written in JS must sort by code point) —
//                     deterministic across hosts — and one call returns at
//                     most FS_MAX_DIR_ENTRIES of them starting at `offset`
//                     in that order; `eof` false means page again. list("")
//                     lists the root]
//   stat(path) -> string
//                    [{"kind":"file","size":N} | {"kind":"dir","size":0} or
//                     {"error":"not found"}. stat("") is the root: always
//                     {"kind":"dir","size":0}. No mtime — see the frame
//                     contract above]
//   mkdir(path) -> 0 | 1
//                    [recursive (every missing ancestor is created) and
//                     idempotent (an existing directory is success). A file
//                     anywhere on the path fails]
//   rename(from, to) -> 0 | 1
//                    [moves a file or directory within the root. An existing
//                     file at `to` is replaced atomically; an existing
//                     directory at `to` fails; a missing parent of `to`
//                     fails (mkdir first — rename does not create). Renaming
//                     a directory into its own subtree fails]
//   usage() -> string
//                    [{"usedBytes":N,"quotaBytes":N} — usedBytes sums every
//                     file's size under the root; quotaBytes is the host's
//                     configured budget for this app, 0 = unmetered. When a
//                     quota is set, a write/append that would exceed it
//                     fails with "quota exceeded"]
//   lastError() -> string
//                    [detail for the last failed op on this module; "" when
//                     the last op succeeded. Module-scoped — there are no
//                     handles in this vocabulary]

export const FS_OP = {
  read: 1,
  write: 2,
  remove: 3,
  list: 4,
  stat: 5,
  mkdir: 6,
  rename: 7,
  usage: 8,
  lastError: 9,
  readText: 10,
} as const;

/** write() modes. */
export const FS_WRITE_TRUNCATE = 0;
export const FS_WRITE_APPEND = 1;

// ---------------------------------------------------------------------------
// Data contract — payload encoding (write data in, read data out)
// ---------------------------------------------------------------------------
// A payload crossing the boundary is one JSON value:
//
//   text   <-> a JSON string        [stored as its UTF-8 bytes]
//   bytes  <-> { "$b": "<base64>" } [the db module's blob spelling]
//
// write() accepts either; read() always returns bytes — the file does not
// remember which spelling wrote it. When readText() is absent, the SDK's
// .text() decodes UTF-8 guest-side (QuickJS has no TextDecoder; the SDK
// carries the codec).
//
// A text payload must be well-formed Unicode, like a path segment: an
// unpaired surrogate has no UTF-8 spelling, so what happens to one is
// host-dependent (a JS host lossily encodes U+FFFD where a JSON-parsing
// native core fails the op). Arbitrary byte data belongs in the bytes
// spelling, never in a string.

/** Marker key for a bytes payload (same spelling as db's DB_BLOB_KEY). */
export const FS_BLOB_KEY = "$b";

// ---------------------------------------------------------------------------
// Data contract — the path grammar
// ---------------------------------------------------------------------------
// A path is 1..FS_MAX_DEPTH segments joined by "/": no leading or trailing
// slash, no empty segment. A segment is ANY well-formed Unicode string —
// Chinese names, dot-prefixed names, whatever the app wants — except the
// four things no filesystem can or this sandbox may allow:
//
//   "." and ".."      the escape hatches (this is the security rule);
//   "/" in a name     unrepresentable — it IS the separator, on every
//                     filesystem on earth;
//   control chars     C0 (U+0000..U+001F) and DEL (U+007F);
//   oversize          a segment > FS_MAX_SEGMENT_BYTES of UTF-8;
//   lone surrogates   ill-formed Unicode has no UTF-8 spelling — a JS host
//                     could store one byte-exactly while the QuickJS-to-
//                     native bridge mangles it into a DIFFERENT name, so
//                     the shared predicate refuses it on every host.
//
// No name is reserved to the host. "" names the root and is valid only
// where an op says so (list, stat). Total path <= FS_MAX_PATH_BYTES of
// UTF-8.
//
// Identity: segments are byte-for-byte identities (compared as UTF-8, no
// case folding, no Unicode normalization). Some host filesystems fold case
// or normalize (macOS APFS); two sibling names differing only by case or
// normalization form are therefore NOT portable — an app must never create
// both. The deterministic hosts (sim, the reference core's Memory storage)
// are byte-exact, so a golden test catches the collision early.

/** Maximum UTF-8 bytes in one segment. */
export const FS_MAX_SEGMENT_BYTES = 64;

/** Maximum segments in a path (root = depth 0). */
export const FS_MAX_DEPTH = 8;

/** Maximum total path length in UTF-8 bytes (segments + separators). */
export const FS_MAX_PATH_BYTES = 160;

/** UTF-8 byte length of a JS string (QuickJS has no TextEncoder). */
function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (c >= 0x10000) i++;
  }
  return n;
}

/** True when `s` is well-formed Unicode (every surrogate is paired). */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) return false; // low with no high before it
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    }
  }
  return true;
}

/** True when `segment` is one valid path segment under the grammar above. */
export function fsValidSegment(segment: string): boolean {
  if (segment.length === 0 || segment === "." || segment === "..") return false;
  if (!wellFormed(segment)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(segment)) return false;
  return utf8Bytes(segment) <= FS_MAX_SEGMENT_BYTES;
}

/** True when `path` is a valid non-root path under the grammar above.
 *  The SAME predicate every host implements; exported so hosts and tests
 *  share one spelling. */
export function fsValidPath(path: string): boolean {
  if (path.length === 0 || utf8Bytes(path) > FS_MAX_PATH_BYTES) return false;
  const segments = path.split("/");
  if (segments.length > FS_MAX_DEPTH) return false;
  return segments.every(fsValidSegment);
}

// ---------------------------------------------------------------------------
// Data contract — resource ceilings
// ---------------------------------------------------------------------------

/**
 * Payload ceiling per read()/write() call, in bytes. One call's payload
 * must fit a device heap comfortably; the SDK loops for larger files, so
 * the ceiling bounds marshaling, not file size.
 */
export const FS_MAX_IO_BYTES = 65536;

/** Whole-file ceiling for the optional readText() acceleration. This permits
 *  enough read() chunks to amortize the native crossing while keeping one
 *  host allocation and one guest string bounded. Larger files use read(). */
export const FS_MAX_TEXT_BYTES = FS_MAX_IO_BYTES * 16;

/** Stable error used by the SDK to fall back from readText() to read(). */
export const FS_READ_TEXT_TOO_LARGE = "readText exceeds FS_MAX_TEXT_BYTES";

/**
 * Entries per list() call. list() pages (offset + eof), so a big directory
 * is slower to enumerate, never impossible — a ceiling an app cannot get
 * stuck behind, unlike an unpaged cap.
 */
export const FS_MAX_DIR_ENTRIES = 256;
