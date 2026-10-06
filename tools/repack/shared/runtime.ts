// The inputs every `tools/repack/<target>.ts` takes, and the checks they all
// make before writing a package: the runtime directory is complete and is the
// one its runtime.json describes, and the `.pocket` holds an intact variant
// for that runtime's target and host ABI whose app id is the identity's.
//
// Bytes in, bytes out: no file system and no network, so a Cloudflare Worker
// can run the same code.

import {
  decodePocketPackage,
  decodeIdentity,
  encodePocketPackage,
  findSection,
  findVariant,
  POCKET_SECTION,
  thinPocketPackage,
  type PocketPackageIdentity,
  type PocketPackageVariant,
} from "../../../contracts/spec/pocket-package.ts";

export interface RepackIdentity {
  /** Reverse-DNS application id; must equal the `.pocket` variant's app id. */
  readonly id: string;
  readonly title: string;
  readonly author: string;
  readonly version: string;
  /** Square PNG of any size; each repack scales and converts it. */
  readonly icon?: Uint8Array;
}

export interface RepackInput {
  /** The runtime directory's files by relative path, runtime.json included. */
  readonly runtime: Map<string, Uint8Array>;
  /** A `.pocket` holding this target's variant. */
  readonly pocket: Uint8Array;
  readonly identity: RepackIdentity;
}

/** dist/runtime/<target>/runtime.json */
export interface RuntimeManifest {
  readonly target: string;
  readonly hostAbi: number;
  /** PocketJS commit the runtime was built from ("-dirty" when the tree had changes). */
  readonly pocketjs: string;
  /** The device profile the runtime was built for. */
  readonly profile: string;
  /** Every other file of the runtime directory: size and SHA-256 (hex). */
  readonly files: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>;
}

export const RUNTIME_MANIFEST = "runtime.json";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Read runtime.json, check it names `target`, and check every file it lists
 * is present with the size and SHA-256 it records.
 */
export async function readRuntime(
  runtime: Map<string, Uint8Array>,
  target: string,
): Promise<RuntimeManifest> {
  const raw = runtime.get(RUNTIME_MANIFEST);
  if (!raw) throw new Error(`repack: the runtime has no ${RUNTIME_MANIFEST}`);
  let manifest: RuntimeManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw)) as RuntimeManifest;
  } catch {
    throw new Error(`repack: ${RUNTIME_MANIFEST} is not JSON`);
  }
  if (manifest.target !== target) {
    throw new Error(`repack: this runtime is for ${JSON.stringify(manifest.target)}, not ${JSON.stringify(target)}`);
  }
  if (!Number.isInteger(manifest.hostAbi) || manifest.hostAbi < 1) {
    throw new Error(`repack: ${RUNTIME_MANIFEST} has no host ABI`);
  }
  if (!manifest.files || typeof manifest.files !== "object") {
    throw new Error(`repack: ${RUNTIME_MANIFEST} lists no files`);
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = runtime.get(name);
    if (!bytes) throw new Error(`repack: the runtime is missing ${name}`);
    if (bytes.length !== expected.bytes || (await sha256Hex(bytes)) !== expected.sha256) {
      throw new Error(`repack: the runtime's ${name} is not the file ${RUNTIME_MANIFEST} describes`);
    }
  }
  return manifest;
}

export interface AdmittedPocket {
  /** The package to ship: the input bytes when they hold only this target's
   *  variant, otherwise the same package thinned to it. */
  readonly bytes: Uint8Array;
  readonly variant: PocketPackageVariant;
  readonly identity: PocketPackageIdentity;
  /** The variant's ResolvedBuildPlan. */
  readonly plan: Record<string, unknown>;
}

/**
 * Check the `.pocket` footer, find the variant for the runtime's target, and
 * refuse a different host ABI, a variant without identity, plan or
 * JavaScript, or an app id other than the identity's.
 */
export function admitPocket(
  pocket: Uint8Array,
  runtime: RuntimeManifest,
  identity: RepackIdentity,
): AdmittedPocket {
  let decoded;
  try {
    decoded = decodePocketPackage(pocket);
  } catch (error) {
    throw new Error(`repack: the .pocket is damaged: ${error instanceof Error ? error.message : String(error)}`);
  }
  const variant = findVariant(decoded, runtime.target);
  if (!variant) {
    const targets = decoded.variants.map((entry) => entry.target).join(", ") || "none";
    throw new Error(`repack: the .pocket has no ${runtime.target} variant (it has ${targets})`);
  }
  if (variant.hostAbi !== runtime.hostAbi) {
    throw new Error(
      `repack: the .pocket's ${runtime.target} variant is for host ABI ${variant.hostAbi}; this runtime is ABI ${runtime.hostAbi}`,
    );
  }
  const identitySection = findSection(variant, POCKET_SECTION.identity);
  const planSection = findSection(variant, POCKET_SECTION.plan);
  const javascript = findSection(variant, POCKET_SECTION.js);
  if (!identitySection || !planSection || !javascript || javascript.length === 0) {
    throw new Error(`repack: the .pocket's ${runtime.target} variant lacks its identity, plan or JavaScript`);
  }
  const packageIdentity = decodeIdentity(identitySection);
  if (packageIdentity.id !== identity.id) {
    throw new Error(
      `repack: the .pocket is app ${JSON.stringify(packageIdentity.id)}; the identity says ${JSON.stringify(identity.id)}`,
    );
  }
  let plan: Record<string, unknown>;
  try {
    plan = JSON.parse(new TextDecoder().decode(planSection)) as Record<string, unknown>;
  } catch {
    throw new Error(`repack: the .pocket's ${runtime.target} plan is not JSON`);
  }
  const target = plan.target as { id?: unknown; hostAbi?: unknown } | undefined;
  if (target?.id !== runtime.target || target.hostAbi !== runtime.hostAbi) {
    throw new Error(`repack: the .pocket's ${runtime.target} plan resolves another target or ABI`);
  }
  const bytes = decoded.variants.length === 1
    ? pocket
    : encodePocketPackage(thinPocketPackage(decoded, [runtime.target]));
  return { bytes, variant, identity: packageIdentity, plan };
}

/** Identity fields every package needs, checked once for every target. */
export function checkIdentity(identity: RepackIdentity): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/.test(identity.id) || !identity.id.includes(".")) {
    throw new Error(`repack: ${JSON.stringify(identity.id)} is not a reverse-DNS application id`);
  }
  for (const field of ["title", "author", "version"] as const) {
    if (typeof identity[field] !== "string" || identity[field].trim() === "") {
      throw new Error(`repack: the identity has no ${field}`);
    }
  }
}

/** A plan's `features` table, `{}` when absent. */
export function planFeatures(plan: Record<string, unknown>): Record<string, boolean> {
  const features = plan.features;
  return features && typeof features === "object" ? (features as Record<string, boolean>) : {};
}
