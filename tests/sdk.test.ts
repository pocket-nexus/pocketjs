import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { encodeIdentity, encodePocketPackage, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { canonicalProfileJson, type PocketProfile } from "../contracts/spec/profile.ts";
import { profileFactsC } from "../tools/profile-export.ts";
import { compilerRtMembers, exportSdk, parseSdkExport, verifySdk } from "../tools/sdk.ts";

const root = resolve(import.meta.dir, "..");
const runDir = join(root, ".pocket-build/validation/sdk", `${Date.now()}-${process.pid}`);
mkdirSync(runDir, { recursive: true });
test("SDK arguments preserve fixed archive policy and permit cross compiler configuration", () => {
  const options = parseSdkExport(["--triple=riscv32imafc-unknown-none-elf", "--out=sdk", "--toolchain=1.93.0", "--cargo=/toolchain/cargo", "--cargo-arg=-Zbuild-std=core,alloc", "--cargo-arg=--offline", "--rustflag=-Ctarget-feature=+m", "--prepare=esp32p4", "--archiver=llvm-ar"], runDir);
  expect(options.cargoArgs).toEqual(["-Zbuild-std=core,alloc", "--offline"]);
  expect(options.out).toBe(join(runDir, "sdk"));
  expect(options.toolchain).toBe("1.93.0");
  for (const extra of ["--features=legacy-ui", "--all-features", "--package=other", "--profile=dev"]) {
    expect(() => parseSdkExport(["--triple=host", "--out=sdk", `--cargo-arg=${extra}`])).toThrow("package/features/profile are fixed");
  }
  expect(() => parseSdkExport(["--triple=host", "--out=sdk", "--prepare=esp32p4", "--archiver=ar"])).toThrow("requires riscv32");
  expect(() => parseSdkExport(["--triple=host", "--out=sdk", "--cargo-arg=--config=/tmp/profile.toml"])).toThrow("inline key=value");
  expect(() => parseSdkExport(["--triple=host", "--out=sdk", "--out=other"])).toThrow("duplicate");
  expect(() => parseSdkExport(["--triple=host", "--out=sdk", '--rustflag=--cfg=feature="std"'])).toThrow("features cannot");
});
test("ESP32-P4 preparation removes only the anchored compiler-rt C group", () => {
  expect(compilerRtMembers(["aa-int_util.o", "aa-addsf3.o", "aa-popcountsi2.o", "bb-addsf3.o", "compiler_builtins.12.rcgu.o"])).toEqual(["aa-int_util.o", "aa-addsf3.o", "aa-popcountsi2.o"]);
  expect(compilerRtMembers(["aa-addsf3.o", "compiler_builtins.12.rcgu.o"])).toEqual([]);
  expect(() => compilerRtMembers(["/123"])).toThrow("GNU long names");
});
function run(args: string[], cwd: string): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString() + result.stderr.toString();
  writeFileSync(join(runDir, `${Date.now()}-${args[0]!.split("/").at(-1)}.log`), output);
  expect(result.success, `${args.join(" ")} (exit ${result.exitCode}, signal ${result.signalCode ?? "none"})\n${output.slice(-8000)}`).toBe(true);
  return result.stdout.toString();
}
test.skipIf(!Bun.which("cmake") || !Bun.which("cc"))("exported SDK relocates and builds a C consumer without checkout paths or Rust at consumption", async () => {
  const triple = /^host: (.+)$/m.exec(run(["rustup", "run", "stable", "rustc", "-Vv"], root))![1]!;
  const options = parseSdkExport(["--triple", triple, "--out", join(runDir, "sdk")]);
  const manifest = await exportSdk(options);
  expect(manifest.status).toBe("candidate");
  expect(manifest.abiFrozen).toBe(false);
  expect(manifest.hostAbi).toBe(POCKET_BINDING_GENERATION);
  expect(manifest.source.revision).toMatch(/^[0-9a-f]{40}$/);
  expect(manifest.build).toMatchObject({ defaultFeatures: false, features: [], profile: "release" });
  expect(manifest.build.rustflags.slice(-2)).toEqual(["-C", "panic=abort"]);
  const sysroot = run(["rustup", "run", "stable", "rustc", "--print", "sysroot"], root).trim();
  const llvmNm = [join(sysroot, "lib/rustlib", triple, "bin/llvm-nm"), Bun.which("llvm-nm"), "/opt/homebrew/opt/llvm/bin/llvm-nm"].find(path => path && existsSync(path));
  const symbolCommand = llvmNm ? [llvmNm] : ["nm", ...(process.platform === "darwin" ? ["--no-llvm-bc"] : [])];
  const symbols = new Set(run([...symbolCommand, "-g", join(options.out, manifest.build.archive)], root).split("\n").flatMap(line => {
    const match = /^[0-9a-fA-F]+\s+[TDBR]\s+_?(\w+)$/.exec(line.trim());
    return match ? [match[1]!] : [];
  }));
  for (const symbol of ["pocket_runtime_create", "pocket_runtime_tick", "pocket_runtime_destroy", "pocket_raster_draw_op", "pocket_draw_list_visit"]) expect(symbols.has(symbol), symbol).toBe(true);
  expect([...symbols].filter(symbol => /^(ui_|pocketjs_native_|pocketjs_idf_|pocket_legacy_runtime_)/.test(symbol))).toEqual([]);
  await expect(exportSdk(options)).rejects.toThrow("already exists");
  const metadata = JSON.parse(run(["cargo", "+stable", "metadata", "--locked", "--format-version=1", "--manifest-path", "Cargo.toml"], root));
  const quickjs = metadata.packages.find((pkg: { name: string }) => pkg.name === "rquickjs-sys").manifest_path.replace(/Cargo.toml$/, "quickjs");
  const external = mkdtempSync(join(tmpdir(), "pocket-sdk-consumer-"));
  try {
    const sdk = join(external, "copied-sdk");
    cpSync(options.out, sdk, { recursive: true });
    // The original export is unavailable while CMake configures and builds.
    renameSync(options.out, `${options.out}-hidden`);
    cpSync(join(root, "tests/fixtures/sdk"), join(external, "program"), { recursive: true });
    cpSync(quickjs, join(external, "program/quickjs"), { recursive: true });
    const fixtureProfile: PocketProfile = { format: "pocket-profile/2", id: "fixture", platform: "test", form: "takeover", cadences: [60], display: { logicalViewports: [[4, 4]], presentations: ["native"], rasterDensity: 1, animation: "repaint" }, panel: { primary: [4, 4] }, capabilities: [] };
    const profile = canonicalProfileJson(fixtureProfile);
    const bytes = (source: string) => new TextEncoder().encode(source);
    const pkg = encodePocketPackage({ manifest: bytes("{}"), variants: [{ target: "fixture", hostAbi: POCKET_BINDING_GENERATION, profileHash: `sha256:${createHash("sha256").update(profile).digest("hex")}`, sections: [
      { kind: POCKET_SECTION.identity, bytes: encodeIdentity({ output: "sdk", id: "test.sdk", title: "SDK consumer" }) },
      { kind: POCKET_SECTION.plan, bytes: bytes('{"animation":"repaint","profile":{"tickHz":60},"viewport":{"logical":[4,4],"presentation":"native","rasterDensity":1},"features":{}}') },
      { kind: POCKET_SECTION.js, bytes: bytes("globalThis.frameCount=0;globalThis.frame=()=>{globalThis.frameCount++;ui.createNode(1)};\0") },
    ] }] });
    writeFileSync(join(external, "program/profile.h"), profileFactsC(fixtureProfile, "profile_facts") + `static const unsigned char profile_hash[32] = {${[...createHash("sha256").update(profile).digest()].join(",")}};\nstatic const unsigned char package_bytes[] = {${[...pkg].join(",")}};\n`);
    run(["cmake", "-S", "program", "-B", "build", "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON", `-DCMAKE_PREFIX_PATH=${sdk}`], external);
    run(["cmake", "--build", "build", "--parallel", "4"], external);
    expect(readFileSync(join(external, "build/compile_commands.json"), "utf8")).not.toContain(root);
    expect(readFileSync(join(external, "build/CMakeFiles/consumer.dir/link.txt"), "utf8")).not.toContain(root);
    expect(run([join(external, "build/consumer")], external)).toContain("one Rust archive, C guest, six hooks, zero leaks");
    expect(run([join(external, "build/driver-kit")], external)).toContain("source/input negative controls passed");
    verifySdk(sdk);
    const manifestPath = join(sdk, "sdk-manifest.json");
    const originalManifest = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, hostAbi: POCKET_BINDING_GENERATION - 1 }));
    expect(() => verifySdk(sdk)).toThrow("binding generation differs");
    writeFileSync(manifestPath, originalManifest);
    writeFileSync(join(sdk, "unlisted.txt"), "unexpected");
    expect(() => verifySdk(sdk)).toThrow("file list differs");
  } finally { rmSync(external, { recursive: true, force: true }); }
}, 240_000);
