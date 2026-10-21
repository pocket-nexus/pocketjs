// platforms/sim/db.ts — the bun:sqlite-backed implementation of the db module
// (contracts/spec/db.ts) for the headless sim host.
//
// Bun's built-in SQLite is the same engine a device host links, so the sim
// runs the real dialect — only the storage policy is sim-shaped: every
// database, named or DB_MEMORY, lives in memory (no disk, no cleanup), and
// named databases persist for the life of the host object — across close()
// and reopen (the image is stashed with serialize()) and across an app
// reload inside one scenario — the way a device keeps its files.
//
// Three dev-host caveats, all spec-permitted:
//   - ATTACH is refused by matching the word anywhere in the sql — the only
//     net that catches every spelling SQLite accepts (`ATTACH DATABASE f`,
//     `ATTACH 'f'`, `ATTACH hex(...)`) without an authorizer, which
//     bun:sqlite does not expose (engine/crates/pocket-db carries the
//     authoritative refusal: authorizer + SQLITE_LIMIT_ATTACHED=0). A string
//     literal containing the word "attach" is a false positive a test can
//     spell around.
//   - a named parameter whose key lacks the $ / : / @ prefix is refused here
//     (the reference core fails it with "unknown parameter"), but a PREFIXED
//     key the statement never mentions is silently ignored — bun:sqlite
//     offers no parameter-name introspection to close that last gap.
//   - SQL time and randomness are NOT pinned — bun:sqlite exposes no VFS
//     hook. The spec already forbids golden-tested apps from depending on
//     them; tests/db.test.ts stays on deterministic SQL.
//
// Inject via bootWorld's extraGlobals: { db: host.ns }, the way a device
// host mounts the namespace beside `ui`.

import { Database as BunDatabase } from "bun:sqlite";
import {
  DB_MAX_DATABASES,
  DB_MAX_RESULT_ROWS,
  DB_MAX_SAFE_INTEGER,
  DB_MEMORY,
  DB_NAME_PATTERN,
  DB_BLOB_KEY,
} from "../../contracts/spec/db.ts";

interface SimDb {
  bun: BunDatabase;
  name: string;
  lastError: string;
}

export interface SimDbHost {
  /** The `globalThis.db` namespace (one method per DB_OP). */
  ns: Record<string, unknown>;
  /** Every op call in order (for trace assertions). */
  log: string[];
  /** Close every underlying database (end of scenario). */
  dispose(): void;
}

function encodeCell(v: unknown): unknown {
  if (v === null || typeof v === "string") return v;
  if (typeof v === "bigint") {
    if (v > BigInt(DB_MAX_SAFE_INTEGER) || v < -BigInt(DB_MAX_SAFE_INTEGER)) {
      throw new Error("integer result exceeds DB_MAX_SAFE_INTEGER");
    }
    return Number(v);
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite REAL result");
    return v;
  }
  if (v instanceof Uint8Array) return { [DB_BLOB_KEY]: Buffer.from(v).toString("base64") };
  throw new Error(`unencodable result value: ${typeof v}`);
}

function decodeParam(v: unknown): unknown {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const b64 = (v as Record<string, unknown>)[DB_BLOB_KEY];
    if (typeof b64 !== "string") throw new Error("malformed blob parameter");
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  if (typeof v === "number" && !Number.isFinite(v)) {
    throw new Error("cannot bind a non-finite number");
  }
  return v;
}

const ATTACH = /\battach\b/i;

export function createSimDbHost(): SimDbHost {
  const dbs = new Map<number, SimDb>();
  const byName = new Map<string, number>();
  // Serialized images of closed named databases — reopening restores them,
  // the way Storage::Dir keeps the file after close on a device host.
  const closedImages = new Map<string, Uint8Array>();
  const log: string[] = [];
  let nextHandle = 1;

  function live(handle: number): SimDb | null {
    return dbs.get(handle) ?? null;
  }

  const ns = {
    open(name: string): number {
      log.push(`op open ${name}`);
      if (name !== DB_MEMORY) {
        if (!DB_NAME_PATTERN.test(name)) return -1;
        const existing = byName.get(name);
        if (existing !== undefined) return existing;
      }
      if (dbs.size >= DB_MAX_DATABASES) return -1;
      const image = name !== DB_MEMORY ? closedImages.get(name) : undefined;
      const bun = image
        ? BunDatabase.deserialize(image, { safeIntegers: true })
        : new BunDatabase(":memory:", { safeIntegers: true });
      const handle = nextHandle++;
      dbs.set(handle, { bun, name, lastError: "" });
      if (name !== DB_MEMORY) {
        closedImages.delete(name);
        byName.set(name, handle);
      }
      return handle;
    },
    close(handle: number): void {
      log.push(`op close ${handle}`);
      const db = live(handle);
      if (!db) return;
      if (db.name !== DB_MEMORY) {
        closedImages.set(db.name, db.bun.serialize());
        byName.delete(db.name);
      }
      db.bun.close();
      dbs.delete(handle);
    },
    exec(handle: number, sql: string): number {
      log.push(`op exec ${handle}`);
      const db = live(handle);
      if (!db) return 1;
      if (ATTACH.test(sql)) {
        db.lastError = "ATTACH is refused (contracts/spec/db.ts storage rule)";
        return 1;
      }
      try {
        db.bun.exec(sql);
        db.lastError = "";
        return 0;
      } catch (error) {
        db.lastError = error instanceof Error ? error.message : String(error);
        return 1;
      }
    },
    query(handle: number, sql: string, args: string): string {
      log.push(`op query ${handle} ${sql}`);
      const db = live(handle);
      if (!db) return JSON.stringify({ error: "database is closed" });
      if (ATTACH.test(sql)) {
        db.lastError = "ATTACH is refused (contracts/spec/db.ts storage rule)";
        return JSON.stringify({ error: db.lastError });
      }
      try {
        const parsed = JSON.parse(args) as unknown[] | Record<string, unknown>;
        if (!Array.isArray(parsed)) {
          // The spec spells named parameters $x / :x / @x; bun would bind a
          // bare key anyway, the reference core fails it — fail like the core.
          for (const key of Object.keys(parsed)) {
            if (!/^[$:@]/.test(key)) throw new Error(`unknown parameter: ${key}`);
          }
        }
        const params = Array.isArray(parsed)
          ? parsed.map(decodeParam)
          : Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, decodeParam(v)]));
        const statement = db.bun.query(sql);
        // bun returns null (not []) for statements that produce no rows.
        const rows = ((Array.isArray(params)
          ? statement.values(...(params as never[]))
          : statement.values(params as never)) ?? []) as unknown[][];
        if (rows.length > DB_MAX_RESULT_ROWS) {
          throw new Error("query exceeds DB_MAX_RESULT_ROWS; add LIMIT or aggregate");
        }
        const counters = db.bun
          .query("SELECT changes() AS c, last_insert_rowid() AS r")
          .get() as { c: bigint; r: bigint };
        db.lastError = "";
        return JSON.stringify({
          cols: statement.columnNames,
          rows: rows.map((r) => r.map(encodeCell)),
          changes: Number(counters.c),
          lastInsertRowid: Number(counters.r),
        });
      } catch (error) {
        db.lastError = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ error: db.lastError });
      }
    },
    lastError(handle: number): string {
      const db = live(handle);
      return db ? db.lastError : "database is closed";
    },
  };

  return {
    ns,
    log,
    dispose(): void {
      for (const db of dbs.values()) db.bun.close();
      dbs.clear();
      byName.clear();
      closedImages.clear();
    },
  };
}
