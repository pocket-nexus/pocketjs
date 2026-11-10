import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import manifestJson from "./cli/ipad2-toolchain.json";

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

export const IPAD2_TOOLCHAIN = manifestJson as IPhone4SToolchainManifest;

export function ipad2CacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.POCKETJS_IPAD2_ROOT?.trim()) return resolve(env.POCKETJS_IPAD2_ROOT.trim());
  const base = env.POCKET_STACK_CACHE_DIR?.trim()
    ? resolve(env.POCKET_STACK_CACHE_DIR.trim())
    : join(env.XDG_CACHE_HOME?.trim() ? resolve(env.XDG_CACHE_HOME.trim()) : join(env.HOME || homedir(), ".cache"), "pocket-stack");
  return join(base, IPAD2_TOOLCHAIN.cachePath);
}

export function ipad2SysrootPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.POCKETJS_IPAD2_SYSROOT?.trim()
    ? resolve(env.POCKETJS_IPAD2_SYSROOT.trim())
    : join(ipad2CacheRoot(env), "sysroot-6.1.3");
}

export function ipad2CsuPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ipad2CacheRoot(env), "sources", `Csu-${IPAD2_TOOLCHAIN.compiler.csu.revision}`);
}

export function ipad2QuickJsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ipad2CacheRoot(env), "sources", `quickjs-rs-${IPAD2_TOOLCHAIN.compiler.quickJsRevision}`);
}

export function ipad2DyldPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ipad2CacheRoot(env), "sources", `dyld-${IPAD2_TOOLCHAIN.dyld.revision}`);
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
  const sysroot = ipad2SysrootPath(env);
  const files = Object.entries(IPAD2_TOOLCHAIN.compiler.sysrootFiles);
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
  const csu = ipad2CsuPath(env);
  const quickjs = ipad2QuickJsPath(env);
  return {
    cacheRoot: ipad2CacheRoot(env),
    sysroot: binariesReady && stubsReady,
    csu:
      checkoutMatches(csu, IPAD2_TOOLCHAIN.compiler.csu.revision) &&
      existsSync(join(csu, "start.s")) &&
      sha256File(join(csu, "start.s")) === IPAD2_TOOLCHAIN.compiler.csu.startSha256 &&
      existsSync(join(csu, "dyld_glue.s")) &&
      sha256File(join(csu, "dyld_glue.s")) === IPAD2_TOOLCHAIN.compiler.csu.dyldGlueSha256,
    quickjs:
      checkoutMatches(quickjs, IPAD2_TOOLCHAIN.compiler.quickJsRevision) &&
      existsSync(join(quickjs, "libquickjs-sys/embed/quickjs/VERSION")) &&
      readFileSync(join(quickjs, "libquickjs-sys/embed/quickjs/VERSION"), "utf8").trim() ===
        IPAD2_TOOLCHAIN.compiler.quickJsVersion,
    dyld: checkoutMatches(ipad2DyldPath(env), IPAD2_TOOLCHAIN.dyld.revision),
  };
}
