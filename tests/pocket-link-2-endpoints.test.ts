// Pocket Link 2 (docs/POCKET-LINK.md): the two TypeScript reference endpoints
// (tools/pocket-link/v2/device.ts and hub.ts) against each other on loopback,
// with an injected clock where the page's timers matter. These are the
// scenarios of §10 that need two live endpoints; the vectors and the
// socket-free state machines are in tests/pocket-link-2.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINK2_APP_EVENT_WINDOW,
  LINK2_APP_FRAME_MESSAGES,
  LINK2_APP_STREAM_WINDOW,
  LINK2_APP_EVENT_WINDOW_HUB,
  LINK2_CHANNEL_OPEN_MS,
  LINK2_DEVTOOLS_LINE_IN,
  LINK2_FEATURES,
  LINK2_FRAME,
  LINK2_HTTP_MIN_PAYLOAD,
  LINK2_REFUSED_HOLD_MS,
  LINK2_REQUEST_STALL_MS,
  LINK2_TCP_PAYLOAD,
  type Link2CatalogApp,
  type Link2InstalledApp,
  type Link2RuntimeStatus,
} from "../contracts/spec/link2.ts";
import { type Carrier, pipeCarriers, tcpCarrier } from "../tools/pocket-link/v2/carrier.ts";
import { type DeviceOptions, LinkDevice, type RuntimeHandlers } from "../tools/pocket-link/v2/device.ts";
import { type Daemon, type DaemonInfo, type HubDevice, type HubOffer, type HubOptions, LinkHub, MemoryStore, type SetupStorage, directoryStorage } from "../tools/pocket-link/v2/hub.ts";
import { type AppletChannel, type Json, LinkError, type StreamReader } from "../tools/pocket-link/v2/peer.ts";
import { appMessageLimit, encodeJsonFrame, encodeRawFrame } from "../tools/pocket-link/v2/protocol.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const pause = (ms = 3) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, what = "the condition", ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(1);
  }
}
const fails = async (promise: Promise<unknown>): Promise<LinkError> => {
  try {
    await promise;
  } catch (error) {
    return error as LinkError;
  }
  throw new Error("the promise resolved");
};

const STATUS: Link2RuntimeStatus = {
  phase: "booted",
  target: "3ds-dev",
  hostAbi: 12,
  slot: "06c50ee053fdb886",
  address: "127.0.0.1",
  generation: 3,
  active: "0000000000000000",
  lastGood: "0000000000000000",
  running: "0c264b65890d0377",
  frame: 45423,
  app: { id: "dev.pocket-nexus.shell", output: "pocket-shell", title: "Pocket" },
};

/** A carrier whose inbound bytes a test can hold back: a deaf console, or a
 *  reply kept in flight while the other side acts. */
interface HeldCarrier extends Carrier {
  hold: boolean;
  release(): void;
}
function holdable(inner: Carrier): HeldCarrier {
  const kept: Uint8Array[] = [];
  const outer: HeldCarrier = {
    maxPayload: inner.maxPayload,
    localAddress: inner.localAddress,
    remoteAddress: inner.remoteAddress,
    write: (bytes, written) => inner.write(bytes, written),
    onData: () => {},
    onClose: () => {},
    close: () => inner.close(),
    hold: false,
    release() {
      outer.hold = false;
      for (const bytes of kept.splice(0)) outer.onData(bytes);
    },
  };
  inner.onData = (bytes) => (outer.hold ? void kept.push(bytes.slice()) : outer.onData(bytes));
  inner.onClose = () => outer.onClose();
  return outer;
}

interface World {
  dir: string;
  clock: { t: number };
  hub: LinkHub;
  store: MemoryStore;
  device: LinkDevice;
  devices: LinkDevice[];
  /** The carriers the device side opened, newest last. */
  carriers: HeldCarrier[];
  /** Moves the clock in steps of at most 1 s, running both sides' timers and letting frames cross. */
  advance(ms: number): Promise<void>;
  /** A device over the same directory (a second console running a copy of the card). */
  another(options?: Partial<DeviceOptions>): LinkDevice;
  link(device?: LinkDevice): Promise<HubDevice>;
  linked(): HubDevice;
}

async function world(options: { hub?: Partial<HubOptions>; device?: Partial<DeviceOptions>; pair?: boolean } = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "pocket-link-2-"));
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const store = new MemoryStore("00000000000000aa");
  const hub = new LinkHub({ name: "Studio Mac", port: 0, host: "127.0.0.1", now, store, ...options.hub });
  await hub.listen();
  if (options.pair !== false) {
    const setup = await hub.setup(directoryStorage(dir), { kind: "card", addresses: ["127.0.0.1"] });
    expect(setup.failed).toBe(false);
  }
  const carriers: HeldCarrier[] = [];
  const devices: LinkDevice[] = [];
  const make = (extra: Partial<DeviceOptions> = {}) => {
    const device = new LinkDevice({
      dir,
      name: "Evan's 3DS",
      model: "New Nintendo 3DS XL",
      target: "3ds-dev",
      hostAbi: 12,
      now,
      beaconPort: null,
      runtime: { status: () => STATUS },
      connect: (address, port) =>
        new Promise<Carrier>((resolve, reject) => {
          const socket = connect({ host: address, port });
          socket.once("connect", () => {
            socket.removeAllListeners("error");
            const carrier = holdable(tcpCarrier(socket, extra.maxPayload ?? options.device?.maxPayload ?? LINK2_TCP_PAYLOAD));
            carriers.push(carrier);
            resolve(carrier);
          });
          socket.once("error", reject);
        }),
      ...options.device,
      ...extra,
    });
    devices.push(device);
    return device;
  };
  const device = make();
  const made: LinkDevice[] = [];
  cleanups.push(() => {
    for (const each of made) each.stop();
    for (const carrier of carriers) carrier.close();
    hub.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  made.push(device);
  const w: World = {
    dir,
    clock,
    hub,
    store,
    device,
    devices,
    carriers,
    async advance(ms) {
      for (let left = ms; left > 0; ) {
        const step = Math.min(left, 1000);
        left -= step;
        clock.t += step;
        for (const each of devices) each.tick();
        hub.tick();
        await pause(4);
      }
    },
    another: (extra) => (made.push(make(extra)), made.at(-1) as LinkDevice),
    async link(which = device) {
      const links = which.status.links;
      if (which.status.phase !== "search") await until(() => which.status.phase === "search", "the device to search");
      which.connectTo(hub.id, "127.0.0.1", hub.port);
      await until(() => which.status.links > links && hub.devices.get(which.id)?.peer.carrier.remoteAddress !== undefined && which.peer !== null, "the link");
      await pause();
      return hub.devices.get(which.id) as HubDevice;
    },
    linked: () => hub.devices.get(device.id) as HubDevice,
  };
  return w;
}

/** A daemon that keeps the channels it was given. */
function echoDaemon(extra: (channel: AppletChannel, info: DaemonInfo) => void = () => {}) {
  const channels: AppletChannel[] = [];
  const infos: DaemonInfo[] = [];
  const closes: string[] = [];
  const daemon: Daemon = {
    attach(channel, info) {
      channels.push(channel);
      infos.push(info);
      channel.onClose((reason) => closes.push(reason));
      channel.on("echo", (args) => ({ got: args }));
      extra(channel, info);
    },
  };
  return { daemon, channels, infos, closes, factory: (app: string) => (app === "dev.test.echo" ? daemon : null) };
}
const APP = "dev.test.echo";
const HASH = "0123456789abcdef";

async function readAll(stream: StreamReader): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const bytes = await stream.read();
    if (bytes === null) break;
    chunks.push(bytes);
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
const pattern = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + (i >> 8)) & 0xff);

// ---------------------------------------------------------------------------
// §2.4, §3: discovery, the handshake, refusals, replacements
// ---------------------------------------------------------------------------

