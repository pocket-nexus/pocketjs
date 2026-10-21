// Transitional binding generations; removed when stage 7c switches hostAbi.
// These numbers are not part of a software profile.
export const LEGACY_BINDING_GENERATIONS: Readonly<Record<string, number>> = {
  "psp": 1,
  "vita": 2,
  "3ds-dev": 11,
  "pocketbook": 5,
  "web-app": 4,
  "macos-app": 4,
  "linux-app": 4,
  "macos-widget": 3,
  "moto-g-play-dev": 9,
  "redmi-1s-dev": 9,
  "blackberry-qnx-dev": 9,
  "meizu-m8-dev": 8,
  "symbian-e7-dev": 4,
  "ios-dev": 7,
  "iphone2g-dev": 6,
  "iphone4s-dev": 8,
  "ipodtouch-dev": 7,
  "ipodtouch4-dev": 8,
  "macos-embedded": 3
};

import type { PocketProfile } from "../contracts/spec/profile.ts";
import type { PocketCapabilityId } from "../contracts/spec/platform-types.ts";

/** One-way compatibility projection for the pre-profile build tools. */
export function legacyTargetProfile<const P extends PocketProfile<PocketCapabilityId>>(profile: P) {
  const hostAbi = LEGACY_BINDING_GENERATIONS[profile.id];
  if (hostAbi === undefined) throw new Error(`No legacy binding generation for ${profile.id}`);
  const { id: _id, hostExtension: _extension, ...contract } = profile;
  return { ...contract, hostAbi };
}
