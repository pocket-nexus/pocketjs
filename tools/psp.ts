import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
// tools/psp.ts <demo> | --bundle <app.pkb> [cargo args…] — compile the
// stock demo apps/<demo>/main.tsx with `pocket compile` into
// dist/<output>.pkb (or take the given bundle), then the EBOOT:
//   POCKETJS_EMBED_BUNDLE=<bundle> POCKETJS_PROFILE_RS=<export> cargo psp
// inside programs/psp/, with the environment tools/psp-toolchain.ts reads from the
// installed toolchain (PSP_SDK, QUICKJS_PREBUILT_LIB, cargo-psp on PATH) plus
// RUST_PSP_TARGET=programs/psp/targets/mipsel-sony-psp.json, RUST_PSP_ABORT_ONLY=1
// and RUSTFLAGS "-A linker-messages …". `pocket target add psp` installs the
// pinned Rust, cargo-psp, SDK and prebuilt QuickJS. The EBOOT embeds the
// bundle bytes and the exported profile; it encodes nothing at boot.
//
// A demo builds from the app section of its apps/<demo>/pocket.host.config.ts;
// --framework=<id> replaces its framework, as the PPSSPP goldens do.
//
// --capture builds the E2E frame-dump EBOOT (cargo psp --features capture)
// and bakes the POCKETJS_CAPTURE_INPUT env ("frame:mask,…") into the binary —
// used by tests/e2e/ppsspp.ts, never by normal builds.
// --bench additionally enables native microsecond timing output to
// ms0:/PocketJS-bench.jsonl and implies --capture.
//
// --runtime builds the generic runtime instead of an app's EBOOT (cargo
// feature `runtime`, POCKETJS_EMBED_APP=0): no app is built or embedded, and
// the EBOOT reads app.pkb from its own folder at boot. tools/runtime/psp.ts
// runs this and collects the output.
//
// buildPspProgram() is the program build itself. It takes the program crate
// as an argument: programs/psp here, or a binary crate in another repository
// that composes the pocketjs-psp library.

import { $ } from "bun";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parseFramework, type PocketFramework } from "../framework/compiler/framework-choice.ts";
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
} from "../framework/compiler/host-build-inputs.ts";
import { verifyPlanHash, type ResolvedBuildPlan } from "../framework/compiler/plan.ts";
import { resolvePspBuildToolchain } from "./psp-toolchain.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import type { RuntimeApplication, RuntimeBuildContext } from "../framework/src/host-config.ts";
import { hashPocketProfile, type PocketProfile } from "../framework/src/profile.ts";
import { prepareApplication } from "./build/inputs.ts";
import { compileDemoBundle, demoApp, demoBundlePath } from "./build/programs/handheld-common.ts";
import type { AppConfig } from "../contracts/spec/app-config.ts";
import { exportProfile } from "./profile-export.ts";
const softwareProfile = POCKET_PROFILES["psp"];
const runtimeProfile = POCKET_PROFILES["psp-runtime"];

const pspUiDir = new URL("..", import.meta.url).pathname; // PocketJS/
const pspTarget = resolvePath(pspUiDir, "tools/build/toolchains/psp/mipsel-sony-psp.json");

/** A PSP program crate: a binary that composes the pocketjs-psp library. */
export interface PspProgram {
  /** The directory of its Cargo.toml. cargo psp runs there, so its
   *  `.cargo/config.toml` applies, it reads `Psp.toml` there and it builds
   *  into its `target/`. */
  readonly directory: string;
  /** Its Cargo package; the binary target carries the same name. Its
   *  features `capture`, `bench` and `runtime` enable the library's. */
  readonly package: string;
  /** Variables its build script reads beyond the PocketJS build environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** A Psp.toml (XMB title, ICON0, PIC1…) packaged in place of the
   *  application's `psp/Psp.toml`. Asset paths in it are relative to its
   *  directory. */
  readonly xmb?: string;
}

/** programs/psp: the stock program. */
export const STOCK_PSP_PROGRAM: PspProgram = { directory: resolvePath(pspUiDir, "programs/psp"), package: "pocketjs-psp" };

