// The command line of the Pocket Link 2 reference Hub (tools/pocket-link/v2/
// cli.ts) with its store, its FTP storage and its beacon targets. The
// commands run as processes against the C client (engine/host-services/
// link2.c in tests/fixtures/link2-client-harness.c, under ASan and UBSan):
// a temporary store, a folder as the card, and for `setup --host` the FTP
// server of tests/helpers/ftp-server.ts.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LINK2_BEACON_PORT } from "../contracts/spec/link2.ts";
import { POCKET_SECTION, encodeIdentity, encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { decodePNG } from "../tools/png.ts";
import { EXIT, parseArguments, parseResolve, screenshotPng } from "../tools/pocket-link/v2/cli.ts";
import { parseDaemonSpec } from "../tools/pocket-link/v2/daemon.ts";
import { pattern } from "../tools/pocket-link/v2/daemon-sample.ts";
import { ftpStorage } from "../tools/pocket-link/v2/ftp-storage.ts";
import { LinkHub, MemoryStore, broadcastAddress, lanBeaconTargets } from "../tools/pocket-link/v2/hub.ts";
import { FolderOffer, packageFooter } from "../tools/pocket-link/v2/offer.ts";
import { catalogRows } from "../tools/pocket-link/v2/paging.ts";
import { decodeBeacon } from "../tools/pocket-link/v2/protocol.ts";
import { LinkStore, hubName, linkHome, writeSecret } from "../tools/pocket-link/v2/store.ts";
import { type FtpServer, startFtpServer } from "./helpers/ftp-server.ts";

const root = resolve(import.meta.dir, "..");
const shared = join(root, "engine/host-services");
const cliPath = join(root, "tools/pocket-link/v2/cli.ts");
const samplePath = join(root, "tools/pocket-link/v2/daemon-sample.ts");

let scratch = "";
let harnessBinary = "";
const cleanups: (() => void | Promise<void>)[] = [];

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const crc = (bytes: Uint8Array) => Bun.hash.crc32(bytes) >>> 0;
const mode = (path: string) => statSync(path).mode & 0o777;
const KEY = "ab".repeat(32);

function freeUdpPort(): Promise<number> {
  return new Promise((done) => {
    const socket = createSocket("udp4");
    socket.bind(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => done(port));
    });
  });
}

/** A process whose output is read as lines. */
interface Lines {
  lines: string[];
  errors(): string;
  send(text: string): void;
  /** The next line at or after the cursor that matches; the cursor moves past it. */
  line(match: RegExp, ms?: number): Promise<RegExpMatchArray>;
  /** A line anywhere in the output so far or to come. */
  any(match: RegExp, ms?: number): Promise<RegExpMatchArray>;
  /** Text on the error stream, so far or to come. */
  said(text: string, ms?: number): Promise<void>;
  kill(signal?: NodeJS.Signals): void;
  exited: Promise<number>;
}

function spawnLines(command: string[], options: { env?: Record<string, string>; cwd?: string } = {}): Lines {
  const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: options.cwd ?? root, env: { ...process.env, ...options.env } });
  const lines: string[] = [];
  let cursor = 0;
  let errors = "";
  let partial = "";
  const drain = async (stream: ReadableStream<Uint8Array>, take: (text: string) => void) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      take(decoder.decode(value, { stream: true }));
    }
  };
  void drain(child.stdout, (text) => {
    const parts = (partial + text).split("\n");
    partial = parts.pop() ?? "";
    lines.push(...parts);
  });
  void drain(child.stderr, (text) => {
    errors += text;
  });
  const fail = (match: RegExp, ms: number) => new Error(`no line matched ${match} in ${ms} ms; last lines:\n${lines.slice(-14).join("\n")}\n${errors.slice(-2000)}`);
  return {
    lines,
    errors: () => errors,
    send(text) {
      child.stdin.write(`${text}\n`);
      child.stdin.flush();
    },
    async line(match, ms = 15_000) {
      const end = Date.now() + ms;
      for (;;) {
        for (; cursor < lines.length; cursor++) {
          const found = lines[cursor].match(match);
          if (found) {
            cursor++;
            return found;
          }
        }
        if (Date.now() > end) throw fail(match, ms);
        await pause(3);
      }
    },
    async any(match, ms = 15_000) {
      const end = Date.now() + ms;
      for (;;) {
        for (const text of lines) {
          const found = text.match(match);
          if (found) return found;
        }
        if (Date.now() > end) throw fail(match, ms);
        await pause(3);
      }
    },
    async said(text, ms = 30_000) {
      for (const end = Date.now() + ms; !errors.includes(text); await pause(5)) {
        if (Date.now() > end) throw new Error(`the error stream never said "${text}"; it said:\n${errors.slice(-1500)}\n${lines.slice(-10).join("\n")}`);
      }
    },
    kill: (signal = "SIGTERM") => child.kill(signal),
    exited: child.exited,
  };
}

/** The C client on a link directory. `--speed 4` shortens its backoff between two commands. */
function startHarness(linkDir: string, beaconPort: number, args: string[] = ["--speed", "4"]): Lines & { quit(): Promise<void> } {
  const harness = spawnLines([harnessBinary, linkDir, String(beaconPort), ...args], { env: { ASAN_OPTIONS: "detect_leaks=0:abort_on_error=0", UBSAN_OPTIONS: "halt_on_error=1" } });
  let done = false;
  const quit = async () => {
    if (done) return;
    done = true;
    harness.send("quit");
    const code = await harness.exited;
    expect(`exit ${code}\n${harness.errors().slice(-3000)}`).toBe("exit 0\n");
    expect(harness.lines.at(-1)).toBe("bye");
  };
  cleanups.push(async () => {
    if (!done) harness.kill("SIGKILL");
    await harness.exited;
  });
  return Object.assign(harness, { quit });
}

interface World {
  home: string;
  card: string;
  linkDir: string;
  beaconPort: number;
  /** The options every command of this world takes. */
  common: string[];
  /** Runs one command to its end. */
  cli(...args: string[]): Promise<{ code: number; out: string; err: string }>;
  /** Starts a command that stays (`serve`, `logs --follow`). */
  start(...args: string[]): Lines;
}

