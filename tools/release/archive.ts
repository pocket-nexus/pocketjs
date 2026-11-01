import { bindingGeneration, filesUnder, verifySdk, type SdkManifest } from "./receipt.ts";
export { verifySdk } from "./receipt.ts";
export type { SdkManifest } from "./receipt.ts";
import { STABLE_RUST_TOOLCHAIN } from "../build/toolchains/rust.ts";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
export interface SdkOptions {
  triple: string; out: string; cargo: string; rustc?: string; toolchain: string;
  cargoArgs: string[]; rustflags: string[]; prepare?: "esp32p4"; archiver?: string;
}
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const roots = ["spec", "drivers", "core", "raster", "present", "package", "modules/media", "runtime", "runtime-cabi", "render/draw-ops", "render/glyph-pages", "render/tri-batch", "render/tex-cache"];

function sourceHash(root: string): string {
  const inputs = ["LICENSE", "Cargo.toml", "Cargo.lock", "engine/Cargo.toml", "engine/Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml", "engine/.cargo/config.toml", "contracts/generated", "contracts/spec/binding-generation.ts", "engine/guest-quickjs/src", "engine/guest-quickjs/include", "engine/driver-kit/c", "tools/sdk.ts", "tools/release", "tools/packaging/cmake", ...roots.flatMap(name => [`engine/${name}/Cargo.toml`, `engine/${name}/src`])];
  const digest = createHash("sha256");
  for (const file of inputs.flatMap(path => filesUnder(join(root, path))).sort()) {
    digest.update(relative(root, file).split(sep).join("/")); digest.update("\0"); digest.update(readFileSync(file)); digest.update("\0");
  }
  return digest.digest("hex");
}
function run(command: string[], cwd: string, env = process.env): string {
  const result = Bun.spawnSync(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(`${command.join(" ")} failed (exit ${result.exitCode}, signal ${result.signalCode ?? "none"}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout.toString();
}
function git(root: string, args: string[]): string | null {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  return result.success ? result.stdout.toString().trim() : null;
}
export function parseSdkExport(args: string[], cwd = process.cwd()): SdkOptions {
  const result: SdkOptions = { triple: "", out: "", cargo: "cargo", toolchain: STABLE_RUST_TOOLCHAIN, cargoArgs: [], rustflags: [] };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(args[index]!);
    if (!match) throw new Error(`unexpected SDK argument: ${args[index]}`);
    const name = match[1]!;
    if (!["triple", "out", "cargo", "rustc", "toolchain", "cargo-arg", "rustflag", "prepare", "archiver"].includes(name)) throw new Error(`unknown SDK option --${name}`);
    const value = match[2] ?? args[++index];
    if (!value || (match[2] === undefined && value.startsWith("--") && name !== "cargo-arg")) throw new Error(`--${name} requires a value`);
    if (name !== "cargo-arg" && name !== "rustflag" && seen.has(name)) throw new Error(`duplicate SDK option --${name}`);
    seen.add(name);
    if (name === "cargo-arg") {
      // Build selection stays fixed. Tier-3 build-std and offline/configuration
      // flags are accepted without permitting another package or feature set.
      if (!/^(?:-Z[^\s]+|--offline|--frozen|--config=.+)$/.test(value)) throw new Error("--cargo-arg accepts -Z..., --offline, --frozen or --config=...; package/features/profile are fixed");
      if (value.startsWith("--config=") && !/^--config=[A-Za-z0-9_.-]+=.+$/.test(value))
        throw new Error("SDK --config accepts inline key=value only; configuration files are not part of the SDK inputs");
      result.cargoArgs.push(value);
    } else if (name === "rustflag") result.rustflags.push(value);
    else if (name === "prepare") {
      if (value !== "esp32p4") throw new Error("--prepare only supports esp32p4");
      result.prepare = value;
    } else Object.assign(result, { [name]: value });
  }
  if (!result.triple || !result.out) throw new Error("SDK export requires --triple and --out");
  if (result.triple.endsWith(".json")) result.triple = resolve(cwd, result.triple);
  else if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(result.triple)) throw new Error("invalid Rust target triple");
  result.out = resolve(cwd, result.out);
  for (const key of ["cargo", "rustc", "archiver"] as const) {
    const value = result[key];
    if (value?.includes("/") || value?.includes("\\")) result[key] = resolve(cwd, value);
  }
  if (result.rustflags.some(flag => /(?:^|[\s=])feature\s*=/.test(flag))) throw new Error("SDK Cargo features cannot be enabled through --rustflag");
  if (result.prepare && result.triple !== "riscv32imafc-unknown-none-elf") throw new Error("esp32p4 preparation requires riscv32imafc-unknown-none-elf");
  if (result.prepare && !result.archiver) throw new Error("esp32p4 preparation requires --archiver");
  return result;
}

export function compilerRtMembers(members: string[]): string[] {
  if (members.some(name => /^\/\d+$/.test(name))) throw new Error("archiver does not resolve GNU long names; use LLVM or GNU ar");
  const prefix = members.map(name => /^([0-9a-f]+)-(?:int_util|popcountsi2)\.o$/.exec(name)?.[1]).find(Boolean);
  return prefix ? members.filter(name => new RegExp(`^${prefix}-[A-Za-z0-9_]+\\.o$`).test(name)) : [];
}

/** Local candidate export; release publication and artifact downloads are separate. */
export async function exportSdk(options: SdkOptions, root = ROOT): Promise<SdkManifest> {
  if (!existsSync(join(root, "Cargo.toml")) && !existsSync(join(root, "engine/Cargo.toml")))
    throw new Error("sdk build requires a PocketJS source checkout; use sdk export to download a release");
  if (existsSync(options.out)) throw new Error(`SDK output already exists: ${options.out}; choose a new directory`);
  const targetName = options.triple.endsWith(".json") ? basename(options.triple, ".json") : options.triple;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(targetName)) throw new Error("invalid target file name");
  const targetBytes = options.triple.endsWith(".json") ? readFileSync(options.triple) : null;
  const cargo = Bun.which(options.cargo) ?? resolve(options.cargo);
  const rustc = options.rustc ?? (existsSync(join(dirname(cargo), "rustc")) ? join(dirname(cargo), "rustc") : "rustc");
  const rustflags = [...options.rustflags, "-C", "panic=abort"];
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CARGO_PROFILE_")));
  const env = { ...ambient, ...(options.toolchain === "none" ? {} : { RUSTUP_TOOLCHAIN: options.toolchain }), RUSTC: rustc, RUSTFLAGS: "", CARGO_ENCODED_RUSTFLAGS: rustflags.join("\x1f"), RUSTC_WRAPPER: "", RUSTC_WORKSPACE_WRAPPER: "" };
  const compiler = run([rustc, "-Vv"], root, env).trim();
  const cargoVersion = run([cargo, "-Vv"], root, env).trim();
  const before = sourceHash(root);
  const hostAbi = bindingGeneration(readFileSync(join(root, "contracts/generated/pocket_spec.h"), "utf8"));
  const checkout = git(root, ["rev-parse", "--show-toplevel"]);
  // A framework installed below another project's Git tree must not claim
  // that project's revision as the SDK's source identity.
  const ownCheckout = checkout !== null && realpathSync(checkout) === realpathSync(root);
  const revision = ownCheckout ? git(root, ["rev-parse", "HEAD"]) : null;
  const status = ownCheckout ? git(root, ["status", "--porcelain", "--untracked-files=normal"]) : null;
  const buildDir = join(root, ".pocket-build/validation/sdk/cargo", hash(JSON.stringify({ target: options.triple, compiler, rustflags, args: options.cargoArgs })).slice(0, 20));
  mkdirSync(buildDir, { recursive: true });
  console.error(`Pocket SDK: building candidate ${targetName} (${options.toolchain}, no_std, no legacy)`);
  const command = [cargo, "rustc", "--lib", "--crate-type", "staticlib", "--locked", "--manifest-path", join(root, existsSync(join(root, "Cargo.toml")) ? "Cargo.toml" : "engine/Cargo.toml"), "-p", "pocket-runtime-cabi", "--no-default-features", "--release", "--target", options.triple, "--target-dir", buildDir, "--message-format=json-render-diagnostics", ...options.cargoArgs, "--", "--print=native-static-libs"];
  const child = Bun.spawn(command, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  writeFileSync(join(buildDir, "sdk-build.log"), `${stdout}\n${stderr}`);
  if (code !== 0 || child.signalCode !== null) throw new Error(`SDK archive build failed (exit ${code}, signal ${child.signalCode ?? "none"}):\n${stderr}\n${stdout}`);
  let archive: string | undefined;
  let features: string[] | undefined;
  const nativeStaticLibs: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line);
    if (message.reason === "compiler-artifact" && message.target?.name === "pocket_runtime_cabi") {
      archive = message.filenames?.find((file: string) => /\.(a|lib)$/.test(file));
      features = message.features;
    }
    if (message.reason === "compiler-message") {
      const text: string = message.message?.message ?? "";
      if (text.startsWith("native-static-libs:")) nativeStaticLibs.push(...text.slice("native-static-libs:".length).trim().split(/\s+/).filter(Boolean));
    }
  }
  for (const match of stderr.matchAll(/native-static-libs:[ \t]*([^\r\n]*)/g)) {
    for (const library of match[1]!.trim().split(/\s+/).filter(Boolean)) if (!nativeStaticLibs.includes(library)) nativeStaticLibs.push(library);
  }
  if (!archive || !existsSync(archive)) throw new Error("Cargo did not report a pocket-runtime-cabi static archive");
  if (!features || features.length) throw new Error(`SDK default archive must have no enabled Cargo features: ${features?.join(", ") ?? "unknown"}`);
  mkdirSync(dirname(options.out), { recursive: true });
  const staging = join(dirname(options.out), `.${basename(options.out)}-${randomUUID()}.tmp`);
  mkdirSync(staging);
  try {
    const copy = (input: string, output: string) => { mkdirSync(dirname(join(staging, output)), { recursive: true }); copyFileSync(join(root, input), join(staging, output)); };
    for (const name of ["runtime", "drivers", "spec", "quickjs_abi"]) {
      copy(`contracts/generated/pocket_${name}.h`, `include/pocket/${name}.h`);
      // Keep one physical definition for pragma-once generated records. The
      // existing C glue and generated nested includes use prefixed names.
      writeFileSync(join(staging, `include/pocket/pocket_${name}.h`), `#pragma once\n#include "${name}.h"\n`);
    }
    copy("engine/driver-kit/c/pocket_driver_kit.h", "include/pocket/pocket_driver_kit.h");
    copy("engine/driver-kit/c/pocket_driver_kit.c", "src/driver-kit/pocket_driver_kit.c");
    copy("engine/guest-quickjs/include/pocket_guest_quickjs.h", "include/pocket/pocket_guest_quickjs.h");
    for (const name of ["guest.c", "generated_ops.h"]) copy(`engine/guest-quickjs/src/${name}`, `src/guest-quickjs/${name}`);
    copy("tools/packaging/cmake/PocketConfig.cmake", "lib/cmake/Pocket/PocketConfig.cmake");
    copy("LICENSE", "LICENSE");
    const archiveName = `lib/${targetName}/${archive.endsWith(".lib") ? "pocket_runtime.lib" : "libpocket_runtime.a"}`;
    mkdirSync(dirname(join(staging, archiveName)), { recursive: true });
    copyFileSync(archive, join(staging, archiveName));
    let preparation: SdkManifest["preparation"] = null;
    if (options.prepare) {
      const path = join(staging, archiveName);
      const archiver = options.archiver!;
      const originalSha256 = hash(readFileSync(path));
      const version = run([archiver, "--version"], root).trim();
      const members = run([archiver, "t", path], root).trim().split(/\r?\n/);
      const removedMembers = compilerRtMembers(members);
      if (removedMembers.length) run([archiver, "d", path, ...removedMembers], root);
      preparation = { kind: "esp32p4", version: 1, archiver: version, originalSha256, removedMembers };
    }
    // Relative paths only: moving the exported tree must not leave checkout or
    // build-directory references in its CMake package.
    writeFileSync(join(staging, "lib/cmake/Pocket/PocketArchive.cmake"), `set(Pocket_TRIPLE "${targetName}")\nset(Pocket_ARCHIVE "${archiveName}")\nset(Pocket_NATIVE_STATIC_LIBS "${nativeStaticLibs.join(";")}")\n`);
    if (before !== sourceHash(root) || (targetBytes && !targetBytes.equals(readFileSync(options.triple)))) throw new Error("SDK sources changed while the archive was building; export again");
    const manifest: SdkManifest = { schemaVersion: 1, status: "candidate", abiFrozen: false, hostAbi, source: { revision, dirty: status === null ? null : status.length > 0, sha256: before }, build: { triple: targetName, target: options.triple.endsWith(".json") ? basename(options.triple) : options.triple, targetSha256: targetBytes ? hash(targetBytes) : null, cargo: cargoVersion, compiler, toolchain: options.toolchain, profile: "release", defaultFeatures: false, features: [], rustflags, cargoArgs: options.cargoArgs, archive: archiveName, nativeStaticLibs }, preparation, files: {} };
    for (const file of filesUnder(staging)) { const bytes = readFileSync(file); manifest.files[relative(staging, file).split(sep).join("/")] = { sha256: hash(bytes), bytes: bytes.length }; }
    writeFileSync(join(staging, "sdk-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    verifySdk(staging);
    if (existsSync(options.out)) throw new Error(`SDK output was created during export: ${options.out}`);
    renameSync(staging, options.out);
    return manifest;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
