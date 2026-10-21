import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { decodePocketPackage, encodePocketPackage, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { cargo, cmake, compilerOnly, defineRuntimeConfig, make, type RuntimeBuild } from "../framework/src/runtime-config.ts";
import { buildRuntime } from "../tools/build/executor.ts";
import { packRuntime } from "../tools/build/pack.ts";
import { writeRuntimeManifest } from "../tools/runtime/manifest.ts";
import { prepareAot, prepareApplication } from "../tools/build/inputs.ts";
import { makeVariant } from "../tools/pocket-pack.ts";
import { resolveProfile, type ResolvedProfile } from "../tools/profile-resolver.ts";

const root = resolve(import.meta.dir, "..");
const base = join(root, ".pocket-build/validation/runtime-build/tests");
mkdirSync(base, { recursive: true });
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function scratch() { const path = mkdtempSync(join(base, "native-")); temporary.push(path); return path; }
const manifest = JSON.parse(readFileSync(join(root, "tests/fixtures/manifests/portable-psp.json"), "utf8"));
function plan() {
  const result = validateAndResolveBuildPlan(manifest, { target: "psp" });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}
async function program(directory: string, build: Omit<RuntimeBuild, "hosts">): Promise<ResolvedProfile> {
  const selected = await resolveProfile({ from: directory, target: "psp" });
  return { ...selected, config: { path: join(directory, "pocket.runtime-config.ts"), profiles: [selected.profile], dependencies: [],
    value: defineRuntimeConfig({ profile: selected.profile, build: { hosts: [`${process.platform}-${process.arch}` as "darwin-arm64"], ...build } }) } };
}
function application(directory: string, generation = POCKET_BINDING_GENERATION as number, profileHash?: string): string {
  const resolved = plan();
  const variant = makeVariant({ target: "psp", hostAbi: POCKET_BINDING_GENERATION, planJson: JSON.stringify(resolved),
    identity: { output: resolved.app.output, id: resolved.app.id, title: resolved.app.title },
    js: new TextEncoder().encode("globalThis.frame = () => {};"), pak: new Uint8Array([1, 2, 3]) });
  const path = join(directory, "app.pocket");
  writeFileSync(path, encodePocketPackage({ manifest: new TextEncoder().encode(JSON.stringify(manifest)), variants: [{ ...variant, hostAbi: generation, ...(profileHash ? { profileHash } : {}) }] }));
  return path;
}

test("native input admission preserves compiled bytes and rejects package/profile drift before a build hook", async () => {
  const dir = scratch(); let calls = 0;
  const selected = await program(dir, { input: "package", steps: compilerOnly(), run() { calls++; } });
  const pocket = application(dir);
  const input = prepareApplication(selected, pocket, join(dir, "out"));
  expect(readFileSync(input.jsPath, "utf8")).toBe("globalThis.frame = () => {};");
  expect([...readFileSync(input.pakPath)]).toEqual([1, 2, 3]);
  expect(input.plan.planHash).toBe(plan().planHash);
  await expect(buildRuntime(selected, join(dir, "missing"))).rejects.toThrow("--pocket");
  const admittedBytes = readFileSync(input.packagePath);
  application(dir, 1);
  expect(readFileSync(input.packagePath)).toEqual(admittedBytes);
  await expect(buildRuntime(selected, join(dir, "legacy"), { pocket })).rejects.toThrow("binding generation");
  application(dir, POCKET_BINDING_GENERATION, "sha256:" + "0".repeat(64));
  await expect(buildRuntime(selected, join(dir, "wrong"), { pocket })).rejects.toThrow("profileHash");
  expect(calls).toBe(0);
  expect(existsSync(join(dir, "legacy/pocket_profile.h"))).toBe(false);
});

test.skipIf(!Bun.which("cmake") || !Bun.which("cc") || !Bun.which("make"))("CMake and make recipes build native executables with the exported program identity", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "main.c"), `#include "pocket_profile.h"\nint main(void) { return pocket_profile.host_abi == ${POCKET_BINDING_GENERATION} && POCKET_PROFILE_WIDTH == 480 ? 0 : 9; }\n`);
  writeFileSync(join(dir, "CMakeLists.txt"), 'cmake_minimum_required(VERSION 3.16)\nproject(executor_fixture C)\nadd_executable(program main.c)\ntarget_include_directories(program PRIVATE "${PROFILE_DIR}")\n');
  writeFileSync(join(dir, "Makefile"), 'program:\n\t$(CC) -I"$(PROFILE_DIR)" main.c -o "$(OUTPUT)"\n');
  for (const kind of ["cmake", "make"] as const) {
    const out = join(dir, kind);
    const selected = await program(dir, {
      steps: kind === "cmake" ? cmake({ buildDirectory: "{outdir}/native", definitions: { PROFILE_DIR: "{outdir}" } }) : make({ variables: { CC: Bun.which("cc")!, PROFILE_DIR: "{outdir}", OUTPUT: "{outdir}/program" } }),
      artifact: kind === "cmake" ? "{outdir}/native/program" : "{outdir}/program",
      async run(ctx) { await ctx.run([join(ctx.outdir, kind === "cmake" ? "native/program" : "program")]); },
    });
    const result = await buildRuntime(selected, out);
    const receipt = JSON.parse(readFileSync(result.receipt!, "utf8"));
    expect(receipt.success).toBe(true); expect(receipt.hostAbi).toBe(POCKET_BINDING_GENERATION);
    expect(receipt.profileHash).toBe(selected.profileHash); expect(receipt.files.program.bytes).toBeGreaterThan(100);
    expect(receipt.commands.every((command: { status: number }) => command.status === 0)).toBe(true);
  }
}, 60_000);

