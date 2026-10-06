// What every repack step takes and checks first (tools/repack/<target>.ts):
// a generic runtime as bytes, a `.pocket` holding the game, and the identity
// the package goes by. The checks here run before any target-specific work:
// the runtime matches its runtime.json, the `.pocket` footer holds, and the
// `.pocket` has a variant for the runtime's target at the runtime's host ABI.

import {
  POCKET_SECTION,
  decodePocketPackage,
  findSection,
  type PocketPackageVariant,
} from "../../../contracts/spec/pocket-package.ts";

export interface RepackIdentity {
  /** Reverse-DNS app id; each target derives its own package name from it. */
  readonly id: string;
  readonly title: string;
  readonly author: string;
  /** `major.minor.patch`. */
  readonly version: string;
  /** A square PNG, any size; the repack scales and converts it. */
  readonly icon?: Uint8Array;
}

export interface RepackInput {
  /** The runtime directory's files by relative path, `runtime.json` among them. */
  readonly runtime: Map<string, Uint8Array>;
  /** A `.pocket` holding this target's variant. */
  readonly pocket: Uint8Array;
  readonly identity: RepackIdentity;
}

export interface RuntimeFile {
  readonly bytes: number;
  readonly sha256: string;
}

/** `runtime.json`, the description a runtime build writes beside its files. */
export interface RuntimeManifest {
  /** The `.pocket` variant target this runtime boots. */
  readonly target: string;
  readonly hostAbi: number;
  /** The PocketJS commit the runtime was built from. */
  readonly pocketjs: string;
  readonly profile: unknown;
  readonly files: Readonly<Record<string, RuntimeFile>>;
}

/** The game half of a repack: the variant's bundle, pack and plan. */
export interface GameVariant {
  readonly variant: PocketPackageVariant;
  /** The bundle without the `.pocket` js section's NUL terminator. */
  readonly js: Uint8Array;
  readonly pak: Uint8Array;
  /** The ResolvedBuildPlan the variant was built from, parsed. */
  readonly plan: {
    readonly target: { readonly id: string; readonly hostAbi: number };
    readonly app: { readonly id: string; readonly title: string; readonly version?: string; readonly output: string };
    readonly viewport: { readonly logical: readonly number[]; readonly rasterDensity: number };
  };
  /** The manifest the `.pocket` carries, verbatim. */
  readonly manifest: Uint8Array;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Parses `runtime.json` and checks every file it lists is in the map with the
 * size and SHA-256 it records. Refuses a runtime built for another target
 * when `expectedTarget` is given.
 */
export async function readRuntime(runtime: Map<string, Uint8Array>, expectedTarget?: (target: string) => boolean): Promise<RuntimeManifest> {
  const text = runtime.get("runtime.json");
  if (!text) throw new Error("repack: the runtime has no runtime.json");
  let manifest: RuntimeManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(text)) as RuntimeManifest;
  } catch {
    throw new Error("repack: runtime.json is not JSON");
  }
  if (typeof manifest.target !== "string" || !Number.isInteger(manifest.hostAbi) || typeof manifest.files !== "object") {
    throw new Error("repack: runtime.json lacks target, hostAbi or files");
  }
  if (expectedTarget && !expectedTarget(manifest.target)) {
    throw new Error(`repack: the runtime is built for ${manifest.target}, not for this repack`);
  }
  for (const [path, file] of Object.entries(manifest.files)) {
    const bytes = runtime.get(path);
    if (!bytes) throw new Error(`repack: the runtime lacks ${path}, which runtime.json lists`);
    if (bytes.length !== file.bytes || (await sha256Hex(bytes)) !== file.sha256) {
      throw new Error(`repack: the runtime's ${path} differs from runtime.json`);
    }
  }
  return manifest;
}

/**
 * The `.pocket`'s variant for the runtime: refuses a broken footer, a
 * `.pocket` without a variant for `runtime.target`, a variant at another host
 * ABI, and a variant whose plan names another target or ABI.
 */
export function gameVariant(pocket: Uint8Array, runtime: RuntimeManifest): GameVariant {
  let decoded;
  try {
    decoded = decodePocketPackage(pocket);
  } catch (error) {
    throw new Error(`repack: the .pocket does not read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const variant = decoded.variants.find((v) => v.target === runtime.target);
  if (!variant) {
    const held = decoded.variants.map((v) => v.target).join(", ") || "none";
    throw new Error(`repack: the .pocket has no ${runtime.target} variant (it holds ${held})`);
  }
  if (variant.hostAbi !== runtime.hostAbi) {
    throw new Error(`repack: the .pocket's ${variant.target} variant is for host ABI ${variant.hostAbi}, and the runtime is host ABI ${runtime.hostAbi}`);
  }
  const js = findSection(variant, POCKET_SECTION.js);
  const pak = findSection(variant, POCKET_SECTION.pak);
  const planBytes = findSection(variant, POCKET_SECTION.plan);
  if (!js || !pak || !planBytes) throw new Error(`repack: the ${variant.target} variant lacks its js, pak or plan section`);
  if (js.length === 0 || js[js.length - 1] !== 0) throw new Error(`repack: the ${variant.target} js section is not NUL-terminated`);
  let plan: GameVariant["plan"];
  try {
    plan = JSON.parse(new TextDecoder().decode(planBytes)) as GameVariant["plan"];
  } catch {
    throw new Error(`repack: the ${variant.target} plan section is not JSON`);
  }
  if (plan?.target?.id !== variant.target || plan.target.hostAbi !== variant.hostAbi) {
    throw new Error(`repack: the ${variant.target} variant's plan names ${plan?.target?.id} at host ABI ${plan?.target?.hostAbi}`);
  }
  return { variant, js: js.subarray(0, js.length - 1), pak, plan, manifest: decoded.manifest };
}
