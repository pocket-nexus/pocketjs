import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * Transitional Nintendo 3DS profile used only by `bun run 3ds`.
 *
 * The CIA has passed a hardware smoke on a New 3DS LL. It deliberately stays
 * out of the production `POCKET_TARGETS` registry while the host-specific
 * suite still leaves the synthesized cursor, sprite, streamed-texture and
 * large-atlas paths uncovered. The app owns the 400x240 top screen and a
 * simultaneous 320x240 auxiliary bottom-screen output. Both PICA200 targets
 * are native at density 1. The resistive panel reports contacts only through
 * input.touch.auxiliary.
 */
export const THREE_DS_DEV_TARGET_ID = "3ds-dev";
export const THREE_DS_DEV_HOST_ABI = 10;
export const THREE_DS_VIEWPORT = [400, 240] as const;
export const THREE_DS_AUXILIARY_VIEWPORT = [320, 240] as const;

export const THREE_DS_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [THREE_DS_DEV_TARGET_ID]: {
      hostAbi: THREE_DS_DEV_HOST_ABI,
      platform: "3ds",
      form: "takeover",
      display: {
        physicalViewport: THREE_DS_VIEWPORT,
        logicalViewports: [THREE_DS_VIEWPORT],
        presentations: ["native"],
        rasterDensity: 1,
        auxiliary: {
          physicalViewport: THREE_DS_AUXILIARY_VIEWPORT,
          logicalViewports: [THREE_DS_AUXILIARY_VIEWPORT],
          presentations: ["native"],
          rasterDensity: 1,
        },
      },
      capabilities: [
        "io.offload",
        "media.playback",
        "input.analog.left",
        "input.analog.right",
        "input.buttons",
        "input.cursor",
        "input.touch.auxiliary",
        "display.auxiliary",
        "text.glyphs.baked",
      ],
    },
  }),
);

export function resolve3dsBuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: THREE_DS_DEV_TARGET_ID },
    THREE_DS_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket 3ds: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
