import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashPocketProfile, type PocketProfile } from "../framework/src/profile.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { compiledProfileHeader } from "./profile-export.ts";

/** pocket_host_profile.h for the C composition wrappers, independent of any
 * package: the pocket_profile.h text (`pocket_profile.facts`,
 * `pocket_profile.profile_hash`) under the name their builds -include. The
 * header includes pocket_runtime.h from contracts/generated. */
export function writeHostProfileHeader(directory: string, profile: PocketProfile): string {
  const source = compiledProfileHeader(profile, hashPocketProfile(profile), POCKET_BINDING_GENERATION);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "pocket_host_profile.h");
  if (!existsSync(path) || readFileSync(path, "utf8") !== source) writeFileSync(path, source);
  return path;
}
