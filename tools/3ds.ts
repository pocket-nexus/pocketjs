// tools/3ds.ts <app> [cargo args…] — build the app JS+pak (tools/build.ts), the
// Rust core staticlib, QuickJS, and the .3dsx for the out-of-registry "3ds-dev"
// profile (tools/3ds-profile.ts).
//
//   bun tools/3ds.ts 3ds-demo
//   bun tools/3ds.ts 3ds-demo --capture           (e2e frame-dump build)
//   bun tools/3ds.ts 3ds-demo --cia               (also emit an installable CIA)
//   bun tools/3ds.ts --plan=<resolved-plan.json> --project-root=<dir>
//
// The toolchain spans two environments. The Rust half compiles on macOS:
// armv6k-nintendo-3ds is a built-in rustc target, so -Z build-std works
// host-side with no devkitARM present. The C half compiles inside the
// devkitpro/devkitarm container, which owns arm-none-eabi-gcc, libctru,
// citro3d, picasso and 3dsxtool. Both halves see the same repository through
// one bind mount at /repo.
//
//   1. tools/build.ts        -> <outdir>/<output>.js + <outdir>/<output>.pak
//   1b. pocket-package.ts    -> dist/3ds/<output>.pocket (also ROMFS recovery)
//   2. cargo build --release -> hosts/3ds/core/target/armv6k-nintendo-3ds/release/
//                               libpocketjs_3ds_core.a   (macOS)
//   3. QuickJS               -> dist/3ds/quickjs/libquickjs.a  (container, cached)
//   3b. makerom (--cia)      -> dist/3ds/makerom/bin/makerom    (container, cached)
//   4. hosts/3ds/Makefile    -> dist/3ds/<output>.3dsx          (container)
//                               dist/3ds/<output>.cia  under --cia
//
// <output> is the resolved plan's app.output, not the bare app argument.
//
// dist/3ds/ is this target's own output tree. A 3DS build never writes into
// dist/, where a PSP or Vita build keeps target-flavored bundles of the same
// name.
//
// ---------------------------------------------------------------------------
// The contract with hosts/3ds/Makefile
// ---------------------------------------------------------------------------
// The Makefile runs in the container with CWD /repo/hosts/3ds and receives all
// paths as container paths. It gets the application, target, primary-display,
// and auxiliary-display variables hostBuildEnvironment() emits —
// POCKETJS_TARGET and POCKETJS_HOST_ABI are the
// values the host must publish as ui.__host / ui.__hostAbi, so the C compile
// derives -DPOCKETJS_TARGET_ID and -DPOCKETJS_HOST_ABI from them rather than
// from literals — plus:
//
//   POCKETJS_CORE_LIB      absolute path to libpocketjs_3ds_core.a
//   POCKETJS_QUICKJS_DIR   directory holding quickjs.h and libquickjs.a
//   POCKETJS_APP_POCKET    target-thinned recovery guest to embed
//   POCKETJS_RUNTIME_SLOT  app-id-derived state directory below runtime/apps
//   POCKETJS_BUILD_DIR     scratch directory for objects, .shbin and the .elf
//   POCKETJS_OUT_3DSX      the .3dsx path to write
//   POCKETJS_SMDH_TITLE    application title  (3dsxtool --smdh metadata)
//   POCKETJS_SMDH_AUTHOR   application id
//   POCKETJS_SMDH_DESC     application description
//   POCKETJS_CAPTURE       "1" under --capture, "" otherwise
//   POCKETJS_CAPTURE_INPUT scripted input tape ("frame:mask,…"), baked in
//   POCKETJS_CAPTURE_TOUCH scripted bottom-screen touch tape, baked in
//   POCKETJS_CAP_START     first frame to dump
//   POCKETJS_CAP_N         how many frames to dump
//
// and, only under --cia, the five the CIA goal needs:
//
//   POCKETJS_OUT_CIA       the .cia path to write ("" disables the goal)
//   POCKETJS_MAKEROM       the makerom binary built by ensureMakerom()
//   POCKETJS_CIA_TITLE     exheader process name, the manifest title cut to 8 B
//   POCKETJS_CIA_PRODUCT   CTR-P-XXXX product code
//   POCKETJS_CIA_UNIQUE_ID title id unique part, e.g. 0xFF3D0
//
// The default goal must produce POCKETJS_OUT_3DSX and nothing outside
// POCKETJS_BUILD_DIR and dist/3ds/.

