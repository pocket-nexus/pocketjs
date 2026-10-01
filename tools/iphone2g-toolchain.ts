import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import manifestJson from "./cli/iphone2g-toolchain.json";

export interface IPhone2GArtifact {
  readonly asset: string;
  readonly url: string;
  readonly sha256: string;
}

export interface IPhone2GToolchainManifest {
  readonly schemaVersion: 1;
  readonly toolchainVersion: string;
  readonly cachePath: string;
  readonly device: {
    readonly productType: "iPhone1,1";
    readonly productVersion: "3.1.3";
    readonly buildVersion: "7E18";
    readonly usbVendorId: string;
    readonly normalModeProductId: string;
  };
  readonly deployment: {
    readonly rootMount: "/";
    readonly dataMount: "/private/var";
    readonly mountPolicy: "read-write";
    readonly devicePort: 22;
    readonly localPort: 2222;
    readonly bootstrapUser: "root";
  };
  readonly compiler: {
    readonly target: "armv6-apple-darwin8";
    readonly minimumVersion: "1.1.4";
    readonly linker: "ld-classic";
    readonly sysrootFiles: Readonly<Record<string, string>>;
    readonly csu: {
      readonly repository: string;
      readonly tag: string;
      readonly revision: string;
      readonly startSha256: string;
      readonly dyldGlueSha256: string;
    };
    readonly rustToolchain: "nightly-2026-07-02";
    readonly quickJsRepository: string;
    readonly quickJsRevision: string;
    readonly quickJsVersion: string;
  };
  readonly firmware: IPhone2GArtifact & {
    readonly sha1: string;
    readonly rootFilesystem: {
      readonly asset: string;
      readonly key: string;
      readonly rawAsset: string;
      readonly rawSha256: string;
    };
  };
  readonly transport: {
    readonly usbmuxd: {
      readonly repository: string;
      readonly revision: string;
    };
    readonly libimobiledevice: {
      readonly repository: string;
      readonly revision: string;
    };
    readonly hostOpenSsl: IPhone2GArtifact & { readonly version: string };
  };
  readonly ramdisk: {
    readonly repository: string;
    readonly revision: string;
    readonly buildId: string;
    readonly artifacts: Readonly<Record<string, string>>;
  };
  readonly bootstrap: {
    readonly files: Readonly<Record<string, string>>;
    readonly openssh: IPhone2GArtifact;
    readonly openssl: IPhone2GArtifact;
  };
}

export const IPHONE2G_TOOLCHAIN = manifestJson as IPhone2GToolchainManifest;

export function iphone2gCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.POCKETJS_IPHONE2G_ROOT?.trim())
    return resolve(env.POCKETJS_IPHONE2G_ROOT.trim());
  const pocketNexus = env.POCKET_NEXUS_CACHE_DIR?.trim()
    ? resolve(env.POCKET_NEXUS_CACHE_DIR.trim())
    : join(
        env.XDG_CACHE_HOME?.trim()
          ? resolve(env.XDG_CACHE_HOME.trim())
          : join(env.HOME || homedir(), ".cache"),
        "pocket-nexus",
      );
  return join(pocketNexus, IPHONE2G_TOOLCHAIN.cachePath);
}

export function iphone2gFirmwarePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    iphone2gCacheRoot(env),
    "downloads",
    IPHONE2G_TOOLCHAIN.firmware.asset,
  );
}

export function iphone2gRootFilesystemPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    iphone2gCacheRoot(env),
    "sysroot-1.1.4",
    IPHONE2G_TOOLCHAIN.firmware.rootFilesystem.rawAsset,
  );
}

export function iphone2gSysrootPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.POCKETJS_IPHONE2G_SYSROOT?.trim();
  return explicit
    ? resolve(explicit)
    : join(iphone2gCacheRoot(env), "sysroot-1.1.4", "rootfs");
}

export function iphone2gCsuPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.POCKETJS_IPHONE2G_CSU?.trim();
  return explicit
    ? resolve(explicit)
    : join(iphone2gCacheRoot(env), "sources", "Csu-76");
}

export function iphone2gQuickJsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.POCKETJS_IPHONE2G_QUICKJS?.trim();
  return explicit
    ? resolve(explicit)
    : join(
        iphone2gCacheRoot(env),
        "sources",
        `quickjs-rs-${IPHONE2G_TOOLCHAIN.compiler.quickJsRevision}`,
      );
}