export interface PspProgramBuild {
  readonly program: PspProgram;
  readonly profile: PocketProfile;
  /** The admitted application the program embeds as `embedded::BUNDLE`.
   *  Without one the program is the generic runtime (cargo feature
   *  `runtime`). */
  readonly application?: RuntimeApplication;
  /** The directory the plan's entry is relative to: the entry's `psp/`
   *  sibling holds the XMB metadata. Default: the working directory. */
  readonly projectRoot?: string;
  readonly capture?: boolean;
  /** Native timing output; implies `capture`. */
  readonly bench?: boolean;
  /** Passed to `cargo psp`, such as `--release`. */
  readonly cargoArgs?: readonly string[];
  /** The generic runtime's output directory (POCKETJS_OUTPUT_DIR). */
  readonly outputDirectory: string;
  /** Where the profile module was exported. Default: this build exports it
   *  under the program's target directory. */
  readonly profileExportDirectory?: string;
  /** Runs each tool; default: a Bun shell in the program directory. */
  readonly run?: (command: string[], options: { cwd: string; env: Readonly<Record<string, string>> }) => Promise<void>;
}

export interface BuiltPspProgram {
  /** target/mipsel-sony-psp/<profile>/EBOOT.PBP in the program directory. */
  readonly eboot: string;
  readonly prx: string;
  /** The application's output name; empty for the generic runtime. */
  readonly output: string;
  readonly profileHash: string;
}

/** Production inputs retain the executor's immutable snapshot, including all sections. */
export function pspBundleInput(bundlePath: string | undefined, outdir: string, context?: RuntimeBuildContext): RuntimeApplication | undefined {
  if (context) {
    if (bundlePath) throw new Error("PSP recipe owns --bundle; supply it to the build executor");
    if (context.application && !existsSync(context.application.bundlePath))
      throw new Error(`PSP captured bundle is missing: ${context.application.bundlePath}`);
    return context.application;
  }
  if (!bundlePath) return undefined; // A stock demo compiles its bundle first.
  return prepareApplication({ profile: softwareProfile, profileHash: hashPocketProfile(softwareProfile),
    hostAbi: POCKET_BINDING_GENERATION, dependencies: [] }, bundlePath, outdir);
}

/** The application `tools/psp.ts <demo>` compiles: the demo's `app`
 *  section, with a --framework override in place of its framework. */
export function pspDemoVariant(framework?: string): ((app: AppConfig) => AppConfig) | undefined {
  if (!framework) return undefined;
  const selected = parseFramework(framework, "--framework");
  return app => ({ ...app, framework: selected });
}

/** The compiled bundle `tools/psp.ts <demo>` embeds, under its output directory. */
export function pspDemoBundle(demo: string, outdir = `${pspUiDir}dist/`): Promise<string> {
  return demoBundlePath(demo, outdir);
}

function outputProfile(args: readonly string[]): string {
  const inlineProfile = args.find((arg) => arg.startsWith("--profile="));
  if (inlineProfile) return inlineProfile.slice("--profile=".length);
  const profileFlag = args.indexOf("--profile");
  if (profileFlag !== -1 && args[profileFlag + 1]) return args[profileFlag + 1]!;
  return args.includes("--release") || args.includes("-r") ? "release" : "debug";
}

/** Per-app XMB metadata: the program's `xmb`, else <entry dir>/psp/Psp.toml
 *  (or <entry dir>/psp/<framework>/Psp.toml), written as the program
 *  directory's Psp.toml, which cargo-psp packs into PARAM.SFO, ICON0 and
 *  PIC1. Its art paths are rewritten absolute. Without a fragment a
 *  previously generated file is removed, so one app's title or cover never
 *  reaches another app's EBOOT. */
