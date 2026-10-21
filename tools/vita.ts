import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
// tools/vita.ts <app> | --plan=<plan.json> [--no-usb-debug] [--capture] [cargo args…]
// tools/vita.ts --runtime [--title=TITLEID] [--no-usb-debug] [cargo args…]
//
// --runtime builds the generic runtime (cargo feature `runtime`): no app is
// built or embedded, and the program reads app0:app.pocket at startup.
// tools/runtime/vita.ts runs it with --no-usb-debug --release and collects
// eboot.bin; --title addresses a USB-debug build to an installed container
// such as Pocket Devkit (P25BFE5E2) for `vita:dev native`.

import { $ } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import {
  FRAMEWORK_CHOICES as FRAMEWORKS,
  parseFramework,
  type PocketFramework,
} from "../framework/compiler/framework-choice.ts";
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
import { mountedSourceApp, resolveSourceEntry, sourceAppContent, sourceOutputName } from "./source-app.ts";
import softwareProfile from "../profiles/vita.ts";
import type { RuntimeBuildContext } from "../framework/src/runtime-config.ts";
import { RUST_TOOLCHAINS } from "./build/toolchains/rust.ts";
import { hashPocketProfile } from "../framework/src/profile.ts";

const pspUiDir = new URL("..", import.meta.url).pathname; // PocketJS/
const nativeDir = pspUiDir + "programs/vita/";
const home = process.env.HOME ?? "";

// ---------------------------------------------------------------------------
// CLI: first bare arg = app name; everything else is passed to cargo build
// ---------------------------------------------------------------------------

export async function buildVita(argv: readonly string[], context?: RuntimeBuildContext): Promise<string> {
let appArg = "";
let capture = false;
let frameworkFlag: string | undefined;
let planPath: string | undefined;
let projectRoot = process.cwd();
let outputDir = pspUiDir + "dist/";
let packageOutputDir: string | undefined;
let skipBuild = false;
let usbDebug = true;
let launcherRegistry = "";
let launcherPackages = "";
let runtime = false;
let titleOverride: string | undefined;
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
  } else if (a.startsWith("--config=") || a === "--no-config") {
    throw new Error("pocket.config.ts was removed; use pocket.json app.framework and app.theme");
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
  } else if (a === "--runtime") {
    runtime = true;
  } else if (a.startsWith("--title=")) {
    titleOverride = a.slice("--title=".length);
  } else if (!planPath && !runtime && !appArg && !a.startsWith("-")) {
    appArg = a;
  } else {
    cargoArgs.push(a);
  }
}

