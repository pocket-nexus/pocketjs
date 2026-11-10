// Pocket Link 2 end to end on the 3DS program (docs/POCKET-LINK.md). One
// Azahar process boots the Link Channel demo with pairing files on its SD
// card and links to the reference Hub endpoint running in this process:
// the handshake, runtime.status and runtime.apps, the applet channel
// (request, response stream, event stream, cancel, the daemon's request and
// events), a screenshot, DevTools eval and log lines, a catalog fetch and an
// install into another slot, a push of a changed package, and a switch to
// the installed app.
//
// The development connection runs beside the link in this build: the script
// also checks that it still answers discovery.

import { $ } from "bun";
import { evidenceDirectory } from "./build.ts";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { POCKET_SECTION, decodePocketPackage, encodePocketPackage } from "../../contracts/spec/pocket-package.ts";
import { pocketPackageFooterHash } from "../../contracts/spec/pocket-runtime-wire.ts";
import { discoverPocketRuntimes } from "../../tools/3ds-runtime-client.ts";
import { LinkHub, MemoryStore, directoryStorage, type HubDevice, type HubOffer } from "../../tools/pocket-link/v2/hub.ts";
import { LINK2_BEACON_PORT } from "../../contracts/spec/link2.ts";
import { LINK_CHANNEL_APP, linkChannelDaemon } from "../../apps/link-channel/daemon.ts";
import { fixtureFetch, patternBytes } from "../../apps/link-channel/http-fixture.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const OUT = evidenceDirectory(ROOT, "azahar-link2");
const FIXTURE_HOME = join(OUT, "home");
const USER_DIR = join(FIXTURE_HOME, "Library/Application Support/Azahar");
const CONFIG = join(USER_DIR, "config/qt-config.ini");
const LINK_DIR = join(USER_DIR, "sdmc/pocketjs/link");
const RUNTIME_DIR = join(USER_DIR, "sdmc/pocketjs/runtime");
const CONSOLE_LOG = join(OUT, "azahar-console.log");
const azaharApp = process.env.AZAHAR || "/Applications/Azahar.app";
const azaharBinary = join(azaharApp, "Contents/MacOS/azahar");
const sourceConfig = process.env.AZAHAR_CONFIG || join(homedir(), "Library/Application Support/Azahar/config/qt-config.ini");
const sourceUserDir = sourceConfig.replace(/\/config\/[^/]+$/, "");
const timeoutMs = Number(process.env.E2E_AZAHAR_TIMEOUT_MS ?? 60_000);
const devKey = Uint8Array.from({ length: 32 }, (_, index) => index * 5 + 9);
const DEMO_APP = "dev.pocket-nexus.3ds-demo";
const DEMO_OUTPUT = "pocket3ds-demo-main";

let passed = 0;
function pass(message: string): void {
  passed += 1;
  console.log(`PASS ${message}`);
}

function fail(message: string): never {
  console.error(`FAIL 3DS Pocket Link 2: ${message}`);
  process.exit(1);
}

if (process.platform !== "darwin") fail("the Azahar Link 2 E2E is macOS-only");
if (!existsSync(azaharBinary)) fail(`Azahar not found at ${azaharApp}`);
if (!existsSync(sourceConfig)) fail(`Azahar config not found at ${sourceConfig}`);

function setConfig(config: string, key: string, value: string): string {
  const assignment = new RegExp(`^${key}=.*$`, "gm");
  if ((config.match(assignment)?.length ?? 0) !== 1) throw new Error(`qt-config.ini does not carry exactly one ${key}`);
  let next = config.replace(new RegExp(`^${key}=.*$`, "m"), () => `${key}=${value}`);
  next = new RegExp(`^${key}\\\\default=.*$`, "m").test(next)
    ? next.replace(new RegExp(`^${key}\\\\default=.*$`, "m"), () => `${key}\\default=false`)
    : next.replace(new RegExp(`^${key}=.*$`, "m"), () => `${key}=${value}\n${key}\\default=false`);
  return next;
}

function writeFixture(): void {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(USER_DIR, "config"), { recursive: true });
  mkdirSync(join(LINK_DIR, "companions"), { recursive: true });
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
  writeFileSync(join(RUNTIME_DIR, "dev.key"), `${Buffer.from(devKey).toString("hex")}\n`);
}

function killEmulator(): void {
  Bun.spawnSync(["pkill", "-9", "-f", azaharBinary], { stdout: "ignore", stderr: "ignore" });
}

