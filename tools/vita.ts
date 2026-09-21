import { $ } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FRAMEWORKS,
  parseFramework,
  type PocketFramework,
} from "../framework/compiler/jsx-plugin.ts";
import type { PocketConfig } from "../framework/src/config.ts";
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
  vitaTitleId,
  type HostBuildInputs,
} from "../framework/src/manifest/index.ts";
import {
  verifyPlanHash,
  type ResolvedBuildPlan,
} from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { demoIdentity, demoManifestFor } from "./demo-identity.ts";
import { packageVitaVpk } from "./vita-package.ts";
import { prepareVitaUsb } from "./vita-usb.ts";

const pspUiDir = new URL("..", import.meta.url).pathname; // PocketJS/
const nativeDir = pspUiDir + "hosts/vita/";
const home = process.env.HOME ?? "";

// ---------------------------------------------------------------------------
// CLI: first bare arg = app name; everything else is passed to cargo vita
// ---------------------------------------------------------------------------

const argv = Bun.argv.slice(2);
let appArg = "";
let capture = false;
let frameworkFlag: string | undefined;
let configPath = pspUiDir + "pocket.config.ts";
let configFlagged = false;
let useConfig = true;
let planPath: string | undefined;
let projectRoot = process.cwd();
let outputDir = pspUiDir + "dist/";
let packageOutputDir: string | undefined;
let skipBuild = false;
let usbDebug = true;
let launcherRegistry = "";
let launcherPackages = "";
const cargoArgs: string[] = [];
const buildFlags: string[] = [];

for (const a of argv) {
  if (a === "--capture") {
    capture = true;
  } else if (a === "--no-usb-debug") {
    usbDebug = false;
  } else if (a.startsWith("--framework=")) {
    frameworkFlag = a.slice("--framework=".length);
    buildFlags.push(a);
  } else if (a.startsWith("--config=")) {
    configPath = resolvePath(pspUiDir, a.slice("--config=".length));
    configFlagged = true;
    buildFlags.push(a);
  } else if (a === "--no-config") {
    useConfig = false;
    buildFlags.push(a);
  } else if (a.startsWith("--plan=")) {
    planPath = resolvePath(a.slice("--plan=".length));
  } else if (a.startsWith("--project-root=")) {
    projectRoot = resolvePath(a.slice("--project-root=".length));
  } else if (a.startsWith("--outdir=")) {
    outputDir = resolvePath(a.slice("--outdir=".length)) + "/";
  } else if (a.startsWith("--package-outdir=")) {
    packageOutputDir = resolvePath(a.slice("--package-outdir=".length));
  } else if (a.startsWith("--launcher-registry=")) {
    launcherRegistry = resolvePath(a.slice("--launcher-registry=".length));
  } else if (a.startsWith("--launcher-packages=")) {
    launcherPackages = resolvePath(a.slice("--launcher-packages=".length));
  } else if (a === "--skip-build") {
    skipBuild = true;
  } else if (!appArg && !a.startsWith("-")) {
    appArg = a;
  } else {
    cargoArgs.push(a);
  }
}

if (!appArg && !planPath) {
  console.error(
    "usage: bun tools/vita.ts <app> [--plan=<resolved-plan.json>] [--capture] " +
      "[--launcher-registry=<tsv> --launcher-packages=<dir>] [cargo args…]   " +
      "e.g. bun tools/vita.ts hero --release",
  );
  process.exit(1);
}
if (Boolean(launcherRegistry) !== Boolean(launcherPackages)) {
  throw new Error(
    "PocketJS vita: --launcher-registry and --launcher-packages must be provided together",
  );
}
if (launcherRegistry && !existsSync(launcherRegistry)) {
  throw new Error(
    `PocketJS vita: launcher registry not found at ${launcherRegistry}`,
  );
}
if (launcherPackages && !existsSync(launcherPackages)) {
  throw new Error(
    `PocketJS vita: launcher packages not found at ${launcherPackages}`,
  );
}

// Prereqs
if (!process.env.VITASDK && !existsSync(`${home}/vitasdk`)) {
  console.error(
    "PocketJS vita: VITASDK environment variable not set. Please set it to your VitaSDK path.",
  );
  process.exit(1);
}

const vitasdk = process.env.VITASDK || `${home}/vitasdk`;
const rustup = Bun.which("rustup") ?? `${home}/.cargo/bin/rustup`;
if (!existsSync(rustup)) {
  console.error(
    "PocketJS vita: rustup not found (expected ~/.cargo/bin/rustup)",
  );
  process.exit(1);
}
if (!existsSync(`${vitasdk}/bin/arm-vita-eabi-gcc`)) {
  console.error(`PocketJS vita: incomplete VitaSDK at ${vitasdk}`);
  process.exit(1);
}

function mountedAppName(arg: string): string {
  const bare = arg.replace(/\.tsx?$/, "").replace(/-main$/, "");
  if (
    existsSync(`${pspUiDir}apps/${bare}/main.tsx`) ||
    existsSync(`${pspUiDir}apps/${bare}-main.tsx`)
  ) {
    return `${bare}-main`;
  }
  return arg;
}

