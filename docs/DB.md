# The DB Module

DB is PocketJS's fourth module (after `ui`, `strike` and `audio`): SQLite
mounted as `globalThis.db` behind five synchronous ops. Like audio it was
written spec-first — the boundary existed before any host code, every host
implements the same pinned protocol, and a developer adding a data feature
extends the spec instead of forking a host. `contracts/spec/db.ts` is
normative; this page is the map.

```
platform storage (POSIX file · LittleFS · memory)              Host / substrate
    ↑ SQLite's own VFS is the port point
db core: SQLite + handle table + statement cache               the module
db spec: ops (open, close, exec, query, lastError)
         events (none — every op is synchronous)
         data contract (JSON value encoding · name rules · ceilings)
         frame contract (no module clock; ops complete in the guest turn)
SDK: @pocketjs/framework/db (Database, Statement — the bun:sqlite shape)
    ↓
app: schema in exec(), rows out of query(), state in tables    Guest
```

## The boundary in one page

**Mount.** The module is its own namespace: `globalThis.db`, one method per
op (`DB_OP` codes are the ABI identity, append-only). Capability id
`data.sqlite`. Unlike audio, absence does **not** degrade to a no-op — data
code that silently drops writes is a corruption bug, so the SDK throws where
the namespace is unmounted, and an app declares `data.sqlite` in
`pocket.json` `requires` so admission catches the gap before eval does.

**Ops** (guest → core, all synchronous): `open(name)` → handle,
`close(handle)`, `exec(handle, sql)` → 0/1 for schema and migrations,
`query(handle, sql, argsJson)` → one JSON line
(`{cols, rows, changes, lastInsertRowid}` or `{error}`), and
`lastError(handle)`. Statement caching is **host-side**, keyed by the sql
string — the guest holds no statement handles, so there is nothing to
finalize and nothing to leak.

**Values** cross as JSON: NULL ↔ `null`, INTEGER ↔ number, REAL ↔ number,
TEXT ↔ string, BLOB ↔ `{"$b": "<base64>"}`. Integers beyond 2^53 − 1 and
non-finite REALs **fail the op** instead of losing precision silently —
store money in cents. Booleans bind as 1/0; integer-valued numbers bind as
INTEGER, fractional as REAL (the bun:sqlite convention).

