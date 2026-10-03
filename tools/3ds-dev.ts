#!/usr/bin/env bun

// Pocket Runtime development loop for Nintendo 3DS.
//
//   bun tools/3ds-dev.ts pair  --host 192.168.8.102
//   bun tools/3ds-dev.ts discover
//   bun tools/3ds-dev.ts push    --app 3ds-demo
//   bun tools/3ds-dev.ts install --app 3ds-demo
//   bun tools/3ds-dev.ts launch  pocket3ds-demo-main.3dsx
//   bun tools/3ds-dev.ts probe
//   bun tools/3ds-dev.ts dev     --app 3ds-demo
//
// `pair` is the one-time ftpd step. Everything else talks directly to the
// running Pocket Runtime over its authenticated TCP connection: `push`
// replaces the guest, `install` writes a .3dsx to sdmc:/3ds/ and restarts
// into it, `launch` starts a .3dsx already on the card.

import { $ } from "bun";
import { guardDeviceCommand } from "./device-lease.ts";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  POCKET_RUNTIME_ACK_FLAG_NATIVE,
  POCKET_RUNTIME_WIRE_PORT,
  pocketPackageFooterHash,
  pocketRuntimeDeviceId,
  pocketRuntimeNativeNameValid,
  type PocketRuntimeAck,
} from "../contracts/spec/pocket-runtime-wire.ts";
import { startDevServer } from "../hosts/web/server.ts";
import {
  PocketRuntimeClient,
  PocketRuntimeSession,
  PocketRuntimeTimeoutError,
  discoverPocketRuntimes,
  parsePocketRuntimeToken,
  type DiscoveredPocketRuntime,
  type PocketRuntimeScreenshot,
} from "./3ds-runtime-client.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const argv = Bun.argv.slice(2);
const commands = new Set(["pair", "discover", "push", "install", "launch", "probe", "dev"]);
const command = commands.has(argv[0] ?? "") ? argv.shift()! : "dev";