describe("admission", () => {
  test("a setup on a directory, the direct try after 2.5 s, and the files the device writes", async () => {
    const w = await world();
    expect(readFileSync(join(w.dir, "device.txt"), "utf8")).toBe(`${w.device.id}\n`);
    expect(readdirSync(join(w.dir, "companions"))).toEqual([`${w.hub.id}.txt`]);
    const keyFile = readFileSync(join(w.dir, "companions", `${w.hub.id}.txt`), "utf8");
    expect(keyFile).toContain(`address=127.0.0.1\nport=${w.hub.port}\n`);
    expect(w.device.paired.map((c) => c.id)).toEqual([w.hub.id]);
    expect(w.device.status.phase).toBe("search");
    // No beacon arrives: the direct try goes to the address Hub wrote into the key file.
    await w.advance(2000);
    expect(w.device.status.phase).toBe("search");
    await w.advance(1000);
    await until(() => w.device.status.phase === "linked", "the direct try to link");
    expect(w.device.hub?.name).toBe("Studio Mac");
    expect(w.device.peer?.limit).toBe(LINK2_TCP_PAYLOAD);
    const record = w.store.get(w.device.id);
    expect(record?.name).toBe("Evan's 3DS");
    expect(record?.model).toBe("New Nintendo 3DS XL");
    // The `ready` gave the name, address and port the key file holds: the device writes nothing.
    expect(readFileSync(join(w.dir, "companions", `${w.hub.id}.txt`), "utf8")).toBe(keyFile);
    expect(existsSync(join(w.dir, "companions", `${w.hub.id}.last`))).toBe(false);
    // The device sends runtime.status once after ready.
    await until(() => w.linked().status !== null, "runtime.status");
    expect(w.linked().status?.running).toBe(STATUS.running);
  });

  test("a beacon from a paired Hub is followed; one from an unknown Hub is not", async () => {
    const beaconPort = 20000 + Math.floor(Math.random() * 20000);
    const w = await world({ hub: { beaconTargets: [{ address: "127.0.0.1", port: beaconPort }] }, device: { beaconPort } });
    w.device.listen();
    await pause(20);
    await w.advance(1000);
    await until(() => w.device.status.phase === "linked", "the beacon to be followed");
    expect(w.device.hub?.id).toBe(w.hub.id);
  });

  test("payload limits: each side offers its own, the smaller one is in force", async () => {
    for (const [deviceOffer, hubOffer, limit] of [
      [4096, 16384, 4096],
      [16384, 8192, 8192],
      [1024, 32768, 1024],
    ] as const) {
      const w = await world({ hub: { maxPayload: hubOffer }, device: { maxPayload: deviceOffer } });
      const hubDevice = await w.link();
      expect(w.device.peer?.limit).toBe(limit);
      expect(hubDevice.peer.limit).toBe(limit);
      expect(appMessageLimit(limit)).toBe(Math.min(8192, limit - 4));
      // A status reply fits the limit in force at each of them.
      expect((await hubDevice.runtimeStatus()).phase).toBe("booted");
    }
  });

  test("refusals: unknown_device, the 30 s hold, and a device Hub forgot", async () => {
    const w = await world();
    await w.link();
    w.hub.forget(w.device.id);
    await until(() => w.device.status.phase === "backoff", "the forgotten close");
    expect(w.device.status.closes.at(-1)).toBe("forgotten");
    await w.advance(1000);
    w.device.connectTo(w.hub.id, "127.0.0.1", w.hub.port);
    await until(() => w.device.status.refusals.length === 1, "the refusal");
    expect(w.device.status.refusals).toEqual(["unknown_device"]);
    // The hold: no direct try goes to that Hub for 30 s.
    const attempts = w.carriers.length;
    await w.advance(LINK2_REFUSED_HOLD_MS - 2000);
    expect(w.carriers.length).toBe(attempts);
    await w.advance(6000);
    expect(w.carriers.length).toBeGreaterThan(attempts);
  });

  test("a setup whose final readback fails is reported as failed and keeps the key it wrote; the first ready confirms it", async () => {
    const w = await world();
    await w.link();
    const first = w.store.get(w.device.id)?.key as string;
    // The device forgot this Hub; a new setup mints a key, and its final readback fails.
    rmSync(join(w.dir, "companions", `${w.hub.id}.txt`));
    const real = directoryStorage(w.dir);
    let reads = 0;
    const flaky: SetupStorage = { ...real, read: async (path) => (path.endsWith(".txt") && path.includes("companions") && ++reads > 1 ? { kind: "failed" } : real.read(path)) };
    w.linked().peer.close("going_away");
    await until(() => w.device.status.phase === "backoff", "the close");
    const setup = await w.hub.setup(flaky, { kind: "card", addresses: ["127.0.0.1"] });
    expect(setup.outcome).toBe("key");
    expect(setup.failed).toBe(true);
    expect(w.hub.unconfirmed.has(w.device.id)).toBe(true);
    // The file was absent, so the old key opened nothing: the minted key replaced it before the first write.
    const minted = w.store.get(w.device.id)?.key as string;
    expect(minted).toMatch(/^[0-9a-f]{64}$/);
    expect(minted).not.toBe(first);
    w.device.reload();
    await w.advance(1000);
    await w.link();
    expect(w.store.get(w.device.id)?.key).toBe(minted);
    expect(w.hub.unconfirmed.has(w.device.id)).toBe(false);
  });

  test("a write cut before the key file is replaced: the old key file stays whole beside a .new, the device answers CLOSE auth, and the next setup repairs it", async () => {
    const w = await world();
    await w.link();
    const cardKey = w.store.get(w.device.id)?.key as string;
    // Hub lost its record; the card still holds the key of the old pairing.
    w.hub.forget(w.device.id);
    await until(() => w.device.status.phase === "backoff", "the forgotten close");
    const real = directoryStorage(w.dir);
    const cut: SetupStorage = { ...real, remove: async (path) => (path.endsWith(`${w.hub.id}.txt`) ? Promise.reject(new Error("the transfer was cut")) : real.remove(path)) };
    const setup = await w.hub.setup(cut, { kind: "card", addresses: ["127.0.0.1"] });
    expect(setup.outcome).toBe("key");
    expect(setup.failed).toBe(true);
    expect(setup.failedAt).toMatchObject({ op: "delete" });
    expect(w.hub.unconfirmed.has(w.device.id)).toBe(true);
    // The card: the old key file whole, and a whole `.new` that the device never loads.
    expect(readFileSync(join(w.dir, "companions", `${w.hub.id}.txt`), "utf8")).toContain(`key=${cardKey}`);
    expect(existsSync(join(w.dir, "companions", `${w.hub.id}.new`))).toBe(true);
    const minted = w.store.get(w.device.id)?.key as string;
    expect(minted).not.toBe(cardKey);
    w.device.reload();
    expect(w.device.paired).toHaveLength(1);
    // Hub proves with the key it minted, which the card does not hold: the device answers CLOSE auth and holds Hub 30 s.
    await w.advance(1000);
    w.device.connectTo(w.hub.id, "127.0.0.1", w.hub.port);
    await until(() => w.device.status.closes.includes("auth"), "the device's CLOSE auth");
    // A later setup reads the file, finds another key than the record's, removes the `.new` and writes again.
    const fixed = await w.hub.setup(real, { kind: "card", addresses: ["127.0.0.1"] });
    expect(fixed.failed).toBe(false);
    expect(existsSync(join(w.dir, "companions", `${w.hub.id}.new`))).toBe(false);
    expect(w.store.get(w.device.id)?.key).not.toBe(minted);
    w.device.reload();
    await w.advance(LINK2_REFUSED_HOLD_MS + 1000);
    if (w.device.status.phase !== "linked") await w.link();
    expect(w.device.status.phase).toBe("linked");
  });

  test("replacements: a live older connection is counted, and the third within 30 s is answered refused busy", async () => {
    const w = await world();
    const twin = w.another();
    expect(twin.id).toBe(w.device.id);
    await w.link(w.device);
    let turn = [twin, w.device];
    for (let n = 0; n < 3; n++) {
      // Each console reaches ready and replaces the other, which answers Hub's PING.
      const [next, previous] = turn;
      if (next.status.phase !== "search") await w.advance(1000);
      await until(() => next.status.phase === "search", "the console to search again");
      await w.link(next);
      await until(() => previous.status.closes.at(-1) === "replaced", "CLOSE replaced");
      turn = [previous, next];
    }
    const [next] = turn;
    await w.advance(1000);
    await until(() => next.status.phase === "search", "the console to search again");
    next.connectTo(w.hub.id, "127.0.0.1", w.hub.port);
    await until(() => next.status.refusals.length === 1, "the refusal");
    expect(next.status.refusals).toEqual(["busy"]);
    expect(w.hub.duplicates.has(w.device.id)).toBe(true);
  });

  test("replacements of connections that answer nothing are not counted: one console at the edge of its range still links", async () => {
    const w = await world();
    await w.link();
    for (let n = 0; n < 4; n++) {
      // The Wi-Fi drop: the old connection goes deaf, and a new console object stands for the device after it.
      const old = w.carriers.at(-1) as HeldCarrier;
      old.hold = true;
      const next = w.another();
      await w.link(next);
      // Hub waits 2 s for the PONG, then closes the half-open connection.
      await w.advance(3000);
      w.devices.splice(w.devices.indexOf(next) - 1, 1);
      expect(w.hub.duplicates.size).toBe(0);
      expect(next.status.refusals).toEqual([]);
    }
  });

  test("a frame of type DATA before ready closes the connection with protocol", async () => {
    const w = await world();
    const socket = connect({ host: "127.0.0.1", port: w.hub.port });
    const got: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => got.push(chunk));
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(Buffer.from([0x50, 0x4b, 0x4c, 0x4b, 2, 2, 0, 0]));
    socket.write(encodeRawFrame(LINK2_FRAME.data, 0, 0, 5, new Uint8Array(4)));
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const bytes = Buffer.concat(got);
    // Hub's preamble selecting 2, then CLOSE with code 2.
    expect([...bytes.subarray(0, 8)]).toEqual([0x50, 0x4b, 0x4c, 0x4b, 2, 2, 2, 0]);
    expect(bytes[8]).toBe(LINK2_FRAME.close);
    expect(bytes.readUInt16LE(20)).toBe(2);
  });

  test("a version-1 console's preamble is answered with selected 0", async () => {
    const w = await world();
    const socket = connect({ host: "127.0.0.1", port: w.hub.port });
    const got: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => got.push(chunk));
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(Buffer.from([0x50, 0x4b, 0x4c, 0x4b, 1, 0, 0, 0]));
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    expect([...Buffer.concat(got)]).toEqual([0x50, 0x4b, 0x4c, 0x4b, 2, 2, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// §4.6, §5: keepalive, requests, the 30 s rules
// ---------------------------------------------------------------------------

describe("requests and timers", () => {
  test("pings every 3 s keep an idle link up; a deaf peer is closed with silence at 10 s", async () => {
    const w = await world();
    const hubDevice = await w.link();
    await w.advance(25_000);
    expect(w.device.status.phase).toBe("linked");
    expect(hubDevice.closed).toBe(null);
    // The device stops hearing Hub: its pings still leave, so Hub keeps the link; the device closes at 10 s.
    (w.carriers.at(-1) as HeldCarrier).hold = true;
    await w.advance(11_000);
    await until(() => w.device.status.closes.at(-1) === "silence", "the device's CLOSE silence");
    await until(() => hubDevice.closed?.code === "silence", "Hub reading it");
  });

  test("an unknown request is answered unknown_message, a malformed one malformed, a group not in use unsupported", async () => {
    const w = await world({ hub: { features: LINK2_FEATURES.filter((f) => f !== "catalog") } });
    await w.link();
    const peer = w.device.peer!;
    expect((await fails(peer.request({ t: "no.such.request" }).reply)).code).toBe("unknown_message");
    expect((await fails(peer.request({ t: "install" }, {}).reply)).code).toBe("not_found");
    expect((await fails(peer.request({ t: "catalog" }).reply)).code).toBe("unsupported");
    expect((await fails(w.device.catalog())).code).toBe("unsupported");
    peer.enqueue(encodeJsonFrame(LINK2_FRAME.request, peer.ids.take(), [1, 2, 3]));
    const call = peer.request({ t: "channel.open", app: 5 as never, hash: "x" }, { feature: "channel" });
    expect((await fails(call.reply)).code).toBe("malformed");
  });

  test("the 30 s stall: a request with no frame for its id is failed with timeout and cancelled; the id is freed 10 s later", async () => {
    const w = await world({ hub: { daemons: () => ({ ready: new Promise<void>(() => {}), attach() {} }) } });
    const hubDevice = await w.link();
    // A responder that never answers: the device's own request to a handler that hangs.
    hubDevice.peer.handle("test.hang", () => new Promise<Json>(() => {}));
    const call = w.device.peer!.request({ t: "test.hang" });
    await w.advance(LINK2_REQUEST_STALL_MS - 1000);
    let settled = false;
    call.reply.catch(() => (settled = true));
    await pause();
    expect(settled).toBe(false);
    await w.advance(2000);
    const error = await fails(call.reply);
    expect(error.code).toBe("timeout");
    // The CANCEL reached Hub, whose endpoint answered `cancelled` itself: the id is free on both sides.
    await pause(10);
    expect(w.device.status.phase).toBe("linked");
  });

  test("CANCEL is answered by cancelled; a CANCEL that crosses a finished reply leaves the reply standing", async () => {
    const w = await world();
    const hubDevice = await w.link();
    let cancelled = 0;
    hubDevice.peer.handle("test.slow", (call) => {
      call.onCancel(() => (cancelled += 1));
      return new Promise<Json>(() => {});
    });
    const slow = w.device.peer!.request({ t: "test.slow" });
    await pause(10);
    slow.cancel();
    expect((await fails(slow.reply)).code).toBe("cancelled");
    expect(cancelled).toBe(1);
    hubDevice.peer.handle("test.quick", () => ({ done: true }));
    const quick = w.device.peer!.request({ t: "test.quick" });
    quick.cancel();
    // Both frames left in one turn: Hub reads the request, answers, then reads the CANCEL of a request it no longer holds.
    const outcome = await quick.reply.then((value) => value, (error: LinkError) => ({ code: error.code }));
    expect(["cancelled", undefined]).toContain((outcome as { code?: string }).code);
  });
});

// ---------------------------------------------------------------------------
// §6.1 Features on a live link
// ---------------------------------------------------------------------------

describe("features", () => {
  test("Hub drops agent with a microphone stream open: the RESET arrives before the features event, and agent comes back", async () => {
    const w = await world();
    const hubDevice = await w.link();
    const order: string[] = [];
    hubDevice.peer.onEvent("agent.audio", (_object, open) => void open?.({ window: 65536, onData: () => {} }), { feature: "agent" });
    const microphone = w.device.peer!.eventStream({ t: "agent.audio", id: 0 }, { feature: "agent" });
    microphone.write(new Uint8Array(4096));
    microphone.finished.catch(() => order.push("reset"));
    await pause(10);
    const before = w.device.peer!.peerFeatures;
    w.hub.setFeatures(LINK2_FEATURES.filter((f) => f !== "agent"));
    await until(() => !w.device.peer!.peerFeatures.includes("agent"), "the features event");
    order.push("features");
    await pause();
    expect(order).toEqual(["reset", "features"]);
    expect(before).toContain("agent");
    expect(w.device.peer!.inUse("agent")).toBe(false);
    // A second change inside one second goes out at its end, with the list as it stands then.
    w.hub.setFeatures([...LINK2_FEATURES]);
    w.hub.setFeatures(LINK2_FEATURES.filter((f) => f !== "install"));
    await w.advance(500);
    expect(w.device.peer!.peerFeatures.includes("agent")).toBe(false);
    await w.advance(1000);
    await until(() => w.device.peer!.peerFeatures.includes("agent"), "the delayed features event");
    expect(w.device.peer!.peerFeatures.includes("install")).toBe(false);
  });

  test("the device drops devtools (stream reset) and adds it back (a new devtools.open)", async () => {
    const w = await world();
    const hubDevice = await w.link();
    const lines: string[] = [];
    hubDevice.onDevtoolsLine = (line) => lines.push(line);
    await until(() => w.device.devtools.open, "the DevTools stream");
    w.device.devtools.send(JSON.stringify({ t: "hello", app: "one" }));
    await until(() => lines.length === 1, "the first line");
    w.device.setFeatures(LINK2_FEATURES.filter((f) => f !== "devtools"));
    await until(() => !hubDevice.peer.inUse("devtools"), "devtools leaving use");
    await expect(hubDevice.eval("1")).rejects.toMatchObject({ code: "unsupported" });
    await w.advance(1000);
    w.device.setFeatures([...LINK2_FEATURES]);
    await until(() => hubDevice.peer.inUse("devtools"), "devtools coming back");
    // The first line on the new stream is the shim's last hello, cached.
    await until(() => lines.length === 2, "the cached hello on the new stream");
    expect(JSON.parse(lines[1]).t).toBe("hello");
  });

  test("Hub drops channel with a channel open: channel.close feature; a request of the dropped group gets unsupported", async () => {
    const echo = echoDaemon();
    const w = await world({ hub: { daemons: echo.factory } });
    await w.link();
    const guest = w.device.openChannel(APP, HASH);
    await until(() => guest.state().state === "open", "the channel");
    w.hub.setFeatures(LINK2_FEATURES.filter((f) => f !== "channel"));
    await until(() => guest.state().state === "closed", "the close");
    expect(guest.state().reason).toBe("feature");
    expect(echo.closes).toEqual(["feature"]);
    const refused = w.device.peer!.request({ t: "channel.open", app: APP, hash: HASH });
    expect((await fails(refused.reply)).code).toBe("unsupported");
    // The group comes into use again: its connection-start step runs, and the channel opens with a larger generation.
    await w.advance(1000);
    w.hub.setFeatures([...LINK2_FEATURES]);
    await w.advance(1000);
    await until(() => guest.state().state === "open", "the reopen");
    expect(guest.generations).toEqual([1, 2]);
  });

  test("a features list of 17 entries closes the link with protocol", async () => {
    const w = await world();
    const hubDevice = await w.link();
    w.device.peer!.event({ t: "features", features: Array.from({ length: 17 }, (_, i) => `f${i}`) });
    await until(() => hubDevice.closed !== null, "the close");
    expect(hubDevice.closed).toMatchObject({ by: "local", code: "protocol" });
    await until(() => w.device.status.closes.at(-1) === "protocol", "the device reading it");
  });
});

// ---------------------------------------------------------------------------
// §6.2 Runtime operations
// ---------------------------------------------------------------------------

describe("runtime operations", () => {
  const runtime = (log: string[]): RuntimeHandlers => ({
    status: () => STATUS,
    async push(request, body) {
      log.push(`push ${request.bytes} ${request.hash} ${body.length}`);
      if (body[0] === 0xff) throw new LinkError("rejected", "the package is for another target", { phase: "rejected" });
      return { generation: 4, message: "ok", app: { id: "dev.test", output: "test", title: "Test" } };
    },
    async nativeInstall(request, body) {
      log.push(`native ${request.name} ${body.length} ${request.launch}`);
      return { phase: request.launch ? "launching" : "installed", path: `sdmc:/3ds/${request.name}` };
    },
    async launch(request) {
      log.push(`launch ${JSON.stringify(request)}`);
      return "app" in request && request.app ? { phase: "switching", output: request.app } : { phase: "launching", name: request.native, path: `sdmc:/3ds/${request.native}` };
    },
    screenshot: () => ({
      frame: 77,
      surfaces: [
        { name: "top", width: 400, height: 240, bytes: 288000, pixels: pattern(288000) },
        { name: "bottom", width: 320, height: 240, bytes: 230400, pixels: pattern(230400).reverse() },
      ],
    }),
  });

  test("push: 100,000 bytes under the device's 64 KiB window, the receipts as events, the reply; a rejection; the mutex", async () => {
    const log: string[] = [];
    const w = await world({ device: { runtime: runtime(log) } });
    const hubDevice = await w.link();
    const events: string[] = [];
    const file = pattern(100_000);
    const first = hubDevice.push(file, "0c264b65890d0377", (event) => events.push(String(event.phase)));
    // A second state-changing request while one is open is refused by Hub with the holder.
    const second = await fails(hubDevice.launch({ app: "test" }));
    expect(second.code).toBe("busy");
    expect(second.extra.holder).toBe("runtime.push");
    const reply = await first;
    expect(reply).toMatchObject({ phase: "accepted", hash: "0c264b65890d0377", generation: 4, app: { output: "test" } });
    expect(events).toEqual(["receiving", "received", "staged"]);
    expect(log).toEqual(["push 100000 0c264b65890d0377 100000"]);
    const bad = pattern(64);
    bad[0] = 0xff;
    const rejected = await fails(hubDevice.push(bad, "0c264b65890d0377"));
    expect(rejected.code).toBe("rejected");
    expect(rejected.extra.phase).toBe("rejected");
  });

  test("a .3dsx install checks the CRC-32 and the magic; with launch the device replies, sends CLOSE restart, and Hub holds the mutex until it links again", async () => {
    const log: string[] = [];
    const w = await world({ device: { runtime: runtime(log) } });
    const hubDevice = await w.link();
    const file = pattern(50_000);
    file.set([0x33, 0x44, 0x53, 0x58]);
    expect(await hubDevice.nativeInstall("probe.3dsx", file, false)).toEqual({ phase: "installed", name: "probe.3dsx", path: "sdmc:/3ds/probe.3dsx" });
    expect((await fails(hubDevice.nativeInstall("probe.3dsx", pattern(50_000), false))).code).toBe("rejected");
    expect((await fails(hubDevice.nativeInstall("../probe.3dsx", file, false))).code).toBe("malformed");
    const reply = await hubDevice.nativeInstall("probe.3dsx", file, true);
    expect(reply.phase).toBe("launching");
    await until(() => hubDevice.closed !== null, "CLOSE restart");
    expect(hubDevice.closed).toMatchObject({ by: "peer", code: "restart" });
    // The device is exiting into another program: no state-changing request until it links again.
    expect(w.device.status.phase).toBe("search");
    const again = await w.link();
    expect((await again.launch({ app: "test" })).phase).toBe("switching");
    expect(log.at(-1)).toBe('launch {"app":"test"}');
  });

  test("a screenshot: the head event, 518,400 bytes under Hub's 256 KiB window, the reply; and the dev menu's unsolicited one", async () => {
    const w = await world({ device: { runtime: runtime([]) } });
    const hubDevice = await w.link();
    const shot = await hubDevice.screenshot();
    expect(shot.frame).toBe(77);
    expect(shot.format).toBe("bgr8-rotated");
    expect(shot.surfaces.map((s) => [s.name, s.bytes])).toEqual([["top", 288000], ["bottom", 230400]]);
    expect(shot.pixels.length).toBe(518_400);
    expect(Buffer.compare(shot.pixels.subarray(0, 288000), pattern(288000))).toBe(0);
    w.device.sendScreenshot();
    await until(() => hubDevice.latestScreenshot !== null, "the unsolicited screenshot");
    expect(hubDevice.latestScreenshot?.pixels.length).toBe(518_400);
  });

  test("Hub that keeps no latest screenshot resets the unsolicited stream refused", async () => {
    const w = await world({ hub: { keepScreenshots: false }, device: { runtime: runtime([]) } });
    await w.link();
    const out = w.device.sendScreenshot()!;
    const error = await fails(out.finished);
    expect(error.extra.reset).toBe("refused");
  });

  test("logs are off at every connection; on, a line is cut to the payload limit minus 96", async () => {
    const w = await world({ device: { maxPayload: 1024 } });
    const hubDevice = await w.link();
    const got: { text: string; frame: number }[] = [];
    hubDevice.onLog = (event) => got.push(event);
    expect(w.device.log("info", "guest", "dropped: logs are off", 1)).toBe(false);
    await hubDevice.logs(true);
    expect(w.device.log("info", "guest", "x".repeat(2000), 0xffff_ffff)).toBe(true);
    await until(() => got.length === 1, "the log event");
    expect(got[0].text.length).toBe(1024 - 96);
    expect(got[0].frame).toBe(0xffff_ffff);
  });

  test("runtime.apps: one page of ordinary rows on TCP, 22 pages of rows at every limit at a 1,024-byte payload limit, one report a second", async () => {
    const ordinary: Link2InstalledApp[] = Array.from({ length: 64 }, (_, i) => ({ id: `dev.pocket-nexus.app-${String(i).padStart(2, "0")}`, output: `app-${i}`, version: "1.0.0", hash: i.toString(16).padStart(16, "0") }));
    const w = await world();
    const hubDevice = await w.link();
    const frames = hubDevice.peer.stats.framesIn;
    w.device.setApps(ordinary);
    await until(() => hubDevice.apps.length === 64, "the report");
    expect(hubDevice.peer.stats.framesIn - frames).toBe(1);
    // A change inside the second goes out at its end.
    w.device.setApps(ordinary.slice(0, 3));
    await pause(10);
    expect(hubDevice.apps.length).toBe(64);
    await w.advance(1000);
    await until(() => hubDevice.apps.length === 3, "the next report");

    const full: Link2InstalledApp[] = Array.from({ length: 64 }, (_, i) => ({ id: `${String(i).padStart(2, "0")}${"i".repeat(126)}`, output: "o".repeat(64), version: "v".repeat(32), hash: "f".repeat(16), home: true }));
    const small = await world({ device: { maxPayload: 1024 } });
    const smallHub = await small.link();
    const before = smallHub.peer.stats.framesIn;
    small.device.setApps(full);
    await until(() => smallHub.apps.length === 64, "the paged report");
    expect(smallHub.peer.stats.framesIn - before).toBe(22);
    expect(smallHub.apps).toEqual(full);
  });
});

// ---------------------------------------------------------------------------
// §6.3 DevTools
// ---------------------------------------------------------------------------

describe("DevTools", () => {
  const ready = async (w: World) => {
    const hubDevice = await w.link();
    await until(() => w.device.devtools.open && hubDevice.devtoolsOpen, "the DevTools stream");
    return hubDevice;
  };

  test("lines both ways, eval answered by the shim, devtools.listen", async () => {
    const w = await world();
    const hubDevice = await ready(w);
    w.device.devtools.onLine = (line) => {
      const message = JSON.parse(line);
      if (message.t === "eval") w.device.devtools.send(JSON.stringify({ t: "evalResult", id: message.id, ok: true, value: String(eval(message.code)) }));
    };
    expect(await hubDevice.eval("6 * 7")).toMatchObject({ ok: true, value: "42" });
    expect(w.device.devtools.listening).toBe(false);
    hubDevice.listen(true);
    await until(() => w.device.devtools.listening, "devtools.listen");
    const lines: string[] = [];
    hubDevice.onDevtoolsLine = (line) => lines.push(line);
    // A tree dump longer than a frame rides the stream; one over 64 KiB is replaced by ctrlDropped.
    w.device.devtools.send(JSON.stringify({ t: "tree", nodes: "n".repeat(40_000) }));
    w.device.devtools.send(JSON.stringify({ t: "tree", nodes: "n".repeat(70_000) }));
    await until(() => lines.length === 2, "the two lines");
    expect(JSON.parse(lines[0]).nodes.length).toBe(40_000);
    expect(JSON.parse(lines[1])).toMatchObject({ t: "ctrlDropped", cap: 65536 });
  });

  test("guest.end fails the pending eval at once, and Hub does not forward the line", async () => {
    const w = await world();
    const hubDevice = await ready(w);
    const forwarded: string[] = [];
    const ended: string[] = [];
    hubDevice.onDevtoolsLine = (line) => forwarded.push(line);
    hubDevice.onGuestEnd = (app, output) => ended.push(`${app} ${output}`);
    w.device.devtools.autoPoll = false;
    const pending = hubDevice.eval("while (true) {}");
    await until(() => w.device.devtools.ringBytes > 0, "the eval line in the ring");
    w.device.guestSwitch("dev.test.old", "old");
    expect((await fails(pending)).code).toBe("closed");
    expect(ended).toEqual(["dev.test.old old"]);
    expect(forwarded).toEqual([]);
    // The undelivered Hub-to-device line was dropped with the guest.
    expect(w.device.devtools.poll()).toBe(null);
    // The mutex is free again: the next eval reaches the next guest's shim.
    w.device.devtools.autoPoll = true;
    w.device.devtools.onLine = (line) => w.device.devtools.send(JSON.stringify({ t: "evalResult", id: JSON.parse(line).id, ok: true }));
    expect(await hubDevice.eval("1")).toMatchObject({ ok: true });
  });

  test("a line cut by a guest switch: its tail is discarded up to its newline", async () => {
    const w = await world();
    await ready(w);
    const lines: string[] = [];
    w.device.devtools.onLine = (line) => lines.push(line);
    const feed = (text: string) => w.device.devtools.feed(new TextEncoder().encode(text));
    void feed('{"t":"eval","id":"hub-1","co');
    w.device.guestSwitch("dev.test.old", "old");
    void feed('de":"1"}\n{"t":"ping"}\n');
    expect(lines).toEqual(['{"t":"ping"}']);
  });

  test("a line held 30 s without credit is dropped and its eval fails with timeout; the stream stays", async () => {
    const w = await world();
    const hubDevice = await ready(w);
    // A guest at a breakpoint: its ring fills with four lines and grants nothing more.
    w.device.devtools.autoPoll = false;
    const big = JSON.stringify({ t: "noop", pad: "p".repeat(LINK2_DEVTOOLS_LINE_IN - 30) });
    for (let i = 0; i < 4; i++) hubDevice.sendLine(big);
    await until(() => w.device.devtools.ringBytes >= 4 * (LINK2_DEVTOOLS_LINE_IN - 16), "the ring to fill");
    const held = hubDevice.eval("1");
    held.catch(() => {});
    await w.advance(LINK2_REQUEST_STALL_MS + 1000);
    expect((await fails(held)).code).toBe("timeout");
    expect(hubDevice.closed).toBe(null);
    expect(hubDevice.peer.inUse("devtools")).toBe(true);
    // The guest runs again: later lines are sent when credit comes.
    for (let line = w.device.devtools.poll(); line !== null; line = w.device.devtools.poll());
    w.device.devtools.autoPoll = true;
    w.device.devtools.onLine = (line) => w.device.devtools.send(JSON.stringify({ t: "evalResult", id: JSON.parse(line).id, ok: true }));
    expect(await hubDevice.eval("2")).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// §6.4, §6.5 Catalog, install, net.http
// ---------------------------------------------------------------------------

describe("catalog, install and net.http", () => {
  const offer = (count: number, size = 4096): HubOffer[] =>
    Array.from({ length: count }, (_, i) => {
      const file = pattern(size + i);
      return {
        id: `dev.pocket-nexus.offer-${String(i).padStart(3, "0")}${"x".repeat(100)}`,
        title: `Offer ${i} ${"t".repeat(60)}`,
        version: "2026.11.10",
        summary: "s".repeat(200),
        output: `offer-${i}`,
        hash: (i + 1).toString(16).padStart(16, "0"),
        bytes: file.length,
        targets: i % 10 === 9 ? ["psp"] : ["3ds-dev"],
        read: () => file,
      };
    });

  test("a catalog of 70 apps: the first 64 by id for the device's target, paged at a 1,024-byte limit, served from the snapshot while the offer changes", async () => {
    let apps = offer(80);
    const w = await world({ hub: { catalog: () => apps }, device: { maxPayload: 1024 } });
    const hubDevice = await w.link();
    let changed = 0;
    w.device.onCatalogChanged = () => (changed += 1);
    const requests = hubDevice.peer.stats.framesIn;
    const fetch = w.device.catalog();
    // The offer changes while the fetch runs: the pages still come from one snapshot.
    await pause(5);
    apps = offer(10);
    w.hub.catalogChanged();
    // A second fetch asked for meanwhile starts after the running one.
    const second = w.device.catalog();
    const rows = await fetch;
    const expected = offer(80).filter((app) => app.targets?.includes("3ds-dev")).map((app) => app.id).sort();
    expect(expected.length).toBe(72);
    expect(rows.map((row: Link2CatalogApp) => row.id)).toEqual(expected.slice(0, 64));
    expect(rows[0].title.length).toBe(64);
    expect(rows[0].summary.length).toBe(120);
    expect(hubDevice.peer.stats.framesIn - requests).toBeGreaterThan(30);
    expect((await second).length).toBe(9);
    expect(changed).toBe(1);
  });

  test("a page request 31 s after the last one is answered changed, and the fetch starts again", async () => {
    const w = await world({ hub: { catalog: () => offer(40) }, device: { maxPayload: 1024 } });
    await w.link();
    const peer = w.device.peer!;
    const first = await peer.request({ t: "catalog" }, { feature: "catalog" }).reply;
    const rows = first.apps as Link2CatalogApp[];
    expect(first.more).toBe(true);
    await w.advance(31_000);
    const late = peer.request({ t: "catalog", after: rows.at(-1)!.id, rev: first.rev }, { feature: "catalog" });
    expect((await fails(late.reply)).code).toBe("changed");
    expect((await fails(peer.request({ t: "catalog", after: rows.at(-1)!.id }, { feature: "catalog" }).reply)).code).toBe("malformed");
    expect((await w.device.catalog()).length).toBe(36);
  });

  test("an install of 6 MiB shares the link with an applet's requests: the round trips are not held behind it", async () => {
    const big = offer(1, 6 * 1024 * 1024);
    const echo = echoDaemon();
    const w = await world({ hub: { catalog: () => big, daemons: echo.factory } });
    await w.link();
    const guest = w.device.openChannel(APP, HASH);
    await until(() => guest.state().state === "open", "the channel");
    let received = 0;
    const install = w.device.install(big[0].id, (bytes) => (received = bytes));
    await until(() => received > 0, "the install's first bytes");
    // Round trips while the install streams: each waits behind at most one chunk of the stream.
    const during: number[] = [];
    const times: number[] = [];
    while (received < big[0].bytes && during.length < 400) {
      const start = performance.now();
      const reply = await guest.request("echo", { n: during.length }).reply;
      times.push(performance.now() - start);
      expect(reply).toEqual({ got: { n: during.length } });
      during.push(received);
    }
    const done = await install;
    expect(done.file.length).toBe(big[0].bytes);
    expect(Buffer.compare(done.file, big[0].read())).toBe(0);
    expect(done.hash).toBe(big[0].hash);
    const inFlight = during.filter((bytes) => bytes > 0 && bytes < big[0].bytes);
    expect(inFlight.length).toBeGreaterThanOrEqual(10);
    // The install was still far from done when the tenth round trip returned.
    expect(inFlight[9]).toBeLessThan(big[0].bytes);
    // Hub's write queue never held more than a few frames: one chunk of the install and the control frames.
    expect(w.linked().peer.stats.queueMax).toBeLessThan(16);
  });

  test("net.http: the body up, the head event, the body down under the 8 KiB window; headers dropped to fit with truncated; errors", async () => {
    const seen: { url: string; body: number; app: string }[] = [];
    const w = await world({
      hub: {
        fetch: async (request, body) => {
          seen.push({ url: request.url, body: body.length, app: request.app });
          if (request.url.endsWith("/fail")) throw new LinkError("dns", "no such host");
          const many = request.url.endsWith("/many");
          return {
            status: 200,
            url: request.url,
            headers: many ? Array.from({ length: 30 }, (_, i): [string, string] => [`x-header-${i}`, "v".repeat(400)]) : [["content-type", "text/plain"]],
            body: pattern(100_000),
          };
        },
      },
    });
    await w.link();
    const response = await w.device.http({ app: APP, url: "https://example.com/data", method: "POST", body: pattern(30_000) });
    expect(response.status).toBe(200);
    expect(response.headers).toEqual({ "content-type": "text/plain" });
    expect(response.truncated).toBe(false);
    expect(Buffer.compare(response.body, pattern(100_000))).toBe(0);
    expect(seen[0]).toEqual({ url: "https://example.com/data", body: 30_000, app: APP });
    const many = await w.device.http({ app: APP, url: "https://example.com/many" });
    expect(many.truncated).toBe(true);
    expect(Object.keys(many.headers).length).toBeLessThan(30);
    expect(JSON.stringify(many.headers).length).toBeLessThanOrEqual(8192);
    expect((await fails(w.device.http({ app: APP, url: "https://example.com/fail" }))).code).toBe("dns");
    // The device's host checks the limits and fails a request before it queues a frame.
    expect((await fails(w.device.http({ app: APP, url: `https://example.com/${"u".repeat(2048)}` }))).code).toBe("invalid_request");
    expect(seen.length).toBe(3);
  });

  test("net.http is out of use under a payload limit of 12,288", async () => {
    const w = await world({ hub: { fetch: async () => ({ status: 200, url: "", headers: [], body: new Uint8Array(0) }) }, device: { maxPayload: LINK2_HTTP_MIN_PAYLOAD - 1 } });
    await w.link();
    expect((await fails(w.device.http({ app: APP, url: "https://example.com/" }))).code).toBe("unavailable");
    const direct = w.device.peer!.request({ t: "net.http", app: APP, url: "https://example.com/", method: "GET", headers: {}, bytes: 0 }, { feature: "net.http" });
    expect((await fails(direct.reply)).code).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// §7 Applet channels
// ---------------------------------------------------------------------------

describe("applet channels", () => {
  test("a channel's life: open with a generation, requests both ways, events both ways, a body, close and reopen", async () => {
    const echo = echoDaemon((channel) => {
      channel.on("upload", async (_args, call) => ({ bytes: (await readAll(call.body!)).length }));
      channel.onEvent("note", (args) => void channel.emit("noted", { seen: args.n }));
    });
    const w = await world({ hub: { daemons: echo.factory } });
    await w.link();
    const guest = w.device.openChannel(APP, HASH);
    expect(guest.state().state).toBe("opening");
    await until(() => guest.state().state === "open", "the channel");
    expect(echo.infos[0]).toEqual({ device: w.device.id, app: APP, hash: HASH, generation: 1 });
    // Each side granted the other its event window after the REPLY.
    await until(() => guest.channel!.units === LINK2_APP_EVENT_WINDOW_HUB && echo.channels[0].units === LINK2_APP_EVENT_WINDOW, "the event windows");
    expect(await guest.request("echo", { a: 1 }).reply).toEqual({ got: { a: 1 } });
    guest.on("ask", (args) => ({ answer: Number(args.q) * 2 }));
    expect(await echo.channels[0].request("ask", { q: 21 }).reply).toEqual({ answer: 42 });
    expect((await fails(echo.channels[0].request("nobody.home").reply)).code).toBe("unknown_message");
    const noted: unknown[] = [];
    guest.onEvent("noted", (args) => noted.push(args.seen));
    expect(guest.emit("note", { n: 7 })).toBe(true);
    await until(() => noted.length === 1, "the event round trip");
    expect(noted).toEqual([7]);
    const upload = guest.request("upload", {}, { body: true });
    await upload.body!.writeAll(pattern(40_000));
    upload.body!.end();
    expect(await upload.reply).toEqual({ bytes: 40_000 });
    // A realm reset: channel.close reset, then a new channel.open with a larger generation.
    const open = guest.request("echo", { late: true });
    guest.reset();
    expect((await fails(open.reply)).code).toBe("closed");
    await w.advance(1000);
    await until(() => guest.state().state === "open" && guest.generations.length === 2, "the reopen");
    expect(guest.generations).toEqual([1, 2]);
    await until(() => echo.closes.length === 1, "the daemon's close notice");
    expect(echo.closes).toEqual(["reset"]);
    guest.exit();
    await until(() => echo.closes.length === 2, "the second close notice");
    expect(echo.closes).toEqual(["reset", "exit"]);
    expect((await fails(guest.request("echo").reply)).code).toBe("no_channel");
  });

  test("a response of 518,400 bytes: the head event hands the stream over, the bytes pass the stream's window, the REPLY is the trailer", async () => {
    const echo = echoDaemon((channel) => {
      channel.on("tile.get", async (_args, call) => {
        // Bytes before a progress event are refused before they reach the wire.
        expect(() => call.respond()).toThrow("bytes before a progress event");
        call.progress("tile.head", { rev: "r42", bytes: 518_400 });
        await call.respond().writeAll(pattern(518_400));
        return { rev: "r42" };
      });
    });
    const w = await world({ hub: { daemons: echo.factory } });
    await w.link();
    const guest = w.device.openChannel(APP, HASH);
    await until(() => guest.state().state === "open", "the channel");
    const heads: string[] = [];
    const chunks: Uint8Array[] = [];
    let received = 0;
    let done = false;
    const call = guest.request("tile.get", { z: 12 }, {
      onProgress: (t, args, stream) => {
        heads.push(`${t} ${args.bytes} ${stream !== undefined}`);
        void (async () => {
          for (let bytes = await stream!.read(); bytes !== null; bytes = await stream!.read()) {
            // One read never hands over more than the stream's window.
            expect(bytes.length).toBeLessThanOrEqual(LINK2_APP_STREAM_WINDOW);
            chunks.push(bytes);
            received += bytes.length;
          }
          done = true;
        })();
      },
    });
    const reply = await call.reply;
    // The REPLY is the trailer: every byte was handed over before it.
    expect(received).toBe(518_400);
    expect(reply).toEqual({ rev: "r42" });
    await until(() => done, "END");
    expect(Buffer.compare(Buffer.concat(chunks), pattern(518_400))).toBe(0);
    expect(heads).toEqual(["tile.head 518400 true"]);
  });

  test("an idle stream with a pending read holds its own window and none of a response's; a response nobody reads ends at 30 s", async () => {
    const echo = echoDaemon((channel) => {
      channel.on("tail.start", () => {
        // A log tail the daemon has nothing to send on.
        channel.emitStream("log.tail");
        return {};
      });
      channel.on("tile.get", async (_args, call) => {
        call.progress("tile.head", { bytes: 18_244 });
        await call.respond().writeAll(pattern(18_244));
        return {};
      });
    });
    const w = await world({ hub: { daemons: echo.factory } });
    await w.link();
    const guest = w.device.openChannel(APP, HASH);
    await until(() => guest.state().state === "open", "the channel");
    let tailRead = false;
    guest.onEvent("log.tail", (_args, stream) => void stream!.read(16_384).then(() => (tailRead = true), () => {}));
    await guest.request("tail.start").reply;
    await pause(10);
    let got = 0;
    const read = guest.request("tile.get", {}, { onProgress: (_t, _a, stream) => void readAll(stream!).then((bytes) => (got = bytes.length), () => {}) });
    await read.reply;
    await until(() => got === 18_244, "the response's bytes");
    expect(tailRead).toBe(false);
    // The same response with no read: no credit is granted, and the call ends at the 30 s limit.
    const unread = guest.request("tile.get", {}, { onProgress: () => {} });
    await w.advance(LINK2_REQUEST_STALL_MS + 2000);
    expect((await fails(unread.reply)).code).toBe("timeout");
    expect(guest.state().state).toBe("open");
  });

  test("the fifth inbound stream is refused with RESET refused and its request still gets its REPLY; the fifth channel is refused busy", async () => {
    const tails: unknown[] = [];
    const echo = echoDaemon((channel) => {
      channel.on("tails", () => {
        for (let i = 0; i < 5; i++) tails.push(channel.emitStream("tail", { i }));
        return { opened: 5 };
      });
      channel.on("tile.get", async (_args, call) => {
        call.progress("tile.head", {});
        const out = call.respond();
        out.write(pattern(100));
        return { sent: true };
      });
    });
    const w = await world({ hub: { daemons: (app) => (app.startsWith("dev.test.") ? echo.daemon : null) } });
    await w.link();
    const guest = w.device.openChannel(APP, HASH);
    await until(() => guest.state().state === "open", "the channel");
    const streams: (StreamReader | undefined)[] = [];
    guest.onEvent("tail", (_args, stream) => void streams.push(stream));
    await guest.request("tails").reply;
    await until(() => streams.length === 5, "the five events");
    expect(streams.filter((s) => s !== undefined)).toHaveLength(4);
    expect(streams[4]).toBeUndefined();
    // With four streams open, a response stream is refused, and the request still ends with its REPLY.
    let handed: StreamReader | undefined | null = null;
    const call = guest.request("tile.get", {}, { onProgress: (_t, _a, stream) => (handed = stream) });
    expect(await call.reply).toEqual({ sent: true });
    expect(handed).toBeUndefined();
    // Four channels on the connection; the fifth is refused busy and retried after 2 s.
    const more = [1, 2, 3].map((n) => w.device.openChannel(`dev.test.app${n}`, HASH));
    await until(() => more.every((channel) => channel.state().state === "open"), "four channels");
    const fifth = w.device.openChannel("dev.test.app4", HASH);
    await until(() => fifth.state().reason === "busy", "the fifth refused");
    expect(fifth.state().state).toBe("closed");
    more[0].exit();
    await w.advance(1000);
    expect(fifth.state().state).toBe("closed");
    await w.advance(1500);
    await until(() => fifth.state().state === "open", "the retry after 2 s");
  });

  test("Hub holds the REPLY while the daemon starts; a daemon not connected in 20 s is busy, retried after 2 s then 4 s; no_daemon is not retried", async () => {
    let start!: () => void;
    let starts = 0;
    const echo = echoDaemon();
    const w = await world({
      hub: {
        daemons: (app) => {
          if (app !== APP) return null;
          starts += 1;
          return { ...echo.daemon, ready: new Promise<void>((resolve) => (start = resolve)) };
        },
      },
    });
    await w.link();
    const guest = w.device.openChannel(APP, HASH);
    // Held 10 s: the link carries everything else meanwhile, and the guest's own requests get no_channel.
    await w.advance(10_000);
    expect(guest.state().state).toBe("opening");
    expect((await w.linked().runtimeStatus()).phase).toBe("booted");
    expect((await fails(guest.request("echo").reply)).code).toBe("no_channel");
    start();
    await until(() => guest.state().state === "open", "the held REPLY");
    expect(starts).toBe(1);
    // A daemon that never connects: busy at LINK_CHANNEL_OPEN_MS, inside the requester's 30 s stall.
    guest.reset();
    await until(() => starts === 2, "the second open");
    await w.advance(LINK2_CHANNEL_OPEN_MS - 2000);
    expect(guest.state().state).toBe("opening");
    await w.advance(2000);
    await until(() => guest.state().reason === "busy", "busy");
    await w.advance(1000);
    expect(starts).toBe(2);
    await w.advance(1000);
    await until(() => starts === 3, "the retry 2 s after busy");
    const missing = w.device.openChannel("dev.test.none", HASH);
    await until(() => missing.state().reason === "no_daemon", "no_daemon");
    await w.advance(5000);
    expect(missing.state()).toEqual({ state: "closed", reason: "no_daemon" });
  });

  test("a CANCEL of channel.open that reaches Hub first is answered cancelled and stops the daemon; one that crosses the accepting REPLY closes the new channel with exit", async () => {
    let stopped = 0;
    let slow = true;
    const echo = echoDaemon();
    const w = await world({
      hub: { daemons: (app) => (app === APP ? { ...echo.daemon, ready: slow ? new Promise<void>(() => {}) : undefined, stop: () => (stopped += 1) } : null) },
    });
    await w.link();
    const early = w.device.openChannel(APP, HASH);
    await pause(10);
    early.exit();
    await until(() => stopped === 1, "the daemon stopped");
    expect(echo.channels.length).toBe(0);
    // The crossing: Hub's accepting REPLY is in flight when the device sends its CANCEL.
    slow = false;
    const carrier = w.carriers.at(-1) as HeldCarrier;
    carrier.hold = true;
    const crossing = w.device.openChannel(APP, HASH);
    await until(() => echo.channels.length === 1, "Hub accepting the channel");
    crossing.exit();
    carrier.release();
    await until(() => echo.closes.length === 1, "the device's channel.close");
    expect(echo.closes).toEqual(["exit"]);
    expect(crossing.state().state).toBe("closed");
    expect(w.device.status.phase).toBe("linked");
    expect(w.linked().channels.size).toBe(0);
  });

  test("the link drops and comes back: the channel is gone without a channel.close, and opens again with a larger generation", async () => {
    const echo = echoDaemon();
    const w = await world({ hub: { daemons: echo.factory } });
    await w.link();
    const guest = w.device.openChannel(APP, HASH);
    await until(() => guest.state().state === "open", "the channel");
    const open = guest.request("echo", {});
    (w.carriers.at(-1) as HeldCarrier).close();
    await until(() => w.device.status.phase === "backoff", "the drop");
    await open.reply.catch(() => {});
    expect(guest.state()).toEqual({ state: "closed", reason: "connection" });
    // One close notice per channel to its daemon; connection loss is one.
    await until(() => echo.closes.length === 1, "the daemon's close notice");
    expect(echo.closes).toEqual(["connection"]);
    // Backoff 1 s, then the direct try after 2.5 s, then channel.open after ready.
    await w.advance(1000);
    expect(w.device.status.phase).toBe("search");
    await w.advance(3000);
    await until(() => guest.state().state === "open", "the reopen after ready");
    expect(guest.generations).toEqual([1, 2]);
    expect(echo.infos.map((info) => info.generation)).toEqual([1, 2]);
    expect(await guest.request("echo", { again: true }).reply).toEqual({ got: { again: true } });
  });

  test("the event window: a guest that takes nothing holds its daemon back with no close; taking events returns the units", async () => {
    const echo = echoDaemon();
    const w = await world({ hub: { daemons: echo.factory }, device: { channel: { auto: false } } });
    await w.link();
    const guest = w.device.openChannel(APP, HASH);
    await until(() => guest.state().state === "open" && echo.channels[0]?.units === LINK2_APP_EVENT_WINDOW, "the channel and its units");
    const daemon = echo.channels[0];
    const seen: number[] = [];
    guest.onEvent("tick", (args) => seen.push(Number(args.n)));
    let sent = 0;
    while (daemon.emit("tick", { n: sent })) sent += 1;
    // 48 units, one per event of under 512 bytes: the daemon is full and the channel stays open.
    expect(sent).toBe(LINK2_APP_EVENT_WINDOW);
    expect(daemon.emit("tick", { n: 999 })).toBe(false);
    await until(() => guest.channel!.waiting === LINK2_APP_EVENT_WINDOW, "the events at the device");
    expect(seen).toEqual([]);
    expect(guest.state().state).toBe("open");
    // An event of 600 bytes costs 2 units: with none granted it is not sent.
    expect(daemon.units).toBe(0);
    // One frame: at most 16 messages. Their units come back in one CREDIT.
    expect(guest.frame().messages).toBe(LINK2_APP_FRAME_MESSAGES);
    await until(() => daemon.units === LINK2_APP_FRAME_MESSAGES, "the regrant");
    expect(seen).toEqual(Array.from({ length: LINK2_APP_FRAME_MESSAGES }, (_, i) => i));
    expect(daemon.emit("tick", { pad: "p".repeat(600) })).toBe(true);
    expect(daemon.units).toBe(LINK2_APP_FRAME_MESSAGES - 2);
    await until(() => guest.channel!.waiting === LINK2_APP_EVENT_WINDOW - LINK2_APP_FRAME_MESSAGES + 1, "the 600-byte event at the device");
    for (let i = 0; i < 20; i++) guest.frame();
    await until(() => daemon.units === LINK2_APP_EVENT_WINDOW, "every unit back");
    expect(seen.length).toBe(LINK2_APP_EVENT_WINDOW + 1);
  });

  test("a cancelled request's head event is discarded and its unit returns; 100 of them leave the window whole", async () => {
    const echo = echoDaemon((channel) => {
      channel.on("tile.get", async (_args, call) => {
        call.progress("tile.head", { bytes: 0 });
        await new Promise<void>((resolve) => call.onCancel(resolve));
        return {};
      });
    });
    const w = await world({ hub: { daemons: echo.factory } });
    await w.link();
    const guest = w.device.openChannel(APP, HASH);
    await until(() => guest.state().state === "open" && echo.channels[0]?.units === LINK2_APP_EVENT_WINDOW, "the channel and its units");
    for (let round = 0; round < 100; round++) {
      const call = guest.request("tile.get", { round }, { onProgress: () => {} });
      call.cancel();
      expect((await fails(call.reply)).code).toBe("cancelled");
    }
    await until(() => echo.channels[0].units === LINK2_APP_EVENT_WINDOW, "48 of 48 units");
    expect(guest.state().state).toBe("open");
  });

  test("an empty response whose head event, END and REPLY arrive before the applet takes the head event: the read ends, and so does one that was reset", async () => {
    const echo = echoDaemon((channel) => {
      channel.on("tile.get", (args, call) => {
        call.progress("tile.head", { bytes: 0 });
        const out = call.respond();
        if (args.reset === true) out.close("cancelled");
        else out.end();
        return { rev: "r0" };
      });
    });
    const w = await world({ hub: { daemons: echo.factory }, device: { channel: { auto: false } } });
    await w.link();
    const guest = w.device.openChannel(APP, HASH);
    await until(() => guest.state().state === "open", "the channel");
    for (const reset of [false, true]) {
      let stream: StreamReader | undefined;
      const call = guest.request("tile.get", { reset }, { onProgress: (_t, _args, given) => (stream = given) });
      // The guest takes nothing until the head event and the REPLY both wait for it: the END (or the
      // RESET) reached the device before the applet held the stream.
      await until(() => guest.channel!.waiting === 2, "the head event and the REPLY at the device");
      await pause(20);
      for (let i = 0; i < 4; i++) guest.frame();
      expect(await call.reply).toEqual({ rev: "r0" });
      expect(stream).toBeDefined();
      if (reset) expect((await fails(stream!.read())).code).toBe("transfer");
      else expect(await stream!.read()).toBe(null);
    }
    expect(guest.state().state).toBe("open");
  });

  test("progress events without a name return their units: 100 of them leave the daemon's window whole", async () => {
    const echo = echoDaemon((channel) => {
      channel.on("work", async (_args, call) => {
        await new Promise<void>((resolve) => call.onCancel(resolve));
        return {};
      });
    });
    const w = await world({ hub: { daemons: echo.factory } });
    const hubDevice = await w.link();
    const guest = w.device.openChannel(APP, HASH);
    await until(() => guest.state().state === "open" && echo.channels[0]?.units === LINK2_APP_EVENT_WINDOW, "the channel and its units");
    const seen: string[] = [];
    const call = guest.request("work", {}, { onProgress: (t) => seen.push(t) });
    await pause(20);
    // Sent raw: the daemon's API refuses an event without a name. Each costs its sender one unit.
    const daemon = echo.channels[0];
    for (let i = 0; i < 100; i++) {
      await until(() => daemon.units > 0, "a unit");
      expect(daemon.spendUnits({ n: i })).toBe(true);
      hubDevice.peer.event({ n: i } as unknown as Json & { t: string }, call.id);
    }
    await until(() => daemon.units === LINK2_APP_EVENT_WINDOW, "48 of 48 units");
    expect(seen).toEqual([]);
    expect(guest.state().state).toBe("open");
    call.cancel();
    await fails(call.reply);
  });

  test("a progress event named log that crosses the applet's channel.close is ignored and does not close the link", async () => {
    const echo = echoDaemon((channel) => {
      channel.on("work", async (_args, call) => {
        await pause(30);
        call.progress("log", { line: "late" });
        call.progress("features", { features: [] });
        return {};
      });
    });
    const w = await world({ hub: { daemons: echo.factory } });
    const hubDevice = await w.link();
    const guest = w.device.openChannel(APP, HASH);
    await until(() => guest.state().state === "open", "the channel");
    // Named log and features while the request is open: read as progress, never as the system events.
    const names: string[] = [];
    await guest.request("work", {}, { onProgress: (t) => names.push(t) }).reply;
    expect(names).toEqual(["log", "features"]);
    expect(w.device.peer!.peerFeatures.length).toBeGreaterThan(0);
    // The same events for an id the device has released: sent raw from Hub's side after the close.
    const call = guest.request("work", {});
    const id = call.id;
    guest.exit();
    await pause(10);
    hubDevice.peer.event({ t: "log", line: "late" }, id);
    hubDevice.peer.event({ t: "features", features: [] }, id);
    await until(() => w.device.peer!.stats.lateEvents === 2, "the late events");
    expect(w.device.status.phase).toBe("linked");
    expect(hubDevice.closed).toBe(null);
  });

  test("a stream-opening event with no handler is reset refused; an object over LINK_APP_MSG is refused before a frame is queued", async () => {
    const echo = echoDaemon();
    const w = await world({ hub: { daemons: echo.factory }, device: { maxPayload: 8192 } });
    await w.link();
    const guest = w.device.openChannel(APP, HASH);
    // The daemon's units arrive in a CREDIT after the REPLY that opened the channel.
    await until(() => guest.state().state === "open" && echo.channels[0]?.units === LINK2_APP_EVENT_WINDOW, "the channel and its units");
    const daemon = echo.channels[0];
    const stream = daemon.emitStream("nobody.listens")!;
    stream.write(pattern(64));
    expect((await fails(stream.finished)).extra.reset).toBe("refused");
    // LINK_APP_MSG is 8,188 on a connection whose payload limit is 8,192.
    const limit = appMessageLimit(8192);
    expect(limit).toBe(8188);
    const fits = { t: "echo", pad: "" };
    fits.pad = "p".repeat(limit - JSON.stringify(fits).length);
    expect(JSON.stringify(fits).length).toBe(8188);
    expect(await guest.request("echo", { pad: fits.pad }).reply).toBeDefined();
    expect((await fails(guest.request("echo", { pad: `${fits.pad}p` }).reply)).code).toBe("too_large");
    expect(guest.emit("note", { pad: `${fits.pad}pp` })).toBe(false);
    // A receiver that still meets one (8,193 bytes on a 16 KiB connection) answers the request too_large.
    const wide = await world({ hub: { daemons: echo.factory } });
    await wide.link();
    const wideGuest = wide.device.openChannel(APP, HASH);
    await until(() => wideGuest.state().state === "open", "the channel");
    const peer = wide.device.peer!;
    const over = { t: "echo", pad: "" };
    over.pad = "p".repeat(8193 - JSON.stringify(over).length);
    const json = new TextEncoder().encode(JSON.stringify(over));
    expect(json.length).toBe(8193);
    const raw = new Uint8Array(4 + json.length);
    new DataView(raw.buffer).setUint32(0, wideGuest.channel!.id, true);
    raw.set(json, 4);
    const id = peer.ids.take();
    const reply = new Promise<string>((resolve) => {
      const carrier = wide.carriers.at(-1) as HeldCarrier;
      const previous = carrier.onData;
      carrier.onData = (bytes) => {
        for (let at = 0; at + 12 <= bytes.length; ) {
          const view = new DataView(bytes.buffer, bytes.byteOffset + at);
          const length = view.getUint32(4, true);
          if (bytes[at] === LINK2_FRAME.reply && view.getUint32(8, true) === id) resolve(new TextDecoder().decode(bytes.subarray(at + 12, at + 12 + length)));
          at += 12 + length;
        }
        previous(bytes);
      };
    });
    peer.enqueue(encodeRawFrame(LINK2_FRAME.request, 0x02, 0, id, raw));
    expect(JSON.parse(await reply).code).toBe("too_large");
    expect(wide.device.status.phase).toBe("linked");
  });

  test("a stream nobody reads: its sender gives up after 30 s with RESET cancelled, and the channel stays", async () => {
    const taken: StreamReader[] = [];
    const echo = echoDaemon((channel) => channel.onEvent("upload", (_args, stream) => void taken.push(stream!)));
    const w = await world({ hub: { daemons: echo.factory } });
    await w.link();
    const guest = w.device.openChannel(APP, HASH);
    await until(() => guest.state().state === "open", "the channel");
    const out = guest.emitStream("upload")!;
    out.write(pattern(1000));
    await until(() => taken.length === 1, "the daemon holding the stream");
    await w.advance(LINK2_REQUEST_STALL_MS + 2000);
    expect((await fails(out.finished)).message).toContain("cancelled");
    await until(() => taken[0] !== undefined, "the reader");
    expect((await fails(taken[0].read())).extra.reset).toBe("cancelled");
    expect(guest.state().state).toBe("open");
  });

  test("the ninth open request on a channel is answered busy; a second carrier adapter joins the two ends in memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-link-2-"));
    const clock = { t: 5_000_000 };
    const now = () => clock.t;
    const hub = new LinkHub({
      name: "Pipe Hub",
      now,
      daemons: () => ({
        attach(channel) {
          channel.on("hang", () => new Promise<Json>(() => {}));
        },
      }),
    });
    await hub.setup(directoryStorage(dir), { kind: "ftp", localAddress: "10.0.0.5" }, 8628);
    const device = new LinkDevice({
      dir,
      name: "Sim",
      model: "sim",
      target: "sim",
      hostAbi: 12,
      now,
      beaconPort: null,
      // A carrier that offers 1 KiB, as a UART at 115,200 baud would.
      connect: async () => {
        const [deviceEnd, hubEnd] = pipeCarriers({ maxPayload: 1024, address: "10.0.0.9" }, { maxPayload: 1024, address: "10.0.0.5" });
        hub.accept(hubEnd);
        return deviceEnd;
      },
    });
    cleanups.push(() => {
      device.stop();
      hub.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    expect(device.paired[0].address).toBe("10.0.0.5");
    // The beacon came from another address than the key file holds: the device writes `.last`, never the key file.
    const keyFile = readFileSync(join(dir, "companions", `${hub.id}.txt`), "utf8");
    device.connectTo(hub.id, "10.0.0.7", 9000);
    await until(() => device.status.phase === "linked", "the link over the pipe");
    expect(device.peer!.limit).toBe(1024);
    expect(readFileSync(join(dir, "companions", `${hub.id}.last`), "utf8")).toBe("name=Pipe Hub\naddress=10.0.0.7\nport=9000\n");
    expect(readFileSync(join(dir, "companions", `${hub.id}.txt`), "utf8")).toBe(keyFile);
    const guest = device.openChannel(APP, HASH);
    await until(() => guest.state().state === "open", "the channel");
    const calls = Array.from({ length: 9 }, () => guest.request("hang"));
    expect((await fails(calls[8].reply)).code).toBe("busy");
    for (const call of calls.slice(0, 8)) call.cancel();
    for (const call of calls.slice(0, 8)) expect((await fails(call.reply)).code).toBe("cancelled");
    // The places are free again: Hub answered each CANCEL itself.
    const again = guest.request("hang");
    await pause(10);
    again.cancel();
    expect((await fails(again.reply)).code).toBe("cancelled");
  });
});

