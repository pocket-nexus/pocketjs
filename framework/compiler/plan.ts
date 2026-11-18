// The build plan: the compiler's input. `tools/build.ts --plan` compiles one
// application for one host from it. framework/compiler/app-plan.ts resolves
// the `app` section of a host config into a plan; another product may write
// plans with its own resolver. A plan carries its own checksum (`planHash`)
// and the host contract it was resolved against (`profile`, `profileHash`),
// and may carry fields this repository does not read.
import type { HostExtension } from "./host-extension.ts";
import { createHash } from "node:crypto";
import type { AnimationClass } from "../../contracts/spec/animation.ts";
import type { AnimationTheme } from "../../contracts/spec/animation-theme.ts";
import type { PocketFramework } from "../../contracts/spec/app-config.ts";
import type { Modality } from "../../contracts/spec/modality.ts";
import type { PresentationMode, Viewport } from "../../contracts/spec/platforms.ts";
import type { CompiledProfile, PocketProfile } from "../../contracts/spec/profile.ts";
import type { WorkerDeclaration } from "../../contracts/spec/worker.ts";
import { hashPocketProfile, validatePocketProfile } from "../src/profile.ts";

/** The profile the package was compiled against and the package rate. */
export type PlanProfile = CompiledProfile & {
  /** Core ticks per virtual second the package is compiled at. */
  readonly tickHz: number;
};

/** The host contract a plan records, without the package rate. */
export function planProfileDocument(profile: PlanProfile): PocketProfile {
  const { tickHz: _tickHz, ...document } = profile;
  return document;
}

export interface ResolvedBuildPlanContent {
  /** The profile the package was compiled against and the package rate
   *  devices run it at (`profile.tickHz`). */
  readonly profile: PlanProfile;
  /** Provenance: the hash of the projection. Devices prefer variants with
   *  their own hash; admission compares facts. */
  readonly profileHash: string;
  /** Package identity travels with the plan: native hosts derive their
   *  platform package id and version from here, never from a second copy. */
  readonly app: {
    readonly id: string;
    readonly title: string;
    readonly version: string;
    /** The mounted module, relative to the project root. */
    readonly entry: string;
    readonly output: string;
    readonly framework: PocketFramework;
    /** Animation content baked into the style table. */
    readonly theme?: AnimationTheme;
    readonly aot?: boolean;
    readonly model?: "rust" | "compiled";
    readonly recursionLimit?: number;
  };
  /** The worker domain the package ships, when the application declares one. */
  readonly domains?: {
    readonly worker: WorkerDeclaration;
  };
  /** The presentation this build compiles: `app.entry` above is its entry.
   *  A plan resolved from a host config names it "default". */
  readonly presentation: {
    readonly id: string;
    readonly entry: string;
  };
  readonly target: {
    readonly id: string;
    readonly hostAbi: number;
  };
  readonly viewport: {
    readonly logical: Viewport;
    readonly physical: Viewport;
    readonly presentation: PresentationMode;
    /** Target-owned raster samples per logical pixel; layout stays logical. */
    readonly rasterDensity: number;
    /** Which viewport variant the target resolved: hosts derive
     *  size-locking from the plan. */
    readonly policy: "fixed" | "dynamic";
  };
  /** Additional resolved UI outputs. Omitted when the application did not
   * declare display.auxiliary or its enhancement was unavailable. */
  readonly surfaces?: {
    readonly auxiliary: {
      readonly logical: Viewport;
      readonly physical: Viewport;
      readonly presentation: PresentationMode;
      readonly rasterDensity: number;
    };
  };
  /** The target's interaction structure, derived from its profile
   *  (contracts/spec/modality.ts). Consumers read it from the plan, never
   *  from a second copy of the registry. */
  readonly modality: Modality;
  /** What a changed frame costs the target, derived from its profile
   *  (contracts/spec/animation.ts). */
  readonly animation: AnimationClass;
  /** Each feature the application turns on: true when the target provides
   *  it. */
  readonly features: Readonly<Record<string, boolean>>;
  /** Companion service names (app.companions): the exact svcOpen strings
   *  the app's adapters speak. Hosts build their svc allowlist from this
   *  list (issue #295). */
  readonly companions: readonly string[];
  /** Versioned, content-verified adapter payload. */
  readonly hostExtension?: HostExtension;
}

export interface ResolvedBuildPlan extends ResolvedBuildPlanContent {
  /** Self-checksum for the serialized plan; not a runtime compatibility hash. */
  readonly planHash: string;
}

/** RFC-8785-shaped canonical JSON for this JSON-only build input. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("build plan contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) => {
      const child = record[key];
      if (child === undefined) throw new TypeError(`build plan contains undefined at ${key}`);
      return `${JSON.stringify(key)}:${canonicalJson(child)}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`build plan contains non-JSON value ${typeof value}`);
}

export function hashBuildPlanContent(content: ResolvedBuildPlanContent): string {
  return `sha256:${createHash("sha256").update(canonicalJson(content)).digest("hex")}`;
}

export function finalizeBuildPlan(content: ResolvedBuildPlanContent): ResolvedBuildPlan {
  return { ...content, planHash: hashBuildPlanContent(content) };
}

export function verifyPlanHash(plan: ResolvedBuildPlan): boolean {
  const { planHash, ...content } = plan;
  return planHash === hashBuildPlanContent(content);
}

/** A plan checksum alone cannot establish the profile it records: the
 *  document must validate and hash to `profileHash`. */
export function verifyPlanProfile(plan: ResolvedBuildPlan): boolean {
  try {
    const { tickHz } = plan.profile;
    if (!Number.isInteger(tickHz) || tickHz < 1 || tickHz > 240) return false;
    const document = planProfileDocument(plan.profile);
    if (["$schema", "hostAbi", "hostExtension"].some(key => Object.hasOwn(document, key))) return false;
    return validatePocketProfile(document, { builtin: true }).ok &&
      /^sha256:[0-9a-f]{64}$/.test(plan.profileHash) &&
      document.id === plan.target.id &&
      hashPocketProfile(document) === plan.profileHash;
  } catch {
    return false;
  }
}
