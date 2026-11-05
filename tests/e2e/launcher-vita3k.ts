// Vita launcher E2E: build the real multi-app VPK, install it into an
// isolated Vita3K VitaFS, then drive repeated whole-guest swaps with the
// capture guest's baked input tape.
//
// Journey (registry starts Café, Chrome, ...):
//   launcher -> Café -> SELECT -> launcher -> Chrome -> SELECT -> launcher
//   -> SELECT resume Chrome -> SELECT -> launcher -> LEFT -> Café
//
// Each sparse 960x544 capture has a JSON sidecar written by the native host.
// The sidecar proves which embedded .pocket guest produced the pixels; the
// pixel checks prove every stage is non-flat, native-density, and distinct.
// Chrome and Café are each relaunched at the same guest-local age and must
// render byte-identically, which exercises teardown plus GPU resource reuse.
//
// Run: bun tests/e2e/launcher-vita3k.ts
// Host deps: VitaSDK, Vita3K, and unzip (same as tests/e2e/vita3k.ts).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { buildCaptureLauncher, evidenceDirectory } from "./build.ts";
import {
  DEFAULT_VITA_PACKAGE_ASSETS,
  VITA_REQUIRED_SYSTEM_ASSETS,
} from "../../tools/vita-package.ts";
import { vitaTitleId } from "../../framework/src/manifest/vita-package.ts";
import { encodePNG } from "../png.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const OUT = evidenceDirectory(ROOT, "launcher-vita3k");
const VITAFS = `${OUT}/vitafs`;
const CONFIG = `${OUT}/config/config.yml`;
const CAPTURE_DIR = `${VITAFS}/ux0/data/pocketjs-captures`;
const REGISTRY = `${OUT}/launcher-registry.json`;
const LAUNCHER_MANIFEST = `${ROOT}apps/launcher/pocket.app.json`;
const W = 960;
const H = 544;
const RAW_BYTES = W * H * 4;
const TIMEOUT_MS = Number(process.env.E2E_LAUNCHER_VITA3K_TIMEOUT_MS ?? 90_000);

const CIRCLE = 0x2000;
const SELECT = 0x0001;
const LEFT = 0x0080;

const LAUNCH_CAFE = 90;
const SUMMON_FROM_CAFE = 180;
const BROWSE_CHROME = 240;
const LAUNCH_CHROME = 270;
const SUMMON_FROM_CHROME = 360;
const RESUME_CHROME = 420;
const SUMMON_FROM_RESUMED_CHROME = 510;
const BROWSE_CAFE = 570;
const RELAUNCH_CAFE = 600;

function press(frame: number, mask: number): readonly string[] {
  return [`${frame}:0x${mask.toString(16).padStart(4, "0")}`, `${frame + 1}:0`];
}

const INPUT = [
  "0:0",
  ...press(LAUNCH_CAFE, CIRCLE),
  ...press(SUMMON_FROM_CAFE, SELECT),
  ...press(BROWSE_CHROME, 0x0020),
  ...press(LAUNCH_CHROME, CIRCLE),
  ...press(SUMMON_FROM_CHROME, SELECT),
  ...press(RESUME_CHROME, SELECT),
  ...press(SUMMON_FROM_RESUMED_CHROME, SELECT),
  ...press(BROWSE_CAFE, LEFT),
  ...press(RELAUNCH_CAFE, CIRCLE),
].join(",");

interface Phase {
  readonly label: string;
  readonly frame: number;
  readonly output: "launcher-main" | "cafe-main" | "chrome-main";
}

const PHASES: readonly Phase[] = [
  { label: "launcher-cold", frame: 80, output: "launcher-main" },
  { label: "cafe-first", frame: 170, output: "cafe-main" },
  { label: "launcher-after-cafe", frame: 230, output: "launcher-main" },
  { label: "chrome-first", frame: 350, output: "chrome-main" },
  { label: "launcher-after-chrome", frame: 410, output: "launcher-main" },
  { label: "chrome-resumed", frame: 500, output: "chrome-main" },
  { label: "launcher-after-resume", frame: 560, output: "launcher-main" },
  { label: "launcher-browsed-cafe", frame: 590, output: "launcher-main" },
  { label: "cafe-recycled", frame: 680, output: "cafe-main" },
] as const;

const CAPTURE_FRAMES = PHASES.map((phase) => phase.frame).join(",");

const vita3k =
  process.env.VITA3K ||
  (process.platform === "darwin"
    ? `${homedir()}/Applications/Vita3K.app/Contents/MacOS/Vita3K`
    : Bun.which("Vita3K"));
