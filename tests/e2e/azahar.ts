// tests/e2e/azahar.ts — deterministic Nintendo 3DS E2E: build a capture .3dsx
// per golden spec, boot it in Azahar against a per-run emulator user directory,
// wait for the guest's completion marker, then byte-compare the decoded
// top- and bottom-screen readbacks against tests/goldens/3ds/.
//
//   bun run e2e:3ds               # compare against tests/goldens/3ds/
//   UPDATE_3DS=1 bun run e2e:3ds  # regenerate goldens (then eyeball the PNGs)
//
// Environment: AZAHAR (the .app bundle), AZAHAR_CONFIG (the settings to clone),
// E2E_AZAHAR_APP (one spec name instead of the default set), E2E_AZAHAR_3DSX
// (run a .3dsx that is already built), E2E_AZAHAR_TIMEOUT_MS,
// E2E_AZAHAR_GRAPHICS_API (0 software, 2 Vulkan).
//
// Determinism: the core steps a fixed dt (contracts/spec/spec.ts FIXED_DT) and
// the baked input tape is indexed by the same frame counter that names the
// dumped files, so a frame is a pure function of its index. The capture is a GX
// display transfer of the PICA200 render target — a real GPU readback, not a
// CPU oracle — and it is byte-identical run to run under one renderer.
//
// It is NOT byte-identical BETWEEN renderers, so the fixture pins one and a
// golden belongs to the pinned one. Measured on Azahar 2125.1.2 with the RGB8
// readback in place, Vulkan (graphics_api=2) against these Software
// (graphics_api=0) goldens: 5.1% of pixels differ, 99.5% of those by 1 or 2 of
// 255 — the two rasterizers round texture filtering and TEV blending
// differently — and 24 pixels along the logo's one diagonal edge differ by more,
// up to 157. Both renderers produce the same picture; only Software produces it
// the same way on every machine, which is why it is the pin.
// E2E_AZAHAR_GRAPHICS_API=2 re-measures that.
//
// Azahar has no headless mode, ignores SIGTERM, and does not exit when the
// guest returns from main(); the driver therefore owns both its lifetime
// (SIGKILL on every path) and its user directory. Emulator-bound and
// GUI-bound: keep it out of `bun run test` and CI.

import { $ } from "bun";
import { evidenceDirectory } from "./build.ts";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { demoManifestFor } from "../../tools/demo-identity.ts";
import { encodePNG } from "../png.ts";
import {
  encodeThresholdInput,
  encodeTouchInput,
  THREE_DS_GOLDEN_SPECS,
  type GoldenSpec,
} from "../golden-specs.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const OUT = evidenceDirectory(ROOT, "azahar");
// Azahar derives its whole user directory from $HOME on macOS, and has no
// command line switch for any part of it. A fixture $HOME is therefore the only
// way to give a run its own config and its own SD card.
const FIXTURE_HOME = `${OUT}/home`;
const USER_DIR = `${FIXTURE_HOME}/Library/Application Support/Azahar`;
const CONFIG = `${USER_DIR}/config/qt-config.ini`;
const CAPTURE_DIR = `${USER_DIR}/sdmc/pocketjs-captures`;
const CONSOLE_LOG = `${OUT}/azahar-console.log`;
const GOLDENS = `${ROOT}tests/goldens/3ds`;

// The 3DS top screen. The transferred buffer is still in the screen's rotated
// orientation, so it is 240 wide by 400 tall on the way out of the GPU.
const W = 400;
const H = 240;
const RAW_BYTES = W * H * 4;
const AUX_W = 320;
const AUX_H = 240;
const AUX_RAW_BYTES = AUX_W * AUX_H * 4;

const TIMEOUT_MS = Number(process.env.E2E_AZAHAR_TIMEOUT_MS ?? 180_000);
const LAUNCH_GRACE_MS = 20_000;
const update = process.env.UPDATE_3DS === "1";

const azaharApp = process.env.AZAHAR || "/Applications/Azahar.app";
const azaharBinary = `${azaharApp}/Contents/MacOS/azahar`;
const sourceConfig =
  process.env.AZAHAR_CONFIG || `${homedir()}/Library/Application Support/Azahar/config/qt-config.ini`;
const sourceUserDir = sourceConfig.replace(/\/config\/[^/]+$/, "");
// Set to run a .3dsx that is already built (the tools/3ds.ts build is skipped).
const prebuilt = process.env.E2E_AZAHAR_3DSX;
const romDir = process.env.E2E_AZAHAR_ROM_DIR ?? `${ROOT}dist/3ds`;
// Azahar's renderer: 0 software, 2 Vulkan. The default is the software
// rasterizer, which is the same on every machine.
const graphicsApi = process.env.E2E_AZAHAR_GRAPHICS_API ?? "0";

