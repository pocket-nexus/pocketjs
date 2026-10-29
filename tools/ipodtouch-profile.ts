import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { POCKET_PROFILES } from "../profiles/index.ts";
import { targetProfile } from "../profiles/contract.ts";
import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
const softwareProfile = POCKET_PROFILES["ipodtouch-dev"];

/**
 * Private connected-device profile for the iPod touch (6th generation).
 *
 * The A8 device has a 640x1136 Retina display. UIKit exposes that as a
 * 320x568-point surface, and PocketSurfaceView rasterizes it at density 2.
 * The profile remains outside POCKET_TARGETS until the hardware path has a
 * repeatable build, deployment, launch, rendered-frame, and touch receipt.
 */
export const IPODTOUCH_DEV_TARGET_ID = softwareProfile.id;
export const IPODTOUCH_DEV_HOST_ABI = POCKET_BINDING_GENERATION;
export const IPODTOUCH_LOGICAL_VIEWPORT = softwareProfile.display.logicalViewports[0];
export const IPODTOUCH_RASTER_DENSITY = softwareProfile.display.rasterDensity;
export const IPODTOUCH_PHYSICAL_VIEWPORT = softwareProfile.panel.primary;

export const IPODTOUCH_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [IPODTOUCH_DEV_TARGET_ID]: targetProfile(softwareProfile),
  }),
);

export function resolveIPodTouchBuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: IPODTOUCH_DEV_TARGET_ID },
    IPODTOUCH_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket ipodtouch: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
