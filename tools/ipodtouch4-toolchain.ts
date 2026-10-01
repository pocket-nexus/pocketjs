import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  IPHONE4S_TOOLCHAIN,
  inspectIPhone4SToolchain,
  iphone4sCsuPath,
  iphone4sDyldPath,
  iphone4sQuickJsPath,
  iphone4sSysrootPath,
} from "./iphone4s-toolchain.ts";

/*
 * The iPod touch 4 (iPod4,1, iOS 6.1.6 / 10B500) builds against the SAME
 * validated ARMv7 sysroot as the iPhone 4S. The sysroot only supplies
 * link-time TAPI stubs and Mach-O libraries extracted from the 6.1.3 shared
 * cache; iOS 6.1.6 is the 6.1.3 SDK surface plus a TLS fix, so every linked
 * install name resolves identically on the device. Sharing the sysroot,
 * Csu bootstrap, pinned QuickJS, and pinned dyld extractor means this target
 * adds no new firmware provenance: `bun iphone4s setup-sources` and
 * `bun iphone4s prepare-sysroot` are the single preparation path.
 *
 * Only the transport material (SSH key + pinned host key) is device-local,
 * because it identifies this physical iPod touch, not the toolchain.
 */

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

export const IPODTOUCH4_TOOLCHAIN = IPHONE4S_TOOLCHAIN;

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

export const ipodtouch4SysrootPath = iphone4sSysrootPath;
export const ipodtouch4CsuPath = iphone4sCsuPath;
export const ipodtouch4QuickJsPath = iphone4sQuickJsPath;
export const ipodtouch4DyldPath = iphone4sDyldPath;
export const inspectIPodTouch4Toolchain = inspectIPhone4SToolchain;
