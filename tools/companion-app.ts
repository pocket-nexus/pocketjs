#!/usr/bin/env bun

// Build the Pocket Companion app:
//
//   bun tools/companion-app.ts [--outdir <dir>]   -> dist/companion/Pocket Companion.app
//
//   --apps <dir>         put the .pocket files of <dir> in Contents/Resources/apps:
//                        the applets the app offers by itself (repeatable)
//   --release            leave this checkout out of the bundle (no PocketRepoAppsDir)
//   --universal          one bundle for Apple silicon and Intel (lipo)
//   --version <v>        CFBundleShortVersionString (default: package.json's)
//   --sign <identity>    sign with a Developer ID and the hardened runtime
//                        (default: ad hoc, `codesign -s -`)
//   --notarize <profile> send the signed app to Apple's notary service with the
//                        notarytool keychain profile <profile>, then staple it
//   --zip <file>         write the app as a zip (ditto), after notarizing
//
// Contents/MacOS/PocketCompanion   SwiftUI app (tools/companion/macos/PocketCompanion.swift)
// Contents/MacOS/pocket-companion  the daemon, `bun build --compile tools/companion.ts`
// Contents/MacOS/pocket-transcribe the agent's speech helper (tools/companion/macos/Transcribe.swift)
// Contents/MacOS/pocket-glyphs     the agent's glyph rasterizer (tools/companion/macos/Glyphs.swift)
// Contents/MacOS/pocket-websignin  a service's sign-in window (tools/companion/macos/WebSignIn.swift)
// Contents/Resources/AppIcon.icns  drawn here, no image assets
// Contents/Resources/apps/         the applets of --apps
//
// Without --release, Info.plist names this checkout's dist/3ds so the daemon
// also offers the apps built here.

import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { encodePNG } from "./png.ts";

const root = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const options = (name: string): string[] => argv.flatMap((arg, index) => (arg === name && argv[index + 1] ? [argv[index + 1]] : []));
const outdir = resolve(option("--outdir") ?? join(root, "dist", "companion"));
const app = join(outdir, "Pocket Companion.app");
const work = join(outdir, "build");
const version = option("--version") ?? (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const release = argv.includes("--release");
const universal = argv.includes("--universal");
const identity = option("--sign");
const notaryProfile = option("--notarize");
const zipOut = option("--zip");
const appDirs = options("--apps").map((dir) => resolve(dir));
if (notaryProfile && !identity) throw new Error("companion-app: --notarize needs --sign <Developer ID identity>");

if (process.platform !== "darwin") {
  console.error("companion-app: the menu-bar app builds on macOS only");
  process.exit(1);
}

// --- icon ------------------------------------------------------------------------

/** Signed distance to a rounded rectangle centred at the origin. */
function roundedRect(x: number, y: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(x) - hw + r;
  const qy = Math.abs(y) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Plum tile with two interlocked link rings, anti-aliased by distance. */
function drawIcon(size: number): Buffer {
  const rgba = new Uint8Array(size * size * 4);
  const s = size / 1024;
  const plumTop = [0x2a, 0x1d, 0x3d];
  const plumBottom = [0x17, 0x12, 0x26];
  const ring = [0xf4, 0xee, 0xff];
  const accent = [0xff, 0x9f, 0x5a];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / s - 512;
      const y = (py + 0.5) / s - 512;
      const px1 = 1 / s; // one output pixel in icon units
      const aa = (d: number) => Math.min(1, Math.max(0, 0.5 - d / px1));
      const tile = aa(roundedRect(x, y, 412, 412, 92));
      if (tile <= 0) continue;
      const t = (y + 412) / 824;
      let c = plumTop.map((v, i) => v + (plumBottom[i] - v) * t);
      // Rings: rotate 45°, two rounded-rect outlines offset along the axis.
      const rx = (x + y) / Math.SQRT2;
      const ry = (y - x) / Math.SQRT2;
      const ringA = Math.abs(roundedRect(rx + 110, ry, 190, 105, 105)) - 34;
      const ringB = Math.abs(roundedRect(rx - 110, ry, 190, 105, 105)) - 34;
      // Interlock: ring B under ring A on the upper half, over it on the lower half.
      const a = aa(ringA);
      const b = aa(ringB);
      const mix = (from: number[], to: number[], k: number) => from.map((v, i) => v + (to[i] - v) * k);
      c = mix(c, accent, b);
      c = mix(c, ring, a);
      if (ry >= 0) c = mix(c, accent, b);
      const o = (py * size + px) * 4;
      rgba[o] = Math.round(c[0]);
      rgba[o + 1] = Math.round(c[1]);
      rgba[o + 2] = Math.round(c[2]);
      rgba[o + 3] = Math.round(255 * tile);
    }
  }
  return encodePNG(rgba, size, size);
}