import { $ } from "bun";
import { containerPathFor, ensureQuickJs, runContainer, THREE_DS_CONTAINER_IMAGE, type Mount } from "./3ds-toolchain.ts";
export { containerPathFor, ensureQuickJs, THREE_DS_CONTAINER_IMAGE } from "./3ds-toolchain.ts";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
} from "../framework/src/manifest/host-build-inputs.ts";
import {
  canonicalJson,
  verifyPlanHash,
  type ResolvedBuildPlan,
} from "../framework/src/manifest/plan.ts";
import {
  THREE_DS_DEV_TARGET_ID,
  resolve3dsBuildPlan,
} from "./3ds-profile.ts";
import { makeVariant } from "./pocket-pack.ts";

const repository = new URL("..", import.meta.url).pathname; // PocketJS/
const hostDirectory = `${repository}hosts/3ds/`;
const coreDirectory = `${hostDirectory}core/`;

/** The dev profile's target id; a plan for any other target is rejected. */
const TARGET_ID = THREE_DS_DEV_TARGET_ID;
const RUST_TARGET = "armv6k-nintendo-3ds";
/** Produced by the `pocketjs-3ds-core` staticlib crate in hosts/3ds/core. */
const CORE_STATIC_LIBRARY = "libpocketjs_3ds_core.a";
// Pin the image that produced the hardware-tested CIA. A floating `latest`
// tag makes fresh machines silently pick a different compiler/libctru/citro3d
// stack; the digest still resolves through the ordinary Docker registry.
const CONTAINER_REPOSITORY = "/repo";
const CONTAINER_OUTPUT = "/out";

// makerom is what turns the ELF into an installable title. It ships in neither
// devkitPro nor Homebrew, so --cia clones and builds it: every dependency
// (mbedtls, blz, yaml) is vendored in the repository, so the clone is the only
// step that needs the network and the build runs in the same offline container
// as everything else.
const MAKEROM_REPOSITORY = "https://github.com/3DSGuy/Project_CTR";
/** Project_CTR revision used to package the hardware-tested CIA. */
export const MAKEROM_REVISION = "e8f5f529c54ff9b22a2491a480ffa69206bf7b19";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface ThreeDsArguments {
  /** Bare app name (apps/<app>/pocket.json); empty when --plan is given. */
  readonly app: string;
  readonly planPath?: string;
  readonly manifestPath?: string;
  readonly projectRoot: string;
  /** Where tools/build.ts writes <app>.js and <app>.pak (trailing slash). */
  readonly outputDir: string;
  /** Where the .3dsx lands. */
  readonly packageDir: string;
  readonly skipBuild: boolean;
  /** Build the target-thinned guest package without rebuilding the native runtime. */
  readonly pocketOnly: boolean;
  readonly capture: boolean;
  /** Also package the ELF as an installable CIA title. */
  readonly cia: boolean;
  readonly configFlagged: boolean;
  readonly useConfig: boolean;
  /** Forwarded to tools/build.ts. */
  readonly buildFlags: readonly string[];
  /** Everything unrecognized, forwarded to cargo. */
  readonly cargoArgs: readonly string[];
}

export interface ParseOptions {
  readonly repositoryRoot?: string;
  readonly workingDirectory?: string;
}

export function parse3dsArguments(
  argv: readonly string[],
  options: ParseOptions = {},
): ThreeDsArguments {
  const root = options.repositoryRoot ?? repository;
  let app = "";
  let planPath: string | undefined;
  let manifestPath: string | undefined;
  let projectRoot = options.workingDirectory ?? process.cwd();
  let outputDir = `${root}dist/3ds/guest/`;
  let packageDir = `${root}dist/3ds`;
  let skipBuild = false;
  let pocketOnly = false;
  let capture = false;
  let cia = false;
  let configFlagged = false;
  let useConfig = true;
  const buildFlags: string[] = [];
  const cargoArgs: string[] = [];

  for (const a of argv) {
    if (a === "--capture") capture = true;
    else if (a === "--cia") cia = true;
    else if (a === "--pocket-only") pocketOnly = true;
    else if (a === "--skip-build") skipBuild = true;
    else if (a.startsWith("--plan=")) planPath = resolvePath(a.slice("--plan=".length));
    else if (a.startsWith("--manifest=")) manifestPath = resolvePath(a.slice("--manifest=".length));
    else if (a.startsWith("--project-root=")) projectRoot = resolvePath(a.slice("--project-root=".length));
    else if (a.startsWith("--outdir=")) outputDir = resolvePath(a.slice("--outdir=".length)) + "/";
    else if (a.startsWith("--package-outdir=")) packageDir = resolvePath(a.slice("--package-outdir=".length));
    else if (a.startsWith("--config=")) {
      configFlagged = true;
      buildFlags.push(a);
    } else if (a === "--no-config") {
      useConfig = false;
      buildFlags.push(a);
    } else if (!app && !a.startsWith("-")) app = a;
    else cargoArgs.push(a);
  }

  return {
    app,
    planPath,
    manifestPath,
    projectRoot,
    outputDir,
    packageDir,
    skipBuild,
    pocketOnly,
    capture,
    cia,
    configFlagged,
    useConfig,
    buildFlags,
    cargoArgs,
  };
}

