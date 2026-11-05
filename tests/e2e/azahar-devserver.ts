// In-process Pocket Runtime development E2E. One Azahar process stays alive
// while the host authenticates, uses Pocket DevTools, captures both screens,
// installs a changed `.pocket`, and restores the release guest over TCP.

import { $ } from "bun";
import { evidenceDirectory } from "./build.ts";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  POCKET_SECTION,
  decodePocketPackage,
  encodePocketPackage,
} from "../../contracts/spec/pocket-package.ts";
import {
  pocketPackageFooterHash,
  pocketRuntimeDeviceId,
} from "../../contracts/spec/pocket-runtime-wire.ts";
import {
  PocketRuntimeClient,
  discoverPocketRuntimes,
  type DiscoveredPocketRuntime,
  type PocketRuntimeScreenshot,
} from "../../tools/3ds-runtime-client.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const OUT = evidenceDirectory(ROOT, "azahar-devserver");
const FIXTURE_HOME = join(OUT, "home");
const USER_DIR = join(FIXTURE_HOME, "Library/Application Support/Azahar");
const CONFIG = join(USER_DIR, "config/qt-config.ini");
const RUNTIME_DIR = join(USER_DIR, "sdmc/pocketjs/runtime");
const CONSOLE_LOG = join(OUT, "azahar-console.log");
const SCREENSHOT = join(OUT, "both-screens.png");
const azaharApp = process.env.AZAHAR || "/Applications/Azahar.app";
const azaharBinary = join(azaharApp, "Contents/MacOS/azahar");
const sourceConfig = process.env.AZAHAR_CONFIG ||
  join(homedir(), "Library/Application Support/Azahar/config/qt-config.ini");
const sourceUserDir = sourceConfig.replace(/\/config\/[^/]+$/, "");
const timeoutMs = Number(process.env.E2E_AZAHAR_TIMEOUT_MS ?? 60_000);
const token = Uint8Array.from({ length: 32 }, (_, index) => index * 7 + 3);

function fail(message: string): never {
  console.error(`FAIL 3DS Pocket Runtime DevTools: ${message}`);
  process.exit(1);
}

if (process.platform !== "darwin") fail("Azahar development E2E is macOS-only");
if (!existsSync(azaharBinary)) fail(`Azahar not found at ${azaharApp}`);
if (!existsSync(sourceConfig)) fail(`Azahar config not found at ${sourceConfig}`);

function setConfig(config: string, key: string, value: string): string {
  const assignment = new RegExp(`^${key}=.*$`, "gm");
  if ((config.match(assignment)?.length ?? 0) !== 1) {
    throw new Error(`qt-config.ini does not carry exactly one ${key}`);
  }
  let next = config.replace(new RegExp(`^${key}=.*$`, "m"), () => `${key}=${value}`);
  next = new RegExp(`^${key}\\\\default=.*$`, "m").test(next)
    ? next.replace(new RegExp(`^${key}\\\\default=.*$`, "m"), () => `${key}\\default=false`)
    : next.replace(
        new RegExp(`^${key}=.*$`, "m"),
        () => `${key}=${value}\n${key}\\default=false`,
      );
  return next;
}

function writeFixture(): void {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(USER_DIR, "config"), { recursive: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });
  for (const directory of ["nand", "sysdata"]) {
    const source = join(sourceUserDir, directory);
    if (existsSync(source)) cpSync(source, join(USER_DIR, directory), { recursive: true });
  }
  let config = readFileSync(sourceConfig, "utf8");
  config = setConfig(config, "graphics_api", "0");
  config = setConfig(config, "resolution_factor", "1");
  config = setConfig(config, "use_vsync", "false");
  config = setConfig(config, "frame_limit", "1000");
  config = setConfig(config, "check_for_update_on_start", "false");
  writeFileSync(CONFIG, config);
  writeFileSync(join(RUNTIME_DIR, "dev.key"), `${Buffer.from(token).toString("hex")}\n`);
}

