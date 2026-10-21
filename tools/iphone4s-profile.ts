import softwareProfile from "../profiles/iphone4s-dev.ts";
import { legacyTargetProfile, LEGACY_BINDING_GENERATIONS } from "../profiles/legacy-abi.ts";
import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/** Private exact-device profile for the iPhone 4S running iOS 6.1.3. */
export const IPHONE4S_DEV_TARGET_ID = softwareProfile.id;
export const IPHONE4S_DEV_HOST_ABI = LEGACY_BINDING_GENERATIONS[softwareProfile.id];
export const IPHONE4S_LOGICAL_VIEWPORT = softwareProfile.display.logicalViewports[0];
export const IPHONE4S_PHYSICAL_VIEWPORT = softwareProfile.display.physicalViewport;
export const IPHONE4S_RASTER_DENSITY = softwareProfile.display.rasterDensity;

export const IPHONE4S_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [IPHONE4S_DEV_TARGET_ID]: legacyTargetProfile(softwareProfile),
  }),
);

export function resolveIPhone4SBuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: IPHONE4S_DEV_TARGET_ID },
    IPHONE4S_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket iphone4s: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