**Storage rule.** `open(name)` is the only path to a database: names are
filename-safe tokens (`DB_NAME_PATTERN`, ≤ 57 chars so `<name>.sqlite`
stays within the fs module's 64-byte segment ceiling) or `:memory:`, and
the host maps a name to a real file under the app's own data root — the reference core
spells that mapping `<data root>/<name>.sqlite`. The database is an
ORDINARY file in the app's home, deliberately visible to a co-mounted fs
module: it is the app's own asset (backup = a file copy), and an app that
overwrites its own database corrupts its own data — the same trust class
as deleting its own files (SQLite fails loudly on a corrupt image). The
guest never sees a path. `ATTACH` — the one SQL statement that names a
file — is refused twice over (engine/crates/pocket-db uses a real SQLite
authorizer for the literal spelling and **`SQLITE_LIMIT_ATTACHED=0`** for
the expression spelling that reaches an authorizer with a NULL filename),
and `load_extension` stays disabled, so the data root stays the sandbox
boundary.

**Ceilings.** `DB_MAX_DATABASES` (4) open handles; `DB_MAX_RESULT_ROWS`
(4096) rows per `query()` call, above which the op fails with "add LIMIT or
aggregate" — an unbounded SELECT on a device heap is a bug surfaced early,
not a workload.

**Frame contract.** The module owns no clock and emits no events: every op
completes inside the guest's single per-tick turn (law 3 unchanged). SQL
time and randomness resolve host-side — deterministic hosts pin them, and a
golden-tested app must not depend on `random()` or 'now'-relative SQL, the
same rule as `Date.now` in guest code.

## The SDK

`@pocketjs/framework/db` is the bun:sqlite shape, so code written against
Bun's built-in SQLite runs against the mounted module unchanged:

```ts
import { Database } from "@pocketjs/framework/db";

const db = new Database("portfolio");
db.exec(`CREATE TABLE IF NOT EXISTS history (
  bucket TEXT PRIMARY KEY, total_cents INTEGER NOT NULL
)`);

const insert = db.query("INSERT OR REPLACE INTO history VALUES ($bucket, $cents)");
const record = db.transaction((bucket: string, cents: number) => {
  insert.run({ $bucket: bucket, $cents: cents });
});
record("2026-08-06T14:35", 1_532_042);

db.query("SELECT * FROM history ORDER BY bucket DESC LIMIT 288").all();
```

`query()` returns a cached `Statement` (`.get/.all/.values/.run`);
`prepare()` skips the cache; `transaction(fn)` wraps BEGIN/COMMIT with
ROLLBACK on throw and nests as savepoints — batching writes into one
transaction is also the flash-wear discipline on device hosts.

## Host status

| Host | Implementation | Status |
|---|---|---|
| sim (`platforms/sim/db.ts`) | bun:sqlite behind the op namespace, injected via `bootWorld` `extraGlobals` | ships with the test host; `tests/db.test.ts` runs the contract and an oracle comparison against bun:sqlite directly |
| reference core (`engine/crates/pocket-db`) | rusqlite (bundled SQLite) + the ATTACH authorizer, mountable on any `pocket-mod` guest as `globalThis.db` | tested including a live QuickJS guest round-trip |
| consoles / devices | — | a target appends `data.sqlite` to its profile when its native host ships the module; the port point is SQLite's VFS (POSIX on desktop, LittleFS-backed on MCU hosts). ESP-IDF support ships in the crate — see below |

## Adoption path

A device host that wants the module makes three moves, none of which touch
the spec, the SDK, or any app:

1. compile SQLite with the platform toolchain and register a VFS for the
   platform filesystem (the desktop default VFS already serves
   `Storage::Dir`);
2. mount the namespace beside `ui` — `pocket_db::mount(&guest, module)` on
   `pocket-mod` hosts, or the raw-QuickJS spelling of the same five
   functions elsewhere;
3. append `data.sqlite` to the target's profile in
   `contracts/spec/platforms.ts`.

## ESP32 / ESP-IDF

`pocket-db` carries its own ESP-IDF support behind
`cfg(target_os = "espidf")` — desktop builds never see it:

- **newlib shims** for the POSIX symbols SQLite's syscall table references
  but newlib lacks (`geteuid`/`fchmod`/`fchown`/`utimes`/`readlink` no-ops
  that are honest on a filesystem with no users or symlinks, and
  `nanosleep` routed through `usleep` for the busy handler);
- **the `unix-none` VFS** on open — LittleFS has no fcntl file locks, and
  a module instance is its files' only writer — plus flash-friendly
  pragmas (`journal_mode=TRUNCATE`, `synchronous=NORMAL`,
  `cache_size=-32`).

What the crate cannot carry is the build environment; a firmware adds, in
its `.cargo/config.toml` (values validated on an ESP32-P4, ESP-IDF v5.5.x,
LittleFS workspace — where a 288-row transaction landed in ~0.4 s on
~70–80 KB of heap and survived power cycling):

```toml
[env]
# The vendored sqlite3.c, tuned for the device: temp tables in memory, no
# mmap, no WAL (shared memory), no dynamic extension loading; lstat does
# not exist on newlib and the VFS never follows symlinks anyway.
LIBSQLITE3_FLAGS = "-DSQLITE_TEMP_STORE=3 -DSQLITE_DEFAULT_MEMSTATUS=0 -DSQLITE_MAX_MMAP_SIZE=0 -DSQLITE_OMIT_WAL -DSQLITE_OMIT_LOAD_EXTENSION -Dlstat=stat"
# CC_/AR_/CFLAGS_riscv32imafc_esp_espidf point at the ESP-IDF gcc as usual.
# newlib has no sys/ioctl.h: put an EMPTY sys/ioctl.h in a shim directory
# and add `-isystem <that dir>` to CFLAGS. Setting CFLAGS in [env] replaces
# cargo's derived flags, so repeat the arch flags (-mabi/-march) alongside.
```

`sqlite3_os_init` for the `unix-none` VFS, journal-file creation, and
power-loss recovery all run against ESP-IDF's VFS layer over LittleFS —
no SQLite source patches, no custom VFS to write.

A firmware that brings its own QuickJS embedding depends with
`default-features = false`: that drops the `mount` helper and its
pocket-mod/rquickjs dependency, so the MCU build compiles only the module
core plus SQLite. Verified: `cargo check` for `riscv32imafc-esp-espidf`
compiles the crate and the bundled `libsqlite3.a` clean under this
recipe.
