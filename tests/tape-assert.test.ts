// tests/tape-assert.test.ts — fail-closed schema validation for tape golden
// `--assert` files. Review B2r found that a missing/null `hashes` field turned
// the assertion off and an array-like object {0: h0, length: 180} checked only
// frame 0 yet still printed "180 frames match"; every malformed, partial, or
// mismatched golden must name the defect and reject before booting instead.
//
// The end-to-end 180/180 replay is the "tape golden" stage in tools/test.ts
// (it needs hosts/web/pocketjs.wasm); this file covers the validator itself
// and the CLI's fail-closed path, which rejects before any build.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAssertArg, parseAssertHashes } from "../tools/tape.ts";

const APP = "hero-main";
const FRAMES = 180;
const golden = JSON.parse(
  readFileSync(new URL("./tapes/hero-main.hashes.json", import.meta.url), "utf8"),
) as { app: string; frames: number; hashes: string[] };

function validDoc(): { app: string; frames: number; hashes: unknown[] } {
  return { app: APP, frames: FRAMES, hashes: [...golden.hashes] };
}

function reject(doc: unknown, fragment: RegExp): void {
  expect(() => parseAssertHashes(doc, "golden.json", APP, FRAMES)).toThrow(fragment);
}

describe("tape --assert schema (pure validator)", () => {
  test("the committed golden is valid and returns its 180 hashes in order", () => {
    const hashes = parseAssertHashes(golden, "tests/tapes/hero-main.hashes.json", APP, FRAMES);
    expect(hashes).toHaveLength(180);
    expect(hashes).toEqual(golden.hashes);
    expect(hashes[0]).toBe("78bb9ae7");
    expect(hashes[179]).toBe("71fa48cd");
  });

  test("a small well-formed document validates", () => {
    const doc = { app: "demo", frames: 2, hashes: ["01234567", "89abcdef"] };
    expect(parseAssertHashes(doc, "small.json", "demo", 2)).toEqual(["01234567", "89abcdef"]);
  });

  test("root must be an object", () => {
    reject(null, /root must be an object/);
    reject([], /root must be an object/);
    reject("golden", /root must be an object/);
    reject(180, /root must be an object/);
    reject(true, /root must be an object/);
  });

  test("app must be a string matching the replayed app", () => {
    let doc = validDoc();
    delete (doc as Partial<typeof doc>).app;
    reject(doc, /"app"/);
    reject({ ...validDoc(), app: 42 }, /"app"/);
    doc = { ...validDoc(), app: "wrong-app" };
    reject(doc, /wrong-app/);
  });

  test("frames must be a non-negative integer agreeing with the array", () => {
    let doc = validDoc();
    delete (doc as Partial<typeof doc>).frames;
    reject(doc, /"frames"/);
    reject({ ...validDoc(), frames: "180" }, /"frames"/);
    reject({ ...validDoc(), frames: 17.5 }, /"frames"/);
    reject({ ...validDoc(), frames: -1 }, /"frames"/);
    reject({ ...validDoc(), frames: 17 }, /"frames" is 17/);
  });

  test("hashes must be present (missing or null must not disable the assert)", () => {
    const doc = validDoc() as Partial<ReturnType<typeof validDoc>>;
    delete doc.hashes;
    reject(doc, /missing field "hashes"/);
    reject({ app: APP, frames: FRAMES, hashes: null }, /"hashes" must be an array/);
    reject({ app: APP, frames: FRAMES, hashes: undefined }, /"hashes" must be an array/);
  });

  test("hashes must be a real array (objects cannot masquerade as one)", () => {
    const fake = { "0": golden.hashes[0], length: 180 };
    reject({ app: APP, frames: FRAMES, hashes: fake }, /"hashes" must be an array/);
    reject({ app: APP, frames: FRAMES, hashes: golden.hashes.join("") }, /"hashes" must be an array/);
    reject({ app: APP, frames: FRAMES, hashes: 180 }, /"hashes" must be an array/);
  });

  test("length must match the frames the tape replays", () => {
    reject({ ...validDoc(), frames: 179, hashes: golden.hashes.slice(0, 179) }, /hashes length 179/);
    reject({ ...validDoc(), frames: 181, hashes: [...golden.hashes, "deadbeef"] }, /hashes length 181/);
    reject({ app: APP, frames: 0, hashes: [] }, /hashes length 0/);
  });

  test("hashes must be dense: holes are rejected at their index", () => {
    const sparse: unknown[] = new Array(3);
    sparse[0] = "01234567";
    sparse[2] = "89abcdef";
    expect(() => parseAssertHashes({ app: "demo", frames: 3, hashes: sparse }, "golden.json", "demo", 3)).toThrow(
      /sparse.*index 1/,
    );
  });

  test("every entry must be an 8-char lowercase hex string", () => {
    const variants: { h: unknown; at: number }[] = [
      { h: 12345678, at: 0 },
      { h: null, at: 1 },
      { h: { hex: "78bb9ae7" }, at: 2 },
      { h: "78BB9AE7", at: 3 }, // uppercase not produced by the hasher
      { h: "78bb9ae", at: 4 }, // 7 chars
      { h: "78bb9ae77", at: 5 }, // 9 chars
      { h: "zzzzzzzz", at: 6 }, // non-hex
      { h: "", at: 7 },
    ];
    for (const { h, at } of variants) {
      const hashes = golden.hashes.slice();
      hashes[at] = h as string;
      reject({ app: APP, frames: FRAMES, hashes }, new RegExp(`hashes\\[${at}\\]`));
    }
  });

  test("root must be a plain object — class instances cannot masquerade as a golden", () => {
    class FakeGolden {
      app = APP;
      frames = FRAMES;
      hashes = [...golden.hashes];
    }
    reject(new FakeGolden(), /non-standard prototype/);
    // A null-prototype object is still plain data.
    const nullProto = Object.assign(Object.create(null), {
      app: APP,
      frames: FRAMES,
      hashes: [...golden.hashes],
    });
    expect(parseAssertHashes(nullProto, "nullproto.json", APP, FRAMES)).toHaveLength(180);
  });

  test("frame count argument disagreements are rejected too", () => {
    // The tape expands to 180 frames; a golden claiming 181 while the array is
    // internally consistent must not match.
    expect(() => parseAssertHashes({ ...validDoc(), frames: 180 }, "g.json", APP, 181)).toThrow(
      /hashes length 180 .* 181 frames/,
    );
  });
});

