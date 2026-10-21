import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function packedFiles(cwd: string): string[] {
  const result = Bun.spawnSync({
    cmd: ["npm", "pack", "--dry-run", "--json"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  // npm <= 11 reports an array of packs; npm >= 12 keys packs by package name.
  const parsed = JSON.parse(result.stdout.toString()) as unknown;
  const report = (
    Array.isArray(parsed) ? parsed[0] : Object.values(parsed as object)[0]
  ) as { files: Array<{ path: string }> } | undefined;
  expect(report?.files, result.stdout.toString().slice(0, 200)).toBeDefined();
  return report!.files.map((file) => file.path);
}

/** Every bare package specifier reachable from `entries` through relative
 *  imports, with the first file that imports it. */
function reachablePackages(entries: readonly string[]): Map<string, string> {
  const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };
  const seen = new Set<string>();
  const packages = new Map<string, string>();
  const pending = entries.map((entry) => join(root, entry));
  const resolveRelative = (from: string, specifier: string) => {
    const base = resolve(dirname(from), specifier);
    return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts")]
      .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  };
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file) || !/\.(?:ts|tsx|js|mjs)$/.test(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8").replace(/^#!.*\n/, "");
    for (const { path: specifier } of transpilers[file.endsWith(".tsx") ? "tsx" : "ts"].scanImports(source)) {
      if (specifier.startsWith(".")) {
        const next = resolveRelative(file, specifier);
        if (next) pending.push(next);
        continue;
      }
      if (/^(?:node:|bun(?::|$))/.test(specifier) || specifier.startsWith("@pocketjs/framework")) continue;
      const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
      if (!packages.has(name)) packages.set(name, file.slice(root.length));
    }
  }
  return packages;
}

function packArchive(cwd: string, destination: string): string {
  const result = Bun.spawnSync({
    cmd: ["npm", "pack", "--json", "--pack-destination", destination],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const parsed = JSON.parse(result.stdout.toString()) as unknown;
  const report = (
    Array.isArray(parsed) ? parsed[0] : Object.values(parsed as object)[0]
  ) as { filename: string } | undefined;
  expect(report?.filename).toBeDefined();
  return join(destination, report!.filename);
}

describe("published npm artifacts", () => {
  test("framework ships compiler, framework and generated contracts without native sources", () => {
    const files = packedFiles(root);
    expect(files).toEqual(expect.arrayContaining([
      "framework/src/index.ts", "framework/src/profile.ts", "profiles/psp.ts",
      "contracts/generated/pocket_runtime.h", "contracts/generated/pocket_drivers.h", "contracts/generated/pocket_spec.h",
      "tools/pocket.ts", "tools/release/fetch.ts", "tools/build/pack.ts", "microts/compiler/aot-model-build.ts",
      "programs/psp/runtime/pocket.runtime-config.ts",
    ]));
    expect(files.filter(file => /\.(rs|c|cpp|cc|m|mm)$/.test(file) || /(^|\/)Cargo\.(toml|lock)$/.test(file))).toEqual([]);
    expect(files.filter(file => /(^|\/)(target|\.pocket-build)\//.test(file) || file.includes(".fingerprint"))).toEqual([]);
    expect(files.filter(file => file.endsWith(".h") && !file.startsWith("contracts/generated/"))).toEqual([]);
  }, 60_000);
  test("manifest commands import only declared runtime dependencies", () => {
    // An application installs the framework with its `dependencies` alone;
    // a compiler import resolved from `devDependencies` or hoisting works in
    // this checkout and fails in the application.
    const dependencies = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies;
    const undeclared = [...reachablePackages(["tools/pocket.ts", "tools/build.ts"])]
      .filter(([name]) => !(name in dependencies))
      .map(([name, importer]) => `${name} (${importer})`);
    expect(undeclared).toEqual([]);
  });

  test("CLI tarball stays self-contained and minimal", () => {
    expect(packedFiles(`${root}tools/cli`)).toEqual([
      "README.md",
      "bin.mjs",
      "create.mjs",
      "framework.mjs",
      "package.json",
      "select.mjs",
    ]);
  });

  test("extracted framework resolves profiles and generic recipes without Cargo sources", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "pocketjs-npm-consumer-"));
    try {
      const archive = packArchive(root, scratch);
      const extract = Bun.spawnSync(["tar", "-xf", archive, "-C", scratch], { stdout: "pipe", stderr: "pipe" });
      expect(extract.success, extract.stderr.toString()).toBe(true);
      const directory = join(scratch, "package");
      symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
      writeFileSync(join(directory, "consumer.ts"), `
import { defineProfile, hashPocketProfile } from "@pocketjs/framework/profile";
import psp from "@pocketjs/framework/profiles/psp";
import { resolveRuntimeProgram } from "./tools/build/programs.ts";
import { sdkCommand } from "./tools/sdk.ts";
const external = defineProfile({ ...psp, id: "external-product-with-a-long-id" });
if (hashPocketProfile(external) === hashPocketProfile(psp)) throw Error("identity omitted id");
const selected = await resolveRuntimeProgram({ from: ${JSON.stringify(scratch)}, target: "psp", generic: true });
if (!selected.config.value.build.genericRuntime.repack) throw Error("missing repack adapter");
if (await sdkCommand(["export", "--cargo", "--out", ${JSON.stringify(join(scratch, "program"))}])) throw Error("template failed");
console.log("npm consumer passed");
`);
      const consumer = Bun.spawnSync([process.execPath, "consumer.ts"], { cwd: directory, stdout: "pipe", stderr: "pipe" });
      expect(consumer.success, consumer.stderr.toString()).toBe(true);
      expect(consumer.stdout.toString()).toContain("npm consumer passed");
      expect(existsSync(join(directory, "Cargo.toml"))).toBe(false);
      expect(readFileSync(join(scratch, "program/Cargo.toml"), "utf8")).toContain('version = "0.1.0", default-features = false');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 60_000);
});
