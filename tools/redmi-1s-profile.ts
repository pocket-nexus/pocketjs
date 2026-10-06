import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * Exact-device profile for the Redmi 1S (HM 1S, `armani`): a 4.7 inch
 * 720x1280 panel on Android 4.3 (API 18), ARMv7.
 *
 * The host is hosts/android, the same code the moto-g-play profile builds,
 * so the profile shares host ABI 9. The target id is what names the device.
 * The panel is 360x640 logical at density 2. The host draws that picture at
 * one scale in both directions, centred, so a phone with a taller panel
 * shows it with black above and below (hosts/android/app/jni/runtime.c).
 *
 * The phone has no game keys: `input.buttons` is absent, as it is for the
 * iPod touch 4, and an app that requires it does not resolve.
 */
export const REDMI_1S_TARGET = "redmi-1s-dev";
export const REDMI_1S_HOST_ABI = 9;
export const REDMI_1S_LOGICAL_VIEWPORT = [360, 640] as const;
export const REDMI_1S_PHYSICAL_VIEWPORT = [720, 1280] as const;
export const REDMI_1S_RASTER_DENSITY = 2;

export const REDMI_1S_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [REDMI_1S_TARGET]: {
      hostAbi: REDMI_1S_HOST_ABI,
      platform: "android",
      form: "takeover",
      display: {
        physicalViewport: REDMI_1S_PHYSICAL_VIEWPORT,
        logicalViewports: [REDMI_1S_LOGICAL_VIEWPORT],
        presentations: ["native"],
        rasterDensity: REDMI_1S_RASTER_DENSITY,
      },
      capabilities: ["input.touch", "text.glyphs.baked", "io.offload"],
    },
  }),
);

export function resolveRedmi1sBuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: REDMI_1S_TARGET },
    REDMI_1S_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket redmi-1s: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
