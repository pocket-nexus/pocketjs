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
const LINUX: readonly HostId[] = ["linux-x64", "linux-arm64"];

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
  registered("psp", "PlayStation Portable", HOST_IDS, pspToolchain as ToolchainManifest),
  registered("vita", "PlayStation Vita"),
  profile("3ds", "Nintendo 3DS", THREE_DS_DEV_TARGET_ID, THREE_DS_DEV_CONTRACTS, HOST_IDS),
  registered("web-app", "Browser", HOST_IDS, compilerOnly("web-app")),
  registered("macos-app", "macOS app", MACOS, compilerOnly("macos-app")),
  registered("linux-app", "Linux app", LINUX, compilerOnly("linux-app")),
  registered("macos-widget", "macOS widget", MACOS, compilerOnly("macos-widget")),
];

export { PROFILE_COMMAND_WORDS as COMMAND_WORDS } from "../../profiles/ids.ts";

export function catalogEntry(id: string): TargetDescriptor | undefined {
  return CATALOG.find((descriptor) => descriptor.id === id);
}

/** The catalog entry whose contract target id is `target`, for diagnostics
 *  that receive a contract id where a catalog id belongs. */
export function catalogEntryForContract(target: string): TargetDescriptor | undefined {
  return CATALOG.find((descriptor) => descriptor.contract.target === target);
}
