import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import softwareProfile from "../profiles/blackberry-qnx-dev.ts";
import { targetProfile } from "../profiles/contract.ts";
import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/** Private exact-device profile for the BlackBerry Classic native QNX host. */
export const BLACKBERRY_QNX_DEV_TARGET_ID = softwareProfile.id;
export type BlackBerryClassicTargetId = typeof BLACKBERRY_QNX_DEV_TARGET_ID;

export const BLACKBERRY_CLASSIC_HOST_ABI = POCKET_BINDING_GENERATION;
export const BLACKBERRY_CLASSIC_LOGICAL_VIEWPORT = softwareProfile.display.logicalViewports[0];
export const BLACKBERRY_CLASSIC_PHYSICAL_VIEWPORT = softwareProfile.display.physicalViewport;
export const BLACKBERRY_CLASSIC_RASTER_DENSITY = softwareProfile.display.rasterDensity;

export const BLACKBERRY_CLASSIC_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [BLACKBERRY_QNX_DEV_TARGET_ID]: targetProfile(softwareProfile),
  }),
);

export function resolveBlackBerryClassicBuildPlan(
  input: unknown,
  target: BlackBerryClassicTargetId,
): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target },
    BLACKBERRY_CLASSIC_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket blackberry-classic: manifest did not resolve for ${target}: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