if (context && !runtime && !planPath) throw new Error("Vita native build requires an admitted package");
if (context) skipBuild = true;
const selectedProfile = context?.profile ?? softwareProfile;
if (runtime && (appArg || planPath || launcherRegistry)) {
  throw new Error("PocketJS vita: --runtime builds a program without an app; give no app, --plan or launcher registry");
}
if (titleOverride !== undefined && !/^[A-Z][A-Z0-9]{8}$/.test(titleOverride)) {
  throw new Error(`PocketJS vita: --title must be nine uppercase letters and digits, got ${titleOverride}`);
}
if (!appArg && !planPath && !runtime) {
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

let buildPlan: ResolvedBuildPlan | undefined;
let hostBuildInputs: HostBuildInputs | undefined;
if (planPath) {
  buildPlan = (await Bun.file(planPath).json()) as ResolvedBuildPlan;
  if (!verifyPlanHash(buildPlan) || buildPlan.target.id !== selectedProfile.id) {
    throw new Error(
      `PocketJS vita: invalid Vita ResolvedBuildPlan at ${planPath}`,
    );
  }
  hostBuildInputs = extractHostBuildInputs(buildPlan, {
    expectedTarget: selectedProfile.id,
  });
  if (frameworkFlag) {
    throw new Error(
      "PocketJS vita: framework overrides are forbidden with --plan",
    );
  }
}

const app = buildPlan
  ? resolvePath(projectRoot, buildPlan.app.entry)
  : appArg
    ? mountedSourceApp(appArg, pspUiDir)
    : "";

const sourceEntry = !buildPlan && !runtime ? resolveSourceEntry(app, pspUiDir, projectRoot) : undefined;
const sourceContent = sourceEntry ? sourceAppContent(sourceEntry, { frameworkRoot: pspUiDir, projectRoot }) : {};
const framework: PocketFramework = buildPlan
  ? parseFramework(buildPlan.app.framework, "ResolvedBuildPlan")
  : frameworkFlag
    ? parseFramework(frameworkFlag, "--framework")
    : parseFramework(sourceContent.framework, "pocket.json");
// A resolved plan owns the exact artifact name. Low-level demo builds keep the
// framework suffix so multiple variants can still coexist in dist/.
const outputApp = runtime
  ? "pocket-runtime"
  : buildPlan
    ? buildPlan.app.output
    : `${sourceEntry ? sourceOutputName(sourceEntry, pspUiDir) : app}${FRAMEWORKS[framework].outputSuffix}`;
const stockDemoName = !buildPlan && appArg ? appArg.replace(/-main$/, "") : "";
const stockDemo =
  stockDemoName && ["main.tsx", "main.ts"].some(file => existsSync(`${pspUiDir}apps/${stockDemoName}/${file}`))
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
  if (buildPlan.app.framework !== framework) {
    throw new Error("PocketJS vita: --framework differs from the application manifest; use a matching manifest/plan");
  }
  projectRoot = pspUiDir;
  hostBuildInputs = extractHostBuildInputs(buildPlan, {
    expectedTarget: selectedProfile.id,
  });
  planPath = `${pspUiDir}.pocket/vita-low-level/${outputApp}.plan.json`;
  mkdirSync(resolvePath(planPath, ".."), { recursive: true });
  await Bun.write(planPath, JSON.stringify(buildPlan, null, 2) + "\n");
}
const applicationId = runtime
  ? "dev.pocket-nexus.runtime"
  : buildPlan?.app.id ??
  stockDemo?.id ??
  `dev.pocket-nexus.legacy.${outputApp.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
const packageTitle = runtime
  ? "PocketJS Runtime"
  : buildPlan?.app.title ?? stockDemo?.title ?? `PocketJS ${outputApp}`;
const titleId = titleOverride ?? vitaTitleId(applicationId);
const nativeBuild = randomBytes(16).toString("hex");
const usb = usbDebug ? await prepareVitaUsb() : undefined;

// ---------------------------------------------------------------------------
// 1. Build the app bundle + pak -> dist/<app>.js + dist/<app>.pak
// ---------------------------------------------------------------------------

if (runtime) console.log("PocketJS vita: building the generic runtime (no app; reads app0:app.pocket)");
else console.log(`PocketJS vita: building app "${app}" (framework=${framework})`);
if (!skipBuild && !runtime) {
  if (buildPlan) {
    await $`bun tools/build.ts --plan=${planPath!} --project-root=${projectRoot} --outdir=${outputDir}`.cwd(pspUiDir);
  } else {
    await $`bun tools/build.ts ${sourceEntry!} --project-root=${projectRoot} --outdir=${outputDir} ${buildFlags}`.cwd(pspUiDir);
  }
}

// ---------------------------------------------------------------------------
// 2. Cargo ELF build, then explicit SDK conversion and packaging
// ---------------------------------------------------------------------------

const nativeInputs: HostBuildInputs = hostBuildInputs ?? {
  profile: selectedProfile,
  profileHash: hashPocketProfile(selectedProfile),
  appOutput: outputApp,
  app: { id: applicationId, title: packageTitle, version: "0.0.0" },
  target: selectedProfile.id,
  hostAbi: POCKET_BINDING_GENERATION,
  viewport: {
    logical: [480, 272],
    physical: [960, 544],
    presentation: "integer-fit",
    rasterDensity: 2,
  },
};

// The pinned engine crate does not export header metadata through DEP_*.
// Resolve that exact dependency before Cargo runs the native build script.
const qjsMetadata = Bun.spawnSync([rustup, "run", RUST_TOOLCHAINS.vita, "cargo", "metadata", "--locked", "--format-version=1", "--manifest-path", `${nativeDir}Cargo.toml`], { stdout: "pipe", stderr: "pipe" });
if (!qjsMetadata.success) throw new Error(qjsMetadata.stderr.toString() || "Vita Cargo metadata failed");
const packages = JSON.parse(qjsMetadata.stdout.toString()).packages as { name: string; manifest_path: string; source: string | null; dependencies: {name: string; source: string | null}[] }[];
const qjsRevision = packages.find(pkg => pkg.name === "pocketjs-vita")?.dependencies.find(dep => dep.name === "libquickjs-sys")?.source;
const qjsPackage = qjsRevision ? packages.find(pkg => pkg.name === "libquickjs-sys" && pkg.source?.startsWith(`${qjsRevision}#`)) : undefined;
if (!qjsPackage) throw new Error("Vita dependency closure has no libquickjs-sys");
const quickjsSource = resolvePath(dirname(qjsPackage.manifest_path), "embed/quickjs");