function launch(rom: string): void {
  killEmulator();
  const result = Bun.spawnSync(
    ["open", "-n", "-a", azaharApp, "--env", `HOME=${FIXTURE_HOME}`, "--stdout", CONSOLE_LOG, "--stderr", CONSOLE_LOG, "--args", rom],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
}

async function until<T>(read: () => T | null | undefined | false, what: string, limit = timeoutMs): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started > limit) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

function hexHash(bytes: Uint8Array): string {
  return pocketPackageFooterHash(bytes).toString(16).padStart(16, "0");
}

function withProbe(good: Uint8Array, marker: string): Uint8Array {
  const value = decodePocketPackage(good);
  return encodePocketPackage({
    manifest: value.manifest,
    variants: value.variants.map((variant) => ({
      ...variant,
      sections: variant.sections.map((section) => section.kind === POCKET_SECTION.js
        ? { ...section, bytes: new Uint8Array([...new TextEncoder().encode(`globalThis.__linkProbe=${JSON.stringify(marker)};\n`), ...section.bytes]) }
        : section),
    })),
  });
}

/** The `value` of an evalResult line, as the shim printed it. */
function evalValue(result: unknown): string {
  return String((result as { value?: unknown } | null)?.value ?? "");
}

function fnv(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i]!, 0x01000193);
  return hash >>> 0;
}

