import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import type { PocketProfile } from "../contracts/spec/profile.ts";
import type { PocketCapabilityId } from "../contracts/spec/platform-types.ts";

/** One-way projection for tools that still consume TargetProfile. Software
 * facts belong to PocketProfile; all programs use the generated UI binding. */
export function targetProfile<const P extends PocketProfile<PocketCapabilityId>>(profile: P) {
  const { id: _id, hostExtension: _extension, ...contract } = profile;
  return { ...contract, hostAbi: POCKET_BINDING_GENERATION };
}
