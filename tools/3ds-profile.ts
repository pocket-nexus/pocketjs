import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import softwareProfile from "../profiles/3ds-dev.ts";
import { targetProfile } from "../profiles/contract.ts";
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
export const THREE_DS_DEV_TARGET_ID = softwareProfile.id;
export const THREE_DS_DEV_HOST_ABI = POCKET_BINDING_GENERATION;
export const THREE_DS_VIEWPORT = softwareProfile.display.logicalViewports[0];
export const THREE_DS_AUXILIARY_VIEWPORT = softwareProfile.display.auxiliary.logicalViewports[0];

export const THREE_DS_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [THREE_DS_DEV_TARGET_ID]: targetProfile(softwareProfile),
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
