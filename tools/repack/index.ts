// The repack entry a Pocket Studio Worker imports: one row per Studio device
// target, each a function from bytes to bytes with the facts the Studio
// needs to store and serve its result. No file system, no network, no
// Node or Bun API in this module or anything it imports
// (tests/repack-worker.test.ts bundles it for the browser and checks).
//
//   // Pocket Studio holds PocketJS as the submodule vendor/pocketjs.
//   import { REPACK_TARGETS } from "../vendor/pocketjs/tools/repack/index.ts";
//   const target = REPACK_TARGETS.psp;
//   const archive = await target.repack({ runtime, bundle, identity });
//
// `runtime` is the files of `bun tools/runtime.ts <target.runtime>`'s output
// directory by relative path, runtime.json included; `bundle` is a compiled
// application the runtime's host contract admits. `target.runtimeTargets`
// lists the host contracts the target's runtimes are built for.

import { IPOD_RUNTIME_TARGET, repackIPod } from "./ipod.ts";
import { THREE_DS_RUNTIME_TARGET, repack3ds } from "./3ds.ts";
import { PSP_RUNTIME_TARGET, repackPsp } from "./psp.ts";
import type { RepackInput } from "./shared/runtime.ts";
import { VITA_RUNTIME_TARGET, repackVita } from "./vita.ts";

export type { RepackIdentity, RepackInput, RuntimeManifest } from "./shared/runtime.ts";

/** The device targets of Pocket Studio, as its catalog names them. */
export type StudioTarget = "psp" | "vita" | "3ds" | "ipod-touch";

export interface RepackTarget {
  /** A game's device package from a runtime directory and the game's bundle. */
  readonly repack: (input: RepackInput) => Promise<Uint8Array>;
  /** `bun tools/runtime.ts <runtime>`: the runtime's name and its directory's name. */
  readonly runtime: "psp" | "vita" | "3ds" | "ipod";
  /** The host contracts this target's runtimes are built for; the runtime's runtime.json names its own. */
  /** Empty means the runtime manifest supplies an external profile identity. */
  readonly runtimeTargets: readonly string[];
  /** The package file's extension, dot included. */
  readonly extension: ".zip" | ".vpk" | ".3dsx" | ".ipa";
  /** The Content-Type a download of the package is served with. */
  readonly contentType: string;
}

export const REPACK_TARGETS: Readonly<Record<StudioTarget, RepackTarget>> = {
  psp: {
    repack: repackPsp,
    runtime: "psp",
    runtimeTargets: [PSP_RUNTIME_TARGET],
    extension: ".zip",
    contentType: "application/zip",
  },
  vita: {
    repack: repackVita,
    runtime: "vita",
    runtimeTargets: [VITA_RUNTIME_TARGET],
    extension: ".vpk",
    contentType: "application/octet-stream",
  },
  "3ds": {
    repack: repack3ds,
    runtime: "3ds",
    runtimeTargets: [THREE_DS_RUNTIME_TARGET],
    extension: ".3dsx",
    contentType: "application/octet-stream",
  },
  "ipod-touch": {
    repack: repackIPod, runtime: "ipod", runtimeTargets: [IPOD_RUNTIME_TARGET],
    extension: ".ipa", contentType: "application/octet-stream",
  },
};

/** A row by Studio target or by runtime name; undefined for anything else. */
export function repackTarget(name: string): RepackTarget | undefined {
  if (Object.hasOwn(REPACK_TARGETS, name)) return REPACK_TARGETS[name as StudioTarget];
  return Object.values(REPACK_TARGETS).find((target) => target.runtime === name);
}
