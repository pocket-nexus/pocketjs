export * from "./platform-types.ts";
import {
  POCKET_CAPABILITIES, defineTargetRegistry, definePlatformContractRegistry,
  type TargetId,
} from "./platform-types.ts";

import { POCKET_PROFILES } from "../../profiles/index.ts";
import { legacyTargetProfile } from "../../profiles/legacy-abi.ts";

/** Compatibility inventory; software facts are owned by profiles/*.ts. */
export const POCKET_TARGETS = defineTargetRegistry({
  psp: legacyTargetProfile(POCKET_PROFILES.psp),
  vita: legacyTargetProfile(POCKET_PROFILES.vita),
  pocketbook: legacyTargetProfile(POCKET_PROFILES.pocketbook),
  "macos-widget": legacyTargetProfile(POCKET_PROFILES["macos-widget"]),
  "macos-app": legacyTargetProfile(POCKET_PROFILES["macos-app"]),
  "linux-app": legacyTargetProfile(POCKET_PROFILES["linux-app"]),
  "web-app": legacyTargetProfile(POCKET_PROFILES["web-app"]),
});

export type PocketTargetId = TargetId<typeof POCKET_TARGETS>;

export const POCKET_PLATFORM_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  POCKET_TARGETS,
);