const sourceConfig =
  process.env.VITA3K_CONFIG ||
  (process.platform === "darwin"
    ? `${homedir()}/Library/Application Support/Vita3K/Vita3K/config.yml`
    : `${homedir()}/.config/Vita3K/config.yml`);
const unzip = Bun.which("unzip");

if (!vita3k || !existsSync(vita3k)) {
  console.error(
    "Vita3K not found (set VITA3K, or install ~/Applications/Vita3K.app)",
  );
  process.exit(2);
}
if (!existsSync(sourceConfig)) {
  console.error(
    `Vita3K config not found at ${sourceConfig} (set VITA3K_CONFIG)`,
  );
  process.exit(2);
}
if (!unzip) {
  console.error(
    "unzip not found (required to install and inspect the launcher VPK)",
  );
  process.exit(2);
}
if (
  !existsSync(`${homedir()}/vitasdk/bin/arm-vita-eabi-gcc`) &&
  !process.env.VITASDK
) {
  console.error("VitaSDK not found (set VITASDK, or install it at ~/vitasdk)");
  process.exit(2);
}

const sourceConfigText = readFileSync(sourceConfig, "utf8");
const configuredVitaFs = sourceConfigText
  .match(/^pref-path:\s*(.+?)\s*$/m)?.[1]
  ?.replace(/^['"]|['"]$/g, "");
const globalVitaFs = configuredVitaFs || `${dirname(sourceConfig)}/fs`;
const launcherManifest = JSON.parse(
  readFileSync(LAUNCHER_MANIFEST, "utf8"),
) as {
  id: string;
  app: { output: string };
};
const titleId = vitaTitleId(launcherManifest.id);
const globalTitleStub = `${globalVitaFs}/ux0/app/${titleId}`;
let createdGlobalTitleStub = false;

function writeFixture(): void {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(CAPTURE_DIR, { recursive: true });
  mkdirSync(`${VITAFS}/ux0/user/00`, { recursive: true });
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(
    `${VITAFS}/ux0/user/00/user.xml`,
    '<?xml version="1.0" encoding="utf-8"?>\n<user id="00" name="Vita3K"><theme use-background="true"><content-id>default</content-id></theme><start-screen type="default"><path></path></start-screen><backgrounds /></user>\n',
  );
  writeFileSync(
    `${VITAFS}/ux0/user/time.xml`,
    '<?xml version="1.0" encoding="utf-8"?>\n<time><user id="00" /></time>\n',
  );

  // Vita3K's keyboard decoder requires the complete installed config. Clone
  // it, then alter only deterministic/isolated keys; never mutate the user's.
  let config = sourceConfigText;
  const set = (key: string, value: string): void => {
    const line = new RegExp(`^${key}:.*$`, "m");
    config = line.test(config)
      ? config.replace(line, `${key}: ${value}`)
      : `${config.trimEnd()}\n${key}: ${value}\n`;
  };
  set("initial-setup", "false");
  set("backend-renderer", "Vulkan");
  set("resolution-multiplier", "1");
  set("screen-filter", "Nearest");
  set("v-sync", "false");
  set("memory-mapping", "double-buffer");
  set("disable-surface-sync", "false");
  set("modules-mode", "2");
  set("pref-path", VITAFS);
  set("show-live-area-screen", "false");
  set("boot-apps-full-screen", "false");
  set("show-welcome", "false");
  set("warn-missing-firmware", "false");
  set("check-for-updates-mode", "0");
  set("discord-rich-presence", "false");
  set("log-level", "0");
  writeFileSync(CONFIG, config);
}

process.on("exit", () => {
  if (!createdGlobalTitleStub) return;
  try {
    // The harness creates an empty compatibility stub only. Refuse recursive
    // deletion if another process unexpectedly populated it.
    rmdirSync(globalTitleStub);
  } catch {
    // Preserve any unexpected contents.
  }
});

async function terminate(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await Promise.race([proc.exited, Bun.sleep(2_000)]);
  if (proc.exitCode === null) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

async function runVita3K(): Promise<void> {
  const done = `${CAPTURE_DIR}/done`;
  const error = `${CAPTURE_DIR}/error.txt`;
  const proc = Bun.spawn(
    [
      vita3k!,
      "--keep-config",
      "--load-config",
      "--config-location",
      CONFIG,
      "-r",
      titleId,
    ],
    { cwd: ROOT, stdout: Bun.file(`${OUT}/vita3k.stdout.log`), stderr: Bun.file(`${OUT}/vita3k.stderr.log`) },
  );
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (existsSync(error)) throw new Error(readFileSync(error, "utf8"));
      if (existsSync(done)) return;
      if (proc.exitCode !== null) {
        throw new Error(
          `Vita3K exited before guest completion (code ${proc.exitCode})`,
        );
      }
      await Bun.sleep(20);
    }
    throw new Error(`Vita3K timed out after ${TIMEOUT_MS} ms`);
  } finally {
    // The capture guest parks after publishing done; the host terminates it
    // to avoid Vita3K 0.2.1/macOS's GXM teardown fault.
    await terminate(proc);
  }
}

function isNonFlat(rgba: Uint8Array): boolean {
  const pixels = new Uint32Array(
    rgba.buffer,
    rgba.byteOffset,
    rgba.byteLength / 4,
  );
  const seen = new Set<number>();
  for (const pixel of pixels) {
    seen.add(pixel);
    if (seen.size >= 3) return true;
  }
  return false;
}

/** Prove capture did not regress to a 480x272 buffer duplicated into 2x2 blocks. */
function hasNativeDetail(rgba: Uint8Array): boolean {
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const topLeft = (y * W + x) * 4;
      for (const offset of [
        topLeft + 4,
        topLeft + W * 4,
        topLeft + W * 4 + 4,
      ]) {
        for (let channel = 0; channel < 4; channel++) {
          if (rgba[topLeft + channel] !== rgba[offset + channel]) return true;
        }
      }
    }
  }
  return false;
}

