import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { vitaTitleId } from "../framework/src/manifest/vita-package.ts";
import { demoIdentity, demoManifestFor } from "./demo-identity.ts";
import { VITA_REQUIRED_SYSTEM_ASSETS } from "./vita-package.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOME = homedir();
const PLAY_DIR = `${ROOT}dist/play-vita`;
const VPK = `${PLAY_DIR}/pocketjs-vita.vpk`;
const VPK_STAMP = `${VPK}.play.json`;
const PLAY_CONFIG = `${PLAY_DIR}/config.yml`;

const defaultVita3kApp = [`${HOME}/Applications/Vita3K.app`, "/Applications/Vita3K.app"].find(
  existsSync,
);
const vita3kApp = process.env.VITA3K_APP || defaultVita3kApp;
const vita3kCandidate =
  process.env.VITA3K || (vita3kApp ? `${vita3kApp}/Contents/MacOS/Vita3K` : Bun.which("Vita3K"));
const vita3k = vita3kCandidate?.includes("/") ? vita3kCandidate : Bun.which(vita3kCandidate ?? "");
const defaultConfig =
  process.platform === "darwin"
    ? `${HOME}/Library/Application Support/Vita3K/Vita3K/config.yml`
    : `${HOME}/.config/Vita3K/config.yml`;
const sourceConfig = process.env.VITA3K_CONFIG || defaultConfig;

function demos(): string[] {
  const root = `${ROOT}apps`;
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(`${root}/${entry.name}/main.tsx`))
    .map((entry) => entry.name)
    .sort();
}

function usage(message?: string): never {
  if (message) console.error(`play: ${message}\n`);
  console.error(
    "usage: bun play vita <demo> [--fullscreen] [--no-build] [--no-launch] [--framework=solid|vue-vapor|octane]\n" +
      "       bun play ios <demo> [--no-build] [--no-launch] [ios flags]\n" +
      `demos: ${demos().join(", ")}`,
  );
  process.exit(message ? 2 : 0);
}

function setScalar(config: string, key: string, value: string): string {
  const line = new RegExp(`^${key}:.*$`, "m");
  return line.test(config)
    ? config.replace(line, `${key}: ${value}`)
    : `${config.trimEnd()}\n${key}: ${value}\n`;
}

function setEmptyList(config: string, key: string): string {
  const lines = config.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (start < 0) return `${config.trimEnd()}\n${key}: []\n`;
  lines[start] = `${key}: []`;
  let end = start + 1;
  while (end < lines.length && /^\s+/.test(lines[end]!)) end++;
  lines.splice(start + 1, end - start - 1);
  return lines.join("\n");
}

function vitaFsFrom(configPath: string, config: string): string {
  const configured = config.match(/^pref-path:\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, "");
  return configured || `${dirname(configPath)}/fs`;
}

function vpkSha256(): string {
  return createHash("sha256").update(readFileSync(VPK)).digest("hex");
}

async function run(command: string[], label: string): Promise<void> {
  const proc = Bun.spawn(command, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0 || proc.signalCode) throw new Error(`${label} failed: ${proc.signalCode ?? code}`);
}

async function stopVita3K(): Promise<void> {
  if (!vita3k || !Bun.which("pgrep") || !Bun.which("pkill")) return;
  const isRunning = (): boolean =>
    Bun.spawnSync(["pgrep", "-f", vita3k], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  if (!isRunning()) return;

  console.log("PocketJS play: stopping the running Vita3K instance ...");
  if (process.platform === "darwin" && vita3k.includes(".app/Contents/MacOS/") && Bun.which("osascript")) {
    const quit = Bun.spawn(
      ["osascript", "-e", 'tell application id "com.github.Vita3K.Vita3K" to quit'],
      { stdout: "ignore", stderr: "ignore" },
    );
    quit.unref();
  } else {
    Bun.spawnSync(["pkill", "-TERM", "-f", vita3k], { stdout: "ignore", stderr: "ignore" });
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    await Bun.sleep(100);
    if (!isRunning()) return;
  }

  // Vita3K 0.2.1 can hang in guest/GXM teardown on macOS. The E2E harness
  // uses the same host-owned fallback instead of asking the guest to exit.
  console.log("PocketJS play: Vita3K did not quit cleanly; forcing restart ...");
  Bun.spawnSync(["pkill", "-KILL", "-f", vita3k], { stdout: "ignore", stderr: "ignore" });
  for (let attempt = 0; attempt < 20; attempt++) {
    await Bun.sleep(100);
    if (!isRunning()) return;
  }
  throw new Error("Vita3K did not stop; close it and retry");
}

const args = Bun.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) usage();
const platform = args.shift();
const demoArg = args.shift();
const playTargets = { vita: true, ios: true } as const;
if (!platform || !(platform in playTargets)) usage(`unsupported platform ${platform ?? "<missing>"}`);
if (!demoArg) usage("missing demo name");

