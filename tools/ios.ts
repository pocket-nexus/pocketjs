// tools/ios.ts — the pocket ios toolchain: doctor/setup for Xcode, the
// simulator and the NativeScript CLI; guest builds against the transitional
// ios-dev profile; staging into the committed NativeScript shell
// (hosts/ios-nativescript); and launch on an arm64 iOS simulator.
//
//   pocket ios doctor
//   pocket ios setup --yes
//   pocket ios devices
//   pocket ios native [--force]
//   pocket ios build nsengine [--density=1..4]
//   pocket ios stage nsengine [--external-guest] [flags]
//   pocket ios play  nsengine [--external-guest] [--device=<name|udid>] [flags]
//
// `play` is also reachable as `pocket play ios <app>`.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { demoManifestFor } from "./demo-identity.ts";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import {
  IOS_DEV_DEFAULT_DENSITY,
  IOS_DEV_MAX_DENSITY,
  IOS_DEV_TARGET_ID,
  resolveIOSDevBuildPlan,
} from "./ios-profile.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DEFAULT_SHELL = resolve(ROOT, "hosts/ios-nativescript");
const XCFRAMEWORK_SCRIPT = resolve(ROOT, "engine/ios/build-xcframework.sh");
const XCFRAMEWORK_DIST = resolve(ROOT, "engine/ios/dist/PocketApple.xcframework");
const MIN_IOS_RUNTIME = 16;
/** Display cadences a PocketSurfaceView can be pinned to: 60, or ProMotion. */
const IOS_TICK_RATES = [60, 120];
const IOS_DEFAULT_TICK_RATE = 60;

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function spawn(
  command: string,
  args: readonly string[],
  options: { inherit?: boolean; cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const child = Bun.spawn({
    cmd: [command, ...args],
    cwd: options.cwd ?? ROOT,
    stdout: options.inherit ? "inherit" : "pipe",
    stderr: options.inherit ? "inherit" : "pipe",
    stdin: "ignore",
  });
  let timedOut = false;
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs)
    : undefined;
  // Drain both pipes concurrently with the exit wait (the tools/symbian.ts
  // shape): `simctl list -j` output routinely outruns the 64 KB pipe buffer,
  // and awaiting exited first deadlocks against a blocked child.
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    options.inherit ? Promise.resolve("") : new Response(child.stdout as ReadableStream).text(),
    options.inherit ? Promise.resolve("") : new Response(child.stderr as ReadableStream).text(),
  ]);
  if (timer) clearTimeout(timer);
  return {
    exitCode: timedOut ? 124 : exitCode,
    stdout,
    stderr: timedOut ? `${stderr}\ncommand timed out` : stderr,
  };
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** The explicit --hz value, or undefined when the flag is absent — callers
 *  fall back to the default (fresh builds) or the build stamp (--no-build). */
function tickRateFlag(args: readonly string[]): number | undefined {
  const raw = flagValue(args, "--hz");
  if (raw === undefined) return undefined;
  const hz = Number(raw);
  if (!IOS_TICK_RATES.includes(hz)) {
    throw new Error(`pocket ios: --hz wants ${IOS_TICK_RATES.join(" or ")}`);
  }
  return hz;
}

function check(label: string, ok: boolean, detail?: string): boolean {
  console.log(`  [${ok ? "ok" : "missing"}] ${label}${detail ? `: ${detail}` : ""}`);
  return ok;
}

function info(label: string, detail: string): void {
  console.log(`  [info] ${label}: ${detail}`);
}

// ---------------------------------------------------------------------------
// Simulator inventory

export interface Simulator {
  udid: string;
  name: string;
  state: string;
  runtimeName: string;
  runtimeVersion: number;
}

