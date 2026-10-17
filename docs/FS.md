# The FS Module

FS is PocketJS's fifth module (after `ui`, `strike`, `audio` and `db`): a
per-app file tree mounted as `globalThis.fs` behind nine required synchronous
ops and an optional whole-file text-read acceleration.
Like db it was written spec-first — the boundary existed before any host
code, every host implements the same pinned protocol, and a developer
adding a storage feature extends the spec instead of forking a host.
`contracts/spec/fs.ts` is normative; this page is the map.

```
platform storage (POSIX dir · LittleFS · memory)                Host / substrate
    ↑ the app's own data root is the port point
fs core: path grammar + confinement + atomic writes             the module
fs spec: ops (read, write, remove, list, stat, mkdir,
              rename, usage, lastError; optional readText)
         events (none — every op is synchronous)
         data contract (path grammar · payload encoding · ceilings)
         frame contract (no module clock; no mtime; ops complete in the turn)
SDK: @pocketjs/framework/fs (file/write + the node:fs sync subset — the Bun shape)
    ↓
app: notes in files, assets in dirs, config in json               Guest
```

## The boundary in one page

**Mount.** The module is its own namespace: `globalThis.fs`, one method per
op (`FS_OP` codes are the ABI identity, append-only). Capability id
`data.fs`. Like db, absence does **not** degrade to a no-op — file code
that silently drops writes is a corruption bug, so the SDK throws where the
namespace is unmounted, and an app declares `data.fs` in `pocket.json`
`requires` so admission catches the gap before eval does.

**Ops** (guest → core, all synchronous): `read(path, offset, maxBytes)` →
one JSON line (`{data:{"$b":…}, size, eof}`), `write(path, data, mode)`
with truncate/append modes, `remove(path, recursive)`, `list(path, offset)`
→ name-sorted, paged entries, `stat(path)` → `{kind, size}`,
`mkdir(path)` (recursive, idempotent), `rename(from, to)`, `usage()` →
`{usedBytes, quotaBytes}`, and `lastError()`. Hosts may expose
`readText(path)`, which validates and returns one complete UTF-8 file as a raw
string. It returns `""` on error and sets `lastError()`; a successful empty file
returns `""` but clears `lastError()`. The SDK probes for the method and
falls back to `read` when it is absent.

**Payloads** cross as one JSON value: text as a JSON string (stored as its
UTF-8 bytes), bytes as `{"$b": "<base64>"}` — the db module's blob
spelling. `read` always returns bytes. `readText`, where present, returns raw
text to avoid a base64 and JSON round trip. The SDK's `.text()` decodes UTF-8
guest-side when the optional method is absent.

**The storage rule — isolation by construction.** Every path is relative
and resolves under the app's own data root, bound by the host at mount.
Names are universal — any well-formed Unicode a filesystem can hold,
dot-prefixed included; nothing in the app's tree is reserved to the host.
Isolation never depended on names: `..`, absolute paths, and `/` inside a
name are unrepresentable, so there is no way to *spell* another app's
tree — the same principle as db's "open(name) is the only path to a
database" and its ATTACH refusal. Hosts must not follow a symlink out of
the root; the reference core lstat-checks every segment and treats any
symlink as absent.

The confinement binds the **guest**, not the host. On Pocket Pi the device
agent's home is the whole workspace — with every app root laid out under
it (`/workspace/apps/<app-id>/data/`), the agent reads and writes every
app's tree through the same module, bound wider, while apps still cannot
reach each other. Privilege is the binding, not the code.

One data root serves both data modules: a database is an ordinary file
(`<data root>/<name>.sqlite`) in the app's home — its own asset, visible
like any of its files (backup = a file copy). Overwriting it corrupts the
app's own data, the same trust class as deleting its own files; SQLite
fails loudly on a corrupt image.

**Atomicity.** A truncate `write` lands completely or not at all: the
payload lands in the module's own temp directory — outside the bound
root, same filesystem — then renames over the target, so after power
loss the file holds the old content or the new, never a torn middle, and
the app's tree never shows host machinery (the module owns the temp
directory and clears it on construction, so a crash orphan cannot
outlive the next boot). Append is not atomic. LittleFS's rename is
atomic, so device hosts inherit the contract by the same moves.

