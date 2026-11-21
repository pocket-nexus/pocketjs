import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { hashPocketProfile } from "../framework/src/profile.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { collectReleaseInputs, RUNTIME_MATRIX } from "../tools/release/inputs.ts";
import { SDK_MATRIX } from "../tools/release/matrix.ts";

const root = resolve(import.meta.dir, ".."), base = join(root, ".pocket-build/validation/release-inputs/tests");
mkdirSync(base, { recursive: true });
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const revision = "b".repeat(40);
function fixture() {
  const directory = mkdtempSync(join(base, "artifacts-")); scratch.push(directory);
  for (const { triple } of SDK_MATRIX) mkdirSync(join(directory, "sdks", "pocket-sdk-" + triple), { recursive: true });
  for (const { profile } of RUNTIME_MATRIX) {
    const build = join(directory, "runtimes", "pocket-runtime-" + profile);
    mkdirSync(join(build, "runtime"), { recursive: true });
    const files: Record<string, { bytes: number; sha256: string }> = {};
    for (const [name, value] of Object.entries({ "runtime.json": "{}", "program.bin": "runtime fixture" })) {
      writeFileSync(join(build, "runtime", name), value);
      files[name] = { bytes: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex") };
    }
    writeFileSync(join(build, "build-receipt.json"), JSON.stringify({ schema: "pocket-runtime-build/1", success: true,
      source: revision, target: profile, hostAbi: POCKET_BINDING_GENERATION, profileHash: hashPocketProfile(POCKET_PROFILES[profile]),
      input: null, deployed: false, artifact: "/different/build/host/runtime", files }));
  }
  return directory;
}
const collect = (directory: string) => collectReleaseInputs(directory, root, "0.15.0", revision);

test("release collection relocates all generic runtime artifacts and requires the complete SDK matrix", () => {
  const directory = fixture(), inputs = collect(directory);
  expect(Object.keys(inputs.sdks)).toEqual(SDK_MATRIX.map(row => row.triple));
  expect(Object.keys(inputs.runtimes)).toEqual(RUNTIME_MATRIX.map(row => row.profile));
  for (const path of Object.values(inputs.runtimes)) expect(path.startsWith(directory + "/runtimes/")).toBe(true);
  rmSync(inputs.sdks[SDK_MATRIX[0]!.triple]!, { recursive: true });
  expect(() => collect(directory)).toThrow();
});

test("release collection refuses missing, failed, application-bound or stale generic runtime builds", () => {
  const directory = fixture(), build = join(directory, "runtimes", "pocket-runtime-psp-runtime");
  const file = join(build, "build-receipt.json"), receipt = JSON.parse(readFileSync(file, "utf8"));
  for (const change of [{ success: false }, { source: revision + "-dirty" }, { source: "c".repeat(40) },
    { input: { kind: "package" } }, { hostAbi: 1 }, { deployed: true }]) {
    writeFileSync(file, JSON.stringify({ ...receipt, ...change }));
    expect(() => collect(directory)).toThrow("successful generic build");
  }
  rmSync(build, { recursive: true });
  expect(() => collect(directory)).toThrow();
});

test("release collection rejects extra output and symlinks before packaging", () => {
  const directory = fixture(), runtime = join(directory, "runtimes", "pocket-runtime-vita", "runtime");
  const program = join(runtime, "program.bin");
  writeFileSync(join(runtime, "unrecorded"), "extra");
  expect(() => collect(directory)).toThrow("file list");
  rmSync(join(runtime, "unrecorded")); rmSync(program);
  symlinkSync("runtime.json", program);
  expect(() => collect(directory)).toThrow("regular files");
});
