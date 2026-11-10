// The Pocket Link 2 C client (engine/host-services/link2.c over link2_bsd.c)
// as a process under ASan and UBSan, against the TypeScript Hub endpoint
// (tools/pocket-link/v2/hub.ts) on loopback: the pairing files Hub's setup
// writes, the first connection, catalog and install, net.http, the runtime
// operations, DevTools, applet channels and the send buffer's rules. The
// harness is tests/fixtures/link2-client-harness.c.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LINK2_APP_EVENT_WINDOW, LINK2_TCP_PAYLOAD } from "../contracts/spec/link2.ts";
import { type Daemon, type HubDevice, type HubOffer, type HubOptions, LinkHub, MemoryStore, directoryStorage } from "../tools/pocket-link/v2/hub.ts";
import { type AppletChannel, type Json, LinkError, type StreamReader } from "../tools/pocket-link/v2/peer.ts";

const root = resolve(import.meta.dir, "..");
const shared = join(root, "engine/host-services");

let scratch = "";
let binary = "";
const cleanups: (() => void | Promise<void>)[] = [];

/** The bytes the harness makes and expects: byte i of a stream is (i * 31 + seed) & 255. */
const pattern = (length: number, seed: number) => new Uint8Array(length).map((_, i) => (i * 31 + seed) & 255);
const crc = (bytes: Uint8Array) => Bun.hash.crc32(bytes) >>> 0;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until(what: () => unknown, label: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await pause(5);
  }
}

function freeUdpPort(): Promise<number> {
  return new Promise((done) => {
    const socket = createSocket("udp4");
    socket.bind(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => done(port));
    });
  });
}

interface Client {
  dir: string;
  hub: LinkHub;
  store: MemoryStore;
  lines: string[];
  /** Writes one command line to the harness. */
  send(command: string): void;
  /** The next line at or after the cursor that matches; the cursor moves past it. */
  line(match: RegExp, ms?: number): Promise<RegExpMatchArray>;
  /** A line anywhere in the output so far or to come, whatever the cursor. */
  any(match: RegExp, ms?: number): Promise<RegExpMatchArray>;
  /** The device linked at Hub. */
  device(): Promise<HubDevice>;
  /** Ends the harness and checks that it left cleanly (no sanitizer report). */
  quit(): Promise<void>;
  exited: Promise<number>;
  stderr(): string;
}

async function start(options: { hub?: Partial<HubOptions>; args?: string[]; pair?: boolean } = {}): Promise<Client> {
  const dir = mkdtempSync(join(scratch, "card-"));
  const store = new MemoryStore("00000000000000aa");
  const beaconPort = await freeUdpPort();
  const hub = new LinkHub({ name: "Studio Mac", port: 0, host: "127.0.0.1", store, beaconTargets: [{ address: "127.0.0.1", port: beaconPort }], ...options.hub });
  await hub.listen();
  if (options.pair !== false) {
    const setup = await hub.setup(directoryStorage(dir), { kind: "card", addresses: ["127.0.0.1"] });
    expect(setup.failed).toBe(false);
  }
  const child = Bun.spawn([binary, dir, String(beaconPort), ...(options.args ?? [])], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0:abort_on_error=0", UBSAN_OPTIONS: "halt_on_error=1" } });
  hub.start(20);
  const lines: string[] = [];
  let cursor = 0;
  let errors = "";
  const drain = async (stream: ReadableStream<Uint8Array>, take: (text: string) => void) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) return;
      take(decoder.decode(value, { stream: true }));
    }
  };
  let partial = "";
  void drain(child.stdout, (text) => {
    const parts = (partial + text).split("\n");
    partial = parts.pop() ?? "";
    lines.push(...parts);
  });
  void drain(child.stderr, (text) => {
    errors += text;
  });
  let done = false;
  const client: Client = {
    dir,
    hub,
    store,
    lines,
    send(command) {
      child.stdin.write(`${command}\n`);
      child.stdin.flush();
    },
    async line(match, ms = 10_000) {
      const end = Date.now() + ms;
      for (;;) {
        for (; cursor < lines.length; cursor++) {
          const found = lines[cursor].match(match);
          if (found) {
            cursor++;
            return found;
          }
        }
        if (Date.now() > end) throw new Error(`no line matched ${match} in ${ms} ms; last lines:\n${lines.slice(-12).join("\n")}\n${errors.slice(-2000)}`);
        await pause(3);
      }
    },
    async any(match, ms = 10_000) {
      const end = Date.now() + ms;
      for (;;) {
        for (const text of lines) {
          const found = text.match(match);
          if (found) return found;
        }
        if (Date.now() > end) throw new Error(`no line matched ${match} in ${ms} ms; last lines:\n${lines.slice(-12).join("\n")}\n${errors.slice(-2000)}`);
        await pause(3);
      }
    },
    async device() {
      await until(() => hub.devices.size === 1, "the device at Hub");
      return [...hub.devices.values()][0];
    },
    async quit() {
      if (done) return;
      done = true;
      client.send("quit");
      const code = await child.exited;
      expect(`exit ${code}\n${errors.slice(-3000)}`).toBe("exit 0\n");
      expect(lines.at(-1)).toBe("bye");
      // On loopback a connect never times out; one that does is a fault of the client's connect test.
      expect(lines.filter((text) => text === "unlinked connect timeout")).toEqual([]);
    },
    exited: child.exited,
    stderr: () => errors,
  };
  cleanups.push(async () => {
    if (!done) child.kill();
    hub.stop();
    await child.exited;
  });
  return client;
}