const env = {
  ...process.env,
  CARGO_TARGET_DIR: `${nativeDir}target`,
  CARGO_PROFILE_RELEASE_LTO: "true",
  // Keep the selected compiler shim and the explicit SDK tools on PATH.
  PATH: `${vitasdk}/bin:${home}/.cargo/bin:${process.env.PATH ?? ""}`,
  VITASDK: vitasdk,
  POCKET_QJS_SOURCE: quickjsSource,
  // The program build identity and final SFO share the manifest title id.
  VITA_DEFAULT_TITLE_ID: titleId,
  POCKETJS_VITA_TITLE_ID: titleId,
  POCKETJS_VITA_PLAN: planPath ?? "",
  POCKETJS_NATIVE_BUILD: nativeBuild,
  ...hostBuildEnvironment(nativeInputs, {
    outputDirectory: outputDir,
    embedApp: !runtime,
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

const features = [capture ? "capture" : "", runtime ? "runtime" : ""].filter(Boolean);
cargoArgs.push("-p", "pocketjs-vita");
if (features.length > 0) cargoArgs.push("--features", features.join(","));
if (!usbDebug) cargoArgs.push("--no-default-features");

console.log(
  `PocketJS vita: Cargo ELF and SDK VPK (app=${runtime ? "none, runtime" : outputApp}${capture ? ", capture" : ""})`,
);
const execute = async (command: string[]) => {
  if (context) await context.run(command, { cwd: nativeDir, env });
  else await $`${command}`.cwd(nativeDir).env(env);
};
await execute([rustup, "run", RUST_TOOLCHAINS.vita, "cargo", "build", "--target", "armv7-sony-vita-newlibeabihf", "-Z", "build-std=std,panic_abort", ...cargoArgs]);
const profile = cargoArgs.includes("--release") || cargoArgs.includes("-r") ? "release" : "debug";
const targetDirectory = `${nativeDir}target/armv7-sony-vita-newlibeabihf/${profile}`;
const elf = `${targetDirectory}/pocketjs-vita.elf`;
const velf = `${targetDirectory}/pocketjs-vita.velf`;
const eboot = `${targetDirectory}/pocketjs-vita.self`;
const sfo = `${targetDirectory}/pocketjs-vita.sfo`;
const vpk = `${targetDirectory}/pocketjs-vita.vpk`;
if (!existsSync(elf)) throw new Error(`PocketJS vita: ELF not found at ${elf}`);
await execute([`${vitasdk}/bin/vita-elf-create`, elf, velf]);
// Debug's kernel USB driver requires unsafe-homebrew SELF permissions.
await execute([`${vitasdk}/bin/vita-make-fself`, ...(usbDebug ? [] : ["-s"]), velf, eboot]);
await execute([`${vitasdk}/bin/vita-mksfoex`, "-d", "ATTRIBUTE2=12", "-s", `TITLE_ID=${titleId}`, packageTitle, sfo]);

// An app's `vita/` directory (VPK-relative paths, e.g. sce_sys/icon0.png)
// overlays the framework's LiveArea defaults.
const entryFile = runtime
  ? undefined
  : buildPlan
    ? resolvePath(projectRoot, buildPlan.app.entry)
    : sourceEntry;
const vitaAssets = entryFile ? resolvePath(dirname(entryFile), "vita") : undefined;
await packageVitaVpk({
  tool: `${vitasdk}/bin/vita-pack-vpk`,
  execute,
  sfo,
  eboot,
  output: vpk,
  usbDriver: usb?.driver,
  applicationAssets: vitaAssets && existsSync(vitaAssets) ? vitaAssets : undefined,
});

const packagedDirectory = packageOutputDir ?? resolvePath(outputDir, "vita");
const packaged = resolvePath(packagedDirectory, `${outputApp}.vpk`);
mkdirSync(packagedDirectory, { recursive: true });
cpSync(vpk, packaged);
const packagedSelf = resolvePath(packagedDirectory, `${outputApp}.self`);
cpSync(eboot, packagedSelf);
await Bun.write(resolvePath(packagedDirectory, `${outputApp}.runtime.json`), JSON.stringify({
  version: 1, titleId, applicationId, output: outputApp, nativeBuild, plan: buildPlan ?? null,
  profileHash: nativeInputs.profileHash,
  self: `${outputApp}.self`, usbDebug, usbDriver: usb?.fingerprint,
  selfSha256: createHash("sha256").update(Buffer.from(await Bun.file(packagedSelf).arrayBuffer())).digest("hex"),
}, null, 2) + "\n");
console.log(`PocketJS vita: package ${titleId} (${applicationId})`);
console.log(`output: ${packaged}`);

return packaged;
}

if (import.meta.main) await buildVita(Bun.argv.slice(2));