async function admissibleRuntimes(): Promise<Map<string, { name: string; version: number }>> {
  const result = await spawn("xcrun", ["simctl", "list", "-j", "runtimes"]);
  const admitted = new Map<string, { name: string; version: number }>();
  if (result.exitCode !== 0) return admitted;
  const parsed = JSON.parse(result.stdout) as {
    runtimes?: Array<{
      identifier?: string;
      isAvailable?: boolean;
      name?: string;
      platform?: string;
      supportedArchitectures?: string[];
      version?: string;
    }>;
  };
  for (const runtime of parsed.runtimes ?? []) {
    const version = Number.parseFloat(runtime.version ?? "0");
    if (
      runtime.identifier &&
      runtime.isAvailable === true &&
      (runtime.platform === "iOS" || runtime.identifier.includes("SimRuntime.iOS")) &&
      (runtime.supportedArchitectures ?? []).includes("arm64") &&
      version >= MIN_IOS_RUNTIME
    ) {
      admitted.set(runtime.identifier, { name: runtime.name ?? runtime.identifier, version });
    }
  }
  return admitted;
}

export async function admissibleSimulators(): Promise<Simulator[]> {
  const runtimes = await admissibleRuntimes();
  const result = await spawn("xcrun", ["simctl", "list", "-j", "devices", "available"]);
  if (result.exitCode !== 0) return [];
  const parsed = JSON.parse(result.stdout) as {
    devices?: Record<
      string,
      Array<{ udid?: string; name?: string; state?: string; deviceTypeIdentifier?: string }>
    >;
  };
  const simulators: Simulator[] = [];
  for (const [runtimeId, devices] of Object.entries(parsed.devices ?? {})) {
    const runtime = runtimes.get(runtimeId);
    if (!runtime) continue;
    for (const device of devices) {
      if (!device.udid || !device.name) continue;
      if (!(device.deviceTypeIdentifier ?? "").includes("iPhone")) continue;
      simulators.push({
        udid: device.udid,
        name: device.name,
        state: device.state ?? "Shutdown",
        runtimeName: runtime.name,
        runtimeVersion: runtime.version,
      });
    }
  }
  return simulators;
}

async function pickSimulator(request?: string): Promise<Simulator> {
  const simulators = await admissibleSimulators();
  if (simulators.length === 0) {
    throw new Error(
      "pocket ios: no arm64 iPhone simulator with an iOS 16+ runtime is available — " +
        "install one with `xcodebuild -downloadPlatform iOS` or via Xcode > Settings > Platforms",
    );
  }
  if (request) {
    const match =
      simulators.find((simulator) => simulator.udid === request) ??
      simulators.find((simulator) => simulator.name.toLowerCase() === request.toLowerCase());
    if (!match) {
      throw new Error(
        `pocket ios: no available simulator matches "${request}" — run \`pocket ios devices\``,
      );
    }
    return match;
  }
  const booted = simulators.find((simulator) => simulator.state === "Booted");
  if (booted) return booted;
  return simulators.sort((a, b) => b.runtimeVersion - a.runtimeVersion)[0];
}

// ---------------------------------------------------------------------------
// doctor / setup / devices

async function commandVersion(command: string, args: readonly string[]): Promise<string | null> {
  if (!Bun.which(command)) return null;
  const result = await spawn(command, args);
  return result.exitCode === 0 ? result.stdout.trim().split("\n")[0] : null;
}

