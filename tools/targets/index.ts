// tools/targets/index.ts — the target catalog: every target `pocket` builds
// for, by the name commands select it with.
//
// Registered targets keep their registry ids. Device profiles are selected by a
// device name and map to their unchanged contract ids, which native hosts
// declare (`__host`) and runtimes compile in to pick a `.pocket` variant.

import { POCKET_PLATFORM_CONTRACTS, type PlatformContractRegistry } from "../../contracts/spec/platforms.ts";
import { THREE_DS_DEV_CONTRACTS, THREE_DS_DEV_TARGET_ID } from "../3ds-profile.ts";
import { MOTO_G_PLAY_CONTRACTS, MOTO_G_PLAY_TARGET } from "../moto-g-play-profile.ts";
import { REDMI_1S_CONTRACTS, REDMI_1S_TARGET } from "../redmi-1s-profile.ts";
import { BLACKBERRY_CLASSIC_DEV_CONTRACTS, BLACKBERRY_QNX_DEV_TARGET_ID } from "../blackberry-classic-profile.ts";
import { MEIZU_M8_DEV_CONTRACTS, MEIZU_M8_DEV_TARGET_ID } from "../meizu-m8-profile.ts";
import { SYMBIAN_E7_DEV_CONTRACTS, SYMBIAN_E7_DEV_TARGET_ID } from "../symbian-profile.ts";
import { IOS_DEV_CONTRACTS, IOS_DEV_TARGET_ID } from "../ios-profile.ts";
import { IPHONE2G_DEV_CONTRACTS, IPHONE2G_DEV_TARGET_ID } from "../iphone2g-profile.ts";
import { IPHONE4S_DEV_CONTRACTS, IPHONE4S_DEV_TARGET_ID } from "../iphone4s-profile.ts";
import { IPODTOUCH_DEV_CONTRACTS, IPODTOUCH_DEV_TARGET_ID } from "../ipodtouch-profile.ts";
import { IPODTOUCH4_DEV_CONTRACTS, IPODTOUCH4_DEV_TARGET_ID } from "../ipodtouch4-profile.ts";
import pspToolchain from "./psp.toolchain.json";
import { TOOLCHAIN_SCHEMA, type ToolchainManifest } from "./toolchain.ts";
import { HOST_IDS, type HostId, type TargetDescriptor } from "./types.ts";

const MACOS: readonly HostId[] = ["darwin-arm64", "darwin-x64"];
const LINUX: readonly HostId[] = ["linux-x64", "linux-arm64"];
// The Android NDK publishes darwin-x86_64 and linux-x86_64 host tools;
// Apple silicon runs the macOS ones under Rosetta.
const ANDROID_NDK: readonly HostId[] = ["darwin-arm64", "darwin-x64", "linux-x64"];

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
  registered("pocketbook", "PocketBook e-reader"),
  registered("web-app", "Browser", HOST_IDS, compilerOnly("web-app")),
  registered("macos-app", "macOS app", MACOS, compilerOnly("macos-app")),
  registered("linux-app", "Linux app", LINUX, compilerOnly("linux-app")),
  registered("macos-widget", "macOS widget", MACOS, compilerOnly("macos-widget")),
  profile("moto-g-play", "Moto G Play (Android)", MOTO_G_PLAY_TARGET, MOTO_G_PLAY_CONTRACTS, ANDROID_NDK),
  profile("redmi-1s", "Redmi 1S (Android)", REDMI_1S_TARGET, REDMI_1S_CONTRACTS, ANDROID_NDK),
  profile("blackberry-classic", "BlackBerry Classic (QNX)", BLACKBERRY_QNX_DEV_TARGET_ID, BLACKBERRY_CLASSIC_DEV_CONTRACTS, HOST_IDS),
  profile("meizu-m8", "Meizu M8 (Windows CE)", MEIZU_M8_DEV_TARGET_ID, MEIZU_M8_DEV_CONTRACTS, HOST_IDS),
  profile("nokia-e7", "Nokia E7 (Symbian)", SYMBIAN_E7_DEV_TARGET_ID, SYMBIAN_E7_DEV_CONTRACTS, HOST_IDS),
  profile("ios-simulator", "iOS simulator", IOS_DEV_TARGET_ID, IOS_DEV_CONTRACTS, ["darwin-arm64"]),
  profile("iphone2g", "iPhone (2007)", IPHONE2G_DEV_TARGET_ID, IPHONE2G_DEV_CONTRACTS, MACOS),
  profile("iphone4s", "iPhone 4S", IPHONE4S_DEV_TARGET_ID, IPHONE4S_DEV_CONTRACTS, MACOS),
  profile("ipodtouch6", "iPod touch (6th generation)", IPODTOUCH_DEV_TARGET_ID, IPODTOUCH_DEV_CONTRACTS, MACOS),
  profile("ipodtouch4", "iPod touch (4th generation)", IPODTOUCH4_DEV_TARGET_ID, IPODTOUCH4_DEV_CONTRACTS, MACOS),
];

/** Words `pocket` uses for its own commands; a catalog id or a host profile id
 *  may not be one of them. */
export const COMMAND_WORDS: readonly string[] = [
  "build", "check", "compile", "component", "create", "default", "deploy", "devtools", "exec", "help",
  "override", "run", "show", "tape", "target", "which",
  // commands of the baseline CLI that are not target names
  "dev", "doctor", "hw", "play", "psplink", "setup",
];

export function catalogEntry(id: string): TargetDescriptor | undefined {
  return CATALOG.find((descriptor) => descriptor.id === id);
}

/** The catalog entry whose contract target id is `target`, for diagnostics
 *  that receive a contract id where a catalog id belongs. */
export function catalogEntryForContract(target: string): TargetDescriptor | undefined {
  return CATALOG.find((descriptor) => descriptor.contract.target === target);
}