// The 3DS top screen is 400x240; the stock 480x272 demo corpus does not fit it
// on either axis and the resolver has no scaling fallback, so this driver runs
// only the specs whose app declares the 400x240 native viewport.
const DEFAULT_SPEC_NAMES = ["3ds-demo"];

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

if (process.platform !== "darwin") {
  console.error("the Azahar E2E driver is macOS-only (it launches the emulator through LaunchServices)");
  process.exit(2);
}
if (!existsSync(azaharBinary)) {
  console.error(`Azahar not found at ${azaharApp} (set AZAHAR to the .app bundle)`);
  process.exit(2);
}
if (!existsSync(sourceConfig)) {
  console.error(`Azahar config not found at ${sourceConfig} (launch Azahar once, or set AZAHAR_CONFIG)`);
  process.exit(2);
}
for (const tool of ["open", "pgrep", "pkill"]) {
  if (!Bun.which(tool)) {
    console.error(`${tool} not found (required to launch and to reap the emulator)`);
    process.exit(2);
  }
}

const requested = process.env.E2E_AZAHAR_APP;
const names = requested ? [requested] : DEFAULT_SPEC_NAMES;
const specs: GoldenSpec[] = [];
for (const name of names) {
  const spec = THREE_DS_GOLDEN_SPECS.find((candidate) => candidate.name === name || candidate.name === `${name}-main`);
  if (!spec) {
    console.error(
      `no THREE_DS_GOLDEN_SPECS entry named ${JSON.stringify(name)} in tests/golden-specs.ts — ` +
        "the input tape and capture frames are shared with the other hosts, never invented here",
    );
    process.exit(2);
  }
  specs.push(spec);
}

// ---------------------------------------------------------------------------
// Per-run fixture
// ---------------------------------------------------------------------------

/** Clone the developer's emulator settings, then pin the keys a golden depends
 *  on. Azahar ignores a value whose sibling `<key>\default=false` line is
 *  missing, so both lines are always written. */
function writeFixture(): void {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(`${USER_DIR}/config`, { recursive: true });
  mkdirSync(CAPTURE_DIR, { recursive: true });
  // The emulated system files, so a fixture $HOME boots the same way the
  // developer's install does. The SD card is deliberately not copied: a shared
  // sdmc lets a previous run's frames satisfy the capture check.
  for (const directory of ["nand", "sysdata"]) {
    if (existsSync(`${sourceUserDir}/${directory}`)) {
      cpSync(`${sourceUserDir}/${directory}`, `${USER_DIR}/${directory}`, { recursive: true });
    }
  }

  let config = readFileSync(sourceConfig, "utf8");
  const set = (key: string, value: string): void => {
    const assignment = new RegExp(`^${key}=.*$`, "gm");
    if ((config.match(assignment)?.length ?? 0) !== 1) {
      throw new Error(`qt-config.ini does not carry exactly one ${key} key`);
    }
    config = config.replace(new RegExp(`^${key}=.*$`, "m"), () => `${key}=${value}`);
    config = new RegExp(`^${key}\\\\default=.*$`, "m").test(config)
      ? config.replace(new RegExp(`^${key}\\\\default=.*$`, "m"), () => `${key}\\default=false`)
      : config.replace(new RegExp(`^${key}=.*$`, "m"), () => `${key}=${value}\n${key}\\default=false`);
  };
  // The renderers agree on the picture but not on every byte: a Vulkan capture
  // differs from these goldens on 5.1% of pixels, almost all by 1 or 2 of 255
  // (see the header). Goldens therefore belong to one backend, and it is the
  // software rasterizer — the one that does not depend on the developer's GPU
  // driver.
  set("graphics_api", graphicsApi);
  // The capture transfers a 240x400 render target; any internal upscale changes
  // what comes back.
  set("resolution_factor", "1");
  set("use_vsync", "false");
  set("frame_limit", "1000");
  set("use_disk_shader_cache", "false");
  set("check_for_update_on_start", "false");
  // A guest that shows the RTC must see the same time on every run: pin the
  // emulated clock to 2000-01-01 00:00:00
  // instead of the host's. It still advances with emulated time, so a
  // minute-resolution display stays stable for the first 60 s of a run.
  set("init_clock", "1");
  set("init_time", "946684800");
  writeFileSync(CONFIG, config);
}

// ---------------------------------------------------------------------------
// Emulator lifetime
// ---------------------------------------------------------------------------