function value(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function has(flag: string): boolean {
  return argv.includes(flag);
}

function usage(message?: string, exitCode = 1): never {
  if (message) console.error(`3ds-dev: ${message}`);
  console.error(`Usage:
  bun tools/3ds-dev.ts pair  --host <3ds-ip> [--ftp-port 5000] [--rotate]
  bun tools/3ds-dev.ts discover
  bun tools/3ds-dev.ts push    [--host <3ds-ip>] [--app 3ds-demo | --package file.pocket]
  bun tools/3ds-dev.ts install [--host <3ds-ip>] [--app 3ds-demo | --file app.3dsx] [--name app.3dsx]
                               [--no-launch] [--ftp [--ftp-port 5000]]
  bun tools/3ds-dev.ts launch  [--host <3ds-ip>] <app.3dsx>
  bun tools/3ds-dev.ts probe   [--host <3ds-ip>] [--out screenshot.png]
  bun tools/3ds-dev.ts dev     [--host <3ds-ip>] [--app 3ds-demo] [--no-push] [--panel-port 8130]

The device must run Pocket Runtime for push/install/launch/probe/dev. pair runs
once while ftpd is open. Other commands discover a paired Runtime
automatically; --host is an explicit fallback. install --ftp copies the .3dsx
through ftpd instead, for a Runtime older than .3dsx install.`);
  process.exit(exitCode);
}

if (has("-h") || has("--help")) usage(undefined, 0);
const explicitHost = value("--host") ?? process.env.POCKET_3DS_HOST;
const configuredPort = Number(value("--port") ?? POCKET_RUNTIME_WIRE_PORT);
if (!Number.isInteger(configuredPort) || configuredPort <= 0 || configuredPort > 65535) {
  usage("--port is invalid");
}
const keyDirectory = join(ROOT, ".pocket", "3ds", "devices");
const NO_RUNTIME_DISCOVERED =
  "no Pocket Runtime discovered; open the 3DS dev menu for its IP and retry with --host";

interface DeviceTarget {
  readonly host: string;
  readonly port: number;
  readonly token: Uint8Array;
  readonly deviceId: bigint;
}

function keyPathFor(host: string, port: number): string {
  const safe = `${host}-${port}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return join(keyDirectory, `${safe}.key`);
}

function tokenAt(path: string): Uint8Array {
  return parsePocketRuntimeToken(readFileSync(path, "utf8"));
}

function tokenForDevice(deviceId: bigint): Uint8Array | null {
  if (!existsSync(keyDirectory)) return null;
  for (const name of readdirSync(keyDirectory).filter((entry) => entry.endsWith(".key")).sort()) {
    try {
      const token = tokenAt(join(keyDirectory, name));
      if (pocketRuntimeDeviceId(token) === deviceId) return token;
    } catch {
      // A corrupt key is reported when selected explicitly; discovery skips it.
    }
  }
  return null;
}

function deviceIdText(deviceId: bigint): string {
  return deviceId.toString(16).padStart(16, "0");
}

async function discoveredDevices(addresses?: readonly string[]): Promise<DiscoveredPocketRuntime[]> {
  return await discoverPocketRuntimes({ port: configuredPort, addresses });
}

async function rediscoverTarget(target: DeviceTarget): Promise<DeviceTarget> {
  const match = (await discoveredDevices()).find((device) => device.deviceId === target.deviceId);
  if (!match) {
    throw new Error(`paired Runtime ${deviceIdText(target.deviceId)} did not answer discovery`);
  }
  return {
    host: match.address,
    port: match.port,
    token: target.token,
    deviceId: target.deviceId,
  };
}

async function resolveTarget(): Promise<DeviceTarget> {
  if (explicitHost) {
    const path = keyPathFor(explicitHost, configuredPort);
    if (existsSync(path)) {
      const token = tokenAt(path);
      return {
        host: explicitHost,
        port: configuredPort,
        token,
        deviceId: pocketRuntimeDeviceId(token),
      };
    }
    const match = (await discoveredDevices([explicitHost])).find(
      (device) => device.address === explicitHost,
    );
    const token = match ? tokenForDevice(match.deviceId) : null;
    if (match && token) {
      return {
        host: match.address,
        port: match.port,
        token,
        deviceId: match.deviceId,
      };
    }
    throw new Error(`device is not paired; run bun run 3ds:dev pair --host ${explicitHost}`);
  }

  const devices = await discoveredDevices();
  const paired = devices.flatMap((device) => {
    const token = tokenForDevice(device.deviceId);
    return token ? [{ device, token }] : [];
  });
  if (paired.length === 0) {
    if (devices.length > 0) {
      const list = devices
        .map((device) => `${device.label || device.target} at ${device.address}`)
        .join(", ");
      throw new Error(`found ${list}, but no matching local pairing key; pair it once through ftpd`);
    }
    throw new Error(NO_RUNTIME_DISCOVERED);
  }
  if (paired.length > 1) {
    const list = paired
      .map(({ device }) => `${device.address} (${deviceIdText(device.deviceId)})`)
      .join(", ");
    throw new Error(`multiple paired Runtimes discovered: ${list}; select one with --host`);
  }
  const { device, token } = paired[0];
  console.log(
    `discovered ${device.label || device.target} ${device.address}:${device.port} — ${deviceIdText(device.deviceId)}`,
  );
  return {
    host: device.address,
    port: device.port,
    token,
    deviceId: device.deviceId,
  };
}

async function waitForDevTarget(): Promise<DeviceTarget> {
  let attempts = 0;
  for (;;) {
    try {
      return await resolveTarget();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (explicitHost || detail !== NO_RUNTIME_DISCOVERED) {
        throw error;
      }
      attempts += 1;
      if (attempts === 1 || attempts % 12 === 0) {
        const suffix = attempts === 1 ? "" : ` (${attempts} attempts)`;
        console.error(`3ds-dev: waiting for paired Runtime discovery${suffix}`);
      }
      await Bun.sleep(750);
    }
  }
}

async function pair(): Promise<void> {
  const host = explicitHost ?? usage("pair requires --host while ftpd is running");
  const port = configuredPort;
  const keyPath = keyPathFor(host, port);
  mkdirSync(keyDirectory, { recursive: true });
  let token: Uint8Array;
  if (existsSync(keyPath) && !has("--rotate")) {
    token = tokenAt(keyPath);
  } else {
    token = crypto.getRandomValues(new Uint8Array(32));
    writeFileSync(keyPath, `${Buffer.from(token).toString("hex")}\n`, { mode: 0o600 });
  }
  chmodSync(keyPath, 0o600);
  const ftpPort = Number(value("--ftp-port") ?? 5000);
  if (!Number.isInteger(ftpPort) || ftpPort <= 0 || ftpPort > 65535) {
    usage("--ftp-port is invalid");
  }
  const url = `ftp://${host}:${ftpPort}/pocketjs/runtime/dev.key`;
  const upload = Bun.spawnSync([
    "curl",
    "--silent",
    "--show-error",
    "--fail",
    "--ftp-create-dirs",
    "--connect-timeout",
    "3",
    "--max-time",
    "30",
    "-T",
    keyPath,
    url,
  ]);
  if (upload.exitCode !== 0) throw new Error(upload.stderr.toString().trim());
  const readback = Bun.spawnSync([
    "curl",
    "--silent",
    "--show-error",
    "--fail",
    "--connect-timeout",
    "3",
    "--max-time",
    "15",
    url,
  ]);
  if (readback.exitCode !== 0) throw new Error(readback.stderr.toString().trim());
  const remote = parsePocketRuntimeToken(readback.stdout.toString());
  if (!Buffer.from(remote).equals(Buffer.from(token))) {
    throw new Error("device pairing key failed its FTP readback comparison");
  }
  console.log(`paired ${host}:${port}`);
  console.log(`device key: /pocketjs/runtime/dev.key`);
  console.log(`local key:  ${keyPath}`);
  console.log("restart Pocket Runtime once; ftpd is not needed afterwards");
}

async function buildPackage(app: string): Promise<string> {
  const result = await $`bun tools/3ds.ts ${app} --pocket-only`.cwd(ROOT).quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`3DS guest build failed\n${result.stdout}${result.stderr}`);
  }
  const text = `${result.stdout}\n${result.stderr}`;
  const paths = [...text.matchAll(/^output: (.+\.pocket) \(/gm)];
  const path = paths.at(-1)?.[1];
  if (!path || !existsSync(path)) throw new Error("3DS guest build did not report a .pocket output");
  return path;
}

