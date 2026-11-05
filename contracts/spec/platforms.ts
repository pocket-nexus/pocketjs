export * from "./platform-types.ts";
import {
  POCKET_CAPABILITIES, defineTargetRegistry, definePlatformContractRegistry,
  type TargetId,
} from "./platform-types.ts";

import { POCKET_PROFILES } from "../../hosts/index.ts";
import { targetProfile } from "../../hosts/contract.ts";

/** Compatibility inventory; software facts are owned by hosts/<id>/pocket.host.json. */
export const POCKET_TARGETS = defineTargetRegistry({
  psp: targetProfile(POCKET_PROFILES.psp),
  vita: targetProfile(POCKET_PROFILES.vita),
  pocketbook: targetProfile(POCKET_PROFILES.pocketbook),
  "macos-widget": targetProfile(POCKET_PROFILES["macos-widget"]),
  "macos-app": targetProfile(POCKET_PROFILES["macos-app"]),
  "linux-app": targetProfile(POCKET_PROFILES["linux-app"]),
  "web-app": targetProfile(POCKET_PROFILES["web-app"]),
});

export type PocketTargetId = TargetId<typeof POCKET_TARGETS>;

export const POCKET_PLATFORM_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  POCKET_TARGETS,
);
