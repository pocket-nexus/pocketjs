// tools/repack/ipod.ts — a game's iPod touch 4 `.ipa` from the generic
// runtime (tools/runtime/ipod.ts) and the game's `.pocket`, in TypeScript.
//
//   Payload/Studio<Name>.app/
//     Studio<Name>              the runtime's executable, byte for byte
//     Info.plist                written here: bundle id, name, version, icons
//     PkgInfo
//     Icon-<hash>.png           57 px from identity.icon (or the runtime's)
//     Icon-<hash>@2x.png        114 px
//     Default@2x.png            the runtime's launch images
//     Default-568h@2x.png
//     app.pocket                the game, thinned to its ipodtouch4-dev variant
//     build-receipt.json        what tools/ipodtouch4.ts checks after install
//
// The zip is tools/repack/shared/zip.ts's: 1980-01-01 entry times, Unix
// modes (the executable 0755), PNGs stored and the rest deflated.
//
// The executable is signed ad hoc once, when the runtime is built, with
// nothing beside it: its code signature covers the code pages, binds no
// Info.plist and seals no resources (`codesign -d` says "Info.plist=not
// bound", "Sealed Resources=none"), so a new Info.plist, icons and app.pocket
// leave it valid. The bundle has no _CodeSignature; the device installs it
// through AppSync Unified as it installs every PocketJS iPod build. The icon
// names carry a hash of the 57 px PNG, so an update with a new icon is not
// shown from SpringBoard's icon cache.

import { decodePng, encodePng } from "./shared/png.ts";
import { flattenRgba, squareIcon } from "./shared/scale.ts";
import {
  admitPocket,
  checkIdentity,
  readRuntime,
  sha256Hex,
  type RepackIdentity,
  type RepackInput,
} from "./shared/runtime.ts";
import { writeZip, type ZipInput } from "./shared/zip.ts";

export const IPOD_RUNTIME_TARGET = "ipodtouch4-dev";
export const IPOD_RUNTIME_EXECUTABLE = "PocketJSRuntime";
export const IPOD_RUNTIME_FILES = [
  IPOD_RUNTIME_EXECUTABLE,
  "Icon.png",
  "Icon@2x.png",
  "Default@2x.png",
  "Default-568h@2x.png",
  "PkgInfo",
] as const;

/** The panel's logical surfaces at density 2: portrait, and landscape (the host rotates its view). */
const SURFACES = [[320, 480], [480, 320]] as const;
const ICON_BACKGROUND = [0x05, 0x08, 0x0c] as const;

/** "Snack Snake" -> "SnackSnake", as pocket-studio names its bundles; the id's last segment when the title has no ASCII letters. */
export function bundleBaseName(identity: Pick<RepackIdentity, "title" | "id">): string {
  const pascal = (text: string) =>
    text.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean)
      .map((word) => word[0]!.toUpperCase() + word.slice(1)).join("");
  const name = pascal(identity.title) || pascal(identity.id.split(".").at(-1) ?? "") || "Game";
  return `Studio${name}`;
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** CFBundleVersion takes the leading numbers of the version ("1.2.0-beta" -> "1.2.0"). */
export function bundleVersion(version: string): string {
  return /^\d+(?:\.\d+){0,2}/.exec(version.trim())?.[0] ?? "0";
}

export function writeInfoPlist(fields: {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly executable: string;
  readonly icon: string;
  readonly retinaIcon: string;
}): Uint8Array {
  const string = (key: string, value: string) => `  <key>${key}</key>\n  <string>${xml(value)}</string>\n`;
  const array = (key: string, values: readonly string[]) =>
    `  <key>${key}</key>\n  <array>\n${values.map((value) => `    <string>${xml(value)}</string>\n`).join("")}  </array>\n`;
  const yes = (key: string) => `  <key>${key}</key>\n  <true/>\n`;
  const body =
    string("CFBundleDevelopmentRegion", "English") +
    string("CFBundleDisplayName", fields.title) +
    string("CFBundleExecutable", fields.executable) +
    string("CFBundleIconFile", fields.icon) +
    array("CFBundleIconFiles", [fields.icon, fields.retinaIcon]) +
    string("CFBundleIdentifier", fields.id) +
    string("CFBundleInfoDictionaryVersion", "6.0") +
    string("CFBundleName", fields.title) +
    string("CFBundlePackageType", "APPL") +
    string("CFBundleShortVersionString", fields.version) +
    string("CFBundleSignature", "????") +
    array("CFBundleSupportedPlatforms", ["iPhoneOS"]) +
    `  <key>CFBundleURLTypes</key>\n  <array>\n    <dict>\n      <key>CFBundleURLName</key>\n      <string>${xml(fields.id)}.launch</string>\n` +
    `      <key>CFBundleURLSchemes</key>\n      <array>\n        <string>${xml(fields.id.toLowerCase())}</string>\n      </array>\n    </dict>\n  </array>\n` +
    string("CFBundleVersion", bundleVersion(fields.version)) +
    yes("LSRequiresIPhoneOS") +
    string("MinimumOSVersion", "6.0") +
    `  <key>UIDeviceFamily</key>\n  <array>\n    <integer>1</integer>\n  </array>\n` +
    string("UILaunchImageFile", "Default") +
    yes("UIPrerenderedIcon") +
    yes("UIRequiresFullScreen") +
    yes("UIStatusBarHidden") +
    array("UISupportedInterfaceOrientations", ["UIInterfaceOrientationPortrait"]);
  return new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      `<plist version="1.0">\n<dict>\n${body}</dict>\n</plist>\n`,
  );
}

