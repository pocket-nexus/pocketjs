import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { compilerOnly, defineRuntimeConfig, type RuntimeBuild } from "../framework/src/runtime-config.ts";
import { buildRuntime } from "../tools/build/executor.ts";
import { nativeOption } from "../tools/build/programs/application.ts";
import { nokiaSourceInputs } from "../tools/build/programs/nokia-e7.ts";
import { resolveProfile, type ResolvedProfile } from "../tools/profile-resolver.ts";

const root = resolve(import.meta.dir, "..");
const base = join(root, ".pocket-build/validation/device-source-inputs/tests");
mkdirSync(base, { recursive: true });
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function scratch() { const path = mkdtempSync(join(base, "run-")); temporary.push(path); return path; }

async function fixture(directory: string, build: Omit<RuntimeBuild, "hosts">): Promise<ResolvedProfile> {
  const selected = await resolveProfile({ from: root, target: "symbian-e7-dev" });
  return { ...selected, config: { path: join(directory, "pocket.runtime-config.ts"), profiles: [selected.profile], profilePaths: [selected.path!], dependencies: [],
    value: defineRuntimeConfig({ profile: selected.path!,
      build: { hosts: [`${process.platform}-${process.arch}` as "darwin-arm64"], ...build } }) } };
}

test("Nokia input selection matches native option precedence and the invocation directory", () => {
  const dir = scratch();
  for (const file of ["catalog.tsv", "catalog.bin", "core.a", "navigation.json", "overridden.json"]) {
    writeFileSync(join(dir, file), file);
  }
  const args = ["--catalog-index", "catalog.tsv", "--catalog-blob=catalog.bin", "--core-library", "core.a",
    "--navigation", "overridden.json", "--navigation=navigation.json"];
  const inputs = nokiaSourceInputs({ args, invocationDirectory: dir });
  for (const option of ["--catalog-index", "--catalog-blob", "--core-library", "--navigation"]) {
    expect(inputs).toContain(resolve(dir, nativeOption(args, option)!));
  }
  expect(inputs).not.toContain(dir);
  expect(inputs).not.toContain(join(dir, "overridden.json"));
  expect(nokiaSourceInputs({ args: [], invocationDirectory: dir }).some(path => path.startsWith(dir))).toBe(false);
});

test("Nokia generated siblings remain build outputs", async () => {
  const dir = scratch(), input = join(dir, "catalog.bin"), generated = join(dir, "generated.sis");
  writeFileSync(input, "catalog original");
  const selected = await fixture(dir, { steps: compilerOnly(), sourceInputs: nokiaSourceInputs,
    run() { writeFileSync(generated, "native output"); } });
  const result = await buildRuntime(selected, join(dir, "out"), {
    args: [`--catalog-blob=${relative(process.cwd(), input)}`],
  });
  const receipt = JSON.parse(readFileSync(result.receipt!, "utf8"));
  expect(receipt.success).toBe(true);
  expect(receipt.dependencies[dir]).toBeUndefined();
  expect(receipt.dependencies[generated]).toBeUndefined();
});

test("missing Nokia file inputs fail before the native hook", async () => {
  const dir = scratch(); let called = false;
  const selected = await fixture(dir, { steps: compilerOnly(), sourceInputs: nokiaSourceInputs, run() { called = true; } });
  await expect(buildRuntime(selected, join(dir, "out"), { args: ["--navigation", join(dir, "missing.json")] })).rejects.toThrow();
  expect(called).toBe(false);
  expect(() => nokiaSourceInputs({ args: ["--core-library", dir], invocationDirectory: process.cwd() })).toThrow("regular file");
});
