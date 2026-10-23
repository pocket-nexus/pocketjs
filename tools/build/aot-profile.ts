import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import type { PocketProfile } from "../../contracts/spec/profile.ts";
import { hashPocketProfile } from "../../framework/src/profile.ts";
import type { RuntimeBuildContext } from "../../framework/src/runtime-config.ts";
import { exportProfile } from "../profile-export.ts";

/** The fields an AOT program build reads from `pocket compile --aot`'s dependencies.json. */
export interface AotDependencyManifest {
  readonly profileHash: string;
  readonly hostAbi: number;
  readonly plan: { readonly profile: PocketProfile };
}

/** Export the program's profile into `directory` for `POCKETJS_PROFILE_RS`.
 * Under `pocket build` the profile is the executor's selection; a direct
 * invocation uses the profile recorded in the compiled plan. The AOT compiler
 * recorded `profileHash` for the generated sources, and the program boots
 * them with the exported `PROFILE_HASH`, so both must name one profile. */
export function exportAotProfile(dependency: AotDependencyManifest, directory: string, context?: RuntimeBuildContext): string {
  const profile = context?.profile ?? dependency.plan.profile;
  const profileHash = context?.profileHash ?? hashPocketProfile(profile);
  if (dependency.hostAbi !== POCKET_BINDING_GENERATION) throw new Error(`AOT sources use binding generation ${dependency.hostAbi}, not ${POCKET_BINDING_GENERATION}; recompile with pocket compile --aot`);
  if (profileHash !== dependency.profileHash || hashPocketProfile(profile) !== profileHash)
    throw new Error(`AOT sources were compiled for profile ${dependency.profileHash}; the program exports ${profileHash}`);
  return exportProfile({ profile, profileHash, hostAbi: POCKET_BINDING_GENERATION, dependencies: [] }, directory).module;
}