async function world(): Promise<World> {
  const base = mkdtempSync(join(scratch, "w-"));
  const home = join(base, "home");
  const card = join(base, "card");
  mkdirSync(card);
  const beaconPort = await freeUdpPort();
  // A command's own `--wait` follows these and wins.
  const common = ["--wait", "20", "--home", home, "--port", "0", "--unicast", `127.0.0.1:${beaconPort}`];
  const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  return {
    home,
    card,
    linkDir: join(card, "pocketjs/link"),
    beaconPort,
    common,
    async cli(...args) {
      const child = Bun.spawn(["bun", cliPath, ...common, ...args], { cwd: base, stdout: "pipe", stderr: "pipe", env });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, out, err };
    },
    start(...args) {
      const lines = spawnLines(["bun", cliPath, ...common, ...args], { cwd: base, env: { NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
      cleanups.push(async () => {
        lines.kill("SIGKILL");
        await lines.exited;
      });
      return lines;
    },
  };
}

function pocketFile(id: string, output: string, title: string, version = "1.0.0", filler = 0): Uint8Array {
  return encodePocketPackage({
    manifest: new TextEncoder().encode(JSON.stringify({ id, version, applet: { summary: `The ${title} applet` }, filler: "x".repeat(filler) })),
    variants: [{ target: "3ds-dev", hostAbi: 12, profileHash: `sha256:${"0".repeat(64)}`, sections: [{ kind: POCKET_SECTION.identity, bytes: encodeIdentity({ output, id, title }) }] }],
  });
}

beforeAll(() => {
  // Short names: a `serve` binds a socket in the store's folder, and a socket path holds about 100 bytes.
  scratch = mkdtempSync(join(tmpdir(), "pl2cli-"));
  harnessBinary = join(scratch, "harness");
  const compile = Bun.spawnSync([
    "cc", "-std=gnu11", "-O1", "-g", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined", "-fno-sanitize-recover=undefined",
    `-I${shared}`, join(root, "tests/fixtures/link2-client-harness.c"),
    join(shared, "link2.c"), join(shared, "link2_bsd.c"), join(shared, "link2_proto.c"), join(shared, "sha256.c"), join(shared, "jscan.c"), "-o", harnessBinary,
  ]);
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const it = (name: string, run: () => Promise<void>, ms = 90_000) => test(name, run, ms);

// ---------------------------------------------------------------------------

describe("--resolve", () => {
  it("takes <host>=<address>:<port> and nothing else", async () => {
    expect(parseResolve("link-channel.test=127.0.0.1:9742")).toEqual({ host: "link-channel.test", address: "127.0.0.1", port: 9742 });
    expect(parseResolve("Origin.Test=localhost:80")).toEqual({ host: "origin.test", address: "localhost", port: 80 });
    for (const bad of ["origin.test", "origin.test=127.0.0.1", "origin.test=127.0.0.1:0", "origin.test=127.0.0.1:70000", "=127.0.0.1:80", "a b=127.0.0.1:80", "origin.test=example.org:80"]) {
      expect(parseResolve(bad)).toBe(null);
    }
  });
});

describe("the store on disk", () => {
  test("folders 0700 and files 0600, an identity made once, records through a rename, one counter for the Hub", () => {
    const home = join(mkdtempSync(join(scratch, "store-")), "link");
    const store = new LinkStore(home, { name: "Studio Mac" });
    expect(store.id).toMatch(/^[0-9a-f]{16}$/);
    expect(store.name).toBe("Studio Mac");
    expect([mode(home), mode(join(home, "devices")), mode(join(home, "hub.json"))]).toEqual([0o700, 0o700, 0o600]);

    store.put({ id: "00000000000000d1", name: "3DS", model: "New 3DS XL", key: KEY, target: "3ds-dev", hostAbi: 12, lastAddress: "10.0.0.7", lastSeen: 5 });
    const file = join(home, "devices", "00000000000000d1.json");
    expect(mode(file)).toBe(0o600);
    expect(readdirSync(join(home, "devices"))).toEqual(["00000000000000d1.json"]);
    expect(store.get("00000000000000d1")?.key).toBe(KEY);
    expect(store.get("../hub")).toBeUndefined();
    expect(() => store.put({ id: "../x", name: "", model: "", key: "", target: "", hostAbi: 0, lastAddress: "", lastSeen: 0 })).toThrow();

    // A second process on the same folder reads the same identity and the other's writes.
    const other = new LinkStore(home, { name: "ignored: the store has a name" });
    expect([other.id, other.name]).toEqual([store.id, "Studio Mac"]);
    expect(other.list().map((record) => record.id)).toEqual(["00000000000000d1"]);
    expect([store.nextGeneration(), other.nextGeneration(), store.nextGeneration()]).toEqual([1, 2, 3]);
    other.setName("Renamed");
    expect(store.name).toBe("Renamed");

    // What a command prints holds no key.
    expect(JSON.stringify(store.describe())).not.toContain(KEY);
    expect(store.describe()[0]).toEqual({ id: "00000000000000d1", name: "3DS", model: "New 3DS XL", target: "3ds-dev", hostAbi: 12, lastAddress: "10.0.0.7", lastSeen: 5, paired: true, unconfirmed: false });

    store.remove("00000000000000d1");
    expect(store.list()).toEqual([]);
  });

  test("a write that cannot be renamed leaves the old file and no temporary one", () => {
    const dir = mkdtempSync(join(scratch, "secret-"));
    const path = join(dir, "value.json");
    writeSecret(path, "one");
    writeSecret(path, "two");
    expect([readFileSync(path, "utf8"), mode(path), readdirSync(dir)]).toEqual(["two", 0o600, ["value.json"]]);
    const blocked = join(dir, "folder");
    mkdirSync(join(blocked, "inside"), { recursive: true });
    expect(() => writeSecret(blocked, "three")).toThrow();
    expect(readdirSync(dir).sort()).toEqual(["folder", "value.json"]);
  });

  test("a name is one line of 40 bytes at most, cut on a code point; the home is $POCKETJS_LINK_HOME or ~/.pocketjs/link", () => {
    expect(hubName("  Studio\nMac  ")).toBe("Studio Mac");
    expect(new TextEncoder().encode(hubName("工作室的电脑".repeat(4))).length).toBe(39);
    expect(linkHome({ POCKETJS_LINK_HOME: "/x/y" })).toBe("/x/y");
    expect(linkHome({ HOME: "/h" })).toEndWith("/.pocketjs/link");
  });
});

describe("beacon targets on a LAN", () => {
  test("the limited broadcast, each interface's broadcast address read again after 10 s, paired devices' last addresses, the named targets, each once", () => {
    expect(broadcastAddress("172.16.10.212", "255.255.255.0")).toBe("172.16.10.255");
    expect(broadcastAddress("10.20.37.5", "255.255.240.0")).toBe("10.20.47.255");
    const store = new MemoryStore();
    store.put({ id: "00000000000000d1", name: "", model: "", key: KEY, target: "", hostAbi: 0, lastAddress: "172.16.10.198", lastSeen: 1 });
    store.put({ id: "00000000000000d2", name: "", model: "", key: KEY, target: "", hostAbi: 0, lastAddress: "", lastSeen: 0 });
    let now = 0;
    let reads = 0;
    let interfaces = [
      { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true },
      { address: "172.16.10.212", netmask: "255.255.255.0", family: "IPv4", internal: false },
      { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false },
      { address: "172.16.10.213", netmask: "255.255.255.0", family: "IPv4", internal: false },
    ];
    const targets = lanBeaconTargets({ store, unicast: [{ address: "172.16.10.198", port: LINK2_BEACON_PORT }, { address: "127.0.0.1", port: 4000 }], interfaces: () => (reads++, interfaces), now: () => now });
    const list = () => targets().map((target) => `${target.address}:${target.port}`);
    expect(list()).toEqual(["255.255.255.255:8627", "172.16.10.255:8627", "172.16.10.198:8627", "127.0.0.1:4000"]);
    interfaces = [{ address: "192.168.1.9", netmask: "255.255.255.0", family: "IPv4", internal: false }];
    now = 9_999;
    expect(list()).toContain("172.16.10.255:8627");
    expect(reads).toBe(1);
    now = 10_000;
    expect(list()).toEqual(["255.255.255.255:8627", "192.168.1.255:8627", "172.16.10.198:8627", "127.0.0.1:4000"]);
    expect(reads).toBe(2);
    // A device that links from a new address is a target from then on.
    store.put({ ...store.get("00000000000000d2")!, lastAddress: "192.168.1.40" });
    expect(list()).toContain("192.168.1.40:8627");
  });

  test("an endpoint with a target function sends a version 2 beacon with its port, id and name", async () => {
    const received: Uint8Array[] = [];
    const socket = createSocket("udp4");
    await new Promise<void>((done) => socket.bind(0, "127.0.0.1", () => done()));
    socket.on("message", (bytes) => received.push(new Uint8Array(bytes)));
    const hub = new LinkHub({ name: "Studio Mac", port: 0, host: "127.0.0.1", store: new MemoryStore("00000000000000aa"), beaconTargets: () => [{ address: "127.0.0.1", port: socket.address().port }] });
    await hub.listen();
    hub.start(20);
    cleanups.push(() => {
      hub.stop();
      socket.close();
    });
    for (const end = Date.now() + 5000; received.length === 0 && Date.now() < end; ) await pause(10);
    expect(decodeBeacon(received[0])).toMatchObject({ port: hub.port, companion: "00000000000000aa", name: "Studio Mac" });
  });
});

describe("a device's link directory over ftpd", () => {
  let server: FtpServer;
  let folder = "";
  const start = async () => {
    folder = mkdtempSync(join(scratch, "ftp-"));
    server = await startFtpServer(folder);
    cleanups.push(() => server.close());
    return ftpStorage({ host: "127.0.0.1", port: server.port });
  };

  it("a read tells absent from failed, a write makes its folders, a delete is confirmed, a rename moves the file", async () => {
    const storage = await start();
    expect(await storage.localAddress()).toBe("127.0.0.1");
    // A card that never held the folders, then a folder without the file: both absent.
    expect(await storage.read("device.txt")).toEqual({ kind: "absent" });
    expect(await storage.list("companions")).toEqual([]);
    await storage.write("companions/00000000000000aa.new", "key=1\n");
    expect(await storage.read("companions/00000000000000ab.txt")).toEqual({ kind: "absent" });
    expect(await storage.read("companions/00000000000000aa.new")).toEqual({ kind: "file", text: "key=1\n" });
    expect(readFileSync(join(folder, "pocketjs/link/companions/00000000000000aa.new"), "utf8")).toBe("key=1\n");

    await storage.remove("companions/00000000000000aa.txt");
    await storage.rename("companions/00000000000000aa.new", "companions/00000000000000aa.txt");
    expect(await storage.list("companions")).toEqual(["00000000000000aa.txt"]);

    // The data connection drops: a failed read, which says nothing about the file.
    server.breakNext("RETR", "/pocketjs/link/companions/00000000000000aa.txt");
    expect(await storage.read("companions/00000000000000aa.txt")).toEqual({ kind: "failed" });
    expect(await storage.read("companions/00000000000000aa.txt")).toEqual({ kind: "file", text: "key=1\n" });
    server.breakNext("NLST", "/pocketjs/link/companions");
    await expect(storage.list("companions")).rejects.toThrow(/could not be listed/);
    server.breakNext("STOR", "/pocketjs/link/device.txt");
    await expect(storage.write("device.txt", "0123456789abcdef\n")).rejects.toThrow(/could not be written/);

    await storage.remove("companions/00000000000000aa.txt");
    expect(await storage.list("companions")).toEqual([]);
    await expect(storage.rename("companions/none.new", "companions/none.txt")).rejects.toThrow(/could not be renamed/);
  });

  it("a path that could end an FTP command is refused before curl runs; a server that is not there fails a read and the first connection", async () => {
    const storage = await start();
    const before = server.commands.length;
    await expect(storage.read("companions/a\r\nDELE x")).rejects.toThrow(/not a path/);
    await expect(storage.remove("../device.txt")).rejects.toThrow(/not a path/);
    expect(server.commands.length).toBe(before);
    expect(() => ftpStorage({ host: "127.0.0.1; rm", port: 5000 })).toThrow();
    await server.close();
    expect(await storage.read("device.txt")).toEqual({ kind: "failed" });
    await expect(storage.localAddress()).rejects.toThrow(/ftpd did not answer at 127\.0\.0\.1/);
  });
});

describe("pieces of the command line", () => {
  test("arguments: values, repeated values, flags, positionals; an unknown option is a usage error", () => {
    const parsed = parseArguments(["install", "a.3dsx", "--name", "b.3dsx", "--no-launch", "--unicast", "10.0.0.1", "--unicast", "10.0.0.2:9"]);
    expect(parsed.command).toBe("install");
    expect(parsed.positional).toEqual(["a.3dsx"]);
    expect(parsed.values.get("--unicast")).toEqual(["10.0.0.1", "10.0.0.2:9"]);
    expect(parsed.flags.has("--no-launch")).toBe(true);
    expect(() => parseArguments(["status", "--nope"])).toThrow(/unknown option/);
    expect(() => parseArguments(["status", "--wait"])).toThrow(/takes a value/);
    expect(parseDaemonSpec("dev.example.app=./daemon.ts")).toEqual({ app: "dev.example.app", path: "./daemon.ts" });
    expect(parseDaemonSpec("=x")).toBeNull();
    expect(parseDaemonSpec("no-equals")).toBeNull();
  });

  test("a screenshot's rotated B,G,R surfaces become one PNG, the top screen above the bottom one", () => {
    // One pixel is marked in each surface: top (x 3, y 1) red, bottom (x 0, y 239) blue.
    const top = new Uint8Array(400 * 240 * 3);
    const bottom = new Uint8Array(320 * 240 * 3);
    top.set([0, 0, 255], (3 * 240 + (239 - 1)) * 3);
    bottom.set([255, 0, 0], (0 * 240 + (239 - 239)) * 3);
    const pixels = new Uint8Array(top.length + bottom.length);
    pixels.set(top);
    pixels.set(bottom, top.length);
    const { png, width, height } = screenshotPng({ frame: 1, format: "bgr8-rotated", surfaces: [{ name: "top", width: 400, height: 240, bytes: top.length }, { name: "bottom", width: 320, height: 240, bytes: bottom.length }], pixels });
    expect([width, height]).toEqual([400, 480]);
    const image = decodePNG(png);
    const at = (x: number, y: number) => [...image.rgba.subarray((y * 400 + x) * 4, (y * 400 + x) * 4 + 4)];
    expect(at(3, 1)).toEqual([255, 0, 0, 255]);
    expect(at(40 + 0, 240 + 239)).toEqual([0, 0, 255, 255]);
    expect(at(0, 0)).toEqual([0, 0, 0, 255]);
    expect(() => screenshotPng({ frame: 1, format: "rgb8", surfaces: [], pixels: new Uint8Array(0) })).toThrow(/format/);
  });

  test("an offer from folders: the first folder wins an id, a file with a bad footer is left out, a changed file is refused at install", () => {
    const first = mkdtempSync(join(scratch, "apps-a-"));
    const second = mkdtempSync(join(scratch, "apps-b-"));
    const one = pocketFile("dev.example.one", "one", "One");
    writeFileSync(join(first, "one.pocket"), one);
    writeFileSync(join(second, "one-other.pocket"), pocketFile("dev.example.one", "one", "One from the second folder", "9.9.9"));
    writeFileSync(join(second, "two.pocket"), pocketFile("dev.example.two", "two", "Two"));
    const damaged = pocketFile("dev.example.bad", "bad", "Bad").slice();
    damaged[20] ^= 1;
    writeFileSync(join(second, "bad.pocket"), damaged);
    const skipped: string[] = [];
    const offer = new FolderOffer([first, second], () => {}, (line) => skipped.push(line));
    const rows = offer.offer();
    // The first folder's file comes first, so the endpoint's rows keep it for the id.
    expect(rows.map((row) => `${row.id} ${row.version}`).sort()).toEqual(["dev.example.one 1.0.0", "dev.example.one 9.9.9", "dev.example.two 1.0.0"]);
    expect([rows[0].id, rows[0].version]).toEqual(["dev.example.one", "1.0.0"]);
    expect(catalogRows(rows).map((row) => `${row.id} ${row.version}`)).toEqual(["dev.example.one 1.0.0", "dev.example.two 1.0.0"]);
    expect(rows[0]).toMatchObject({ output: "one", title: "One", summary: "The One applet", hash: packageFooter(one)?.stored, bytes: one.length, targets: ["3ds-dev"] });
    expect(skipped).toEqual([expect.stringContaining("bad.pocket is left out: footer hash mismatch")]);
    expect(crc(rows[0].read())).toBe(crc(one));
    writeFileSync(join(first, "one.pocket"), pocketFile("dev.example.one", "one", "One", "1.0.1"));
    expect(() => rows[0].read()).toThrow(/changed/);
    expect(offer.rescan()).toBe(true);
    expect(offer.offer()[0].version).toBe("1.0.1");
  });
});

// ---------------------------------------------------------------------------

describe("the commands, against the C client", () => {
  it("setup --card writes the pairing and prints no key; devices lists it; a second setup keeps it; forget drops the record", async () => {
    const w = await world();
    const first = await w.cli("setup", "--card", w.card, "--address", "127.0.0.1", "--name", "Studio Mac");
    expect(first.code, first.err).toBe(EXIT.ok);
    const store = new LinkStore(w.home);
    const [record] = store.list();
    expect(first.out).toContain(`device ${record.id}: a new key is written`);
    expect(first.out + first.err).not.toContain(record.key);
    expect(readFileSync(join(w.linkDir, "device.txt"), "utf8")).toBe(`${record.id}\n`);
    expect(readFileSync(join(w.linkDir, "companions", `${store.id}.txt`), "utf8")).toBe(`key=${record.key}\nname=Studio Mac\naddress=127.0.0.1\nport=8628\n`);
    expect(readdirSync(join(w.linkDir, "companions"))).toEqual([`${store.id}.txt`]);

    const listed = await w.cli("devices");
    expect(listed.out).toContain(`Hub ${store.id} "Studio Mac"`);
    expect(listed.out).toContain(`${record.id}  -  -  -  -  never linked`);
    expect(listed.out).not.toContain(record.key);
    const json = JSON.parse((await w.cli("devices", "--json")).out);
    expect(json.devices).toEqual([{ id: record.id, name: "", model: "", target: "", hostAbi: 0, lastAddress: "", lastSeen: 0, paired: true, unconfirmed: false, linked: false }]);

    const second = await w.cli("setup", "--card", w.card, "--address", "127.0.0.1", "--json");
    expect(second.code).toBe(EXIT.ok);
    expect(JSON.parse(second.out)).toEqual({ outcome: "kept", failed: false, device: record.id, message: "the pairing is in place" });
    expect(new LinkStore(w.home).get(record.id)?.key).toBe(record.key);

    expect((await w.cli("forget", "0123")).code).toBe(EXIT.usage);
    expect((await w.cli("forget", "00000000000000ff")).code).toBe(EXIT.failed);
    expect((await w.cli("forget", record.id)).code).toBe(EXIT.ok);
    expect((await w.cli("devices")).out).toContain("no device is paired");
  });

  it("setup --host writes through ftpd: the key goes to .new first, the address is the FTP connection's, and the client links with the files", async () => {
    const w = await world();
    const server = await startFtpServer(w.card);
    cleanups.push(() => server.close());
    const done = await w.cli("setup", "--host", "127.0.0.1", "--ftp-port", String(server.port));
    expect(done.code, done.err).toBe(EXIT.ok);
    const store = new LinkStore(w.home);
    const [record] = store.list();
    expect(done.out).toContain(`device ${record.id}: a new key is written`);
    expect(readFileSync(join(w.linkDir, "companions", `${store.id}.txt`), "utf8")).toContain("address=127.0.0.1\n");
    const stored = server.commands.filter((line) => /^(STOR|RNFR|RNTO) /.test(line));
    expect(stored).toEqual(["STOR device.txt", `STOR ${store.id}.new`, `RNFR /pocketjs/link/companions/${store.id}.new`, `RNTO /pocketjs/link/companions/${store.id}.txt`]);
    expect(done.out + done.err).not.toContain(record.key);

    const harness = startHarness(w.linkDir, w.beaconPort);
    await harness.line(new RegExp(`^device ${record.id}$`));
    const status = await w.cli("status", "--json");
    expect(status.code, status.err).toBe(EXIT.ok);
    expect(JSON.parse(status.out)).toMatchObject({ device: record.id, name: "Harness 3DS", status: { phase: "booted", target: "3ds-dev" } });
    await harness.any(/^linked /);
    await harness.quit();
  });

  it("a setup cut midway is exit 4 and \"setup not confirmed\" until the next one completes; ftpd that is not there says what to do", async () => {
    const w = await world();
    const server = await startFtpServer(w.card);
    const hubId = new LinkStore(w.home).id;
    server.breakNext("STOR", `/pocketjs/link/companions/${hubId}.new`);
    const cut = await w.cli("setup", "--host", "127.0.0.1", "--ftp-port", String(server.port));
    expect(cut.code).toBe(EXIT.setup);
    expect(cut.err).toContain("setup not confirmed for device");
    expect(cut.err).toContain(`companions/${hubId}.new`);
    expect((await w.cli("devices")).out).toContain("[setup not confirmed]");
    // The partial .new of the cut is removed, and the key is written again.
    const again = await w.cli("setup", "--host", "127.0.0.1", "--ftp-port", String(server.port));
    expect(again.code, again.err).toBe(EXIT.ok);
    expect(readdirSync(join(w.linkDir, "companions"))).toEqual([`${hubId}.txt`]);
    expect((await w.cli("devices")).out).not.toContain("setup not confirmed");

    // A failed read ends the setup with the record as it was.
    const key = new LinkStore(w.home).list()[0].key;
    server.breakNext("RETR", `/pocketjs/link/companions/${hubId}.txt`);
    const unread = await w.cli("setup", "--host", "127.0.0.1", "--ftp-port", String(server.port));
    expect(unread.code).toBe(EXIT.setup);
    expect(new LinkStore(w.home).list()[0].key).toBe(key);

    await server.close();
    const gone = await w.cli("setup", "--host", "127.0.0.1", "--ftp-port", String(server.port));
    expect(gone.code).toBe(EXIT.setup);
    expect(gone.err).toContain("ftpd did not answer at 127.0.0.1");
    expect(gone.err).toContain("start ftpd on the device");
    expect((await w.cli("setup")).code).toBe(EXIT.usage);
    expect((await w.cli("setup", "--card", join(w.card, "nowhere"))).code).toBe(EXIT.setup);
  });

  it("a command that sees no device says what to check: exit 3; no pairing and an ambiguous one are known before a port is taken", async () => {
    const w = await world();
    const none = await w.cli("status");
    expect(none.code).toBe(EXIT.noDevice);
    expect(none.err).toContain("this Hub holds no pairing");
    expect((await w.cli("nonsense")).code).toBe(EXIT.usage);
    expect((await w.cli("status", "--nope")).code).toBe(EXIT.usage);

    expect((await w.cli("setup", "--card", w.card, "--address", "127.0.0.1")).code).toBe(EXIT.ok);
    const waited = await w.cli("status", "--wait", "1");
    expect(waited.code).toBe(EXIT.noDevice);
    expect(waited.err).toContain("no device linked within 1 s");
    expect(waited.err).toContain("the device's program is running");
    expect(waited.err).toContain("holds this Hub's pairing");
    expect(waited.err).toContain("another Hub may hold the device's link");

    // A second paired device: the command wants --device.
    const other = join(w.card, "second");
    mkdirSync(other);
    expect((await w.cli("setup", "--card", other, "--address", "127.0.0.1")).code).toBe(EXIT.ok);
    const two = await w.cli("status", "--wait", "1");
    expect(two.code).toBe(EXIT.usage);
    expect(two.err).toContain("several devices are paired");
    const ids = new LinkStore(w.home).list().map((record) => record.id);
    expect(ids.length).toBe(2);
    expect((await w.cli("status", "--wait", "1", "--device", ids[0])).code).toBe(EXIT.noDevice);
    expect((await w.cli("status", "--wait", "1", "--device", "00000000000000ff")).err).toContain("holds no pairing for 00000000000000ff");
  });

  it("a device whose key file holds another key: the advice names the rejected proof", async () => {
    const w = await world();
    expect((await w.cli("setup", "--card", w.card, "--address", "127.0.0.1")).code).toBe(EXIT.ok);
    const store = new LinkStore(w.home);
    const [record] = store.list();
    store.put({ ...record, key: "cd".repeat(32) });
    const harness = startHarness(w.linkDir, w.beaconPort);
    await harness.line(/^device /);
    const refused = await w.cli("status", "--wait", "4");
    expect(refused.code).toBe(EXIT.noDevice);
    expect(refused.err).toContain("rejected this Hub's proof: its key file holds another key; run the setup again");
    await harness.quit();
  });

  it("status, apps, eval and logs, each starting the endpoint, waiting for the device and leaving", async () => {
    const w = await world();
    expect((await w.cli("setup", "--card", w.card, "--address", "127.0.0.1")).code).toBe(EXIT.ok);
    const harness = startHarness(w.linkDir, w.beaconPort);
    await harness.line(/^device /);
    harness.send("apps 3");

    const status = await w.cli("status");
    expect(status.code, status.err).toBe(EXIT.ok);
    expect(status.out).toContain('"Harness 3DS"');
    expect(status.out).toContain("  phase: booted");
    expect(status.out).toContain("    id: dev.pocket-nexus.shell");
    await harness.line(/^linked /);
    await harness.line(/^unlinked going_away/);

    const apps = await w.cli("apps");
    expect(apps.code, apps.err).toBe(EXIT.ok);
    expect(apps.out.trim().split("\n")).toEqual([
      "dev.example.applet-00  applet-00  1.0.0  0000000000000000  [home]",
      "dev.example.applet-01  applet-01  1.0.1  0000000000000001",
      "dev.example.applet-02  applet-02  1.0.2  0000000000000002",
    ]);

    // The harness answers an eval with the length of the line it received.
    const evaluated = await w.cli("eval", "1 + 1");
    expect(evaluated.code, evaluated.err).toBe(EXIT.ok);
    expect(Number(evaluated.out.trim())).toBeGreaterThan(20);
    await harness.any(/^devtools-line \{"t":"eval","id":"hub-1","code":"1 \+ 1"\}/);
    expect(JSON.parse((await w.cli("eval", "2", "--json")).out)).toMatchObject({ ok: true });

    const following = w.start("logs", "--follow");
    // The line is printed once the device answered `runtime.logs`: a log line before that is not sent.
    await following.said("log lines follow");
    harness.send("log a line from the guest");
    await following.line(/^\[info\] guest: a line from the guest$/);
    following.kill("SIGINT");
    expect(await following.exited).toBe(EXIT.ok);
    await harness.quit();
  });

  it("serve --panel: a panel's line reaches the applet's DevTools shim and the answer comes back on the panel's socket", async () => {
    const w = await world();
    expect((await w.cli("setup", "--card", w.card, "--address", "127.0.0.1")).code).toBe(EXIT.ok);
    const panelPort = await freeUdpPort();
    const serve = w.start("serve", "--panel", "--panel-port", String(panelPort));
    const announced = await serve.any(/panel: http:\/\/127\.0\.0\.1:(\d+)\/devtools/);
    const port = Number(announced[1]);
    const panel = new WebSocket(`ws://127.0.0.1:${port}/ws?role=panel`);
    const got: string[] = [];
    panel.onmessage = (event) => void got.push(String(event.data));
    await new Promise<void>((done, fail) => {
      panel.onopen = () => done();
      panel.onerror = () => fail(new Error("the panel's socket did not open"));
    });
    // At the clock's own speed the first beacon arrives before the direct try of the key file's address.
    const harness = startHarness(w.linkDir, w.beaconPort, ["--speed", "1"]);
    await serve.any(/^\S+ linked /);
    // The harness answers an eval line as the shim does, with an evalResult line.
    for (const end = Date.now() + 15_000; Date.now() < end && !got.some((line) => line.includes('"evalResult"')); ) {
      panel.send(JSON.stringify({ t: "eval", id: "panel-1", code: "1 + 1" }));
      await pause(300);
    }
    panel.close();
    expect(got.some((line) => line.includes('"evalResult"') && line.includes("panel-1"))).toBe(true);
    await harness.any(/^devtools-line \{"t":"eval","id":"panel-1"/);
    await harness.quit();
  });

  it("serve: the other commands go through it; push, a .3dsx, launch, a screenshot, logs, the catalog, net.http and a daemon module", async () => {
    const w = await world();
    expect((await w.cli("setup", "--card", w.card, "--address", "127.0.0.1")).code).toBe(EXIT.ok);
    const appsDir = join(w.card, "..", "apps");
    mkdirSync(appsDir);
    const one = pocketFile("dev.example.one", "one", "One", "1.0.0", 300_000);
    writeFileSync(join(appsDir, "one.pocket"), one);

    const http = createHttpServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain", "x-path": request.url ?? "" });
      response.end("hello from the web");
    });
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", () => done()));
    cleanups.push(() => void http.close());
    const httpPort = (http.address() as { port: number }).port;

    const serve = w.start("serve", "--apps", appsDir, "--daemon", `dev.example.sample=${samplePath}`, "--allow-private", "--resolve", `origin.test=127.0.0.1:${httpPort}`);
    await serve.line(/Hub [0-9a-f]{16} ".*" on port \d+; features runtime runtime\.native devtools apps catalog install net\.http channel$/);
    await serve.any(/catalog: 1 rows from /);
    await serve.any(/daemon: dev\.example\.sample$/);
    expect(existsSync(join(w.home, "serve.sock"))).toBe(true);

    const harness = startHarness(w.linkDir, w.beaconPort, ["--speed", "1"]);
    await harness.line(/^linked /);
    await serve.line(/linked [0-9a-f]{16} "Harness 3DS" New Nintendo 3DS XL from 127\.0\.0\.1, payload limit 16384$/);
    const second = await w.cli("serve");
    expect(second.code).toBe(EXIT.failed);
    expect(second.err).toContain("a serve already runs for the store");

    // The device stays linked to serve: a command goes through it and comes back at once.
    const started = Date.now();
    const status = await w.cli("status", "--json");
    expect(status.code, status.err).toBe(EXIT.ok);
    expect(JSON.parse(status.out)).toMatchObject({ name: "Harness 3DS", status: { phase: "booted" } });
    expect(Date.now() - started).toBeLessThan(3000);
    expect((await w.cli("devices")).out).toContain("[linked]");
    await serve.any(/command: status$/);

    // push: the footer hash is the package's, the device's phases are printed.
    writeFileSync(join(w.card, "..", "pushed.pocket"), one);
    const pushed = await w.cli("push", "pushed.pocket");
    expect(pushed.code, pushed.err).toBe(EXIT.ok);
    expect(pushed.out).toContain("… receiving");
    expect(pushed.out).toContain(`pushed ${packageFooter(one)?.stored} (${one.length} bytes): accepted, generation 4, running dev.example.pushed`);
    expect((await harness.line(/^push (\d+) (\d+)$/)).slice(1)).toEqual([String(one.length), String(crc(one))]);
    writeFileSync(join(w.card, "..", "damaged.pocket"), one.subarray(0, one.length - 3));
    const damaged = await w.cli("push", "damaged.pocket");
    expect(damaged.code).toBe(EXIT.failed);
    expect(damaged.err).toContain("not a whole .pocket package");
    expect((await w.cli("push", "nowhere.pocket")).code).toBe(EXIT.failed);
    harness.send("stage reject");
    await pause(100);
    const rejected = await w.cli("push", "pushed.pocket");
    expect(rejected.code).toBe(EXIT.failed);
    expect(rejected.err).toContain("push: rejected: the package's profile does not match");
    harness.send("stage ok");
    await pause(100);

    // A .3dsx: installed for the next start, then installed and started.
    const native = new Uint8Array([0x33, 0x44, 0x53, 0x58, ...pattern(120_000, 6)]);
    writeFileSync(join(w.card, "..", "probe.3dsx"), native);
    const installed = await w.cli("install", "probe.3dsx", "--no-launch");
    expect(installed.code, installed.err).toBe(EXIT.ok);
    expect(installed.out).toContain(`installed sdmc:/3ds/probe.3dsx (${native.length} bytes): installed`);
    expect((await harness.line(/^native (\S+) (\d+) (\d+) (\d)$/)).slice(1)).toEqual(["probe.3dsx", String(native.length), String(crc(native)), "0"]);
    const launched = await w.cli("install", "probe.3dsx", "--name", "other.3dsx");
    expect(launched.code, launched.err).toBe(EXIT.ok);
    expect(launched.out).toContain("the device restarts into other.3dsx");
    expect(launched.out).toContain("linked again from 127.0.0.1");
    await harness.line(/^native other\.3dsx \d+ \d+ 1$/);
    await harness.line(/^restart$/);
    await harness.line(/^linked /);

    // launch: an applet id switches, a .3dsx name restarts, a missing applet is the device's error.
    const switched = await w.cli("launch", "dev.example.pushed");
    expect(switched.out.trim()).toBe("dev.example.pushed: switching");
    const missing = await w.cli("launch", "missing");
    expect(missing.code).toBe(EXIT.failed);
    expect(missing.err).toContain("launch: not_found: no such applet");
    const restarted = await w.cli("launch", "probe.3dsx", "--json");
    expect(restarted.code, restarted.err).toBe(EXIT.ok);
    expect(JSON.parse(restarted.out)).toMatchObject({ phase: "launching", name: "probe.3dsx", back: true });
    await harness.line(/^restart$/);
    await harness.line(/^linked /);

    // shot: the harness's pattern bytes, composed into a 400x480 PNG.
    const shot = await w.cli("shot", "--out", "screen.png");
    expect(shot.code, shot.err).toBe(EXIT.ok);
    expect(shot.out).toMatch(/screen\.png: 400x480, frame 777$/m);
    const image = decodePNG(readFileSync(join(w.card, "..", "screen.png")));
    expect([image.w, image.h]).toEqual([400, 480]);
    const source = pattern(518_400, 9);
    const top = (x: number, y: number) => (x * 240 + (239 - y)) * 3;
    expect([...image.rgba.subarray((5 * 400 + 17) * 4, (5 * 400 + 17) * 4 + 3)]).toEqual([source[top(17, 5) + 2], source[top(17, 5) + 1], source[top(17, 5)]]);

    // eval and logs through serve; serve prints the log lines itself too.
    expect((await w.cli("eval", "40 + 2")).code).toBe(EXIT.ok);
    const following = w.start("logs", "--follow");
    await following.said("log lines follow");
    harness.send("log shown twice");
    await following.line(/^\[info\] guest: shown twice$/);
    await serve.any(/[0-9a-f]{16} \[info\] guest: shown twice$/);
    following.kill("SIGINT");
    expect(await following.exited).toBe(EXIT.ok);
    const brief = await w.cli("logs", "--seconds", "1", "--json");
    expect(brief.code).toBe(EXIT.ok);

    // The catalog of the folder, a change, and an install of the offered file.
    harness.send("catalog");
    await harness.line(/^catalog-page 1 1 dev\.example\.one dev\.example\.one$/);
    await harness.line(/^catalog-done ok 1$/);
    writeFileSync(join(appsDir, "two.pocket"), pocketFile("dev.example.two", "two", "Two"));
    await harness.line(/^catalog-changed$/, 20_000);
    await serve.any(/catalog: the offer changed, 2 rows$/);
    harness.send("install dev.example.one");
    const begun = await harness.line(/^install-begin (\d+) dev\.example\.one ([0-9a-f]{16}) (\d+)$/);
    expect(begun.slice(2)).toEqual([packageFooter(one)?.stored ?? "", String(one.length)]);
    expect((await harness.line(/^install-end (\d+) (\S+) (\d+) (\d+)$/)).slice(2)).toEqual(["ok", String(one.length), String(crc(one))]);

    // net.http through fetch, with the destination policy of version 1; no services behind companion.pocket.
    harness.send(`http dev.example.one http://127.0.0.1:${httpPort}/hello GET 0`);
    const request = (await harness.line(/^http (\d+)$/))[1];
    expect((await harness.line(/^http-head (\d+) (.*)$/))[2]).toContain('"status":200');
    expect((await harness.line(/^http-end (\d+) (\S+) (\d+) (\d+)$/)).slice(1)).toEqual([request, "ok", "18", String(crc(new TextEncoder().encode("hello from the web")))]);
    harness.send("http dev.example.one https://companion.pocket/store/x GET 0");
    await harness.line(/^http (\d+)$/);
    expect((await harness.line(/^http-end (\d+) (\S+) /))[2]).toBe("unavailable");
    // --resolve: a host that does not resolve goes to the server the owner named, and the applet
    // sees the URL it asked for; the serve prints one line per request.
    harness.send("http dev.example.one http://origin.test/mapped GET 0");
    const mapped = (await harness.line(/^http (\d+)$/))[1];
    const mappedHead = (await harness.line(/^http-head (\d+) (.*)$/))[2];
    expect(mappedHead).toContain('"url":"http://origin.test/mapped"');
    expect(mappedHead).toContain('"x-path":"/mapped"');
    expect((await harness.line(/^http-end (\d+) (\S+) (\d+) (\d+)$/)).slice(1, 4)).toEqual([mapped, "ok", "18"]);
    await serve.any(/net\.http: dev\.example\.one GET http:\/\/origin\.test\/mapped -> 200, 18 bytes in \d+ ms$/);

    // The sample daemon: a request, a stream behind its head event, events, a cancelled request.
    harness.send("channel-open dev.example.sample 0123456789abcdef");
    await harness.line(/^channel-state 0 open - \d+$/);
    await serve.any(/channel: dev\.example\.sample of device [0-9a-f]{16}, generation \d+$/);
    await serve.any(/dev\.example\.sample: device [0-9a-f]{16} opened generation \d+ \(package 0123456789abcdef\)$/);
    harness.send('request 0 0 {"t":"echo","x":1}');
    const echo = (await harness.line(/^request 0 (\d+)$/))[1];
    expect((await harness.line(/^message 0 reply (\d+) 0 0 (.*)$/)).slice(1)).toEqual([echo, '{"echo":{"x":1}}']);

    harness.send('request 0 0 {"t":"blob","bytes":300000,"seed":9}');
    const blob = (await harness.line(/^request 0 (\d+)$/))[1];
    expect((await harness.line(/^message 0 progress (\d+) (\d+) 0 (.*)$/)).slice(1)).toEqual([blob, blob, '{"t":"blob.head","bytes":300000}']);
    // The REPLY is the trailer: the harness prints it in the frame that hands over the last bytes, before its own stream line.
    expect((await harness.line(/^message 0 reply (\d+) 0 0 (.*)$/))[2]).toBe(`{"bytes":300000,"crc32":${crc(pattern(300_000, 9))}}`);
    expect((await harness.any(/^stream-end 0 (\d+) (\d+) (\d+)$/)).slice(1)).toEqual([blob, "300000", String(crc(pattern(300_000, 9)))]);

    harness.send('request 0 0 {"t":"ticks","count":3,"everyMs":20}');
    await harness.line(/^message 0 reply \d+ 0 0 \{"started":3\}$/);
    for (const n of [0, 1, 2]) await harness.line(new RegExp(`^message 0 event 0 0 0 \\{"t":"tick","n":${n},"of":3\\}$`));

    harness.send('request 0 0 {"t":"slow","ms":20000}');
    const slow = (await harness.line(/^request 0 (\d+)$/))[1];
    await pause(200);
    harness.send(`cancel 0 ${slow}`);
    expect((await harness.line(/^message 0 reply (\d+) 0 1 (.*)$/))[1]).toBe(slow);
    await serve.any(/dev\.example\.sample: slow: cancelled by the applet$/);
    // An applet this serve names no module for: Hub answers `no_daemon`.
    harness.send("exit 0");
    await harness.line(/^exited 0$/);
    await serve.any(/channel: dev\.example\.sample generation \d+ closed: exit$/);
    harness.send("channel-open dev.example.unknown 0123456789abcdef");
    await harness.line(/^channel-state 0 closed no_daemon /);

    // forget through serve closes the link; serve ends on a signal and removes its socket.
    const id = new LinkStore(w.home).list()[0].id;
    expect((await w.cli("forget", id)).code).toBe(EXIT.ok);
    await harness.any(/^unlinked forgotten/);
    await serve.any(new RegExp(`unlinked ${id}: forgotten`));
    serve.kill("SIGINT");
    expect(await serve.exited).toBe(EXIT.ok);
    expect(existsSync(join(w.home, "serve.sock"))).toBe(false);
    await harness.quit();
  }, 180_000);
});
