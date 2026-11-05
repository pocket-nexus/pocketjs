// tests/fs-3ds.test.ts — the native hosts' fs module (engine/host-services/fs.c),
// compiled natively under ASan/UBSan by tests/fixtures/3ds-fs.c over a
// temporary directory:
//
// - every scenario runs against the sim's fs host (platforms/sim/fs.ts, the
//   contract's reference for the JS hosts) and the C module, and each op's
//   result and lastError must agree;
// - FAT's rename path (no rename onto an existing name) and the recovery of
//   a replacement a power loss interrupted;
// - the quota a package plan asks for.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPLET_STORE_MAX_BYTES } from "../contracts/spec/applet.ts";
import { FS_MAX_IO_BYTES, FS_WRITE_APPEND, FS_WRITE_TRUNCATE } from "../contracts/spec/fs.ts";
import { createSimFsHost } from "../platforms/sim/fs.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "engine/host-services");
let scratch = "";
let binary = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "pocket-3ds-fs-"));
  binary = join(scratch, "harness");
  const compile = Bun.spawnSync([
    "cc", "-std=gnu11", "-O1", "-Wall", "-Wextra", "-DFS_TEST_HOOKS", "-fsanitize=address,undefined",
    join(ROOT, "tests/fixtures/3ds-fs.c"), join(SRC, "fs.c"), join(SRC, "jscan.c"), "-o", binary,
  ]);
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

type Op =
  | ["read", string, number, number]
  | ["write", string, string, number]
  | ["remove", string, number]
  | ["list", string, number]
  | ["stat", string]
  | ["mkdir", string]
  | ["rename", string, string]
  | ["usage"];

const hex = (text: string) => (text === "" ? "-" : Buffer.from(text, "utf8").toString("hex"));
const text = (value: string) => JSON.stringify(value);
const bytes = (values: number[]) => JSON.stringify({ $b: Buffer.from(values).toString("base64") });

let runs = 0;
/** Run raw harness command lines in a fresh tree; each answer is [result, lastError]. */
function harness(lines: string[], quota = 0, keep?: string): [string, string][] {
  const dir = keep ?? join(scratch, `tree-${runs++}`);
  const commands = [`bind ${hex(join(dir, "data"))} ${hex(join(dir, "tmp"))} ${quota}`, ...lines];
  const result = Bun.spawnSync([binary], { stdin: Buffer.from(`${commands.join("\n")}\n`) });
  if (result.exitCode !== 0) throw new Error(`harness exited ${result.exitCode}: ${result.stderr}`);
  const out = result.stdout.toString().split("\n").filter((line, i, all) => i < all.length - 1 || line !== "");
  expect(out[0]).toBe("1\t");
  return out.slice(1).map((line) => {
    const tab = line.indexOf("\t");
    return [line.slice(0, tab), line.slice(tab + 1)];
  });
}

function command(op: Op): string {
  switch (op[0]) {
    case "read": return `read ${hex(op[1])} ${op[2]} ${op[3]}`;
    case "write": return `write ${hex(op[1])} ${hex(op[2])} ${op[3]}`;
    case "remove": return `remove ${hex(op[1])} ${op[2]}`;
    case "list": return `list ${hex(op[1])} ${op[2]}`;
    case "stat": return `stat ${hex(op[1])}`;
    case "mkdir": return `mkdir ${hex(op[1])}`;
    case "rename": return `rename ${hex(op[1])} ${hex(op[2])}`;
    case "usage": return "usage";
  }
}

/** Every op's [result, lastError] on the sim host and on fs.c, side by side. */
function both(ops: Op[], quota = 0) {
  const sim = createSimFsHost({ quotaBytes: quota });
  const ns = sim.ns as Record<string, (...args: unknown[]) => unknown>;
  const expected = ops.map((op) => {
    const value = ns[op[0]]!(...op.slice(1));
    return [String(value), String(ns.lastError!())] as [string, string];
  });
  const actual = harness(ops.map(command), quota);
  const parse = (value: string) => (value.startsWith("{") ? JSON.parse(value) : value);
  return { expected: expected.map(([r, e]) => [parse(r), e]), actual: actual.map(([r, e]) => [parse(r), e]) };
}

