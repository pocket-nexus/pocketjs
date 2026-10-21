// Repack the minimal 3DS file program, launch it in Azahar and inspect native
// screenshots of both displays. No product development service is required.
// --runtime DIR selects a generic build receipt or its runtime artifact directory.
// --external-input waits for a test operator to press the logged key and F13;
// otherwise the macOS test runner sends those keys through System Events.
// --keys a,h,g chooses the application's keyboard sequence.
// --touches '160,140;160,180' chooses auxiliary touch points (external input).
// --window-rect x,y,w,h accepts external window PNGs when native capture fails.
// Keep the pointer outside that rectangle while capturing each window PNG.
// --device retains the paired product's wire replay validation.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pocketRuntimeDeviceId } from "../../contracts/spec/pocket-runtime-wire.ts";
import { PocketRuntimeClient, parsePocketRuntimeToken } from "../../tools/3ds-runtime-client.ts";
import { readRuntimeDirectory } from "../../tools/repack.ts";
import { repack3ds } from "../../tools/repack/3ds.ts";
import { decodePng, encodePng } from "../../tools/repack/shared/png.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const argv = Bun.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const device = argv.includes("--device");
const id = option("id");
if (!id && !argv.includes("--preflight")) throw new Error("--id is required");
const run = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = resolve(option("out") ?? join(ROOT, ".pocket-build/validation/e2e", `${device ? "device" : "azahar"}-${run}`));
mkdirSync(OUT, { recursive: true });
const transcript: string[] = [];
const log = (line: string) => {
  console.log(line);
  transcript.push(line);
};

const BTN = { UP: 0x10, RIGHT: 0x20, DOWN: 0x40, LEFT: 0x80, CIRCLE: 0x2000 } as const;
const STEPS: ReadonlyArray<readonly [string, number]> = [
  ["circle", BTN.CIRCLE],
  ["right", BTN.RIGHT],
  ["down", BTN.DOWN],
  ["left", BTN.LEFT],
  ["up", BTN.UP],
  ["right", BTN.RIGHT],
];

const azaharApp = process.env.AZAHAR || "/Applications/Azahar.app";
const azaharBinary = join(azaharApp, "Contents/MacOS/azahar");
const FIXTURE_HOME = join(OUT, "home");
const USER_DIR = join(FIXTURE_HOME, "Library/Application Support/Azahar");
const SDMC = join(USER_DIR, "sdmc");

const shots = join(OUT, "screenshots");
const sourceConfig = process.env.AZAHAR_CONFIG ?? join(homedir(), "Library/Application Support/Azahar/config/qt-config.ini");
const externalInput = argv.includes("--external-input");
// Some Azahar/macOS versions return a blank native screenshot. An external
// window capture can supply the same test with an explicit display rectangle;
// retain the unmodified window PNG as evidence alongside the normalized frame.
const windowRect = option("window-rect")?.split(",").map(Number);
if (windowRect && (!externalInput || windowRect.length !== 4 || windowRect.some(value => !Number.isInteger(value) || value < 0) || !windowRect[2] || !windowRect[3]))
  throw new Error("--window-rect x,y,width,height needs --external-input and a valid rectangle");
const keys = (option("keys") ?? "a,h,g,f,t").split(",");
if (keys.some(key => !/^[a-z0-9]$/.test(key))) throw new Error("--keys accepts comma-separated letter/digit keys");
const touches = option("touches")?.split(";").map(pair => pair.split(",").map(Number));
if (touches && (!externalInput || touches.some(pair => pair.length !== 2 || pair.some(value => !Number.isInteger(value) || value < 0) || pair[0]! >= 320 || pair[1]! >= 240)))
  throw new Error("--touches x,y;x,y requires --external-input and auxiliary surface coordinates");