function assertPackagedDefaultLiveArea(): void {
  for (const path of VITA_REQUIRED_SYSTEM_ASSETS) {
    const unpacked = Bun.spawnSync({
      cmd: [unzip!, "-p", VPK, path],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!unpacked.success) {
      throw new Error(
        `launcher VPK is missing ${path}: ${unpacked.stderr.toString().trim()}`,
      );
    }
    if (
      !Buffer.from(unpacked.stdout).equals(
        readFileSync(`${DEFAULT_VITA_PACKAGE_ASSETS}/${path}`),
      )
    ) {
      throw new Error(
        `launcher VPK ${path} does not match PocketJS's default Vita asset`,
      );
    }
  }
}

interface RegistryEntry {
  readonly output: string;
  readonly id: string;
}

interface CaptureSidecar {
  readonly appIndex: number;
  readonly appOutput: string;
  readonly appId: string;
}

function readSidecar(frame: number): CaptureSidecar {
  const path = `${CAPTURE_DIR}/f${String(frame).padStart(4, "0")}.json`;
  if (!existsSync(path)) throw new Error(`capture sidecar missing: ${path}`);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isInteger((value as Partial<CaptureSidecar>).appIndex) ||
    typeof (value as Partial<CaptureSidecar>).appOutput !== "string" ||
    typeof (value as Partial<CaptureSidecar>).appId !== "string"
  ) {
    throw new Error(`malformed capture sidecar: ${path}`);
  }
  return value as CaptureSidecar;
}

function assertEqualFrame(a: Buffer, b: Buffer, label: string): void {
  if (!a.equals(b))
    throw new Error(`${label}: fresh relaunch was not byte-deterministic`);
}

function assertDifferentFrame(a: Buffer, b: Buffer, label: string): void {
  if (a.equals(b))
    throw new Error(`${label}: capture stages are byte-identical`);
}

writeFixture();

console.log("# build multi-app Vita capture VPK ...");
const VPK = await buildCaptureLauncher({
  root: ROOT, directory: OUT, target: "vita",
  env: {
    ...process.env,
    VITASDK: process.env.VITASDK ?? `${homedir()}/vitasdk`,
    POCKETJS_CAPTURE_INPUT: INPUT,
    POCKETJS_CAPTURE_FRAMES: CAPTURE_FRAMES,
  },
});
if (!existsSync(REGISTRY)) {
  console.error(
    `FAIL: Vita launcher registry missing after successful build: ${REGISTRY}`,
  );
  process.exit(1);
}

try {
  assertPackagedDefaultLiveArea();
} catch (error) {
  console.error(`FAIL: ${(error as Error).message}`);
  process.exit(1);
}