async function buildIcon(dir: string): Promise<string> {
  const iconset = join(dir, "AppIcon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const base of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${base}x${base}.png`), drawIcon(base));
    writeFileSync(join(iconset, `icon_${base}x${base}@2x.png`), drawIcon(base * 2));
  }
  const icns = join(dir, "AppIcon.icns");
  await $`iconutil -c icns ${iconset} -o ${icns}`.quiet();
  return icns;
}

// --- bundle ----------------------------------------------------------------------

function infoPlist(): string {
  const entries: [string, string][] = [
    ["CFBundleIdentifier", "<string>dev.pocket-nexus.companion</string>"],
    ["CFBundleName", "<string>Pocket Companion</string>"],
    ["CFBundleDisplayName", "<string>Pocket Companion</string>"],
    ["CFBundleExecutable", "<string>PocketCompanion</string>"],
    ["CFBundleIconFile", "<string>AppIcon</string>"],
    ["CFBundlePackageType", "<string>APPL</string>"],
    ["CFBundleShortVersionString", `<string>${version}</string>`],
    ["CFBundleVersion", `<string>${version}</string>`],
    ["LSMinimumSystemVersion", "<string>15.0</string>"],
    ["LSUIElement", "<true/>"],
    ["NSHighResolutionCapable", "<true/>"],
    ["NSLocalNetworkUsageDescription", "<string>Pocket Companion listens for paired game consoles on your local network and announces itself to them.</string>"],
    ...(release ? [] : ([["PocketRepoAppsDir", `<string>${join(root, "dist", "3ds")}</string>`]] as [string, string][])),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries.map(([k, v]) => `  <key>${k}</key>\n  ${v}`).join("\n")}
</dict>
</plist>
`;
}

mkdirSync(work, { recursive: true });
const daemon = join(work, "pocket-companion");
const swiftBinary = join(work, "PocketCompanion");
/** The Swift helpers beside the app in Contents/MacOS; `main` marks a source
 *  whose entry point is an @main type (swiftc -parse-as-library). */
const helpers = [
  { name: "pocket-transcribe", source: "Transcribe.swift", main: true },
  { name: "pocket-glyphs", source: "Glyphs.swift", main: false },
  { name: "pocket-websignin", source: "WebSignIn.swift", main: false },
];
const arches = universal ? ["arm64", "x86_64"] : [process.arch === "arm64" ? "arm64" : "x86_64"];
/** Bun's compile target for an architecture. Every Intel Mac that runs macOS 15 has AVX2; under Rosetta the Intel daemon prints Bun's AVX warning and runs. */
const BUN_TARGETS: Record<string, string> = { arm64: "bun-darwin-arm64", x86_64: "bun-darwin-x64" };

/** Build `out` once per architecture and join the slices with lipo. */
async function fat(out: string, build: (arch: string, slice: string) => Promise<unknown>) {
  const slices: string[] = [];
  for (const arch of arches) {
    const slice = arches.length > 1 ? `${out}-${arch}` : out;
    await build(arch, slice);
    slices.push(slice);
  }
  if (slices.length > 1) await $`lipo -create ${slices} -output ${out}`.quiet();
}

const swiftc = (source: string, out: string, main: boolean) =>
  fat(out, (arch, slice) => $`swiftc -O ${main ? ["-parse-as-library"] : []} -swift-version 5 -target ${arch}-apple-macos15.0 ${join(root, "tools", "companion", "macos", source)} -o ${slice}`);

console.log(`companion-app: compiling the daemon (${arches.join(", ")})`);
await fat(daemon, (arch, slice) => $`bun build --compile --target=${BUN_TARGETS[arch]} ${join(root, "tools", "companion.ts")} --outfile ${slice}`.quiet());
console.log("companion-app: compiling the Swift app");
await swiftc("PocketCompanion.swift", swiftBinary, true);
console.log("companion-app: compiling the speech, glyph and sign-in helpers");
for (const helper of helpers) await swiftc(helper.source, join(work, helper.name), helper.main);
console.log("companion-app: drawing the icon");
const icns = await buildIcon(work);

const macos = join(app, "Contents", "MacOS");
const resources = join(app, "Contents", "Resources");
/** The executables signed one by one before the bundle. */
const executables = ["pocket-companion", ...helpers.map((helper) => helper.name)];
rmSync(app, { recursive: true, force: true });
mkdirSync(macos, { recursive: true });
mkdirSync(resources, { recursive: true });
cpSync(swiftBinary, join(macos, "PocketCompanion"));
for (const name of executables) cpSync(join(work, name), join(macos, name));
cpSync(icns, join(resources, "AppIcon.icns"));
writeFileSync(join(app, "Contents", "Info.plist"), infoPlist());
writeFileSync(join(app, "Contents", "PkgInfo"), "APPL????");

if (appDirs.length > 0) {
  const bundled = join(resources, "apps");
  mkdirSync(bundled, { recursive: true });
  for (const dir of appDirs) {
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".pocket"))) cpSync(join(dir, name), join(bundled, name));
  }
  console.log(`companion-app: ${readdirSync(bundled).length} applets in Contents/Resources/apps`);
}

// A compiled Bun program writes machine code at run time: under the hardened
// runtime it needs JIT memory, and its own environment variables (BUN_BE_BUN).
const DAEMON_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-executable-page-protection</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
`;
const entitlements = join(work, "daemon.entitlements");
writeFileSync(entitlements, DAEMON_ENTITLEMENTS);

const sign = (path: string, extra: string[] = []) =>
  identity
    ? $`codesign --force --timestamp --options runtime ${extra} -s ${identity} ${path}`.quiet()
    : $`codesign --force -s - ${path}`.quiet();
for (const name of executables) await sign(join(macos, name), name === "pocket-companion" && identity ? ["--entitlements", entitlements] : []);
await sign(app);
await $`codesign --verify --strict --deep ${app}`.quiet();
if (!existsSync(join(macos, "PocketCompanion"))) throw new Error("bundle incomplete");
console.log(`companion-app: ${app}${identity ? ` (signed: ${identity})` : " (ad hoc)"}`);

if (notaryProfile) {
  const upload = join(work, "notarize.zip");
  rmSync(upload, { force: true });
  await $`ditto -c -k --keepParent ${app} ${upload}`.quiet();
  console.log("companion-app: waiting for Apple's notary service");
  const result = await $`xcrun notarytool submit ${upload} --keychain-profile ${notaryProfile} --wait`.nothrow().text();
  console.log(result.trim());
  if (!/status: Accepted/.test(result)) throw new Error("companion-app: notarization was not accepted (xcrun notarytool log <id> --keychain-profile <profile> shows why)");
  await $`xcrun stapler staple ${app}`.quiet();
  await $`spctl --assess --type execute --verbose ${app}`;
}

if (zipOut) {
  const out = resolve(zipOut);
  rmSync(out, { force: true });
  await $`ditto -c -k --keepParent ${app} ${out}`.quiet();
  console.log(`companion-app: ${out}`);
}