if (platform === "ios") {
  const demo = demoArg.replace(/-main$/, "");
  if (!demos().includes(demo)) usage(`unknown demo ${demoArg}`);
  const framework = args.find(arg => arg.startsWith("--framework="))?.slice("--framework=".length) ??
    (demo.endsWith("vue-vapor") ? "vue-vapor" : demo.endsWith("octane") ? "octane" : "solid");
  const output = `${ROOT}.pocket-build/play-ios/${demo}`;
  const pocket = `${output}/application.pocket`;
  if (!args.includes("--no-build")) {
    mkdirSync(output, { recursive: true });
    const manifest = `${output}/pocket.json`;
    writeFileSync(manifest, JSON.stringify(demoManifestFor(ROOT, demo, framework), null, 2) + "\n");
    await run([process.execPath, "tools/pocket.ts", "compile", "--target", "ios-dev",
      "--manifest", manifest, "--project-root", ROOT, "--outdir", `${output}/compiler`, "--output", pocket],
      "iOS application compile");
  }
  if (!existsSync(pocket)) throw new Error(`compiled iOS package is missing: ${pocket}; remove --no-build and retry`);
  await run([process.execPath, "tools/ios.ts", "play", "--pocket", pocket,
    ...args.filter(arg => !arg.startsWith("--framework="))], "iOS simulator play");
  process.exit(0);
}

const fullscreen = args.includes("--fullscreen");
const noBuild = args.includes("--no-build");
const noLaunch = args.includes("--no-launch");
const framework = args.find((arg) => arg.startsWith("--framework="));
const knownFlags = new Set(["--fullscreen", "--no-build", "--no-launch"]);
const unknown = args.find((arg) => !knownFlags.has(arg) && !arg.startsWith("--framework="));
if (unknown) usage(`unknown option ${unknown}`);

const demo = demoArg.replace(/-main$/, "");
if (!demos().includes(demo)) usage(`unknown demo ${demoArg}`);
const identity = demoIdentity(demo);
const titleId = vitaTitleId(identity.id);
const stagedApp = `${PLAY_DIR}/${titleId}`;
if (!vita3k || !existsSync(vita3k)) {
  throw new Error("Vita3K not found; set VITA3K/VITA3K_APP or install ~/Applications/Vita3K.app");
}
if (!existsSync(sourceConfig)) {
  throw new Error(`Vita3K config not found at ${sourceConfig}; run Vita3K once or set VITA3K_CONFIG`);
}

const requestedFramework =
  framework?.slice("--framework=".length) ||
  (demo.endsWith("vue-vapor") ? "vue-vapor" : demo.endsWith("octane") ? "octane" : "solid");

if (!noBuild) {
  const manifest = demoManifestFor(ROOT, demo, requestedFramework) as Record<string, any>;
  const manifestPath = `${ROOT}.pocket/play/${demo}.json`;
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const compilerOutput = `${PLAY_DIR}/compiler/${demo}`;
  const packagePath = `${compilerOutput}/app.pocket`;
  const nativeOutput = `${PLAY_DIR}/native/${demo}`;
  console.log(`PocketJS play: compiling ${demo} for PS Vita ...`);
  await run([
    process.execPath, "tools/pocket.ts", "compile", "--target", "vita",
    "--manifest", manifestPath, "--project-root", ROOT,
    "--outdir", compilerOutput, "--plan-dir", `${compilerOutput}/plans`,
    "--output", packagePath,
  ], "Vita application compile");
  console.log(`PocketJS play: building ${demo} for PS Vita ...`);
  await run([
    process.execPath, "tools/pocket.ts", "build", "--target", "vita",
    "--pocket", packagePath, "--outdir", nativeOutput,
  ], "Vita native build");
  const receipt = JSON.parse(readFileSync(`${nativeOutput}/build-receipt.json`, "utf8"));
  if (receipt.schema !== "pocket-runtime-build/1" || receipt.success !== true || typeof receipt.artifact !== "string") {
    throw new Error("Vita native build did not produce a successful artifact receipt");
  }
  copyFileSync(receipt.artifact, VPK);
}
if (!existsSync(VPK)) throw new Error(`VPK not found at ${VPK}; remove --no-build and retry`);
if (!noBuild) {
  writeFileSync(VPK_STAMP, JSON.stringify({ demo, framework: requestedFramework, titleId, sha256: vpkSha256() }));
} else {
  let cached: { demo?: string; framework?: string; titleId?: string; sha256?: string } = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(VPK_STAMP, "utf8"));
    if (parsed && typeof parsed === "object") cached = parsed;
  } catch {
    // The actionable error below covers a missing or invalid stamp.
  }
  if (
    cached.demo !== demo ||
    cached.framework !== requestedFramework ||
    cached.titleId !== titleId ||
    cached.sha256 !== vpkSha256()
  ) {
    throw new Error(`the cached VPK is not ${demo}; remove --no-build and retry`);
  }
}