**The op is the atomic unit.** A file larger than `FS_MAX_IO_BYTES`
crosses as one truncate plus appends (the SDK's chunking), so power loss
between chunks can leave the leading chunks only. An app that needs
whole-file atomicity above 64 KiB writes to a sibling name and
`rename`s over the target — the same move the module itself makes.

**Ceilings.** `FS_MAX_IO_BYTES` (64 KiB) per read/write payload — the SDK
chunks larger files, so the ceiling bounds marshaling, not file size. It does
not apply to optional `readText`, whose successful return holds the complete
file up to `FS_MAX_TEXT_BYTES` (1 MiB). Larger files fall back to paged binary
reads, and memory-constrained hosts may omit the method.
`FS_MAX_DIR_ENTRIES` (256) per `list()` call, paged via offset + eof — a
big directory is slower to enumerate, never impossible. Paths:
`FS_MAX_DEPTH` (8) segments of `FS_MAX_SEGMENT_BYTES` (64) each,
`FS_MAX_PATH_BYTES` (160) total. A per-app byte quota is host policy,
reported by `usage()` (0 = unmetered) and enforced on write.

**Frame contract.** The module owns no clock and emits no events: every op
completes inside the guest's single per-tick turn (law 3 unchanged). There
is no `watch()` — watching needs events and a clock; a per-tick guest
polls `stat()` when it must. `stat` carries **no mtime**: a timestamp is
the fs spelling of `Date.now`, and a golden-tested app must not depend on
one. An app that needs a timestamp writes it into content it controls.

**Identity.** Segments are byte-for-byte identities (UTF-8, no case
folding, no Unicode normalization), but some host filesystems fold or
normalize (macOS APFS). Two sibling names differing only by case or
normalization form are not portable — never create both. The
deterministic hosts (sim, the reference core's Memory storage) are
byte-exact, so a golden test catches the collision before a folding
device filesystem hides it.

## The SDK

`@pocketjs/framework/fs` is the Bun shape — `file()`/`write()` plus the
node:fs sync subset Bun implements — so file code written against Bun runs
against the mounted module unchanged. Methods return values synchronously
(the frame contract), and `await` unwraps a plain value, so Bun-idiomatic
`await file(p).text()` needs no edits:

```ts
import { file, write, readdirSync, mkdirSync, rmSync, usage } from "@pocketjs/framework/fs";

write("notes/today.md", "# Today\n- ship the fs module");   // atomic, mkdir -p
const f = file("notes/today.md");
f.exists();   // true
f.size;       // bytes
f.text();     // the string  (await f.text() works too)
f.bytes();    // Uint8Array
f.json();     // parsed JSON (for config files)

mkdirSync("assets/img");
readdirSync("notes", { withFileTypes: true });  // name-sorted entries
rmSync("notes", { recursive: true });
usage();      // { usedBytes, quotaBytes }
```

Also exported: `readFileSync`, `writeFileSync`, `appendFileSync`,
`renameSync`, `statSync`, `existsSync` — each the node spelling Bun also
serves. Files larger than one payload chunk transparently
(`FS_MAX_IO_BYTES` per op crossing).

Choosing between fs and db: rows, queries and transactions belong in
`data.sqlite`; documents, assets and configs belong here. A key-value need
is one db table, not a third module.

## Host status

| Host | Implementation | Status |
|---|---|---|
| sim (`hosts/sim/fs.ts`) | in-memory tree behind the op namespace, injected via `bootWorld` `extraGlobals` | ships with the test host; `tests/fs.test.ts` runs the contract, the SDK, and an oracle comparison against Bun's real fs |
| reference core (`engine/crates/pocket-fs`) | `Storage::Memory`/`Storage::Dir` over std::fs — grammar confinement, symlink refusal, atomic truncate writes, quota — mountable on any `pocket-mod` guest as `globalThis.fs` | tested including a live QuickJS guest round-trip |
| consoles / devices | — | a target appends `data.fs` to its profile when its native host ships the module; the port point is the data root (POSIX dir on desktop, a LittleFS directory on MCU hosts) |

## Adoption path

A device host that wants the module makes three moves, none of which touch
the spec, the SDK, or any app:

1. pick the app's data root and a sibling temp directory on the platform
   filesystem (Pocket Pi: `/workspace/apps/<app-id>/data/` — the SAME
   root the db module binds — and `/workspace/apps/<app-id>/tmp/`) and
   construct the module bound to them —
   `pocket_fs::FsModule::new(Storage::Dir { root, tmp })`, one instance
   per app;
2. mount the namespace beside `ui` — `pocket_fs::mount(&guest, module)` on
   `pocket-mod` hosts, or the raw-QuickJS spelling of the nine required
   functions elsewhere (depend with `default-features = false` to drop the
   pocket-mod dependency; verified to `cargo check` clean for
   `riscv32imafc-esp-espidf`);
3. append `data.fs` to the target's profile in
   `contracts/spec/platforms.ts`.