/** A daemon with handlers a test adds to; it keeps the channels it was given. */
function daemonOf(attach: (channel: AppletChannel) => void) {
  const channels: AppletChannel[] = [];
  const daemon: Daemon = {
    attach(channel) {
      channels.push(channel);
      attach(channel);
    },
  };
  return { daemon, channels };
}

async function readAll(stream: StreamReader): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (let chunk = await stream.read(); chunk !== null; chunk = await stream.read()) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "pocket-link-2-client-"));
  binary = join(scratch, "harness");
  const compile = Bun.spawnSync([
    "cc", "-std=gnu11", "-O1", "-g", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined", "-fno-sanitize-recover=undefined",
    `-I${shared}`, join(root, "tests/fixtures/link2-client-harness.c"),
    join(shared, "link2.c"), join(shared, "link2_bsd.c"), join(shared, "link2_proto.c"), join(shared, "sha256.c"), join(shared, "jscan.c"), "-o", binary,
  ]);
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** Each test spawns the client, links (a beacon a second) and tears down: well over the default 5 s on a loaded machine. */
const it = (name: string, run: () => Promise<void>) => test(name, run, 60_000);

describe("Pocket Link 2 C client against the reference Hub", () => {
  it("the pairing files of a setup, then the first connection: device.txt read, the key file never written, runtime.status at ready", async () => {
    const c = await start();
    const keyFile = join(c.dir, "companions", `${c.hub.id}.txt`);
    const before = readFileSync(keyFile, "utf8");
    const id = (await c.line(/^device ([0-9a-f]{16})$/))[1];
    expect(readFileSync(join(c.dir, "device.txt"), "utf8")).toBe(`${id}\n`);
    expect((await c.line(/^linked (.+) (\d+)$/)).slice(1)).toEqual(["Studio Mac", String(LINK2_TCP_PAYLOAD)]);
    const device = await c.device();
    expect(device.id).toBe(id);
    expect(device.name).toBe("Harness 3DS");
    expect(device.target).toBe("3ds-dev");
    expect(c.store.get(id)?.key).toBe(before.match(/^key=([0-9a-f]{64})$/m)?.[1] as string);
    // The unsolicited runtime.status at ready, and the request for it.
    await until(() => device.status !== null, "runtime.status");
    expect(device.status).toMatchObject({ phase: "booted", target: "3ds-dev", hostAbi: 12, frame: 4242, app: { output: "pocket-shell" } });
    const { t: _t, ...status0 } = device.status as unknown as Json;
    expect(await device.runtimeStatus()).toEqual(status0 as never);
    c.send("status");
    const status = JSON.parse((await c.line(/^status (.*)$/))[1]);
    expect(status).toMatchObject({ phase: "linked", device: id, hub: { id: c.hub.id, name: "Studio Mac" }, limit: LINK2_TCP_PAYLOAD, error: null });
    expect(status.paired).toEqual([{ id: c.hub.id, name: "Studio Mac", address: "127.0.0.1", port: c.hub.port }]);
    // The device never opens the key file for writing; nothing changed at this ready, so no .last file either.
    expect(readFileSync(keyFile, "utf8")).toBe(before);
    expect(existsSync(join(c.dir, "companions", `${c.hub.id}.last`))).toBe(false);
    await c.quit();
    expect(c.lines).toContain("unlinked going_away");
  });

  it("a Hub name that changed goes to the .last file; a Hub with another key gets CLOSE auth and is held", async () => {
    const c = await start({ hub: { name: "Renamed Mac" } });
    const keyFile = join(c.dir, "companions", `${c.hub.id}.txt`);
    writeFileSync(keyFile, readFileSync(keyFile, "utf8").replace("name=Renamed Mac", "name=Old Name"));
    c.send("reload");
    await c.line(/^linked Renamed Mac/);
    await until(() => existsSync(join(c.dir, "companions", `${c.hub.id}.last`)), "the .last file");
    expect(readFileSync(join(c.dir, "companions", `${c.hub.id}.last`), "utf8")).toBe(`name=Renamed Mac\naddress=127.0.0.1\nport=${c.hub.port}\n`);
    expect(readFileSync(keyFile, "utf8")).toContain("name=Old Name");
    await c.quit();

    // Another card whose key file holds a key Hub does not: the device verifies Hub's proof first.
    const d = await start();
    const other = join(d.dir, "companions", `${d.hub.id}.txt`);
    const text = readFileSync(other, "utf8");
    await d.line(/^linked /);
    (await d.device()).peer.close("going_away");
    await d.line(/^unlinked going_away/);
    writeFileSync(other, text.replace(/^key=[0-9a-f]{64}$/m, `key=${"ab".repeat(32)}`));
    d.send("reload");
    await d.line(/^unlinked auth$/);
    // Held for 30 s: no further attempt follows the backoff.
    const links = d.lines.filter((line) => line.startsWith("unlinked")).length;
    await pause(1800);
    expect(d.lines.filter((line) => line.startsWith("unlinked")).length).toBe(links);
    await d.quit();
  });

  it("a device Hub has no record of is refused unknown_device", async () => {
    const c = await start();
    await c.line(/^linked /);
    const device = await c.device();
    c.hub.forget(device.id);
    await c.line(/^unlinked forgotten$/);
    await c.line(/^unlinked refused: unknown_device$/);
    await c.quit();
  });

  it("catalog pages, catalog.changed, an install of 3 MiB under the 64 KiB window, and an app the offer lacks", async () => {
    const file = pattern(3 * 1024 * 1024 + 17, 1);
    const offer: HubOffer[] = Array.from({ length: 70 }, (_, i) => ({
      id: `dev.example.app-${(69 - i).toString().padStart(2, "0")}`,
      title: `App ${69 - i}`,
      version: "1.2.3",
      summary: "s".repeat(120),
      output: `app-${69 - i}`,
      hash: (69 - i).toString(16).padStart(16, "0"),
      bytes: file.length,
      read: () => file,
    }));
    const c = await start({ hub: { catalog: () => offer } });
    await c.line(/^linked /);
    c.send("catalog");
    const first = await c.line(/^catalog-page 1 (\d+) (\S+) (\S+)$/);
    expect(first[2]).toBe("dev.example.app-00");
    const done = await c.line(/^catalog-done (\S+) (\d+)$/);
    expect(done.slice(1)).toEqual(["ok", "64"]);
    const pages = c.lines.filter((line) => line.startsWith("catalog-page"));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.at(-1)?.endsWith("dev.example.app-63")).toBe(true);
    expect(pages.reduce((sum, line) => sum + Number(line.split(" ")[2]), 0)).toBe(64);

    c.hub.catalogChanged();
    await c.line(/^catalog-changed$/);

    c.send("install dev.example.app-03");
    const id = (await c.line(/^install (\d+)$/))[1];
    expect((await c.line(/^install-begin (\d+) (\S+) (\S+) (\d+)$/)).slice(1)).toEqual([id, "dev.example.app-03", "0000000000000003", String(file.length)]);
    expect((await c.line(/^install-end (\d+) (\S+) (\d+) (\d+)$/, 20_000)).slice(1)).toEqual([id, "ok", String(file.length), String(crc(file))]);

    c.send("install dev.example.nothing");
    const missing = (await c.line(/^install (\d+)$/))[1];
    expect((await c.line(/^install-end (\d+) (\S+)/)).slice(1)).toEqual([missing, "not_found"]);
    await c.quit();
  });

  it("a payload limit of 1,024 from the device: paged lists still arrive whole, and net.http is out of use", async () => {
    const offer: HubOffer[] = Array.from({ length: 40 }, (_, i) => ({
      id: `dev.example.app-${i.toString().padStart(2, "0")}`, title: `App ${i}`, version: "1.0.0", summary: "s".repeat(100), output: `app-${i}`, hash: i.toString(16).padStart(16, "0"), bytes: 10, read: () => new Uint8Array(10),
    }));
    const c = await start({ hub: { catalog: () => offer }, args: ["--payload", "1024"] });
    expect((await c.line(/^linked (.+) (\d+)$/))[2]).toBe("1024");
    const device = await c.device();
    expect(device.peer.limit).toBe(1024);
    c.send("catalog");
    expect((await c.line(/^catalog-done (\S+) (\d+)$/)).slice(1)).toEqual(["ok", "40"]);
    expect(c.lines.filter((line) => line.startsWith("catalog-page")).length).toBeGreaterThan(8);
    // 64 installed applets with every field at its limit: 22 pages of 3 rows at 1 KiB.
    c.send("apps 64 1");
    await until(() => device.apps.length === 64, "the runtime.apps report", 15_000);
    expect(device.apps[0]).toMatchObject({ hash: "0000000000000000", home: true });
    expect(device.apps[63].hash).toBe("000000000000003f");
    expect((await device.runtimeStatus()).phase).toBe("booted");
    c.send("http dev.example.app https://example.com/ GET 0");
    expect((await c.line(/^http (\d+)$/))[1]).toBe("0");
    await c.quit();
  });

  it("net.http: the request and its body reach the injected fetch, the response streams under the 8 KiB window, and an error ends the request", async () => {
    const body = pattern(100_000, 2);
    const seen: { request: Json; body: Uint8Array }[] = [];
    const c = await start({
      hub: {
        fetch: async (request, sent) => {
          seen.push({ request: request as unknown as Json, body: sent.slice() });
          if (request.url.endsWith("/fail")) throw new LinkError("timeout", "the site did not answer");
          return { status: 200, url: request.url, headers: [["content-type", "application/octet-stream"], ["x-count", "1"]], body };
        },
      },
    });
    await c.line(/^linked /);
    c.send('http dev.example.app https://example.com/data POST 4096 {"x-test":"1"}');
    const id = (await c.line(/^http (\d+)$/))[1];
    expect(Number(id)).toBeGreaterThan(0);
    const head = JSON.parse((await c.line(/^http-head (\d+) (.*)$/))[2]);
    expect(head).toEqual({ t: "net.head", status: 200, url: "https://example.com/data", headers: { "content-type": "application/octet-stream", "x-count": "1" } });
    expect((await c.line(/^http-end (\d+) (\S+) (\d+) (\d+)$/)).slice(1)).toEqual([id, "ok", String(body.length), String(crc(body))]);
    expect(seen[0].request).toMatchObject({ app: "dev.example.app", url: "https://example.com/data", method: "POST", headers: { "x-test": "1" } });
    expect(crc(seen[0].body)).toBe(crc(pattern(4096, 5)));

    // A worker that takes no bytes: the response stops at the window, and flows again when it consumes.
    c.send("http-slow 1");
    c.send("http dev.example.app https://example.com/slow GET 0");
    const slow = (await c.line(/^http (\d+)$/))[1];
    await c.line(/^http-head /);
    await pause(300);
    expect(c.lines.some((line) => line.startsWith(`http-end ${slow}`))).toBe(false);
    c.send("http-slow 0");
    expect((await c.line(/^http-end (\d+) (\S+) (\d+) (\d+)$/)).slice(1)).toEqual([slow, "ok", String(body.length), String(crc(body))]);

    c.send("http dev.example.app https://example.com/fail GET 0");
    const failed = (await c.line(/^http (\d+)$/))[1];
    expect((await c.line(/^http-end (\d+) (\S+)/)).slice(1)).toEqual([failed, "timeout"]);
    await c.quit();
  });

  it("runtime operations through the host's callbacks: push, a refused push, a .3dsx, launch, a screenshot, logs, the apps report", async () => {
    const c = await start();
    await c.line(/^linked /);
    const device = await c.device();
    const file = pattern(1_500_000, 4);
    const events: Json[] = [];
    const pushed = await device.push(file, "00000000000000aa", (event) => events.push(event));
    expect(pushed).toMatchObject({ phase: "accepted", hash: "00000000000000aa", generation: 4, app: { id: "dev.example.pushed" } });
    expect(events.map((event) => event.phase)).toEqual(["receiving", "received", "staged"]);
    expect((await c.line(/^push (\d+) (\d+)$/)).slice(1)).toEqual([String(file.length), String(crc(file))]);

    c.send("stage reject");
    await pause(50);
    await expect(device.push(pattern(5000, 4), "00000000000000bb")).rejects.toMatchObject({ code: "rejected" });
    c.send("stage storage");
    await pause(50);
    await expect(device.push(pattern(200_000, 4), "00000000000000cc")).rejects.toMatchObject({ code: "storage" });
    await c.line(/^push-abort /);
    c.send("stage ok");
    await pause(50);

    const native = new Uint8Array([0x33, 0x44, 0x53, 0x58, ...pattern(70_000, 6)]);
    expect(await device.nativeInstall("probe.3dsx", native, false)).toEqual({ phase: "installed", name: "probe.3dsx", path: "sdmc:/3ds/probe.3dsx" });
    expect((await c.line(/^native (\S+) (\d+) (\d+) (\d)$/)).slice(1)).toEqual(["probe.3dsx", String(native.length), String(crc(native)), "0"]);
    await expect(device.nativeInstall("other.3dsx", pattern(4000, 6), false)).rejects.toMatchObject({ code: "rejected", message: "not a 3DSX file" });
    await c.line(/^native-abort /);
    await expect(device.nativeInstall("bad name.3dsx", native, false)).rejects.toMatchObject({ code: "malformed" });

    await expect(device.peer.request({ t: "runtime.nothing" }).reply).rejects.toMatchObject({ code: "unknown_message" });
    expect(await device.launch({ app: "dev.example.pushed" })).toEqual({ phase: "switching", output: "dev.example.pushed" });
    await expect(device.launch({ app: "missing" })).rejects.toMatchObject({ code: "not_found" });

    const shot = await device.screenshot();
    expect(shot.frame).toBe(777);
    expect(shot.surfaces.map((surface) => surface.bytes)).toEqual([288_000, 230_400]);
    expect(crc(shot.pixels)).toBe(crc(pattern(518_400, 9)));
    await c.line(/^shot-end 518400$/);

    const logs: Json[] = [];
    device.onLog = (event) => logs.push(event as unknown as Json);
    c.send("log before logs are on");
    expect((await c.line(/^log (\d)$/))[1]).toBe("0");
    await device.logs(true);
    c.send("log a line from the guest");
    expect((await c.line(/^log (\d)$/))[1]).toBe("1");
    await until(() => logs.length === 1, "the log event");
    expect(logs[0]).toEqual({ t: "log", level: "info", source: "guest", text: "a line from the guest", frame: 12 });

    c.send("apps 3");
    await until(() => device.apps.length === 3, "the runtime.apps report");
    expect(device.apps[0]).toEqual({ id: "dev.example.applet-00", output: "applet-00", version: "1.0.0", hash: "0000000000000000", home: true });
    await c.quit();
  });

  it("a launch into a .3dsx: the REPLY, CLOSE restart, the host's restart, and the device links again", async () => {
    const c = await start();
    await c.line(/^linked /);
    const device = await c.device();
    expect(await device.launch({ native: "probe.3dsx" })).toMatchObject({ phase: "launching", name: "probe.3dsx" });
    await c.line(/^unlinked restart$/);
    await c.line(/^restart$/);
    await until(() => device.closed !== null, "the close at Hub");
    expect(device.closed?.code).toBe("restart");
    await c.line(/^linked /, 8000);
    await c.quit();
  });

  it("DevTools: the stream opens at ready, lines cross both ways, an eval is answered, and a guest switch ends the old guest's lines", async () => {
    const c = await start();
    await c.line(/^linked /);
    const device = await c.device();
    await until(() => device.devtoolsOpen, "the DevTools stream");
    const lines: string[] = [];
    device.onDevtoolsLine = (line) => lines.push(line);
    c.send('devtools-send {"t":"hello","hostAbi":12}');
    c.send(`devtools-send {"t":"tree","nodes":"${"n".repeat(40_000)}"}`);
    await until(() => lines.length === 2, "two lines at Hub");
    expect(lines[0]).toBe('{"t":"hello","hostAbi":12}');
    expect(lines[1].length).toBe(40_000 + 23);

    const answer = await device.eval("1 + 1");
    expect(answer).toMatchObject({ t: "evalResult", ok: true });
    await c.line(/^devtools-line \{"t":"eval"/);
    // A 16 KiB line toward the device: the largest one, inside the ring's credit.
    device.sendLine(JSON.stringify({ t: "inspect", pad: "p".repeat(16_000) }));
    await c.line(/^devtools-line \{"t":"inspect"/);

    let ended = "";
    device.onGuestEnd = (app, output) => (ended = `${app} ${output}`);
    c.send("guest-switch dev.example.old old-main");
    await until(() => ended !== "", "guest.end at Hub");
    expect(ended).toBe("dev.example.old old-main");
    await c.quit();
  });

  it("an applet channel: requests both ways, a 518,400-byte response behind its head step, bodies, an event's stream, cancel", async () => {
    const big = pattern(518_400, 8);
    const seen: Record<string, unknown> = {};
    const { daemon, channels } = daemonOf((channel) => {
      channel.on("echo", (args) => ({ echo: args }));
      channel.on("tile.get", async (args, call) => {
        call.progress("tile.head", { bytes: big.length });
        const out = call.respond();
        await out.writeAll(big.subarray(0, Number(args.bytes)));
        return { rev: "r42", bytes: Number(args.bytes) };
      });
      channel.on("put", async (_args, call) => {
        const body = await readAll(call.body as StreamReader);
        return { bytes: body.length, crc: crc(body) };
      });
      channel.on("slow", (_args, call) => new Promise<Json>((_resolve, reject) => call.onCancel(() => reject(new LinkError("cancelled")))));
      channel.onEvent("blob", (_args, stream) => {
        void readAll(stream as StreamReader).then((bytes) => (seen.blob = { bytes: bytes.length, crc: crc(bytes) }));
      });
      channel.onEvent("note", (args) => (seen.note = args));
    });
    const c = await start({ hub: { daemons: () => daemon } });
    await c.line(/^linked /);
    c.send("channel-open dev.example.map 00000000000000aa");
    await c.line(/^channel 0$/);
    const generation = Number((await c.line(/^channel-state 0 open - (\d+)$/))[1]);
    expect(generation).toBeGreaterThan(0);
    await until(() => channels.length === 1, "the daemon's end");
    const channel = channels[0];
    expect(channel.generation).toBe(generation);
    await until(() => channel.units === LINK2_APP_EVENT_WINDOW, "the device's first grant of units");

    // The applet's request and its reply.
    c.send('request 0 0 {"t":"echo","x":1}');
    const echo = (await c.line(/^request 0 (\d+)$/))[1];
    expect((await c.line(/^message 0 reply (\d+) 0 0 (.*)$/)).slice(1)).toEqual([echo, '{"echo":{"x":1}}']);

    // A response over one window: the head hands the stream over, the bytes arrive, the REPLY is the trailer.
    c.send(`request 0 0 {"t":"tile.get","bytes":${big.length}}`);
    const tile = (await c.line(/^request 0 (\d+)$/))[1];
    const head = await c.line(/^message 0 progress (\d+) (\d+) 0 (.*)$/);
    expect(head.slice(1)).toEqual([tile, tile, `{"t":"tile.head","bytes":${big.length}}`]);
    // The REPLY is the trailer on the wire; the applet reads the bytes the stream still holds whenever it asks for them.
    expect((await c.any(new RegExp(`^stream-end 0 ${tile} (\\d+) (\\d+)$`))).slice(1)).toEqual([String(big.length), String(crc(big))]);
    expect((await c.any(new RegExp(`^message 0 reply ${tile} 0 0 (.*)$`)))[1]).toBe(`{"rev":"r42","bytes":${big.length}}`);
    const order = (text: string) => c.lines.findIndex((line) => line.startsWith(text));
    expect(order(`message 0 progress ${tile}`)).toBeLessThan(order(`message 0 reply ${tile}`));

    // The applet's request with a body, and an event that opens a stream toward the daemon.
    c.send('request 0 40000 {"t":"put"}');
    const put = (await c.line(/^request 0 (\d+)$/))[1];
    expect((await c.line(/^message 0 reply (\d+) 0 0 (.*)$/)).slice(1)).toEqual([put, JSON.stringify({ bytes: 40_000, crc: crc(pattern(40_000, 3)) })]);
    c.send('emit 0 0 {"t":"note","text":"hello"}');
    c.send('emit 0 30000 {"t":"blob"}');
    await until(() => seen.blob !== undefined && seen.note !== undefined, "the daemon's events");
    expect(seen.note).toEqual({ text: "hello" });
    expect(seen.blob).toEqual({ bytes: 30_000, crc: crc(pattern(30_000, 3)) });

    // Cancel: the endpoint next to the responder answers it.
    c.send('request 0 0 {"t":"slow"}');
    const slow = (await c.line(/^request 0 (\d+)$/))[1];
    c.send(`cancel 0 ${slow}`);
    const cancelled = await c.line(/^message 0 reply (\d+) 0 1 (.*)$/);
    expect(cancelled[1]).toBe(slow);
    expect(JSON.parse(cancelled[2]).code).toBe("cancelled");

    // The daemon's requests: a plain one, one with a body, one answered with 100,000 bytes behind a head.
    expect(await channel.request("ping", { n: 1 }).reply).toEqual({ t: "ping", body: 0, crc: 0 });
    const upload = channel.request("upload", {}, { body: true });
    const sent = pattern(50_000, 0);
    void upload.body?.writeAll(sent).then(() => upload.body?.end());
    expect(await upload.reply).toEqual({ t: "upload", body: sent.length, crc: crc(sent) });
    let response: Promise<Uint8Array> | null = null;
    const bigCall = channel.request("big", { bytes: 100_000 }, { onProgress: (_t, _args, stream) => (response ??= readAll(stream as StreamReader)) });
    expect(await bigCall.reply).toEqual({ bytes: 100_000 });
    expect(crc(await (response as unknown as Promise<Uint8Array>))).toBe(crc(pattern(100_000, 3)));
    // A request the applet gives up on: the daemon's CANCEL reaches the guest.
    const waiting = channel.request("slow", {});
    await c.line(/^message 0 request (\d+) 0 0 \{"t":"slow"\}$/);
    waiting.cancel();
    await expect(waiting.reply).rejects.toMatchObject({ code: "cancelled" });
    await c.line(/^message 0 cancel /);

    // Objects the client refuses on the applet's side.
    c.send('request 0 0 {"t":"Bad Name"}');
    expect((await c.line(/^request-error 0 (-?\d+)$/))[1]).toBe("-4");
    c.send(`emit 0 0 {"t":"big","pad":"${"x".repeat(9000)}"}`);
    expect((await c.line(/^emit-error 0 (-?\d+)$/))[1]).toBe("-3");

    c.send("exit 0");
    await c.line(/^exited 0$/);
    await until(() => channel.state().state === "closed", "the close at the daemon");
    expect(channel.state().reason).toBe("exit");
    c.send("stats");
    const stats = (await c.line(/^stats (.*)$/))[1];
    // Fixed buffers: 16 KiB receive, 12 + 16 KiB + 16 KiB send, the 65,540-byte line ring and the 64 KiB out buffer.
    expect(stats).toContain(`fixed=${16384 + 12 + 16384 + 16384 + 65540 + 65536}`);
    expect(stats).toContain("channel=0 ");
    expect(Number(stats.match(/peak=(\d+)/)?.[1])).toBeLessThanOrEqual(112 * 1024 + 8 * 8192);
    await c.quit();
  });

  it("events through a stalled guest: the window holds them at the daemon, none is lost, and the channel stays open", async () => {
    const { daemon, channels } = daemonOf(() => {});
    const c = await start({ hub: { daemons: () => daemon } });
    await c.line(/^linked /);
    c.send("channel-open dev.example.feed 00000000000000bb");
    await c.line(/^channel-state 0 open /);
    await until(() => channels.length === 1 && channels[0].units === LINK2_APP_EVENT_WINDOW, "the channel and its units");
    const channel = channels[0];
    c.send("guest-pause 600");
    await pause(50);
    let sent = 0;
    let full = 0;
    const end = Date.now() + 8000;
    while (sent < 300 && Date.now() < end) {
      if (channel.emit("tick", { n: sent })) sent++;
      else {
        full++;
        await pause(5);
      }
    }
    expect(sent).toBe(300);
    // The stalled guest took nothing for 600 ms: the daemon found the window full meanwhile.
    expect(full).toBeGreaterThan(0);
    await c.line(/^message 0 event 0 0 0 \{"t":"tick","n":299\}$/, 10_000);
    const ticks = c.lines.filter((line) => line.startsWith("message 0 event")).map((line) => JSON.parse(line.slice(line.indexOf("{"))).n);
    expect(ticks).toEqual(Array.from({ length: 300 }, (_, i) => i));
    expect(channel.state().state).toBe("open");
    expect(c.lines.some((line) => line.startsWith("channel-state 0 closed"))).toBe(false);
    // The applet's side of the same window: the daemon grants 256 units.
    c.send("emit-count 0 400");
    expect(Number((await c.line(/^emitted 0 (\d+)$/))[1])).toBeGreaterThanOrEqual(256);
    await c.quit();
  });

  it("requests cancelled with their head event in flight return its units: 100 of them leave the daemon its 48", async () => {
    const { daemon, channels } = daemonOf((channel) => {
      channel.on("tile.get", (_args, call) => {
        call.progress("tile.head", { bytes: 100 });
        return new Promise<Json>((_resolve, reject) => call.onCancel(() => reject(new LinkError("cancelled"))));
      });
    });
    const c = await start({ hub: { daemons: () => daemon } });
    await c.line(/^linked /);
    c.send("channel-open dev.example.map 00000000000000ab");
    await c.line(/^channel-state 0 open /);
    await until(() => channels.length === 1 && channels[0].units === LINK2_APP_EVENT_WINDOW, "the channel and its units");
    for (let i = 0; i < 100; i++) {
      c.send('request 0 0 {"t":"tile.get"}');
      const id = (await c.line(/^request 0 (\d+)$/))[1];
      c.send(`cancel 0 ${id}`);
      const reply = await c.any(new RegExp(`^message 0 reply ${id} 0 1 (.*)$`));
      expect(JSON.parse(reply[1]).code).toBe("cancelled");
    }
    // Taken by the guest or discarded behind a CANCEL, every head event's units came back.
    await until(() => channels[0].units === LINK2_APP_EVENT_WINDOW, "every unit back at the daemon", 5000);
    expect(channels[0].state().state).toBe("open");
    await c.quit();
  });

  it("an idle stream with a pending read holds no other stream's credit; a stream the applet does not read is granted nothing", async () => {
    const bytes = pattern(18_244, 8);
    const writers: { tail?: import("../tools/pocket-link/v2/peer.ts").StreamWriter; ignored?: import("../tools/pocket-link/v2/peer.ts").StreamWriter } = {};
    const { daemon, channels } = daemonOf((channel) => {
      channel.on("tile.get", async (_args, call) => {
        call.progress("tile.head", { bytes: bytes.length });
        await call.respond().writeAll(bytes);
        return { bytes: bytes.length };
      });
    });
    const c = await start({ hub: { daemons: () => daemon } });
    await c.line(/^linked /);
    c.send("channel-open dev.example.map 00000000000000cc");
    await c.line(/^channel-state 0 open /);
    await until(() => channels.length === 1 && channels[0].units > 0, "the channel");
    // A log tail the daemon writes nothing on: the guest keeps a read pending on it.
    writers.tail = channels[0].emitStream("tail") ?? undefined;
    await c.line(/^message 0 event 0 (\d+) 0 \{"t":"tail"\}$/);
    await pause(100);
    c.send(`request 0 0 {"t":"tile.get"}`);
    const tile = (await c.line(/^request 0 (\d+)$/))[1];
    expect((await c.any(new RegExp(`^stream-end 0 ${tile} (\\d+) (\\d+)$`), 5000)).slice(1)).toEqual([String(bytes.length), String(crc(bytes))]);
    await c.any(new RegExp(`^message 0 reply ${tile} `));

    // A stream the applet takes and never reads: its sender gets no credit.
    c.send("hold-streams 1");
    await pause(50);
    writers.ignored = channels[0].emitStream("ignored") ?? undefined;
    await c.line(/^message 0 event 0 (\d+) 0 \{"t":"ignored"\}$/);
    writers.ignored?.write(pattern(4000, 1));
    await pause(300);
    expect(writers.ignored?.sent).toBe(0);
    c.send("hold-streams 0");
    c.send(`request 0 0 {"t":"tile.get"}`);
    const again = (await c.line(/^request 0 (\d+)$/))[1];
    await c.any(new RegExp(`^stream-end 0 ${again} 18244 `), 5000);
    await c.quit();
  });

  it("a connection that ends: the channel closes with it, and the next ready opens it with a larger generation", async () => {
    const { daemon, channels } = daemonOf(() => {});
    const c = await start({ hub: { daemons: () => daemon } });
    await c.line(/^linked /);
    c.send("channel-open dev.example.map 00000000000000dd");
    const first = Number((await c.line(/^channel-state 0 open - (\d+)$/))[1]);
    (await c.device()).peer.close("going_away", "Hub restarts");
    await c.line(/^unlinked going_away$/);
    await c.line(/^channel-state 0 closed connection 0$/);
    await c.line(/^linked /, 8000);
    const second = Number((await c.line(/^channel-state 0 open - (\d+)$/))[1]);
    expect(second).toBeGreaterThan(first);
    expect(channels.length).toBe(2);
    expect(channels[0].state()).toEqual({ state: "closed", reason: "connection" });
    await c.quit();
  });

  it("channel.open refusals: no daemon lasts for the applet's run; a realm reset opens again", async () => {
    let allow = false;
    const { daemon } = daemonOf(() => {});
    const c = await start({ hub: { daemons: () => (allow ? daemon : null) } });
    await c.line(/^linked /);
    c.send("channel-open dev.example.none 00000000000000ee");
    await c.line(/^channel-state 0 closed no_daemon 0$/);
    await pause(1500);
    expect(c.lines.filter((line) => line.startsWith("channel-state 0 opening")).length).toBe(1);
    allow = true;
    c.send("reset 0");
    await c.line(/^channel-state 0 open - (\d+)$/);
    c.send("reset 0");
    // channel.close `reset`, then a new channel.open: the next generation.
    await c.line(/^channel-state 0 opening reset 0$/);
    expect((await c.line(/^channel-state 0 open - (\d+)$/, 5000))[1]).toBe("2");
    await c.quit();
  });

  it("streams a system event opens, both ways, and the agent's events with id 0", async () => {
    const c = await start();
    await c.line(/^linked /);
    const device = await c.device();
    const atlas = pattern(100_000, 4);
    const out = device.eventStream({ t: "agent.glyphs", bytes: atlas.length });
    await out.writeAll(atlas);
    out.end();
    expect((await c.line(/^sys-stream (\S+) (\d+) (\d+) (\d)$/)).slice(1)).toEqual(["agent.glyphs", String(atlas.length), String(crc(atlas)), "1"]);
    device.event({ t: "agent.state", phase: "listening" });
    expect((await c.line(/^sys-event (\S+) (.*)$/)).slice(1)).toEqual(["agent.state", '{"t":"agent.state","phase":"listening"}']);
    // A stream with no declared size is refused.
    const refused = device.eventStream({ t: "agent.screen" });
    await expect(refused.finished).rejects.toMatchObject({ code: "transfer" });

    const shots: Uint8Array[] = [];
    let done = false;
    device.peer.onEvent("agent.shot", (object, open) => {
      open?.({ window: 256 * 1024, total: Number(object.bytes), onData: (bytes) => void shots.push(bytes.slice()) }).finished.then(() => (done = true), () => {});
    }, { feature: "agent" });
    c.send('event-stream 20000 {"t":"agent.shot","bytes":20000}');
    expect((await c.line(/^event-stream (\d+) (\d+)$/))[2]).toBe("20000");
    await until(() => done, "the stream at Hub");
    expect(crc(new Uint8Array(Buffer.concat(shots)))).toBe(crc(pattern(20_000, 7)));
    const events: Json[] = [];
    device.onSystemEvent = (object) => events.push(object);
    c.send('event {"t":"agent.cancel"}');
    await until(() => events.length === 1, "agent.cancel at Hub");
    expect(events[0]).toEqual({ t: "agent.cancel" });
    await c.quit();
  });

  it("the features list changes on a live link: a dropped group ends at both sides", async () => {
    const c = await start();
    await c.line(/^linked /);
    const device = await c.device();
    await until(() => device.devtoolsOpen, "the DevTools stream");
    c.send("features runtime catalog install");
    await until(() => !device.peer.inUse("devtools") && device.peer.peerFeatures.length === 3, "the features event");
    await until(() => !device.devtoolsOpen, "the DevTools stream to end");
    await expect(device.nativeInstall("probe.3dsx", pattern(100, 1), false)).rejects.toMatchObject({ code: "unsupported" });
    expect((await device.runtimeStatus()).phase).toBe("booted");
    // Hub drops catalog: the device's fetch has nothing to ask.
    c.hub.setFeatures(["runtime", "install"]);
    await pause(200);
    c.send("catalog");
    expect((await c.line(/^catalog (\d)$/))[1]).toBe("0");
    await c.quit();
  });

  it("a send buffer that takes nothing: frames that need an answer wait in the receive buffer, every request gets one reply, and the link stays up", async () => {
    const c = await start();
    await c.line(/^linked /);
    const device = await c.device();
    c.send("block-send 1200");
    await pause(50);
    const calls = Array.from({ length: 400 }, () => device.runtimeStatus().then(() => "ok", (error: LinkError) => error.code));
    const outcomes = await Promise.all(calls);
    // 8 of Hub's requests are open at the device at a time: the rest are answered busy, each exactly once.
    expect(outcomes.filter((outcome) => outcome !== "ok" && outcome !== "busy")).toEqual([]);
    expect(outcomes.filter((outcome) => outcome === "ok").length).toBeGreaterThan(0);
    expect(device.closed).toBeNull();
    expect((await device.runtimeStatus()).phase).toBe("booted");
    c.send("stats");
    const stats = (await c.line(/^stats (.*)$/))[1];
    expect(Number(stats.match(/pauses=(\d+)/)?.[1])).toBeGreaterThan(0);
    // The send buffer never held more than its size, and 64 bytes stayed for PING, PONG and CLOSE.
    expect(Number(stats.match(/txpeak=(\d+)/)?.[1])).toBeLessThanOrEqual(12 + 16384 + 16384);
    await c.quit();
  });
});