const targetRegistry = JSON.parse(readFileSync(REGISTRY, "utf8")) as {
  apps: RegistryEntry[];
};
const appTable: RegistryEntry[] = [
  // Native app0's generated tuple is a sentinel, but the runtime resolves
  // the canonical identity carried inside its embedded .pocket package.
  { output: launcherManifest.app.output, id: launcherManifest.id },
  ...targetRegistry.apps,
];
for (const required of ["launcher-main", "cafe-main", "chrome-main"]) {
  if (!appTable.some((app) => app.output === required)) {
    console.error(`FAIL: Vita launcher registry does not contain ${required}`);
    process.exit(1);
  }
}

console.log(`# install ${titleId} into isolated VitaFS ...`);
const appDir = `${VITAFS}/ux0/app/${titleId}`;
rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
const install = Bun.spawnSync({
  cmd: [unzip, "-oq", VPK, "-d", appDir],
  stdout: "pipe",
  stderr: "pipe",
});
if (!install.success) {
  console.error(
    `FAIL: could not extract launcher VPK: ${install.stderr.toString().trim()}`,
  );
  process.exit(1);
}
if (
  !existsSync(`${appDir}/eboot.bin`) ||
  !existsSync(`${appDir}/sce_sys/param.sfo`)
) {
  console.error(
    "FAIL: extracted launcher VPK is missing eboot.bin or sce_sys/param.sfo",
  );
  process.exit(1);
}

// Vita3K validates -r in its default VitaFS before applying --load-config.
if (!existsSync(globalTitleStub)) {
  mkdirSync(globalTitleStub, { recursive: true });
  createdGlobalTitleStub = true;
}

console.log("# Vita3K scripted launcher journey ...");
try {
  await runVita3K();
} catch (error) {
  console.error(`FAIL: ${(error as Error).message}`);
  process.exit(1);
}

const frames = new Map<string, Buffer>();
try {
  for (const phase of PHASES) {
    const stem = `f${String(phase.frame).padStart(4, "0")}`;
    const rawPath = `${CAPTURE_DIR}/${stem}.rgba`;
    if (!existsSync(rawPath))
      throw new Error(`${phase.label}: capture file missing`);
    const raw = readFileSync(rawPath);
    if (raw.byteLength !== RAW_BYTES) {
      throw new Error(
        `${phase.label}: expected ${RAW_BYTES} bytes (960x544 RGBA), got ${raw.byteLength}`,
      );
    }
    if (!isNonFlat(raw))
      throw new Error(`${phase.label}: degenerate flat frame`);
    if (!hasNativeDetail(raw)) {
      throw new Error(
        `${phase.label}: framebuffer contains only duplicated 2x2 logical pixels`,
      );
    }

    const sidecar = readSidecar(phase.frame);
    const expectedIndex = appTable.findIndex(
      (app) => app.output === phase.output,
    );
    const expected = appTable[expectedIndex]!;
    if (
      sidecar.appIndex !== expectedIndex ||
      sidecar.appOutput !== expected.output ||
      sidecar.appId !== expected.id
    ) {
      throw new Error(
        `${phase.label}: sidecar identifies ${sidecar.appIndex}:${sidecar.appOutput}:${sidecar.appId}, ` +
          `expected ${expectedIndex}:${expected.output}:${expected.id}`,
      );
    }

    frames.set(phase.label, raw);
    writeFileSync(`${OUT}/${phase.label}.png`, encodePNG(raw, W, H));
    console.log(
      `PASS ${phase.label}: ${sidecar.appIndex}:${sidecar.appOutput}, 960x544 native detail`,
    );
  }

  for (let index = 1; index < PHASES.length; index++) {
    const previous = PHASES[index - 1]!;
    const current = PHASES[index]!;
    assertDifferentFrame(
      frames.get(previous.label)!,
      frames.get(current.label)!,
      `${previous.label} vs ${current.label}`,
    );
  }

  // Both apps are captured exactly 80 incoming-guest frames after launch.
  // Equality makes lifecycle reset/resource reuse a deterministic contract,
  // not merely "the emulator did not crash after several swaps".
  assertEqualFrame(
    frames.get("chrome-first")!,
    frames.get("chrome-resumed")!,
    "Chrome relaunch",
  );
  assertEqualFrame(
    frames.get("cafe-first")!,
    frames.get("cafe-recycled")!,
    "Café relaunch",
  );
} catch (error) {
  console.error(`FAIL: ${(error as Error).message}`);
  process.exit(1);
}

console.log(
  `PASS: Vita launcher VPK LiveArea + ${PHASES.length} sidecar-identified native frames; ` +
    "7 guest swaps and two deterministic resource-reuse relaunches verified",
);
