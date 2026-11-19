import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { BUNDLE_SECTION, decodeBundle, encodeBundle } from "../contracts/spec/bundle.ts";
import { resolveAppPlan } from "../framework/compiler/app-plan.ts";
import { PORTABLE_APP } from "./app-fixtures.ts";
import { cargo, cmake, compilerOnly, defineHostConfig, make, type RuntimeBuild, type RuntimeSourceContext } from "../framework/src/host-config.ts";
import { buildRuntime } from "../tools/build/executor.ts";
import { prepareAot, prepareApplication } from "../tools/build/inputs.ts";
import { packRuntime } from "../tools/build/pack.ts";
import { makeBundle } from "../tools/bundle.ts";
import { resolveProfile, type ResolvedProfile } from "../tools/profile-resolver.ts";
import { writeRuntimeManifest } from "../tools/runtime/manifest.ts";

const root = resolve(import.meta.dir, "..");
const base = join(root, ".pocket-build/validation/runtime-build/tests");
mkdirSync(base, { recursive: true });
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function scratch() { const path = mkdtempSync(join(base, "native-")); temporary.push(path); return path; }
function plan() {
  const result = resolveAppPlan(PORTABLE_APP, { target: "psp" });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}
async function program(directory: string, build: Omit<RuntimeBuild, "hosts">): Promise<ResolvedProfile> {
  const selected = await resolveProfile({ from: directory, target: "psp" });
  return { ...selected, config: { path: join(directory, "pocket.host.config.ts"), profiles: [selected.profile], profilePaths: [selected.path!], dependencies: [],
    value: defineHostConfig({ host: selected.path!, build: { hosts: [`${process.platform}-${process.arch}` as "darwin-arm64"], ...build } }) } };
}
function application(directory: string, generation = POCKET_BINDING_GENERATION as number, profileHash?: string): string {
  const bundle = makeBundle({ plan: plan(), js: new TextEncoder().encode("globalThis.frame = () => {};"), pak: new Uint8Array([1, 2, 3]) });
  const path = join(directory, "app.pkb");
  writeFileSync(path, encodeBundle({ ...bundle, hostAbi: generation, ...(profileHash ? { profileHash } : {}) }));
  return path;
}

test("native input admission preserves compiled bytes and rejects stale binding generations before a build hook", async () => {
  const dir = scratch(); let calls = 0;
  const selected = await program(dir, { input: "bundle", steps: compilerOnly(), run() { calls++; } });
  const bundle = application(dir);
  const input = prepareApplication(selected, bundle, join(dir, "out"));
  expect(readFileSync(input.jsPath, "utf8")).toBe("globalThis.frame = () => {};");
  expect([...readFileSync(input.pakPath)]).toEqual([1, 2, 3]);
  await expect(buildRuntime(selected, join(dir, "missing"))).rejects.toThrow("--bundle");
  const admittedBytes = readFileSync(input.bundlePath);
  application(dir, 1);
  expect(readFileSync(input.bundlePath)).toEqual(admittedBytes);
  await expect(buildRuntime(selected, join(dir, "legacy"), { bundle })).rejects.toThrow("binding generation");
  expect(calls).toBe(0);
  expect(existsSync(join(dir, "legacy/pocket_profile.h"))).toBe(false);
});

test("native input admission reads the bundle's plan and requires the program's host contract", async () => {
  const dir = scratch();
  const selected = await program(dir, { input: "bundle", steps: compilerOnly() });
  const input = prepareApplication(selected, application(dir), join(dir, "out"));
  expect(input.plan.app.id).toBe(PORTABLE_APP.id);
  expect(readFileSync(input.jsPath, "utf8")).toBe("globalThis.frame = () => {};");
  expect(() => prepareApplication(selected, application(dir, POCKET_BINDING_GENERATION, `sha256:${"0".repeat(64)}`), join(dir, "stale")))
    .toThrow("profileHash");
});