interface NativeBuild {
  readonly path: string;
  /** The guest the .3dsx embeds, when its .pocket is known. */
  readonly pocket: string | null;
  readonly embeddedHash: string | null;
}

function nativeBuildAt(path: string, pocket: string | null): NativeBuild {
  if (!pocket || !existsSync(pocket)) return { path, pocket: null, embeddedHash: null };
  const hash = pocketPackageFooterHash(new Uint8Array(readFileSync(pocket)));
  return { path, pocket, embeddedHash: hash.toString(16).padStart(16, "0") };
}

async function buildNative(app: string): Promise<NativeBuild> {
  const result = await $`bun tools/3ds.ts ${app}`.cwd(ROOT).quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`3DS build failed\n${result.stdout}${result.stderr}`);
  }
  const text = `${result.stdout}\n${result.stderr}`;
  const path = [...text.matchAll(/^output: (.+\.3dsx)$/gm)].at(-1)?.[1];
  if (!path || !existsSync(path)) throw new Error("3DS build did not report a .3dsx output");
  const pocket = [...text.matchAll(/^output: (.+\.pocket) \(/gm)].at(-1)?.[1] ?? null;
  return nativeBuildAt(path, pocket);
}

/** --file names a .3dsx built elsewhere; its .pocket, if any, sits beside it. */
async function nativeBuild(): Promise<NativeBuild> {
  const explicit = value("--file");
  if (!explicit) return await buildNative(value("--app") ?? "3ds-demo");
  const path = resolve(explicit);
  if (!existsSync(path)) throw new Error(`.3dsx does not exist: ${path}`);
  return nativeBuildAt(path, path.replace(/\.3dsx$/i, ".pocket"));
}

async function packagePath(): Promise<string> {
  const explicit = value("--package");
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new Error(`package does not exist: ${path}`);
    return path;
  }
  return await buildPackage(value("--app") ?? "3ds-demo");
}

function createClient(target: DeviceTarget): PocketRuntimeClient {
  return new PocketRuntimeClient({
    host: target.host,
    port: target.port,
    token: target.token,
    timeoutMs: 15_000,
  });
}

/** Connect, retrying once when the TCP connect or handshake times out: the
 *  console's single-client listener can miss a connection made right after
 *  the previous client left. */