async function doctor(): Promise<boolean> {
  console.log("PocketJS iOS doctor\n");
  console.log("required:");
  const arm64 = (await spawn("uname", ["-m"])).stdout.trim() === "arm64";
  let ok = check(
    "Apple Silicon host",
    arm64,
    arm64 ? undefined : "PocketApple.xcframework and @nativescript/ios-quickjs ship arm64 slices only",
  );
  const xcode = await commandVersion("xcodebuild", ["-version"]);
  ok = check("Xcode", xcode !== null, xcode ?? "xcode-select --install, then install Xcode") && ok;
  const clang = (await spawn("xcrun", ["--find", "clang"])).exitCode === 0;
  ok = check("xcrun clang", clang) && ok;
  const runtimes = await admissibleRuntimes();
  ok = check(
    `arm64 iOS ${MIN_IOS_RUNTIME}+ simulator runtime`,
    runtimes.size > 0,
    runtimes.size > 0
      ? [...runtimes.values()].map((runtime) => runtime.name).join(", ")
      : "xcodebuild -downloadPlatform iOS",
  ) && ok;
  const simulators = await admissibleSimulators();
  ok = check(
    "iPhone simulator device",
    simulators.length > 0,
    simulators.length > 0 ? `${simulators.length} available` : "create one in Xcode > Devices",
  ) && ok;
  ok = check("bun", Bun.which("bun") !== null) && ok;
  const node = await commandVersion("node", ["--version"]);
  const nodeMajor = node ? Number.parseInt(node.replace(/^v/, ""), 10) : 0;
  ok = check("node >= 18", nodeMajor >= 18, node ?? "install Node 18+") && ok;
  const nsVersion = await commandVersion("ns", ["--version"]);
  ok = check("NativeScript CLI", nsVersion !== null, nsVersion ?? "npm install -g nativescript") && ok;

  console.log("\noptional (engine development — the shell consumes the prebuilt plugin):");
  const rustup = Bun.which("rustup") !== null;
  check("rustup", rustup);
  if (rustup) {
    const targets = (await spawn("rustup", ["target", "list", "--installed"])).stdout;
    check("aarch64-apple-ios target", targets.includes("aarch64-apple-ios\n"));
    check("aarch64-apple-ios-sim target", targets.includes("aarch64-apple-ios-sim"));
  }
  info(
    "CocoaPods",
    "not required — neither the shell nor @nativescript/pocketjs carries a Podfile",
  );
  console.log(ok ? "\nready: pocket play ios nsengine" : "\nfix the missing items above, then re-run");
  return ok;
}

async function setup(): Promise<void> {
  if (!Bun.which("rustup")) {
    console.log("pocket ios setup: rustup not found — install from https://rustup.rs (only needed to rebuild the native surface)");
  } else {
    await spawn("rustup", ["target", "add", "aarch64-apple-ios", "aarch64-apple-ios-sim"], {
      inherit: true,
    });
  }
  console.log("everything else is diagnosed, not installed — run `pocket ios doctor`:");
  console.log("  Xcode + simulator runtime: xcodebuild -downloadPlatform iOS");
  console.log("  NativeScript CLI:          npm install -g nativescript");
}

async function devices(): Promise<void> {
  const simulators = await admissibleSimulators();
  if (simulators.length === 0) {
    console.log("no admissible simulators (arm64 iPhone, iOS 16+) — xcodebuild -downloadPlatform iOS");
    return;
  }
  for (const simulator of simulators) {
    console.log(`  ${simulator.udid}  ${simulator.state.padEnd(8)}  ${simulator.name} (${simulator.runtimeName})`);
  }
}

// ---------------------------------------------------------------------------
// native / build / stage

async function buildNative(force: boolean): Promise<void> {
  if (existsSync(XCFRAMEWORK_DIST) && !force) {
    console.log(`pocket ios: PocketApple.xcframework present (${XCFRAMEWORK_DIST}) — use --force to rebuild`);
    return;
  }
  const result = await spawn("bash", [XCFRAMEWORK_SCRIPT], { inherit: true });
  if (result.exitCode !== 0 || !existsSync(XCFRAMEWORK_DIST)) {
    throw new Error("pocket ios: build-xcframework.sh failed (rustup targets missing? run `pocket ios setup`)");
  }
}

interface GuestArtifacts {
  appOutput: string;
  bundle: string;
  pak: string;
  planPath: string;
}

/** What a build baked into its artifacts — the facts staging must agree
 *  with. Written next to the artifacts because the resolved plan cannot
 *  carry them: the plan is hash-sealed and does not own the tick rate. */
interface BuildStamp {
  app: string;
  tickHz: number;
  density: number;
}

function buildStampPath(demo: string): string {
  return resolve(ROOT, `dist/ios/${demo}/build-stamp.json`);
}

