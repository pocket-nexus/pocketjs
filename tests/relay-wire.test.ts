import { expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import {
  RelayEndpoint,
  attachRelayChannel,
  attachRelayProvider,
  relaySocketChannel,
  serveRelayTcp,
  socketCanAdmit,
  type RelayProviderConnection,
} from "../tools/relay-wire.ts";
import {
  createRelaySession,
  type RelayTransportAdapter,
} from "../framework/src/relay/session.ts";
import { RelayRecordDecoder } from "../framework/src/relay/frame.ts";
import { RELAY_LIMITS, type RelayProtocolVersion, type RelayRxLimits } from "../contracts/spec/relay.ts";
const RX: RelayRxLimits = {
  maxWireBytes: 4096, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 32768,
  maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 2, maxScratchBytes: 262144,
};
const local = {
  versions: [[1, 0] as RelayProtocolVersion],
  profiles: [{ name: "map.raster", version: 1 }],
  codecs: [0, 1, 257],
  kinds: [1, 6],
  rxLimits: RX,
};

test("relay-wire: a provider over TCP completes the six-step handshake and an OPEN", async () => {
  const reached: string[] = [];
  const server = await serveRelayTcp({
    local: { ...local },
    authenticate: () => ({ id: "device-1", grants: ["pocket-map"] }),
    hooks: (peer) => ({
      onPhase: (phase) => reached.push(`${peer.id}:${phase}`),
    }),
  });

  // Guest side: raw socket + shared session machine.
  const socket = connect(server.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const guestChannel = relaySocketChannel(socket, { id: "companion", grants: ["pocket-map"] });
  const guestAdapter: RelayTransportAdapter = {
    peer: guestChannel.peer,
    trySend: (bytes) => (guestChannel.send(bytes) ? "accepted" : "busy"),
  };
  const guest = createRelaySession({
    role: "guest",
    transport: guestAdapter,
    local: { app: "pocket-map", ...local },
    pingIntervalMs: 10 ** 9, // keep this test free of ping frames
    stallMs: 10 ** 9,
  });
  const decoder = new RelayRecordDecoder(RELAY_LIMITS.bootstrapMaxWireBytes);
  socket.on("data", (rawChunk) => {
    const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : rawChunk;
    const pushed = decoder.push(chunk);
    if (!pushed.ok) throw new Error(pushed.code);
    for (const record of pushed.frames) guest.handleRecord(record);
  });

  const ready = guest.whenReady();
  expect(guest.hello().ok).toBe(true);
  await ready;
  expect(guest.phase).toBe("ready");
  expect(guest.negotiation?.version).toEqual([1, 0]);

  const opened = await guest.open({
    app: "pocket-map", namespace: "map/demo",
    profile: { name: "map.raster", version: 1 },
  });
  expect(opened.stream).toBe(1);
  expect(opened.namespace).toBe("map/demo");
  expect(reached).toContain("device-1:ready");

  guest.close();
  socket.destroy();
  await server.close();
});

test("relay-wire: authenticate() returning null destroys the socket before any HELLO", async () => {
  let connections = 0;
  const server = await serveRelayTcp({
    local: { ...local },
    authenticate: () => null,
    onConnection: () => { connections++; },
  });
  const socket = connect(server.port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("close", resolve));
  socket.destroy();
  await server.close();
  expect(connections).toBe(0);
});

test("relay-wire: attachRelayProvider tears down on a malformed (oversized) record", async () => {
  // In-memory channel pair; no TCP needed.
  const server = createServer();
  const protocolErrors: string[] = [];
  let serverSocket: Socket | undefined;
  const accepted = new Promise<void>((resolve) => {
    server.once("connection", (s) => { serverSocket = s; resolve(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");

  const client = connect(address.port, "127.0.0.1");
  await new Promise<void>((resolve) => client.once("connect", resolve));
  await accepted;

  const connection = attachRelayProvider({
    channel: relaySocketChannel(serverSocket!, { id: "d", grants: ["pocket-map"] }),
    local: { ...local },
    hooks: { onProtocolError: (code) => protocolErrors.push(code) },
  });
  // Forged length prefix far over the 4096 cap.
  const forged = Buffer.alloc(8);
  forged.writeUInt32LE(0x00100000, 0);
  client.write(forged);
  await new Promise<void>((resolve) => client.once("close", resolve));
  expect(protocolErrors).toEqual(["WIRE_TOO_LARGE"]);
  // No HELLO ever ran, so the disconnect leaves the machine at idle.
  expect(connection.session.phase).toBe("idle");
  client.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("relay-wire: a PING sent over the real socket is answered", async () => {
  const server = await serveRelayTcp({
    local: { ...local },
    authenticate: () => ({ id: "device-1", grants: ["pocket-map"] }),
  });
  const socket = connect(server.port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", resolve));

  // Large ping interval so the machine does not ping first; drive one ping
  // manually through a tiny wrapper clock is unnecessary — use the public
  // stats: after READY, schedule a ping via a near-zero interval instead.
  const guestChannel = relaySocketChannel(socket, { id: "companion", grants: ["pocket-map"] });
  const guestAdapter: RelayTransportAdapter = {
    peer: guestChannel.peer,
    trySend: (bytes) => (guestChannel.send(bytes) ? "accepted" : "busy"),
  };
  const guest = createRelaySession({
    role: "guest",
    transport: guestAdapter,
    local: { app: "pocket-map", ...local },
    pingIntervalMs: 5,
    stallMs: 10 ** 9,
  });
  const decoder = new RelayRecordDecoder(RELAY_LIMITS.bootstrapMaxWireBytes);
  socket.on("data", (rawChunk) => {
    const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : rawChunk;
    const pushed = decoder.push(chunk);
    if (!pushed.ok) throw new Error(pushed.code);
    for (const record of pushed.frames) guest.handleRecord(record);
  });
  guest.hello();
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no pong")), 3000);
    const check = () => {
      if (guest.getStats().pingsReceived > 0) { clearTimeout(t); resolve(); }
      else setTimeout(check, 10);
    };
    setTimeout(check, 10);
  });
  expect(guest.getStats().pingsReceived).toBeGreaterThan(0);
  guest.close();
  socket.destroy();
  await server.close();
  expect(guest.getStats().pingsReceived).toBeGreaterThan(0);
});

// --- Review 937 B-3: send() is an admission decision, not write()'s hint -----

/** Minimal Socket stand-in recording writes and exposing a controllable
 *  queue, so the admission boundary is deterministic (no kernel buffer). */
function fakeSocket(highWaterMark: number, queued: { bytes: number }) {
  const writes: number[] = [];
  const socket = {
    destroyed: false,
    writable: true,
    get writableLength() { return queued.bytes; },
    writableHighWaterMark: highWaterMark,
    setNoDelay() {},
    write(bytes: Uint8Array) { writes.push(bytes.length); queued.bytes += bytes.length; return queued.bytes < highWaterMark; },
    on() { return socket; },
    once() { return socket; },
    destroy() { socket.destroyed = true; },
    writes,
  };
  return socket as unknown as Socket & { writes: number[] };
}

test("B-3 channel: a busy frame is refused before socket.write and admitted again after drain", () => {
  const queued = { bytes: 0 };
  const socket = fakeSocket(128 * 1024, queued);
  const channel = relaySocketChannel(socket, { id: "p", grants: [] });
  const chunk = new Uint8Array(64 * 1024);

  // First 64 KiB: empty queue, admitted even though it alone reaches half
  // the mark; it is written exactly once, in order.
  expect(channel.send(chunk)).toBe(true);
  expect(socket.writes).toEqual([chunk.length]);

  // Second 64 KiB would meet/exceed the mark with a non-empty queue: busy
  // must mean "not taken" — write() is not called a second time.
  expect(channel.send(chunk)).toBe(false);
  expect(socket.writes).toEqual([chunk.length]);

  // Once the queue drains, the same frame is admitted and written.
  queued.bytes = 0;
  expect(channel.send(chunk)).toBe(true);
  expect(socket.writes).toEqual([chunk.length, chunk.length]);
});

test("B-3 socketCanAdmit: admission is queued==0 or queued+frame strictly below the mark", () => {
  const s = (writableLength: number, writableHighWaterMark: number) =>
    ({ writableLength, writableHighWaterMark }) as Pick<Socket, "writableLength" | "writableHighWaterMark">;
  const frame = new Uint8Array(4096);
  expect(socketCanAdmit(s(0, 16384), frame)).toBe(true);
  expect(socketCanAdmit(s(8192, 16384), frame)).toBe(true);   // 12288 < 16384
  expect(socketCanAdmit(s(12288, 16384), frame)).toBe(false); // 16384 == mark
  expect(socketCanAdmit(s(16000, 16384), frame)).toBe(false); // over mark
});

test("B-3 loopback: the frame whose send() returns busy is never delivered to the peer", async () => {
  // Real node:net, peer paused (Review 937 busy-896 invariant). If "busy"
  // meant not-admitted, the peer can never receive the busy frame.
  let serverSocket: Socket | undefined;
  const server = createServer((s) => { serverSocket = s; s.pause(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const client = await new Promise<Socket>((r) => {
    const c = connect(port, "127.0.0.1", () => r(c));
  });
  const channel = relaySocketChannel(client, { id: "peer", grants: [] });

  let total = 0;
  let busyAt = -1;
  const CHUNK = 64 * 1024;
  for (let i = 0; i < 400 && busyAt < 0; i++) {
    const frame = new Uint8Array(CHUNK).fill(i & 0xff);
    if (!channel.send(frame)) busyAt = i;
  }
  expect(busyAt).toBeGreaterThanOrEqual(0);

  await new Promise<void>((done) => {
    serverSocket!.on("data", (c: Buffer) => { total += c.length; });
    serverSocket!.resume();
    setTimeout(done, 1500);
  });
  channel.destroy(); client.destroy(); await new Promise<void>((r) => server.close(() => r()));
  console.log(`first busy at frame #${busyAt}; bytes delivered = ${total}; admitted cap = ${busyAt * CHUNK}`);
  expect(total).toBeLessThanOrEqual(busyAt * CHUNK);
});

// --- review 1070 B3: the adapter composes session, credit and resource layers --

test("B3 over TCP: a guest endpoint completes a resource.get and a subscribe through the composed provider adapter", async () => {
  const object = new Uint8Array(10000);
  for (let i = 0; i < object.length; i++) object[i] = (i * 7) & 0xff;
  const ref = { kind: 1, ns: "map/demo", key: "z/1", revision: "v1", rendition: "r5g6b5le-256-v1" };
  const gets: string[] = [];
  const server = await serveRelayTcp({
    local: { ...local },
    authenticate: () => ({ id: "device-1", grants: ["pocket-map"] }),
    onConnection: (connection) => { serverConnection = connection; },
    hooks: () => ({
      onGet: (request) => {
        gets.push((request.metadata.resource as { key: string }).key);
        serverConnection!.endpoint.replyObject(request, { ref, codec: 257, data: object, value: { width: 100 } });
      },
    }),
  });
  let serverConnection: RelayProviderConnection | undefined;

  const socket = connect(server.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const guestChannel = relaySocketChannel(socket, { id: "companion", grants: ["pocket-map"] });
  const guest = new RelayEndpoint({
    role: "guest",
    transport: { peer: guestChannel.peer, trySend: (bytes) => (guestChannel.send(bytes) ? "accepted" : "busy") },
    local: { app: "pocket-map", ...local },
    pingIntervalMs: 10 ** 9,
    stallMs: 10 ** 9,
  });
  attachRelayChannel(guest, guestChannel, { maxWireBytes: RX.maxWireBytes });

  const ready = guest.whenReady();
  expect(guest.hello().ok).toBe(true);
  await ready;
  const opened = await guest.open({ app: "pocket-map", namespace: "map/demo", profile: { name: "map.raster", version: 1 } });
  expect(opened.stream).toBe(1);

  const result = await new Promise<{ ok: boolean; value?: { data: Uint8Array; value?: unknown } }>((resolve) => {
    const started = guest.get(1, { kind: 1, ns: "map/demo", key: "z/1", rendition: "r5g6b5le-256-v1" },
      { accept: [257], maxObjectBytes: 131072 }, (r) => resolve(r as never));
    if (!("correlation" in started)) resolve({ ok: false });
  });
  expect(result.ok).toBe(true);
  expect(Buffer.compare(Buffer.from(result.value!.data), Buffer.from(object))).toBe(0);
  expect(result.value!.value).toEqual({ width: 100 });
  expect(gets).toEqual(["z/1"]);

  const subscribed = await new Promise<{ ok: boolean; value?: { subscription?: number } }>((resolve) => {
    guest.subscribe(1, { ns: "map/demo" }, "latest-snapshot", { onObject() {} }, (r) => resolve(r as never));
  });
  expect(subscribed).toEqual({ ok: true, value: { subscription: 1 } });
  // Credit came back over the socket: nothing in flight on either end once
  // the exchange settled.
  await new Promise((r) => setTimeout(r, 50));
  expect(guest.inspect()!.sender.ledgerView().inFlight(1)).toEqual({ frames: 0, bytes: 0 });
  const providerLedger = serverConnection!.endpoint.inspect()!.sender.ledgerView();
  expect(providerLedger.inFlight(1)).toEqual({ frames: 0, bytes: 0 });
  expect(providerLedger.releasedTotals(1)).toEqual(providerLedger.sentTotals(1));
  expect(providerLedger.sentTotals(1).frames).toBeGreaterThanOrEqual(3);

  guest.close();
  socket.destroy();
  await server.close();
});
