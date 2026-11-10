#!/usr/bin/env bun
// The command line of the Pocket Link 2 reference Hub (docs/POCKET-LINK.md):
// it writes a pairing onto a device, then drives the device over the link
// with the endpoint of hub.ts. It stands alone until Pocket Hub's own
// endpoint exists.
//
//   bun tools/pocket-link/v2/cli.ts <command> [arguments] [options]
//
// `setup`, `devices` and `forget` work on the store. Every other command
// needs the link: it starts the endpoint (TCP 8628, or an ephemeral port
// when that is taken, and a beacon a second), waits for the paired device to
// connect, acts and leaves. `serve` stays, and while one runs for a store
// the other commands go through it (a socket in the store's folder), because
// a device links to one Hub at a time.
//
// Exit codes: 0 done; 1 the device, the storage or a file answered an
// error; 2 the command line is wrong; 3 no device linked within the wait;
// 4 a setup that is not confirmed.

import { createSocket } from "node:dgram";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server, type Socket, connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { basename, join, resolve } from "node:path";
import { LINK2_BEACON_PORT, LINK2_PORT, type Link2LogEvent } from "../../../contracts/spec/link2.ts";
import { NET_METHODS, type NetMethod } from "../../../contracts/spec/net.ts";
import { encodePNG } from "../../png.ts";
import { NetFailure, adoptSystemProxy, performNet } from "../fetch.ts";
import { type DaemonInfo, type LinkDaemon, loadDaemon, parseDaemonSpec } from "./daemon.ts";
import { ftpStorage } from "./ftp-storage.ts";
import { type BeaconTarget, type HttpFetch, type HubDevice, LinkHub, type Refusal, type Screenshot, type SetupResult, directoryStorage, lanBeaconTargets } from "./hub.ts";
import { FolderOffer, packageFooter } from "./offer.ts";
import { type Json, LinkError } from "./peer.ts";
import { isLinkId } from "./protocol.ts";
import { LinkStore, linkHome } from "./store.ts";

export const EXIT = { ok: 0, failed: 1, usage: 2, noDevice: 3, setup: 4 } as const;

const USAGE = `Pocket Link 2 reference Hub

  setup --host <ip> [--ftp-port 5000]   write this Hub's pairing onto a device over ftpd
  setup --card <dir>                    the same onto the mounted SD card
  devices                               the devices this Hub holds a pairing for
  forget <device id>                    drop a device's record; its link closes

  status                                the program's runtime.status
  apps                                  the applets installed on the device
  push <file.pocket>                    push a package to the running program
  install <file.3dsx> [--name <name.3dsx>] [--no-launch]
  launch <name.3dsx | applet id>        start a .3dsx, or switch to an installed applet
  shot [--out <file.png>]               both screens as one PNG
  eval <code>                           evaluate in the running applet
  logs [--follow] [--seconds <n>]       the program's log lines; 5 s without --follow

  serve [--apps <dir>]… [--daemon <applet id>=<module.ts>]… [--allow-private] [--no-http]
        [--resolve <host>=<address>:<port>]… [--panel [--panel-port 8130]]
                                        stay linked: the catalog of the folders, net.http,
                                        applet channels to the named daemon modules, log lines;
                                        --resolve sends an applet's requests for <host> to a
                                        server of this computer's choosing, as curl's does;
                                        --panel serves the Pocket DevTools panel and carries
                                        its lines to and from the running applet

options
  --home <dir>            the store ($POCKETJS_LINK_HOME, else ~/.pocketjs/link)
  --name <text>           this Hub's display name (stored; 40 bytes at most)
  --port <n>              the link port (8628; an ephemeral port when it is taken; 0 asks for one)
  --unicast <ip[:port]>   one more beacon target (repeatable)
  --address <ip>          this computer's address for a pairing written with --card (repeatable)
  --link-dir <path>       the link directory on the device's storage (pocketjs/link)
  --device <id>           the device, when several are paired
  --wait <seconds>        how long a command waits for the device to link (20)
  --json                  answers as JSON

exit codes: 0 done, 1 an error answer, 2 usage, 3 no device linked, 4 setup not confirmed`;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(["--home", "--name", "--port", "--unicast", "--address", "--link-dir", "--device", "--wait", "--host", "--ftp-port", "--card", "--out", "--seconds", "--apps", "--daemon", "--panel-port", "--resolve"]);
const BOOLEAN_FLAGS = new Set(["--json", "--follow", "--no-launch", "--allow-private", "--no-http", "--panel", "--help"]);

export class UsageError extends Error {}

export interface Parsed {
  command: string;
  positional: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

export function parseArguments(argv: readonly string[]): Parsed {
  const parsed: Parsed = { command: "", positional: [], values: new Map(), flags: new Set() };
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index];
    if (VALUE_FLAGS.has(word)) {
      const value = argv[++index];
      if (value === undefined) throw new UsageError(`${word} takes a value`);
      parsed.values.set(word, [...(parsed.values.get(word) ?? []), value]);
    } else if (BOOLEAN_FLAGS.has(word)) parsed.flags.add(word);
    else if (word.startsWith("--")) throw new UsageError(`unknown option ${word}`);
    else if (parsed.command === "") parsed.command = word;
    else parsed.positional.push(word);
  }
  return parsed;
}