const inputSteps = touches?.map(([x, y]) => `touch(${x},${y})`) ?? keys;
function preflight(): void {
  if (process.platform !== "darwin") throw new Error("Azahar E2E requires macOS LaunchServices");
  if (!existsSync(azaharBinary)) throw new Error(`Azahar not found: ${azaharBinary}`);
  if (!existsSync(sourceConfig)) throw new Error(`isolated Azahar defaults required: set AZAHAR_CONFIG (${sourceConfig})`);
  for (const tool of ["open", "pgrep", ...(externalInput ? [] : ["osascript"])])
    if (!Bun.which(tool)) throw new Error(`${tool} is required`);
}
function writeFixture(): void {
  rmSync(FIXTURE_HOME, { recursive: true, force: true });
  mkdirSync(join(USER_DIR, "config"), { recursive: true });
  mkdirSync(SDMC, { recursive: true }); mkdirSync(shots, { recursive: true });
  const sourceUser = sourceConfig.replace(/\/config\/[^/]+$/, "");
  for (const directory of ["nand", "sysdata"])
    if (existsSync(join(sourceUser, directory))) cpSync(join(sourceUser, directory), join(USER_DIR, directory), { recursive: true });
  let config = readFileSync(sourceConfig, "utf8");
  const set = (key: string, value: string): void => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(`^${escaped}=.*$`, "m");
    if (!expression.test(config)) throw new Error(`Azahar config has no ${key}`);
    config = config.replace(expression, () => `${key}=${value}`);
    const fallback = new RegExp(`^${escaped}\\\\default=.*$`, "m");
    config = fallback.test(config) ? config.replace(fallback, () => `${key}\\default=false`)
      : config.replace(expression, () => `${key}=${value}\n${key}\\default=false`);
  };
  // Azahar 2125 software output does not fulfill native screenshot requests.
  // This Vulkan scene/liveness run is separate from the software golden test.
  for (const [key, value] of Object.entries({ graphics_api: "2", resolution_factor: "1", use_vsync: "false",
    check_for_update_on_start: "false", frame_limit: "100", layout_option: "0", swap_screen: "false",
    upright_screen: "false", screenshot_resolution_factor: "1",
    "Paths\\screenshotPath": shots, "Shortcuts\\Main%20Window\\Capture%20Screenshot\\KeySeq": "F13" })) set(key, value);
  writeFileSync(join(USER_DIR, "config/qt-config.ini"), config);
}
let romPath: string | null = null;
function emulatorPids(): number[] {
  if (!romPath) return [];
  const result = Bun.spawnSync(["pgrep", "-f", romPath], { stdout: "pipe", stderr: "ignore" });
  return result.stdout.toString().trim().split(/\s+/).filter(Boolean).map(Number);
}
function killEmulator(): void {
  for (const pid of emulatorPids()) { try { process.kill(pid, "SIGKILL"); } catch {} }
  romPath = null;
}
function launch(rom: string): void {
  romPath = rom;
  const result = Bun.spawnSync(["open", "-n", "-a", azaharApp, "--env", `HOME=${FIXTURE_HOME}`,
    "--stdout", join(OUT, "azahar.log"), "--stderr", join(OUT, "azahar.log"), "--args", rom]);
  if (!result.success) throw new Error(`Azahar launch failed: ${result.stderr.toString()}`);
}
async function nativeScreenshot(name: string, key?: string): Promise<string> {
  const before = new Set(readdirSync(shots));
  log(`capture ${name}: ${key ? `press ${key}, then ` : ""}${windowRect ? `move the pointer outside the displays and save a fresh window PNG into ${shots}` : "F13 in Azahar"}`);
  if (!externalInput) {
    const pid = emulatorPids()[0]; if (!pid) throw new Error("Azahar exited before screenshot");
    const commands = [`tell application "System Events"`, `set p to first application process whose unix id is ${pid}`,
      `set frontmost of p to true`, `tell p`, ...(key ? [`keystroke "${key}"`, "delay 1"] : []), "key code 105", "end tell", "end tell"];
    const result = Bun.spawnSync(["osascript", "-e", commands.join("\n")]);
    if (!result.success) throw new Error(`keyboard automation failed: ${result.stderr.toString()}`);
  }
  const deadline = Date.now() + (externalInput ? 180_000 : 60_000);
  while (Date.now() < deadline) {
    if (!emulatorPids().length) throw new Error("Azahar exited while waiting for a rendered frame");
    const file = readdirSync(shots).find(path => path.endsWith(".png") && !before.has(path));
    if (file) {
      let png = new Uint8Array(readFileSync(join(shots, file)));
      let decoded = await decodePng(png);
      if (windowRect) {
        const [x0, y0, width, height] = windowRect as [number, number, number, number];
        if (x0 + width > decoded.width || y0 + height > decoded.height) throw new Error("display rectangle exceeds captured window");
        writeFileSync(join(OUT, `${name}.window.png`), png);
        const rgba = new Uint8Array(400 * 480 * 4);
        for (let y=0;y<480;y++) for (let x=0;x<400;x++) {
          const at=((y0+Math.floor(y*height/480))*decoded.width+x0+Math.floor(x*width/400))*4;
          rgba.set(decoded.rgba.subarray(at,at+4),(y*400+x)*4);
        }
        decoded={width:400,height:480,rgba}; png = new Uint8Array(await encodePng(decoded));
      }
      if (decoded.width !== 400 || decoded.height !== 480) throw new Error(`native screenshot is ${decoded.width}x${decoded.height}, expected 400x480`);
      for (const [label, x0, y0, width] of [["top", 0, 0, 400], ["bottom", 40, 240, 320]] as const) {
        const colors = new Set<number>();
        for (let y = y0; y < y0 + 240; y++) for (let x = x0; x < x0 + width; x++) {
          const at = (y * 400 + x) * 4;
          colors.add((decoded.rgba[at]! << 16) | (decoded.rgba[at + 1]! << 8) | decoded.rgba[at + 2]!);
        }
        if (colors.size < 8) throw new Error(`${label} screen has no rendered scene (${colors.size} colors)`);
      }
      writeFileSync(join(OUT, `${name}.png`), png);
      const digest = createHash("sha256").update(decoded.rgba).digest("hex");
      log(`native screenshot ${name}: 400x480 sha256 ${digest}`); return digest;
    }
    await Bun.sleep(100);
  }
  throw new Error(`no native screenshot for ${name}`);
}

