// PocketJS db spec — the boundary of the DB module (`globalThis.db`).
//
// This is a MODULE spec in the docs/RUNTIMES.md §5 sense: a vertical slice
// with its own vocabulary, mounted as its own namespace, pinned here as data.
// It is deliberately NOT part of the `ui` op table — db evolves append-only
// in its own op space, and a host adopts it independently of the UI surface
// (capability id `data.sqlite` in contracts/spec/platforms.ts).
//
// The module is SQLite behind a five-op namespace. The engine, the SQL
// dialect, and the file format are SQLite's — the spec pins only what
// crosses the boundary: op codes, the JSON row encoding, the resource
// ceilings, and the storage/clock rules a host must follow.
//
// The four parts of the boundary:
//
//   ops            guest -> core intent (numeric codes below, append-only)
//   events         none — every op is synchronous; the module owns no clock
//   data contract  the JSON value encoding + database name rules (this file)
//   frame contract every op completes inside the guest's single per-tick
//                  turn (law 3 holds unchanged). SQL time and randomness
//                  resolve host-side: deterministic hosts pin them, and a
//                  golden-tested app must not depend on `random()` or
//                  'now'-relative SQL (same rule as Date.now in guest code).
//
// Storage rule: `open(name)` is the ONLY path to a database. Names are
// logical (below); the HOST maps them to real files under the app's own
// data root (or memory). The guest never sees a path, and a database file
// is never shared between apps. Hosts MUST refuse `ATTACH` — it is the one
// SQL statement that names a file — so the app's data root stays the
// sandbox boundary. `sqlite3_load_extension` stays disabled (SQLite's
// default).
//
// If you change ANY value here: run `bun contracts/spec/gen-rust.ts`, commit
// the regenerated engine/spec/src/lib.rs (tests/contract.ts byte-compares).

// ---------------------------------------------------------------------------
// Db ops (the `db.*` native contract)
// ---------------------------------------------------------------------------
// Numeric codes are the FFI ABI identity of each op. 0 is reserved
// (invalid/nop). Codes are append-only: never renumber, never reuse.
//
// Signatures (authoritative; hosts marshal them however they like):
//   open(name:string) -> handle | -1
//                    [name is DB_MEMORY or matches DB_NAME_PATTERN; -1 =
//                     refused (bad name or DB_MAX_DATABASES already open).
//                     Opening the same persistent name twice returns the
//                     SAME handle; DB_MEMORY always opens a fresh private
//                     database]
//   close(handle)                          [idempotent; a closed handle is
//                                           dead and every later op on it
//                                           fails with "database is closed"]
//   exec(handle, sql:string) -> 0 | 1      [run one or more statements, no
//                                           result rows — the schema and
//                                           migration path. 1 = failed; the
//                                           detail is lastError()]
//   query(handle, sql:string, args:string) -> string
//                    [run ONE statement with bound parameters and return
//                     the complete result as one JSON line (shape below).
//                     `args` is a JSON array (positional) or object (named
//                     $x / :x / @x) of encoded values. Statement caching is
//                     HOST-side, keyed by the sql string — the guest holds
//                     no statement handles]
//   lastError(handle) -> string            [detail for the last failed
//                                           exec/query on this handle; ""
//                                           when none]
//
// query() result, one JSON object per call (fields append-only):
//
//   { "cols": ["id","name"], "rows": [[1,"a"],[2,"b"]],
//     "changes": 0, "lastInsertRowid": 0 }
//        `cols` are the statement's column names ([] for non-readers),
//        `rows` are arrays in column order using the value encoding below.
//        `changes` / `lastInsertRowid` are SQLite's counters after the call.
//   { "error": "no such table: t" }
//        The statement failed (parse, bind, step, or a ceiling below).
//        lastError() returns the same string.

export const DB_OP = {
  open: 1,
  close: 2,
  exec: 3,
  query: 4,
  lastError: 5,
} as const;

// ---------------------------------------------------------------------------
// Data contract — value encoding (rows out, parameters in)
// ---------------------------------------------------------------------------
// SQLite value -> JSON value, both directions:
//
//   NULL     <-> null
//   INTEGER  <-> number            [|v| must be <= 2^53 - 1. A larger stored
//                                   integer makes the op FAIL — a loud error
//                                   beats silent precision loss. Store money
//                                   in cents and ids under 2^53.]
//   REAL     <-> number            [non-finite REAL fails the same way]
//   TEXT     <-> string
//   BLOB     <-> { "$b": "<base64>" }
//
// Binding accepts additionally: true/false bind as INTEGER 1/0, and a JSON
// number binds as INTEGER when integer-valued, else REAL (the bun:sqlite /
// better-sqlite3 convention the SDK mirrors).

/** Marker key for a BLOB value inside a row or a parameter list. */
export const DB_BLOB_KEY = "$b";

/** Largest integer magnitude that crosses the boundary losslessly. */
export const DB_MAX_SAFE_INTEGER = 9007199254740991;

// ---------------------------------------------------------------------------
// Data contract — database names
// ---------------------------------------------------------------------------

/** The in-memory database name (private to the handle, gone on close). */
export const DB_MEMORY = ":memory:";

/**
 * Logical persistent-database names: a filename-safe token, no paths, no
 * extensions games. The host maps a name to a real file under the app's own
 * data root; the mapping is host policy and never guest-visible. The 57-char
 * ceiling keeps the reference mapping `<name>.sqlite` (+7 bytes) within the
 * fs module's 64-byte segment ceiling, so a co-mounted fs module can always
 * address the database file the docs call "visible like any of its files".
 */
export const DB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,56}$/;

// ---------------------------------------------------------------------------
// Data contract — resource ceilings
// ---------------------------------------------------------------------------

/** Open databases per guest. An app has its own db plus room for a scratch
 *  or migration companion. Deliberately tiny — more simultaneous databases
 *  is a schema smell, not a bigger constant. */
export const DB_MAX_DATABASES = 4;

/**
 * Result-row ceiling per query() call. A query producing more rows FAILS
 * ("query exceeds DB_MAX_RESULT_ROWS; add LIMIT or aggregate") — the row
 * budget of a 480x272..720x1280 UI is far below this, and an unbounded
 * SELECT on a device heap is a bug surfaced early, not a workload.
 */
export const DB_MAX_RESULT_ROWS = 4096;
