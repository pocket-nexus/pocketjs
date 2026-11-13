// Pocket Link 2: the reference device (tools/pocket-link/v2/device.ts)
// against the reference Hub (tools/pocket-link/v2/hub.ts) in one process,
// over in-memory carriers that cut the byte stream as a socket may: several
// writes in one read, or one byte per read. No socket is opened.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINK2_APP_OUTBOUND, LINK2_PAIR_WINDOW_MS, LINK2_TCP_PAYLOAD, type Link2InstalledApp, type Link2RuntimeStatus } from "../contracts/spec/link2.ts";
import { type Carrier, pipeCarriers } from "../tools/pocket-link/v2/carrier.ts";
import { type GuestChannel, LinkDevice, type RuntimeHandlers } from "../tools/pocket-link/v2/device.ts";
import { type Daemon, type HubDevice, LinkHub, MemoryStore, directoryStorage } from "../tools/pocket-link/v2/hub.ts";
import { type AppletChannel, type Json, LinkError, type StreamReader } from "../tools/pocket-link/v2/peer.ts";
import { formatCompanionFile } from "../tools/pocket-link/v2/pairing.ts";
import {
  Link2FrameDecoder,
  devicePreamble,
  encodeHandshake,
  encodePing,
  encodePreamble,
  pairCompanionProof,
  pairConsoleProof,
  pairMaskKey,
  parseJsonPayload,
  parsePairOffer,
  refused,
} from "../tools/pocket-link/v2/protocol.ts";
import { VECTOR_DIR } from "../tools/pocket-link/v2/vectors.ts";

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(what: () => unknown, label: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await pause(2);
  }
}
const pattern = (length: number, seed: number) => new Uint8Array(length).map((_, i) => (i * 31 + seed) & 255);

/**
 * Two carriers joined in memory that cut the stream as a socket read may.
 * `turn`: every write of one turn of the event loop arrives as one chunk on a
 * later turn, as a read that finds several segments waiting. `bytes`: the
 * same bytes, one per `onData` call.
 */
function cutCarriers(cut: "turn" | "bytes", deviceWrite?: (bytes: Uint8Array) => Uint8Array): [Carrier, Carrier] {
  let open = true;
  const make = (): Carrier => ({ maxPayload: LINK2_TCP_PAYLOAD, localAddress: "127.0.0.1", remoteAddress: "127.0.0.1", write() {}, onData: () => {}, onClose: () => {}, close() {} });
  const device = make();
  const hub = make();
  const join = (from: Carrier, to: Carrier, change: (bytes: Uint8Array) => Uint8Array) => {
    let batch: Uint8Array[] = [];
    let written: (() => void)[] = [];
    from.write = (bytes, done) => {
      if (!open) return;
      batch.push(change(bytes.slice()));
      if (done) written.push(done);
      if (batch.length > 1) return;
      setImmediate(() => {
        const parts = batch;
        const callbacks = written;
        batch = [];
        written = [];
        if (!open) return;
        const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
        let at = 0;
        for (const part of parts) {
          all.set(part, at);
          at += part.length;
        }
        for (const callback of callbacks) callback();
        if (cut === "turn") to.onData(all);
        else for (const byte of all) if (open) to.onData(Uint8Array.of(byte));
      });
    };
    from.close = () => {
      if (!open) return;
      setImmediate(() => {
        if (!open) return;
        open = false;
        from.onClose();
        to.onClose();
      });
    };
  };
  join(device, hub, deviceWrite ?? ((bytes) => bytes));
  join(hub, device, (bytes) => bytes);
  return [device, hub];
}

const STATUS: Link2RuntimeStatus = { phase: "running", target: "3ds-dev", hostAbi: 12, slot: "a", address: "127.0.0.1", generation: 1, active: "", lastGood: "", running: "", frame: 1, app: null };