let buildPlan: ResolvedBuildPlan | undefined;
let hostBuildInputs: HostBuildInputs | undefined;
if (planPath) {
  buildPlan = (await Bun.file(planPath).json()) as ResolvedBuildPlan;
  if (!verifyPlanHash(buildPlan) || buildPlan.target.id !== "vita") {
    throw new Error(
      `PocketJS vita: invalid Vita ResolvedBuildPlan at ${planPath}`,
    );
  }
  hostBuildInputs = extractHostBuildInputs(buildPlan, {
    expectedTarget: "vita",
  });
  if (frameworkFlag || configFlagged) {
    throw new Error(
      "PocketJS vita: framework/config overrides are forbidden with --plan",
    );
  }
}

const app = buildPlan
  ? resolvePath(projectRoot, buildPlan.app.entry)
  : appArg
    ? mountedAppName(appArg)
    : "";

async function loadConfig(): Promise<PocketConfig> {
  if (!useConfig || !existsSync(configPath)) return {};
  const url = pathToFileURL(configPath);
  url.searchParams.set("mtime", String(statSync(configPath).mtimeMs));
  const mod = (await import(url.href)) as {
    default?: PocketConfig;
    config?: PocketConfig;
  };
  return mod.default ?? mod.config ?? {};
}

const config = buildPlan ? {} : await loadConfig();
const framework: PocketFramework = buildPlan
  ? parseFramework(buildPlan.app.framework, "ResolvedBuildPlan")
  : frameworkFlag
    ? parseFramework(frameworkFlag, "--framework")
    : parseFramework(config.framework, "pocket.config.ts");
// A resolved plan owns the exact artifact name. Low-level demo builds keep the
// framework suffix so multiple variants can still coexist in dist/.
const outputApp = buildPlan
  ? buildPlan.app.output
  : `${app}${FRAMEWORKS[framework].outputSuffix}`;
const stockDemoName = !buildPlan && appArg ? appArg.replace(/-main$/, "") : "";
const stockDemo =
  stockDemoName && existsSync(`${pspUiDir}apps/${stockDemoName}/main.tsx`)
    ? demoIdentity(stockDemoName)
    : undefined;

