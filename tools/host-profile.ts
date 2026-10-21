import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalProfileJson, hashPocketProfile, type PocketProfile } from "../framework/src/profile.ts";

/** Build output consumed by the C composition wrapper, independent of any package. */
export function writeHostProfileHeader(directory: string, profile: PocketProfile): string {
  const json = canonicalProfileJson(profile);
  // Hex escapes preserve UTF-8 and avoid the C preprocessor's trigraphs.
  const literal = [...new TextEncoder().encode(json)].map(byte => `\\x${byte.toString(16).padStart(2, "0")}`).join("");
  const hash = hashPocketProfile(profile).slice("sha256:".length).match(/../g)!.map(byte => Number.parseInt(byte, 16));
  const source = `/* Generated software profile; do not edit. */
#ifndef POCKET_HOST_PROFILE_H
#define POCKET_HOST_PROFILE_H
#include <stdint.h>
static const char POCKETJS_HOST_PROFILE_JSON[] = "${literal}";
static const uint8_t POCKETJS_HOST_PROFILE_HASH[32] = {${hash.join(",")}};
#define POCKETJS_HOST_PROFILE_TICK_HZ ${profile.tickHz}u
#endif
`;
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "pocket_host_profile.h");
  if (!existsSync(path) || readFileSync(path, "utf8") !== source) writeFileSync(path, source);
  return path;
}