function emulatorRunning(): boolean {
  return Bun.spawnSync(["pgrep", "-f", azaharBinary], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

/** Azahar outlives its guest, so a run interrupted with ^C leaves an instance
 *  holding the fixture and racing the next run's capture files. */
function killEmulator(): void {
  Bun.spawnSync(["pkill", "-9", "-f", azaharBinary], { stdout: "ignore", stderr: "ignore" });
}

async function runAzahar(rom: string): Promise<void> {
  const done = `${CAPTURE_DIR}/done`;
  const error = `${CAPTURE_DIR}/error.txt`;
  rmSync(CAPTURE_DIR, { recursive: true, force: true });
  mkdirSync(CAPTURE_DIR, { recursive: true });
  killEmulator();

  // LaunchServices, not a direct exec: Azahar only reaches the window server —
  // and only then advances the guest — when it is launched into the user's GUI
  // session. `--env` carries the fixture $HOME across the hand-off, which the
  // launched process does not otherwise inherit, and `-n` refuses to reuse an
  // instance that is already up.
  const launch = Bun.spawnSync(
    ["open", "-n", "-a", azaharApp, "--env", `HOME=${FIXTURE_HOME}`,
      "--stdout", CONSOLE_LOG, "--stderr", CONSOLE_LOG, "--args", rom],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (launch.exitCode !== 0) {
    throw new Error(`could not launch Azahar: ${launch.stderr.toString().trim()}`);
  }

  const started = Date.now();
  let seenRunning = false;
  try {
    while (Date.now() - started < TIMEOUT_MS) {
      // Four conditions, not one: the guest's failure path, the guest's
      // completion marker, the emulator dying, and the deadline.
      if (existsSync(error)) throw new Error(readFileSync(error, "utf8").trim());
      if (existsSync(done)) return;
      if (emulatorRunning()) seenRunning = true;
      else if (seenRunning) throw new Error("Azahar exited before the guest finished");
      else if (Date.now() - started > LAUNCH_GRACE_MS) throw new Error("Azahar never started");
      await Bun.sleep(100);
    }
    // Azahar's own log file is buffered and flushed on a clean exit only, so
    // the SIGKILL below leaves it empty and rotates the previous run's log
    // away. The console stream redirected at launch is the diagnostic instead.
    throw new Error(
      `timed out after ${TIMEOUT_MS} ms without the guest's done marker ` +
        `(see ${CONSOLE_LOG})`,
    );
  } finally {
    killEmulator();
  }
}

// ---------------------------------------------------------------------------
// Decode + structural guards
// ---------------------------------------------------------------------------

/** The display transfer keeps the screen's rotated orientation: the buffer is
 *  240 wide by 400 tall, column-major, and each RGBA8 word is stored A,B,G,R.
 *  Decoding it as a plain 400x240 image mismatches every pixel while looking
 *  almost right. */
function decodeScreen(raw: Uint8Array, width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const source = (x * height + (height - 1 - y)) * 4;
      const destination = (y * width + x) * 4;
      rgba[destination] = raw[source + 3];
      rgba[destination + 1] = raw[source + 2];
      rgba[destination + 2] = raw[source + 1];
      rgba[destination + 3] = 255; // the target's own alpha is never presented
    }
  }
  return rgba;
}

function isNonFlat(rgba: Uint8Array): boolean {
  const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength / 4);
  const seen = new Set<number>();
  for (const pixel of pixels) {
    seen.add(pixel);
    if (seen.size >= 3) return true;
  }
  return false;
}

/** Prove the frame is the top screen's own 400x240 and not a 200x120 render
 *  with every pixel doubled. */