async function open(
  target: DeviceTarget,
  quiet = false,
): Promise<{ client: PocketRuntimeClient; ack: PocketRuntimeAck }> {
  for (let attempt = 0; ; attempt += 1) {
    const client = createClient(target);
    client.on("socketError", (error) => {
      if (!quiet) console.error(`3ds-dev: socket: ${String(error)}`);
    });
    try {
      const ack = await client.connect();
      console.log(
        `connected ${target.host}:${target.port} — abi ${ack.hostAbi}, generation ${ack.generation}, active ${ack.activeHash.toString(16).padStart(16, "0")}`,
      );
      return { client, ack };
    } catch (error) {
      client.close();
      if (attempt > 0 || !(error instanceof PocketRuntimeTimeoutError)) throw error;
      console.error(`3ds-dev: ${error.message}; retrying`);
      await Bun.sleep(1000);
    }
  }
}

async function connect(target: DeviceTarget): Promise<PocketRuntimeClient> {
  return (await open(target)).client;
}

async function discoverCommand(): Promise<void> {
  const devices = await discoveredDevices();
  if (devices.length === 0) throw new Error("no Pocket Runtime answered discovery");
  for (const device of devices) {
    const paired = tokenForDevice(device.deviceId) !== null;
    console.log(
      `${device.label || device.target}  ${device.address}:${device.port}  id ${deviceIdText(device.deviceId)}  ` +
        `gen ${device.generation}  ${paired ? "paired" : "no local key"}`,
    );
  }
}

function hashOf(value: Record<string, unknown>): string {
  return String(value.hash ?? "").toLowerCase();
}

async function pushWithClient(client: PocketRuntimeClient, path: string): Promise<string> {
  const bytes = new Uint8Array(readFileSync(path));
  const expectedHash = pocketPackageFooterHash(bytes).toString(16).padStart(16, "0");
  const verdict = client.waitForCtrl(
    (message) => message.t === "runtime.install" &&
      ["accepted", "rejected", "transfer-error"].includes(String(message.phase)) &&
      hashOf(message) === expectedHash,
    30_000,
  );
  const hash = await client.install(bytes);
  if (hash.toString(16).padStart(16, "0") !== expectedHash) {
    throw new Error("package footer changed while preparing the transfer");
  }
  console.log(`sent ${basename(path)} — ${bytes.length} bytes, ${expectedHash}`);
  const result = await verdict;
  if (result.phase !== "accepted") {
    throw new Error(`device rejected ${expectedHash}: ${String(result.message ?? result.phase)}`);
  }
  console.log(`accepted ${expectedHash}`);
  return expectedHash;
}

async function push(): Promise<void> {
  const path = await packagePath();
  const target = await resolveTarget();
  const client = await connect(target);
  try {
    await pushWithClient(client, path);
  } finally {
    client.close();
  }
}

function supportsNative(ack: PocketRuntimeAck): boolean {
  return (ack.flags & POCKET_RUNTIME_ACK_FLAG_NATIVE) !== 0;
}

function requireNative(ack: PocketRuntimeAck): void {
  if (!supportsNative(ack)) {
    throw new Error(
      "this Runtime predates .3dsx install; copy one newer .3dsx through ftpd first: " +
        "bun run 3ds:dev install --ftp --host <3ds-ip>",
    );
  }
}

type NativeReceipt = Record<string, unknown> & { phase: string; name: string; message?: string };

/** The runtime.native receipts for one file name, kept from before the
 *  transfer starts so none is missed, with the first failure noted. */
function collectReceipts(client: PocketRuntimeClient, name: string) {
  const seen: NativeReceipt[] = [];
  const waiters: (() => void)[] = [];
  let failure: NativeReceipt | null = null;
  const onCtrl = (message: Record<string, unknown>) => {
    if (message.t !== "runtime.native" || message.name !== name) return;
    const receipt = message as NativeReceipt;
    seen.push(receipt);
    if (!failure && /error|rejected/.test(receipt.phase)) failure = receipt;
    for (const wake of waiters.splice(0)) wake();
  };
  client.on("ctrl", onCtrl);
  return {
    failed: () => failure,
    stop: () => client.off("ctrl", onCtrl),
    /** The next receipt in `phases` (or a failure), within timeoutMs from now. */
    async next(phases: readonly string[], timeoutMs: number): Promise<NativeReceipt> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = seen.find((receipt) => phases.includes(receipt.phase)) ?? failure;
        if (found) return found;
        const left = deadline - Date.now();
        if (left <= 0) throw new PocketRuntimeTimeoutError(`no ${phases.join("/")} receipt for ${name} within ${timeoutMs} ms`);
        await new Promise<void>((wake) => {
          const timer = setTimeout(wake, left);
          waiters.push(() => {
            clearTimeout(timer);
            wake();
          });
        });
      }
    },
  };
}

