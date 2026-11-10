import { IPODTOUCH4_DEV_CONTRACTS, IPODTOUCH4_DEV_TARGET_ID } from "../ipodtouch4-profile.ts";
import { IPODTOUCH_DEV_CONTRACTS, IPODTOUCH_DEV_TARGET_ID } from "../ipodtouch-profile.ts";
import { IOS_DEV_CONTRACTS, IOS_DEV_TARGET_ID } from "../ios-profile.ts";
import { SYMBIAN_E7_DEV_CONTRACTS, SYMBIAN_E7_DEV_TARGET_ID } from "../symbian-profile.ts";
// tools/targets/index.ts — the target catalog: every target `pocket` builds
// for, by the name commands select it with.
//
// Registered targets keep their registry ids. Device profiles are selected by a
// device name and map to their unchanged contract ids, which native hosts
// declare (`__host`) and runtimes compile in to pick a `.pocket` variant.

import { POCKET_PLATFORM_CONTRACTS, type PlatformContractRegistry } from "../../contracts/spec/platforms.ts";
import { THREE_DS_DEV_CONTRACTS, THREE_DS_DEV_TARGET_ID } from "../3ds-profile.ts";
import { pspToolchain } from "../build/toolchains/psp.ts";
import { TOOLCHAIN_SCHEMA, type ToolchainManifest } from "./toolchain.ts";
import { HOST_IDS, type HostId, type TargetDescriptor } from "./types.ts";

const MACOS: readonly HostId[] = ["darwin-arm64", "darwin-x64"];

function registered(
  id: string,
  title: string,
  hosts: readonly HostId[] = HOST_IDS,
  toolchain?: ToolchainManifest,
): TargetDescriptor {
  return {
    id,
    title,
    contract: { kind: "registry", target: id, registry: () => POCKET_PLATFORM_CONTRACTS },
    hosts,
    ...(toolchain ? { toolchain } : {}),
  };
}

/** The manifest of a target whose `pocket build` runs the compiler and nothing else. */
function compilerOnly(target: string): ToolchainManifest {
  return { schema: TOOLCHAIN_SCHEMA, target, components: [] };
}

function profile(
  id: string,
  title: string,
  target: string,
  registry: PlatformContractRegistry,
  hosts: readonly HostId[],
): TargetDescriptor {
  return { id, title, contract: { kind: "profile", target, registry: () => registry }, hosts };
}

export const CATALOG: readonly TargetDescriptor[] = [
  registered("pocketbook", "PocketBook e-reader"),
  profile("nokia-e7", "Nokia E7 (Symbian)", SYMBIAN_E7_DEV_TARGET_ID, SYMBIAN_E7_DEV_CONTRACTS, HOST_IDS),
  profile("ios-simulator", "iOS simulator", IOS_DEV_TARGET_ID, IOS_DEV_CONTRACTS, ["darwin-arm64"]),
  profile("ipodtouch6", "iPod touch (6th generation)", IPODTOUCH_DEV_TARGET_ID, IPODTOUCH_DEV_CONTRACTS, MACOS),
  profile("ipodtouch4", "iPod touch (4th generation)", IPODTOUCH4_DEV_TARGET_ID, IPODTOUCH4_DEV_CONTRACTS, MACOS),
  registered("psp", "PlayStation Portable", HOST_IDS, pspToolchain as ToolchainManifest),
  registered("vita", "PlayStation Vita"),
  profile("3ds", "Nintendo 3DS", THREE_DS_DEV_TARGET_ID, THREE_DS_DEV_CONTRACTS, HOST_IDS),
  registered("web-app", "Browser", HOST_IDS, compilerOnly("web-app")),
  registered("macos-widget", "macOS widget", MACOS, compilerOnly("macos-widget")),
];

export { PROFILE_COMMAND_WORDS as COMMAND_WORDS } from "../../hosts/ids.ts";

export function catalogEntry(id: string): TargetDescriptor | undefined {
  return CATALOG.find((descriptor) => descriptor.id === id);
}

/** The catalog entry whose contract target id is `target`, for diagnostics
 *  that receive a contract id where a catalog id belongs. */
export function catalogEntryForContract(target: string): TargetDescriptor | undefined {
  return CATALOG.find((descriptor) => descriptor.contract.target === target);
}
