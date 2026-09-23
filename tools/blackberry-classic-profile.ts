import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/** Private exact-device profile for the BlackBerry Classic native QNX host. */
export const BLACKBERRY_QNX_DEV_TARGET_ID = "blackberry-qnx-dev";
export type BlackBerryClassicTargetId = typeof BLACKBERRY_QNX_DEV_TARGET_ID;

export const BLACKBERRY_CLASSIC_HOST_ABI = 9;
export const BLACKBERRY_CLASSIC_LOGICAL_VIEWPORT = [360, 360] as const;
export const BLACKBERRY_CLASSIC_PHYSICAL_VIEWPORT = [720, 720] as const;
export const BLACKBERRY_CLASSIC_RASTER_DENSITY = 2;

const CLASSIC_DISPLAY = {
  physicalViewport: BLACKBERRY_CLASSIC_PHYSICAL_VIEWPORT,
  logicalViewports: [BLACKBERRY_CLASSIC_LOGICAL_VIEWPORT],
  presentations: ["native"],
  rasterDensity: BLACKBERRY_CLASSIC_RASTER_DENSITY,
} as const;

const CLASSIC_CAPABILITIES = [
  "input.buttons",
  "input.touch",
  "text.glyphs.baked",
] as const;

export const BLACKBERRY_CLASSIC_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [BLACKBERRY_QNX_DEV_TARGET_ID]: {
      hostAbi: BLACKBERRY_CLASSIC_HOST_ABI,
      platform: "blackberry10-qnx",
      form: "takeover",
      display: CLASSIC_DISPLAY,
      capabilities: CLASSIC_CAPABILITIES,
    },
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
