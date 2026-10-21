#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_COMPONENTS, NATIVE_POLICY, RUST_TARGETS, nativeSourceDigest, sha256,
  verifyNativeCompiler, verifyNativeReceipt, type IdfTarget, type NativeReceipt } from "./esp-idf-native-receipt.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = Bun.argv.slice(2);
function take(name: string): string | undefined {
  const i = args.indexOf("--" + name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) throw new Error("--" + name + " requires a value");
  args.splice(i, 2);
  return value;
}
const target = take("target") as IdfTarget;
const component = take("component");
const cargo = resolve(take("cargo") ?? Bun.which("cargo") ?? "");
const outputRoot = resolve(take("output-root") ?? join(ROOT, "hosts/esp-idf/components"));
const archiver = take("archiver") ?? process.env.AR ?? [Bun.which("llvm-ar"), Bun.which("gcc-ar"),
  Bun.which("riscv32-esp-elf-ar"), "/opt/homebrew/opt/llvm/bin/llvm-ar", Bun.which("ar")].find(p => p && existsSync(p));
if (!(target in RUST_TARGETS) || args.length) throw new Error("usage: esp-idf-native --target <esp32p4|esp32s3> [--component ui-core] [--cargo path] [--archiver path] [--output-root components-dir]");
const specs = NATIVE_COMPONENTS.filter(spec => !component || spec.crate === component);
if (!specs.length) throw new Error("unknown native component " + component);
function run(command: string[], env?: Record<string, string | undefined>): void {
  const result = Bun.spawnSync(command, { cwd: ROOT, stdout: "inherit", stderr: "inherit", env });
  if (result.exitCode !== 0) throw new Error("command failed: " + command.join(" "));
}
const rustc = join(dirname(cargo), "rustc");
const version = Bun.spawnSync([rustc, "-Vv"], { stdout: "pipe", stderr: "pipe" });
if (version.exitCode !== 0) throw new Error("rustc beside the supplied cargo is not runnable");
const compiler = version.stdout.toString().trim();
verifyNativeCompiler(ROOT, target, compiler);
let archiveTool: NativeReceipt["archiver"] = null;
if (target === "esp32p4") {
  if (!archiver) throw new Error("archive preparation needs --archiver");
  const version = Bun.spawnSync([archiver, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (version.exitCode !== 0) throw new Error("use LLVM or GNU ar with --version support");
  archiveTool = { version: version.stdout.toString().trim(), executableSha256: sha256(readFileSync(archiver)) };
}
for (const spec of specs) {
  const sourceSha256 = await nativeSourceDigest(ROOT, spec);
  const cargoTarget = join(ROOT, "dist/esp-idf-native/cargo", spec.crate, target);
  const native = join(ROOT, "hosts/esp-idf/native", spec.crate);
  mkdirSync(cargoTarget, { recursive: true });
  run([cargo, "build", ...(target === "esp32s3" ? ["-Zbuild-std=core,alloc"] : []),
    "--release", "--locked", "--no-default-features", "--target", RUST_TARGETS[target],
    "--manifest-path", join(native, "Cargo.toml")], { ...process.env, RUSTC: rustc,
      RUSTFLAGS: "", CARGO_ENCODED_RUSTFLAGS: "", CARGO_TARGET_DIR: cargoTarget,
      RUSTC_WRAPPER: "", RUSTC_WORKSPACE_WRAPPER: "",
      PATH: dirname(cargo) + ":" + (process.env.PATH ?? "") });
  const directory = join(outputRoot, spec.component, "lib", target);
  mkdirSync(directory, { recursive: true });
  const archivePath = join(directory, spec.archive);
  await Bun.write(archivePath, readFileSync(join(cargoTarget, RUST_TARGETS[target], "release", spec.archive)));
  if (target === "esp32p4") run(["cmake", "-DPOCKETJS_ARCHIVE=" + archivePath,
    "-DPOCKETJS_ARCHIVER=" + archiver, "-DPOCKETJS_TARGET=" + target, "-P",
    join(ROOT, "hosts/esp-idf/components/pocketjs_ui_core/prepare_archive.cmake")]);
  if (sourceSha256 !== await nativeSourceDigest(ROOT, spec)) throw new Error("native sources changed while building");
  const archive = readFileSync(archivePath);
  const receipt: NativeReceipt = { schemaVersion: 2, component: spec.component, target,
    rustTarget: RUST_TARGETS[target], compiler, archiver: archiveTool,
    sourceSha256, archiveSha256: sha256(archive), archiveBytes: archive.length, policy: NATIVE_POLICY };
  await Bun.write(join(directory, "build-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  await verifyNativeReceipt(ROOT, spec, target, directory);
  console.log(spec.component + "/" + target + ": " + archive.length + " bytes, sha256 " + receipt.archiveSha256);
}