test.skipIf(!Bun.which("cmake") || !Bun.which("cc") || !Bun.which("make"))("CMake and make recipes build native executables with the exported program identity", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "main.c"), `#include "pocket_profile.h"\nint main(void) { return pocket_profile.host_abi == ${POCKET_BINDING_GENERATION} && POCKET_PROFILE_WIDTH == 480 ? 0 : 9; }\n`);
  writeFileSync(join(dir, "CMakeLists.txt"), 'cmake_minimum_required(VERSION 3.16)\nproject(executor_fixture C)\nadd_executable(program main.c)\ntarget_include_directories(program PRIVATE "${PROFILE_DIR}" "${CONTRACTS_DIR}")\n');
  writeFileSync(join(dir, "Makefile"), 'program:\n\t$(CC) -I"$(PROFILE_DIR)" -I"$(CONTRACTS_DIR)" main.c -o "$(OUTPUT)"\n');
  for (const kind of ["cmake", "make"] as const) {
    const out = join(dir, kind);
    const selected = await program(dir, {
      steps: kind === "cmake" ? cmake({ buildDirectory: "{outdir}/native", definitions: { PROFILE_DIR: "{outdir}", CONTRACTS_DIR: "{contracts}" } }) : make({ variables: { CC: Bun.which("cc")!, PROFILE_DIR: "{outdir}", CONTRACTS_DIR: "{contracts}", OUTPUT: "{outdir}/program" } }),
      artifact: kind === "cmake" ? "{outdir}/native/program" : "{outdir}/program",
      async run(ctx) { await ctx.run([join(ctx.outdir, kind === "cmake" ? "native/program" : "program")]); },
    });
    const result = await buildRuntime(selected, out);
    const receipt = JSON.parse(readFileSync(result.receipt!, "utf8"));
    expect(receipt.success).toBe(true); expect(receipt.hostAbi).toBe(POCKET_BINDING_GENERATION);
    expect(receipt.files.program.bytes).toBeGreaterThan(100);
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
      expect(receipt.dependencies[join(source, "added.c")]).toBeUndefined();
  }
});

/** A program whose native inputs are chosen at build time: `--inputs=<list>`
 *  (relative to the invocation directory) names a list file, and the list
 *  names one regular file per line, relative to the list. */
function listedInputs(context: Pick<RuntimeSourceContext, "args" | "invocationDirectory">): string[] {
  const argument = context.args.find(arg => arg.startsWith("--inputs="));
  if (!argument) return [];
  const list = resolve(context.invocationDirectory, argument.slice("--inputs=".length));
  return [list, ...readFileSync(list, "utf8").split("\n").filter(Boolean).map(name => {
    const path = resolve(dirname(list), name);
    if (!lstatSync(path).isFile()) throw new Error(`listed input is not a regular file: ${path}`);
    return path;
  })];
}

test("dynamic sourceInputs exclude the directory a build writes its output into", async () => {
  const dir = scratch(), list = join(dir, "inputs.txt"), packages = join(dir, "packages");
  mkdirSync(packages); writeFileSync(list, "packages/guest.pkb\n");
  const bundle = application(dir), guest = join(packages, "guest.pkb");
  writeFileSync(guest, readFileSync(bundle));
  const seen: string[][] = [];
  const selected = await program(dir, { input: "bundle", steps: compilerOnly(),
    sourceInputs(ctx) {
      expect("run" in ctx).toBe(false); expect("env" in ctx).toBe(false);
      expect(ctx.invocationDirectory).toBe(process.cwd());
      expect(ctx.application?.plan.app.output).toBe(ctx.output);
      const paths = listedInputs(ctx); seen.push(paths); return paths;
    }, run() { writeFileSync(join(packages, "generated-cover.png"), "generated output"); },
  });
  const args = [`--inputs=${relative(process.cwd(), list)}`];
  const first = await buildRuntime(selected, join(dir, "first"), { bundle, args });
  const before = JSON.parse(readFileSync(first.receipt!, "utf8"));
  expect(before.sourceInputs).toEqual([list, guest].sort());
  expect(before.dependencies[packages]).toBeUndefined();
  expect(before.dependencies[join(packages, "generated-cover.png")]).toBeUndefined();
  const decoded = decodeBundle(readFileSync(guest));
  const changed = encodeBundle({ ...decoded, sections: [...decoded.sections, { kind: 99, bytes: new Uint8Array([42]) }] });
  writeFileSync(guest, changed);
  const second = await buildRuntime(selected, join(dir, "second"), { bundle, args });
  const after = JSON.parse(readFileSync(second.receipt!, "utf8"));
  expect(after.success).toBe(true);
  expect(seen).toEqual(Array.from({ length: 4 }, () => [list, guest]));
});

