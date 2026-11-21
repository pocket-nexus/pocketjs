import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  IOS6_TOOLCHAIN,
  inspectIOS6Toolchain,
  ios6CsuPath,
  ios6DyldPath,
  ios6QuickJsPath,
  ios6SysrootPath,
} from "./ios6.ts";

/* The iPod touch 4 uses the pinned ARMv7 iOS 6 sysroot, Csu bootstrap,
 * QuickJS and dyld extractor. SSH transport keys belong to the device. */

export const IPODTOUCH4_DEVICE = {
  productType: "iPod4,1",
  hardwareModel: "N81AP",
  productVersion: "6.1.6",
  buildVersion: "10B500",
} as const;

export const IPODTOUCH4_DEPLOYMENT = {
  devicePort: 22,
  localPort: 2224,
} as const;

export const IPODTOUCH4_TOOLCHAIN = IOS6_TOOLCHAIN;

export function ipodtouch4CacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.POCKETJS_IPODTOUCH4_ROOT?.trim()) return resolve(env.POCKETJS_IPODTOUCH4_ROOT.trim());
  const base = env.POCKET_NEXUS_CACHE_DIR?.trim()
    ? resolve(env.POCKET_NEXUS_CACHE_DIR.trim())
    : join(
        env.XDG_CACHE_HOME?.trim() ? resolve(env.XDG_CACHE_HOME.trim()) : join(env.HOME || homedir(), ".cache"),
        "pocket-nexus",
      );
  return join(base, "ipodtouch4");
}

export const ipodtouch4SysrootPath = ios6SysrootPath;
export const ipodtouch4CsuPath = ios6CsuPath;
export const ipodtouch4QuickJsPath = ios6QuickJsPath;
export const ipodtouch4DyldPath = ios6DyldPath;
export const inspectIPodTouch4Toolchain = inspectIOS6Toolchain;