const one = (parsed: Parsed, flag: string): string | undefined => parsed.values.get(flag)?.at(-1);
function integerOption(parsed: Parsed, flag: string, least: number, most: number, otherwise: number): number {
  const text = one(parsed, flag);
  if (text === undefined) return otherwise;
  const value = Number(text);
  if (!/^\d+$/.test(text) || value < least || value > most) throw new UsageError(`${flag} is a whole number from ${least} to ${most}`);
  return value;
}
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function unicastTargets(parsed: Parsed): BeaconTarget[] {
  return (parsed.values.get("--unicast") ?? []).map((text) => {
    const [address, port = String(LINK2_BEACON_PORT)] = text.split(":");
    if (!IPV4.test(address) || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new UsageError(`--unicast takes an IPv4 address and an optional :port, not ${text}`);
    return { address, port: Number(port) };
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const describeError = (error: unknown): string =>
  error instanceof LinkError ? (error.message !== error.code ? `${error.code}: ${error.message}` : error.code) : error instanceof Error ? error.message : String(error);

function fields(object: Json, io: Io, indent = ""): void {
  for (const [key, value] of Object.entries(object)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      io.out(`${indent}${key}:`);
      fields(value as Json, io, `${indent}  `);
    } else io.out(`${indent}${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// This computer's addresses, for a pairing written onto a mounted card (§3.2)
// ---------------------------------------------------------------------------

/** The address of the interface the default route leaves by. A UDP socket that
 *  "connects" sends nothing; the system picks its local address. */
function routeAddress(): Promise<string | null> {
  return new Promise((done) => {
    const socket = createSocket("udp4");
    const end = (address: string | null) => {
      try {
        socket.close();
      } catch {}
      done(address);
    };
    socket.once("error", () => end(null));
    socket.connect(9, "192.0.2.1", () => {
      try {
        end(socket.address().address);
      } catch {
        end(null);
      }
    });
  });
}

/** Every IPv4 address of this computer's interfaces, the default route's first. */
export async function ownAddresses(): Promise<string[]> {
  const all = Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((entry) => !entry.internal && entry.family === "IPv4")
    .map((entry) => entry.address);
  const first = await routeAddress();
  return [...new Set([...(first !== null && all.includes(first) ? [first] : []), ...all])];
}

// ---------------------------------------------------------------------------
// The running Hub of one command
// ---------------------------------------------------------------------------

type LogListener = (device: HubDevice, event: Link2LogEvent) => void;

interface Session {
  store: LinkStore;
  hub: LinkHub;
  /** True while the endpoint listens: the commands that need the link can run. */
  online: boolean;
  /** `serve` keeps logs on and prints them itself. */
  serving: boolean;
  refusals: Refusal[];
  logListeners: Set<LogListener>;
  linkListeners: Set<(device: HubDevice) => void>;
}

interface Invocation {
  session: Session;
  args: Parsed;
  io: Io;
  /** Relative paths of the command line are the caller's. */
  cwd: string;
  /** Ends a command that runs until told to stop (`logs --follow`). */
  signal: AbortSignal;
}

function openSession(args: Parsed, options: { features?: string[]; serving?: boolean; hub?: Partial<ConstructorParameters<typeof LinkHub>[0]> } = {}): Session {
  const store = new LinkStore(one(args, "--home") ?? linkHome(), { name: one(args, "--name") });
  const name = one(args, "--name");
  if (name !== undefined && name !== store.name) store.setName(name);
  const session: Session = { store, hub: null as unknown as LinkHub, online: false, serving: options.serving ?? false, refusals: [], logListeners: new Set(), linkListeners: new Set() };
  const portText = one(args, "--port");
  session.hub = new LinkHub({
    name: store.name,
    store,
    port: portText === undefined ? undefined : integerOption(args, "--port", 0, 65535, LINK2_PORT),
    features: options.features ?? ["runtime", "runtime.native", "devtools", "apps"],
    beaconTargets: lanBeaconTargets({ store, unicast: unicastTargets(args) }),
    onRefusal: (refusal) => {
      session.refusals.push(refusal);
      if (session.refusals.length > 32) session.refusals.shift();
    },
    onDevice: (device) => {
      device.onLog = (event) => {
        for (const listener of session.logListeners) listener(device, event);
      };
      for (const listener of [...session.linkListeners]) listener(device);
    },
    ...options.hub,
  });
  return session;
}

async function goOnline(session: Session): Promise<void> {
  await session.hub.listen();
  session.hub.start(50);
  session.online = true;
}

async function closeSession(session: Session): Promise<void> {
  if (!session.online) return;
  session.online = false;
  session.hub.stop();
  // The CLOSE frames leave before the process does.
  await new Promise((done) => setTimeout(done, 120));
}

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
  });

const waitMs = (args: Parsed) => integerOption(args, "--wait", 0, 3600, 20) * 1000;

/** The device id a command acts on, or the line that says why there is none. */
function targetDevice(session: Session, args: Parsed): { id: string } | { error: string; exit: number } {
  const paired = session.store.describe().filter((record) => record.paired);
  const named = one(args, "--device");
  if (named !== undefined) {
    if (!isLinkId(named)) return { error: "--device takes a device id: 16 lowercase hex digits (`devices` lists them)", exit: EXIT.usage };
    if (!paired.some((record) => record.id === named)) return { error: `this Hub holds no pairing for ${named}`, exit: EXIT.noDevice };
    return { id: named };
  }
  if (paired.length === 1) return { id: paired[0].id };
  if (paired.length === 0) return { error: "this Hub holds no pairing: run `setup --host <ip>` while ftpd runs on the device, or `setup --card <dir>`", exit: EXIT.noDevice };
  return { error: `several devices are paired; name one with --device:\n${paired.map((record) => `  ${record.id}  ${record.name || "-"}`).join("\n")}`, exit: EXIT.usage };
}

function waitAdvice(session: Session, id: string, seconds: number): string[] {
  const lines = [
    `no device linked within ${seconds} s. Check:`,
    "  - the device's program is running, and it is a program that speaks version 2 of the link",
    "  - the device holds this Hub's pairing: `setup --host <ip>` while ftpd runs on it, or `setup --card <dir>`",
    "  - another Hub may hold the device's link (a `serve` of another store, or Pocket Hub): a device links to one Hub at a time",
  ];
  const seen = new Set<string>();
  for (const refusal of session.refusals) {
    let line: string;
    if (refusal.kind === "closed" && refusal.code === "auth") line = `  the device at ${refusal.address} rejected this Hub's proof: its key file holds another key; run the setup again`;
    else if (refusal.kind === "refused" && refusal.code === "unknown_device") line = `  a device ${refusal.device ?? ""} at ${refusal.address} asked for this Hub, which holds no pairing for it${refusal.device !== id ? "" : "; run the setup again"}`;
    else line = `  a connection from ${refusal.address} ended before ready: ${refusal.kind} ${refusal.code}`;
    if (!seen.has(line)) lines.push(line);
    seen.add(line);
  }
  return lines;
}

/** The linked device of a command, waiting for it to connect; null after the advice was printed. */
async function linkedDevice(call: Invocation, ms = waitMs(call.args)): Promise<HubDevice | number> {
  const { session, io } = call;
  const target = targetDevice(session, call.args);
  if ("error" in target) {
    io.err(target.error);
    return target.exit;
  }
  const end = Date.now() + ms;
  for (;;) {
    const device = session.hub.devices.get(target.id);
    if (device !== undefined && device.closed === null) return device;
    if (Date.now() >= end || call.signal.aborted) break;
    await pause(25, call.signal);
  }
  for (const line of waitAdvice(session, target.id, Math.round(ms / 1000))) io.err(line);
  return EXIT.noDevice;
}

/** After a reply with `phase: "launching"`: the device exits into the file and links again. */
async function linkedAgain(call: Invocation, before: HubDevice): Promise<HubDevice | null> {
  const end = Date.now() + Math.max(waitMs(call.args), 1000);
  while (Date.now() < end && !call.signal.aborted) {
    const device = call.session.hub.devices.get(before.id);
    if (device !== undefined && device !== before && device.closed === null) return device;
    await pause(25, call.signal);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commands on the store
// ---------------------------------------------------------------------------

function reportSetup(result: SetupResult, io: Io, hubName: string): number {
  const device = result.deviceId ?? "(no device id)";
  if (result.failed) {
    const step = result.failedAt === null ? "" : ` (${result.failedAt.op} ${"path" in result.failedAt ? result.failedAt.path : `${result.failedAt.from} to ${result.failedAt.to}`})`;
    io.err(`setup not confirmed for device ${device}: ${result.message}${step}`);
    if (result.outcome !== "failed-read" && result.outcome !== "eight-computers") io.err("the device shows as \"setup not confirmed\" until it links or a setup completes; run the setup again");
    return EXIT.setup;
  }
  io.out(`device ${device}: ${result.message}`);
  io.out(`start the program on the device; it links to "${hubName}" by itself`);
  return EXIT.ok;
}

async function setup(call: Invocation): Promise<number> {
  const { args, io, session } = call;
  const host = one(args, "--host");
  const card = one(args, "--card");
  if ((host === undefined) === (card === undefined)) throw new UsageError("setup takes --host <ip> (ftpd runs on the device) or --card <dir> (the mounted SD card)");
  const linkDir = one(args, "--link-dir") ?? "pocketjs/link";
  const port = session.online ? session.hub.port : integerOption(args, "--port", 0, 65535, LINK2_PORT) || LINK2_PORT;
  let result: SetupResult;
  if (host !== undefined) {
    const storage = ftpStorage({ host, port: integerOption(args, "--ftp-port", 1, 65535, 5000), root: linkDir });
    let localAddress: string;
    try {
      localAddress = await storage.localAddress();
    } catch (error) {
      io.err(`${describeError(error)}; start ftpd on the device (it shows its address and port) and try again`);
      return EXIT.setup;
    }
    result = await session.hub.setup(storage, { kind: "ftp", localAddress }, port);
  } else {
    const root = resolve(call.cwd, card as string);
    if (!existsSync(root)) {
      io.err(`${root} is not there: name the folder the SD card is mounted at`);
      return EXIT.setup;
    }
    const named = args.values.get("--address") ?? [];
    for (const address of named) if (!IPV4.test(address)) throw new UsageError(`--address takes an IPv4 address, not ${address}`);
    const addresses = named.length > 0 ? named : await ownAddresses();
    if (addresses.length === 0) io.err("this computer has no network address now: the pairing is written without one, and the device finds this Hub by its beacon");
    result = await session.hub.setup(directoryStorage(join(root, linkDir)), { kind: "card", addresses }, port);
  }
  if (args.flags.has("--json")) io.out(JSON.stringify({ outcome: result.outcome, failed: result.failed, device: result.deviceId, message: result.message }));
  return reportSetup(result, args.flags.has("--json") ? { out() {}, err: io.err } : io, session.store.name);
}

function devices(call: Invocation): number {
  const { session, io, args } = call;
  const rows = session.store.describe().map((record) => ({ ...record, linked: session.online && session.hub.devices.get(record.id)?.closed === null }));
  if (args.flags.has("--json")) {
    io.out(JSON.stringify({ hub: { id: session.store.id, name: session.store.name }, devices: rows }));
    return EXIT.ok;
  }
  io.out(`Hub ${session.store.id} "${session.store.name}"`);
  if (rows.length === 0) io.out("no device is paired");
  for (const row of rows) {
    const notes = [row.linked ? "linked" : "", row.paired ? "" : "no key", row.unconfirmed ? "setup not confirmed" : ""].filter((note) => note !== "");
    const seen = row.lastSeen > 0 ? new Date(row.lastSeen).toISOString() : "never linked";
    io.out(`${row.id}  ${row.name || "-"}  ${row.model || "-"}  ${row.target || "-"}  ${row.lastAddress || "-"}  ${seen}${notes.length > 0 ? `  [${notes.join(", ")}]` : ""}`);
  }
  return EXIT.ok;
}

function forget(call: Invocation): number {
  const id = call.args.positional[0];
  if (id === undefined || !isLinkId(id)) throw new UsageError("forget takes a device id: 16 lowercase hex digits (`devices` lists them)");
  if (call.session.store.get(id) === undefined) {
    call.io.err(`this Hub holds no record of ${id}`);
    return EXIT.failed;
  }
  call.session.hub.forget(id);
  call.io.out(`forgot ${id}; the device keeps this Hub's key file until a setup replaces it or the owner removes this computer on the device`);
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// Commands over the link
// ---------------------------------------------------------------------------

async function status(call: Invocation, device: HubDevice): Promise<number> {
  const answer = (await device.runtimeStatus()) as unknown as Json;
  if (call.args.flags.has("--json")) call.io.out(JSON.stringify({ device: device.id, name: device.name, model: device.model, address: device.peer.carrier.remoteAddress, status: answer }));
  else {
    call.io.out(`${device.id} "${device.name}" ${device.model} at ${device.peer.carrier.remoteAddress}, payload limit ${device.peer.limit}`);
    fields(answer, call.io, "  ");
  }
  return EXIT.ok;
}

async function apps(call: Invocation, device: HubDevice): Promise<number> {
  if (!device.peer.inUse("apps")) {
    call.io.err("the device does not report its applets (the `apps` group is not in use)");
    return EXIT.failed;
  }
  // The report follows `ready`; a device that links for this command sends it within the first frames.
  let reported = device.apps.length > 0 || call.session.serving;
  const before = device.onApps;
  device.onApps = (list) => {
    reported = true;
    before?.(list);
  };
  for (const end = Date.now() + 3000; !reported && Date.now() < end && !call.signal.aborted; ) await pause(25, call.signal);
  device.onApps = before;
  if (call.args.flags.has("--json")) call.io.out(JSON.stringify({ device: device.id, apps: device.apps }));
  else if (device.apps.length === 0) call.io.out("no applet is installed");
  else for (const app of device.apps) call.io.out(`${app.id}  ${app.output}  ${app.version || "-"}  ${app.hash}${app.home ? "  [home]" : ""}`);
  return EXIT.ok;
}

function readFile(call: Invocation, path: string | undefined, what: string): Uint8Array | null {
  if (path === undefined) throw new UsageError(`${call.args.command} takes ${what}`);
  try {
    return new Uint8Array(readFileSync(resolve(call.cwd, path)));
  } catch (error) {
    call.io.err(`${path}: ${(error as Error).message}`);
    return null;
  }
}

async function push(call: Invocation, device: HubDevice): Promise<number> {
  const file = readFile(call, call.args.positional[0], "a .pocket file");
  if (file === null) return EXIT.failed;
  const footer = packageFooter(file);
  if (footer === null || footer.stored !== footer.computed) {
    call.io.err(`${call.args.positional[0]} is not a whole .pocket package: its footer hash does not match its bytes`);
    return EXIT.failed;
  }
  const json = call.args.flags.has("--json");
  const reply = await device.push(file, footer.stored, (event) => {
    if (!json && typeof event.phase === "string") call.io.out(`… ${event.phase}`);
  });
  if (json) call.io.out(JSON.stringify({ device: device.id, bytes: file.length, ...reply }));
  else {
    const app = reply.app as { id?: string; title?: string } | undefined;
    call.io.out(`pushed ${footer.stored} (${file.length} bytes): ${String(reply.phase ?? "accepted")}${reply.generation !== undefined ? `, generation ${reply.generation}` : ""}${app?.id ? `, running ${app.id}` : ""}`);
  }
  return EXIT.ok;
}

/** What follows a reply that says the device exits into a `.3dsx`. */
async function afterLaunch(call: Invocation, device: HubDevice, reply: Json, what: string): Promise<number> {
  const json = call.args.flags.has("--json");
  if (reply.phase !== "launching") {
    if (json) call.io.out(JSON.stringify({ device: device.id, ...reply }));
    return EXIT.ok;
  }
  if (!json) call.io.out(`the device restarts into ${what}`);
  const again = await linkedAgain(call, device);
  if (json) call.io.out(JSON.stringify({ device: device.id, ...reply, back: again !== null }));
  if (again === null) {
    call.io.err(`${what} was started and the device did not link again within ${Math.round(Math.max(waitMs(call.args), 1000) / 1000)} s`);
    return EXIT.noDevice;
  }
  if (!json) call.io.out(`linked again from ${again.peer.carrier.remoteAddress}`);
  return EXIT.ok;
}

async function install(call: Invocation, device: HubDevice): Promise<number> {
  const path = call.args.positional[0];
  const file = readFile(call, path, "a .3dsx file");
  if (file === null) return EXIT.failed;
  const name = one(call.args, "--name") ?? basename(path as string);
  const launch = !call.args.flags.has("--no-launch");
  const json = call.args.flags.has("--json");
  const reply = await device.nativeInstall(name, file, launch, (event) => {
    if (!json && typeof event.phase === "string") call.io.out(`… ${event.phase}`);
  });
  if (!json) call.io.out(`installed ${String(reply.path ?? name)} (${file.length} bytes): ${String(reply.phase ?? "installed")}`);
  return afterLaunch(call, device, reply, name);
}

async function launch(call: Invocation, device: HubDevice): Promise<number> {
  const what = call.args.positional[0];
  if (what === undefined) throw new UsageError("launch takes the name of a .3dsx under sdmc:/3ds/, or an applet id");
  const reply = await device.launch(what.endsWith(".3dsx") ? { native: what } : { app: what });
  if (!call.args.flags.has("--json") && reply.phase !== "launching") call.io.out(`${what}: ${String(reply.phase ?? "done")}`);
  return afterLaunch(call, device, reply, what);
}

/** A screenshot's surfaces, one under the other, as a PNG. The format is the
 *  PICA target's: B, G, R bytes in rotated column-major order (§6.2). */
export function screenshotPng(shot: Screenshot): { png: Buffer; width: number; height: number } {
  if (shot.format !== "bgr8-rotated") throw new Error(`this tool does not read the screenshot format ${shot.format}`);
  const width = Math.max(0, ...shot.surfaces.map((surface) => surface.width));
  const height = shot.surfaces.reduce((sum, surface) => sum + surface.height, 0);
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 3; index < rgba.length; index += 4) rgba[index] = 255;
  let offset = 0;
  let top = 0;
  for (const surface of shot.surfaces) {
    if (surface.bytes !== surface.width * surface.height * 3 || offset + surface.bytes > shot.pixels.length) throw new Error(`the surface ${surface.name} has the wrong byte count`);
    const left = (width - surface.width) >> 1;
    for (let y = 0; y < surface.height; y++) {
      for (let x = 0; x < surface.width; x++) {
        const source = offset + (x * surface.height + (surface.height - 1 - y)) * 3;
        const destination = ((top + y) * width + left + x) * 4;
        rgba[destination] = shot.pixels[source + 2];
        rgba[destination + 1] = shot.pixels[source + 1];
        rgba[destination + 2] = shot.pixels[source];
      }
    }
    offset += surface.bytes;
    top += surface.height;
  }
  return { png: encodePNG(rgba, width, height), width, height };
}

async function shot(call: Invocation, device: HubDevice): Promise<number> {
  const taken = await device.screenshot();
  const { png, width, height } = screenshotPng(taken);
  const path = resolve(call.cwd, one(call.args, "--out") ?? `3ds-${device.id}-f${taken.frame}.png`);
  writeFileSync(path, png);
  if (call.args.flags.has("--json")) call.io.out(JSON.stringify({ device: device.id, frame: taken.frame, path, width, height, surfaces: taken.surfaces }));
  else call.io.out(`${path}: ${width}x${height}, frame ${taken.frame}`);
  return EXIT.ok;
}

async function evaluate(call: Invocation, device: HubDevice): Promise<number> {
  const code = call.args.positional.join(" ");
  if (code === "") throw new UsageError("eval takes the code to evaluate");
  if (!device.peer.inUse("devtools")) {
    call.io.err("the device offers no DevTools stream (the `devtools` group is not in use)");
    return EXIT.failed;
  }
  for (const end = Date.now() + 5000; !device.devtoolsOpen && Date.now() < end && !call.signal.aborted; ) await pause(25, call.signal);
  if (!device.devtoolsOpen) {
    call.io.err("the device did not open its DevTools stream within 5 s");
    return EXIT.failed;
  }
  const answer = await device.eval(code);
  if (call.args.flags.has("--json")) call.io.out(JSON.stringify({ device: device.id, ok: answer.ok === true, value: answer.value ?? null }));
  else call.io.out(typeof answer.value === "string" ? answer.value : JSON.stringify(answer.value ?? null));
  return answer.ok === true ? EXIT.ok : EXIT.failed;
}

export function logLine(event: Link2LogEvent): string {
  const record = event as unknown as Json;
  const dropped = typeof record.dropped === "number" && record.dropped > 0 ? ` (${record.dropped} lines dropped before this one)` : "";
  return `[${String(record.level ?? "info")}] ${String(record.source ?? "guest")}: ${String(record.text ?? "")}${dropped}`;
}

async function logs(call: Invocation, device: HubDevice): Promise<number> {
  const { session, io, args } = call;
  const json = args.flags.has("--json");
  const listener: LogListener = (from, event) => {
    if (from.id === device.id) io.out(json ? JSON.stringify(event) : logLine(event));
  };
  session.logListeners.add(listener);
  try {
    await device.logs(true);
    if (!json) io.err(args.flags.has("--follow") ? "log lines follow; end with Ctrl-C" : "log lines follow");
    if (args.flags.has("--follow")) await new Promise<void>((done) => (call.signal.aborted ? done() : call.signal.addEventListener("abort", () => done(), { once: true })));
    else await pause(integerOption(args, "--seconds", 1, 3600, 5) * 1000, call.signal);
    // `serve` keeps the lines coming for its own output.
    if (!session.serving && device.closed === null) await device.logs(false).catch(() => {});
  } finally {
    session.logListeners.delete(listener);
  }
  return EXIT.ok;
}

const LINKED: Record<string, (call: Invocation, device: HubDevice) => Promise<number>> = { status, apps, push, install, launch, shot, eval: evaluate, logs };
const STORED: Record<string, (call: Invocation) => number | Promise<number>> = { setup, devices, forget };

/** Runs one command in a session; the answer is its exit code. */
export async function run(call: Invocation): Promise<number> {
  const { args, io } = call;
  try {
    const stored = STORED[args.command];
    if (stored !== undefined) return await stored(call);
    const linked = LINKED[args.command];
    if (linked === undefined) throw new UsageError(args.command === "" ? "no command" : `unknown command ${args.command}`);
    const device = await linkedDevice(call);
    if (typeof device === "number") return device;
    return await linked(call, device);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    io.err(`${args.command}: ${describeError(error)}`);
    return EXIT.failed;
  }
}

// ---------------------------------------------------------------------------
// serve, and the socket the other commands reach it through
// ---------------------------------------------------------------------------

const socketPath = (home: string) => join(home, "serve.sock");

/** `--resolve <host>=<address>:<port>`: where requests for a host go instead of its own address. */
export function parseResolve(spec: string): { host: string; address: string; port: number } | null {
  const match = /^([A-Za-z0-9.-]+)=(\d{1,3}(?:\.\d{1,3}){3}|localhost):(\d{1,5})$/.exec(spec);
  if (match === null) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1].toLowerCase(), address: match[2], port };
}

function netFetch(allowPrivate: boolean, resolves: Map<string, { address: string; port: number }> = new Map(), log: (line: string) => void = () => {}): HttpFetch {
  return async (request, body) => {
    if (!(NET_METHODS as readonly string[]).includes(request.method)) throw new LinkError("invalid_request", `the method ${request.method} is not one net.http carries`);
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new LinkError("invalid_request", "the URL does not parse");
    }
    // This Hub runs no services: the origin Pocket Hub answers itself has nothing behind it here.
    if (url.hostname === "companion.pocket") throw new LinkError("unavailable", "this Hub runs no services");
    // A host named with --resolve goes to the server the owner chose, private address or not.
    const mapped = resolves.get(url.hostname.toLowerCase());
    const target = new URL(url.href);
    if (mapped !== undefined) {
      target.protocol = "http:";
      target.hostname = mapped.address;
      target.port = String(mapped.port);
    }
    const started = Date.now();
    try {
      const response = await performNet(
        { url: target.href, method: request.method as NetMethod, headers: request.headers, timeoutMs: request.timeoutMs, maxBytes: request.maxBytes, body },
        { allowPrivate: allowPrivate || mapped !== undefined },
      );
      log(`net.http: ${request.app} ${request.method} ${request.url} -> ${response.status}, ${response.body.length} bytes in ${Date.now() - started} ms`);
      return { status: response.status, url: mapped !== undefined ? request.url : response.url, headers: Object.entries(response.headers), body: response.body };
    } catch (error) {
      log(`net.http: ${request.app} ${request.method} ${request.url} -> ${error instanceof NetFailure ? error.code : "error"} after ${Date.now() - started} ms`);
      if (error instanceof NetFailure) throw new LinkError(error.code, error.message);
      throw error;
    }
  };
}

/** One command from another process: `{argv, cwd}` on a line, answered with
 *  `{o}` and `{e}` lines and one `{x}`, the exit code. */
function serveCommand(session: Session, socket: Socket, log: (line: string) => void): void {
  let buffer = "";
  let started = false;
  const abort = new AbortController();
  const send = (object: Json) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(object)}\n`);
  };
  socket.on("error", () => abort.abort());
  socket.on("close", () => abort.abort());
  socket.on("data", (chunk) => {
    if (started) return;
    buffer += chunk.toString("utf8");
    const end = buffer.indexOf("\n");
    if (end < 0) return;
    started = true;
    let request: { argv?: unknown; cwd?: unknown };
    try {
      request = JSON.parse(buffer.slice(0, end));
    } catch {
      return void socket.destroy();
    }
    const argv = Array.isArray(request.argv) ? request.argv.filter((word): word is string => typeof word === "string") : [];
    const io: Io = { out: (line) => send({ o: line }), err: (line) => send({ e: line }) };
    let args: Parsed;
    try {
      args = parseArguments(argv);
    } catch (error) {
      io.err((error as Error).message);
      send({ x: EXIT.usage });
      return void socket.end();
    }
    log(`command: ${args.command}`);
    void run({ session, args, io, cwd: typeof request.cwd === "string" ? request.cwd : process.cwd(), signal: abort.signal }).then((code) => {
      send({ x: code });
      socket.end();
    });
  });
}

/** Sends a command to the `serve` of this store. Null when none runs. */
function delegate(home: string, argv: readonly string[], io: Io, signal: AbortSignal): Promise<number | null> {
  const path = socketPath(home);
  if (!existsSync(path)) return Promise.resolve(null);
  return new Promise((done) => {
    const socket = connect(path);
    let buffer = "";
    let code: number | null = null;
    let connected = false;
    socket.on("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify({ argv, cwd: process.cwd() })}\n`);
      signal.addEventListener("abort", () => socket.destroy(), { once: true });
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as { o?: string; e?: string; x?: number };
          if (typeof message.o === "string") io.out(message.o);
          if (typeof message.e === "string") io.err(message.e);
          if (typeof message.x === "number") code = message.x;
        } catch {}
      }
    });
    // A socket file nobody listens on is a `serve` that ended without removing it.
    socket.on("error", () => done(connected ? (code ?? EXIT.failed) : null));
    socket.on("close", () => done(connected ? (code ?? (signal.aborted ? EXIT.ok : EXIT.failed)) : null));
  });
}

