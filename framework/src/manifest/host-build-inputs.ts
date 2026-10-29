import type { AnimationTheme } from "../../../contracts/spec/pocket-manifest.ts";
import { isHostExtension, type HostExtension } from "./host-extension.ts";
import { canonicalJson } from "./plan.ts";
import {
  PRESENTATION_MODES,
  type PresentationMode,
  type Viewport,
} from "../../../contracts/spec/platforms.ts";
import { verifyPlanHash, verifyPlanProfile, type PlanProfile, type ResolvedBuildPlan } from "./plan.ts";
import { canonicalProfileJson, hashPocketProfile } from "../profile.ts";
import { POCKET_BINDING_GENERATION } from "../../../contracts/spec/binding-generation.ts";

/** Stable subset of the internal build plan consumed by custom native hosts. */
export interface HostBuildInputs {
  /** The profile's provenance projection and the package rate (`tickHz`). */
  readonly profile: PlanProfile;
  readonly profileHash: string;
  readonly appOutput: string;
  /** Package identity from the manifest, as the plan resolved it. Hosts map
   *  it onto their platform's package id and version scheme. */
  readonly app: {
    readonly id: string;
    readonly title: string;
    readonly version: string;
    readonly theme?: AnimationTheme;
  };
  readonly target: string;
  readonly hostAbi: number;
  readonly viewport: {
    readonly logical: Viewport;
    readonly physical: Viewport;
    readonly presentation: PresentationMode;
    readonly rasterDensity: number;
  };
  readonly surfaces?: {
    readonly auxiliary: {
      readonly logical: Viewport;
      readonly physical: Viewport;
      readonly presentation: PresentationMode;
      readonly rasterDensity: number;
    };
  };
  readonly hostExtension?: HostExtension;
}

export interface ExtractHostBuildInputsOptions {
  readonly expectedTarget?: string;
  readonly expectedProfileHash?: string;
}