async function writeXmbMetadata(programDir: string, fragment: string | undefined): Promise<void> {
  const GENERATED_MARK = "# GENERATED by tools/psp.ts";
  const label = fragment?.startsWith(pspUiDir) ? fragment.slice(pspUiDir.length) : fragment;
  const generatedPspToml = `${programDir}Psp.toml`;
  const generatedExisting =
    existsSync(generatedPspToml) && (await Bun.file(generatedPspToml).text()).startsWith(GENERATED_MARK);
  if (fragment && existsSync(fragment)) {
    if (existsSync(generatedPspToml) && !generatedExisting) {
      throw new Error(`PocketJS psp: ${generatedPspToml} exists but was not generated by this script — ` +
        "per-app XMB metadata lives in <app dir>/psp/Psp.toml; move or delete the file to continue.");
    }
    const fragDir = resolvePath(fragment, "..") + "/";
    const rewritten = (await Bun.file(fragment).text()).replace(
      /^(\s*\w+_(?:png|pmf|at3))(\s*=\s*")(?!\/)([^"]+)(")/gm,
      (_m, key, eq, rel, close) => `${key}${eq}${fragDir}${rel}${close}`,
    );
    // Every asset key must have resolved to an absolute path that exists —
    // single-quoted strings, `~`, or drive paths would otherwise slip through
    // the rewrite and cargo-psp would pack missing/stale art without a word.
    const badAssets: string[] = [];
    for (const m of rewritten.matchAll(/^\s*(\w+_(?:png|pmf|at3))\s*=\s*(['"])(.*)\2\s*$/gm)) {
      if (!m[3]!.startsWith("/") || !existsSync(m[3]!)) badAssets.push(`${m[1]} = ${m[3]}`);
    }
    if (badAssets.length > 0) {
      throw new Error(`PocketJS psp: XMB asset path(s) in ${label} did not resolve:\n` +
        badAssets.map((b) => `  ${b}`).join("\n") +
        `\n(use double-quoted paths relative to the fragment's directory)`);
    }
    await Bun.write(generatedPspToml, `${GENERATED_MARK} from ${label} — do not edit.\n${rewritten}`);
    console.log(`PocketJS psp: XMB metadata from ${label}`);
  } else if (generatedExisting) {
    unlinkSync(generatedPspToml); // a previous app's cover must not leak into this EBOOT
  } else if (existsSync(generatedPspToml)) {
    console.log(`PocketJS psp: note — hand-authored ${generatedPspToml} found; cargo-psp will apply it.`);
  }
}

/** Build a PSP program crate around one application, or none, into an
 *  EBOOT.PBP with the application's XMB metadata. */
export async function buildPspProgram(build: PspProgramBuild): Promise<BuiltPspProgram> {
  const { program, profile: selectedProfile, application } = build;
  const programDir = resolvePath(program.directory) + "/";
  const runtime = !application;
  const capture = build.capture || build.bench;
  // The installed toolchain, or a diagnostic naming `pocket target add psp`.
  const toolchain = resolvePspBuildToolchain();

  let buildPlan: ResolvedBuildPlan | undefined;
  if (application) {
    buildPlan = await Bun.file(application.planPath).json() as ResolvedBuildPlan;
    if (!verifyPlanHash(buildPlan) || buildPlan.target.id !== selectedProfile.id) {
      throw new Error(`PocketJS psp: invalid PSP ResolvedBuildPlan at ${application.planPath}`);
    }
  }
  const outputDirectory = application ? application.directory + "/" : build.outputDirectory;
  const projectRoot = build.projectRoot ?? process.cwd();
  const outputApp = buildPlan?.app.output ?? "";

  const framework: PocketFramework = parseFramework(buildPlan?.app.framework, "ResolvedBuildPlan");
  // A demo built through a non-default framework may ship its own cover set
  // so the XMB tells the twins apart (<app>/psp/<framework>/); the shared
  // fragment one level up stays the default.
  const appFragment = buildPlan ? (() => {
    const base = resolvePath(projectRoot, buildPlan.app.entry, "..", "psp");
    const twin = `${base}/${framework}/Psp.toml`;
    return existsSync(twin) ? twin : `${base}/Psp.toml`;
  })() : `${pspUiDir}programs/psp/runtime/Psp.toml`;
  await writeXmbMetadata(programDir, program.xmb ? resolvePath(program.xmb) : appFragment);

  const rustflags = [
    process.env.RUSTFLAGS,
    // Benign +abicalls(newlib) vs +noabicalls(rust-psp) linker warnings are
    // suppressed by default — set PSPJS_SHOW_LINKER_MESSAGES=1 for raw output.
    process.env.PSPJS_SHOW_LINKER_MESSAGES === "1" ? undefined : "-A linker-messages",
    "-A unexpected-cfgs",
    "-A unstable-name-collisions",
  ]
    .filter(Boolean)
    .join(" ");

  // build.rs embeds the exported profile module. The executor exports it into
  // its outdir; another build exports the selected profile here.
  const profileExportDirectory = build.profileExportDirectory ?? `${programDir}target/pocket-profile/${selectedProfile.id}`;
  if (!build.profileExportDirectory) {
    exportProfile({ profile: selectedProfile, profileHash: hashPocketProfile(selectedProfile),
      hostAbi: POCKET_BINDING_GENERATION, dependencies: [] }, profileExportDirectory);
  }
  const hostEnvironment = buildPlan
    ? hostBuildEnvironment(extractHostBuildInputs(buildPlan, { expectedTarget: selectedProfile.id }), {
        outputDirectory,
        embedApp: true,
        profileExportDirectory,
      })
    : {
        // The generic runtime: no application is embedded.
        POCKETJS_PROFILE_EXPORT_DIR: profileExportDirectory,
        POCKETJS_PROFILE_RS: `${profileExportDirectory}/pocket_profile.rs`,
        POCKETJS_APP_OUTPUT: "",
        POCKETJS_EMBED_APP: "0",
        POCKETJS_OUTPUT_DIR: outputDirectory,
        POCKETJS_TARGET: selectedProfile.id,
        POCKETJS_HOST_ABI: String(POCKET_BINDING_GENERATION),
        POCKETJS_LOGICAL_WIDTH: "480",
        POCKETJS_LOGICAL_HEIGHT: "272",
        POCKETJS_PHYSICAL_WIDTH: "480",
        POCKETJS_PHYSICAL_HEIGHT: "272",
        POCKETJS_PRESENTATION: "native",
        POCKETJS_RASTER_DENSITY: "1",
      };

  const env = {
    POCKETJS_OFFLOAD_SLOT: buildPlan?.features["io.offload"] ? createHash("sha256").update(buildPlan.app.id).digest("hex").slice(0, 16) : "",
    ...toolchain.environment,
    RUSTFLAGS: rustflags,
    RUST_PSP_TARGET: pspTarget,
    // panic-abort EBOOTs: no panic_unwind/libunwind in build-std.
    RUST_PSP_ABORT_ONLY: "1",
    // Keep PSP dev builds fast (opt-level 0 is unusably slow on hardware).
    CARGO_TARGET_DIR: `${programDir}target`,
    CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "3",
    ...hostEnvironment,
    // The build script embeds these original bytes; it has no raw-bundle path.
    POCKETJS_EMBED_BUNDLE: application ? resolvePath(application.bundlePath) : "",
    // Scripted capture input + per-demo capture window, baked into the EBOOT
    // by programs/psp/build.rs (only consumed under --capture; harmless otherwise).
    // Explicit so stale values never linger in the cargo fingerprint.
    POCKETJS_CAPTURE_INPUT: process.env.POCKETJS_CAPTURE_INPUT ?? "",
    POCKETJS_TRACE: process.env.POCKETJS_TRACE ?? "",
    POCKETJS_CAP_START: process.env.POCKETJS_CAP_START ?? "",
    POCKETJS_CAP_N: process.env.POCKETJS_CAP_N ?? "",
    POCKETJS_ARENA_BYTES: process.env.POCKETJS_ARENA_BYTES ?? "",
    POCKETJS_BENCH_DUMP_FRAMES: process.env.POCKETJS_BENCH_DUMP_FRAMES ?? "",
    ...program.env,
  };

  const cargoArgs = [...(build.cargoArgs ?? [])];
  const profile = outputProfile(cargoArgs);
  // Trace bakes dprintln onto the DEBUG SCREEN, and from the XMB (no host0:)
  // it exercises IO paths PSPLINK sessions never see. A release EBOOT with
  // trace is almost always a deployment mistake: say so, loudly (this exact
  // slip shipped once).
  if ((process.env.POCKETJS_TRACE ?? "") !== "" && profile === "release") {
    console.warn(
      "\n!!  PocketJS psp: POCKETJS_TRACE is baked into a RELEASE build — debug-screen logs" +
        "\n!!  will draw over the app. Ship traceless; trace is for PSPLINK dev loops.\n",
    );
  }
  const features = [capture ? "capture" : "", build.bench ? "bench" : "", runtime ? "runtime" : ""].filter(Boolean);
  if (features.length > 0) cargoArgs.push("--features", features.join(","));
  cargoArgs.push("-p", program.package, "--bin", program.package);

  console.log(`PocketJS psp: cargo psp (${program.package}, app=${runtime ? "none, runtime" : outputApp})`);
  const command = [toolchain.rustup, "run", toolchain.rustToolchain, "cargo", "psp", ...cargoArgs];
  if (build.run) await build.run(command, { cwd: programDir, env });
  else await $`${command}`.cwd(programDir).env(env);

  const targetDirectory = `${programDir}target/mipsel-sony-psp/${profile}`;
  const prx = `${targetDirectory}/${program.package}.prx`;
  const { verifyPspPrx } = await import("./psp-prx.ts");
  verifyPspPrx(new Uint8Array(await Bun.file(prx).arrayBuffer()));
  const binEboot = `${targetDirectory}/${program.package}.EBOOT.PBP`;
  const eboot = `${targetDirectory}/EBOOT.PBP`;
  if (existsSync(binEboot)) {
    await Bun.write(eboot, await Bun.file(binEboot).arrayBuffer());
  }
  console.log(`output: ${eboot}`);
  return { eboot, prx, output: outputApp, profileHash: hashPocketProfile(selectedProfile) };
}

// ---------------------------------------------------------------------------
// CLI: first bare arg = app name; everything else is passed to cargo psp.
// ---------------------------------------------------------------------------

export async function buildPsp(argv: readonly string[], context?: RuntimeBuildContext): Promise<string> {
let appArg = "";
let capture = false;
let bench = false;
let frameworkFlag: string | undefined;
let planPath: string | undefined;
let bundlePath: string | undefined;
let projectRoot = process.cwd();
let outputDir = pspUiDir + "dist/";
let skipBuild = false;
let runtime = false;
const cargoArgs: string[] = [];
for (let index = 0; index < argv.length; index++) {
  const a = argv[index]!;
  if (a === "--capture") capture = true; // E2E frame-dump build (tests/e2e/ppsspp.ts)
  else if (a === "--bench") {
    bench = true;
    capture = true;
  }
  else if (a.startsWith("--framework=")) frameworkFlag = a.slice("--framework=".length);
  else if (a.startsWith("--config=") || a === "--no-config") {
    throw new Error("pocket.config.ts was removed; app.framework and app.theme belong to the application's pocket.host.config.ts");
  } else if (a.startsWith("--plan=")) planPath = resolvePath(a.slice("--plan=".length));
  else if (a === "--pocket" || a.startsWith("--pocket=")) throw new Error("--pocket was removed; pass the compiled application with --bundle FILE (pocket compile writes a .pkb bundle)");
  else if (a === "--bundle" || a.startsWith("--bundle=")) {
    const value = a === "--bundle" ? argv[++index] : a.slice("--bundle=".length);
    if (!value || value.startsWith("--")) throw new Error("--bundle requires a compiled bundle path");
    bundlePath = resolvePath(value);
  }
  else if (a.startsWith("--project-root=")) projectRoot = resolvePath(a.slice("--project-root=".length));
  else if (a.startsWith("--outdir=")) outputDir = resolvePath(a.slice("--outdir=".length)) + "/";
  else if (a === "--skip-build") skipBuild = true;
  else if (a === "--runtime") runtime = true;
  else if (!planPath && !runtime && !appArg && !a.startsWith("-")) appArg = a;
  else cargoArgs.push(a);
}
if (runtime && bundlePath) throw new Error("PSP generic runtime cannot embed --bundle");
if (bundlePath && (appArg || planPath || frameworkFlag))
  throw new Error("--bundle supplies the application and plan; do not override them");
if (planPath && !context) throw new Error("PocketJS psp: --plan is the build executor's input; compile the application and pass --bundle");
if (frameworkFlag && !appArg) throw new Error("PocketJS psp: --framework applies to a stock demo build");
let application = pspBundleInput(bundlePath, outputDir, context);
if (context && !runtime && !application) throw new Error("PSP native build requires an admitted bundle");
const selectedProfile = context?.profile ?? (runtime ? runtimeProfile : softwareProfile);
if (runtime && (appArg || planPath)) {
  console.error("PocketJS psp: --runtime builds an EBOOT without an app; give no app or --plan");
  process.exit(1);
}
if (!appArg && !application && !runtime) {
  console.error("usage: bun tools/psp.ts <demo> | --bundle <application.pkb> [--framework=<id>] [--capture|--bench] [cargo args…]   e.g. bun tools/psp.ts hero --release");
  process.exit(1);
}
// Reject an unknown demo before resolving a toolchain.
const demoApplication = !application && !runtime ? await demoApp(appArg) : undefined;
const demoVariant = pspDemoVariant(frameworkFlag);

// The installed toolchain, or a diagnostic naming `pocket target add psp`.
try {
  resolvePspBuildToolchain();
} catch (error) {
  console.error(`PocketJS psp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// A stock demo compiles to dist/<output>.pkb; --skip-build reuses it. The
// EBOOT embeds that bundle exactly as it embeds a --bundle input.
if (runtime) console.log("PocketJS psp: building the generic runtime (no app; reads app.pkb)");
if (demoApplication) {
  console.log(`PocketJS psp: compiling demo "${appArg}" (framework=${(demoVariant?.(demoApplication) ?? demoApplication).framework})`);
  application = pspBundleInput(await compileDemoBundle("psp", appArg, outputDir, { reuse: skipBuild, ...(demoVariant ? { app: demoVariant } : {}) }), outputDir);
  projectRoot = pspUiDir;
}

const built = await buildPspProgram({
  program: STOCK_PSP_PROGRAM,
  profile: selectedProfile,
  application,
  projectRoot,
  capture,
  bench,
  cargoArgs,
  outputDirectory: outputDir,
  profileExportDirectory: context?.outdir,
  run: context && ((command, options) => context.run(command, options)),
});
return built.eboot;
}

if (import.meta.main) await buildPsp(Bun.argv.slice(2));
