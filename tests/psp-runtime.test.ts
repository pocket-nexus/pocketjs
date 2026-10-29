import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { POCKET_PROFILES } from "../profiles/index.ts";
import { hashPocketProfile } from "../framework/src/profile.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { profileRegistry } from "../tools/profile-resolver.ts";
import { encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { makeVariant } from "../tools/pocket-pack.ts";
import { pspDemoManifest, pspDemoPackage, pspLauncherPackages, pspPackageInput } from "../tools/psp.ts";
import { launcherSourceInputs } from "../tools/build/psp/launcher.ts";
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
test("PSP writer emits real static tables with exact package bytes and explicit launcher inputs", () => {
  const directory = embedDirectory(), binary = resolve(directory, "embed-tests");
  const build = Bun.spawnSync(["rustc", "--edition=2021", "--test", "tools/build/embedded-apps.rs", "-o", binary],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(build.success, build.stderr.toString()).toBe(true);
  const run = Bun.spawnSync([binary], { env: { ...process.env, POCKET_EMBED_TEST_DIR: directory }, stdout: "pipe", stderr: "pipe" });
  expect(run.success, run.stdout.toString() + run.stderr.toString()).toBe(true);
  expect(run.stdout.toString()).toContain("4 passed");
}, 60_000);

test("PSP --pocket captures admitted original bytes without requiring or compiling application sources", () => {
  const directory = embedDirectory();
  const manifest = { $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2,
    id: "dev.pocket.psp-embed", title: "Original package", version: "1.0.0",
    engine: { capabilities: { requires: ["text.glyphs.baked"] } },
    app: { entry: "does-not-exist.tsx", framework: "solid", output: "original",
      viewport: { fixed: { logical: [480, 272], presentation: "native" } } } };
  const result = validateAndResolveBuildPlan(manifest, { target: profile.id }, profileRegistry(profile));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const variant = makeVariant({ target: profile.id, hostAbi: POCKET_BINDING_GENERATION,
    planJson: JSON.stringify(result.plan), identity: { id: manifest.id, title: manifest.title, output: "original" },
    js: new TextEncoder().encode("globalThis.frame=()=>{};"), pak: new Uint8Array([1, 2, 3]) });
  const bytes = encodePocketPackage({ manifest: new TextEncoder().encode(JSON.stringify(manifest)), variants: [variant] });
  const source = resolve(directory, "original.pocket"); writeFileSync(source, bytes);
  const application = pspPackageInput(source, directory)!;
  expect(application.packagePath).toStartWith(directory);
  expect(application.packagePath).not.toBe(source);
  expect(readFileSync(application.packagePath)).toEqual(Buffer.from(bytes));
  const context = { profile, profileHash: hashPocketProfile(profile), configDirectory: directory, outdir: directory,
    output: "original", args: [], env: {}, toolchainPaths: {}, application, async run() { throw new Error("compiler must not run"); } };
  expect(pspPackageInput(undefined, directory, context)).toBe(application);
  expect(() => pspPackageInput(source, directory, context)).toThrow("recipe owns --pocket");
  writeFileSync(source, "corrupt original after admission");
  expect(readFileSync(application.packagePath)).toEqual(Buffer.from(bytes));
  expect(() => pspPackageInput(source, directory)).toThrow();
});

test("PSP demo builds compile the demo manifest, with --framework replacing its framework", () => {
  expect(pspDemoManifest("hero").app.framework).toBe("solid");
  expect(pspDemoManifest("hero-main", "octane").app.framework).toBe("octane");
  expect(pspDemoPackage("hero", "/tmp/psp-out/")).toBe("/tmp/psp-out/hero-main.pocket");
  expect(() => pspDemoManifest("apps/hero/main.tsx")).toThrow("not a stock demo");
});

test("PSP CLI rejects missing or conflicting package inputs before invoking a toolchain", () => {
  for (const args of [["--pocket"], ["--pocket=/missing/psp-application.pocket"], ["--pocket=/missing", "--runtime"], ["--pocket=/missing", "--plan=/other"], ["--plan=/other"], ["not-a-demo"]]) {
    const result = Bun.spawnSync([process.execPath, "tools/psp.ts", ...args], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    expect(result.success).toBe(false);
    expect(result.stdout.toString()).not.toContain("cargo psp");
    expect(result.stderr.toString()).not.toContain("toolchain is not installed");
  }
});

test("PSP launcher packages resolve beside the registry, independently of captured application output", () => {
  const directory = embedDirectory(), registry = resolve(directory, "launcher-registry.tsv");
  const packages = resolve(directory, "packages"), explicit = resolve(directory, "elsewhere");
  writeFileSync(registry, "guest\tdev.guest\tGuest\n"); mkdirSync(packages); mkdirSync(explicit);
  expect(pspLauncherPackages(registry)).toBe(packages);
  expect(pspLauncherPackages(registry, explicit)).toBe(explicit);
  expect(() => pspLauncherPackages(registry, resolve(directory, "missing"))).toThrow("directory is missing");
  expect(() => pspLauncherPackages(resolve(directory, "absent.tsv"))).toThrow("registry is missing");
  expect(() => pspLauncherPackages("", packages)).toThrow("requires --launcher-registry");
  expect(pspLauncherPackages("")).toBe("");
});

test("PSP launcher source declarations match explicit registry guests and package directories", () => {
  const dir = embedDirectory(), registry = resolve(dir, "registry.tsv"), packages = resolve(dir, "packages"), elsewhere = resolve(dir, "elsewhere");
  mkdirSync(packages); mkdirSync(elsewhere);
  writeFileSync(registry, "first\tdev.first\tFirst\r\nsecond\tdev.second\tSecond\r\n");
  for (const base of [packages, elsewhere]) for (const name of ["first", "second"]) writeFileSync(resolve(base, name + ".pocket"), name);
  const ctx = { invocationDirectory: dir, output: "launcher", args: ["--launcher-registry=registry.tsv"] };
  expect(launcherSourceInputs(ctx)).toEqual([registry, resolve(packages, "first.pocket"), resolve(packages, "second.pocket")]);
  expect(launcherSourceInputs({ ...ctx, args: [...ctx.args, "--launcher-packages=elsewhere"] }))
    .toEqual([registry, resolve(elsewhere, "first.pocket"), resolve(elsewhere, "second.pocket")]);
  expect(launcherSourceInputs({ ...ctx, args: [] })).toEqual([]);
  expect(() => launcherSourceInputs({ ...ctx, args: ["--launcher-packages=elsewhere"] })).toThrow("requires --launcher-registry");
  expect(() => launcherSourceInputs({ ...ctx, args: ["--launcher-registry"] })).toThrow("requires =<path>");
  writeFileSync(registry, "launcher\tdev.launcher\tLauncher\n");
  expect(() => launcherSourceInputs(ctx)).toThrow("duplicates output");
  writeFileSync(registry, "\uFEFFfirst\tdev.first\tFirst\n");
  expect(() => launcherSourceInputs(ctx)).toThrow("invalid launcher output");
});