async function serve(args: Parsed, io: Io, signal: AbortSignal): Promise<number> {
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const log = (line: string) => io.out(`${stamp()} ${line}`);
  const home = one(args, "--home") ?? linkHome();
  const appDirs = (args.values.get("--apps") ?? []).map((dir) => resolve(dir));
  const specs = (args.values.get("--daemon") ?? []).map((spec) => {
    const parsed = parseDaemonSpec(spec);
    if (parsed === null) throw new UsageError(`--daemon takes <applet id>=<module.ts>, not ${spec}`);
    return parsed;
  });
  const resolves = new Map<string, { address: string; port: number }>();
  for (const spec of args.values.get("--resolve") ?? []) {
    const parsed = parseResolve(spec);
    if (parsed === null) throw new UsageError(`--resolve takes <host>=<address>:<port>, not ${spec}`);
    resolves.set(parsed.host, { address: parsed.address, port: parsed.port });
  }
  const features = ["runtime", "runtime.native", "devtools", "apps", ...(appDirs.length > 0 ? ["catalog", "install"] : []), ...(args.flags.has("--no-http") ? [] : ["net.http"]), ...(specs.length > 0 ? ["channel"] : [])];

  let offer: FolderOffer | null = null;
  const daemons = new Map<string, LinkDaemon>();
  const session = openSession(args, {
    serving: true,
    features,
    hub: {
      catalog: () => offer?.offer() ?? [],
      fetch: args.flags.has("--no-http") ? undefined : netFetch(args.flags.has("--allow-private"), resolves, log),
      daemons: (app) => daemons.get(app) ?? null,
    },
  });
  if ((await delegate(home, ["devices", "--json"], { out() {}, err() {} }, signal)) !== null) {
    io.err(`a serve already runs for the store ${home}`);
    return EXIT.failed;
  }
  rmSync(socketPath(home), { force: true });

  for (const { app, path } of specs) {
    try {
      const daemon = await loadDaemon(app, path, { cwd: process.cwd(), home, log: (line) => log(`${app}: ${line}`) });
      daemons.set(app, {
        ready: daemon.ready,
        stop: () => daemon.stop?.(),
        attach(channel, info: DaemonInfo) {
          log(`channel: ${info.app} of device ${info.device}, generation ${info.generation}`);
          channel.onClose((reason) => log(`channel: ${info.app} generation ${info.generation} closed: ${reason}`));
          daemon.attach(channel, info);
        },
      });
    } catch (error) {
      io.err(`--daemon ${app}: ${describeError(error)}`);
      return EXIT.failed;
    }
  }
  if (appDirs.length > 0) {
    offer = new FolderOffer(appDirs, () => {
      log(`catalog: the offer changed, ${offer?.offer().length ?? 0} rows`);
      session.hub.catalogChanged();
    }, log);
    offer.watch();
  }
  if (!args.flags.has("--no-http")) adoptSystemProxy();

  session.logListeners.add((device, event) => log(`${device.id} ${logLine(event)}`));
  session.linkListeners.add((device) => {
    log(`linked ${device.id} "${device.name}" ${device.model} from ${device.peer.carrier.remoteAddress}, payload limit ${device.peer.limit}`);
    device.onStatus = (status) => log(`${device.id} status: ${status.phase}${(status as unknown as Json).running ? `, running ${String((status as unknown as Json).running)}` : ""}`);
    device.onApps = (list) => log(`${device.id} reports ${list.length} installed applets`);
    device.onGuestEnd = (app) => log(`${device.id} guest ended: ${app}`);
    device.onClose = (info) => log(`unlinked ${device.id}: ${info.code}${info.reason ? ` ${info.reason}` : ""}`);
    if (device.peer.inUse("runtime")) void device.logs(true).catch(() => {});
  });
  const reported = new Set<string>();
  const refusalTimer = setInterval(() => {
    for (const refusal of session.refusals.splice(0)) {
      const line = `refused ${refusal.address}${refusal.device ? ` (device ${refusal.device})` : ""}: ${refusal.kind} ${refusal.code}`;
      if (reported.has(line)) continue;
      reported.add(line);
      log(line);
    }
  }, 500);

  // The Pocket DevTools panel: a web page on this computer whose lines travel
  // on the device's DevTools stream (§6.3), both ways, while a device is linked.
  let panel: { stop(): void } | null = null;
  if (args.flags.has("--panel")) {
    const { startDevServer } = await import("../../dev/web/server.ts");
    const web = startDevServer({ port: integerOption(args, "--panel-port", 1, 65535, Number(process.env.PORT ?? 8130)), portRetries: 10 });
    const bridge = new WebSocket(`ws://127.0.0.1:${web.port}/ws?role=device`);
    const send = (text: string) => {
      if (bridge.readyState === WebSocket.OPEN) bridge.send(text);
    };
    const linked = new Set<HubDevice>();
    bridge.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      for (const device of linked) if (device.closed === null && device.devtoolsOpen) device.sendLine(event.data);
    };
    session.linkListeners.add((device) => {
      linked.add(device);
      device.listen(true);
      device.onDevtoolsLine = send;
      // The panel's screenshot button reaches the shim as a line; the shim's
      // answer is the device's unsolicited runtime.screenshot (§6.2).
      device.onScreenshot = (shot) => {
        const { png } = screenshotPng(shot);
        send(JSON.stringify({ t: "screenshot", frame: shot.frame, data: `data:image/png;base64,${png.toString("base64")}` }));
      };
    });
    panel = { stop: () => { bridge.close(); web.stop(); } };
    log(`panel: ${web.panelUrl}`);
  }

  await goOnline(session);
  let server: Server | null = null;
  try {
    await new Promise<void>((done, fail) => {
      server = createServer((socket) => serveCommand(session, socket, log));
      server.once("error", fail);
      server.listen(socketPath(home), () => done());
    });
  } catch (error) {
    clearInterval(refusalTimer);
    offer?.close();
    panel?.stop();
    await closeSession(session);
    io.err(`the socket ${socketPath(home)} could not be bound (${describeError(error)}); a socket path holds about 100 bytes, so name a shorter --home`);
    return EXIT.failed;
  }
  log(`Hub ${session.store.id} "${session.store.name}" on port ${session.hub.port}; features ${features.join(" ")}`);
  if (offer !== null) log(`catalog: ${offer.offer().length} rows from ${appDirs.join(", ")}`);
  for (const app of daemons.keys()) log(`daemon: ${app}`);
  const paired = session.store.describe().filter((record) => record.paired);
  log(paired.length === 0 ? "no device is paired: run `setup` first" : `waiting for ${paired.map((record) => record.id).join(", ")}`);

  await new Promise<void>((done) => (signal.aborted ? done() : signal.addEventListener("abort", () => done(), { once: true })));
  clearInterval(refusalTimer);
  offer?.close();
  panel?.stop();
  (server as Server | null)?.close();
  rmSync(socketPath(home), { force: true });
  await closeSession(session);
  log("stopped");
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv: readonly string[], io: Io = { out: (line) => console.log(line), err: (line) => console.error(line) }): Promise<number> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const args = parseArguments(argv);
    if (args.flags.has("--help") || args.command === "help" || args.command === "") {
      io.out(USAGE);
      return args.command === "" && !args.flags.has("--help") ? EXIT.usage : EXIT.ok;
    }
    if (args.command === "serve") return await serve(args, io, abort.signal);
    if (STORED[args.command] === undefined && LINKED[args.command] === undefined) throw new UsageError(`unknown command ${args.command}`);
    const delegated = await delegate(one(args, "--home") ?? linkHome(), argv, io, abort.signal);
    if (delegated !== null) return delegated;
    const session = openSession(args);
    try {
      if (LINKED[args.command] !== undefined) {
        // No pairing, or an ambiguous one, is known before a port is taken.
        const target = targetDevice(session, args);
        if ("error" in target) {
          io.err(target.error);
          return target.exit;
        }
        await goOnline(session);
      }
      return await run({ session, args, io, cwd: process.cwd(), signal: abort.signal });
    } finally {
      await closeSession(session);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    io.err(describeError(error));
    return EXIT.failed;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