test("dynamic input content and list changes during a build reject success and deployment", async () => {
  for (const mutation of ["listed", "list"] as const) {
    const dir = scratch(), list = join(dir, "inputs.txt"), packages = join(dir, "packages");
    mkdirSync(packages); writeFileSync(list, "packages/guest.pkb\n");
    const bundle = application(dir), guest = join(packages, "guest.pkb");
    const bytes = readFileSync(bundle); writeFileSync(guest, bytes); writeFileSync(join(packages, "other.pkb"), bytes);
    let deployed = false;
    const selected = await program(dir, { input: "bundle", steps: compilerOnly(), sourceInputs: listedInputs,
      run() {
        if (mutation === "listed") writeFileSync(guest, "changed during build");
        else writeFileSync(list, "packages/other.pkb\n");
      }, deploy() { deployed = true; },
    });
    const out = join(dir, "out");
    await expect(buildRuntime(selected, out, { bundle, args: [`--inputs=${list}`], deploy: true }))
      .rejects.toThrow("runtime build inputs changed");
    const receipt = JSON.parse(readFileSync(join(out, "build-receipt.json"), "utf8"));
    expect(receipt.success).toBe(false); expect(deployed).toBe(false);
    expect(receipt.dependencies[join(packages, "other.pkb")]).toBeUndefined();
  }
});

test("dynamic sourceInputs compare the declared path set even when both paths are existing config dependencies", async () => {
  const dir = scratch(), first = join(dir, "first"), second = join(dir, "second");
  writeFileSync(first, "first"); writeFileSync(second, "second");
  let paths = [first];
  const selected = await program(dir, { steps: compilerOnly(), sourceInputs: () => paths, run() { paths = [second]; } });
  const out = join(dir, "out");
  await expect(buildRuntime({ ...selected, dependencies: [first, second] }, out)).rejects.toThrow("sourceInputs path set");
  const receipt = JSON.parse(readFileSync(join(out, "build-receipt.json"), "utf8"));
  expect(receipt.success).toBe(false); expect(receipt.sourceInputs).toEqual([first]);
  expect(receipt.dependencies[first]).toBeDefined(); expect(receipt.dependencies[second]).toBeDefined();
});

test("sourceInputs functions must return synchronous nonempty string paths and arrays remain compatible", async () => {
  const dir = scratch(); let calls = 0;
  for (const result of [undefined, "file", [""], [42], Promise.resolve(["file"])]) {
    const selected = await program(dir, { steps: compilerOnly(), sourceInputs: (() => result) as RuntimeBuild["sourceInputs"], run() { calls++; } });
    await expect(buildRuntime(selected, join(dir, "bad"))).rejects.toThrow("sourceInputs must return");
  }
  expect(calls).toBe(0);
  writeFileSync(join(dir, "file"), "original array API");
  const selected = await program(dir, { steps: compilerOnly(), sourceInputs: ["file"], run() { calls++; } });
  const result = await buildRuntime(selected, join(dir, "array"));
  const receipt = JSON.parse(readFileSync(result.receipt!, "utf8"));
  expect(receipt.success).toBe(true); expect(calls).toBe(1);
  expect(receipt.sourceInputs).toEqual([join(dir, "file")]);
});