async function connect(host: string, token: Uint8Array, timeoutMs: number): Promise<PocketRuntimeClient> {
  const started = Date.now();
  let last = "not listening";
  while (Date.now() - started < timeoutMs) {
    const client = new PocketRuntimeClient({ host, token, timeoutMs: 10_000 });
    try {
      await client.connect();
      return client;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      client.close();
      await Bun.sleep(250);
    }
  }
  throw new Error(`no Pocket Runtime at ${host}: ${last}`);
}

async function screenshot(client: PocketRuntimeClient, name: string): Promise<string> {
  const pending = client.waitForScreenshot(30_000);
  await client.sendCtrl({ t: "screenshot" });
  const shot = await pending;
  writeFileSync(join(OUT, `${name}.png`), shot.png);
  const digest = createHash("sha256").update(shot.png).digest("hex").slice(0, 16);
  log(`screenshot ${name}.png frame ${shot.frame} ${shot.metadata.topWidth}x${shot.metadata.topHeight} + ${shot.metadata.auxiliaryWidth}x${shot.metadata.auxiliaryHeight} sha256 ${digest}`);
  return digest;
}

async function play(client: PocketRuntimeClient): Promise<void> {
  const statusPromise = client.waitForCtrl((message) => message.t === "runtime.status");
  await client.requestStatus();
  const status = await statusPromise;
  const slot = createHash("sha256").update(id!).digest("hex").slice(0, 16);
  log(`status ${JSON.stringify(status)}`);
  if (status.target !== "3ds-dev" || status.slot !== slot) {
    throw new Error(`runtime.status is not this game's: expected slot ${slot}`);
  }
  let previous = await screenshot(client, "00-start");
  let index = 1;
  for (const [name, mask] of STEPS) {
    // Two idle frames, the button held for four, then 40 frames for the slide.
    await client.sendCtrl({ t: "replay", tape: { v: 1, app: id, frames: 46, masks: [[0, 2], [mask, 4], [0, 40]] } });
    await Bun.sleep(1500);
    const digest = await screenshot(client, `${String(index).padStart(2, "0")}-${name}`);
    if (digest === previous) throw new Error(`pressing ${name} changed nothing on screen`);
    previous = digest;
    index += 1;
  }
}

let client: PocketRuntimeClient | null = null;
try {
  if (device) {
    const host = option("host");
    if (!host) throw new Error("--device needs --host");
    const token = parsePocketRuntimeToken(readFileSync(join(ROOT, ".pocket/3ds/devices", `${host}-8131.key`), "utf8"));
    client = await connect(host, token, 30_000);
    log(`connected to ${host} (device ${pocketRuntimeDeviceId(token).toString(16)})`);
    await play(client);
  } else {
    preflight();
    if (argv.includes("--preflight")) { log("preflight passed; emulator not started"); }
    else {
      const pocketPath = option("pocket");
      const identity = { id: id!, title: option("title") ?? "", author: option("author") ?? "", version: option("version") ?? "" };
      if (!pocketPath || !identity.title || !identity.author || !identity.version)
        throw new Error("Azahar runs need --pocket, --id, --title, --author and --version");
      const icon = option("icon");
      let runtimeDir = resolve(option("runtime") ?? join(ROOT, "dist/runtime/3ds"));
      const receiptPath = join(runtimeDir, "build-receipt.json");
      if (existsSync(receiptPath)) {
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
        if (receipt.success !== true) throw new Error("runtime build receipt is not successful");
        runtimeDir = receipt.artifact;
      }
      const runtime = readRuntimeDirectory(runtimeDir);
      const game = await repack3ds({ runtime, pocket: new Uint8Array(readFileSync(pocketPath)),
        identity: { ...identity, ...(icon ? { icon: new Uint8Array(readFileSync(icon)) } : {}) } });
      const gamePath = join(OUT, "game.3dsx"); writeFileSync(gamePath, game);
      log(`repacked ${game.length} bytes from ${runtimeDir}`);
      writeFixture(); launch(gamePath); await Bun.sleep(10_000);
      let previous = await nativeScreenshot("00-start");
      for (const [index, key] of inputSteps.entries()) {
        const digest = await nativeScreenshot(`${index + 1}-${key}`, key);
        if (digest === previous) throw new Error(`pressing ${key} changed no pixels`);
        previous = digest;
      }
      if (!emulatorPids().length) throw new Error("Azahar exited after the last frame");
      log("minimal program rendered both screens and responded to input without a product wire service");
    }
  }
  log("PASS");
} catch (error) {
  log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  client?.close();
  if (!device) killEmulator();
  writeFileSync(join(OUT, "transcript.txt"), `${transcript.join("\n")}\n`);
}