/** Send a .3dsx and wait for the device to install (or stage) it and, when
 *  asked, to hand it to the loader. Waits are timed from the end of the
 *  transfer, so a large file does not count against them. */
async function installWithClient(
  client: PocketRuntimeClient,
  path: string,
  name: string,
  launch: boolean,
): Promise<void> {
  const bytes = new Uint8Array(readFileSync(path));
  const receipts = collectReceipts(client, name);
  try {
    const began = Date.now();
    const crc = await client.installNative(bytes, name, launch, () => receipts.failed() !== null);
    const stored = await receipts.next(["installed", "staged"], 30_000);
    if (stored.phase !== "installed" && stored.phase !== "staged") {
      throw new Error(`device refused ${name}: ${String(stored.message ?? stored.phase)}`);
    }
    const seconds = ((Date.now() - began) / 1000).toFixed(1);
    console.log(
      `${stored.phase} sdmc:/3ds/${name} — ${bytes.length} bytes, crc32 ${crc.toString(16).padStart(8, "0")}, ${seconds} s`,
    );
    if (!launch) {
      if (stored.phase === "staged") console.log("the running .3dsx is replaced when it next exits");
      return;
    }
    const started = await receipts.next(["launching", "launch-error"], 15_000);
    if (started.phase !== "launching") {
      throw new Error(`installed, but could not restart into it: ${String(started.message ?? started.phase)}`);
    }
    console.log(`restarting into ${name}`);
  } finally {
    receipts.stop();
  }
}

async function runningHash(client: PocketRuntimeClient): Promise<string> {
  const status = client.waitForCtrl((message) => message.t === "runtime.status");
  await client.requestStatus();
  return String((await status).running ?? "");
}

/** After a launch the device comes back under the same pairing ID. Returns
 *  a connected client, or null when nothing answered within 60 s (a .3dsx
 *  that is not a PocketJS dev build never does). */
async function awaitReturn(target: DeviceTarget): Promise<PocketRuntimeClient | null> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await Bun.sleep(1500);
    try {
      // Refused connections are expected while the console restarts.
      return (await open(explicitHost ? target : await rediscoverTarget(target), true)).client;
    } catch {
      // Still restarting.
    }
  }
  return null;
}

/** The console should run the guest the installed .3dsx embeds. A .3dsx whose
 *  embedded guest the slot has booted before does not displace a later push
 *  (README: "A newly installed .3dsx boots the guest it embeds"), so an
 *  unchanged binary reinstalled after a push gets its guest pushed. */
async function settleGuest(client: PocketRuntimeClient, build: NativeBuild): Promise<void> {
  const running = await runningHash(client);
  if (!build.embeddedHash || !build.pocket) {
    console.log(`running ${running}`);
    return;
  }
  if (running === build.embeddedHash) {
    console.log(`running ${running}, the guest ${basename(build.path)} embeds`);
    return;
  }
  console.log(`running ${running}, an older push; sending the embedded guest ${build.embeddedHash}`);
  await pushWithClient(client, build.pocket);
}

function ftpInstall(path: string, name: string): void {
  const host = explicitHost ?? usage("install --ftp requires --host while ftpd is running");
  const ftpPort = Number(value("--ftp-port") ?? 5000);
  if (!Number.isInteger(ftpPort) || ftpPort <= 0 || ftpPort > 65535) usage("--ftp-port is invalid");
  const url = `ftp://${host}:${ftpPort}/3ds/${name}`;
  const upload = Bun.spawnSync([
    "curl", "--silent", "--show-error", "--fail", "--noproxy", "*", "--ftp-create-dirs",
    "--connect-timeout", "3", "--max-time", "300", "-T", path, url,
  ]);
  if (upload.exitCode !== 0) throw new Error(upload.stderr.toString().trim());
  console.log(`copied ${basename(path)} to ${url}; start it from the Homebrew Launcher`);
}

function nativeName(build: NativeBuild): string {
  const name = value("--name") ?? basename(build.path);
  if (!pocketRuntimeNativeNameValid(name)) usage(`${name} is not a .3dsx file name the Runtime accepts`);
  return name;
}