export function iphone2gLegacyKitPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.POCKETJS_IPHONE2G_LEGACY_KIT?.trim();
  return explicit
    ? resolve(explicit)
    : join(
        iphone2gCacheRoot(env),
        "sources",
        `Legacy-iOS-Kit-${IPHONE2G_TOOLCHAIN.ramdisk.revision}`,
      );
}

export function iphone2gRamdiskPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    iphone2gLegacyKitPath(env),
    "saved",
    IPHONE2G_TOOLCHAIN.device.productType,
    `ramdisk_${IPHONE2G_TOOLCHAIN.ramdisk.buildId}`,
    "saved",
  );
}

export function iphone2gBootstrapPath(
  artifact: IPhone2GArtifact,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(iphone2gCacheRoot(env), "downloads", "bootstrap", artifact.asset);
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

export function artifactMatches(path: string, sha256: string): boolean {
  return existsSync(path) && sha256File(path) === sha256;
}

function checkoutMatches(path: string, revision: string): boolean {
  if (!existsSync(join(path, ".git/HEAD"))) return false;
  const head = spawnSync("git", ["-C", path, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  const tracked = spawnSync(
    "git",
    ["-C", path, "status", "--porcelain=v1", "--untracked-files=no"],
    { encoding: "utf8" },
  );
  return (
    head.status === 0 &&
    head.stdout.trim() === revision &&
    tracked.status === 0 &&
    tracked.stdout.trim() === ""
  );
}

export interface IPhone2GToolchainStatus {
  readonly cacheRoot: string;
  readonly firmware: boolean;
  readonly rootFilesystem: boolean;
  readonly sysroot: boolean;
  readonly csu: boolean;
  readonly quickjs: boolean;
  readonly legacyKit: boolean;
  readonly ramdisk: boolean;
  readonly openssh: boolean;
  readonly openssl: boolean;
}

/** Check pinned local artifacts without probing or changing a connected phone. */
export function inspectIPhone2GToolchain(
  env: NodeJS.ProcessEnv = process.env,
): IPhone2GToolchainStatus {
  const rootfs = iphone2gRootFilesystemPath(env);
  const sysroot = iphone2gSysrootPath(env);
  const csu = iphone2gCsuPath(env);
  const quickjs = iphone2gQuickJsPath(env);
  const quickjsSource = join(quickjs, "libquickjs-sys/embed/quickjs");
  const legacyKit = iphone2gLegacyKitPath(env);
  const ramdisk = iphone2gRamdiskPath(env);
  return {
    cacheRoot: iphone2gCacheRoot(env),
    firmware: artifactMatches(
      iphone2gFirmwarePath(env),
      IPHONE2G_TOOLCHAIN.firmware.sha256,
    ),
    rootFilesystem: artifactMatches(
      rootfs,
      IPHONE2G_TOOLCHAIN.firmware.rootFilesystem.rawSha256,
    ),
    sysroot: Object.entries(IPHONE2G_TOOLCHAIN.compiler.sysrootFiles).every(
      ([relative, sha256]) => artifactMatches(join(sysroot, relative), sha256),
    ),
    csu:
      artifactMatches(
        join(csu, "start.s"),
        IPHONE2G_TOOLCHAIN.compiler.csu.startSha256,
      ) &&
      artifactMatches(
        join(csu, "dyld_glue.s"),
        IPHONE2G_TOOLCHAIN.compiler.csu.dyldGlueSha256,
      ),
    quickjs:
      existsSync(join(quickjsSource, "quickjs.c")) &&
      existsSync(join(quickjsSource, "quickjs.h")) &&
      existsSync(join(quickjsSource, "libunicode.c")) &&
      checkoutMatches(quickjs, IPHONE2G_TOOLCHAIN.compiler.quickJsRevision),
    legacyKit:
      existsSync(join(legacyKit, "restore.sh")) &&
      checkoutMatches(legacyKit, IPHONE2G_TOOLCHAIN.ramdisk.revision),
    ramdisk: Object.entries(IPHONE2G_TOOLCHAIN.ramdisk.artifacts).every(
      ([asset, sha256]) => artifactMatches(join(ramdisk, asset), sha256),
    ),
    openssh: artifactMatches(
      iphone2gBootstrapPath(IPHONE2G_TOOLCHAIN.bootstrap.openssh, env),
      IPHONE2G_TOOLCHAIN.bootstrap.openssh.sha256,
    ),
    openssl: artifactMatches(
      iphone2gBootstrapPath(IPHONE2G_TOOLCHAIN.bootstrap.openssl, env),
      IPHONE2G_TOOLCHAIN.bootstrap.openssl.sha256,
    ),
  };
}