interface Pair {
  hub: LinkHub;
  device: LinkDevice;
  /** The device at Hub, once linked. */
  linked(): Promise<HubDevice>;
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function pair(options: { carriers: () => [Carrier, Carrier]; onDevice?: (device: HubDevice) => void; daemon?: Daemon; runtime?: RuntimeHandlers; features?: string[] }): Promise<Pair> {
  const dir = mkdtempSync(join(tmpdir(), "link2-reference-"));
  const hub = new LinkHub({ name: "Studio Mac", store: new MemoryStore("00000000000000aa"), beaconTargets: [], onDevice: options.onDevice, daemons: () => options.daemon ?? null });
  const setup = await hub.setup(directoryStorage(dir), { kind: "card", addresses: ["127.0.0.1"] });
  expect(setup.failed).toBe(false);
  const device = new LinkDevice({
    dir,
    name: "Test Console",
    model: "New Nintendo 3DS XL",
    target: "3ds-dev",
    hostAbi: 12,
    beaconPort: null,
    runtime: options.runtime ?? { status: () => STATUS },
    features: options.features,
    connect: async () => {
      const [mine, theirs] = options.carriers();
      hub.accept(theirs);
      return mine;
    },
  });
  cleanups.push(() => {
    device.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  device.connectTo(hub.id, "127.0.0.1", 8628);
  return {
    hub,
    device,
    async linked() {
      await until(() => hub.devices.size === 1 && device.status.phase === "linked", "the link");
      return [...hub.devices.values()][0];
    },
  };
}

describe("the frame behind ready (§3.3)", () => {
  for (const cut of ["turn", "bytes"] as const) {
    test(`Hub's first request in the write of ready, read ${cut === "turn" ? "in one chunk" : "one byte at a time"}: the device answers it and stays linked`, async () => {
      const first: { call: Promise<Link2RuntimeStatus> | null } = { call: null };
      // Hub sends the moment it has written `ready`: the request goes out in the same turn.
      const { device, linked } = await pair({ carriers: () => cutCarriers(cut), onDevice: (d) => (first.call = d.runtimeStatus()) });
      const at = await linked();
      expect(first.call).not.toBeNull();
      expect(await first.call).toEqual(STATUS);
      // A second request on the same link.
      expect(await at.runtimeStatus()).toEqual(STATUS);
      expect(device.status.closes).toEqual([]);
      expect(device.status.links).toBe(1);
      expect(at.closed).toBeNull();
    });
  }
  test("a PING the device wrote behind auth, in one chunk with it: Hub answers it after ready", async () => {
    const auth = new TextEncoder().encode('"t":"auth"');
    const hasAuth = (bytes: Uint8Array) => Buffer.from(bytes).includes(auth);
    let pinged = false;
    const { device, linked } = await pair({
      carriers: () =>
        cutCarriers("turn", (bytes) => {
          if (pinged || !hasAuth(bytes)) return bytes;
          pinged = true;
          const ping = encodePing(0x1234);
          const both = new Uint8Array(bytes.length + ping.length);
          both.set(bytes);
          both.set(ping, bytes.length);
          return both;
        }),
    });
    const at = await linked();
    expect(pinged).toBe(true);
    expect(await at.runtimeStatus()).toEqual(STATUS);
    expect(device.status.closes).toEqual([]);
    expect(at.closed).toBeNull();
  });
});

describe("runtime.remove (§6.2): the reference device against the reference Hub, case by case as the vectors give them", () => {
  // biome-ignore lint/suspicious/noExplicitAny: the vectors are JSON
  const v: any = JSON.parse(readFileSync(join(VECTOR_DIR, "requests.json"), "utf8")).runtimeRemove;
  /** A frame's JSON: its 12 header bytes are 24 hex digits. */
  const payload = (hex: string): Json => JSON.parse(Buffer.from(hex.slice(24), "hex").toString("utf8"));
  const outcome = (reply: Promise<Json>) => reply.then(() => null, (error: LinkError) => ({ code: error.code, reason: (error.extra.reason as string | undefined) ?? null }));
  const expected = (index: number) => ({ code: v.errors[index].code, reason: v.errors[index].reason });

  test("the REPLY and the report without the row; home, running, not_found, an install under way, a second state-changing request, storage; the id's limits; Hub's mutex", async () => {
    const installed = v.installed as Link2InstalledApp[];
    const running = installed.find((row) => row.id === v.running) as Link2InstalledApp;
    const deleted: string[] = [];
    let failStorage = false;
    const { device, hub, linked } = await pair({
      carriers: () => pipeCarriers(),
      runtime: {
        status: () => ({ ...STATUS, app: { id: running.id, output: running.output, title: "Map" } }),
        push: () => new Promise(() => {}),
        remove: async ({ id }) => {
          if (failStorage) throw new LinkError("storage", "the applet's slot could not be deleted");
          deleted.push(id);
        },
      },
    });
    device.setApps(installed);
    const at = await linked();
    // The device's timed rules: a report inside the second goes out at its end.
    device.start(20);
    await until(() => at.apps.length === installed.length, "the first report");
    expect(at.peer.inUse("runtime.remove")).toBe(true);

    // Hub takes its device mutex: a holder in place answers busy and nothing is sent.
    let release: () => void = () => {};
    const held = hub.locked(at.id, "a test holder", () => new Promise<void>((done) => (release = done)));
    await expect(at.remove(v.errors[0].id)).rejects.toMatchObject({ code: "busy", extra: { holder: "a test holder" } });
    release();
    await held;

    expect(await outcome(at.remove(v.errors[0].id))).toEqual(expected(0));
    expect(await outcome(at.remove(v.errors[1].id))).toEqual(expected(1));
    expect(await outcome(at.remove(v.errors[2].id))).toEqual(expected(2));

    // An install of the applet streams: Hub holds the device's install request open.
    let endInstall: (() => void) | null = null;
    at.peer.handle("install", () => new Promise<Json>((_, fail) => (endInstall = () => fail(new LinkError("not_found", "the test ends the install")))), { feature: "install" });
    const install = device.install(v.errors[3].id).then(() => "done", (error: LinkError) => error.code);
    await until(() => endInstall !== null, "the install at Hub");
    expect(await outcome(at.remove(v.errors[3].id))).toEqual(expected(3));
    (endInstall as unknown as () => void)();
    expect(await install).toBe("not_found");

    // A second state-changing request, as a Hub that breaks §8.3 sends it: the device's one slot answers busy.
    const push = at.peer.request({ t: "runtime.push", bytes: 1000, hash: "00000000000000aa" }, { feature: "runtime", body: true });
    push.reply.catch(() => {});
    await pause(10);
    expect(await outcome(at.peer.request({ t: "runtime.remove", id: v.errors[4].id }, { feature: "runtime.remove" }).reply)).toEqual(expected(4));
    push.cancel();
    await expect(push.reply).rejects.toMatchObject({ code: "cancelled" });

    failStorage = true;
    expect(await outcome(at.remove(v.errors[5].id))).toEqual(expected(5));
    failStorage = false;

    // The id's limits: one the device accepts and does not hold is not_found.
    for (const c of v.ids as { name: string; json: Json & { t: string }; accepted: boolean }[]) {
      expect(`${c.name}: ${(await outcome(at.peer.request(c.json, { feature: "runtime.remove" }).reply))?.code}`).toBe(`${c.name}: ${c.accepted ? "not_found" : "malformed"}`);
    }
    expect(deleted).toEqual([]);

    // The removal: the REPLY of the vectors, then the report of the smaller set.
    const [request, reply, report] = v.removed.map((step: { hex: string }) => payload(step.hex));
    expect(await at.remove(request.id as string)).toEqual(reply);
    expect(deleted).toEqual([request.id]);
    await until(() => at.apps.length === installed.length - 1, "the report without the row");
    expect(at.apps).toEqual(report.apps as unknown as Link2InstalledApp[]);
    expect(await outcome(at.remove(request.id as string))).toEqual({ code: "not_found", reason: null });
  });

  test("a device that does not list runtime.remove is never sent it; one sent anyway is answered unsupported", async () => {
    const { linked } = await pair({ carriers: () => pipeCarriers(), features: ["runtime", "apps"] });
    const at = await linked();
    expect(at.peer.inUse("runtime.remove")).toBe(false);
    await expect(at.remove("dev.example.notes")).rejects.toMatchObject({ code: "unsupported" });
    expect(await outcome(at.peer.request({ t: "runtime.remove", id: "dev.example.notes" }).reply)).toEqual(expected(6));
  });
});

/** A daemon that reads every stream the applet opens with `blob`, and keeps the bytes. */
function blobDaemon() {
  const got: { bytes: number[]; ended: boolean; error: string | null }[] = [];
  const channels: AppletChannel[] = [];
  const drain = async (stream: StreamReader, into: { bytes: number[]; ended: boolean; error: string | null }) => {
    try {
      for (;;) {
        const chunk = await stream.read();
        if (chunk === null) break;
        for (const byte of chunk) into.bytes.push(byte);
      }
      into.ended = true;
    } catch (error) {
      into.error = String(error);
    }
  };
  const daemon: Daemon = {
    attach(channel) {
      channels.push(channel);
      channel.onEvent("blob", (_args, stream) => {
        const into = { bytes: [] as number[], ended: false, error: null as string | null };
        got.push(into);
        if (stream) void drain(stream, into);
      });
      channel.on("upload", async (_args, call) => {
        const into = { bytes: [] as number[], ended: false, error: null as string | null };
        got.push(into);
        if (call.body) await drain(call.body, into);
        return { bytes: into.bytes.length };
      });
    },
  };
  return { daemon, got, channels };
}

async function openGuest(options: { daemon: Daemon }): Promise<{ guest: GuestChannel; at: HubDevice }> {
  const { device, linked } = await pair({ carriers: () => pipeCarriers(), daemon: options.daemon });
  const at = await linked();
  const guest = device.openChannel("dev.example.blob", "0123456789abcdef");
  await until(() => guest.state().state === "open", "the channel");
  return { guest, at };
}
const same = (got: number[], want: Uint8Array) => got.length === want.length && want.every((byte, i) => got[i] === byte);

describe("a stream writer waits for room in its channel's outbound queue (§7.6)", () => {
  test("one writeAll of 1 MiB on a stream an applet event opened arrives whole", async () => {
    const { daemon, got } = blobDaemon();
    const { guest } = await openGuest({ daemon });
    const bytes = pattern(1024 * 1024, 7);
    const writer = guest.emitStream("blob", { name: "one" });
    expect(writer).not.toBeNull();
    await writer!.writeAll(bytes);
    writer!.end();
    await writer!.finished;
    await until(() => got[0]?.ended, "the daemon's END");
    expect(same(got[0].bytes, bytes)).toBe(true);
  });
  test("two streams of one channel written at once both finish, with events emitted between", async () => {
    const { daemon, got } = blobDaemon();
    const { guest } = await openGuest({ daemon });
    const a = pattern(3 * LINK2_APP_OUTBOUND + 5, 1);
    const b = pattern(2 * LINK2_APP_OUTBOUND + 9, 2);
    const one = guest.emitStream("blob", { name: "a" })!;
    const two = guest.emitStream("blob", { name: "b" })!;
    const writes = Promise.all([one.writeAll(a).then(() => one.end()), two.writeAll(b).then(() => two.end())]);
    for (let i = 0; i < 20; i++) {
      guest.emit("note", { i });
      await pause(1);
    }
    await writes;
    await Promise.all([one.finished, two.finished]);
    await until(() => got.length === 2 && got.every((g) => g.ended), "both ENDs");
    expect(same(got[0].bytes, a)).toBe(true);
    expect(same(got[1].bytes, b)).toBe(true);
  });
  test("a request's body of 1 MiB written in one writeAll beside an event stream", async () => {
    const { daemon, got } = blobDaemon();
    const { guest } = await openGuest({ daemon });
    const body = pattern(1024 * 1024, 3);
    const side = pattern(LINK2_APP_OUTBOUND + 1, 4);
    const call = guest.request("upload", {}, { body: true });
    const stream = guest.emitStream("blob", { name: "side" })!;
    await Promise.all([call.body!.writeAll(body).then(() => call.body!.end()), stream.writeAll(side).then(() => stream.end())]);
    expect(await call.reply).toEqual({ bytes: body.length });
    await until(() => got.length === 2 && got.every((g) => g.ended), "both streams");
    expect(same(got.find((g) => g.bytes.length === body.length)!.bytes, body)).toBe(true);
  });
  test("Hub's response stream to an applet request: one writeAll larger than Hub's queue, beside an event stream toward the device", async () => {
    const size = 600 * 1024;
    const response = pattern(size, 5);
    const toDevice = pattern(300 * 1024, 6);
    const received: number[] = [];
    const side: number[] = [];
    let sideEnded = false;
    const daemon: Daemon = {
      attach(channel) {
        channel.on("fetch", async (_args, call) => {
          call.progress("head", { bytes: size });
          const out = call.respond();
          const other = channel.emitStream("blob", {})!;
          await Promise.all([out.writeAll(response), other.writeAll(toDevice).then(() => other.end())]);
          return { done: true };
        });
      },
    };
    const { guest } = await openGuest({ daemon });
    guest.onEvent("blob", (_args, stream) => {
      void (async () => {
        for (;;) {
          const chunk = await stream!.read();
          if (chunk === null) break;
          for (const byte of chunk) side.push(byte);
        }
        sideEnded = true;
      })();
    });
    let reading: Promise<void> | null = null;
    const call = guest.request("fetch", {}, {
      onProgress: (_t, _args, stream) => {
        if (stream === undefined || reading !== null) return;
        reading = (async () => {
          for (;;) {
            const chunk = await stream.read();
            if (chunk === null) break;
            for (const byte of chunk) received.push(byte);
          }
        })();
      },
    });
    expect(await call.reply).toEqual({ done: true });
    await reading;
    await until(() => sideEnded, "the event stream's END");
    expect(same(received, response)).toBe(true);
    expect(same(side, toDevice)).toBe(true);
  });
});

describe("pairing by a code the device shows (§3.11): the reference device against the reference Hub", () => {
  /** A device whose directory no Hub has set up, and a Hub that holds no record. */
  function unpaired(cut: "turn" | "bytes", change: { now?: () => number; answer?: (hub: Carrier) => void } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "link2-pair-"));
    const store = new MemoryStore("00000000000000aa");
    const asked: string[] = [];
    const gone: string[] = [];
    const hub = new LinkHub({ name: "Studio Mac", store, beaconTargets: [], onPairRequest: (request) => asked.push(request.device), onPairGone: (device) => gone.push(device) });
    const device = new LinkDevice({
      dir,
      name: "Test Tablet",
      model: "M5Stack Tab5",
      target: "tab5-home",
      hostAbi: 7,
      beaconPort: null,
      now: change.now,
      runtime: { status: () => STATUS },
      connect: async () => {
        const [mine, theirs] = cutCarriers(cut);
        if (change.answer) change.answer(theirs);
        else hub.accept(theirs);
        return mine;
      },
    });
    cleanups.push(() => {
      device.stop();
      hub.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const keyFile = join(dir, "companions", `${hub.id}.txt`);
    /** The owner opens a pairing and chooses the Hub its beacon named. */
    const ask = () => {
      expect(device.pairOpen()).toBe(true);
      device.hear(hub.id, "Studio Mac", "127.0.0.1", 8628);
      expect(device.pairAsk(hub.id)).toBe(true);
    };
    return { dir, store, hub, device, asked, gone, keyFile, ask };
  }
  const another = (code: string) => (code === "000000" ? "000001" : "000000");

  for (const cut of ["turn", "bytes"] as const) {
    test(`a wrong code, then the code: the device writes the key file and links (${cut})`, async () => {
      const c = unpaired(cut);
      c.device.start(5);
      // No code: nothing to ask. A code: the Hubs heard are listed, and one of them is asked.
      expect(c.device.pairAsk(c.hub.id)).toBe(false);
      expect(c.device.pair).toMatchObject({ state: "idle", code: "", hubs: [] });
      expect(c.device.pairOpen()).toBe(true);
      const code = c.device.pair.code;
      expect(code).toMatch(/^\d{6}$/);
      expect(c.device.pair).toMatchObject({ state: "open", tries: 3, hub: "", hubs: [] });
      expect(c.device.pairAsk(c.hub.id)).toBe(false);
      c.device.hear(c.hub.id, "Studio Mac", "127.0.0.1", 8628);
      expect(c.device.pair.hubs).toEqual([{ id: c.hub.id, name: "Studio Mac" }]);
      expect(c.device.pairAsk(c.hub.id)).toBe(true);
      expect(c.device.pair).toMatchObject({ state: "asking", code, hub: c.hub.id, hubName: "Studio Mac" });

      await until(() => c.hub.pairRequests().length === 1, "the request at Hub");
      expect(c.hub.pairRequests()[0]).toMatchObject({ device: c.device.id, name: "Test Tablet", model: "M5Stack Tab5", target: "tab5-home" });
      // Another code fails the device's check of the offer: one try spent, no record, no key file.
      await expect(c.hub.pair(c.device.id, another(code))).rejects.toMatchObject({ code: "bad_code" });
      expect(c.device.pair).toMatchObject({ state: "asking", code, tries: 2 });
      expect(c.store.list()).toEqual([]);
      expect(existsSync(c.keyFile)).toBe(false);

      // The device asks again with the same code; the code pairs.
      c.device.hear(c.hub.id, "Studio Mac", "127.0.0.1", 8628);
      await until(() => c.hub.pairRequests().length === 1, "the second request at Hub");
      await c.hub.pair(c.device.id, code);
      const record = c.store.get(c.device.id);
      expect(record).toMatchObject({ id: c.device.id, name: "Test Tablet", model: "M5Stack Tab5", target: "tab5-home", unconfirmed: false });
      expect(readFileSync(c.keyFile, "utf8")).toBe(formatCompanionFile({ key: record?.key ?? "", name: "Studio Mac", address: "127.0.0.1", port: 8628 }));
      expect(readdirSync(join(c.dir, "companions"))).toEqual([`${c.hub.id}.txt`]);

      // The pairing is the pairing of §3.1: the device links by the handshake.
      await until(() => c.hub.devices.size === 1 && c.device.status.phase === "linked", "the link");
      expect(c.device.pair).toMatchObject({ state: "paired", code: "", hub: c.hub.id, hubName: "Studio Mac", error: "" });
      expect(c.device.hub?.id).toBe(c.hub.id);
      expect(c.asked).toEqual([c.device.id, c.device.id]);
    });
  }

  test("three wrong codes drop the code: the device asks no more and Hub holds no record", async () => {
    const c = unpaired("turn");
    c.device.start(5);
    c.ask();
    const code = c.device.pair.code;
    for (let wrong = 1; wrong <= 3; wrong++) {
      c.device.hear(c.hub.id, "Studio Mac", "127.0.0.1", 8628);
      await until(() => c.hub.pairRequests().length === 1, `request ${wrong} at Hub`);
      await expect(c.hub.pair(c.device.id, another(code))).rejects.toMatchObject({ code: "bad_code" });
    }
    expect(c.device.pair).toMatchObject({ state: "failed", code: "", tries: 0, error: "a wrong code was entered too often" });
    expect(c.device.status.phase).toBe("idle");
    await pause(700);
    expect(c.hub.pairRequests()).toEqual([]);
    expect(c.store.list()).toEqual([]);
    // Its owner opens a pairing anew: another draw, three tries.
    expect(c.device.pairOpen()).toBe(true);
    expect(c.device.pair).toMatchObject({ state: "open", tries: 3, error: "" });
  });

  test("a request Hub's owner dismisses, one the device's owner leaves, and a code that runs out", async () => {
    let clock = 1_000_000;
    const c = unpaired("turn", { now: () => clock });
    const settle = async (what: () => unknown, label: string) => {
      await until(() => {
        c.device.tick();
        return what();
      }, label);
    };
    c.ask();
    await settle(() => c.hub.pairRequests().length === 1, "the request at Hub");
    c.hub.declinePair(c.device.id);
    await settle(() => c.device.pair.state === "failed", "the refusal at the device");
    expect(c.device.pair).toMatchObject({ code: "", error: "that computer dismissed the request" });
    expect(c.device.status.refusals).toEqual(["declined"]);
    expect(c.gone).toEqual([c.device.id]);

    // The device's owner leaves the page: the connection closes, and Hub's request with it.
    c.ask();
    await settle(() => c.hub.pairRequests().length === 1, "the second request at Hub");
    c.device.pairClose();
    expect(c.device.pair).toMatchObject({ state: "idle", code: "", error: "" });
    await settle(() => c.hub.pairRequests().length === 0, "the request gone at Hub");
    expect(c.gone).toEqual([c.device.id, c.device.id]);

    // A code lasts 5 minutes, asked or not.
    expect(c.device.pairOpen()).toBe(true);
    clock += LINK2_PAIR_WINDOW_MS - 1;
    c.device.tick();
    expect(c.device.pair).toMatchObject({ state: "open", leftMs: 1 });
    clock += 1;
    c.device.tick();
    expect(c.device.pair).toMatchObject({ state: "failed", code: "", leftMs: 0, error: "the code ran out" });
    expect(c.store.list()).toEqual([]);
  });

  test("a Hub from before §3.11 answers pair with refused malformed: the device says that Hub pairs by no code", async () => {
    const c = unpaired("turn", {
      answer: (hub) => {
        hub.onData = () => {
          const preamble = encodePreamble({ highest: 2, lowest: 2, selected: 2 });
          const frame = encodeHandshake(refused("malformed", "hello: not a hello"));
          const both = new Uint8Array(preamble.length + frame.length);
          both.set(preamble);
          both.set(frame, preamble.length);
          hub.write(both);
          hub.close();
        };
      },
    });
    expect(devicePreamble().length).toBe(8);
    c.ask();
    await until(() => c.device.pair.state === "failed", "the refusal at the device");
    expect(c.device.pair.error).toBe("that computer's Hub does not pair by a code");
  });

  test("a scripted device from the vectors: an accept under another key is refused and stores nothing; the right one stores the key the offer carried", async () => {
    const v = JSON.parse(readFileSync(join(VECTOR_DIR, "pair-by-code.json"), "utf8"));
    const step = (what: string) => v.transcript.find((s: { from: string; what: string }) => `${s.from} ${s.what}` === what);
    const store = new MemoryStore("00000000000000aa");
    const hub = new LinkHub({ name: "Studio Mac", store, beaconTargets: [] });
    cleanups.push(() => hub.stop());
    const pair = step("device pair").json as { device: string; nonce: string };

    /** The device's bytes of the vector, then the handshake messages Hub writes. */
    const ask = () => {
      const [mine, theirs] = cutCarriers("turn");
      const decoder = new Link2FrameDecoder();
      const messages: Record<string, unknown>[] = [];
      let preamble = true;
      let closed = false;
      mine.onClose = () => {
        closed = true;
      };
      mine.onData = (bytes) => {
        const body = preamble ? bytes.subarray(8) : bytes;
        preamble = false;
        for (const frame of decoder.push(body)) messages.push(parseJsonPayload(frame).object ?? {});
      };
      hub.accept(theirs);
      mine.write(new Uint8Array(Buffer.from(step("device preamble").hex + step("device pair").hex, "hex")));
      return { carrier: mine, messages, closed: () => closed };
    };

    // Hub mints the key and the nonce: the device reads both from the offer.
    const first = ask();
    await until(() => hub.pairRequests().length === 1, "the request at Hub");
    const refusal = hub.pair(pair.device, v.code).catch((error) => error);
    await until(() => first.messages.length === 1, "the offer");
    first.carrier.write(encodeHandshake(v.badAccept.json));
    expect(await refusal).toMatchObject({ code: "bad_proof" });
    await until(() => first.closed(), "Hub's close");
    expect(first.messages[1]).toMatchObject({ t: "refused", code: "bad_proof" });
    expect(store.list()).toEqual([]);

    const second = ask();
    await until(() => hub.pairRequests().length === 1, "the second request at Hub");
    const paired = hub.pair(pair.device, v.code);
    await until(() => second.messages.length === 1, "the second offer");
    const offer = parsePairOffer(second.messages[0]);
    expect(offer).toMatchObject({ companion: hub.id, name: "Studio Mac" });
    if (offer === null) throw new Error("no offer");
    expect(offer.proof).toBe(pairCompanionProof(v.code, pair.nonce, offer.nonce, pair.device, hub.id));
    const key = pairMaskKey(v.code, offer.key, pair.nonce, offer.nonce, pair.device, hub.id);
    expect(store.list()).toEqual([]);
    second.carrier.write(encodeHandshake({ t: "pair.accept", proof: pairConsoleProof(key, pair.nonce, offer.nonce, pair.device, hub.id) }));
    await paired;
    await until(() => second.closed(), "Hub's close behind pair.done");
    expect(second.messages[1]).toEqual({ t: "pair.done" });
    expect(store.get(pair.device)).toMatchObject({ ...v.record, key });
  });

  test("a device linked to one Hub pairs with a second: the first link ends, both key files stay, and it links to the Hub it paired with", async () => {
    const c = unpaired("turn");
    // The first Hub set the directory up, as for a card (§3.2).
    const first = new LinkHub({ name: "First Mac", store: new MemoryStore("00000000000000bb"), beaconTargets: [] });
    const setup = await first.setup(directoryStorage(c.dir), { kind: "card", addresses: ["127.0.0.1"] });
    expect(setup.failed).toBe(false);
    const hubs = new Map([[8628, c.hub], [8629, first]]);
    const device = new LinkDevice({
      dir: c.dir,
      name: "Test Tablet",
      model: "M5Stack Tab5",
      target: "tab5-home",
      hostAbi: 7,
      beaconPort: null,
      runtime: { status: () => STATUS },
      connect: async (_address, port) => {
        const [mine, theirs] = cutCarriers("turn");
        hubs.get(port)?.accept(theirs);
        return mine;
      },
    });
    cleanups.push(() => {
      device.stop();
      first.stop();
    });
    device.start(5);
    device.connectTo(first.id, "127.0.0.1", 8629);
    await until(() => first.devices.size === 1 && device.status.phase === "linked", "the link to the first Hub");
    writeFileSync(join(c.dir, "companions", `${c.hub.id}.last`), "name=Old\naddress=10.0.0.9\nport=1\n");

    expect(device.pairOpen()).toBe(true);
    device.hear(c.hub.id, "Studio Mac", "127.0.0.1", 8628);
    expect(device.pairAsk(c.hub.id)).toBe(true);
    await until(() => first.devices.size === 0, "the first link ended");
    await until(() => c.hub.pairRequests().length === 1, "the request at the second Hub");
    await c.hub.pair(device.id, device.pair.code);
    await until(() => c.hub.devices.size === 1 && device.status.phase === "linked", "the link to the second Hub");
    expect(device.hub?.id).toBe(c.hub.id);
    // The earlier pairing stays; a .last file of the new Hub's id is gone, so its key file's address holds.
    const files = readdirSync(join(c.dir, "companions"));
    expect(files.filter((name) => name.endsWith(".txt")).sort()).toEqual([`${first.id}.txt`, `${c.hub.id}.txt`].sort());
    expect(files).not.toContain(`${c.hub.id}.last`);
    expect(device.paired.map((companion) => companion.id).sort()).toEqual([first.id, c.hub.id].sort());
  });
});