/** 57 and 114 px opaque PNGs from the identity's icon. */
export async function ipodIcons(icon: Uint8Array): Promise<{ icon: Uint8Array; retina: Uint8Array }> {
  const image = await decodePng(icon);
  const make = (size: number) => encodePng(flattenRgba(squareIcon(image, size), ICON_BACKGROUND), { opaque: true });
  return { icon: await make(57), retina: await make(114) };
}

export async function repackIPod(input: RepackInput): Promise<Uint8Array> {
  checkIdentity(input.identity);
  const runtime = await readRuntime(input.runtime, IPOD_RUNTIME_TARGET);
  const host = runtime.host ?? {};
  if (host.executable !== IPOD_RUNTIME_EXECUTABLE || !/^[0-9a-f]{32}$/.test(host.buildId ?? "") || !host.deploymentTarget) {
    throw new Error("repack ipod: runtime.json has no host build id, executable and deployment target");
  }
  for (const name of IPOD_RUNTIME_FILES) {
    if (!(name in runtime.files)) throw new Error(`repack ipod: the runtime does not list ${name}`);
  }
  const pocket = admitPocket(input.pocket, runtime, input.identity);
  const viewport = pocket.plan.viewport as { logical?: number[]; physical?: number[]; rasterDensity?: number } | undefined;
  const logical = viewport?.logical ?? [];
  if (!SURFACES.some(([width, height]) => logical[0] === width && logical[1] === height) || viewport?.rasterDensity !== 2) {
    throw new Error("repack ipod: the game's plan is not 320x480 or 480x320 at density 2");
  }
  const companions = pocket.plan.companions;
  if (Array.isArray(companions) && companions.length > 0) {
    throw new Error("repack ipod: the game needs companion services, which the iPod runtime does not carry");
  }

  const { id, title, version } = input.identity;
  const base = bundleBaseName(input.identity);
  const bundle = `Payload/${base}.app/`;
  const file = (name: string) => input.runtime.get(name)!;
  const icons = input.identity.icon
    ? await ipodIcons(input.identity.icon)
    : { icon: file("Icon.png"), retina: file("Icon@2x.png") };
  const iconTag = (await sha256Hex(icons.icon)).slice(0, 8);
  const iconName = `Icon-${iconTag}.png`;
  const retinaName = `Icon-${iconTag}@2x.png`;
  const files = new Map<string, Uint8Array>([
    [base, file(IPOD_RUNTIME_EXECUTABLE)],
    ["Info.plist", writeInfoPlist({ id, title, version, executable: base, icon: iconName, retinaIcon: retinaName })],
    ["PkgInfo", file("PkgInfo")],
    [iconName, icons.icon],
    [retinaName, icons.retina],
    ["Default@2x.png", file("Default@2x.png")],
    ["Default-568h@2x.png", file("Default-568h@2x.png")],
    ["app.pocket", pocket.bytes],
  ]);
  const digests: Record<string, string> = {};
  for (const name of [...files.keys()].sort()) digests[name] = await sha256Hex(files.get(name)!);
  const receipt = {
    schema: 1,
    buildId: host.buildId,
    bundleId: id,
    target: runtime.target,
    hostAbi: runtime.hostAbi,
    deploymentTarget: host.deploymentTarget,
    files: digests,
    viewport: {
      logical: [logical[0], logical[1]],
      physical: viewport?.physical ?? [logical[0]! * 2, logical[1]! * 2],
      rasterDensity: 2,
    },
  };
  files.set("build-receipt.json", new TextEncoder().encode(`${JSON.stringify(receipt, null, 2)}\n`));

  const entries: ZipInput[] = [
    { name: "Payload/", data: new Uint8Array(0), compress: false },
    { name: bundle, data: new Uint8Array(0), compress: false },
  ];
  for (const name of [...files.keys()].sort()) {
    entries.push({
      name: bundle + name,
      data: files.get(name)!,
      // The executable must arrive as 0755; PNGs are compressed already.
      ...(name === base ? { unixMode: 0o100755 } : {}),
      compress: !name.endsWith(".png"),
    });
  }
  return writeZip(entries);
}
