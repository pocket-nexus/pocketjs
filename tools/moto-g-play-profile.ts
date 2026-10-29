import { POCKET_PROFILES } from "../profiles/index.ts";
import { targetProfile } from "../profiles/contract.ts";
import { POCKET_CAPABILITIES, definePlatformContractRegistry, defineTargetRegistry } from "../contracts/spec/platforms.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
const softwareProfile = POCKET_PROFILES["moto-g-play-dev"];
export const MOTO_G_PLAY_TARGET = softwareProfile.id;
export const MOTO_G_PLAY_CONTRACTS = definePlatformContractRegistry(POCKET_CAPABILITIES, defineTargetRegistry({
  [MOTO_G_PLAY_TARGET]: targetProfile(softwareProfile),
}));
export function resolveMotoGPlayBuildPlan(input: unknown) {
  const result = validateAndResolveBuildPlan(input, { target: MOTO_G_PLAY_TARGET }, MOTO_G_PLAY_CONTRACTS);
  if (!result.ok) throw new Error(result.diagnostics.map(d => `${d.path}: ${d.message}`).join("; "));
  return result.plan;
}
