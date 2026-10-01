import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import manifestJson from "./cli/iphone4s-toolchain.json";

export interface IPhone4SToolchainManifest {
  readonly schemaVersion: 1;
  readonly toolchainVersion: string;
  readonly cachePath: string;
  readonly device: {
    readonly productType: "iPhone4,1";
    readonly hardwareModel: "N94AP";
    readonly productVersion: "6.1.3";
    readonly buildVersion: "10B329";
  };
  readonly deployment: {
    readonly devicePort: 22;
    readonly localPort: 22442;
    readonly bootstrapUser: "root";
  };
  readonly compiler: {
    readonly target: "armv7-apple-ios";
    readonly minimumVersion: "6.0";
    readonly linker: "ld-classic";
    readonly rustToolchain: "nightly-2026-07-02";
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
    readonly asset: string;
    readonly sha1: string;
    readonly rootFilesystemAsset: string;
    readonly sharedCachePath: string;
    readonly sharedCacheSha256: string;
  };
  readonly dyld: {
    readonly repository: string;
    readonly tag: string;
    readonly revision: string;
  };
}

export const IPHONE4S_TOOLCHAIN = manifestJson as IPhone4SToolchainManifest;

export function iphone4sCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.POCKETJS_IPHONE4S_ROOT?.trim()) return resolve(env.POCKETJS_IPHONE4S_ROOT.trim());
  const base = env.POCKET_NEXUS_CACHE_DIR?.trim()
    ? resolve(env.POCKET_NEXUS_CACHE_DIR.trim())
    : join(env.XDG_CACHE_HOME?.trim() ? resolve(env.XDG_CACHE_HOME.trim()) : join(env.HOME || homedir(), ".cache"), "pocket-nexus");
  return join(base, IPHONE4S_TOOLCHAIN.cachePath);
}

export function iphone4sSysrootPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.POCKETJS_IPHONE4S_SYSROOT?.trim()
    ? resolve(env.POCKETJS_IPHONE4S_SYSROOT.trim())
    : join(iphone4sCacheRoot(env), "sysroot-6.1.3");
}

export function iphone4sCsuPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(iphone4sCacheRoot(env), "sources", `Csu-${IPHONE4S_TOOLCHAIN.compiler.csu.revision}`);
}

export function iphone4sQuickJsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(iphone4sCacheRoot(env), "sources", `quickjs-rs-${IPHONE4S_TOOLCHAIN.compiler.quickJsRevision}`);
}

export function iphone4sDyldPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(iphone4sCacheRoot(env), "sources", `dyld-${IPHONE4S_TOOLCHAIN.dyld.revision}`);
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

function checkoutMatches(path: string, revision: string): boolean {
  if (!existsSync(join(path, ".git/HEAD"))) return false;
  const head = spawnSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" });
  const tracked = spawnSync("git", ["-C", path, "status", "--porcelain=v1", "--untracked-files=no"], { encoding: "utf8" });
  return head.status === 0 && head.stdout.trim() === revision && tracked.status === 0 && tracked.stdout.trim() === "";
}

export function inspectIPhone4SToolchain(env: NodeJS.ProcessEnv = process.env) {
  const sysroot = iphone4sSysrootPath(env);
  const files = Object.entries(IPHONE4S_TOOLCHAIN.compiler.sysrootFiles);
  const binariesReady = files.every(([relative, hash]) => {
    const path = join(sysroot, relative);
    return existsSync(path) && sha256File(path) === hash;
  });
  const stubsReady = [
    "usr/lib/libSystem.tbd",
    "usr/lib/libobjc.tbd",
    "usr/lib/libgcc_s.1.tbd",
    "System/Library/Frameworks/UIKit.framework/UIKit.tbd",
    "System/Library/Frameworks/Foundation.framework/Foundation.tbd",
    "System/Library/Frameworks/CoreGraphics.framework/CoreGraphics.tbd",
    "System/Library/Frameworks/OpenGLES.framework/OpenGLES.tbd",
  ].every((relative) => existsSync(join(sysroot, relative)));
  const csu = iphone4sCsuPath(env);
  const quickjs = iphone4sQuickJsPath(env);
  return {
    cacheRoot: iphone4sCacheRoot(env),
    sysroot: binariesReady && stubsReady,
    csu:
      checkoutMatches(csu, IPHONE4S_TOOLCHAIN.compiler.csu.revision) &&
      existsSync(join(csu, "start.s")) &&
      sha256File(join(csu, "start.s")) === IPHONE4S_TOOLCHAIN.compiler.csu.startSha256 &&
      existsSync(join(csu, "dyld_glue.s")) &&
      sha256File(join(csu, "dyld_glue.s")) === IPHONE4S_TOOLCHAIN.compiler.csu.dyldGlueSha256,
    quickjs:
      checkoutMatches(quickjs, IPHONE4S_TOOLCHAIN.compiler.quickJsRevision) &&
      existsSync(join(quickjs, "libquickjs-sys/embed/quickjs/VERSION")) &&
      readFileSync(join(quickjs, "libquickjs-sys/embed/quickjs/VERSION"), "utf8").trim() ===
        IPHONE4S_TOOLCHAIN.compiler.quickJsVersion,
    dyld: checkoutMatches(iphone4sDyldPath(env), IPHONE4S_TOOLCHAIN.dyld.revision),
  };
}
