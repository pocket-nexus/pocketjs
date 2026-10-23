import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * Exact-device profile for Foundation's Passport Prime: a 480x800 touch panel
 * driven by KeyOS (a Xous microkernel) on a single Cortex-A5.
 *
 * The host is hosts/keyos. gui-server lends the app a 480x800 framebuffer and
 * draws the collapsed Control Center over its top 40 rows, so the PocketJS
 * surface is the 480x760 band below it. The panel has no game keys, and
 * KeyOS gives an app no USB debug channel of its own, so `input.buttons` and
 * `io.offload` are absent.
 */
export const PASSPORT_PRIME_TARGET = "passport-prime-dev";
export const PASSPORT_PRIME_HOST_ABI = 12;
export const PASSPORT_PRIME_LOGICAL_VIEWPORT = [480, 760] as const;
export const PASSPORT_PRIME_PHYSICAL_VIEWPORT = [480, 760] as const;
export const PASSPORT_PRIME_RASTER_DENSITY = 1;
/** Rows of the panel the collapsed Control Center covers. */
export const PASSPORT_PRIME_STATUS_BAR_ROWS = 40;

export const PASSPORT_PRIME_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [PASSPORT_PRIME_TARGET]: {
      hostAbi: PASSPORT_PRIME_HOST_ABI,
      platform: "keyos",
      form: "takeover",
      display: {
        physicalViewport: PASSPORT_PRIME_PHYSICAL_VIEWPORT,
        logicalViewports: [PASSPORT_PRIME_LOGICAL_VIEWPORT],
        presentations: ["native"],
        rasterDensity: PASSPORT_PRIME_RASTER_DENSITY,
      },
      capabilities: ["input.touch", "text.glyphs.baked"],
    },
  }),
);

export function resolvePassportPrimeBuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: PASSPORT_PRIME_TARGET },
    PASSPORT_PRIME_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket passport-prime: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