let config = readFileSync(sourceConfig, "utf8");
const vitaFs = vitaFsFrom(sourceConfig, config);
const installedApp = `${vitaFs.replace(/\/$/, "")}/ux0/app/${titleId}`;
const nextInstalledApp = `${installedApp}.pocketjs-play-new`;

// Homebrew does not need firmware LLE modules. A complete cloned config keeps
// Vita3K's required keyboard keys while Manual/HLE avoids module-start crashes.
config = setScalar(config, "initial-setup", "false");
config = setScalar(config, "modules-mode", "2");
config = setScalar(config, "screen-filter", "Nearest");
config = setScalar(config, "show-welcome", "false");
config = setScalar(config, "warn-missing-firmware", "false");
config = setScalar(config, "check-for-updates-mode", "0");
config = setScalar(config, "pref-path", JSON.stringify(vitaFs));
config = setEmptyList(config, "lle-modules");
if (fullscreen) {
  config = setScalar(config, "boot-apps-full-screen", "true");
  config = setScalar(config, "stretch_the_display_area", "true");
}

rmSync(stagedApp, { recursive: true, force: true });
mkdirSync(stagedApp, { recursive: true });
const unzip = Bun.which("unzip");
if (!unzip) throw new Error("unzip not found");
await run([unzip, "-oq", VPK, "-d", stagedApp], "VPK extraction");
const missingVpkFiles = ["eboot.bin", "sce_sys/param.sfo", ...VITA_REQUIRED_SYSTEM_ASSETS]
  .filter((path) => !existsSync(`${stagedApp}/${path}`));
if (missingVpkFiles.length > 0) {
  throw new Error(`built VPK is missing ${missingVpkFiles.join(", ")}`);
}

mkdirSync(dirname(installedApp), { recursive: true });
rmSync(nextInstalledApp, { recursive: true, force: true });
cpSync(stagedApp, nextInstalledApp, { recursive: true });
mkdirSync(PLAY_DIR, { recursive: true });
writeFileSync(PLAY_CONFIG, config);

await stopVita3K();
rmSync(installedApp, { recursive: true, force: true });
renameSync(nextInstalledApp, installedApp);
console.log(`PocketJS play: installed ${demo} as ${titleId}`);

if (noLaunch) {
  console.log("PocketJS play: --no-launch requested; emulator not started");
  process.exit(0);
}

const launchArgs = [
  "--keep-config",
  "--load-config",
  "--config-location",
  PLAY_CONFIG,
  ...(fullscreen ? ["--fullscreen"] : []),
  "-r",
  titleId,
];

// Vita3K validates -r against its default VitaFS before loading a custom
// --config-location. Seed only the empty directory needed for that check.
const defaultConfigText = existsSync(defaultConfig) ? readFileSync(defaultConfig, "utf8") : "";
const globalTitleStub = `${vitaFsFrom(defaultConfig, defaultConfigText)}/ux0/app/${titleId}`;
let createdGlobalTitleStub = false;
if (!existsSync(globalTitleStub)) {
  mkdirSync(globalTitleStub, { recursive: true });
  createdGlobalTitleStub = true;
}
const cleanupGlobalTitleStub = (): void => {
  if (!createdGlobalTitleStub) return;
  try {
    rmdirSync(globalTitleStub);
  } catch {
    // Never recursively delete a directory another process may have populated.
  }
  createdGlobalTitleStub = false;
};
process.on("exit", cleanupGlobalTitleStub);

// Spawn the selected executable directly so VITA3K is honored and an immediate
// emulator crash is reported instead of being hidden by macOS LaunchServices.
const proc = Bun.spawn([vita3k, ...launchArgs], {
  cwd: ROOT,
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
const earlyExit = await Promise.race([
  proc.exited.then((code) => code),
  Bun.sleep(2_000).then(() => null),
]);
if (earlyExit !== null) {
  cleanupGlobalTitleStub();
  throw new Error(`Vita3K exited during launch with code ${earlyExit}`);
}
cleanupGlobalTitleStub();
proc.unref();

console.log(`PocketJS play: ${demo} is running in Vita3K (F11 toggles fullscreen)`);