let hub: LinkHub | null = null;
try {
  for (const app of ["link-channel", "3ds-demo"]) {
    const build = await $`bun tools/3ds.ts ${app}`.cwd(ROOT).quiet().nothrow();
    if (build.exitCode !== 0) throw new Error(`build of ${app} failed\n${build.stdout}${build.stderr}`);
  }
  const rom = join(ROOT, "dist/3ds/link-channel.3dsx");
  const good = new Uint8Array(readFileSync(join(ROOT, "dist/3ds/link-channel.pocket")));
  const demo = new Uint8Array(readFileSync(join(ROOT, `dist/3ds/${DEMO_OUTPUT}.pocket`)));
  writeFixture();

  const { daemon, seen } = linkChannelDaemon();
  const offers: HubOffer[] = [{
    id: DEMO_APP,
    title: "PocketJS: 3DS Dual Screen",
    version: "0.1.0",
    output: DEMO_OUTPUT,
    hash: hexHash(demo),
    bytes: demo.length,
    summary: "The dual-screen demo",
    read: () => demo,
  }];
  const devices: HubDevice[] = [];
  let apps: { id: string; output: string; hash: string; home?: boolean }[] = [];
  const devtools: string[] = [];
  const fetched: string[] = [];
  hub = new LinkHub({
    name: "E2E Hub",
    store: new MemoryStore(),
    port: 0,
    beaconTargets: [{ address: "127.0.0.1", port: LINK2_BEACON_PORT }],
    catalog: () => offers,
    // The worker's origin (apps/link-channel/http-fixture.ts), answered without a socket.
    fetch: fixtureFetch((line) => fetched.push(line)),
    daemons: (app) => (app === LINK_CHANNEL_APP ? daemon : null),
    keepScreenshots: true,
    onDevice: (device) => {
      devices.push(device);
      device.onApps = (rows) => (apps = rows);
      device.onDevtoolsLine = (line) => devtools.push(line);
    },
  });
  const port = await hub.listen();
  hub.start();

  // The setup writes device.txt and this Hub's key file onto the card (§3.2).
  const setup = await hub.setup(directoryStorage(LINK_DIR), { kind: "card", addresses: ["127.0.0.1"] }, port);
  if (setup.failed || !setup.deviceId) throw new Error(`the setup failed: ${JSON.stringify(setup)}`);
  pass(`setup wrote the pairing of device ${setup.deviceId} for port ${port}`);

  launch(rom);
  const device = await until(() => devices[0], "the device's link");
  if (device.id !== setup.deviceId || device.target !== "3ds-dev" || device.hostAbi !== POCKET_BINDING_GENERATION) {
    throw new Error(`wrong identity: ${JSON.stringify({ id: device.id, target: device.target, hostAbi: device.hostAbi })}`);
  }
  pass(`linked: ${device.name} (${device.model}), interface version ${device.hostAbi}`);

  const status = await device.runtimeStatus();
  if (status.target !== "3ds-dev" || status.app?.id !== LINK_CHANNEL_APP || typeof status.frame !== "number") {
    throw new Error(`wrong runtime.status: ${JSON.stringify(status)}`);
  }
  pass(`runtime.status: phase ${status.phase}, app ${status.app.id}, frame ${status.frame}`);

  await until(() => apps.some((row) => row.id === LINK_CHANNEL_APP && row.home === true), "runtime.apps with the home row");
  pass(`runtime.apps: ${apps.length} row(s), the launcher's own with home`);

  // The applet channel: the demo's script against its daemon.
  const report = await until(() => seen.report, "the demo applet's report over its channel", 30_000) as Record<string, any>;
  const blob = report.blob as { received: number; hash: number; trailer: { bytes: number; hash: number } };
  if (JSON.stringify(report.echo) !== JSON.stringify({ echo: "hello" })) throw new Error(`wrong echo: ${JSON.stringify(report.echo)}`);
  if (blob.received !== 48_000 || blob.hash !== seen.blobHash || blob.trailer.bytes !== 48_000) throw new Error(`wrong response stream: ${JSON.stringify(blob)} against ${seen.blobHash}`);
  const note = new Uint8Array(3000);
  for (let i = 0; i < note.length; i++) note[i] = (i * 7) & 0xff;
  await until(() => seen.note, "the event stream toward the daemon", 10_000);
  if (seen.note!.bytes !== 3000 || seen.note!.hash !== fnv(note)) throw new Error(`wrong event stream: ${JSON.stringify(seen.note)}`);
  if (report.cancelled !== "cancelled") throw new Error(`the cancelled request ended as ${JSON.stringify(report.cancelled)}`);
  await until(() => seen.sum, "the daemon's request answered by the applet", 10_000);
  if (JSON.stringify(seen.sum) !== JSON.stringify({ sum: 42 })) throw new Error(`wrong reply from the applet: ${JSON.stringify(seen.sum)}`);
  if (seen.generation < 1 || typeof report.ticks !== "number") throw new Error(`wrong channel facts: ${JSON.stringify({ generation: seen.generation, ticks: report.ticks })}`);
  pass(`applet channel generation ${seen.generation}: request, a 48,000-byte response stream, a 3,000-byte event stream, cancel, the daemon's request, ${report.ticks} tick event(s)`);

  // The applet's worker fetched through the link: Hub performed the request.
  await until(() => seen.http?.startsWith("200"), `the worker's net.http outcome`, 60_000).catch((error) => {
    throw new Error(`${(error as Error).message}; last ${JSON.stringify(seen.http)}, Hub fetched ${JSON.stringify(fetched)}`);
  });
  // Five requests: a small GET, a body of several frames, a POST with a body, one the worker
  // cancels (its request ends `unknown`, -3: the origin was still working) and one that
  // outlives its own timeout.
  const expected = [
    "200 14 hello from Hub",
    `big 200 100000 ${fnv(patternBytes(100_000)).toString(16)}`,
    `post 200 POST 700 ${fnv(new TextEncoder().encode("p".repeat(700))).toString(16)}`,
    "cancel -3",
    "timeout -3",
  ].join(" | ");
  if (seen.http !== expected || fetched[0] !== `${LINK_CHANNEL_APP} GET http://link-channel.test/hello?from=worker`) {
    throw new Error(`wrong net.http: ${JSON.stringify(seen.http)}, expected ${JSON.stringify(expected)}, for ${JSON.stringify(fetched)}`);
  }
  pass(`net.http from the worker: ${fetched[0]} gave ${seen.http}`);

  const shot = await device.screenshot();
  const [top, bottom] = shot.surfaces;
  if (top?.width !== 400 || top.height !== 240 || bottom?.width !== 320 || bottom.height !== 240 || shot.pixels.length !== 400 * 240 * 3 + 320 * 240 * 3) {
    throw new Error(`wrong screenshot: ${JSON.stringify(shot.surfaces)} ${shot.pixels.length} bytes`);
  }
  if (shot.pixels.every((byte) => byte === shot.pixels[0])) throw new Error("the screenshot is one flat colour");
  writeFileSync(join(OUT, "screens.bgr8"), shot.pixels);
  pass(`runtime.screenshot: frame ${shot.frame}, ${shot.pixels.length} bytes in ${shot.format}`);

  await until(() => device.devtoolsOpen, "the DevTools stream", 10_000);
  device.listen(true);
  const evaluated = await device.eval('console.log("Azahar link2 E2E"); ({target: globalThis.ui.__host, abi: globalThis.ui.__hostAbi, channel: typeof globalThis.link.channel})');
  if (!evalValue(evaluated).includes("3ds-dev") || !evalValue(evaluated).includes("object")) throw new Error(`wrong eval: ${JSON.stringify(evaluated)}`);
  await until(() => devtools.some((line) => line.includes('"t":"log"') && line.includes("Azahar link2 E2E")), "the guest's log line on the DevTools stream", 10_000);
  await device.logs(true);
  pass("DevTools over the link: eval in the guest, and its console line");

  // The guest reads Hub's offer and installs one app into its own slot.
  const asked = await device.eval("globalThis.link.catalog()");
  const catalogId = Number(evalValue(asked));
  if (!(catalogId > 0)) throw new Error(`link.catalog() gave ${JSON.stringify(asked)}`);
  // The shim prints a short preview of a value, so the guest keeps the
  // link's events and each eval asks for the few facts the check needs.
  const DRAIN = "(globalThis.__linkEvents = (globalThis.__linkEvents || []).concat(JSON.parse(globalThis.link.poll() || '[]')))";
  const pollUntil = async (select: string, needle: string, what: string): Promise<string> => {
    const started = Date.now();
    let last = "";
    while (Date.now() - started < 30_000) {
      last = evalValue(await device.eval(`${DRAIN}, (${select})`));
      if (last.includes(needle)) return last;
      await Bun.sleep(100);
    }
    throw new Error(`timed out waiting for ${what}; saw ${last}`);
  };
  const catalog = await pollUntil(
    "globalThis.__linkEvents.filter(e => e.t === 'catalog').flatMap(e => e.apps.map(a => a.id + '@' + a.output)).join(',')",
    `${DEMO_APP}@${DEMO_OUTPUT}`,
    "the catalog event",
  );
  const installAsked = await device.eval(`globalThis.link.install(${JSON.stringify(DEMO_APP)})`);
  if (!(Number(evalValue(installAsked)) > 0)) throw new Error(`link.install gave ${JSON.stringify(installAsked)}`);
  await pollUntil(
    "globalThis.__linkEvents.filter(e => e.t === 'install.done' || e.t === 'error').map(e => e.t + ':' + (e.hash || e.message)).join(',')",
    `install.done:${hexHash(demo)}`,
    "install.done with the package's hash",
  );
  await until(() => apps.some((row) => row.id === DEMO_APP && row.hash === hexHash(demo)), "runtime.apps with the installed app", 15_000);
  void catalog;
  pass(`catalog and install: ${DEMO_APP} (${demo.length} bytes) committed in its own slot and reported by runtime.apps`);

  // A changed package of the running app replaces it; the channel opens again.
  const before = seen.channels;
  const changed = withProbe(good, "azahar-link2");
  const events: string[] = [];
  const pushed = await device.push(changed, hexHash(changed), (event) => events.push(String((event as { phase?: string }).phase)));
  if ((pushed as { phase?: string }).phase !== "accepted" || (pushed as { app?: { id?: string } }).app?.id !== LINK_CHANNEL_APP) {
    throw new Error(`the push ended as ${JSON.stringify(pushed)}`);
  }
  const probe = await device.eval("globalThis.__linkProbe ?? null");
  if (!evalValue(probe).includes("azahar-link2")) throw new Error(`the pushed guest does not run: ${JSON.stringify(probe)}`);
  await until(() => seen.channels > before, "the pushed guest's channel", 15_000);
  pass(`runtime.push: ${hexHash(changed)} accepted after ${events.join(", ")}; the new guest's channel is generation ${seen.generation}`);

  // The development connection still answers beside the link.
  const dev = await discoverPocketRuntimes({ addresses: ["127.0.0.1"], timeoutMs: 500 });
  if (dev.length !== 1 || dev[0]!.target !== "3ds-dev") throw new Error("the development connection did not answer discovery");
  pass("the development connection answers discovery beside the link");

  // A switch to the installed app through the launcher.
  const switched = await device.launch({ app: DEMO_OUTPUT });
  if ((switched as { phase?: string }).phase !== "switching") throw new Error(`runtime.launch gave ${JSON.stringify(switched)}`);
  const started = Date.now();
  let now = await device.runtimeStatus();
  while (now.app?.id !== DEMO_APP && Date.now() - started < 20_000) {
    await Bun.sleep(200);
    now = await device.runtimeStatus();
  }
  if (now.app?.id !== DEMO_APP) throw new Error(`the device still runs ${now.app?.id}`);
  pass(`runtime.launch: switched to ${now.app.id}`);

  console.log(`Azahar Pocket Link 2 E2E: ${passed} passed, 0 failed`);
} catch (error) {
  console.error(`FAIL 3DS Pocket Link 2: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  hub?.stop();
  killEmulator();
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}