test("Cargo recipes pass the trusted profile to native build scripts and require a lockfile", async () => {
  const dir = scratch(); const out = join(dir, "out");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "Cargo.toml"), '[package]\nname="pocket-executor-fixture"\nversion="0.1.0"\nedition="2021"\n[workspace]\n');
  writeFileSync(join(dir, "Cargo.lock"), 'version = 4\n[[package]]\nname = "pocket-executor-fixture"\nversion = "0.1.0"\n');
  writeFileSync(join(dir, "src/main.rs"), `fn main() { assert_eq!(env!("POCKETJS_HOST_ABI"), "${POCKET_BINDING_GENERATION}"); assert_eq!(env!("POCKETJS_TARGET"), "psp"); }\n`);
  const selected = await program(dir, { steps: cargo({ toolchain: "stable", release: false, targetDirectory: "{outdir}/cargo", args: ["--offline"], env: { POCKETJS_TARGET: "wrong", POCKETJS_HOST_ABI: "1" } }),
    artifact: "{outdir}/cargo/debug/pocket-executor-fixture", async run(ctx) { await ctx.run([join(ctx.outdir, "cargo/debug/pocket-executor-fixture")]); } });
  const built = await buildRuntime(selected, out);
  expect(JSON.parse(readFileSync(built.receipt!, "utf8")).success).toBe(true);
}, 60_000);

