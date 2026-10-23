// Deploy the PocketBook host + a demo app to a device mounted over USB.
//
// Usage:
//   bun programs/pocketbook/deploy.ts [MOUNT_POINT] [APP_NAME]
//
//   MOUNT_POINT  device mount root (default: auto-detect the first PocketBook
//                under /run/media/$USER, /media/$USER, or /Volumes on macOS)
//   APP_NAME     launcher folder name (default: pocketjs-hero)
//
// Prereqs (run from the repo root):
//   # 1. cross-compile the host against the exported pocketbook profile
//   bun tools/pocket.ts profile export --config programs/pocketbook/pocket.runtime-config.ts --out target/pocketbook-profile
//   (cd programs/pocketbook && POCKETJS_PROFILE_RS=$PWD/../../target/pocketbook-profile/pocket_profile.rs \
//     cargo zigbuild --release --target armv7-unknown-linux-gnueabi.2.23)
//   # 2. build the app bundle for the pocketbook target
//   bun run pocket compile --runtime-config programs/pocketbook/pocket.runtime-config.ts --manifest apps/hero/pocket.json --project-root . --outdir dist
//
// The host reads app.js + app.pak from its working directory (override with
// POCKET_JS / POCKET_PAK), so we install them next to the binary.

import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const HOST_BIN = join(
  ROOT,
  "target/armv7-unknown-linux-gnueabi/release/pocketbook-host",
);
const BUNDLE_JS = join(ROOT, "dist/hero-main.js");
const BUNDLE_PAK = join(ROOT, "dist/hero-main.pak");

const [mountArg, appArg] = Bun.argv.slice(2);
const APP_NAME = appArg ?? "pocketjs-hero";

// --- locate the device mount point -----------------------------------------
// A PocketBook exposes an `applications/` dir at its storage root.
function detectMount(): string | undefined {
  const user = process.env.USER ?? "";
  const bases = [`/run/media/${user}`, `/media/${user}`, "/Volumes"];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const candidate = join(base, entry);
      if (existsSync(join(candidate, "applications"))) return candidate;
    }
  }
  return undefined;
}

const MOUNT = mountArg || detectMount();
if (!MOUNT || !existsSync(MOUNT)) {
  console.error("error: no device mount point found. Pass it explicitly:");
  console.error("  bun programs/pocketbook/deploy.ts /run/media/$USER/PB626");
  process.exit(1);
}

// --- sanity-check artifacts -------------------------------------------------
if (!existsSync(HOST_BIN)) {
  console.error(`error: host binary missing — run cargo zigbuild first (${HOST_BIN})`);
  process.exit(1);
}
for (const bundle of [BUNDLE_JS, BUNDLE_PAK]) {
  if (!existsSync(bundle)) {
    console.error(`error: ${bundle} missing — run 'bun pocket compile --target pocketbook …' first`);
    process.exit(1);
  }
}

const DEST = join(MOUNT, "applications", APP_NAME);
const LAUNCHER = join(MOUNT, "applications", `${APP_NAME}.app`);
console.log(`==> deploying to ${DEST}`);
mkdirSync(DEST, { recursive: true });

await copyFile(HOST_BIN, join(DEST, APP_NAME));
await copyFile(BUNDLE_JS, join(DEST, "app.js"));
await copyFile(BUNDLE_PAK, join(DEST, "app.pak"));
chmodSync(join(DEST, APP_NAME), 0o755);

// The .app launcher (PocketBook firmware discovers apps via *.app files and
// runs them through sh — the launcher itself must stay a device-side shell
// script). Logs land next to the binary so they survive over USB.
await Bun.write(
  LAUNCHER,
  `#!/bin/sh
# PocketJS ${APP_NAME} launcher for PocketBook

APP_DIR="/mnt/ext1/applications/${APP_NAME}"
LOG="\${APP_DIR}/pocketjs.log"

cd "\${APP_DIR}" || exit 1
export RUST_LOG="\${RUST_LOG:-info}"
exec ./${APP_NAME} >"\$LOG" 2>&1
`,
);
try {
  chmodSync(LAUNCHER, 0o755); // FAT ignores the exec bit; firmware runs .app via sh
} catch {}

console.log(`==> done. Eject safely, then launch '${APP_NAME}' from the PocketBook launcher.`);
console.log("    (If it doesn't appear, the firmware may need a rescan/restart.)");