async function install(): Promise<void> {
  const build = await nativeBuild();
  const name = nativeName(build);
  if (has("--ftp")) {
    ftpInstall(build.path, name);
    return;
  }
  const launch = !has("--no-launch");
  const target = await resolveTarget();
  const { client, ack } = await open(target);
  try {
    requireNative(ack);
    await installWithClient(client, build.path, name, launch);
  } finally {
    client.close();
  }
  if (!launch) return;
  const back = await awaitReturn(target);
  if (!back) {
    if (build.embeddedHash) throw new Error(`${name} did not answer within 60 s after the restart`);
    console.log(`${name} started; it does not answer the dev connection`);
    return;
  }
  try {
    await settleGuest(back, build);
  } finally {
    back.close();
  }
}

async function launchCommand(): Promise<void> {
  const name = argv.find((entry, index) => !entry.startsWith("--") && (index === 0 || !argv[index - 1].startsWith("--")));
  if (!name || !pocketRuntimeNativeNameValid(name)) usage("launch needs a .3dsx name under sdmc:/3ds/");
  const target = await resolveTarget();
  const { client, ack } = await open(target);
  const receipts = collectReceipts(client, name);
  try {
    requireNative(ack);
    await client.launch(name);
    const result = await receipts.next(["launching", "launch-error"], 15_000);
    if (result.phase !== "launching") throw new Error(`could not launch ${name}: ${String(result.message ?? result.phase)}`);
    console.log(`launching ${name}`);
  } finally {
    receipts.stop();
    client.close();
  }
  const back = await awaitReturn(target);
  if (!back) {
    console.log(`${name} started; it does not answer the dev connection`);
    return;
  }
  try {
    console.log(`back at ${back.host} — running ${await runningHash(back)}`);
  } finally {
    back.close();
  }
}

function screenshotPath(frame: number): string {
  const explicit = value("--out");
  if (explicit) return resolve(explicit);
  const directory = join(ROOT, "dist", "3ds", "screenshots");
  mkdirSync(directory, { recursive: true });
  return join(directory, `pocket-runtime-f${String(frame).padStart(6, "0")}.png`);
}

async function probe(): Promise<void> {
  const target = await resolveTarget();
  const client = await connect(target);
  try {
    const statusPromise = client.waitForCtrl((message) => message.t === "runtime.status");
    await client.requestStatus();
    const status = await statusPromise;

    const statsPromise = client.waitForCtrl((message) => message.t === "devStats");
    const treePromise = client.waitForCtrl((message) => message.t === "tree");
    const evalPromise = client.waitForCtrl(
      (message) => message.t === "evalResult" && message.id === "3ds-probe",
    );
    const logPromise = client.waitForCtrl(
      (message) => message.t === "log" && JSON.stringify(message).includes("Pocket Runtime probe"),
    );
    const shotPromise = client.waitForScreenshot(20_000);
    await client.sendCtrl({ t: "devStats" });
    await client.sendCtrl({ t: "getTree" });
    await client.sendCtrl({
      t: "eval",
      id: "3ds-probe",
      code: 'console.log("Pocket Runtime probe"); ({target:globalThis.ui.__host,abi:globalThis.ui.__hostAbi,probe:globalThis.__runtimeProbe??null})',
    });
    await client.sendCtrl({ t: "screenshot" });
    const [stats, tree, evaluation, , screenshot] = await Promise.all([
      statsPromise,
      treePromise,
      evalPromise,
      logPromise,
      shotPromise,
    ]);
    const output = screenshotPath(screenshot.frame);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, screenshot.png);
    console.log(`status:     ${JSON.stringify(status)}`);
    console.log(`devStats:   ${JSON.stringify(stats.data)}`);
    console.log(`tree frame: ${String(tree.frame ?? "?")}`);
    console.log(`eval:       ${String(evaluation.value ?? "?")}`);
    console.log(`screenshot: ${output} (${screenshot.png.length} bytes)`);
  } finally {
    client.close();
  }
}