export interface HostBuildEnvironmentOptions {
  readonly outputDirectory: string;
  readonly embedApp: boolean;
  /** Where `exportProfile` wrote pocket_profile.h and pocket_profile.rs for this build. */
  readonly profileExportDirectory?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isViewport(value: unknown): value is Viewport {
  return Array.isArray(value) && value.length === 2 && value.every((part) =>
    typeof part === "number" && Number.isInteger(part) && part > 0
  );
}

function hasHostInputShape(input: unknown): input is ResolvedBuildPlan {
  if (!isRecord(input) || !isRecord(input.app) || !isRecord(input.target)) return false;
  if (!isRecord(input.viewport) || !isRecord(input.features)) return false;
  if (
    typeof input.app.id !== "string" || input.app.id.length === 0 ||
    typeof input.app.title !== "string" || input.app.title.length === 0 ||
    typeof input.app.version !== "string" || input.app.version.length === 0
  ) return false;
  if (input.surfaces !== undefined) {
    if (!isRecord(input.surfaces) || !isRecord(input.surfaces.auxiliary)) return false;
    const auxiliary = input.surfaces.auxiliary;
    if (!isViewport(auxiliary.logical) || !isViewport(auxiliary.physical)) return false;
    if (!PRESENTATION_MODES.includes(auxiliary.presentation as PresentationMode)) return false;
    if (
      !Number.isInteger(auxiliary.rasterDensity) ||
      (auxiliary.rasterDensity as number) < 1 ||
      (auxiliary.rasterDensity as number) > 255
    ) return false;
  }
  if (typeof input.app.output !== "string" || input.app.output.length === 0) return false;
  if (typeof input.target.id !== "string" || input.target.id.length === 0) return false;
  if (!Number.isInteger(input.target.hostAbi) || (input.target.hostAbi as number) < 1) return false;
  if (!isViewport(input.viewport.logical) || !isViewport(input.viewport.physical)) return false;
  if (!PRESENTATION_MODES.includes(input.viewport.presentation as PresentationMode)) return false;
  if (
    !Number.isInteger(input.viewport.rasterDensity) ||
    (input.viewport.rasterDensity as number) < 1 ||
    (input.viewport.rasterDensity as number) > 255
  ) return false;
  if (typeof input.planHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(input.planHash)) return false;
  if (input.hostExtension !== undefined && !isHostExtension(input.hostExtension)) return false;
  return Object.values(input.features).every((available) => typeof available === "boolean");
}

function readVerifiedPlan(input: unknown): ResolvedBuildPlan {
  if (!hasHostInputShape(input)) {
    throw new TypeError("PocketJS host build: invalid ResolvedBuildPlan shape");
  }
  try {
    if (!verifyPlanHash(input)) {
      throw new TypeError("PocketJS host build: invalid ResolvedBuildPlan checksum");
    }
    if (!verifyPlanProfile(input)) {
      throw new TypeError("PocketJS host build: invalid ResolvedBuildPlan profile identity");
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("PocketJS host build:")) {
      throw error;
    }
    throw new TypeError("PocketJS host build: invalid ResolvedBuildPlan shape", { cause: error });
  }
  return input;
}

/**
 * Verify an internal plan and project it onto the stable custom-host boundary.
 * Custom hosts should not import or retain the complete ResolvedBuildPlan.
 */
export function extractHostBuildInputs(
  input: unknown,
  options: ExtractHostBuildInputsOptions = {},
): HostBuildInputs {
  const plan = readVerifiedPlan(input);
  if (plan.target.hostAbi !== POCKET_BINDING_GENERATION) {
    throw new TypeError(`PocketJS host build: binding generation ${plan.target.hostAbi} is unsupported; rebuild for ${POCKET_BINDING_GENERATION}`);
  }
  if (options.expectedTarget && plan.target.id !== options.expectedTarget) {
    throw new TypeError(
      `PocketJS host build: expected target ${options.expectedTarget}, got ${plan.target.id}`,
    );
  }
  if (options.expectedProfileHash && plan.profileHash !== options.expectedProfileHash) {
    throw new TypeError(`PocketJS host build: expected profile ${options.expectedProfileHash}, got ${plan.profileHash}`);
  }
  return {
    profile: plan.profile,
    profileHash: plan.profileHash,
    appOutput: plan.app.output,
    app: {
      id: plan.app.id,
      title: plan.app.title,
      version: plan.app.version,
      ...(plan.app.theme !== undefined ? { theme: plan.app.theme } : {}),
    },
    target: plan.target.id,
    hostAbi: plan.target.hostAbi,
    viewport: {
      logical: plan.viewport.logical,
      physical: plan.viewport.physical,
      presentation: plan.viewport.presentation,
      rasterDensity: plan.viewport.rasterDensity,
    },
    ...(plan.surfaces ? { surfaces: plan.surfaces } : {}),
    ...(plan.hostExtension ? { hostExtension: plan.hostExtension } : {}),
  };
}

/** Build the target-neutral environment shared by framework and custom crates. */
export function hostBuildEnvironment(
  inputs: HostBuildInputs,
  options: HostBuildEnvironmentOptions,
): Readonly<Record<string, string>> {
  if (inputs.hostAbi !== POCKET_BINDING_GENERATION) {
    throw new TypeError(`PocketJS host build: binding generation ${inputs.hostAbi} is unsupported; rebuild for ${POCKET_BINDING_GENERATION}`);
  }
  if (inputs.profile.id !== inputs.target || hashPocketProfile(inputs.profile) !== inputs.profileHash) {
    throw new TypeError("PocketJS host build: invalid profile identity");
  }
  return {
    POCKETJS_PROFILE_HASH: inputs.profileHash,
    POCKETJS_PROFILE_JSON: canonicalProfileJson(inputs.profile),
    POCKETJS_TICK_HZ: String(inputs.profile.tickHz),
    POCKETJS_APP_OUTPUT: inputs.appOutput,
    POCKETJS_APP_ID: inputs.app.id,
    POCKETJS_APP_TITLE: inputs.app.title,
    POCKETJS_APP_VERSION: inputs.app.version,
    POCKETJS_EMBED_APP: options.embedApp ? "1" : "0",
    POCKETJS_OUTPUT_DIR: options.outputDirectory,
    POCKETJS_TARGET: inputs.target,
    POCKETJS_HOST_ABI: String(inputs.hostAbi),
    POCKETJS_LOGICAL_WIDTH: String(inputs.viewport.logical[0]),
    POCKETJS_LOGICAL_HEIGHT: String(inputs.viewport.logical[1]),
    POCKETJS_PHYSICAL_WIDTH: String(inputs.viewport.physical[0]),
    POCKETJS_PHYSICAL_HEIGHT: String(inputs.viewport.physical[1]),
    POCKETJS_PRESENTATION: inputs.viewport.presentation,
    POCKETJS_RASTER_DENSITY: String(inputs.viewport.rasterDensity),
    POCKETJS_AUX_LOGICAL_WIDTH: inputs.surfaces ? String(inputs.surfaces.auxiliary.logical[0]) : "",
    POCKETJS_AUX_LOGICAL_HEIGHT: inputs.surfaces ? String(inputs.surfaces.auxiliary.logical[1]) : "",
    POCKETJS_AUX_PHYSICAL_WIDTH: inputs.surfaces ? String(inputs.surfaces.auxiliary.physical[0]) : "",
    POCKETJS_AUX_PHYSICAL_HEIGHT: inputs.surfaces ? String(inputs.surfaces.auxiliary.physical[1]) : "",
    POCKETJS_AUX_PRESENTATION: inputs.surfaces ? inputs.surfaces.auxiliary.presentation : "",
    POCKETJS_AUX_RASTER_DENSITY: inputs.surfaces ? String(inputs.surfaces.auxiliary.rasterDensity) : "",
    ...(inputs.hostExtension ? { POCKETJS_HOST_EXTENSION: canonicalJson(inputs.hostExtension) } : {}),
    ...(options.profileExportDirectory ? { POCKETJS_PROFILE_EXPORT_DIR: options.profileExportDirectory, POCKETJS_PROFILE_RS: `${options.profileExportDirectory}/pocket_profile.rs` } : {}),
  };
}
