import { BUILD_STD_NIGHTLY } from "../../../tools/build/toolchains/rust.ts";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import manifestJson from "./ios6/manifest.json";

export interface IOS6ToolchainManifest {
  readonly schemaVersion: 1;
  readonly toolchainVersion: string;
  readonly cachePath: string;
  readonly compiler: {
    readonly target: "armv7-apple-ios";
    readonly minimumVersion: "6.0";
    readonly linker: "ld-classic";
    readonly rustToolchain: string;
    readonly sysrootFiles: Readonly<Record<string, string>>;
    readonly csu: {
      readonly repository: string;
      readonly tag: string;
      readonly revision: string;
      readonly startSha256: string;
      readonly dyldGlueSha256: string;
    };
    readonly quickJsRepository: string;
    readonly quickJsRevision: string;
    readonly quickJsVersion: string;
  };
  readonly firmware: {
    readonly sourceDevice: { readonly productType: string; readonly hardwareModel: string; readonly productVersion: string; readonly buildVersion: string };
    readonly sharedCachePath: string;
    readonly sharedCacheLinkIdentitySha256: string;
  };
  readonly dyld: {
    readonly repository: string;
    readonly tag: string;
    readonly revision: string;
  };
}

export const IOS6_TOOLCHAIN = { ...manifestJson, compiler: { ...manifestJson.compiler, rustToolchain: BUILD_STD_NIGHTLY } } as IOS6ToolchainManifest;

export function ios6CacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.POCKETJS_IOS6_ROOT?.trim()) return resolve(env.POCKETJS_IOS6_ROOT.trim());
  const base = env.POCKET_NEXUS_CACHE_DIR?.trim()
    ? resolve(env.POCKET_NEXUS_CACHE_DIR.trim())
    : join(env.XDG_CACHE_HOME?.trim() ? resolve(env.XDG_CACHE_HOME.trim()) : join(env.HOME || homedir(), ".cache"), "pocket-nexus");
  return join(base, IOS6_TOOLCHAIN.cachePath);
}

export function ios6SysrootPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.POCKETJS_IOS6_SYSROOT?.trim()
    ? resolve(env.POCKETJS_IOS6_SYSROOT.trim())
    : join(ios6CacheRoot(env), `sysroot-${IOS6_TOOLCHAIN.firmware.sourceDevice.productVersion}-tapi`);
}

export function ios6SharedCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ios6CacheRoot(env), "sysroot-source", "dyld_shared_cache_armv7");
}

export function ios6CsuPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ios6CacheRoot(env), "sources", `Csu-${IOS6_TOOLCHAIN.compiler.csu.revision}`);
}

export function ios6QuickJsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ios6CacheRoot(env), "sources", `quickjs-rs-${IOS6_TOOLCHAIN.compiler.quickJsRevision}`);
}

export function ios6DyldPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ios6CacheRoot(env), "sources", `dyld-${IOS6_TOOLCHAIN.dyld.revision}`);
}

export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const length = readSync(descriptor, buffer, 0, buffer.length, null);
      if (length === 0) break;
      hash.update(buffer.subarray(0, length));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

/** Hash cache metadata, code and link-edit bytes with writable mappings zeroed.
 * A running iOS device can expose slid pointers and live data in those mappings.
 * They do not supply the exported symbol names used by the TAPI sysroot. */
export function ios6SharedCacheLinkIdentity(path: string): string {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes.subarray(0, 16).toString("ascii") !== "dyld_v1   armv7\0") {
    throw new Error("pocket ios6: expected an ARMv7 dyld v1 shared cache");
  }
  const offset = bytes.readUInt32LE(16), count = bytes.readUInt32LE(20);
  const end = offset + count * 32;
  if (count !== 3 || offset < 24 || end > bytes.length) throw new Error("pocket ios6: invalid cache mapping table");
  const writable: { start: number; end: number }[] = [];
  for (let index = 0; index < count; index++) {
    const entry = offset + index * 32;
    const size = Number(bytes.readBigUInt64LE(entry + 8));
    const start = Number(bytes.readBigUInt64LE(entry + 16));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || size <= 0 || start + size > bytes.length) {
      throw new Error("pocket ios6: invalid cache mapping range");
    }
    if (bytes.readUInt32LE(entry + 28) & 2) {
      if (start < end) throw new Error("pocket ios6: writable mapping overlaps cache metadata");
      writable.push({ start, end: start + size });
    }
  }
  if (writable.length !== 1) throw new Error("pocket ios6: expected one writable cache mapping");
  for (const range of writable) bytes.fill(0, range.start, range.end);
  return createHash("sha256").update(bytes).digest("hex");
}

function checkoutMatches(path: string, revision: string): boolean {
  if (!existsSync(join(path, ".git/HEAD"))) return false;
  const head = spawnSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" });
  const tracked = spawnSync("git", ["-C", path, "status", "--porcelain=v1", "--untracked-files=no"], { encoding: "utf8" });
  return head.status === 0 && head.stdout.trim() === revision && tracked.status === 0 && tracked.stdout.trim() === "";
}

export function inspectIOS6Toolchain(env: NodeJS.ProcessEnv = process.env) {
  const sysroot = ios6SysrootPath(env);
  const files = Object.entries(IOS6_TOOLCHAIN.compiler.sysrootFiles);
  const binariesReady = files.every(([relative, hash]) => {
    const path = join(sysroot, relative);
    return existsSync(path) && sha256File(path) === hash;
  });
  const csu = ios6CsuPath(env);
  const quickjs = ios6QuickJsPath(env);
  return {
    cacheRoot: ios6CacheRoot(env),
    sysroot: binariesReady,
    csu:
      checkoutMatches(csu, IOS6_TOOLCHAIN.compiler.csu.revision) &&
      existsSync(join(csu, "start.s")) &&
      sha256File(join(csu, "start.s")) === IOS6_TOOLCHAIN.compiler.csu.startSha256 &&
      existsSync(join(csu, "dyld_glue.s")) &&
      sha256File(join(csu, "dyld_glue.s")) === IOS6_TOOLCHAIN.compiler.csu.dyldGlueSha256,
    quickjs:
      checkoutMatches(quickjs, IOS6_TOOLCHAIN.compiler.quickJsRevision) &&
      existsSync(join(quickjs, "libquickjs-sys/embed/quickjs/VERSION")) &&
      readFileSync(join(quickjs, "libquickjs-sys/embed/quickjs/VERSION"), "utf8").trim() ===
        IOS6_TOOLCHAIN.compiler.quickJsVersion,
    dyld: checkoutMatches(ios6DyldPath(env), IOS6_TOOLCHAIN.dyld.revision),
  };
}
