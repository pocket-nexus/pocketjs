// The repack entry a Pocket Studio Worker imports: one row per Studio device
// target, each a function from bytes to bytes with the facts the Studio
// needs to store and serve its result. No file system, no network, no
// Node or Bun API in this module or anything it imports
// (tests/repack-worker.test.ts bundles it for the browser and checks).
//
//   // Pocket Studio holds PocketJS as the submodule vendor/pocketjs.
//   import { REPACK_TARGETS } from "../vendor/pocketjs/tools/repack/index.ts";
//   const target = REPACK_TARGETS.android;
//   const apk = await target.repack({ runtime, pocket, identity, signer });
//
// `runtime` is the files of `bun tools/runtime.ts <target.runtime>`'s output
// directory by relative path, runtime.json included; `pocket` holds a
// variant for one of `target.variantTargets`, the one the runtime's
// runtime.json names. Android alone takes `signer`.

import { ANDROID_RUNTIME_TARGETS, repackAndroid } from "./android.ts";
import { THREE_DS_RUNTIME_TARGET, repack3ds } from "./3ds.ts";
import { IPOD_RUNTIME_TARGET, repackIPod } from "./ipod.ts";
import { PSP_RUNTIME_TARGET, repackPsp } from "./psp.ts";
import type { RepackInput } from "./shared/runtime.ts";
import { VITA_RUNTIME_TARGET, repackVita } from "./vita.ts";

export type { ApkSigner } from "./shared/apk-sign.ts";
export type { RepackIdentity, RepackInput, RuntimeManifest } from "./shared/runtime.ts";
export { POCKET_STUDIO_COMMUNITY_SIGNER, androidPackageName } from "./android.ts";

/** The device targets of Pocket Studio, as its catalog names them. */
export type StudioTarget = "psp" | "vita" | "3ds" | "ipod-touch" | "android";

export interface RepackTarget {
  /** A game's package from a runtime directory and the game's `.pocket`. */
  readonly repack: (input: RepackInput) => Promise<Uint8Array>;
  /** `bun tools/runtime.ts <runtime>`: the runtime's name and its directory's name. */
  readonly runtime: "psp" | "vita" | "3ds" | "ipod" | "android";
  /** The `.pocket` targets this target's runtimes boot; the runtime's runtime.json names the one it was built for. */
  readonly variantTargets: readonly string[];
  /** The package file's extension, dot included. */
  readonly extension: ".zip" | ".vpk" | ".3dsx" | ".ipa" | ".apk";
  /** The Content-Type a download of the package is served with. */
  readonly contentType: string;
  /** Whether `input.signer` is required. */
  readonly signed: boolean;
}

export const REPACK_TARGETS: Readonly<Record<StudioTarget, RepackTarget>> = {
  psp: {
    repack: repackPsp,
    runtime: "psp",
    variantTargets: [PSP_RUNTIME_TARGET],
    extension: ".zip",
    contentType: "application/zip",
    signed: false,
  },
  vita: {
    repack: repackVita,
    runtime: "vita",
    variantTargets: [VITA_RUNTIME_TARGET],
    extension: ".vpk",
    contentType: "application/octet-stream",
    signed: false,
  },
  "3ds": {
    repack: repack3ds,
    runtime: "3ds",
    variantTargets: [THREE_DS_RUNTIME_TARGET],
    extension: ".3dsx",
    contentType: "application/octet-stream",
    signed: false,
  },
  "ipod-touch": {
    repack: repackIPod,
    runtime: "ipod",
    variantTargets: [IPOD_RUNTIME_TARGET],
    extension: ".ipa",
    contentType: "application/octet-stream",
    signed: false,
  },
  android: {
    repack: (input) => repackAndroid(input),
    runtime: "android",
    variantTargets: [...ANDROID_RUNTIME_TARGETS],
    extension: ".apk",
    contentType: "application/vnd.android.package-archive",
    signed: true,
  },
};

/** A row by Studio target or by runtime name (`ipod` is `ipod-touch`); undefined for anything else. */
export function repackTarget(name: string): RepackTarget | undefined {
  if (Object.hasOwn(REPACK_TARGETS, name)) return REPACK_TARGETS[name as StudioTarget];
  return Object.values(REPACK_TARGETS).find((target) => target.runtime === name);
}
