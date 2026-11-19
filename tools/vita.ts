import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { compiledProfile } from "../contracts/spec/profile.ts";
// tools/vita.ts <demo> [--capture] [cargo args…]
// tools/vita.ts --runtime [--title=TITLEID] [cargo args…]
//
// A demo compiles with `pocket compile` into dist/<output>.pkb; the
// program embeds that bundle and the exported profile, and encodes nothing
// at startup. The build executor supplies --plan with its admitted bundle.
//
// --runtime builds the generic runtime (cargo feature `runtime`): no app is
// built or embedded, and the program reads app0:app.pkb at startup.
// tools/runtime/vita.ts runs it with --release and collects eboot.bin.
// --title replaces the title id derived from the application id.
//
// buildVitaProgram() is the program build itself. It takes the program crate
// as an argument: programs/vita here, or a binary crate in another repository
// that composes the pocketjs-vita library.

import { $ } from "bun";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { parseFramework } from "../framework/compiler/framework-choice.ts";
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
  vitaTitleId,
  type HostBuildInputs,
} from "../framework/src/plan.ts";
import {
  verifyPlanHash,
  type ResolvedBuildPlan,
} from "../framework/compiler/plan.ts";
import { packageVitaVpk } from "./vita-package.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import type { RuntimeApplication, RuntimeBuildContext } from "../framework/src/host-config.ts";
import { RUST_TOOLCHAINS } from "./build/toolchains/rust.ts";
import { hashPocketProfile, type PocketProfile } from "../framework/src/profile.ts";
import { prepareApplication } from "./build/inputs.ts";
import { compileDemoBundle, demoApp } from "./build/programs/handheld-common.ts";
import { exportProfile } from "./profile-export.ts";
const softwareProfile = POCKET_PROFILES["vita"];

const pspUiDir = new URL("..", import.meta.url).pathname; // PocketJS/
const home = process.env.HOME ?? "";

/** A Vita program crate: a binary that composes the pocketjs-vita library. */
export interface VitaProgram {
  /** The directory of its Cargo.toml. Cargo runs there, so its
   *  `.cargo/config.toml` applies, and builds into its `target/`. */
  readonly directory: string;
  /** Its Cargo package; the binary target carries the same name. */
  readonly package: string;
  /** Variables its build script reads beyond the PocketJS build environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Sign the SELF without vita-make-fself's `-s`: an unsafe-homebrew SELF,
   *  which HENkaku requires to load a kernel module through taiHEN. */
  readonly unsafe?: boolean;
  /** A VPK-relative tree packaged over the framework's LiveArea defaults in
   *  place of the application's `vita/` directory. */
  readonly assets?: string;
}

/** programs/vita: the stock program. */
export const STOCK_VITA_PROGRAM: VitaProgram = { directory: resolvePath(pspUiDir, "programs/vita"), package: "pocketjs-vita" };

export interface VitaProgramBuild {
  readonly program: VitaProgram;
  readonly profile: PocketProfile;
  /** The admitted application the program embeds. Without one the program
   *  is the generic runtime (cargo feature `runtime`). */
  readonly application?: RuntimeApplication;
  /** The directory the plan's entry is relative to: the entry's `vita/`
   *  sibling overlays the LiveArea defaults. Default: the working directory. */
  readonly projectRoot?: string;
  /** Default: vitaTitleId of the application id. */
  readonly titleId?: string;
  readonly capture?: boolean;
  readonly launcherRegistry?: string;
  readonly launcherBundles?: string;
  /** Passed to `cargo build`, such as `--release`. */
  readonly cargoArgs?: readonly string[];
  /** The embedded application's outputs when it has no directory of its own. */
  readonly outputDirectory: string;
  /** Receives <output>.vpk and <output>.self. */
  readonly packageDirectory: string;
  /** Where the profile module was exported. Default: this build exports it
   *  under the program's target directory. */
  readonly profileExportDirectory?: string;
  /** Runs each tool; default: a Bun shell in the program directory. */
  readonly run?: (command: string[], options: { cwd: string; env: Readonly<Record<string, string>> }) => Promise<void>;
}