function normalizeDemoName(demo: string): string {
  return demo.replace(/-main$/, "");
}

async function buildGuest(demoArg: string, density: number, tickHz: number): Promise<GuestArtifacts> {
  const demo = normalizeDemoName(demoArg);
  const manifest = demoManifestFor(ROOT, demo);
  const plan = resolveIOSDevBuildPlan(manifest, density);
  const planDir = resolve(ROOT, ".pocket/ios");
  mkdirSync(planDir, { recursive: true });
  const planPath = resolve(planDir, `${demo}.plan.json`);
  writeFileSync(planPath, JSON.stringify(plan, null, 2));

  const outdir = resolve(ROOT, `dist/ios/${demo}`);
  const built = await spawn(
    "bun",
    [
      "tools/build.ts",
      `--plan=${planPath}`,
      `--project-root=${ROOT}`,
      `--outdir=${outdir}`,
      `--hz=${tickHz}`,
      // The headline/FPS copy renders the baked rate's digits; pin them so
      // glyph coverage never depends on incidental literals elsewhere.
      "--extra-chars=0123456789",
    ],
    { inherit: true },
  );
  if (built.exitCode !== 0) throw new Error(`pocket ios: guest build failed for ${demo}`);

  const inputs = extractHostBuildInputs(plan, { expectedTarget: IOS_DEV_TARGET_ID });
  const bundle = resolve(outdir, `${inputs.appOutput}.js`);
  const pak = resolve(outdir, `${inputs.appOutput}.pak`);
  if (!existsSync(bundle) || !existsSync(pak)) {
    throw new Error(`pocket ios: expected ${bundle} and ${pak} after the build`);
  }
  const stamp: BuildStamp = { app: inputs.appOutput, tickHz, density };
  writeFileSync(buildStampPath(demo), JSON.stringify(stamp, null, 2) + "\n");
  return { appOutput: inputs.appOutput, bundle, pak, planPath };
}

interface StageOptions {
  shellDir: string;
  externalGuest: boolean;
  tickHz: number;
  pluginPath?: string;
  runtimeTgz?: string;
}

function stageAssets(artifacts: GuestArtifacts, options: StageOptions): void {
  const assets = resolve(options.shellDir, "src/assets/pocket");
  mkdirSync(assets, { recursive: true });
  cpSync(artifacts.bundle, resolve(assets, `${artifacts.appOutput}.pocketjs`));
  cpSync(artifacts.pak, resolve(assets, `${artifacts.appOutput}.pak`));
  cpSync(artifacts.planPath, resolve(assets, `${artifacts.appOutput}.plan.json`));
  writeFileSync(
    resolve(assets, "current.json"),
    JSON.stringify(
      {
        app: artifacts.appOutput,
        externalGuest: options.externalGuest,
        tickHz: options.tickHz,
      },
      null,
      2,
    ) + "\n",
  );
}

async function installShellDependencies(options: StageOptions): Promise<void> {
  const packagePath = resolve(options.shellDir, "package.json");
  const hasOverrides = options.pluginPath !== undefined || options.runtimeTgz !== undefined;
  const committed = readFileSync(packagePath, "utf8");
  try {
    if (hasOverrides) {
      const manifest = JSON.parse(committed) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      if (options.pluginPath) {
        manifest.dependencies["@nativescript/pocketjs"] = `file:${resolve(options.pluginPath)}`;
      }
      if (options.runtimeTgz) {
        manifest.devDependencies["@nativescript/ios-quickjs"] = `file:${resolve(options.runtimeTgz)}`;
      }
      writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + "\n");
    }
    const installed = await spawn("npm", ["install", "--no-audit", "--no-fund"], {
      inherit: true,
      cwd: options.shellDir,
    });
    if (installed.exitCode !== 0) throw new Error("pocket ios: npm install failed in the shell");
  } finally {
    // Restore the maintained shell manifest after checkout-specific overrides.
    writeFileSync(packagePath, committed);
  }
}

