import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { IOS6_TOOLCHAIN, ios6CacheRoot, ios6CsuPath, ios6DyldPath, ios6QuickJsPath, ios6SysrootPath, ios6SharedCachePath, ios6SharedCacheLinkIdentity, inspectIOS6Toolchain, sha256File } from "./build/toolchains/ios6.ts";
const REPOSITORY = resolve(import.meta.dir, "..");
interface CommandResult { exitCode: number; stdout: string; stderr: string }
function run(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Uint8Array } = {},
): CommandResult {
  const result = Bun.spawnSync({
    cmd: [executable, ...args],
    cwd: options.cwd ?? REPOSITORY,
    env: options.env ?? process.env,
    stdin: options.input,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.success ? 0 : result.exitCode || 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function mustRun(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Uint8Array } = {},
): string {
  const result = run(executable, args, options);
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(
      `pocket ios6: ${executable} ${args.join(" ")} failed (${result.exitCode})${
        detail ? `:\n${detail}` : ""
      }`,
    );
  }
  return result.stdout.trim();
}

function ensureCheckout(path: string, repository: string, revision: string, tag?: string): void {
  if (!existsSync(join(path, ".git/HEAD"))) {
    mkdirSync(dirname(path), { recursive: true });
    mustRun("git", ["clone", "--filter=blob:none", "--no-checkout", repository, path]);
    mustRun("git", ["-C", path, "checkout", "--detach", tag ?? revision]);
  }
  const head = mustRun("git", ["-C", path, "rev-parse", "HEAD"]);
  if (head !== revision) throw new Error(`pocket ios6: source at ${path} is ${head}, expected ${revision}`);
}

export function setupSources(): void {
  const compiler = IOS6_TOOLCHAIN.compiler;
  ensureCheckout(ios6CsuPath(), compiler.csu.repository, compiler.csu.revision, compiler.csu.tag);
  ensureCheckout(ios6QuickJsPath(), compiler.quickJsRepository, compiler.quickJsRevision);
  ensureCheckout(
    ios6DyldPath(),
    IOS6_TOOLCHAIN.dyld.repository,
    IOS6_TOOLCHAIN.dyld.revision,
    IOS6_TOOLCHAIN.dyld.tag,
  );
  const status = inspectIOS6Toolchain();
  if (!status.csu || !status.quickjs || !status.dyld) throw new Error("pocket ios6: downloaded source verification failed");
  console.log(`sources ready in ${ios6CacheRoot()}/sources`);
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function thinExtractedMachO(root: string): void {
  for (const path of walkFiles(root)) {
    const info = run("lipo", ["-info", path]);
    if (info.exitCode !== 0 || !info.stdout.startsWith("Architectures in the fat file:")) continue;
    if (!info.stdout.includes("armv7")) continue;
    const temporary = `${path}.pocketjs-thin`;
    mustRun("lipo", [path, "-thin", "armv7", "-output", temporary]);
    renameSync(temporary, path);
  }
}

function exportedSymbols(paths: readonly string[]): string[] {
  const symbols = new Set<string>();
  for (const path of paths) {
    const output = mustRun("xcrun", ["nm-classic", "-gU", path]);
    for (const line of output.split("\n")) {
      const match = line.match(/\s[ASTDBIWV]\s(\S+)$/);
      if (match) symbols.add(match[1]);
    }
  }
  return [...symbols].sort();
}

function writeTextStub(output: string, installName: string, sources: readonly string[]): void {
  const symbols = exportedSymbols(sources);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, [
    "--- !tapi-tbd",
    "tbd-version: 4",
    "targets: [ armv7-ios ]",
    `install-name: ${JSON.stringify(installName)}`,
    "exports:",
    "  - targets: [ armv7-ios ]",
    `    symbols: [ ${symbols.map((symbol) => JSON.stringify(symbol)).join(", ")} ]`,
    "...",
    "",
  ].join("\n"));
}

function createLinkerStubs(root: string): void {
  for (const name of ["UIKit", "Foundation", "CoreGraphics", "OpenGLES"]) {
    const binary = join(root, `System/Library/Frameworks/${name}.framework/${name}`);
    writeTextStub(`${binary}.tbd`, `/System/Library/Frameworks/${name}.framework/${name}`, [binary]);
  }
  const systemDirectory = join(root, "usr/lib/system");
  const systemLibraries = readdirSync(systemDirectory)
    .filter((name) => name.endsWith(".dylib"))
    .map((name) => join(systemDirectory, name));
  writeTextStub(join(root, "usr/lib/libSystem.tbd"), "/usr/lib/libSystem.B.dylib", [
    join(root, "usr/lib/libSystem.B.dylib"),
    ...systemLibraries,
  ]);
  writeTextStub(join(root, "usr/lib/libobjc.tbd"), "/usr/lib/libobjc.A.dylib", [join(root, "usr/lib/libobjc.A.dylib")]);
  writeTextStub(join(root, "usr/lib/libgcc_s.1.tbd"), "/usr/lib/libgcc_s.1.dylib", [join(root, "usr/lib/libgcc_s.1.dylib")]);
}

export function prepareSysroot(sharedCache = process.env.POCKETJS_IOS6_SHARED_CACHE?.trim() || ios6SharedCachePath()): void {
  setupSources();
  if (inspectIOS6Toolchain().sysroot) {
    console.log(`validated sysroot already present at ${ios6SysrootPath()}`);
    return;
  }
  const cache = resolve(sharedCache);
  if (!existsSync(cache)) {
    throw new Error("pocket ios6: run `bun ipodtouch4 prepare-sysroot --device` or set POCKETJS_IOS6_SHARED_CACHE to the pinned iPod touch 4 cache");
  }
  if (ios6SharedCacheLinkIdentity(cache) !== IOS6_TOOLCHAIN.firmware.sharedCacheLinkIdentitySha256) {
    throw new Error("pocket ios6: shared cache link identity does not match iPod4,1 iOS 6.1.6 (10B500)");
  }
  const transaction = randomBytes(8).toString("hex");
  const staging = join(ios6CacheRoot(), `sysroot-stage-${transaction}`);
  const buildDirectory = join(ios6CacheRoot(), `build/dsc-extractor-${transaction}`);
  mkdirSync(staging, { recursive: true });
  mkdirSync(buildDirectory, { recursive: true });
  try {
    const dyldSource = ios6DyldPath();
    const extractorSource = join(buildDirectory, "dsc_extractor.cpp");
    let extractor = readFileSync(join(dyldSource, "launch-cache/dsc_extractor.cpp"), "utf8");
    extractor = extractor.replace("const char* afterSlash", "char* afterSlash").replace("const char* slash;", "char* slash;");
    if (extractor.includes("const char* afterSlash") || extractor.includes("const char* slash;")) {
      throw new Error("pocket ios6: pinned dyld extractor compatibility patch did not apply");
    }
    writeFileSync(extractorSource, extractor);
    const main = join(buildDirectory, "main.cpp");
    writeFileSync(main, `#include <stdio.h>\nextern \"C\" int dyld_shared_cache_extract_dylibs_progress(const char *, const char *, void (^)(unsigned, unsigned));\nint main(int argc, const char **argv) { if (argc != 3) return 64; return dyld_shared_cache_extract_dylibs_progress(argv[1], argv[2], ^(unsigned current, unsigned total) { if (current == total || current % 100 == 0) fprintf(stderr, \"%u/%u\\n\", current, total); }); }\n`);
    const extractorBinary = join(buildDirectory, "dsc-extractor");
    mustRun("xcrun", ["clang++", "-O2", "-std=gnu++11", "-fblocks", "-Wno-deprecated-declarations",
      "-I", join(dyldSource, "include"), "-I", join(dyldSource, "launch-cache"), extractorSource,
      join(dyldSource, "launch-cache/dsc_iterator.cpp"), main, "-o", extractorBinary]);
    const extracted = join(buildDirectory, "extracted");
    mkdirSync(extracted);
    mustRun(extractorBinary, [cache, extracted]);
    thinExtractedMachO(extracted);
    createLinkerStubs(extracted);
    for (const [relative, expected] of Object.entries(IOS6_TOOLCHAIN.compiler.sysrootFiles)) {
      const path = join(extracted, relative);
      if (!existsSync(path) || sha256File(path) !== expected) throw new Error(`pocket ios6: extracted sysroot mismatch for ${relative}`);
      const output = join(staging, relative);
      mkdirSync(dirname(output), { recursive: true });
      cpSync(path, output);
    }
    const destination = ios6SysrootPath();
    const backup = `${destination}.backup-${transaction}`;
    if (existsSync(destination)) renameSync(destination, backup);
    try {
      renameSync(staging, destination);
      if (!inspectIOS6Toolchain().sysroot) throw new Error("pocket ios6: installed sysroot failed verification");
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
      if (existsSync(backup)) renameSync(backup, destination);
      throw error;
    }
    console.log(`prepared validated ARMv7 sysroot at ${destination}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(buildDirectory, { recursive: true, force: true });
  }
}