function killEmulator(): void {
  Bun.spawnSync(["pkill", "-9", "-f", azaharBinary], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

function launch(rom: string): void {
  killEmulator();
  const result = Bun.spawnSync(
    [
      "open",
      "-n",
      "-a",
      azaharApp,
      "--env",
      `HOME=${FIXTURE_HOME}`,
      "--stdout",
      CONSOLE_LOG,
      "--stderr",
      CONSOLE_LOG,
      "--args",
      rom,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
}

async function connectUntil(overrideToken = token): Promise<PocketRuntimeClient> {
  const started = Date.now();
  let lastError = "not listening";
  while (Date.now() - started < timeoutMs) {
    const client = new PocketRuntimeClient({
      host: "127.0.0.1",
      token: overrideToken,
      timeoutMs: 10_000,
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      client.close();
      await Bun.sleep(100);
    }
  }
  throw new Error(`development socket did not accept a client: ${lastError}`);
}

async function discoverUntil(): Promise<DiscoveredPocketRuntime> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const devices = await discoverPocketRuntimes({
      addresses: ["127.0.0.1"],
      timeoutMs: 150,
    });
    if (devices.length > 0) return devices[0];
    await Bun.sleep(100);
  }
  throw new Error("development runtime did not answer UDP discovery");
}

function withProbe(good: Uint8Array, marker: string): Uint8Array {
  const value = decodePocketPackage(good);
  return encodePocketPackage({
    manifest: value.manifest,
    variants: value.variants.map((variant) => ({
      ...variant,
      sections: variant.sections.map((section) => section.kind === POCKET_SECTION.js
        ? {
            ...section,
            bytes: new Uint8Array([
              ...new TextEncoder().encode(`globalThis.__runtimeProbe=${JSON.stringify(marker)};\n`),
              ...section.bytes,
            ]),
          }
        : section),
    })),
  });
}

function hexHash(bytes: Uint8Array): string {
  return pocketPackageFooterHash(bytes).toString(16).padStart(16, "0");
}

async function install(client: PocketRuntimeClient, bytes: Uint8Array): Promise<Record<string, unknown>> {
  const hash = hexHash(bytes);
  const receipt = client.waitForCtrl(
    (message) => message.t === "runtime.install" && message.hash === hash &&
      ["accepted", "rejected", "transfer-error"].includes(String(message.phase)),
    30_000,
  );
  await client.install(bytes);
  const result = await receipt;
  if (result.phase !== "accepted") {
    throw new Error(`device rejected ${hash}: ${String(result.message ?? result.phase)}`);
  }
  return result;
}

async function evaluate(
  client: PocketRuntimeClient,
  id: string,
  code: string,
): Promise<Record<string, unknown>> {
  const result = client.waitForCtrl(
    (message) => message.t === "evalResult" && message.id === id,
    10_000,
  );
  await client.sendCtrl({ t: "eval", id, code });
  return await result;
}

function assertScreenshot(screenshot: PocketRuntimeScreenshot): void {
  if (screenshot.metadata.topWidth !== 400 || screenshot.metadata.topHeight !== 240 ||
      screenshot.metadata.auxiliaryWidth !== 320 || screenshot.metadata.auxiliaryHeight !== 240) {
    throw new Error(`wrong screenshot surfaces: ${JSON.stringify(screenshot.metadata)}`);
  }
  if (screenshot.png.subarray(1, 4).toString() !== "PNG") {
    throw new Error("combined screenshot is not a PNG");
  }
  if (screenshot.png.readUInt32BE(16) !== 400 || screenshot.png.readUInt32BE(20) !== 480) {
    throw new Error("combined screenshot is not 400 x 480");
  }
}

let client: PocketRuntimeClient | null = null;
try {
  const build = await $`bun tools/3ds.ts 3ds-demo`.cwd(ROOT).quiet().nothrow();
  if (build.exitCode !== 0) throw new Error(`build failed\n${build.stdout}${build.stderr}`);
  const rom = join(ROOT, "dist/3ds/pocket3ds-demo-main.3dsx");
  const pocket = join(ROOT, "dist/3ds/pocket3ds-demo-main.pocket");
  writeFixture();
  launch(rom);

  const discovered = await discoverUntil();
  if (discovered.target !== "3ds-dev" || discovered.hostAbi !== POCKET_BINDING_GENERATION ||
      discovered.port !== 8131 || discovered.deviceId !== pocketRuntimeDeviceId(token)) {
    throw new Error(`wrong discovery identity: ${JSON.stringify({
      ...discovered,
      activeHash: discovered.activeHash.toString(16),
      deviceId: discovered.deviceId.toString(16),
    })}`);
  }
  console.log(`PASS discovered paired Runtime ${discovered.address}:${discovered.port} without an IP argument`);

  const wrong = Uint8Array.from(token, (byte) => byte ^ 0xff);
  try {
    const rejected = await connectUntil(wrong);
    rejected.close();
    throw new Error("an incorrect pairing token authenticated");
  } catch (error) {
    if (!String(error).includes("rejected the pairing token")) throw error;
  }
  console.log("PASS rejected an incorrect pairing token");

  client = await connectUntil();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("native Runtime did not answer a heartbeat")), 6_000);
    client!.once("pong", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  console.log("PASS native Runtime returned a PONG on the authenticated connection");
  const statusPromise = client.waitForCtrl((message) => message.t === "runtime.status");
  await client.requestStatus();
  const status = await statusPromise;
  if (status.target !== "3ds-dev" || status.hostAbi !== POCKET_BINDING_GENERATION || status.phase !== "booted") {
    throw new Error(`wrong runtime status: ${JSON.stringify(status)}`);
  }

  const statsPromise = client.waitForCtrl((message) => message.t === "devStats");
  const treePromise = client.waitForCtrl((message) => message.t === "tree");
  const logPromise = client.waitForCtrl(
    (message) => message.t === "log" && JSON.stringify(message).includes("Azahar devserver E2E"),
  );
  const evalPromise = evaluate(
    client,
    "initial",
    'console.log("Azahar devserver E2E"); ({target:globalThis.ui.__host,abi:globalThis.ui.__hostAbi})',
  );
  await client.sendCtrl({ t: "devStats" });
  await client.sendCtrl({ t: "getTree" });
  const [stats, tree, evaluation] = await Promise.all([
    statsPromise,
    treePromise,
    evalPromise,
    logPromise,
  ]);
  if (!stats.data || typeof tree.frame !== "number" ||
      !String(evaluation.value).includes('target: "3ds-dev"')) {
    throw new Error("Pocket DevTools status/tree/eval transcript is incomplete");
  }
  console.log("PASS status, logs, tree, eval, and native debug stats share one connection");

  const screenshotPromise = client.waitForScreenshot(20_000);
  await client.sendCtrl({ t: "screenshot" });
  const screenshot = await screenshotPromise;
  assertScreenshot(screenshot);
  writeFileSync(SCREENSHOT, screenshot.png);
  console.log(`PASS captured both screens at frame ${screenshot.frame}`);

  const good = new Uint8Array(readFileSync(pocket));
  const marker = "azahar-devserver";
  const changed = withProbe(good, marker);
  const changedReceipt = await install(client, changed);
  const changedEval = await evaluate(client, "changed", "globalThis.__runtimeProbe ?? null");
  if (!String(changedEval.value).includes(marker) || Number(changedReceipt.generation) !== 1) {
    throw new Error(`changed guest was not active: ${JSON.stringify(changedEval)}`);
  }
  console.log(`PASS installed and executed changed guest ${hexHash(changed)}`);

  const restoredReceipt = await install(client, good);
  const restoredEval = await evaluate(client, "restored", "globalThis.__runtimeProbe ?? null");
  if (String(restoredEval.value) !== "null" || Number(restoredReceipt.generation) !== 2) {
    throw new Error(`release guest was not restored: ${JSON.stringify(restoredEval)}`);
  }
  console.log(`PASS restored release guest ${hexHash(good)} without restarting Azahar`);
  console.log("Azahar Pocket Runtime DevTools E2E: 7 passed, 0 failed");
} catch (error) {
  console.error(`FAIL 3DS Pocket Runtime DevTools: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  client?.close();
  killEmulator();
}
