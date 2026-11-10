import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/** Private exact-device profile for the iPad 2,2 running iOS 6.1.3. */
export const IPAD2_DEV_TARGET_ID = "ipad2-dev";
export const IPAD2_DEV_HOST_ABI = 8;
export const IPAD2_LOGICAL_VIEWPORT = [768, 1024] as const;
export const IPAD2_PHYSICAL_VIEWPORT = [768, 1024] as const;
export const IPAD2_RASTER_DENSITY = 1;

export const IPAD2_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [IPAD2_DEV_TARGET_ID]: {
      hostAbi: IPAD2_DEV_HOST_ABI,
      platform: "ios",
      form: "takeover",
      display: {
        physicalViewport: IPAD2_PHYSICAL_VIEWPORT,
        logicalViewports: [IPAD2_LOGICAL_VIEWPORT],
        presentations: ["native"],
        rasterDensity: IPAD2_RASTER_DENSITY,
      },
      capabilities: ["input.touch", "text.glyphs.baked"],
    },
  }),
);

export function resolveIPad2BuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: IPAD2_DEV_TARGET_ID },
    IPAD2_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket ipad2: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