test("a dynamic sourceInputs function that throws fails the build before its hook", async () => {
  const dir = scratch(), list = join(dir, "inputs.txt"), packages = join(dir, "packages");
  mkdirSync(packages); mkdirSync(join(packages, "directory")); const bundle = application(dir); let calls = 0;
  const selected = await program(dir, { input: "bundle", steps: compilerOnly(), sourceInputs: listedInputs, run() { calls++; } });
  for (const name of ["packages/absent.pkb", "packages/directory"]) {
    writeFileSync(list, `${name}\n`);
    await expect(buildRuntime(selected, join(dir, "bad"), { bundle, args: [`--inputs=${list}`] })).rejects.toThrow();
  }
  await expect(buildRuntime(selected, join(dir, "bad"), { bundle, args: [`--inputs=${join(dir, "absent.txt")}`] })).rejects.toThrow();
  expect(calls).toBe(0);
});

test("AOT consumption accepts relocated outputs and rejects stale generation", async () => {
  const dir = scratch(); const selected = await resolveProfile({ from: dir, target: "psp" });
  const sources = [{ file: "include.rs", source: '#[path="mod.rs"] mod generated;' }, { file: "mod.rs", source: "pub fn guest() {}" }];
  for (const source of sources) writeFileSync(join(dir, source.file), source.source);
  const receipt = { schemaVersion: 1, kind: "aot", hostAbi: POCKET_BINDING_GENERATION, plan: plan(), planHash: plan().planHash, profileHash: selected.profileHash,
    outputs: sources.map(source => ({ file: source.file, sha256: createHash("sha256").update(source.source).digest("hex") })) };
  const path = join(dir, "dependencies.json"); writeFileSync(path, JSON.stringify(receipt));
  expect(prepareAot(selected, dir).includeFile).toBe(join(dir, "include.rs"));
  writeFileSync(path, JSON.stringify({ ...receipt, hostAbi: 1 }));
  expect(() => prepareAot(selected, dir)).toThrow("binding generation");
});


test("pack uses the program's repack adapter after matching runtime, package and configuration identity", async () => {
  const dir = scratch(); const runtime = join(dir, "runtime"); mkdirSync(runtime);
  const config = join(dir, "pocket.host.config.ts");
  writeFileSync(config, `import {defineHostConfig,compilerOnly} from '@pocketjs/framework/host-config';
    export default defineHostConfig({host:${JSON.stringify(join(import.meta.dir, "../hosts/psp/pocket.host.json"))},build:{hosts:['darwin-arm64','darwin-x64','linux-x64','linux-arm64'],steps:compilerOnly(),
      genericRuntime:{extension:'.fixture',async repack(input){return new Uint8Array([...input.runtime.get('native.bin'),...new TextEncoder().encode(input.identity.id)]);}}}});`);
  const selected = await resolveProfile({ from: dir });
  writeFileSync(join(runtime, "native.bin"), new Uint8Array([7, 8, 9]));
  await writeRuntimeManifest(runtime, { target: "psp", hostAbi: POCKET_BINDING_GENERATION, profile: selected.profile, files: ["native.bin"] });
  const bundle = application(dir);
  const packed = await packRuntime({ config, runtime, bundle, output: join(dir, "app.fixture") }, dir);
  expect([...readFileSync(packed).subarray(0, 3)]).toEqual([7, 8, 9]);
  expect(readFileSync(packed).subarray(3).toString()).toBe(plan().app.id);
  const decoded = decodeBundle(readFileSync(bundle));
  const malformed = join(dir, "malformed.pkb");
  writeFileSync(malformed, encodeBundle({ ...decoded,
    sections: decoded.sections.map(section => section.kind === BUNDLE_SECTION.js ? { ...section, bytes: section.bytes.subarray(0, section.bytes.length - 1) } : section),
  }));
  const rejected = join(dir, "rejected.fixture");
  await expect(packRuntime({ config, runtime, bundle: malformed, output: rejected }, dir)).rejects.toThrow("NUL-terminated");
  expect(existsSync(rejected)).toBe(false);
  writeFileSync(join(runtime, "unlisted.bin"), "unverified bytes");
  await expect(packRuntime({ config, runtime, bundle, output: rejected }, dir)).rejects.toThrow("unlisted file");
  expect(existsSync(rejected)).toBe(false);
  rmSync(join(runtime, "unlisted.bin"));
});

