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
const softwareProfile = POCKET_PROFILES["meizu-m8-dev"];

/**
 * Development profile for the original Windows CE 6 Meizu M8/M8SE.
 *
 * The logical surface matches the 480x720 LCD. The shared binding's wide touch words
 * carry the full native coordinate range without device-specific app input.
 * It remains private until the full hardware acceptance receipt passes.
 */
export const MEIZU_M8_DEV_TARGET_ID = softwareProfile.id;
export const MEIZU_M8_DEV_HOST_ABI = POCKET_BINDING_GENERATION;
export const MEIZU_M8_LOGICAL_VIEWPORT = softwareProfile.display.logicalViewports[0];
export const MEIZU_M8_PHYSICAL_VIEWPORT = softwareProfile.panel.primary;

export const MEIZU_M8_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [MEIZU_M8_DEV_TARGET_ID]: targetProfile(softwareProfile),
  }),
);

export function resolveMeizuM8BuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: MEIZU_M8_DEV_TARGET_ID },
    MEIZU_M8_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket meizu-m8: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
