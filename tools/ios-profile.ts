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
const softwareProfile = POCKET_PROFILES["ios-dev"];

/**
 * Transitional modern-iOS profile used only by `pocket ios`.
 *
 * It deliberately stays out of the production `POCKET_TARGETS` registry until
 * the Apple host has passed a device acceptance suite. The surface is a
 * PocketSurfaceView framed inside another runtime's view hierarchy (a
 * NativeScript layout today), so the form is "embedded": the 480x272 logical
 * viewport is fixed and the view letterboxes it with aspect-fit. The native
 * host publishes this identity via pocket_apple_set_identity
 * (engine/ios/uikit/PocketSurfaceView.m), and external-guest hosts publish
 * the same pair on the ui namespace they mount — all three must agree.
 *
 * Raster density is the surface's raster scale (PocketSurfaceView clamps
 * 1..4). Glyph atlases bake at build time, so guests must build at the
 * density the surface renders — a mismatch renders soft text.
 */
export const IOS_DEV_TARGET_ID = softwareProfile.id;
export const IOS_DEV_HOST_ABI = POCKET_BINDING_GENERATION;
export const IOS_DEV_VIEWPORT = softwareProfile.display.logicalViewports[0];
export const IOS_DEV_DEFAULT_DENSITY = softwareProfile.display.rasterDensity;
export const IOS_DEV_MAX_DENSITY = 4;

export function iosDevContracts(rasterDensity: number = IOS_DEV_DEFAULT_DENSITY) {
  if (
    !Number.isInteger(rasterDensity) ||
    rasterDensity < 1 ||
    rasterDensity > IOS_DEV_MAX_DENSITY
  ) {
    throw new Error(
      `pocket ios: raster density must be an integer 1..${IOS_DEV_MAX_DENSITY}, got ${rasterDensity}`,
    );
  }
  const [width, height] = IOS_DEV_VIEWPORT;
  return definePlatformContractRegistry(
    POCKET_CAPABILITIES,
    defineTargetRegistry({
      [IOS_DEV_TARGET_ID]: targetProfile({
        ...softwareProfile,
        display: { ...softwareProfile.display, rasterDensity },
        panel: { primary: [width * rasterDensity, height * rasterDensity] },
      }),
    }),
  );
}

export const IOS_DEV_CONTRACTS = iosDevContracts();

export function resolveIOSDevBuildPlan(
  input: unknown,
  rasterDensity?: number,
): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: IOS_DEV_TARGET_ID },
    rasterDensity === undefined ? IOS_DEV_CONTRACTS : iosDevContracts(rasterDensity),
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket ios: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
