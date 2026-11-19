import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { targetProfile } from "../hosts/contract.ts";
import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/compiler/plan.ts";
import { resolveAppPlan } from "../framework/compiler/app-plan.ts";
import type { AppViewport } from "../contracts/spec/viewport.ts";
const softwareProfile = POCKET_PROFILES["symbian-e7-dev"];

/**
 * Transitional Nokia E7 profile used only by `pocket symbian`.
 *
 * It deliberately stays out of the production `POCKET_TARGETS` registry until
 * the E7 host has passed the full hardware acceptance suite. The Qt window is
 * the PocketJS surface: its 640x360 landscape and 360x640 portrait geometries
 * are native logical viewports, with live relayout when Symbian rotates it.
 * ui.physics (ops 52..56) is bound by programs/nokia-e7/runtime/main.cpp for a
 * plan that resolved it; the guest ships inside its host's SIS.
 */
export const SYMBIAN_E7_DEV_TARGET_ID = softwareProfile.id;
export const SYMBIAN_E7_DEV_HOST_ABI = POCKET_BINDING_GENERATION;
export const SYMBIAN_E7_DEFAULT_VIEWPORT = softwareProfile.display.logicalViewports[0];
export const SYMBIAN_E7_MIN_VIEWPORT = softwareProfile.display.dynamicViewport!.min;
export const SYMBIAN_E7_MAX_VIEWPORT = softwareProfile.display.dynamicViewport!.max;

export const SYMBIAN_E7_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [SYMBIAN_E7_DEV_TARGET_ID]: targetProfile(softwareProfile),
  }),
);

export function resolveSymbianE7BuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = resolveAppPlan(
    input,
    { target: SYMBIAN_E7_DEV_TARGET_ID },
    SYMBIAN_E7_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket symbian: application did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}

export type SymbianOrientation = "auto" | "portrait" | "landscape";

/**
 * The orientation an E7 build holds, the host's one orientation lock. An
 * application whose dynamic viewport range admits portrait sizes only (every
 * width below every height) is held in portrait, a landscape-only range in
 * landscape; any other app follows the phone's rotation with live relayout.
 * `viewport` is the `app.viewport` of the host config the package was
 * compiled from; without it (a package compiled elsewhere) the range is
 * unknown and the app rotates.
 */
export function symbianE7Orientation(
  viewport: AppViewport | undefined,
): SymbianOrientation {
  const dynamic = viewport && !("logical" in viewport) ? viewport.dynamic : undefined;
  return !dynamic?.min || !dynamic.max ? "auto"
    : dynamic.max[0] < dynamic.min[1] ? "portrait"
    : dynamic.max[1] < dynamic.min[0] ? "landscape"
    : "auto";
}