function agree(ops: Op[], quota = 0) {
  const { expected, actual } = both(ops, quota);
  for (let i = 0; i < ops.length; i += 1) {
    expect({ op: ops[i], result: actual[i] }).toEqual({ op: ops[i], result: expected[i] });
  }
}

describe("fs.c agrees with the sim host", () => {
  test("write, append, read at offsets, stat, list", () => {
    agree([
      ["write", "a.txt", text("hello"), FS_WRITE_TRUNCATE],
      ["read", "a.txt", 0, 100],
      ["write", "a.txt", text(" world"), FS_WRITE_APPEND],
      ["read", "a.txt", 3, 4],
      ["read", "a.txt", 100, 10],
      ["stat", "a.txt"],
      ["stat", ""],
      ["write", "d/e/f.bin", bytes([0, 1, 2, 255]), FS_WRITE_TRUNCATE],
      ["read", "d/e/f.bin", 0, 4],
      ["list", "", 0],
      ["list", "d", 0],
      ["list", "d/e", 0],
      ["stat", "d"],
      ["write", "a.txt", text("x"), FS_WRITE_TRUNCATE],
      ["read", "a.txt", 0, 10],
      ["write", "e.txt", text(""), FS_WRITE_TRUNCATE],
      ["read", "e.txt", 0, 1],
      ["usage"],
    ]);
  });

  test("the path grammar", () => {
    const long = "x".repeat(65);
    const deep = Array.from({ length: 9 }, () => "d").join("/");
    const wide = Array.from({ length: 6 }, () => "y".repeat(26)).join("/");
    const paths = ["/a", "a/", "a//b", ".", "..", "a/../b", "x\u0001y", "x\u007fy", long, deep, wide, "照片/一.txt", "😀.json", ".hidden"];
    agree(paths.flatMap((path): Op[] => [["write", path, text("v"), FS_WRITE_TRUNCATE], ["stat", path]]));
    agree([["write", "", text("v"), FS_WRITE_TRUNCATE], ["mkdir", ""], ["remove", "", 1], ["read", "", 0, 1]]);
  });

  test("ranges and payloads", () => {
    agree([
      ["write", "a", text("abc"), FS_WRITE_TRUNCATE],
      ["read", "a", 0, 0],
      ["read", "a", 0, FS_MAX_IO_BYTES + 1],
      ["read", "a", -1, 1],
      ["read", "a", 0, FS_MAX_IO_BYTES],
      ["write", "b", JSON.stringify({ other: "x" }), FS_WRITE_TRUNCATE],
      ["write", "b", text("a\u0000b\"c\\dé中\u{1f600}"), FS_WRITE_TRUNCATE],
      ["read", "b", 0, 64],
      ["write", "b", text("x"), 7],
      ["write", "big", bytes(new Array(FS_MAX_IO_BYTES + 1).fill(7)), FS_WRITE_TRUNCATE],
      ["write", "full", bytes(new Array(FS_MAX_IO_BYTES).fill(9)), FS_WRITE_TRUNCATE],
      ["stat", "full"],
      ["read", "missing", 0, 1],
      ["mkdir", "dir"],
      ["read", "dir", 0, 1],
      ["write", "dir", text("x"), FS_WRITE_TRUNCATE],
    ]);
  });

  test("directories, removal and rename", () => {
    agree([
      ["mkdir", "m/n/o"],
      ["mkdir", "m/n"],
      ["write", "m/n/o/f", text("1"), FS_WRITE_TRUNCATE],
      ["write", "file", text("2"), FS_WRITE_TRUNCATE],
      ["mkdir", "file/x"],
      ["mkdir", "file"],
      ["write", "file/x/y", text("3"), FS_WRITE_TRUNCATE],
      ["remove", "m", 0],
      ["remove", "missing", 0],
      ["rename", "file", "file"],
      ["write", "other", text("4"), FS_WRITE_TRUNCATE],
      ["rename", "other", "file"],
      ["read", "file", 0, 8],
      ["rename", "file", "nowhere/x"],
      ["rename", "file", "m"],
      ["rename", "m", "m/n/inside"],
      ["rename", "m", "file"],
      ["rename", "missing", "z"],
      ["rename", "m", "moved"],
      ["list", "moved/n/o", 0],
      ["list", "file", 0],
      ["list", "missing", 0],
      ["remove", "moved", 1],
      ["list", "", 0],
      ["remove", "file", 0],
      ["usage"],
    ]);
  });

  test("list sorts by code point and pages at FS_MAX_DIR_ENTRIES", () => {
    const names = ["b", "a", "Z", "é", "中", "😀", "aa", "ｚ"];
    agree([...names.map((name): Op => ["write", `s/${name}`, text(name), FS_WRITE_TRUNCATE]), ["list", "s", 0], ["list", "s", 3], ["list", "s", 99]]);
    const many: Op[] = Array.from({ length: 300 }, (_, i) => ["write", `p/${String(i).padStart(3, "0")}`, text(""), FS_WRITE_TRUNCATE]);
    agree([...many, ["list", "p", 0], ["list", "p", 256], ["list", "p", -5]]);
  });

  test("the quota covers writes and appends", () => {
    agree([
      ["write", "a", text("12345678"), FS_WRITE_TRUNCATE],
      ["write", "a", text("12345"), FS_WRITE_APPEND],
      ["write", "a", text("1234567890"), FS_WRITE_TRUNCATE],
      ["write", "b", text("1"), FS_WRITE_TRUNCATE],
      ["remove", "a", 0],
      ["write", "b", text("123456789"), FS_WRITE_APPEND],
      ["usage"],
    ], 10);
  });
});

