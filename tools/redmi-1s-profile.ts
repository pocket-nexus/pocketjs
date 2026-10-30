import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { targetProfile } from "../hosts/contract.ts";
import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
const softwareProfile = POCKET_PROFILES["redmi-1s-dev"];

/**
 * Exact-device profile for the Redmi 1S (HM 1S, `armani`): a 4.7 inch
 * 720x1280 panel on Android 4.3 (API 18), ARMv7.
 *
 * The host is programs/android, the same code the moto-g-play profile builds.
 * All profiles use the shared binding generation; the target id names the device.
 * The panel is 360x640 logical at density 2. The host draws that picture at
 * one scale in both directions, centred, so a phone with a taller panel
 * shows it with black above and below (programs/android/app/jni/runtime.c).
 *
 * The phone has no game keys: `input.buttons` is absent, as it is for the
 * iPod touch 4, and an app that requires it does not resolve.
 */
export const REDMI_1S_TARGET = softwareProfile.id;
export const REDMI_1S_HOST_ABI = POCKET_BINDING_GENERATION;
export const REDMI_1S_LOGICAL_VIEWPORT = softwareProfile.display.logicalViewports[0];
export const REDMI_1S_PHYSICAL_VIEWPORT = softwareProfile.panel.primary;
export const REDMI_1S_RASTER_DENSITY = softwareProfile.display.rasterDensity;

export const REDMI_1S_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [REDMI_1S_TARGET]: targetProfile(softwareProfile),
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
