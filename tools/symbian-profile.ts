import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * Transitional Nokia E7 profile used only by `pocket symbian`.
 *
 * It deliberately stays out of the production `POCKET_TARGETS` registry until
 * the E7 host has passed the full hardware acceptance suite. The Qt window is
 * the PocketJS surface: its 640x360 landscape and 360x640 portrait geometries
 * are native logical viewports, with live relayout when Symbian rotates it.
 * ui.physics (ops 52..56) is bound by hosts/nokia-e7/runtime/main.cpp for a
 * plan that resolved it; the guest ships inside its host's SIS.
 */
export const SYMBIAN_E7_DEV_TARGET_ID = "symbian-e7-dev";
export const SYMBIAN_E7_DEV_HOST_ABI = 4;
export const SYMBIAN_E7_DEFAULT_VIEWPORT = [640, 360] as const;
export const SYMBIAN_E7_MIN_VIEWPORT = [360, 360] as const;
export const SYMBIAN_E7_MAX_VIEWPORT = [640, 640] as const;

export const SYMBIAN_E7_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [SYMBIAN_E7_DEV_TARGET_ID]: {
      hostAbi: SYMBIAN_E7_DEV_HOST_ABI,
      platform: "symbian",
      form: "window",
      display: {
        physicalViewport: SYMBIAN_E7_DEFAULT_VIEWPORT,
        logicalViewports: [SYMBIAN_E7_DEFAULT_VIEWPORT],
        dynamicViewport: {
          min: SYMBIAN_E7_MIN_VIEWPORT,
          max: SYMBIAN_E7_MAX_VIEWPORT,
        },
        presentations: ["native"],
        rasterDensity: 1,
      },
      capabilities: [
        "input.buttons",
        "input.touch",
        "display.viewport.live",
        "text.glyphs.baked",
        "ui.physics",
      ],
    },
  }),
);

export function resolveSymbianE7BuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: SYMBIAN_E7_DEV_TARGET_ID },
    SYMBIAN_E7_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket symbian: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}

type ViewportDeclaration = { dynamic?: { min?: readonly number[]; max?: readonly number[] } };

/**
 * The orientation an E7 build holds, the host's one orientation lock. A
 * manifest whose dynamic viewport range admits portrait sizes only (every
 * width below every height) is held in portrait, a landscape-only range in
 * landscape; any other app follows the phone's rotation with live relayout.
 * A navigation registry entry marked `portrait` holds a rotating app in
 * portrait as well.
 */
export function symbianE7Orientation(
  manifest: unknown,
  plan: ResolvedBuildPlan,
  navigation: "auto" | "portrait" = "auto",
): "auto" | "portrait" | "landscape" {
  const app = (manifest as { app?: { viewport?: ViewportDeclaration; presentations?: { id?: string; viewport?: ViewportDeclaration }[] } }).app;
  const chosen = app?.presentations?.find((entry) => entry.id === plan.presentation.id);
  const dynamic = (chosen?.viewport ?? app?.viewport)?.dynamic;
  const range = !dynamic?.min || !dynamic.max ? "auto"
    : dynamic.max[0] < dynamic.min[1] ? "portrait"
    : dynamic.max[1] < dynamic.min[0] ? "landscape"
    : "auto";
  if (navigation === "auto") return range;
  if (range === "landscape") {
    throw new Error(`pocket symbian: the navigation registry holds ${plan.app.output} in portrait, but its manifest admits landscape only`);
  }
  return "portrait";
}