describe("FAT and power loss", () => {
  test("a lone surrogate, data that is not JSON and bad base64 are malformed payloads", () => {
    const answers = harness([
      command(["write", "s", '"\\ud800"', FS_WRITE_TRUNCATE]),
      command(["write", "s", "nope", FS_WRITE_TRUNCATE]),
      // Node's base64 decoder skips what is not base64; fs.c refuses it.
      command(["write", "s", JSON.stringify({ $b: "!!" }), FS_WRITE_TRUNCATE]),
    ]);
    for (const [result, error] of answers) {
      expect(result).toBe("1");
      expect(error).toContain("malformed payload");
    }
  });

  test("a truncating write over an existing file takes the remove-then-rename path and leaves no staging", () => {
    const dir = join(scratch, "fat");
    const answers = harness([
      "hooks 1 0",
      command(["write", "home-layout.json", text("old"), FS_WRITE_TRUNCATE]),
      command(["write", "home-layout.json", text("new"), FS_WRITE_TRUNCATE]),
      command(["read", "home-layout.json", 0, 16]),
    ], 0, dir);
    expect(answers[1]![0]).toBe("0");
    expect(answers[2]![0]).toBe("0");
    expect(JSON.parse(answers[3]![0]).data.$b).toBe(Buffer.from("new").toString("base64"));
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });

  test("a replacement cut after the old file is removed finishes at the next bind", () => {
    const dir = join(scratch, "crash");
    const first = harness([
      "hooks 1 0",
      command(["write", "keep.json", text("old"), FS_WRITE_TRUNCATE]),
      "hooks 1 1",
      command(["write", "keep.json", text("new"), FS_WRITE_TRUNCATE]),
    ], 0, dir);
    expect(first[3]![0]).toBe("1");
    expect(existsSync(join(dir, "data/keep.json"))).toBe(false);
    const second = harness([command(["read", "keep.json", 0, 16])], 0, dir);
    expect(JSON.parse(second[0]![0]).data.$b).toBe(Buffer.from("new").toString("base64"));
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });

  test("the quota is the plan's applet store, else 4 MiB", () => {
    const quota = (plan: string) => harness([`quota ${hex(plan)}`])[0]![0];
    expect(quota(JSON.stringify({ app: {}, applet: { version: 1, store: { maxBytes: 65536 } } }))).toBe("65536");
    expect(quota(JSON.stringify({ app: {}, applet: { version: 1 } }))).toBe(String(APPLET_STORE_MAX_BYTES));
    expect(quota(JSON.stringify({ app: {} }))).toBe(String(APPLET_STORE_MAX_BYTES));
  });
});
