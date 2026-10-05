import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

export const WII_DEV_TARGET_ID = "wii-dev";
export const WII_DEV_HOST_ABI = 7;
export const WII_DEV_VIEWPORT = [480, 272] as const;

export const WII_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [WII_DEV_TARGET_ID]: {
      hostAbi: WII_DEV_HOST_ABI,
      platform: "wii",
      form: "embedded",
      display: {
        // This is the nominal 1x surface, not a Wii video-mode size. The
        // application supplies the physical GX rectangle to pocket_wii_draw.
        physicalViewport: WII_DEV_VIEWPORT,
        logicalViewports: [WII_DEV_VIEWPORT],
        presentations: ["native", "integer-fit"],
        rasterDensity: 1,
      },
      capabilities: [
        "input.analog.left",
        "input.buttons",
        "text.glyphs.baked",
      ],
    },
  }),
);

export function resolveWiiBuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: WII_DEV_TARGET_ID },
    WII_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket wii: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