// ---------------------------------------------------------------------------
// CLI fail-closed behaviour — every malformed golden exits non-zero BEFORE the
// bundle boots (no "tape: rebuilding" line) and never prints a match.
// ---------------------------------------------------------------------------

const root = new URL("..", import.meta.url).pathname;
const tmpDirs: string[] = [];

function tmp(): string {
  const dir = `/tmp/pocketjs-tape-assert-${process.pid}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runTapeCli(assertPath: string) {
  return Bun.spawnSync(
    [
      process.execPath,
      "tools/tape.ts",
      "replay",
      "hero-main",
      "tests/tapes/hero-main.tape.json",
      "--assert",
      assertPath,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
}

describe("tape replay --assert CLI fails closed", () => {
  const cases: { name: string; body: (dir: string) => string; error: RegExp }[] = [
    {
      name: "hashes null — assertion must not switch off",
      body: (d) => {
        const p = join(d, "null.json");
        writeFileSync(p, JSON.stringify({ app: APP, frames: FRAMES, hashes: null }));
        return p;
      },
      error: /"hashes" must be an array/,
    },
    {
      name: "hashes missing — assertion must not switch off",
      body: (d) => {
        const p = join(d, "missing.json");
        writeFileSync(p, JSON.stringify({ app: APP, frames: FRAMES }));
        return p;
      },
      error: /missing field "hashes"/,
    },
    {
      name: "array-like object must not partially assert frame 0",
      body: (d) => {
        const p = join(d, "objectfake.json");
        writeFileSync(p, JSON.stringify({ app: APP, frames: FRAMES, hashes: { "0": golden.hashes[0], length: 180 } }));
        return p;
      },
      error: /"hashes" must be an array/,
    },
    {
      name: "wrong app metadata is rejected",
      body: (d) => {
        const p = join(d, "metadata.json");
        writeFileSync(p, JSON.stringify({ app: "wrong-app", frames: 17, hashes: golden.hashes }));
        return p;
      },
      error: /wrong-app/,
    },
    {
      name: "179-entry partial array is rejected before replay",
      body: (d) => {
        const p = join(d, "short.json");
        writeFileSync(p, JSON.stringify({ app: APP, frames: 179, hashes: golden.hashes.slice(0, 179) }));
        return p;
      },
      error: /hashes length 179/,
    },
    {
      name: "illegal element is rejected with its index",
      body: (d) => {
        const p = join(d, "bad-entry.json");
        const hashes = golden.hashes.slice();
        hashes[5] = "DEADBEEF";
        writeFileSync(p, JSON.stringify({ app: APP, frames: FRAMES, hashes }));
        return p;
      },
      error: /hashes\[5\]/,
    },
    {
      name: "syntactically invalid JSON is reported explicitly",
      body: (d) => {
        const p = join(d, "broken.json");
        writeFileSync(p, '{ "hashes": [ ');
        return p;
      },
      error: /invalid JSON/,
    },
    {
      name: "missing assert file is reported explicitly",
      body: (d) => join(d, "does-not-exist.json"),
      error: /cannot read --assert/,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const assertPath = c.body(tmp());
      const result = runTapeCli(assertPath);
      const out = result.stdout.toString();
      const err = result.stderr.toString();
      expect(result.exitCode, err + out).not.toBe(0);
      expect(err).toMatch(c.error);
      expect(out).not.toMatch(/frames match/);
      // Rejection happens before boot: the app bundle is never built.
      expect(out + err).not.toMatch(/rebuilding|missing — running/);
    }, 10_000);
  }
});

// ---------------------------------------------------------------------------
// --assert argument parsing (Review B2rr): "the flag is absent" and "the flag
// is present but its value is missing/empty/another flag" are different. The
// first is a plain replay; the second must fail closed before any work.
// ---------------------------------------------------------------------------

describe("tape --assert argument parsing (pure)", () => {
  const parse = (extra: string[]) =>
    parseAssertArg(["bun", "tools/tape.ts", "replay", "hero-main", "tests/tapes/hero-main.tape.json", ...extra]);

  test("absent: no --assert anywhere means a plain, unchecked replay", () => {
    expect(parse([])).toEqual({ kind: "absent" });
    expect(parse(["--hashes", "out.json", "--png", "0"])).toEqual({ kind: "absent" });
  });

  test("value: --assert PATH resolves to the path", () => {
    expect(parse(["--assert", "tests/tapes/hero-main.hashes.json"])).toEqual({
      kind: "value",
      value: "tests/tapes/hero-main.hashes.json",
    });
  });

  test("value: attached --assert=PATH resolves to the path", () => {
    expect(parse(["--assert=tests/tapes/hero-main.hashes.json"])).toEqual({
      kind: "value",
      value: "tests/tapes/hero-main.hashes.json",
    });
  });

  test("missing: --assert as the last token has no value", () => {
    const r = parse(["--assert"]);
    expect(r.kind).toBe("missing");
    expect(r.kind === "missing" ? r.reason : "").toMatch(/last argument/);
  });

  test("missing: --assert followed by an empty string is an error, not 'absent'", () => {
    const r = parse(["--assert", ""]);
    expect(r.kind).toBe("missing");
    expect(r.kind === "missing" ? r.reason : "").toMatch(/empty string/);
  });

  test("missing: --assert= (attached empty) is an error", () => {
    const r = parse(["--assert="]);
    expect(r.kind).toBe("missing");
    expect(r.kind === "missing" ? r.reason : "").toMatch(/empty value/);
  });

  test("missing: --assert followed by another flag names that flag", () => {
    const r = parse(["--assert", "--png", "0"]);
    expect(r.kind).toBe("missing");
    expect(r.kind === "missing" ? r.reason : "").toMatch(/next argument is the flag "--png"/);
  });

  test("a lone dash stays a literal path value", () => {
    expect(parse(["--assert", "-"])).toEqual({ kind: "value", value: "-" });
  });
});

// End-to-end boundary: every valueless form exits non-zero before the tape is
// read or the bundle is rebuilt, a real golden still asserts, and a replay
// without --assert keeps its unchecked behaviour.
function runTapeArgs(extra: string[]) {
  return Bun.spawnSync(
    [process.execPath, "tools/tape.ts", "replay", "hero-main", "tests/tapes/hero-main.tape.json", ...extra],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
}

describe("tape replay --assert CLI value boundary", () => {
  const missingCases: { name: string; args: string[]; error: RegExp }[] = [
    { name: "bare --assert at the end", args: ["--assert"], error: /last argument/ },
    { name: "empty string value", args: ["--assert", ""], error: /empty string/ },
    { name: "attached empty --assert=", args: ["--assert="], error: /empty value/ },
    {
      name: "next argument is a flag",
      args: ["--assert", "--png", "0"],
      error: /next argument is the flag "--png"/,
    },
  ];

  for (const c of missingCases) {
    test(c.name, () => {
      const result = runTapeArgs(c.args);
      const out = result.stdout.toString();
      const err = result.stderr.toString();
      expect(result.exitCode, err + out).not.toBe(0);
      expect(err).toMatch(/tape: --assert requires a golden hashes file path/);
      expect(err).toMatch(c.error);
      // The error is a parameter error, not a failed file open.
      expect(err).not.toMatch(/cannot read --assert/);
      expect(out + err).not.toMatch(/frames match|replayed \d+ frames/);
      // Fails before reading the tape matters and, crucially, before building.
      expect(out + err).not.toMatch(/rebuilding|missing — running/);
    }, 10_000);
  }

  test("valid separated --assert PATH still strictly asserts 180/180", () => {
    const result = runTapeArgs(["--assert", "tests/tapes/hero-main.hashes.json"]);
    const out = result.stdout.toString();
    const err = result.stderr.toString();
    expect(result.exitCode, err + out).toBe(0);
    expect(out).toMatch(/tape: OK — 180 frames match tests\/tapes\/hero-main\.hashes\.json/);
  }, 30_000);

  test("valid attached --assert=PATH is accepted", () => {
    const result = runTapeArgs(["--assert=tests/tapes/hero-main.hashes.json"]);
    const out = result.stdout.toString();
    const err = result.stderr.toString();
    expect(result.exitCode, err + out).toBe(0);
    expect(out).toMatch(/tape: OK — 180 frames match/);
  }, 30_000);

  test("no --assert at all keeps the plain unchecked replay (exit 0)", () => {
    const result = runTapeArgs([]);
    const out = result.stdout.toString();
    const err = result.stderr.toString();
    expect(result.exitCode, err + out).toBe(0);
    expect(out).toMatch(/tape: replayed 180 frames/);
    expect(out).not.toMatch(/frames match/);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Review B2rrr: the whole argv is scanned, not just the first --assert. A
// valueless occurrence (bare, empty, attached-empty, flag-like) fails closed
// wherever it appears, and two non-empty occurrences are a duplicate error —
// safety must not depend on which occurrence comes first.
// ---------------------------------------------------------------------------

describe("tape --assert duplicate and later-occurrence parsing (pure)", () => {
  const PREFIX = ["bun", "tools/tape.ts", "replay", "hero-main", "tests/tapes/hero-main.tape.json"];
  const parse = (extra: string[]) => parseAssertArg([...PREFIX, ...extra]);
  const reasonOf = (r: ReturnType<typeof parseAssertArg>): string =>
    r.kind === "missing" || r.kind === "duplicate" ? r.reason : "";
  const good = "tests/tapes/hero-main.hashes.json";
  const other = "/tmp/second-golden.json";

  const missingCases: { name: string; args: string[]; error: RegExp }[] = [
    { name: "valid separated, then bare trailing", args: ["--assert", good, "--assert"], error: /last argument/ },
    {
      name: "valid separated, then empty string",
      args: ["--assert", good, "--assert", ""],
      error: /empty string/,
    },
    { name: "valid separated, then attached empty", args: ["--assert", good, "--assert="], error: /empty value/ },
    { name: "valid attached, then attached empty", args: [`--assert=${good}`, "--assert="], error: /empty value/ },
    {
      name: "valid separated, then flag-like value",
      args: ["--assert", good, "--assert", "--png", "0"],
      error: /next argument is the flag "--png"/,
    },
    {
      name: "valid attached, then flag-like value",
      args: [`--assert=${good}`, "--assert", "--png", "0"],
      error: /next argument is the flag "--png"/,
    },
    { name: "empty first, valid later (reverse order)", args: ["--assert", "", "--assert", good], error: /empty string/ },
    {
      name: "bare-looking first (next token is --assert), valid later",
      args: ["--assert", "--assert", good],
      error: /next argument is the flag "--assert"/,
    },
    {
      name: "two malformed occurrences report the first one in argv order",
      args: ["--assert", "", "--assert"],
      error: /empty string/,
    },
  ];

  for (const c of missingCases) {
    test(`missing: ${c.name}`, () => {
      const r = parse(c.args);
      expect(r.kind).toBe("missing");
      expect(reasonOf(r)).toMatch(c.error);
    });
  }

  const duplicateCases: { name: string; args: string[] }[] = [
    { name: "two separated paths", args: ["--assert", good, "--assert", other] },
    { name: "two attached paths", args: [`--assert=${good}`, `--assert=${other}`] },
    { name: "attached then separated", args: [`--assert=${good}`, "--assert", other] },
    { name: "separated then attached", args: ["--assert", good, `--assert=${other}`] },
    { name: "the same path twice", args: ["--assert", good, "--assert", good] },
    {
      name: "three occurrences",
      args: ["--assert", good, "--assert", other, `--assert=${good}`],
    },
    {
      name: "unrelated flags interleaved between the occurrences",
      args: ["--png", "0", "--assert", good, "--outdir", "dist/x", "--assert", other],
    },
  ];

  for (const c of duplicateCases) {
    const count = c.args.filter((a) => a === "--assert" || a.startsWith("--assert=")).length;
    test(`duplicate: ${c.name}`, () => {
      const r = parse(c.args);
      expect(r.kind).toBe("duplicate");
      expect(reasonOf(r)).toMatch(/--assert may be given at most once/);
      expect(reasonOf(r)).toMatch(new RegExp(`appeared ${count} times`));
    });
  }

  test("duplicate reason names every path so composed command lines are debuggable", () => {
    const r = parse(["--assert", good, "--assert", other]);
    expect(r.kind).toBe("duplicate");
    expect(reasonOf(r)).toContain(good);
    expect(reasonOf(r)).toContain(other);
  });

  test("scanning is position-independent: --assert among positional arguments still counts twice", () => {
    const r = parseAssertArg([
      "bun",
      "tools/tape.ts",
      "replay",
      "--assert",
      good,
      "hero-main",
      "tests/tapes/hero-main.tape.json",
      "--assert",
      other,
    ]);
    expect(r.kind).toBe("duplicate");
  });

  test("a single valid occurrence mixed with other flags stays a value", () => {
    expect(parse(["--png", "0", "--assert", good, "--outdir", "dist/x"])).toEqual({
      kind: "value",
      value: good,
    });
  });
});

describe("tape replay rejects duplicate and later valueless --assert (CLI)", () => {
  const good = "tests/tapes/hero-main.hashes.json";

  const cases: { name: string; args: (dir: string) => string[]; error: RegExp }[] = [
    { name: "valid then bare --assert", args: () => ["--assert", good, "--assert"], error: /last argument/ },
    {
      name: "valid then empty string",
      args: () => ["--assert", good, "--assert", ""],
      error: /empty string/,
    },
    {
      name: "valid attached then attached empty",
      args: () => [`--assert=${good}`, "--assert="],
      error: /empty value/,
    },
    {
      name: "valid then flag-like value",
      args: () => ["--assert", good, "--assert", "--png", "0"],
      error: /next argument is the flag "--png"/,
    },
    {
      name: "two non-empty paths (second one divergent) is rejected, not first-wins",
      args: (d) => {
        const p = join(d, "divergent.json");
        const hashes = golden.hashes.slice();
        hashes[40] = "deadbeef";
        writeFileSync(p, JSON.stringify({ app: APP, frames: FRAMES, hashes }));
        return ["--assert", good, "--assert", p];
      },
      error: /--assert may be given at most once/,
    },
    {
      name: "two attached non-empty paths",
      args: (d) => {
        const p = join(d, "second.json");
        writeFileSync(p, JSON.stringify({ app: APP, frames: FRAMES, hashes: [...golden.hashes] }));
        return [`--assert=${good}`, `--assert=${p}`];
      },
      error: /--assert may be given at most once/,
    },
    {
      name: "same path repeated",
      args: () => ["--assert", good, "--assert", good],
      error: /--assert may be given at most once/,
    },
    {
      name: "three occurrences",
      args: () => ["--assert", good, "--assert", good, `--assert=${good}`],
      error: /appeared 3 times/,
    },
    {
      name: "empty first with a valid second still rejects",
      args: () => ["--assert", "", "--assert", good],
      error: /empty string/,
    },
    {
      name: "flag-like first with a valid second still rejects",
      args: () => ["--assert", "--assert", good],
      error: /next argument is the flag "--assert"/,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const result = runTapeArgs(c.args(tmp()));
      const out = result.stdout.toString();
      const err = result.stderr.toString();
      expect(result.exitCode, err + out).not.toBe(0);
      expect(err).toMatch(/tape: --assert/);
      expect(err).toMatch(c.error);
      // A parameter error, not a failed file open or a replay verdict.
      expect(err).not.toMatch(/cannot read --assert|FIRST DIVERGENT FRAME/);
      expect(out + err).not.toMatch(/frames match|replayed \d+ frames/);
      // Rejected before reading the tape and, crucially, before building.
      expect(out + err).not.toMatch(/rebuilding|missing — running/);
    }, 10_000);
  }
});
