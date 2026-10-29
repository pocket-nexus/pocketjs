import { STABLE_RUST_TOOLCHAIN } from "../tools/build/toolchains/rust.ts";
import type { RuntimeApplication } from "../framework/src/runtime-config.ts";
import { applicationBundle, prepareCompiledApplication, runProgramBuild } from "./build/programs/application.ts";
// NativeScript iOS build, staging and deployment. Application JavaScript
// arrives in a compiled .pocket; this file builds only the native shell.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveProfile } from "../tools/profile-resolver.ts";
import {
  IOS_DEV_DEFAULT_DENSITY,
  IOS_DEV_MAX_DENSITY,
  IOS_DEV_TARGET_ID,
} from "./ios-profile.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DEFAULT_SHELL = resolve(ROOT, "programs/ios-simulator/shell");
const XCFRAMEWORK_SCRIPT = resolve(ROOT, "tools/build-xcframework.sh");
const XCFRAMEWORK_DIST = resolve(ROOT, ".pocket-build/ios/xcframework/PocketApple.xcframework");
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
    exitCode: timedOut ? 124 : child.signalCode ? exitCode || 1 : exitCode,
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
    const targets = (await spawn("rustup", ["target", "list", "--toolchain", STABLE_RUST_TOOLCHAIN, "--installed"])).stdout;
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
    await spawn("rustup", ["target", "add", "--toolchain", STABLE_RUST_TOOLCHAIN, "aarch64-apple-ios", "aarch64-apple-ios-sim"], {
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

/** Build the NativeScript host shell around an already compiled guest. */
export async function buildIOSSimulatorNative(application: RuntimeApplication, outdir: string, args: readonly string[] = []): Promise<void> {
  const { inputs } = applicationBundle(application, IOS_DEV_TARGET_ID);
  const sdk = await spawn("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"]);
  if (sdk.exitCode !== 0 || !sdk.stdout.trim()) throw new Error("iOS simulator native build requires the Xcode iPhoneSimulator SDK");
  if (!Bun.which("ns")) throw new Error("iOS simulator native build requires the NativeScript CLI (ns)");
  const shellDir = resolve(outdir, "shell");
  rmSync(shellDir, { recursive: true, force: true });
  cpSync(DEFAULT_SHELL, shellDir, { recursive: true, filter: source => !["node_modules", "platforms", ".git"].includes(source.split("/").at(-1)!) });
  const packagePath = resolve(shellDir, "package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  manifest.dependencies["@pocketjs/framework"] = `file:${resolve(ROOT, ".")}`;
  writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + "\n");
  const options: StageOptions = { shellDir, externalGuest: args.includes("--external-guest"), tickHz: application.plan.profile.tickHz };
  stageAssets({ appOutput: inputs.appOutput, bundle: application.jsPath, pak: application.pakPath, planPath: application.planPath }, options);
  await buildNative(true);
  await vendPluginXcframework(options);
  await installShellDependencies(options);
  const built = await spawn("ns", ["build", "ios", "--emulator", "--release", ...args.filter(arg => arg !== "--external-guest")], { cwd: shellDir, inherit: true });
  if (built.exitCode !== 0) throw new Error("iOS simulator native shell build failed");
  const candidates = [...new Bun.Glob("platforms/ios/build/**/*.app").scanSync({ cwd: shellDir, onlyFiles: false })];
  const apps = candidates.filter(path => path.includes("iphonesimulator") && !path.includes(".app/"));
  if (apps.length !== 1) throw new Error(`iOS simulator native build must produce one .app, found ${apps.length}`);
  const output = resolve(outdir, "PocketShell.app");
  rmSync(output, { recursive: true, force: true });
  cpSync(resolve(shellDir, apps[0]!), output, { recursive: true });
  cpSync(XCFRAMEWORK_DIST, resolve(outdir, "PocketApple.xcframework"), { recursive: true });
}

interface GuestArtifacts {
  appOutput: string;
  bundle: string;
  pak: string;
  planPath: string;
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

async function play(args: readonly string[]): Promise<void> {
  const selected = await resolveProfile({ from: process.cwd(), runtimeConfig: flagValue(args, "--runtime-config") ?? resolve(ROOT, "programs/ios-simulator/pocket.runtime-config.ts"), requireConfig: true });
  const application = prepareCompiledApplication(selected.profile, args, resolve(ROOT, ".pocket-build/ios/stage"));
  const { inputs } = applicationBundle(application, IOS_DEV_TARGET_ID);
  const requestedHz = tickRateFlag(args);
  const requestedDensity = flagValue(args, "--density");
  // The surface runs the package's rate; the package carries it.
  if ((requestedHz !== undefined && requestedHz !== application.plan.profile.tickHz) ||
      (requestedDensity !== undefined && Number(requestedDensity) !== selected.profile.display.rasterDensity)) {
    throw new Error("iOS staging timing and density must match the compiled package's runtime config");
  }
  const options: StageOptions = {
    shellDir: resolve(flagValue(args, "--shell-dir") ?? DEFAULT_SHELL),
    externalGuest: args.includes("--external-guest"), tickHz: application.plan.profile.tickHz,
    pluginPath: flagValue(args, "--plugin-path"), runtimeTgz: flagValue(args, "--runtime-tgz"),
  };
  if (args.includes("--rebuild-native")) await buildNative(true);
  await vendPluginXcframework(options);
  const artifacts: GuestArtifacts = { appOutput: inputs.appOutput, bundle: application.jsPath, pak: application.pakPath, planPath: application.planPath };
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

  pocket ios doctor                       inspect Xcode, Rust targets and NativeScript
  pocket ios setup                        add Rust iOS targets
  pocket ios devices                      list available simulators
  pocket ios native [--force]              build PocketApple.xcframework
  pocket ios build --pocket <app.pocket>   build the native simulator shell
  pocket ios stage --pocket <app.pocket>   stage the compiled package into the shell
  pocket ios play --pocket <app.pocket>    stage, build and launch the shell

stage/play options:
  --runtime-config=<file>  program profile (default programs/ios-simulator)
  --external-guest         use the shell's generated guest binding
  --shell-dir=<path>       destination NativeScript shell
  --plugin-path=<path>     @nativescript/pocketjs source override
  --runtime-tgz=<path>     @nativescript/ios-quickjs package override
  --device=<name|udid>     simulator selection for play
  --rebuild-native        rebuild the native framework before staging
  --no-launch             stage without launching
  --attach                attach NativeScript logs
  --release               build the shell in release mode
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
        await runProgramBuild("ios-simulator", rest);
        return;
      }
      case "stage": {
        await play([...rest, "--no-launch"]);
        return;
      }
      case "play": {
        await play(rest);
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