const USAGE =
  "usage: bun tools/3ds.ts <app> [--plan=<resolved-plan.json>] [--project-root=<dir>] " +
  "[--outdir=<dir>] [--package-outdir=<dir>] [--skip-build] [--pocket-only] [--capture] [--cia] [cargo args…]   " +
  "e.g. bun tools/3ds.ts 3ds-demo --cia";

export interface CaptureDefines {
  readonly input: string;
  readonly touch: string;
  readonly start: string;
  readonly count: string;
}

/**
 * Validate the values compiled into a capture binary. Besides giving
 * direct `--capture` builds a complete 0..0 default window, the narrow grammar
 * keeps environment text from becoming C or shell syntax in the Makefile's
 * `-D` arguments.
 */
export function captureDefines(
  environment: Readonly<Record<string, string | undefined>>,
): CaptureDefines {
  const input = environment.POCKETJS_CAPTURE_INPUT ?? "";
  const touch = environment.POCKETJS_CAPTURE_TOUCH ?? "";
  const start = environment.POCKETJS_CAP_START ?? "0";
  const count = environment.POCKETJS_CAP_N ?? "1";
  const integer = "(?:0[xX][0-9a-fA-F]+|[0-9]+)";
  const tape = new RegExp(`^(?:${integer}:${integer})(?:,${integer}:${integer})*$`);
  if (input !== "" && !tape.test(input)) {
    throw new Error(
      "PocketJS 3ds: POCKETJS_CAPTURE_INPUT must be frame:mask pairs separated by commas",
    );
  }
  const touchTape =
    /^(?:[0-9]+:(?:-|[0-9]+,[0-9]+,[0-9]+))(?:@[0-9]+:(?:-|[0-9]+,[0-9]+,[0-9]+))*$/;
  if (touch !== "" && !touchTape.test(touch)) {
    throw new Error(
      "PocketJS 3ds: POCKETJS_CAPTURE_TOUCH must be frame:- or frame:id,x,y entries separated by @",
    );
  }
  for (const entry of touch === "" ? [] : touch.split("@")) {
    const [frame, payload] = entry.split(":");
    boundedCaptureInteger("POCKETJS_CAPTURE_TOUCH frame", frame!, true);
    if (payload === "-") continue;
    const [id, x, y] = payload!.split(",");
    boundedCaptureInteger("POCKETJS_CAPTURE_TOUCH id", id!, true, 0xffn);
    boundedCaptureInteger("POCKETJS_CAPTURE_TOUCH x", x!, true, 319n);
    boundedCaptureInteger("POCKETJS_CAPTURE_TOUCH y", y!, true, 239n);
  }
  boundedCaptureInteger("POCKETJS_CAP_START", start, true);
  boundedCaptureInteger("POCKETJS_CAP_N", count, false);
  return { input, touch, start, count };
}

function boundedCaptureInteger(
  name: string,
  value: string,
  allowZero: boolean,
  maximum = 0xffff_ffffn,
): void {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`PocketJS 3ds: ${name} must be an unsigned decimal integer`);
  }
  const parsed = BigInt(value);
  if (parsed > maximum || (!allowZero && parsed === 0n)) {
    throw new Error(`PocketJS 3ds: ${name} is outside its supported range`);
  }
}

