// tests/3ds-bundle-compile.test.ts — the 3DS program's compile of a guest
// bundle on a thread of its own (products/3ds/src/bundle_compile.c), built for
// the build machine against the QuickJS revision the 3DS program links
// (tools/build/toolchains/3ds.ts THREE_DS_QUICKJS_PIN). main.c runs it on a
// second thread on a package's first boot while the main thread pumps the
// link (docs/POCKET-LINK.md §4.6, §12.2); the harness runs it on a pthread.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureQuickJsSources } from "../tools/build/toolchains/3ds.ts";
import { quickJsVendorObjects } from "../tools/quickjs-vendor.ts";

const root = resolve(import.meta.dir, "..");
const build = join(root, `.pocket-build/validation/3ds-bundle-compile/${Date.now()}-${process.pid}`);
let harness = "";

beforeAll(() => {
  mkdirSync(build, { recursive: true });
  const cc = Bun.which("cc");
  expect(cc).not.toBeNull();
  const quickjs = ensureQuickJsSources();
  const objects = quickJsVendorObjects({
    cc: cc!,
    quickjs,
    units: ["quickjs", "cutils", "libregexp", "libunicode", "dtoa"],
    flags: ["-std=gnu11", "-O1", "-D_GNU_SOURCE", '-DCONFIG_VERSION="pocket3ds-test"', "-w"],
  });
  harness = join(build, "bundle-compile");
  const compile = Bun.spawnSync([
    cc!, "-std=gnu11", "-Wall", "-Wextra", "-Werror", "-O1",
    "-I", join(root, "products/3ds/src"), "-isystem", quickjs,
    join(root, "tests/fixtures/3ds-bundle-compile.c"), join(root, "products/3ds/src/bundle_compile.c"),
    ...objects, "-lm", "-lpthread", "-o", harness,
  ], { stdout: "pipe", stderr: "pipe" });
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
}, 300_000);

function run(mode: "compile" | "raw", source: string): Record<string, string> {
  const file = join(build, `source-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(file, source);
  const result = Bun.spawnSync([harness, mode, file], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const facts: Record<string, string> = {};
  for (const line of result.stdout.toString().trim().split("\n")) {
    const at = line.indexOf(" ");
    if (at < 0) facts[line] = "";
    else facts[line.slice(0, at)] = line.slice(at + 1);
  }
  return facts;
}

/** A bundle of a few hundred kilobytes with the constructs a Solid app's build carries. */
function bundle(functions: number): string {
  const parts = ["'use strict';", "const table = [];"];
  for (let i = 0; i < functions; i++) {
    parts.push(
      `class Row${i} { #seen = ${i}; constructor(x) { this.x = x; } get value() { return this.#seen + this.x; } static of(x) { return new Row${i}(x); } }`,
      `async function load${i}(n) { await null; return \`row \${n}: \${/a(b+)c/u.test("abbc") ? n * 2 : 0}\`; }`,
      `table.push((x = ${i}) => Row${i}.of(x).value + [1, 2, 3].map((v) => v * ${i % 7}).reduce((a, b) => a + b, 0) + Number(${i}n % 7n));`,
    );
  }
  parts.push("globalThis.result = table.reduce((sum, f, i) => sum + f(i), 0);");
  return parts.join("\n");
}
const expected = (functions: number) => {
  let sum = 0;
  for (let i = 0; i < functions; i++) sum += i + i + 6 * (i % 7) + (i % 7);
  return String(sum);
};

describe("a guest bundle compiled in a QuickJS runtime of its own", () => {
  test("gives the bytes the guest's own compile wrote to bundle.qbc, and they run in another runtime", () => {
    for (const functions of [1, 400, 1500]) {
      const facts = run("compile", bundle(functions));
      expect(facts.error).toBeUndefined();
      expect(Number(facts.bytes)).toBeGreaterThan(0);
      expect(facts.same).toBe("yes");
      expect(facts.result).toBe(expected(functions));
    }
  }, 120_000);
  test("a source that does not compile gives QuickJS's message and the line, and no bytecode", () => {
    const facts = run("compile", "const a = 1;\nconst b = ;\nconst c = 3;\n");
    expect(facts.error).toContain("SyntaxError");
    expect(facts.error).toContain("pocket:guest:2");
    expect(facts.bytes).toBeUndefined();
  });
  test("a section without its terminal NUL is left to the guest's own evaluate", () => {
    const facts = run("raw", "globalThis.result = 1;");
    expect(facts.unavailable).toBe("");
    expect(facts.bytes).toBeUndefined();
  });
  test("a bundle that nests deeper than the 3DS stack limit fails as the guest's compile does, without overflowing the thread", () => {
    const depth = 20_000;
    const facts = run("compile", `globalThis.result = ${"[".repeat(depth)}${"]".repeat(depth)};`);
    expect(facts.error).toMatch(/stack overflow|too many/i);
  });
});
