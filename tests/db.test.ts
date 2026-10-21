// Db module unit tests: the sim host against the pinned op contract, the
// bun:sqlite-shaped SDK over it, and Bun's own SQLite as the oracle for row
// results. Runs entirely in-process; no built bundle, no disk.

import { afterEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import {
  DB_MAX_DATABASES,
  DB_MAX_RESULT_ROWS,
  DB_MEMORY,
  DB_NAME_PATTERN,
} from "../contracts/spec/db.ts";
import { Database, dbHost } from "../framework/src/db-api.ts";
import { createSimDbHost, type SimDbHost } from "../platforms/sim/db.ts";

const g = globalThis as { db?: unknown };
let host: SimDbHost | null = null;

/** Mount a fresh sim host as globalThis.db, the way bootWorld's
 *  extraGlobals does for a scenario. */
function mount(): SimDbHost {
  host = createSimDbHost();
  g.db = host.ns;
  return host;
}

afterEach(() => {
  host?.dispose();
  host = null;
  g.db = undefined;
});

// --- the namespace contract (ops, straight through) -------------------------

describe("sim host ops", () => {
  test("open refuses bad names, path traversal, and over-limit opens", () => {
    const { ns } = mount();
    const open = ns.open as (name: string) => number;
    expect(open("../escape")).toBe(-1);
    expect(open("a/b")).toBe(-1);
    expect(open("")).toBe(-1);
    expect(open(".hidden")).toBe(-1);
    const handles = [];
    for (let i = 0; i < DB_MAX_DATABASES; i++) handles.push(open(`app-${i}`));
    for (const h of handles) expect(h).toBeGreaterThan(0);
    expect(open("one-too-many")).toBe(-1);
  });

  test("the same persistent name returns the same handle; :memory: never does", () => {
    const { ns } = mount();
    const open = ns.open as (name: string) => number;
    const a = open("app");
    expect(open("app")).toBe(a);
    expect(open(DB_MEMORY)).not.toBe(open(DB_MEMORY));
  });

  test("ATTACH is refused on both exec and query", () => {
    const { ns } = mount();
    const open = ns.open as (name: string) => number;
    const exec = ns.exec as (h: number, sql: string) => number;
    const query = ns.query as (h: number, sql: string, args: string) => string;
    const lastError = ns.lastError as (h: number) => string;
    const h = open(DB_MEMORY);
    expect(exec(h, "ATTACH DATABASE '/tmp/x' AS other")).toBe(1);
    expect(lastError(h)).toContain("ATTACH");
    const result = JSON.parse(query(h, "attach database ':memory:' as other", "[]"));
    expect(result.error).toContain("ATTACH");
    // Every spelling SQLite accepts, not just the DATABASE-keyword form:
    // bare string, and an expression filename (which on the reference core
    // reaches the authorizer as NULL and is caught by SQLITE_LIMIT_ATTACHED).
    expect(exec(h, "ATTACH ':memory:' AS o1")).toBe(1);
    expect(exec(h, "ATTACH hex('2f746d702f78') AS o2")).toBe(1);
  });

  test("a named parameter without the $/:/@ prefix fails like the reference core", () => {
    const { ns } = mount();
    const open = ns.open as (name: string) => number;
    const exec = ns.exec as (h: number, sql: string) => number;
    const query = ns.query as (h: number, sql: string, args: string) => string;
    const h = open(DB_MEMORY);
    exec(h, "CREATE TABLE t (a, b)");
    const result = JSON.parse(query(h, "INSERT INTO t VALUES ($a, $b)", '{"a":1,"$b":2}'));
    expect(result.error).toBe("unknown parameter: a");
  });

  test("ops on a closed handle fail with 'database is closed'", () => {
    const { ns } = mount();
    const open = ns.open as (name: string) => number;
    const close = ns.close as (h: number) => void;
    const query = ns.query as (h: number, sql: string, args: string) => string;
    const h = open(DB_MEMORY);
    close(h);
    expect(JSON.parse(query(h, "SELECT 1", "[]")).error).toBe("database is closed");
  });

  test("query result carries cols, rows, changes and lastInsertRowid", () => {
    const { ns } = mount();
    const open = ns.open as (name: string) => number;
    const exec = ns.exec as (h: number, sql: string) => number;
    const query = ns.query as (h: number, sql: string, args: string) => string;
    const h = open(DB_MEMORY);
    expect(exec(h, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")).toBe(0);
    const ins = JSON.parse(query(h, "INSERT INTO t (v) VALUES (?)", '["hello"]'));
    expect(ins.changes).toBe(1);
    expect(ins.lastInsertRowid).toBe(1);
    const sel = JSON.parse(query(h, "SELECT id, v FROM t", "[]"));
    expect(sel.cols).toEqual(["id", "v"]);
    expect(sel.rows).toEqual([[1, "hello"]]);
  });

  test("a result beyond DB_MAX_RESULT_ROWS fails loudly", () => {
    const { ns } = mount();
    const open = ns.open as (name: string) => number;
    const exec = ns.exec as (h: number, sql: string) => number;
    const query = ns.query as (h: number, sql: string, args: string) => string;
    const h = open(DB_MEMORY);
    exec(h, "CREATE TABLE n (v INTEGER)");
    exec(
      h,
      `WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq LIMIT ${DB_MAX_RESULT_ROWS + 1})
       INSERT INTO n SELECT x FROM seq`,
    );
    const over = JSON.parse(query(h, "SELECT v FROM n", "[]"));
    expect(over.error).toContain("DB_MAX_RESULT_ROWS");
    const capped = JSON.parse(query(h, `SELECT v FROM n LIMIT ${DB_MAX_RESULT_ROWS}`, "[]"));
    expect(capped.rows.length).toBe(DB_MAX_RESULT_ROWS);
  });

  test("an integer beyond 2^53-1 fails instead of losing precision", () => {
    const { ns } = mount();
    const open = ns.open as (name: string) => number;
    const query = ns.query as (h: number, sql: string, args: string) => string;
    const h = open(DB_MEMORY);
    const over = JSON.parse(query(h, "SELECT 9007199254740993", "[]"));
    expect(over.error).toContain("DB_MAX_SAFE_INTEGER");
    const ok = JSON.parse(query(h, "SELECT 9007199254740991", "[]"));
    expect(ok.rows).toEqual([[9007199254740991]]);
  });
});

// --- the SDK (the bun:sqlite shape over the mounted namespace) ---------------

describe("Database SDK", () => {
  test("throws where the module is unmounted", () => {
    expect(dbHost()).toBeNull();
    expect(() => new Database()).toThrow("data.sqlite");
  });

  test("CRUD round-trip with objects, values and named parameters", () => {
    mount();
    const db = new Database();
    db.exec(`CREATE TABLE positions (
      symbol TEXT PRIMARY KEY, qty REAL NOT NULL, cost_cents INTEGER NOT NULL
    )`);
    const insert = db.query("INSERT INTO positions VALUES ($s, $q, $c)");
    insert.run({ $s: "AAPL", $q: 10, $c: 190_00 });
    insert.run({ $s: "NVDA", $q: 2.5, $c: 121_50 });
    expect(db.query("SELECT count(*) AS n FROM positions").get()).toEqual({ n: 2 });
    expect(db.query("SELECT symbol FROM positions ORDER BY symbol").values()).toEqual([
      ["AAPL"],
      ["NVDA"],
    ]);
    const row = db.query("SELECT * FROM positions WHERE symbol = ?").get("NVDA");
    expect(row).toEqual({ symbol: "NVDA", qty: 2.5, cost_cents: 12150 });
    expect(db.query("SELECT * FROM positions WHERE symbol = ?").get("MSFT")).toBeNull();
    const del = db.run("DELETE FROM positions WHERE qty < ?", [5]);
    expect(del.changes).toBe(1);
  });

  test("statement caching: query() reuses, prepare() does not", () => {
    mount();
    const db = new Database();
    expect(db.query("SELECT 1")).toBe(db.query("SELECT 1"));
    expect(db.prepare("SELECT 1")).not.toBe(db.prepare("SELECT 1"));
  });

  test("columnNames populate on execution", () => {
    mount();
    const db = new Database();
    const q = db.query("SELECT 1 AS one, 2 AS two");
    expect(q.columnNames).toEqual([]);
    q.get();
    expect(q.columnNames).toEqual(["one", "two"]);
  });

  test("blobs round-trip as Uint8Array", () => {
    mount();
    const db = new Database();
    db.exec("CREATE TABLE b (data BLOB)");
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    db.run("INSERT INTO b VALUES (?)", [bytes]);
    const out = db.query("SELECT data FROM b").get();
    expect(out?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(out?.data as Uint8Array)).toEqual(Array.from(bytes));
  });

  test("transaction commits, rolls back on throw, and nests as savepoints", () => {
    mount();
    const db = new Database();
    db.exec("CREATE TABLE t (v INTEGER)");
    const insertBoth = db.transaction((a: number, b: number) => {
      db.run("INSERT INTO t VALUES (?)", [a]);
      db.run("INSERT INTO t VALUES (?)", [b]);
      return a + b;
    });
    expect(insertBoth(1, 2)).toBe(3);
    expect(db.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });

    const failing = db.transaction(() => {
      db.run("INSERT INTO t VALUES (99)");
      throw new Error("boom");
    });
    expect(() => failing()).toThrow("boom");
    expect(db.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });

    const outer = db.transaction(() => {
      db.run("INSERT INTO t VALUES (10)");
      const inner = db.transaction(() => {
        db.run("INSERT INTO t VALUES (11)");
        throw new Error("inner");
      });
      expect(() => inner()).toThrow("inner");
    });
    outer();
    const values = db.query("SELECT v FROM t ORDER BY v").values();
    expect(values).toEqual([[1], [2], [10]]);
  });

  test("a persistent name survives close/reopen inside one host", () => {
    mount();
    const first = new Database("ledger");
    first.exec("CREATE TABLE snap (v INTEGER)");
    first.run("INSERT INTO snap VALUES (42)");
    const second = new Database("ledger");
    expect(second.query("SELECT v FROM snap").get()).toEqual({ v: 42 });
    // Through an actual close(), too — the way Storage::Dir keeps the file
    // on a device host.
    second.close();
    const third = new Database("ledger");
    expect(third.query("SELECT v FROM snap").get()).toEqual({ v: 42 });
  });

  test("SQL errors surface as thrown Errors with SQLite's message", () => {
    mount();
    const db = new Database();
    expect(() => db.query("SELECT * FROM missing").all()).toThrow("missing");
    expect(() => db.exec("NOT SQL AT ALL")).toThrow();
  });
});

// --- oracle: the SDK over the sim host agrees with bun:sqlite directly -------

describe("bun:sqlite oracle", () => {
  test("identical statements produce identical rows", () => {
    mount();
    const ours = new Database();
    const oracle = new BunDatabase(":memory:");
    const ddl = `CREATE TABLE history (
      bucket TEXT PRIMARY KEY, total_cents INTEGER, day_pnl_cents INTEGER
    )`;
    const rows: [string, number, number][] = [
      ["2026-08-06T14:30", 1_532_042, 1824],
      ["2026-08-06T14:35", 1_531_010, 792],
      ["2026-08-06T14:40", 1_540_500, 10_282],
    ];
    ours.exec(ddl);
    oracle.exec(ddl);
    for (const r of rows) {
      ours.run("INSERT INTO history VALUES (?, ?, ?)", r);
      oracle.query("INSERT INTO history VALUES (?, ?, ?)").run(...r);
    }
    const sql = `SELECT bucket, total_cents FROM history
      WHERE day_pnl_cents > ? ORDER BY bucket DESC`;
    expect(ours.query(sql).values(1000)).toEqual(
      oracle.query(sql).values(1000) as never,
    );
  });
});

// --- spec sanity --------------------------------------------------------------

describe("spec constants", () => {
  test("DB_NAME_PATTERN accepts tokens and refuses paths", () => {
    // 57 chars is the ceiling: `<name>.sqlite` (+7 bytes) stays within the
    // fs module's 64-byte segment ceiling, keeping the database file
    // addressable by a co-mounted fs module.
    for (const good of ["app", "portfolio-history", "a.b_c-1", "A", "a".repeat(57)]) {
      expect(DB_NAME_PATTERN.test(good)).toBe(true);
    }
    for (const bad of ["", ".hidden", "-lead", "a/b", "a\\b", "..", "a".repeat(58)]) {
      expect(DB_NAME_PATTERN.test(bad)).toBe(false);
    }
  });
});