/** VitaSDK ($VITASDK, else ~/vitasdk) and rustup, checked before any build step. */
function vitaToolchain(): { vitasdk: string; rustup: string } {
  if (!process.env.VITASDK && !existsSync(`${home}/vitasdk`)) {
    throw new Error("PocketJS vita: VITASDK environment variable not set. Please set it to your VitaSDK path.");
  }
  const vitasdk = process.env.VITASDK || `${home}/vitasdk`;
  const rustup = Bun.which("rustup") ?? `${home}/.cargo/bin/rustup`;
  if (!existsSync(rustup)) throw new Error("PocketJS vita: rustup not found (expected ~/.cargo/bin/rustup)");
  if (!existsSync(`${vitasdk}/bin/arm-vita-eabi-gcc`)) throw new Error(`PocketJS vita: incomplete VitaSDK at ${vitasdk}`);
  return { vitasdk, rustup };
}

export interface BuiltVitaProgram {
  readonly vpk: string;
  readonly self: string;
  readonly output: string;
  readonly applicationId: string;
  readonly titleId: string;
  readonly profileHash: string;
}

/** Build a Vita program crate around one application, or none, into a SELF
 *  and a VPK with the framework's LiveArea defaults. */
export async function buildVitaProgram(build: VitaProgramBuild): Promise<BuiltVitaProgram> {
  const { program, profile: selectedProfile, application } = build;
  const programDir = resolvePath(program.directory) + "/";
  const runtime = !application;
  if (runtime && build.launcherRegistry) {
    throw new Error("PocketJS vita: the generic runtime cannot embed a launcher registry");
  }
  if (build.titleId !== undefined && !/^[A-Z][A-Z0-9]{8}$/.test(build.titleId)) {
    throw new Error(`PocketJS vita: --title must be nine uppercase letters and digits, got ${build.titleId}`);
  }
  const { vitasdk, rustup } = vitaToolchain();

  let buildPlan: ResolvedBuildPlan | undefined;
  let hostBuildInputs: HostBuildInputs | undefined;
  if (application) {
    buildPlan = (await Bun.file(application.planPath).json()) as ResolvedBuildPlan;
    if (!verifyPlanHash(buildPlan) || buildPlan.target.id !== selectedProfile.id) {
      throw new Error(`PocketJS vita: invalid Vita ResolvedBuildPlan at ${application.planPath}`);
    }
    hostBuildInputs = extractHostBuildInputs(buildPlan, { expectedTarget: selectedProfile.id });
  }

  const outputApp = runtime ? "pocket-runtime" : buildPlan!.app.output;
  const applicationId = runtime ? "dev.pocket-nexus.runtime" : buildPlan!.app.id;
  const packageTitle = runtime ? "PocketJS Runtime" : buildPlan!.app.title;
  const titleId = build.titleId ?? vitaTitleId(applicationId);

  const nativeInputs: HostBuildInputs = hostBuildInputs ?? {
    profile: { ...compiledProfile(selectedProfile), tickHz: Math.max(...selectedProfile.cadences) },
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
  const qjsMetadata = Bun.spawnSync([rustup, "run", RUST_TOOLCHAINS.vita, "cargo", "metadata", "--locked", "--format-version=1", "--manifest-path", `${programDir}Cargo.toml`], { stdout: "pipe", stderr: "pipe" });
  if (!qjsMetadata.success) throw new Error(qjsMetadata.stderr.toString() || "Vita Cargo metadata failed");
  const packages = JSON.parse(qjsMetadata.stdout.toString()).packages as { name: string; manifest_path: string; source: string | null; dependencies: {name: string; source: string | null}[] }[];
  const qjsRevision = packages.find(pkg => pkg.name === "pocketjs-vita")?.dependencies.find(dep => dep.name === "libquickjs-sys")?.source;
  const qjsPackage = qjsRevision ? packages.find(pkg => pkg.name === "libquickjs-sys" && pkg.source?.startsWith(`${qjsRevision}#`)) : undefined;
  if (!qjsPackage) throw new Error("Vita dependency closure has no libquickjs-sys");
  const quickjsSource = resolvePath(dirname(qjsPackage.manifest_path), "embed/quickjs");

  // build.rs embeds the exported profile module. The executor exports it into
  // its outdir; another build exports the selected profile here.
  const profileExportDirectory = build.profileExportDirectory ?? `${programDir}target/pocket-profile/${selectedProfile.id}`;
  if (!build.profileExportDirectory) {
    exportProfile({ profile: selectedProfile, profileHash: hashPocketProfile(selectedProfile),
      hostAbi: POCKET_BINDING_GENERATION, dependencies: [] }, profileExportDirectory);
  }

  const env = {
    ...process.env,
    CARGO_TARGET_DIR: `${programDir}target`,
    CARGO_PROFILE_RELEASE_LTO: "true",
    // Keep the selected compiler shim and the explicit SDK tools on PATH.
    PATH: `${vitasdk}/bin:${home}/.cargo/bin:${process.env.PATH ?? ""}`,
    VITASDK: vitasdk,
    POCKET_QJS_SOURCE: quickjsSource,
    // The final SFO uses the application's title id.
    VITA_DEFAULT_TITLE_ID: titleId,
    // The bundle's own JS and pak, extracted beside its snapshot, give the
    // bundle hash; the bundle bytes are what the program embeds.
    ...hostBuildEnvironment(nativeInputs, {
      outputDirectory: application?.directory ?? build.outputDirectory,
      embedApp: !runtime,
      profileExportDirectory,
    }),
    POCKETJS_EMBED_BUNDLE: application ? resolvePath(application.bundlePath) : "",
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
    POCKETJS_LAUNCHER_REGISTRY: build.launcherRegistry ?? "",
    POCKETJS_LAUNCHER_BUNDLES: build.launcherBundles ?? "",
    ...program.env,
  };

  const cargoArgs = [...(build.cargoArgs ?? []), "-p", program.package];
  const features = [build.capture ? "capture" : "", runtime ? "runtime" : ""].filter(Boolean);
  if (features.length > 0) cargoArgs.push("--features", features.join(","));

  console.log(
    `PocketJS vita: Cargo ELF and SDK VPK (${program.package}, app=${runtime ? "none, runtime" : outputApp}${build.capture ? ", capture" : ""})`,
  );
  const execute = async (command: string[]) => {
    if (build.run) await build.run(command, { cwd: programDir, env });
    else await $`${command}`.cwd(programDir).env(env);
  };
  await execute([rustup, "run", RUST_TOOLCHAINS.vita, "cargo", "build", "--target", "armv7-sony-vita-newlibeabihf", "-Z", "build-std=std,panic_abort", ...cargoArgs]);
  const profile = cargoArgs.includes("--release") || cargoArgs.includes("-r") ? "release" : "debug";
  const targetDirectory = `${programDir}target/armv7-sony-vita-newlibeabihf/${profile}`;
  const elf = `${targetDirectory}/${program.package}.elf`;
  const velf = `${targetDirectory}/${program.package}.velf`;
  const eboot = `${targetDirectory}/${program.package}.self`;
  const sfo = `${targetDirectory}/${program.package}.sfo`;
  const vpk = `${targetDirectory}/${program.package}.vpk`;
  if (!existsSync(elf)) throw new Error(`PocketJS vita: ELF not found at ${elf}`);
  await execute([`${vitasdk}/bin/vita-elf-create`, elf, velf]);
  await execute([`${vitasdk}/bin/vita-make-fself`, ...(program.unsafe ? [] : ["-s"]), velf, eboot]);
  await execute([`${vitasdk}/bin/vita-mksfoex`, "-d", "ATTRIBUTE2=12", "-s", `TITLE_ID=${titleId}`, packageTitle, sfo]);

  // An app's `vita/` directory (VPK-relative paths, e.g. sce_sys/icon0.png)
  // overlays the framework's LiveArea defaults.
  const entryFile = buildPlan ? resolvePath(build.projectRoot ?? process.cwd(), buildPlan.app.entry) : undefined;
  const vitaAssets = entryFile ? resolvePath(dirname(entryFile), "vita") : undefined;
  const assets = program.assets ?? (vitaAssets && existsSync(vitaAssets) ? vitaAssets : undefined);
  await packageVitaVpk({
    tool: `${vitasdk}/bin/vita-pack-vpk`,
    execute,
    sfo,
    eboot,
    output: vpk,
    applicationAssets: assets,
  });

  mkdirSync(build.packageDirectory, { recursive: true });
  const packaged = resolvePath(build.packageDirectory, `${outputApp}.vpk`);
  cpSync(vpk, packaged);
  const packagedSelf = resolvePath(build.packageDirectory, `${outputApp}.self`);
  cpSync(eboot, packagedSelf);
  console.log(`PocketJS vita: package ${titleId} (${applicationId})`);
  console.log(`output: ${packaged}`);
  return { vpk: packaged, self: packagedSelf, output: outputApp, applicationId, titleId, profileHash: nativeInputs.profileHash };
}

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
let launcherRegistry = "";
let launcherBundles = "";
let runtime = false;
let titleOverride: string | undefined;
const cargoArgs: string[] = [];

for (const a of argv) {
  if (a === "--capture") {
    capture = true;
  } else if (a.startsWith("--framework=")) {
    frameworkFlag = a.slice("--framework=".length);
  } else if (a.startsWith("--config=") || a === "--no-config") {
    throw new Error("pocket.config.ts was removed; app.framework and app.theme belong to the application's pocket.host.config.ts");
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
  } else if (a.startsWith("--launcher-bundles=")) {
    launcherBundles = resolvePath(a.slice("--launcher-bundles=".length));
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

if (planPath && !context) throw new Error("PocketJS vita: --plan is the build executor's input; pass a compiled bundle with `pocket build --target vita --bundle`");
let application: RuntimeApplication | undefined = context?.application;
if (application && !existsSync(application.bundlePath)) throw new Error(`Vita captured bundle is missing: ${application.bundlePath}`);
if (context && !runtime && !application) throw new Error("Vita native build requires an admitted bundle");
const selectedProfile = context?.profile ?? softwareProfile;
if (runtime && (appArg || planPath || launcherRegistry)) {
  throw new Error("PocketJS vita: --runtime builds a program without an app; give no app, --plan or launcher registry");
}
if (!appArg && !application && !runtime) {
  console.error(
    "usage: bun tools/vita.ts <demo> [--framework=<id>] [--capture] " +
      "[--launcher-registry=<tsv> --launcher-bundles=<dir>] [cargo args…]   " +
      "e.g. bun tools/vita.ts hero --release",
  );
  process.exit(1);
}
if (frameworkFlag && !appArg) throw new Error("PocketJS vita: --framework applies to a stock demo build");
// A stock demo builds from its host config with the same compiler as
// `bun play`. The config owns its framework, and the title id follows its
// application id.
const demoApplication = !application && !runtime ? await demoApp(appArg) : undefined;
if (demoApplication && frameworkFlag && demoApplication.framework !== parseFramework(frameworkFlag, "--framework")) {
  throw new Error(`PocketJS vita: --framework differs from the application's app.framework (${demoApplication.framework})`);
}
if (Boolean(launcherRegistry) !== Boolean(launcherBundles)) {
  throw new Error(
    "PocketJS vita: --launcher-registry and --launcher-bundles must be provided together",
  );
}
if (launcherRegistry && !existsSync(launcherRegistry)) {
  throw new Error(
    `PocketJS vita: launcher registry not found at ${launcherRegistry}`,
  );
}
if (launcherBundles && !existsSync(launcherBundles)) {
  throw new Error(
    `PocketJS vita: launcher bundles not found at ${launcherBundles}`,
  );
}

vitaToolchain();

// A stock demo compiles to dist/<output>.pkb; --skip-build reuses it.
// The program embeds the bundle the executor admitted or this compile made.
if (runtime) console.log("PocketJS vita: building the generic runtime (no app; reads app0:app.pkb)");
if (demoApplication) {
  console.log(`PocketJS vita: compiling demo "${appArg}" (framework=${demoApplication.framework})`);
  const compiled = await compileDemoBundle("vita", appArg, outputDir, { reuse: skipBuild });
  application = prepareApplication({ profile: selectedProfile, profileHash: hashPocketProfile(selectedProfile),
    hostAbi: POCKET_BINDING_GENERATION, dependencies: [] }, compiled, outputDir);
  projectRoot = pspUiDir;
}

const built = await buildVitaProgram({
  program: STOCK_VITA_PROGRAM,
  profile: selectedProfile,
  application,
  projectRoot,
  titleId: titleOverride,
  capture,
  launcherRegistry: launcherRegistry || undefined,
  launcherBundles: launcherBundles || undefined,
  cargoArgs,
  outputDirectory: outputDir,
  packageDirectory: packageOutputDir ?? resolvePath(outputDir, "vita"),
  profileExportDirectory: context?.outdir,
  run: context && ((command, options) => context.run(command, options)),
});
return built.vpk;
}

if (import.meta.main) await buildVita(Bun.argv.slice(2));