async function dev(): Promise<void> {
  let target = await waitForDevTarget();
  const panelPort = Number(value("--panel-port") ?? process.env.PORT ?? 8130);
  const server = startDevServer({ port: panelPort, portRetries: 10 });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?role=device`);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.onopen = () => resolveOpen();
    socket.onerror = () => rejectOpen(new Error("Pocket DevTools panel WebSocket failed to open"));
  });
  let connectionAttempts = 0;
  const session = new PocketRuntimeSession({
    retryDelayMs: 750,
    createClient: async () => {
      if (connectionAttempts++ > 0 && !explicitHost) target = await rediscoverTarget(target);
      return createClient(target);
    },
  });
  let currentPackage = value("--package") ? resolve(value("--package")!) : "";

  const forwardScreenshot = (screenshot: PocketRuntimeScreenshot) => {
    if (socket.readyState === WebSocket.OPEN) {
      const data = `data:image/png;base64,${screenshot.png.toString("base64")}`;
      socket.send(JSON.stringify({ t: "screenshot", frame: screenshot.frame, data }));
    }
    const output = screenshotPath(screenshot.frame);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, screenshot.png);
    console.log(`screenshot ${output}`);
  };
  session.on("screenshot", forwardScreenshot);
  session.on("ctrlLine", (line: string) => {
    let rawNotice = false;
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      rawNotice = message.t === "screenshotRaw";
      if (message.t === "runtime.status") console.log(`runtime ${line}`);
      if (message.t === "runtime.install") console.log(`update ${line}`);
    } catch {
      // Forward malformed lines so the panel can expose the protocol error.
    }
    if (!rawNotice && socket.readyState === WebSocket.OPEN) socket.send(line);
  });
  let reconnectFailures = 0;
  let native = false;
  session.on("connect", (_client: PocketRuntimeClient, ack) => {
    native = supportsNative(ack);
    console.log(
      `connected ${target.host}:${target.port} — abi ${ack.hostAbi}, generation ${ack.generation}, active ${ack.activeHash.toString(16).padStart(16, "0")}`,
    );
  });
  session.on("disconnect", () => {
    reconnectFailures = 0;
    console.error("3ds-dev: runtime disconnected; reconnecting");
  });
  session.on("reconnectError", (error) => {
    reconnectFailures += 1;
    if (reconnectFailures === 1 || reconnectFailures % 12 === 0) {
      const detail = error instanceof Error ? error.message : String(error);
      const attempts = reconnectFailures === 1 ? "" : ` (${reconnectFailures} attempts)`;
      console.error(`3ds-dev: reconnect waiting: ${detail}${attempts}`);
    }
  });
  session.on("reconnect", (client: PocketRuntimeClient, ack) => {
    native = supportsNative(ack);
    reconnectFailures = 0;
    console.log(
      `reconnected ${target.host}:${target.port} — abi ${ack.hostAbi}, generation ${ack.generation}, active ${ack.activeHash.toString(16).padStart(16, "0")}`,
    );
    void client.requestStatus().catch((error) => console.error(String(error)));
  });
  socket.onmessage = (event) => {
    if (typeof event.data === "string") void session.sendCtrl(event.data).catch(console.error);
  };
  await session.start();

  const rebuild = async () => {
    currentPackage = value("--package") ? resolve(value("--package")!) : await buildPackage(value("--app") ?? "3ds-demo");
    await pushWithClient(await session.requireClient(), currentPackage);
  };
  // The session reconnects once the new process is up.
  // The session reconnects once the new process is up; the guest is then
  // settled over that connection, since the console takes one client.
  const reinstall = async () => {
    if (!native) throw new Error("this Runtime predates .3dsx install; use install --ftp once");
    const build = await nativeBuild();
    const reconnected = new Promise<PocketRuntimeClient>((resolveClient) =>
      session.once("reconnect", (client: PocketRuntimeClient) => resolveClient(client)));
    await installWithClient(await session.requireClient(), build.path, nativeName(build), true);
    await settleGuest(await reconnected, build);
  };
  if (!has("--no-push")) await rebuild();

  console.log(`panel: ${server.panelUrl}`);
  console.log("keys: r rebuild+push · i install .3dsx+restart · s screenshot · o open panel · q quit");
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    session.close();
    socket.close();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk: Buffer) => {
      const key = chunk.toString();
      if (key === "q" || key === "\x03") cleanup();
      if (key === "r") void rebuild().catch((error) => console.error(String(error)));
      if (key === "i") void reinstall().catch((error) => console.error(String(error)));
      if (key === "s") void session.sendCtrl({ t: "screenshot" }).catch(console.error);
      if (key === "o") void $`open ${server.panelUrl}`.nothrow().quiet();
    });
  }
  await new Promise(() => {});
}

try {
  if (command !== "discover") await guardDeviceCommand("3ds:wire");
  if (command === "pair") await pair();
  else if (command === "discover") await discoverCommand();
  else if (command === "push") await push();
  else if (command === "install") await install();
  else if (command === "launch") await launchCommand();
  else if (command === "probe") await probe();
  else await dev();
} catch (error) {
  console.error(`3ds-dev: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