async function vendPluginXcframework(options: StageOptions): Promise<void> {
  const plugin = options.pluginPath ?? resolve(options.shellDir, "pocketjs");
  const destination = resolve(plugin, "platforms/ios/PocketApple.xcframework");
  if (!existsSync(XCFRAMEWORK_DIST)) {
    if (existsSync(destination)) return;
    throw new Error("pocket ios: build the canonical runtime framework first with pocket ios native");
  }
  rmSync(destination, { recursive: true, force: true });
  cpSync(XCFRAMEWORK_DIST, destination, { recursive: true });
}

// ---------------------------------------------------------------------------
// play

async function play(demoArg: string, args: readonly string[]): Promise<void> {
  const density = Number(flagValue(args, "--density") ?? IOS_DEV_DEFAULT_DENSITY);
  const requestedHz = tickRateFlag(args);
  const options: StageOptions = {
    shellDir: resolve(flagValue(args, "--shell-dir") ?? DEFAULT_SHELL),
    externalGuest: args.includes("--external-guest"),
    tickHz: requestedHz ?? IOS_DEFAULT_TICK_RATE,
    pluginPath: flagValue(args, "--plugin-path"),
    runtimeTgz: flagValue(args, "--runtime-tgz"),
  };

  if (args.includes("--rebuild-native")) {
    await buildNative(true);
  }
  await vendPluginXcframework(options);

  let artifacts: GuestArtifacts;
  if (args.includes("--no-build")) {
    const demo = normalizeDemoName(demoArg);
    const planPath = resolve(ROOT, `.pocket/ios/${demo}.plan.json`);
    if (!existsSync(planPath)) {
      throw new Error(`pocket ios: --no-build but no prior plan at ${planPath}`);
    }
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const inputs = extractHostBuildInputs(plan, { expectedTarget: IOS_DEV_TARGET_ID });
    artifacts = {
      appOutput: inputs.appOutput,
      bundle: resolve(ROOT, `dist/ios/${demo}/${inputs.appOutput}.js`),
      pak: resolve(ROOT, `dist/ios/${demo}/${inputs.appOutput}.pak`),
      planPath,
    };
    if (!existsSync(artifacts.bundle) || !existsSync(artifacts.pak)) {
      throw new Error("pocket ios: --no-build but no prior guest artifacts — drop the flag");
    }
    // Timing (and glyph scale) are baked into the reused artifacts; staging
    // must repeat the bundle's facts, never the flags' defaults. Bundles
    // refuse a mismatched rate at mount, so a stale stage fails on-device.
    if (!existsSync(buildStampPath(demo))) {
      throw new Error(
        "pocket ios: --no-build but the prior build predates build stamps — rebuild once without it",
      );
    }
    const stamp = JSON.parse(readFileSync(buildStampPath(demo), "utf8")) as BuildStamp;
    if (requestedHz !== undefined && requestedHz !== stamp.tickHz) {
      throw new Error(
        `pocket ios: --no-build reuses a ${stamp.tickHz} Hz build but --hz=${requestedHz} was asked — rebuild, or drop --hz`,
      );
    }
    if (flagValue(args, "--density") !== undefined && density !== stamp.density) {
      throw new Error(
        `pocket ios: --no-build reuses a density-${stamp.density} build but --density=${density} was asked — rebuild, or drop --density`,
      );
    }
    options.tickHz = stamp.tickHz;
  } else {
    artifacts = await buildGuest(demoArg, density, options.tickHz);
  }
  stageAssets(artifacts, options);
  await installShellDependencies(options);

  if (args.includes("--no-launch")) {
    console.log(`pocket ios: staged ${artifacts.appOutput} into ${options.shellDir} (launch skipped)`);
    return;
  }

  const simulator = await pickSimulator(flagValue(args, "--device"));
  console.log(`pocket ios: launching on ${simulator.name} (${simulator.runtimeName}, ${simulator.udid})`);
  // Idempotent: "Unable to boot device in current state: Booted" is fine.
  await spawn("xcrun", ["simctl", "boot", simulator.udid]);
  await spawn("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", simulator.udid]);

  const runArgs = ["run", "ios", "--device", simulator.udid, "--no-hmr"];
  if (!args.includes("--attach")) runArgs.push("--justlaunch");
  if (args.includes("--release")) runArgs.push("--release");
  const ran = await spawn("ns", runArgs, { inherit: true, cwd: options.shellDir });
  if (ran.exitCode !== 0) throw new Error("pocket ios: ns run ios failed");
}