// ---------------------------------------------------------------------------
// Container plumbing
// ---------------------------------------------------------------------------

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function capture(
  command: string,
  args: readonly string[],
  cwd = repository,
): Promise<CommandResult> {
  const child = Bun.spawn({
    cmd: [command, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function preflightContainer(): Promise<string> {
  if (!Bun.which("docker")) {
    throw new Error(
      "PocketJS 3ds: docker was not found on PATH. The 3DS C toolchain " +
        "(arm-none-eabi-gcc, libctru, citro3d, picasso, 3dsxtool) only exists " +
        "in a container; install Docker Desktop and start it.",
    );
  }
  const daemon = await capture("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (daemon.exitCode !== 0) {
    throw new Error(
      "PocketJS 3ds: the Docker daemon is not responding — start Docker Desktop and retry.\n" +
        (daemon.stderr.trim() || daemon.stdout.trim()),
    );
  }
  const image = await capture("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    THREE_DS_CONTAINER_IMAGE,
  ]);
  if (image.exitCode !== 0) {
    throw new Error(
      `PocketJS 3ds: the ${THREE_DS_CONTAINER_IMAGE} image is not present locally. Run:\n` +
        `  docker pull ${THREE_DS_CONTAINER_IMAGE}`,
    );
  }
  return image.stdout.trim();
}

/**
 * The toolchain the Rust core builds with: hosts/3ds/core/rust-toolchain.toml
 * owns the choice when it exists, otherwise plain nightly. -Z build-std needs
 * rust-src for whichever one wins.
 */
async function preflightRust(): Promise<{ rustup: string; toolchain: string; rustcPath: string }> {
  const rustup = Bun.which("rustup") ?? `${homedir()}/.cargo/bin/rustup`;
  if (!existsSync(rustup)) {
    throw new Error(
      "PocketJS 3ds: rustup not found (expected ~/.cargo/bin/rustup). Install Rust from https://rustup.rs.",
    );
  }
  let toolchain = "nightly";
  if (existsSync(`${coreDirectory}rust-toolchain.toml`)) {
    const active = await capture(rustup, ["show", "active-toolchain"], coreDirectory);
    const named = active.stdout.trim().split(/\s+/)[0];
    if (active.exitCode === 0 && named) toolchain = named;
  }
  const rustc = await capture(rustup, ["run", toolchain, "rustc", "--version"]);
  if (rustc.exitCode !== 0) {
    throw new Error(
      `PocketJS 3ds: the ${toolchain} toolchain is not installed. Run:\n` +
        `  rustup toolchain install ${toolchain}`,
    );
  }
  const components = await capture(rustup, [
    "component",
    "list",
    "--toolchain",
    toolchain,
    "--installed",
  ]);
  if (!components.stdout.split(/\r?\n/).some((line) => line.startsWith("rust-src"))) {
    throw new Error(
      `PocketJS 3ds: rust-src is required to build core/alloc for ${RUST_TARGET}. Run:\n` +
        `  rustup component add rust-src --toolchain ${toolchain}`,
    );
  }
  const compiler = await capture(rustup, ["which", "--toolchain", toolchain, "rustc"]);
  if (compiler.exitCode !== 0) throw new Error("PocketJS 3ds: cannot resolve the pinned Rust compiler");
  return { rustup, toolchain, rustcPath: compiler.stdout.trim() };
}

// ---------------------------------------------------------------------------
// QuickJS
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// makerom (--cia)
// ---------------------------------------------------------------------------

/**
 * Clone and build makerom, and cache the binary. The stamp covers the checked
 * out revision and the container image, so a re-clone or a new devkitARM
 * release rebuilds and nothing else does.
 *
 * The clone happens on macOS because the container runs with --network=none;
 * the build happens in the container because that is where this repository's
 * device toolchain lives. makerom vendors mbedtls, blz and yaml, so nothing
 * after the clone reaches the network.
 */
export async function ensureMakerom(
  cacheDirectory: string,
  imageId: string,
  mounts: readonly Mount[],
): Promise<string> {
  const checkout = join(cacheDirectory, "src");
  const project = join(checkout, "makerom");
  const binary = join(project, "bin", "makerom");
  const stampPath = join(cacheDirectory, ".stamp");

  const installedHead = existsSync(join(project, "makefile"))
    ? await capture("git", ["rev-parse", "HEAD"], checkout)
    : undefined;
  if (installedHead?.exitCode !== 0 || installedHead?.stdout.trim() !== MAKEROM_REVISION) {
    if (!Bun.which("git")) {
      throw new Error("PocketJS 3ds: --cia needs git on PATH to fetch makerom.");
    }
    mkdirSync(cacheDirectory, { recursive: true });
    rmSync(checkout, { recursive: true, force: true });
    console.log(`PocketJS 3ds: fetching makerom ${MAKEROM_REVISION} …`);
    const steps: ReadonlyArray<readonly [readonly string[], string]> = [
      [["init", checkout], repository],
      [["remote", "add", "origin", MAKEROM_REPOSITORY], checkout],
      [["fetch", "--depth", "1", "origin", MAKEROM_REVISION], checkout],
      [["checkout", "--detach", "FETCH_HEAD"], checkout],
    ];
    for (const [command, cwd] of steps) {
      const result = await capture("git", command, cwd);
      if (result.exitCode !== 0) {
        rmSync(checkout, { recursive: true, force: true });
        throw new Error(
          `PocketJS 3ds: could not fetch makerom ${MAKEROM_REVISION} into ${checkout}.\n` +
            (result.stderr.trim() || result.stdout.trim()) +
            "\nmakerom is the only tool that builds a CIA and ships in neither " +
            "devkitPro nor Homebrew. With no network, place that revision at " +
            `${checkout} and rerun; the build itself is offline.`,
        );
      }
    }
  }

  const head = await capture("git", ["rev-parse", "HEAD"], checkout);
  if (head.exitCode !== 0 || head.stdout.trim() !== MAKEROM_REVISION) {
    throw new Error(`PocketJS 3ds: makerom checkout is not pinned to ${MAKEROM_REVISION}`);
  }
  const stamp = `${imageId} ${MAKEROM_REVISION}`;
  if (
    existsSync(binary) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8").trim() === stamp
  ) {
    console.log(`PocketJS 3ds: makerom cached (${binary})`);
    return binary;
  }

  console.log("PocketJS 3ds: building makerom …");
  await runContainer(
    ["make deps", `make -j${availableParallelism()}`].join("\n"),
    mounts,
    containerPathFor(project, mounts),
    {},
    "makerom build",
  );
  if (!existsSync(binary)) {
    throw new Error(`PocketJS 3ds: the makerom build did not produce ${binary}`);
  }
  writeFileSync(stampPath, `${stamp}\n`);
  return binary;
}

// ---------------------------------------------------------------------------
// CIA identity
// ---------------------------------------------------------------------------

/** FNV-1a over the UTF-8 bytes; the hash this repository already stamps with. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The unique part of the title id, `0x0004000000<unique>00`.
 *
 * **Unique ids 0xFF000-0xFFFFF are the homebrew block**: no retail game and no
 * system title is assigned one, so an installed CIA cannot collide with a title
 * the console already has. The low 12 bits come from the manifest's app id, so
 * an app keeps its title id across rebuilds — an install replaces the previous
 * one instead of accumulating — and two apps get different ids without anyone
 * choosing a number by hand.
 */
export function ciaUniqueId(appId: string): string {
  return `0x${(0xff000 | (fnv1a32(appId) & 0xfff)).toString(16).toUpperCase()}`;
}

/**
 * Stable SD-card namespace for one application's mutable 3DS Runtime state.
 *
 * The complete manifest id is the authority. A fixed-length SHA-256 prefix
 * keeps every native path bounded while making unrelated HBL entries unable
 * to recover or hot-load one another's package.
 */
export function runtimeSlot(appId: string): string {
  return createHash("sha256").update(appId, "utf8").digest("hex").slice(0, 16);
}

/**
 * The full 64-bit title id as hex: category 0x00040000 (a CTR application),
 * then the unique id shifted up by the 8-bit variation, which is 0. It names
 * the directory the installed title lands in, on an SD card and in Azahar
 * alike: `Nintendo 3DS/<id>/<id>/title/00040000/<low 32 bits>/content/`.
 */
export function ciaTitleId(appId: string): string {
  const unique = 0xff000 | (fnv1a32(appId) & 0xfff);
  return `00040000${((unique << 8) >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * The product code, `CTR-P-XXXX`. Nintendo assigns retail codes; homebrew
 * invents its own, so the four characters are the app id's last dotted segment
 * reduced to A-Z0-9, extended from the id's hash when it is shorter than four.
 * The shape is the one makerom validates even without `FreeProductCode`.
 */
export function ciaProductCode(appId: string): string {
  const segment = appId.split(".").pop() || appId;
  const letters = segment.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const filler = fnv1a32(appId).toString(36).toUpperCase();
  return `CTR-P-${`${letters}${filler}`.slice(0, 4)}`;
}

/**
 * The exheader's process name, which is **8 bytes** — makerom truncates a
 * longer BasicInfo.Title to it silently, so the cut happens here where it is
 * visible. Characters that would end the RSF's quoted scalar or start another
 * substitution are dropped first. The title HOME Menu shows is the SMDH's, not
 * this one, and keeps the manifest string whole.
 */
export function ciaProcessName(title: string, appId: string): string {
  const printable = title.replace(/[^\x20-\x7e]/g, "").replace(/["\\$]/g, "");
  const cut = printable.slice(0, 8).trim();
  return cut || `PJ${(fnv1a32(appId) & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Build plan
// ---------------------------------------------------------------------------

function assert3dsPlan(plan: ResolvedBuildPlan, origin: string): ResolvedBuildPlan {
  if (!verifyPlanHash(plan) || plan.target.id !== TARGET_ID) {
    throw new Error(`PocketJS 3ds: invalid ${TARGET_ID} ResolvedBuildPlan at ${origin}`);
  }
  return plan;
}

async function loadBuildPlan(
  args: ThreeDsArguments,
): Promise<{ plan: ResolvedBuildPlan; planPath: string; manifestPath: string }> {
  if (args.planPath) {
    if (args.configFlagged || !args.useConfig) {
      throw new Error("PocketJS 3ds: config overrides are forbidden with --plan");
    }
    const plan = (await Bun.file(args.planPath).json()) as ResolvedBuildPlan;
    const checked = assert3dsPlan(plan, args.planPath);
    const entry = resolvePath(args.projectRoot, checked.app.entry);
    let directory = dirname(entry);
    let manifestPath = args.manifestPath ?? "";
    const boundary = resolvePath(args.projectRoot);
    while (!manifestPath) {
      const candidate = join(directory, "pocket.json");
      if (existsSync(candidate)) {
        manifestPath = candidate;
        break;
      }
      if (directory === boundary || dirname(directory) === directory) break;
      directory = dirname(directory);
    }
    if (!manifestPath) {
      throw new Error(
        `PocketJS 3ds: ${args.planPath} needs its source pocket.json between ${dirname(entry)} and ${boundary}; ` +
          "the runtime package carries the admitted manifest verbatim",
      );
    }
    const manifestPlan = resolve3dsBuildPlan(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (canonicalJson(manifestPlan) !== canonicalJson(checked)) {
      throw new Error(
        `PocketJS 3ds: ${args.planPath} has drifted from ${manifestPath}; regenerate the resolved plan before packaging`,
      );
    }
    return { plan: checked, planPath: args.planPath, manifestPath };
  }
  // An app outside this repository is named relative to --project-root.
  const candidates = [
    ...new Set([
      join(args.projectRoot, "apps", args.app, "pocket.json"),
      `${repository}apps/${args.app}/pocket.json`,
    ]),
  ];
  const manifest = candidates.find((path) => existsSync(path));
  if (!manifest) {
    throw new Error(
      `PocketJS 3ds: no manifest for "${args.app}" (looked in ${candidates.join(", ")}). ` +
        "A 3DS app declares its own 400x240 native viewport; the stock " +
        "integer-fit demos cannot be admitted.",
    );
  }
  const plan = assert3dsPlan(
    resolve3dsBuildPlan(JSON.parse(readFileSync(manifest, "utf8"))),
    manifest,
  );
  const planPath = `${repository}.pocket/3ds/${plan.app.output}.plan.json`;
  mkdirSync(resolvePath(planPath, ".."), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { plan, planPath, manifestPath: manifest };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export async function build3ds(argv: readonly string[]): Promise<string> {
  const args = parse3dsArguments(argv);
  if (!args.app && !args.planPath) throw new Error(USAGE);
  if (!existsSync(hostDirectory)) {
    throw new Error(`PocketJS 3ds: the host is absent at ${hostDirectory}`);
  }

  if (args.pocketOnly && (args.capture || args.cia)) {
    throw new Error("PocketJS 3ds: --pocket-only cannot be combined with --capture or --cia");
  }
  const { plan, planPath, manifestPath } = await loadBuildPlan(args);
  const inputs = extractHostBuildInputs(plan, { expectedTarget: TARGET_ID });
  const capture = args.capture
    ? captureDefines(process.env)
    : { input: "", touch: "", start: "", count: "" };

  // 1. guest bundle + pak
  console.log(`PocketJS 3ds: building app "${plan.app.output}" (${plan.app.framework})`);
  mkdirSync(args.outputDir, { recursive: true });
  if (!args.skipBuild) {
    await $`bun tools/build.ts --plan=${planPath} --project-root=${args.projectRoot} --outdir=${args.outputDir} ${args.buildFlags}`
      .cwd(repository);
  }
  const guestJavaScript = join(args.outputDir, `${inputs.appOutput}.js`);
  const guestPack = join(args.outputDir, `${inputs.appOutput}.pak`);
  for (const artifact of [guestJavaScript, guestPack]) {
    if (!existsSync(artifact)) {
      throw new Error(`PocketJS 3ds: the guest build did not produce ${artifact}`);
    }
  }

  // A 3DS application update is a normal target-thinned `.pocket`: admitted
  // manifest, resolved plan, compiled guest and target-flavoured pak. The same
  // artifact is embedded as the runtime's immutable recovery guest and written
  // beside the native binary for SD-card deployment.
  mkdirSync(args.packageDir, { recursive: true });
  const manifestBytes = new Uint8Array(readFileSync(manifestPath));
  const guestPackage = encodePocketPackage({
    manifest: manifestBytes,
    variants: [
      makeVariant({
        target: TARGET_ID,
        hostAbi: plan.target.hostAbi,
        planJson: canonicalJson(plan),
        identity: {
          output: plan.app.output,
          id: plan.app.id,
          title: plan.app.title,
        },
        js: new Uint8Array(readFileSync(guestJavaScript)),
        pak: new Uint8Array(readFileSync(guestPack)),
      }),
    ],
  });
  const pocketOutput = join(args.packageDir, `${inputs.appOutput}.pocket`);
  writeFileSync(pocketOutput, guestPackage);
  console.log(`output: ${pocketOutput} (${guestPackage.length} bytes, ${TARGET_ID} abi ${plan.target.hostAbi})`);
  const appRuntimeSlot = runtimeSlot(plan.app.id);
  console.log(
    `runtime: /pocketjs/runtime/apps/${appRuntimeSlot} (${plan.app.id})`,
  );
  if (args.pocketOnly) return pocketOutput;

  const imageId = await preflightContainer();
  const { rustup, toolchain, rustcPath } = await preflightRust();

  // 2. the Rust core staticlib, on macOS
  console.log(`PocketJS 3ds: cargo build --release (${RUST_TARGET}, ${toolchain})`);
  await $`${rustup} run ${toolchain} cargo build --release ${args.cargoArgs}`
    .cwd(coreDirectory)
    .env({
      ...process.env,
      RUSTC: rustcPath,
      ...hostBuildEnvironment(inputs, {
        outputDirectory: args.outputDir,
        embedApp: true,
      }),
    });
  const releaseDirectory = `${coreDirectory}target/${RUST_TARGET}/release`;
  const coreLibrary = join(releaseDirectory, CORE_STATIC_LIBRARY);
  if (!existsSync(coreLibrary)) {
    const found = existsSync(releaseDirectory)
      ? readdirSync(releaseDirectory).filter((name) => name.endsWith(".a"))
      : [];
    throw new Error(
      `PocketJS 3ds: ${CORE_STATIC_LIBRARY} is absent from ${releaseDirectory}` +
        (found.length > 0 ? ` (found ${found.join(", ")})` : "") +
        " — hosts/3ds/core must be a staticlib crate named pocketjs-3ds-core",
    );
  }

  // 3-4. everything that needs devkitARM
  const distributionRoot = `${repository}dist/3ds`;
  const quickJsDirectory = join(distributionRoot, "quickjs");
  // C objects, romfs staging and SMDH metadata are cacheable only within one
  // resolved output. A shared directory can package app B with app A's older
  // romfs files when their mtimes happen to precede the staging targets.
  const buildDirectory = join(distributionRoot, "build", inputs.appOutput);
  mkdirSync(buildDirectory, { recursive: true });

  const mounts: Mount[] = [
    { hostPath: repository, containerPath: CONTAINER_REPOSITORY },
  ];
  const outsideRepository = [args.outputDir, args.packageDir, args.projectRoot].filter(
    (path) => !resolvePath(path).startsWith(`${resolvePath(repository)}/`),
  );
  if (outsideRepository.length > 0) {
    // One extra mount covers an app built outside the repository; a second
    // distinct root would need its own and is refused by containerPathFor.
    mounts.push({
      hostPath: resolvePath(outsideRepository[0]),
      containerPath: CONTAINER_OUTPUT,
    });
  }

  await ensureQuickJs(quickJsDirectory, imageId, mounts);
  const makerom = args.cia
    ? await ensureMakerom(join(distributionRoot, "makerom"), imageId, mounts)
    : "";

  const output = join(args.packageDir, `${inputs.appOutput}.3dsx`);
  const ciaOutput = join(args.packageDir, `${inputs.appOutput}.cia`);
  const makeEnvironment: Record<string, string> = {
    ...hostBuildEnvironment(inputs, {
      outputDirectory: containerPathFor(args.outputDir, mounts),
      embedApp: true,
    }),
    POCKETJS_CORE_LIB: containerPathFor(coreLibrary, mounts),
    POCKETJS_QUICKJS_DIR: containerPathFor(quickJsDirectory, mounts),
    POCKETJS_APP_POCKET: containerPathFor(pocketOutput, mounts),
    POCKETJS_RUNTIME_SLOT: appRuntimeSlot,
    POCKETJS_BUILD_DIR: containerPathFor(buildDirectory, mounts),
    POCKETJS_OUT_3DSX: containerPathFor(output, mounts),
    POCKETJS_OFFLOAD: plan.features["io.offload"] ? "1" : "",
    POCKETJS_MEDIA: plan.features["media.playback"] ? "1" : "",
    POCKETJS_OFFLOAD_SLOT: createHash("sha256").update(plan.app.id).digest("hex").slice(0, 16),
    POCKETJS_SMDH_TITLE: plan.app.title,
    POCKETJS_SMDH_AUTHOR: plan.app.id,
    POCKETJS_SMDH_DESC: `PocketJS ${plan.app.title}`,
    POCKETJS_CAPTURE: args.capture ? "1" : "",
    // Explicit so a previous run's tape never lingers in the object cache.
    POCKETJS_CAPTURE_INPUT: capture.input,
    POCKETJS_CAPTURE_TOUCH: capture.touch,
    POCKETJS_CAP_START: capture.start,
    POCKETJS_CAP_N: capture.count,
    // The CIA goal is off unless POCKETJS_OUT_CIA names a file. Title, product
    // code and unique id are all derived from the resolved plan.
    POCKETJS_OUT_CIA: args.cia ? containerPathFor(ciaOutput, mounts) : "",
    POCKETJS_MAKEROM: args.cia ? containerPathFor(makerom, mounts) : "",
    POCKETJS_CIA_TITLE: ciaProcessName(plan.app.title, plan.app.id),
    POCKETJS_CIA_PRODUCT: ciaProductCode(plan.app.id),
    POCKETJS_CIA_UNIQUE_ID: ciaUniqueId(plan.app.id),
  };

  const notes = [args.capture ? "capture" : "", args.cia ? "cia" : ""].filter(Boolean);
  console.log(
    `PocketJS 3ds: make (${THREE_DS_CONTAINER_IMAGE}${notes.length > 0 ? `, ${notes.join(", ")}` : ""})`,
  );
  await runContainer(
    `make -j${availableParallelism()}`,
    mounts,
    containerPathFor(hostDirectory, mounts),
    makeEnvironment,
    "hosts/3ds/Makefile",
  );
  if (!existsSync(output)) {
    throw new Error(`PocketJS 3ds: the container build did not produce ${output}`);
  }
  console.log(`output: ${output}`);
  if (args.cia) {
    if (!existsSync(ciaOutput)) {
      throw new Error(`PocketJS 3ds: the container build did not produce ${ciaOutput}`);
    }
    console.log(
      `output: ${ciaOutput} (title id ${ciaTitleId(plan.app.id)}, install with \`azahar -i\`)`,
    );
  }
  return output;
}

if (import.meta.main) {
  try {
    await build3ds(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
