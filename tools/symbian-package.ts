import { createHash } from "node:crypto";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";

const DEVELOPMENT_UID = /^0xE[0-9A-F]{7}$/i;
const SAFE_OUTPUT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SAFE_EXECUTABLE = /^[A-Za-z][A-Za-z0-9]{0,30}$/;
const DEFAULT_DATA_BASE = 0x400000;
const DATA_BASE_ALIGNMENT = 0x100000;
const MAX_DATA_BASE = 0x10000000;

export interface SymbianPackageIdentity {
  readonly appId: string;
  readonly appOutput: string;
  readonly title: string;
  readonly uid: string;
  readonly executable: string;
  readonly sisFile: string;
  readonly receiptFile: string;
}

/**
 * GCCE's stock Qt mkspec puts writable data at 0x400000. Large qrc payloads
 * (DeepZoom tiles or a multi-app catalog) can extend read-only data past that
 * address, so reserve the raw embedded byte count on top of the historical
 * 4 MiB baseline and round to a 1 MiB boundary. The linker remains the final
 * overlap check; the upper bound rejects artifacts too large for this E7 host.
 */
export function symbianDataBaseForEmbeddedBytes(
  embeddedBytes: number,
): string {
  if (
    !Number.isSafeInteger(embeddedBytes) ||
    embeddedBytes < 0
  ) {
    throw new Error("Symbian embedded byte count must be a non-negative safe integer");
  }
  const dataBase = Math.ceil(
    (DEFAULT_DATA_BASE + embeddedBytes) / DATA_BASE_ALIGNMENT,
  ) * DATA_BASE_ALIGNMENT;
  if (dataBase > MAX_DATA_BASE) {
    throw new Error(
      `Symbian embedded payload requires data base 0x${dataBase.toString(16)}, above the E7 limit`,
    );
  }
  return `0x${dataBase.toString(16)}`;
}

/**
 * Stable private-range UID3 for local development packages.
 *
 * Symbian's 0xE0000000..0xEFFFFFFF range is intentionally unprotected. The
 * reverse-DNS Pocket id is the durable input so independent checkouts build
 * upgrade-compatible packages without adding private Symbian fields to
 * pocket.json.
 */
export function symbianUidForAppId(appId: string): string {
  const digest = createHash("sha256").update(appId, "utf8").digest("hex");
  return `0xE${digest.slice(0, 7).toUpperCase()}`;
}

export function validateSymbianDevelopmentUid(uid: string): string {
  if (!DEVELOPMENT_UID.test(uid)) {
    throw new Error(
      `Symbian UID3 must be in the unprotected development range 0xE0000000..0xEFFFFFFF, got ${JSON.stringify(uid)}`,
    );
  }
  return `0x${uid.slice(2).toUpperCase()}`;
}

/**
 * qmake/EKA2 target names are deliberately ASCII and at most 31 characters.
 * The UID suffix prevents two similarly truncated output names from sharing
 * sys/bin and resource paths.
 */
export function symbianExecutableName(
  appOutput: string,
  uid: string,
): string {
  const stem = appOutput
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 15) || "App";
  const executable = `PocketJs${stem}${validateSymbianDevelopmentUid(uid).slice(2)}`;
  if (!SAFE_EXECUTABLE.test(executable)) {
    throw new Error(`unsafe Symbian executable name ${JSON.stringify(executable)}`);
  }
  return executable;
}

export function symbianPackageIdentity(
  plan: ResolvedBuildPlan,
  uidOverride?: string,
): SymbianPackageIdentity {
  if (!SAFE_OUTPUT.test(plan.app.output)) {
    throw new Error(
      `unsafe Symbian app output name ${JSON.stringify(plan.app.output)}`,
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._+&():-]{0,127}$/.test(plan.app.title)) {
    throw new Error(
      "Symbian package title must be 1..128 safe ASCII title characters",
    );
  }
  const uid = validateSymbianDevelopmentUid(
    uidOverride ?? symbianUidForAppId(plan.app.id),
  );
  return {
    appId: plan.app.id,
    appOutput: plan.app.output,
    title: plan.app.title,
    uid,
    executable: symbianExecutableName(plan.app.output, uid),
    sisFile: `${plan.app.output}.sis`,
    receiptFile: `${plan.app.output}.receipt.json`,
  };
}