// ---------------------------------------------------------------------------

const HELP = `PocketJS Apple / iOS toolchain

  pocket ios doctor                 inspect Xcode, the simulator, Rust targets and the NativeScript CLI
  pocket ios setup                  add the two Rust iOS targets; print install hints for the rest
  pocket ios devices                list the arm64 iOS simulators this target can run on
  pocket ios native [--force]       build engine/ios/dist/PocketApple.xcframework
  pocket ios build <app> [--density=1..${IOS_DEV_MAX_DENSITY}] [--hz=${IOS_TICK_RATES.join("|")}]
                                    resolve the ${IOS_DEV_TARGET_ID} plan and emit dist/ios/<app>/
  pocket ios stage <app> [flags]    build + copy assets into the shell, without launching
  pocket ios play <app> [flags]     stage, then build and launch the shell on the simulator

flags for stage/play:
  --density=1..${IOS_DEV_MAX_DENSITY}      guest raster density (default ${IOS_DEV_DEFAULT_DENSITY}; glyphs bake at this scale)
  --hz=${IOS_TICK_RATES.join("|")}         ticks per second of guest time (default ${IOS_DEFAULT_TICK_RATE}; 120 for ProMotion)
                      Glyphs are density-baked; timing is hz-baked. A bundle
                      only runs correctly at the hz it was built with, so the
                      shell is staged with that rate.
  --external-guest    evaluate the guest in the shell's own runtime (PocketHostView)
  --device=<name|udid>  pick a specific simulator (default: booted, else newest runtime)
  --rebuild-native    rebuild PocketApple.xcframework first (needs Rust iOS targets)
  --no-build          reuse the previous guest build for this app
  --no-launch         stage only
  --attach            stay attached to ns run for console output (default exits after launch)
  --release           build the shell in release configuration
  --shell-dir=<path>  stage into another NativeScript app instead of hosts/ios-nativescript
  --plugin-path=<path>  override the maintained @nativescript/pocketjs checkout
  --runtime-tgz=<path>  use a local @nativescript/ios-quickjs tgz instead of npm
`;

export async function iosMain(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "doctor": {
        const ok = await doctor();
        if (!ok) process.exitCode = 1;
        return;
      }
      case "setup":
        await setup();
        return;
      case "devices":
        await devices();
        return;
      case "native":
        await buildNative(rest.includes("--force"));
        return;
      case "build": {
        if (!rest[0] || rest[0].startsWith("--")) throw new Error("pocket ios build: missing app name");
        const density = Number(flagValue(rest, "--density") ?? IOS_DEV_DEFAULT_DENSITY);
        const artifacts = await buildGuest(rest[0], density, tickRateFlag(rest) ?? IOS_DEFAULT_TICK_RATE);
        console.log(`pocket ios: built ${artifacts.bundle}`);
        return;
      }
      case "stage": {
        if (!rest[0] || rest[0].startsWith("--")) throw new Error("pocket ios stage: missing app name");
        await play(rest[0], [...rest.slice(1), "--no-launch"]);
        return;
      }
      case "play": {
        if (!rest[0] || rest[0].startsWith("--")) throw new Error("pocket ios play: missing app name");
        await play(rest[0], rest.slice(1));
        return;
      }
      default:
        console.log(HELP);
        if (command !== undefined && command !== "help" && command !== "--help") {
          process.exitCode = 1;
        }
    }
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await iosMain();
}
