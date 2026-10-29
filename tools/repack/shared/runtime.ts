// The inputs every `tools/repack/<target>.ts` takes, and the checks they all
// make before writing a package: the runtime directory is complete and is the
// one its runtime.json describes, and the `.pocket` holds an intact variant
// the runtime's profile document admits (contracts/spec/admission.ts) whose
// app id is the identity's.
//
// Bytes in, bytes out: no file system and no network, so a Cloudflare Worker
// can run the same code.

import {
  decodePocketPackage,
  decodeIdentity,
  encodePocketPackage,
  findSection,
  POCKET_SECTION,
  thinPocketPackage,
  type PocketPackageIdentity,
  type PocketPackageVariant,
} from "../../../contracts/spec/pocket-package.ts";
import type { ApkSigner } from "./apk-sign.ts";
import { canonicalProfileJson, pocketProfileSchema, POCKET_PROFILE_FILE, POCKET_PROFILE_FORMAT, type PocketProfile } from "../../../contracts/spec/profile.ts";
import { admissionHost, describeRejection, selectVariant } from "../../../contracts/spec/admission.ts";
import { validateSchema, type ContractDiagnostic } from "../../../framework/src/manifest/schema.ts";
import { POCKET_BINDING_GENERATION } from "../../../contracts/spec/binding-generation.ts";

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
  /** The key and certificate an Android APK is signed with: the Pocket Studio
   *  community key. The other targets take none. */
  readonly signer?: ApkSigner;
}

/** dist/runtime/<target>/runtime.json */
export interface RuntimeManifest {
  readonly target: string;
  readonly hostAbi: number;
  /** PocketJS commit the runtime was built from ("-dirty" when the tree had changes). */
  readonly pocketjs: string;
  /** The id of the profile the runtime was built for; its document ships
   *  beside it as pocket-profile.json. */
  readonly profile: string;
  /** The provenance hash of that document. */
  readonly profileHash: string;
  /** Every other file of the runtime directory: size and SHA-256 (hex). */
  readonly files: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>;
  /** Target-specific facts about the program (the iPod's build id, executable
   *  name and deployment target). */
  readonly host?: Readonly<Record<string, string>>;
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
/** A checked runtime directory and the profile document it ships. */
export interface RuntimeDirectory extends RuntimeManifest {
  readonly document: PocketProfile;
}

/** The provenance hash, computed without Node APIs. */
async function documentHash(profile: PocketProfile): Promise<string> {
  return `sha256:${await sha256Hex(new TextEncoder().encode(canonicalProfileJson(profile)))}`;
}

export async function readRuntime(
  runtime: Map<string, Uint8Array>,
  target: string,
): Promise<RuntimeDirectory> {
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
  requireCurrentRuntime(manifest);
  if (typeof manifest.profileHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(manifest.profileHash)) {
    throw new Error(`repack: ${RUNTIME_MANIFEST} has no valid profileHash; rebuild the runtime`);
  }
  if (!manifest.files || typeof manifest.files !== "object") {
    throw new Error(`repack: ${RUNTIME_MANIFEST} lists no files`);
  }
  for (const name of runtime.keys()) {
    if (name !== RUNTIME_MANIFEST && !Object.hasOwn(manifest.files, name))
      throw new Error(`repack: the runtime contains an unlisted file: ${name}`);
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (name === RUNTIME_MANIFEST || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === ".."))
      throw new Error(`repack: invalid runtime file path: ${name}`);
    const bytes = runtime.get(name);
    if (!bytes) throw new Error(`repack: the runtime is missing ${name}`);
    if (bytes.length !== expected.bytes || (await sha256Hex(bytes)) !== expected.sha256) {
      throw new Error(`repack: the runtime's ${name} is not the file ${RUNTIME_MANIFEST} describes`);
    }
  }
  const documentBytes = runtime.get(POCKET_PROFILE_FILE);
  if (!documentBytes || !Object.hasOwn(manifest.files, POCKET_PROFILE_FILE)) {
    throw new Error(`repack: the runtime ships no ${POCKET_PROFILE_FILE}; rebuild the runtime`);
  }
  let document: PocketProfile;
  try { document = JSON.parse(new TextDecoder().decode(documentBytes)) as PocketProfile; }
  catch { throw new Error(`repack: the runtime's ${POCKET_PROFILE_FILE} is not JSON`); }
  const diagnostics: ContractDiagnostic[] = [];
  validateSchema(document, pocketProfileSchema, "", diagnostics);
  if (diagnostics.length || document.format !== POCKET_PROFILE_FORMAT || document.id !== manifest.profile || document.id !== manifest.target ||
      document.hostAbi !== manifest.hostAbi || (await documentHash(document)) !== manifest.profileHash) {
    throw new Error(`repack: the runtime's ${POCKET_PROFILE_FILE} is not the profile ${RUNTIME_MANIFEST} names`);
  }
  return { ...manifest, document };
}