test("pack takes the identity's author from the application's config and its icon from the icon section", async () => {
  const dir = scratch(); const runtime = join(dir, "runtime"); mkdirSync(runtime);
  const config = join(dir, "pocket.host.config.ts");
  writeFileSync(config, `import {defineHostConfig,compilerOnly} from '@pocketjs/framework/host-config';
    export default defineHostConfig({host:${JSON.stringify(join(import.meta.dir, "../hosts/psp/pocket.host.json"))},app:${JSON.stringify({ ...PORTABLE_APP, author: "Pocket Nexus" })},build:{hosts:['darwin-arm64','darwin-x64','linux-x64','linux-arm64'],steps:compilerOnly(),
      genericRuntime:{extension:'.fixture',async repack(input){return new TextEncoder().encode(JSON.stringify({author:input.identity.author,icon:[...(input.identity.icon??[])]}));}}}});`);
  const selected = await resolveProfile({ from: dir });
  writeFileSync(join(runtime, "native.bin"), new Uint8Array([7]));
  await writeRuntimeManifest(runtime, { target: "psp", hostAbi: POCKET_BINDING_GENERATION, profile: selected.profile, files: ["native.bin"] });
  const icon = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const bundle = join(dir, "authored.pkb");
  writeFileSync(bundle, encodeBundle(makeBundle({ plan: plan(), js: new TextEncoder().encode("globalThis.frame = () => {};"), pak: new Uint8Array(), icon })));
  const packed = await packRuntime({ config, runtime, bundle, output: join(dir, "app.fixture") }, dir);
  expect(JSON.parse(readFileSync(packed, "utf8"))).toEqual({ author: "Pocket Nexus", icon: [...icon] });
  const explicit = await packRuntime({ config, runtime, bundle, output: join(dir, "explicit.fixture"), author: "Someone" }, dir);
  expect(JSON.parse(readFileSync(explicit, "utf8")).author).toBe("Someone");
});

test("config resolution directories exclude generated native outputs but retain package and module candidates", async () => {
  for (const mutation of ["native-output", "package", "lock", "module"] as const) {
    const dir = scratch();
    mkdirSync(join(dir, "choice"));
    writeFileSync(join(dir, "choice/index.ts"), "export default 1;\n");
    const change = mutation === "native-output"
      ? 'fs.writeFileSync(import.meta.dir + "/Psp.toml", "generated metadata"); fs.mkdirSync(import.meta.dir + "/target");'
      : `fs.writeFileSync(import.meta.dir + ${JSON.stringify(mutation === "package" ? "/package.json" : mutation === "lock" ? "/bun.lock" : "/choice.ts")}, ${JSON.stringify(mutation === "package" ? '{"type":"module"}' : mutation === "lock" ? '{}' : 'export default 2;')});`;
    writeFileSync(join(dir, "pocket.host.config.ts"), `
      import fs from 'node:fs';
      import choice from './choice';
      export default { host: ${JSON.stringify(join(root, "hosts/psp/pocket.host.json"))}, build: {
        hosts: [${JSON.stringify(`${process.platform}-${process.arch}`)}],
        steps: [{kind:'compilerOnly'}], artifact: '{outdir}/native.bin',
        run(ctx) { if(choice !== 1) throw Error('unexpected original choice'); ${change} fs.writeFileSync(ctx.outdir + '/native.bin', 'native'); }
      } };
    `);
    const selected = await resolveProfile({ from: dir, requireConfig: true });
    const out = join(dir, "out");
    if (mutation === "native-output") {
      const result = await buildRuntime(selected, out);
      expect(JSON.parse(readFileSync(result.receipt!, "utf8")).success).toBe(true);
    } else {
      await expect(buildRuntime(selected, out)).rejects.toThrow("runtime build inputs changed");
      expect(JSON.parse(readFileSync(join(out, "build-receipt.json"), "utf8")).success).toBe(false);
    }
  }
});
