// The inputs every `tools/repack/<target>.ts` takes, and the checks they all
// make before writing a device package: the runtime directory is complete and
// is the one its runtime.json describes, and the bundle is intact, its plan is
// admitted by the runtime's host contract (contracts/spec/admission.ts), and
// its app id is the identity's.
//
// Bytes in, bytes out: no file system and no network, so a Cloudflare Worker
// can run the same code.

import {
  BUNDLE_SECTION,
  decodeBundle,
  decodeIdentity,
  findSection,
  type Bundle,
  type BundleIdentity,
} from "../../../contracts/spec/bundle.ts";
import { canonicalProfileJson, pocketProfileSchema, POCKET_PROFILE_FILE, POCKET_PROFILE_FORMAT, type PocketProfile } from "../../../contracts/spec/profile.ts";
import { admissionHost, admitBundle, describeRejection } from "../../../contracts/spec/admission.ts";
import { validateSchema, type ContractDiagnostic } from "../../../contracts/spec/json-schema.ts";
import { POCKET_BINDING_GENERATION } from "../../../contracts/spec/binding-generation.ts";

export interface RepackIdentity {
  /** Reverse-DNS application id; must equal the bundle's app id. */
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
  /** The compiled application bundle (`.pkb`). */
  readonly bundle: Uint8Array;
  readonly identity: RepackIdentity;
}

/** dist/runtime/<target>/runtime.json */
export interface RuntimeManifest {
  readonly target: string;
  readonly hostAbi: number;
  /** PocketJS commit the runtime was built from ("-dirty" when the tree had changes). */
  readonly pocketjs: string;
  /** The id of the profile the runtime was built for; its document ships
   *  beside it as pocket.host.json. */
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
/** A checked runtime directory and the host contract it ships. */
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
    throw new Error(`repack: the runtime's ${POCKET_PROFILE_FILE} is not the host contract ${RUNTIME_MANIFEST} names`);
  }
  return { ...manifest, document };
}

export interface AdmittedBundle {
  /** The bundle to ship: the input bytes. */
  readonly bytes: Uint8Array;
  readonly bundle: Bundle;
  readonly identity: BundleIdentity;
  /** The bundle's ResolvedBuildPlan. */
  readonly plan: Record<string, unknown>;
}

/**
 * Check the bundle's hashes, admit its plan against the runtime's profile
 * document, and refuse a bundle without identity, plan or JavaScript, a plan
 * that does not record its own profile, or an app id other than the
 * identity's.
 */
export async function admitRepackBundle(
  bytes: Uint8Array,
  runtime: RuntimeDirectory,
  identity: RepackIdentity,
): Promise<AdmittedBundle> {
  requireCurrentRuntime(runtime);
  let bundle: Bundle;
  try {
    bundle = decodeBundle(bytes);
  } catch (error) {
    throw new Error(`repack: the bundle is damaged: ${error instanceof Error ? error.message : String(error)}`);
  }
  const admission = admitBundle(bundle, admissionHost(runtime.document, runtime.profileHash, runtime.hostAbi));
  if (!admission.ok) {
    throw new Error(`repack: this ${runtime.target} runtime does not admit the bundle: ${describeRejection(admission)}`);
  }
  const identitySection = findSection(bundle, BUNDLE_SECTION.identity);
  const planSection = findSection(bundle, BUNDLE_SECTION.plan);
  const javascript = findSection(bundle, BUNDLE_SECTION.js);
  if (!identitySection || !planSection || !javascript || javascript.length === 0) {
    throw new Error("repack: the bundle lacks its identity, plan or JavaScript");
  }
  if (javascript[javascript.length - 1] !== 0) throw new Error("repack: application JavaScript must be NUL-terminated");
  const bundleIdentity = decodeIdentity(identitySection);
  if (bundleIdentity.id !== identity.id) {
    throw new Error(
      `repack: the bundle is app ${JSON.stringify(bundleIdentity.id)}; the identity says ${JSON.stringify(identity.id)}`,
    );
  }
  let plan: Record<string, unknown>;
  try {
    plan = JSON.parse(new TextDecoder().decode(planSection)) as Record<string, unknown>;
  } catch {
    throw new Error("repack: the bundle's plan is not JSON");
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
  if (typeof target?.id !== "string" || target.hostAbi !== bundle.hostAbi || profile.id !== target.id ||
      profileHash !== bundle.profileHash || plan.profileHash !== bundle.profileHash) {
    throw new Error("repack: the bundle's plan has an invalid profile identity");
  }
  return { bytes, bundle, identity: bundleIdentity, plan };
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
