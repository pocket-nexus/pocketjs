import { POCKET_CAPABILITIES, definePlatformContractRegistry, defineTargetRegistry } from "../contracts/spec/platforms.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
export const MOTO_G_PLAY_TARGET = "moto-g-play-dev";
export const MOTO_G_PLAY_CONTRACTS = definePlatformContractRegistry(POCKET_CAPABILITIES, defineTargetRegistry({
  [MOTO_G_PLAY_TARGET]: {
    platform: "android", form: "takeover", hostAbi: 9,
    display: { physicalViewport: [720, 1600], logicalViewports: [[360, 800]], presentations: ["native"], rasterDensity: 2 },
    capabilities: ["input.buttons", "input.touch", "text.glyphs.baked", "io.offload"],
  },
}));
export function resolveMotoGPlayBuildPlan(input: unknown) {
  const result = validateAndResolveBuildPlan(input, { target: MOTO_G_PLAY_TARGET }, MOTO_G_PLAY_CONTRACTS);
  if (!result.ok) throw new Error(result.diagnostics.map(d => `${d.path}: ${d.message}`).join("; "));
  return result.plan;
}
