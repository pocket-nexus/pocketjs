import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { hashPocketProfile } from "../framework/src/profile.ts";
import { resolveAppPlan } from "../framework/compiler/app-plan.ts";
import { profileRegistry } from "../tools/profile-resolver.ts";
import { encodeBundle } from "../contracts/spec/bundle.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { makeBundle } from "../tools/bundle.ts";
import { pspBundleInput, pspDemoBundle, pspDemoVariant } from "../tools/psp.ts";
import { demoApp } from "../tools/build/programs/handheld-common.ts";
test("PSP production guest uses canonical runtime, providers, input and shutdown", () => {
  const result = Bun.spawnSync([process.execPath, "tools/test-psp-runtime.ts"], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(result.success, `${result.stdout.toString()}\n${result.stderr.toString()}\nsignal=${result.signalCode}`).toBe(true);
}, 180_000);

import { pspLinkArguments, responseWords } from "../tools/psp-linker.ts";
const profile = POCKET_PROFILES["psp"];

test("PSP SDK fallback libraries follow Rust symbol owners without masking duplicates", () => {
  const args = ["-flavor", "gnu", "main.o", "-Bstatic", "quickjs.rlib", "-lc", "-lm", "-lpthread-psp", "-lcglue", "psp.rlib", "core.rlib", "-Bdynamic", "--gc-sections", "-o", "app.elf"];
  const linked = pspLinkArguments(args);
  expect(linked).toEqual(["-flavor", "gnu", "main.o", "-Bstatic", "quickjs.rlib", "psp.rlib", "core.rlib", "-Bstatic", "-lc", "-lm", "-lpthread-psp", "-lcglue", "-Bdynamic", "--gc-sections", "-o", "app.elf"]);
  expect(linked.some(arg => arg.includes("multiple-definition"))).toBe(false);
  expect(pspLinkArguments(["-flavor", "gnu", "stub.o", "-o", "stub.elf"])).toEqual(["-flavor", "gnu", "stub.o", "-o", "stub.elf"]);
  expect(() => pspLinkArguments(["-lc"])).toThrow("without Rust archives");
});

test("PSP linker response arguments preserve spaces and escaped path characters", () => {
  expect(responseWords('"/tmp/a b/psp.rlib" -lc \'x y.rlib\' plain\\ path.rlib ""')).toEqual(["/tmp/a b/psp.rlib", "-lc", "x y.rlib", "plain path.rlib", ""]);
  expect(() => responseWords('"unfinished')).toThrow("unterminated");
  expect(() => responseWords("unfinished\\")).toThrow("incomplete");
});

function embedDirectory() {
  const base = resolve(import.meta.dir, "../.pocket-build/validation/psp-package-embed");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(resolve(base, "run-"));
}
test("PSP and Vita embed the one compiled bundle verbatim, 16-byte aligned, with their build identities", () => {
  const directory = embedDirectory(), binary = resolve(directory, "embed-tests");
  const build = Bun.spawnSync(["rustc", "--edition=2021", "--test", "tools/build/embedded-bundle.rs", "-o", binary],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(build.success, build.stderr.toString()).toBe(true);
  const run = Bun.spawnSync([binary], { env: { ...process.env, POCKET_EMBED_TEST_DIR: directory }, stdout: "pipe", stderr: "pipe" });
  expect(run.success, run.stdout.toString() + run.stderr.toString()).toBe(true);
  expect(run.stdout.toString()).toContain("3 passed");
}, 60_000);

test("PSP --bundle captures admitted original bytes without requiring or compiling application sources", () => {
  const directory = embedDirectory();
  const app = { id: "dev.pocket.psp-embed", title: "Original package", version: "1.0.0", features: ["text.glyphs.baked"],
    entry: "does-not-exist.tsx", framework: "solid", output: "original",
    viewport: { fixed: { logical: [480, 272], presentation: "native" } } } as const;
  const result = resolveAppPlan(app, { target: profile.id }, profileRegistry(profile));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const bytes = encodeBundle(makeBundle({ plan: result.plan, js: new TextEncoder().encode("globalThis.frame=()=>{};"), pak: new Uint8Array([1, 2, 3]) }));
  const source = resolve(directory, "original.pkb"); writeFileSync(source, bytes);
  const application = pspBundleInput(source, directory)!;
  expect(application.bundlePath).toStartWith(directory);
  expect(application.bundlePath).not.toBe(source);
  expect(readFileSync(application.bundlePath)).toEqual(Buffer.from(bytes));
  const context = { profile, profileHash: hashPocketProfile(profile), configDirectory: directory, outdir: directory,
    output: "original", args: [], env: {}, toolchainPaths: {}, application, async run() { throw new Error("compiler must not run"); } };
  expect(pspBundleInput(undefined, directory, context)).toBe(application);
  expect(() => pspBundleInput(source, directory, context)).toThrow("recipe owns --bundle");
  writeFileSync(source, "corrupt original after admission");
  expect(readFileSync(application.bundlePath)).toEqual(Buffer.from(bytes));
  expect(() => pspBundleInput(source, directory)).toThrow();
});

test("PSP demo builds compile the demo's app section, with --framework replacing its framework", async () => {
  const hero = await demoApp("hero");
  expect(hero.framework).toBe("solid");
  expect(pspDemoVariant()).toBeUndefined();
  expect(pspDemoVariant("octane")!(await demoApp("hero-main")).framework).toBe("octane");
  expect(await pspDemoBundle("hero", "/tmp/psp-out/")).toBe("/tmp/psp-out/hero-main.pkb");
  await expect(demoApp("apps/hero/main.tsx")).rejects.toThrow("not a stock demo");
});

test("PSP CLI rejects missing or conflicting bundle inputs before invoking a toolchain", () => {
  for (const args of [["--bundle"], ["--bundle=/missing/psp-application.pkb"], ["--bundle=/missing", "--runtime"], ["--bundle=/missing", "--plan=/other"], ["--plan=/other"], ["not-a-demo"], ["--pocket=/missing/app.pocket"]]) {
    const result = Bun.spawnSync([process.execPath, "tools/psp.ts", ...args], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    expect(result.success).toBe(false);
    expect(result.stdout.toString()).not.toContain("cargo psp");
    expect(result.stderr.toString()).not.toContain("toolchain is not installed");
  }
});
