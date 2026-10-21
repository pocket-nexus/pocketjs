import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import softwareProfile from "../profiles/iphone2g-dev.ts";
import { targetProfile } from "../profiles/contract.ts";
import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * Transitional iPhone 2G profile used only by the private device toolchain.
 *
 * It deliberately stays out of the production `POCKET_TARGETS` registry until
 * the iPhone OS 3.1.3 host has passed the full hardware acceptance suite. The
 * application owns the original 320x480 display and receives touch input in
 * the same logical coordinate space.
 */
export const IPHONE2G_DEV_TARGET_ID = softwareProfile.id;
export const IPHONE2G_DEV_HOST_ABI = POCKET_BINDING_GENERATION;
export const IPHONE2G_VIEWPORT = softwareProfile.display.logicalViewports[0];

export const IPHONE2G_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [IPHONE2G_DEV_TARGET_ID]: targetProfile(softwareProfile),
  }),
);

export function resolveIPhone2GBuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: IPHONE2G_DEV_TARGET_ID },
    IPHONE2G_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket iphone2g: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
