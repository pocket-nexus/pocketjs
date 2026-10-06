// A game repacked onto the generic 3DS runtime, started and played.
//
//   bun tests/e2e/3ds-repack.ts --pocket <game.pocket> --id <id> --title <title>
//     --author <author> --version <version> [--icon <png>] [--out <dir>]
//   bun tests/e2e/3ds-repack.ts --device --host <3ds-ip> --id <id> [--out <dir>]
//
// Azahar (the default): repacks the game onto dist/runtime/3ds (built by
// `bun tools/runtime.ts 3ds`), starts the bare runtime once to read the line
// it leaves when it carries no game, then starts the repacked .3dsx on a
// fixture SD card and plays it over the Pocket Runtime wire.
//
// --device: the repacked .3dsx is already running on a paired console
// (`bun tools/3ds-dev.ts install --file <game.3dsx> --name <name>.3dsx`
// under the 3ds:wire device lease); only the play part runs.
//
// Play: status (target, ABI, the state slot named from the app id), a
// screenshot of both screens, then a DevTools replay tape per step (CIRCLE to
// start, then the D-pad) with a screenshot after each. A step whose
// screenshot equals the previous one fails the run. Screenshots and the
// transcript go to --out (default .pocket-build/validation/runtime-3ds/<run>/).

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pocketRuntimeDeviceId } from "../../contracts/spec/pocket-runtime-wire.ts";
import { PocketRuntimeClient, parsePocketRuntimeToken } from "../../tools/3ds-runtime-client.ts";
import { readRuntimeDirectory } from "../../tools/repack.ts";
import { repack3ds } from "../../tools/repack/3ds.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const argv = Bun.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const device = argv.includes("--device");
const id = option("id");
if (!id) throw new Error("--id is required");
const run = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = option("out") ?? join(ROOT, ".pocket-build/validation/runtime-3ds", `${device ? "device" : "azahar"}-${run}`);
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

function setConfig(config: string, key: string, value: string): string {
  const line = new RegExp(`^${key}=.*$`, "m");
  if (!line.test(config)) return `${config}\n${key}=${value}\n${key}\\default=false\n`;
  const next = config.replace(line, `${key}=${value}`);
  const fallback = new RegExp(`^${key}\\\\default=.*$`, "m");
  return fallback.test(next) ? next.replace(fallback, `${key}\\default=false`) : next.replace(line, `${key}=${value}\n${key}\\default=false`);
}

function writeFixture(token: Uint8Array): void {
  rmSync(FIXTURE_HOME, { recursive: true, force: true });
  mkdirSync(join(USER_DIR, "config"), { recursive: true });
  mkdirSync(join(SDMC, "pocketjs/runtime"), { recursive: true });
  const sourceConfig = join(homedir(), "Library/Application Support/Azahar/config/qt-config.ini");
  const sourceUser = join(homedir(), "Library/Application Support/Azahar");
  for (const directory of ["nand", "sysdata"]) {
    if (existsSync(join(sourceUser, directory))) cpSync(join(sourceUser, directory), join(USER_DIR, directory), { recursive: true });
  }
  let config = existsSync(sourceConfig) ? readFileSync(sourceConfig, "utf8") : "[Renderer]\n";
  for (const [key, value] of [["graphics_api", "0"], ["resolution_factor", "1"], ["use_vsync", "false"], ["check_for_update_on_start", "false"]]) {
    config = setConfig(config, key!, value!);
  }
  writeFileSync(join(USER_DIR, "config/qt-config.ini"), config);
  writeFileSync(join(SDMC, "pocketjs/runtime/dev.key"), `${Buffer.from(token).toString("hex")}\n`);
}

// Azahar runs detached from this process (started from Bun.spawn with a pipe
// or file for output it never boots the ROM). Every ROM this run starts sits
// in --out, so its path names this run's emulator and nobody else's.
let romPath: string | null = null;

function killEmulator(): void {
  if (romPath) Bun.spawnSync(["pkill", "-9", "-f", romPath], { stdout: "ignore", stderr: "ignore" });
  romPath = null;
}

function launch(rom: string): void {
  killEmulator();
  romPath = rom;
  const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const log = join(OUT, `azahar-${Date.now()}.log`);
  const result = Bun.spawnSync(["sh", "-c", `HOME=${shell(FIXTURE_HOME)} ${shell(azaharBinary)} ${shell(rom)} > ${shell(log)} 2>&1 &`]);
  if (result.exitCode !== 0) throw new Error(`Azahar did not start: ${result.stderr.toString().trim()}`);
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
    const pocketPath = option("pocket");
    const identity = { id, title: option("title") ?? "", author: option("author") ?? "", version: option("version") ?? "" };
    if (!pocketPath || !identity.title || !identity.author || !identity.version) {
      throw new Error("Azahar runs need --pocket, --title, --author and --version");
    }
    const icon = option("icon");
    const runtime = readRuntimeDirectory(join(ROOT, "dist/runtime/3ds"));
    const started = performance.now();
    const game = await repack3ds({
      runtime,
      pocket: new Uint8Array(readFileSync(pocketPath)),
      identity: { ...identity, ...(icon ? { icon: new Uint8Array(readFileSync(icon)) } : {}) },
    });
    log(`repacked ${game.length} bytes in ${(performance.now() - started).toFixed(0)} ms`);
    const gamePath = join(OUT, "game.3dsx");
    writeFileSync(gamePath, game);
    const token = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 255);

    // The bare runtime: no RomFS, so it leaves its one line and waits for HOME.
    writeFixture(token);
    const barePath = join(OUT, "bare-runtime.3dsx");
    cpSync(join(ROOT, "dist/runtime/3ds/runtime.3dsx"), barePath);
    launch(barePath);
    const errorFile = join(SDMC, "pocketjs-error.txt");
    for (let waited = 0; waited < 30_000 && !existsSync(errorFile); waited += 250) await Bun.sleep(250);
    const line = existsSync(errorFile) ? readFileSync(errorFile, "utf8").trim() : "(no error file)";
    log(`bare runtime: ${line}`);
    if (!line.includes("carries no game")) throw new Error("the bare runtime did not say it carries no game");

    writeFixture(token);
    launch(gamePath);
    client = await connect("127.0.0.1", token, 60_000);
    log("connected to Azahar");
    await play(client);
    const state = join(SDMC, "pocketjs/runtime/apps", createHash("sha256").update(id).digest("hex").slice(0, 16));
    log(`state slot on the SD card: ${existsSync(state) ? state.slice(SDMC.length) : "missing"}`);
    if (!existsSync(state)) throw new Error("the game's state slot was not created");
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
