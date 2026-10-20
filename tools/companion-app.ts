#!/usr/bin/env bun

// Build the Pocket Companion menu-bar app:
//
//   bun tools/companion-app.ts [--outdir <dir>]   -> dist/companion/Pocket Companion.app
//
// Contents/MacOS/PocketCompanion   SwiftUI app (tools/companion/macos/PocketCompanion.swift)
// Contents/MacOS/pocket-companion  the daemon, `bun build --compile tools/companion.ts`
// Contents/MacOS/pocket-transcribe the agent's speech helper (tools/companion/macos/Transcribe.swift)
// Contents/MacOS/pocket-glyphs     the agent's glyph rasterizer (tools/companion/macos/Glyphs.swift)
// Contents/Resources/AppIcon.icns  drawn here, no image assets
//
// The bundle is signed ad hoc (`codesign -s -`). Info.plist names this
// checkout's dist/3ds so the daemon offers the apps built here.

import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { encodePNG } from "./png.ts";

const root = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--outdir");
const outdir = outIndex >= 0 ? resolve(argv[outIndex + 1]) : join(root, "dist", "companion");
const app = join(outdir, "Pocket Companion.app");
const work = join(outdir, "build");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

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
    ["PocketRepoAppsDir", `<string>${join(root, "dist", "3ds")}</string>`],
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
const transcriber = join(work, "pocket-transcribe");
const glyphs = join(work, "pocket-glyphs");
const arch = process.arch === "arm64" ? "arm64" : "x86_64";

console.log("companion-app: compiling the daemon");
await $`bun build --compile ${join(root, "tools", "companion.ts")} --outfile ${daemon}`.quiet();
console.log("companion-app: compiling the Swift app");
await $`swiftc -O -parse-as-library -swift-version 5 -target ${arch}-apple-macos15.0 ${join(root, "tools", "companion", "macos", "PocketCompanion.swift")} -o ${swiftBinary}`;
console.log("companion-app: compiling the speech and glyph helpers");
await $`swiftc -O -parse-as-library -swift-version 5 -target ${arch}-apple-macos15.0 ${join(root, "tools", "companion", "macos", "Transcribe.swift")} -o ${transcriber}`;
await $`swiftc -O -swift-version 5 -target ${arch}-apple-macos15.0 ${join(root, "tools", "companion", "macos", "Glyphs.swift")} -o ${glyphs}`;
console.log("companion-app: drawing the icon");
const icns = await buildIcon(work);

rmSync(app, { recursive: true, force: true });
mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
cpSync(swiftBinary, join(app, "Contents", "MacOS", "PocketCompanion"));
cpSync(daemon, join(app, "Contents", "MacOS", "pocket-companion"));
cpSync(transcriber, join(app, "Contents", "MacOS", "pocket-transcribe"));
cpSync(glyphs, join(app, "Contents", "MacOS", "pocket-glyphs"));
cpSync(icns, join(app, "Contents", "Resources", "AppIcon.icns"));
writeFileSync(join(app, "Contents", "Info.plist"), infoPlist());
writeFileSync(join(app, "Contents", "PkgInfo"), "APPL????");

await $`codesign --force -s - ${join(app, "Contents", "MacOS", "pocket-companion")}`.quiet();
await $`codesign --force -s - ${join(app, "Contents", "MacOS", "pocket-transcribe")}`.quiet();
await $`codesign --force -s - ${join(app, "Contents", "MacOS", "pocket-glyphs")}`.quiet();
await $`codesign --force -s - ${app}`.quiet();
await $`codesign --verify --strict ${app}`.quiet();
if (!existsSync(join(app, "Contents", "MacOS", "PocketCompanion"))) throw new Error("bundle incomplete");
console.log(`companion-app: ${app}`);