function hasNativeDetail(rgba: Uint8Array, width: number, height: number): boolean {
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const topLeft = (y * width + x) * 4;
      for (const offset of [topLeft + 4, topLeft + width * 4, topLeft + width * 4 + 4]) {
        for (let channel = 0; channel < 4; channel++) {
          if (rgba[topLeft + channel] !== rgba[offset + channel]) return true;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

try {
  writeFixture();
} catch (error) {
  console.error(`could not build the run fixture: ${(error as Error).message}`);
  process.exit(2);
}
mkdirSync(GOLDENS, { recursive: true });
// Emulator provenance: byte-exact goldens are only promised for the Azahar
// build and the renderer they were recorded with.
const buildStamp = `${Bun.spawnSync([azaharBinary, "--version"]).stdout.toString().trim()}, graphics_api=${graphicsApi}`;
const stampPath = `${GOLDENS}/AZAHAR-BUILD.txt`;
const recordedStamp = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : null;
let passed = 0;
let failed = 0;

for (const spec of specs) {
  // A spec name mirrors its app directory (`3ds-demo-main` -> apps/3ds-demo);
  // the .3dsx is named by the manifest's app.output, which is not the same
  // string.
  const demo = (spec.app ?? spec.name).replace(/-main$/, "");
  const manifest = demoManifestFor(ROOT, demo) as { app: { output?: string } };
  const rom = prebuilt ?? `${romDir}/${manifest.app.output ?? `${demo}-main`}.3dsx`;
  // The window the guest dumps. It starts at 0 so a frame's file name is its
  // global frame index whether the host names dumps by the counter or by the
  // offset into the window.
  const capN = Math.max(...spec.capture) + 1;
  console.log(`\n## ${spec.name} (${spec.capture.length} golden frame(s) of a ${capN}-frame dump)`);

  if (!prebuilt) {
    if (!existsSync(`${ROOT}apps/${demo}`)) {
      console.error(`FAIL ${spec.name}: no apps/${demo} to build`);
      failed += spec.capture.length;
      continue;
    }
    // The tape and the capture window are baked into the binary: the guest
    // never reads them back off the emulator's filesystem at runtime.
    const build = await $`bun tools/3ds.ts ${demo} --capture`
      .cwd(ROOT)
      .env({
        ...process.env,
        POCKETJS_CAPTURE_INPUT: encodeThresholdInput(spec),
        // The generic host tape uses semicolons. The 3DS build flag uses @ so
        // the baked value remains one shell argument through Make.
        POCKETJS_CAPTURE_TOUCH: encodeTouchInput(spec).replaceAll(";", "@"),
        POCKETJS_CAP_START: "0",
        POCKETJS_CAP_N: String(capN),
      })
      .quiet()
      .nothrow();
    if (build.exitCode !== 0) {
      console.error(`FAIL ${spec.name}: 3DS build failed\n${build.stdout}${build.stderr}`);
      failed += spec.capture.length;
      continue;
    }
  }
  if (!existsSync(rom)) {
    console.error(`FAIL ${spec.name}: no capture .3dsx at ${rom}`);
    failed += spec.capture.length;
    continue;
  }

  try {
    await runAzahar(rom);
  } catch (error) {
    console.error(`FAIL ${spec.name}: ${(error as Error).message}`);
    failed += spec.capture.length;
    continue;
  }

  for (const frame of spec.capture) {
    for (const surface of [
      { suffix: "", name: "top", width: W, height: H, bytes: RAW_BYTES },
      { suffix: "aux-", name: "auxiliary", width: AUX_W, height: AUX_H, bytes: AUX_RAW_BYTES },
    ] as const) {
      const baseLabel = `${spec.name}.${frame}`;
      const label = surface.name === "top" ? baseLabel : `${baseLabel}.${surface.name}`;
      try {
        // Structural guards run before any comparison, and in UPDATE mode too:
        // a golden that is short, flat, or upscaled must never be recorded.
        const rawPath =
          `${CAPTURE_DIR}/${surface.suffix}f${String(frame).padStart(4, "0")}.raw`;
        if (!existsSync(rawPath)) throw new Error(`${label}: capture file missing`);
        const raw = readFileSync(rawPath);
        if (raw.byteLength !== surface.bytes) {
          throw new Error(
            `${label}: expected ${surface.bytes} bytes ` +
              `(${surface.width}x${surface.height} RGBA8), got ${raw.byteLength}`,
          );
        }
        const rgba = decodeScreen(raw, surface.width, surface.height);
        if (!isNonFlat(rgba)) throw new Error(`${label}: degenerate flat frame`);
        if (!hasNativeDetail(rgba, surface.width, surface.height)) {
          throw new Error(`${label}: frame contains only duplicated 2x2 pixels`);
        }

        const actual = encodePNG(rgba, surface.width, surface.height);
        const golden = `${GOLDENS}/${label}.png`;
        if (update) {
          writeFileSync(golden, actual);
          console.log(
            `WROTE ${label} ` +
              `(${surface.width}x${surface.height} ${surface.name} PICA200 readback)`,
          );
          passed++;
          continue;
        }
        if (!existsSync(golden)) {
          throw new Error(`${label}: golden missing (run with UPDATE_3DS=1 after visual review)`);
        }
        if (!actual.equals(readFileSync(golden))) {
          writeFileSync(`${OUT}/${label}.actual.png`, actual);
          const drift =
            recordedStamp && recordedStamp !== buildStamp
              ? ` — note: goldens came from ${recordedStamp}, this run is ${buildStamp}`
              : "";
          throw new Error(
            `${label}: PNG bytes differ (see ${OUT}/${label}.actual.png)${drift}`,
          );
        }
        console.log(
          `PASS ${label} ` +
            `(${surface.width}x${surface.height} ${surface.name} screen, byte-exact)`,
        );
        passed++;
      } catch (error) {
        console.error(`FAIL ${(error as Error).message}`);
        failed++;
      }
    }
  }
}

if (update && passed > 0) writeFileSync(stampPath, `${buildStamp}\n`);
console.log(`\nAzahar E2E: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