// Keep the convenient low-level demo command on the same manifest/plan path
// as `bun play` and custom hosts. Without this, its compiler defaulted to a
// density-1 PSP bundle before the Vita native backend packaged it.
if (!buildPlan && stockDemo) {
  const manifest = demoManifestFor(
    pspUiDir,
    stockDemoName,
    framework,
  ) as Record<string, any>;
  const resolution = validateAndResolveBuildPlan(manifest, { target: "vita" });
  if (!resolution.ok) {
    throw new Error(
      `PocketJS vita: could not resolve stock demo plan: ${resolution.diagnostics
        .map((item) => `${item.path || "/"}: ${item.message}`)
        .join("; ")}`,
    );
  }
  buildPlan = resolution.plan;
  hostBuildInputs = extractHostBuildInputs(buildPlan, {
    expectedTarget: "vita",
  });
  planPath = `${pspUiDir}.pocket/vita-low-level/${outputApp}.plan.json`;
  mkdirSync(resolvePath(planPath, ".."), { recursive: true });
  await Bun.write(planPath, JSON.stringify(buildPlan, null, 2) + "\n");
}
const applicationId =
  buildPlan?.app.id ??
  stockDemo?.id ??
  `dev.pocket-stack.legacy.${outputApp.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
const packageTitle =
  buildPlan?.app.title ?? stockDemo?.title ?? `PocketJS ${outputApp}`;
const titleId = vitaTitleId(applicationId);
const nativeBuild = randomBytes(16).toString("hex");
const usb = usbDebug ? await prepareVitaUsb() : undefined;

// ---------------------------------------------------------------------------
// 1. Build the app bundle + pak -> dist/<app>.js + dist/<app>.pak
// ---------------------------------------------------------------------------

console.log(`PocketJS vita: building app "${app}" (framework=${framework})`);
if (!skipBuild) {
  if (buildPlan) {
    await $`bun tools/build.ts --plan=${planPath!} --project-root=${projectRoot} --outdir=${outputDir}`.cwd(pspUiDir);
  } else {
    await $`bun tools/build.ts ${app} ${buildFlags}`.cwd(pspUiDir);
  }
}

// ---------------------------------------------------------------------------
// 2. cargo vita build vpk
// ---------------------------------------------------------------------------

const nativeInputs: HostBuildInputs = hostBuildInputs ?? {
  appOutput: outputApp,
  target: "vita",
  hostAbi: 2,
  viewport: {
    logical: [480, 272],
    physical: [960, 544],
    presentation: "integer-fit",
    rasterDensity: 2,
  },
};

const env = {
  ...process.env,
  // cargo-vita probes `rustc` from PATH even when cargo itself was launched
  // through `rustup run`. Keep the rustup shim ahead of Homebrew's stable
  // compiler and expose VitaSDK tools without requiring shell dotfiles.
  PATH: `${vitasdk}/bin:${home}/.cargo/bin:${process.env.PATH ?? ""}`,
  VITASDK: vitasdk,
  // cargo-vita uses this only when the reusable runtime crate deliberately
  // omits a static title_id. Pocket's stable manifest id owns installation
  // identity; every demo therefore gets its own LiveArea application.
  VITA_DEFAULT_TITLE_ID: titleId,
  POCKETJS_VITA_TITLE_ID: titleId,
  POCKETJS_VITA_PLAN: planPath ?? "",
  POCKETJS_NATIVE_BUILD: nativeBuild,
  ...hostBuildEnvironment(nativeInputs, {
    outputDirectory: outputDir,
    embedApp: true,
  }),
  TARGET_AR: "arm-vita-eabi-ar",
  AR_armv7_sony_vita_newlibeabihf: "arm-vita-eabi-ar",
  TARGET_CC: "arm-vita-eabi-gcc",
  CC_armv7_sony_vita_newlibeabihf: "arm-vita-eabi-gcc",
  TARGET_CXX: "arm-vita-eabi-g++",
  CXX_armv7_sony_vita_newlibeabihf: "arm-vita-eabi-g++",
  POCKETJS_CAPTURE_INPUT: process.env.POCKETJS_CAPTURE_INPUT ?? "",
  POCKETJS_CAPTURE_TOUCH: process.env.POCKETJS_CAPTURE_TOUCH ?? "",
  POCKETJS_CAPTURE_FRAMES: process.env.POCKETJS_CAPTURE_FRAMES ?? "",
  POCKETJS_CAPTURE_DIR:
    process.env.POCKETJS_CAPTURE_DIR ?? "ux0:data/pocketjs-captures",
  // Multi-app launcher embed. Empty values preserve the single-app runtime.
  POCKETJS_LAUNCHER_REGISTRY: launcherRegistry,
  POCKETJS_LAUNCHER_PACKAGES: launcherPackages,
};

if (capture) cargoArgs.push("--features", "capture");
if (!usbDebug) cargoArgs.push("--no-default-features");

console.log(
  `PocketJS vita: cargo vita build vpk (app=${outputApp}${capture ? ", capture" : ""})`,
);
// Forward to cargo-vita
await $`${rustup} run nightly-2026-05-28 cargo vita build vpk ${cargoArgs}`
  .cwd(nativeDir)
  .env(env);

// cargo-vita has a target-id fallback but no corresponding dynamic title-name
// fallback. Recreate only the package metadata and VPK here so both values
// come from the same ResolvedBuildPlan; the native executable is unchanged.
const profile =
  cargoArgs.includes("--release") || cargoArgs.includes("-r")
    ? "release"
    : "debug";
const targetDirectory = `${nativeDir}target/armv7-sony-vita-newlibeabihf/${profile}`;
const eboot = `${targetDirectory}/pocketjs-vita.self`;
const sfo = `${targetDirectory}/pocketjs-vita.sfo`;
const vpk = `${targetDirectory}/pocketjs-vita.vpk`;
if (!existsSync(eboot))
  throw new Error(`PocketJS vita: eboot not found at ${eboot}`);

// cargo-vita defaults to a safe SELF. Kernel driver loading and writing the
// inactive native slot require the standard unsafe-homebrew SELF permissions.
if (usbDebug) {
  await $`${vitasdk}/bin/vita-make-fself ${targetDirectory}/pocketjs-vita.velf ${eboot}`;
}

await $`${vitasdk}/bin/vita-mksfoex -d ATTRIBUTE2=12 -s TITLE_ID=${titleId} ${packageTitle} ${sfo}`;
await packageVitaVpk({
  tool: `${vitasdk}/bin/vita-pack-vpk`,
  sfo,
  eboot,
  output: vpk,
  usbDriver: usb?.driver,
});

const packagedDirectory = packageOutputDir ?? resolvePath(outputDir, "vita");
const packaged = resolvePath(packagedDirectory, `${outputApp}.vpk`);
mkdirSync(packagedDirectory, { recursive: true });
cpSync(vpk, packaged);
const packagedSelf = resolvePath(packagedDirectory, `${outputApp}.self`);
cpSync(eboot, packagedSelf);
await Bun.write(resolvePath(packagedDirectory, `${outputApp}.runtime.json`), JSON.stringify({
  version: 1, titleId, applicationId, output: outputApp, nativeBuild, plan: buildPlan ?? null,
  self: `${outputApp}.self`, usbDebug, usbDriver: usb?.fingerprint,
  selfSha256: createHash("sha256").update(Buffer.from(await Bun.file(packagedSelf).arrayBuffer())).digest("hex"),
}, null, 2) + "\n");
console.log(`PocketJS vita: package ${titleId} (${applicationId})`);
console.log(`output: ${packaged}`);