export interface AdmittedPocket {
  /** The package to ship: the input bytes when they hold only this target's
   *  variant, otherwise the same package thinned to it (encoded on first read). */
  readonly bytes: Uint8Array;
  readonly variant: PocketPackageVariant;
  readonly identity: PocketPackageIdentity;
  /** The variant's ResolvedBuildPlan. */
  readonly plan: Record<string, unknown>;
}

/**
 * Check the `.pocket` footer, select the variant the runtime's profile
 * document admits, and refuse a variant without identity, plan or
 * JavaScript, a plan that does not record its own profile, or an app id
 * other than the identity's.
 */
export async function admitPocket(
  pocket: Uint8Array,
  runtime: RuntimeDirectory,
  identity: RepackIdentity,
): Promise<AdmittedPocket> {
  requireCurrentRuntime(runtime);
  let decoded;
  try {
    decoded = decodePocketPackage(pocket);
  } catch (error) {
    throw new Error(`repack: the .pocket is damaged: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!decoded.variants.length) throw new Error("repack: the .pocket has no variants");
  const selection = selectVariant(decoded, admissionHost(runtime.document, runtime.profileHash, runtime.hostAbi));
  if (!selection.ok) {
    throw new Error(`repack: this ${runtime.target} runtime does not admit the .pocket: ${describeRejection(selection)}`);
  }
  const variant = selection.variant;
  const identitySection = findSection(variant, POCKET_SECTION.identity);
  const planSection = findSection(variant, POCKET_SECTION.plan);
  const javascript = findSection(variant, POCKET_SECTION.js);
  if (!identitySection || !planSection || !javascript || javascript.length === 0) {
    throw new Error(`repack: the .pocket's ${variant.target} variant lacks its identity, plan or JavaScript`);
  }
  if (javascript[javascript.length - 1] !== 0) throw new Error("repack: application JavaScript must be NUL-terminated");
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
    throw new Error(`repack: the .pocket's ${variant.target} plan is not JSON`);
  }
  // The plan records the profile it was compiled against and its hash.
  const target = plan.target as { id?: unknown; hostAbi?: unknown } | undefined;
  const { tickHz: _tickHz, ...profile } = (plan.profile ?? {}) as PocketProfile & { tickHz?: number };
  const diagnostics: ContractDiagnostic[] = [];
  validateSchema(profile, pocketProfileSchema, "/profile", diagnostics);
  let profileHash: string | undefined;
  try {
    if (!diagnostics.length) profileHash = await documentHash(profile);
  } catch { /* Invalid profile data is rejected with the identity error below. */ }
  if (target?.id !== variant.target || target.hostAbi !== variant.hostAbi || profile.id !== variant.target ||
      profileHash !== variant.profileHash || plan.profileHash !== variant.profileHash) {
    throw new Error(`repack: the .pocket's ${variant.target} plan has an invalid profile identity`);
  }
  let thinned: Uint8Array | undefined;
  return {
    get bytes() {
      thinned ??= decoded.variants.length === 1 ? pocket : encodePocketPackage(thinPocketPackage(decoded, [variant.target]));
      return thinned;
    },
    variant,
    identity: packageIdentity,
    plan,
  };
}

function requireCurrentRuntime(runtime: RuntimeManifest): void {
  if (runtime.hostAbi !== POCKET_BINDING_GENERATION) {
    throw new Error(`repack: runtime binding generation ${runtime.hostAbi} is unsupported; rebuild for ${POCKET_BINDING_GENERATION}`);
  }
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