test("failed or signaled commands cannot publish a successful receipt or run deploy", async () => {
  const dir = scratch(); let deployed = false;
  const dependency = join(dir, "recipe-input.json");
  writeFileSync(dependency, "before");
  const selected = await program(dir, { steps: compilerOnly(), sourceInputs: ["recipe-input.json"], async run(ctx) {
    writeFileSync(dependency, "after");
    await ctx.run([process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")']);
  }, deploy() { deployed = true; } });
  await expect(buildRuntime(selected, join(dir, "out"), { deploy: true })).rejects.toThrow("SIGTERM");
  const receipt = JSON.parse(readFileSync(join(dir, "out/build-receipt.json"), "utf8"));
  expect(receipt.success).toBe(false); expect(receipt.deployed).toBe(false); expect(deployed).toBe(false);
  expect(receipt.dependencies[dependency].sha256).toBe(createHash("sha256").update("before").digest("hex"));
});

test("successful native commands cannot deploy changed configuration or source inputs", async () => {
  for (const mutation of ["config", "content", "add", "delete", "empty-directory"] as const) {
    const dir = scratch(); const source = join(dir, "src"); mkdirSync(source);
    const dependency = join(dir, "config-dependency.ts"); writeFileSync(dependency, "before");
    const native = join(source, "native.c"); writeFileSync(native, "before");
    writeFileSync(join(source, "kept.h"), "unchanged");
    let deployed = false;
    const change = mutation === "config" ? `fs.writeFileSync(${JSON.stringify(dependency)}, 'after')`
      : mutation === "content" ? `fs.writeFileSync(${JSON.stringify(native)}, 'after')`
      : mutation === "add" ? `fs.writeFileSync(${JSON.stringify(join(source, "added.c"))}, 'new')`
      : mutation === "empty-directory" ? `fs.mkdirSync(${JSON.stringify(join(source, "empty"))})`
      : `fs.unlinkSync(${JSON.stringify(native)})`;
    const selected = await program(dir, { steps: compilerOnly(), sourceInputs: ["src"], artifact: "{outdir}/native.bin",
      async run(ctx) {
        await ctx.run([process.execPath, "-e", `const fs = require('node:fs'); ${change}; fs.writeFileSync(${JSON.stringify(join(dir, "out/native.bin"))}, 'native output');`]);
      }, deploy() { deployed = true; } });
    await expect(buildRuntime({ ...selected, dependencies: [dependency] }, join(dir, "out"), { deploy: true })).rejects.toThrow("runtime build inputs changed");
    const receipt = JSON.parse(readFileSync(join(dir, "out/build-receipt.json"), "utf8"));
    expect(receipt.success).toBe(false); expect(receipt.deployed).toBe(false); expect(deployed).toBe(false);
    expect(receipt.commands[0].status).toBe(0);
    expect(receipt.failure).toContain("runtime build inputs changed");
    expect(receipt.dependencies[dependency].sha256).toBe(createHash("sha256").update("before").digest("hex"));
    expect(receipt.dependencies[native].sha256).toBe(createHash("sha256").update("before").digest("hex"));
    expect(receipt.dependencies[join(source, "added.c")]).toBeUndefined();
  }
});

test("AOT consumption verifies relocated generated outputs and rejects stale generation or changed bytes", async () => {
  const dir = scratch(); const selected = await resolveProfile({ from: dir, target: "psp" });
  const sources = [{ file: "include.rs", source: '#[path="mod.rs"] mod generated;' }, { file: "mod.rs", source: "pub fn guest() {}" }];
  for (const source of sources) writeFileSync(join(dir, source.file), source.source);
  const receipt = { schemaVersion: 1, kind: "aot", hostAbi: POCKET_BINDING_GENERATION, plan: plan(), planHash: plan().planHash, profileHash: selected.profileHash,
    outputs: sources.map(source => ({ file: source.file, sha256: createHash("sha256").update(source.source).digest("hex") })) };
  const path = join(dir, "dependencies.json"); writeFileSync(path, JSON.stringify(receipt));
  expect(prepareAot(selected, dir).includeFile).toBe(join(dir, "include.rs"));
  writeFileSync(path, JSON.stringify({ ...receipt, hostAbi: 1 }));
  expect(() => prepareAot(selected, dir)).toThrow("binding generation");
  writeFileSync(path, JSON.stringify(receipt)); writeFileSync(join(dir, "mod.rs"), "changed");
  expect(() => prepareAot(selected, dir)).toThrow("checksum mismatch");
});


test("pack uses the program's repack adapter after matching runtime, package and configuration identity", async () => {
  const dir = scratch(); const runtime = join(dir, "runtime"); mkdirSync(runtime);
  const config = join(dir, "pocket.runtime-config.ts");
  writeFileSync(config, `import {defineRuntimeConfig,compilerOnly} from '@pocketjs/framework/runtime-config';
    import profile from '@pocketjs/framework/profiles/psp';
    export default defineRuntimeConfig({profile,build:{hosts:['darwin-arm64','darwin-x64','linux-x64','linux-arm64'],steps:compilerOnly(),
      genericRuntime:{extension:'.fixture',async repack(input){return new Uint8Array([...input.runtime.get('native.bin'),...new TextEncoder().encode(input.identity.id)]);}}}});`);
  const selected = await resolveProfile({ from: dir });
  writeFileSync(join(runtime, "native.bin"), new Uint8Array([7, 8, 9]));
  await writeRuntimeManifest(runtime, { target: "psp", hostAbi: POCKET_BINDING_GENERATION, profile: "psp", profileHash: selected.profileHash, files: ["native.bin"] });
  const pocket = application(dir);
  const packed = await packRuntime({ config, runtime, pocket, output: join(dir, "app.fixture") }, dir);
  expect([...readFileSync(packed).subarray(0, 3)]).toEqual([7, 8, 9]);
  expect(readFileSync(packed).subarray(3).toString()).toBe(plan().app.id);
  const decoded = decodePocketPackage(readFileSync(pocket));
  const malformed = join(dir, "malformed.pocket");
  writeFileSync(malformed, encodePocketPackage({ ...decoded, variants: decoded.variants.map(variant => ({ ...variant,
    sections: variant.sections.map(section => section.kind === POCKET_SECTION.js ? { ...section, bytes: section.bytes.subarray(0, section.bytes.length - 1) } : section),
  })) }));
  const rejected = join(dir, "rejected.fixture");
  await expect(packRuntime({ config, runtime, pocket: malformed, output: rejected }, dir)).rejects.toThrow("NUL-terminated");
  expect(existsSync(rejected)).toBe(false);
  writeFileSync(join(runtime, "unlisted.bin"), "unverified bytes");
  await expect(packRuntime({ config, runtime, pocket, output: rejected }, dir)).rejects.toThrow("unlisted file");
  expect(existsSync(rejected)).toBe(false);
  rmSync(join(runtime, "unlisted.bin"));
  writeFileSync(join(runtime, "native.bin"), new Uint8Array([9, 9, 9]));
  await expect(packRuntime({ config, runtime, pocket, output: join(dir, "bad.fixture") }, dir)).rejects.toThrow("not the file");
  expect(existsSync(join(dir, "bad.fixture"))).toBe(false);
});
