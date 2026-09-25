// Composed endpoint (framework/src/relay/endpoint.ts): the L1 session, the
// P3 credit/queue machines and the L2 resource layer over one transport,
// guest <-> provider, with credit accounting and resource state asserted on
// both ends (review 1070 B3).

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  RELAY_CODEC,
  RELAY_DELIVERY,
  RELAY_EFFECT,
  RELAY_ERROR,
  RELAY_INVALIDATE_SCOPE,
  RELAY_KIND,
  RELAY_OP,
  RELAY_STATUS,
  RELAY_TYPE,
  type RelayResourceRef,
  type RelayRxLimits,
} from "../contracts/spec/relay.ts";
import { RELAY_P3_ERROR } from "../framework/src/relay/credit.ts";
import {
  RelayEndpoint,
  relayControlSlice,
  relayStreamSlice,
  type RelayEndpointHooks,
  type RelayIncomingRequest,
} from "../framework/src/relay/endpoint.ts";
import { decodeFrame, encodeFrame } from "../framework/src/relay/frame.ts";
import type { RelayPublishedObject } from "../framework/src/relay/resource.ts";
import type {
  RelayLocalCapabilities,
  RelayScheduler,
  RelayTransportAdapter,
} from "../framework/src/relay/session.ts";
import type { ResourceResult } from "../framework/src/resource-cache.ts";

// --- deterministic infrastructure ----------------------------------------------

const RX: RelayRxLimits = {
  maxWireBytes: 4096, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 32768,
  maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 2, maxScratchBytes: 262144,
};
const PROFILE = { name: "map.raster", version: 1 };
const tileRef = (revision?: string): RelayResourceRef => ({
  kind: RELAY_KIND.TILE, ns: "map/demo", key: "webmercator/demo-raster/z14/x2621/y6332",
  ...(revision ? { revision } : {}), rendition: "r5g6b5le-256-v1",
});
const nodeSha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (n: number, seed = 1) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 131 + seed * 17) & 0xff;
  return out;
};

function fakeScheduler(): RelayScheduler & { advance(ms: number): void } {
  let now = 0;
  let nextId = 1;
  const jobs = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; jobs.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { jobs.delete(id); },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        let dueId = 0, dueAt = 0, dueFn: (() => void) | undefined;
        for (const [id, job] of jobs) {
          if (job.at <= until && (dueFn === undefined || job.at < dueAt)) { dueId = id; dueAt = job.at; dueFn = job.fn; }
        }
        if (dueFn === undefined) break;
        now = dueAt; jobs.delete(dueId); dueFn();
      }
      now = until;
    },
  };
}

function seededBytes(seed: number) {
  let counter = seed;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) { counter = (counter * 1103515245 + 12345) >>> 0; out[i] = (counter >>> 16) & 0xff; }
    return out;
  };
}

interface Captured { from: "guest" | "provider"; bytes: Uint8Array }

interface Link {
  guest: RelayEndpoint;
  provider: RelayEndpoint;
  clocks: { guest: ReturnType<typeof fakeScheduler>; provider: ReturnType<typeof fakeScheduler> };
  wire: Captured[];
  /** Per-direction "busy" switch for the fake transport. */
  busy: { guest: boolean; provider: boolean };
  /** Number of physical trySend calls refused by the busy switch. */
  busyReturns: { guest: number; provider: number };
  /** Sampled on every provider send: in-flight frames on stream 1. */
  providerInFlight: number[];
  settle(): Promise<void>;
}

function makeLink(opts: {
  sync?: boolean;
  guestRx?: Partial<RelayRxLimits>;
  providerRx?: Partial<RelayRxLimits>;
  guestHooks?: RelayEndpointHooks;
  providerHooks?: RelayEndpointHooks;
  framesPerPump?: number;
} = {}): Link {
  const wire: Captured[] = [];
  const busy = { guest: false, provider: false };
  const busyReturns = { guest: 0, provider: 0 };
  const providerInFlight: number[] = [];
  const caps = (app: string | undefined, rx: Partial<RelayRxLimits> | undefined): RelayLocalCapabilities => ({
    app, versions: [[1, 0]], profiles: [PROFILE],
    codecs: [RELAY_CODEC.NONE, RELAY_CODEC.JSON, RELAY_CODEC.R5G6B5LE, RELAY_CODEC.OPAQUE_BYTES],
    kinds: [RELAY_KIND.TILE, RELAY_KIND.TERMINAL_CELLS], rxLimits: { ...RX, ...rx },
  });
  const link: Partial<Link> = { wire, busy, busyReturns, providerInFlight };
  const route = (from: "guest" | "provider", raw: Uint8Array): "accepted" | "busy" | "offline" => {
    if (busy[from]) { busyReturns[from]++; return "busy"; }
    const copy = raw.slice();
    wire.push({ from, bytes: copy });
    if (from === "provider") providerInFlight.push(link.provider!.inspect()?.sender.ledgerView().inFlight(1).frames ?? 0);
    const target = from === "guest" ? link.provider! : link.guest!;
    if (opts.sync) target.handleRecord(copy);
    else queueMicrotask(() => target.handleRecord(copy));
    return "accepted";
  };
  const guestTransport: RelayTransportAdapter = { peer: { id: "companion", grants: ["pocket-map"] }, trySend: (b) => route("guest", b) };
  const providerTransport: RelayTransportAdapter = { peer: { id: "device-1", grants: ["pocket-map"] }, trySend: (b) => route("provider", b) };
  const clocks = { guest: fakeScheduler(), provider: fakeScheduler() };
  link.clocks = clocks;
  link.guest = new RelayEndpoint({
    role: "guest", transport: guestTransport, local: caps("pocket-map", opts.guestRx),
    scheduler: clocks.guest, randomBytes: seededBytes(0x47), hooks: opts.guestHooks, framesPerPump: opts.framesPerPump,
  });
  link.provider = new RelayEndpoint({
    role: "provider", transport: providerTransport, local: caps(undefined, opts.providerRx),
    scheduler: clocks.provider, randomBytes: seededBytes(0x50), hooks: opts.providerHooks, framesPerPump: opts.framesPerPump,
  });
  link.settle = async () => {
    // Microtask-queued delivery and scheduled flushes: drain until the wire
    // stops growing.
    for (let round = 0; round < 64; round++) {
      const before = wire.length;
      for (let i = 0; i < 16; i++) await Promise.resolve();
      if (wire.length === before) break;
    }
  };
  return link as Link;
}

async function connect(link: Link): Promise<number> {
  const ready = link.guest.whenReady();
  expect(link.guest.hello().ok).toBe(true);
  await link.settle();
  await ready;
  expect(link.guest.phase).toBe("ready");
  expect(link.provider.phase).toBe("ready");
  const opened = await link.guest.open({ app: "pocket-map", namespace: "map/demo", profile: PROFILE });
  await link.settle();
  return opened.stream;
}

const decoded = (link: Link, from?: "guest" | "provider") => link.wire
  .filter((f) => from === undefined || f.from === from)
  .map((f) => {
    const r = decodeFrame(f.bytes, { maxWireBytes: 65536 });
    if (!r.ok) throw new Error(r.code);
    return { from: f.from, ...r.frame };
  });

/** A provider that serves one in-memory object per key. */
function serveObjects(objects: Map<string, { ref: RelayResourceRef; codec: number; data: Uint8Array; value?: Record<string, unknown> }>, held?: RelayIncomingRequest[]): RelayEndpointHooks {
  return {
    onGet(request) {
      if (held) { held.push(request); return; }
      const ref = request.metadata.resource as RelayResourceRef;
      const object = objects.get(ref.key);
      if (!object) { provider(request).replyError(request, RELAY_ERROR.NOT_FOUND, `no ${ref.key}`); return; }
      const ifRevision = (request.metadata.args as { ifRevision?: string }).ifRevision;
      if (ifRevision !== undefined && ifRevision === object.ref.revision) { provider(request).replyNotModified(request, object.ref); return; }
      provider(request).replyObject(request, object);
    },
  };
}
// The hook closure needs the endpoint; tests set it after construction.
let currentProvider: RelayEndpoint | undefined;
const provider = (_r: RelayIncomingRequest) => currentProvider!;

const getObject = (link: Link, stream: number, ref: RelayResourceRef, maxObjectBytes = 131072) =>
  new Promise<ResourceResult<unknown>>((resolve) => {
    const started = link.guest.get(stream, ref, { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes }, resolve);
    if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
  });

// =============================================================================

test("B3 e2e: guest <-> provider over the composed endpoints: get + subscribe + invalidate, credit and resource state asserted", async () => {
  const objectBytes = bytes(12000, 3);
  const objects = new Map([[tileRef().key, { ref: tileRef("tile-v1"), codec: RELAY_CODEC.R5G6B5LE, data: objectBytes, value: { width: 100, height: 60 } }]]);
  const evicts: Record<string, unknown>[] = [];
  const link = makeLink({ providerHooks: { ...serveObjects(objects), onEvict: (m) => evicts.push(m) } });
  currentProvider = link.provider;
  const stream = await connect(link);
  expect(stream).toBe(1);

  // --- window slices agree on both ends: control quarter + the OPEN's per-stream window, capped
  const g = link.guest.inspect()!;
  const p = link.provider.inspect()!;
  const control = relayControlSlice(RX);
  expect(control).toEqual({ frames: 2, bytes: 8192 });
  const slice = relayStreamSlice(RX, [control], RX);
  expect(slice).toEqual({ frames: 6, bytes: 24576 });
  expect(g.allocations.get(1)).toEqual(slice);
  expect(p.allocations.get(1)).toEqual(slice);
  expect(g.sender.ledgerView().sliceOf(1)).toEqual(slice);
  expect(p.sender.ledgerView().sliceOf(1)).toEqual(slice);

  // --- the handshake's own control frames went through the P3 sender and their credit came back
  // guest sent READY + OPEN on stream 0 (2 normal frames), provider READY resp + OPEN resp.
  expect(g.sender.ledgerView().sentTotals(0)).toMatchObject({ frames: 2 });
  expect(g.sender.ledgerView().releasedTotals(0)).toMatchObject({ frames: 2 });
  expect(p.sender.ledgerView().sentTotals(0)).toMatchObject({ frames: 2 });
  expect(p.sender.ledgerView().releasedTotals(0)).toMatchObject({ frames: 2 });
  expect(g.sender.ledgerView().inFlight(0)).toEqual({ frames: 0, bytes: 0 });
  expect(p.sender.ledgerView().inFlight(0)).toEqual({ frames: 0, bytes: 0 });
  // HELLO/HELLO-response rode session 0 straight to the transport: seq 1 each, uncharged.
  const bootstrap = decoded(link).filter((f) => f.session === 0n);
  expect(bootstrap.map((f) => [f.from, f.metadata.op, f.seq])).toEqual([["guest", RELAY_OP.HELLO, 1], ["provider", RELAY_OP.HELLO, 1]]);

  // --- resource.get: request through credit admission, chunked reply through the window, assembled once
  const wireBefore = link.wire.length;
  const result = await getObject(link, stream, tileRef());
  await link.settle();
  expect(result.ok).toBe(true);
  if (!result.ok || !("value" in result)) throw new Error("get failed");
  const published = result.value as RelayPublishedObject;
  expect(published.ref).toEqual(tileRef("tile-v1"));
  expect(published.codec).toBe(RELAY_CODEC.R5G6B5LE);
  expect(Buffer.compare(Buffer.from(published.data), Buffer.from(objectBytes))).toBe(0);
  expect(published.digest).toBe(`sha256:${nodeSha(objectBytes)}`);
  expect(published.value).toEqual({ width: 100, height: 60 });
  // The wire: one REQUEST on stream 1 from the guest; N chunk RESPONSEs from the provider under the
  // 4096-byte control wire; relay.credit PUSHes on stream 0 back from the guest, cumulative.
  const exchange = decoded(link).slice(wireBefore);
  const request = exchange.filter((f) => f.from === "guest" && f.stream === 1);
  expect(request.map((f) => [f.type, f.metadata.op, f.seq])).toEqual([[RELAY_TYPE.REQUEST, RELAY_OP.RESOURCE_GET, 1]]);
  const chunks = exchange.filter((f) => f.from === "provider" && f.stream === 1);
  expect(chunks.length).toBe(4);
  chunks.forEach((c, i) => {
    expect(c.type).toBe(RELAY_TYPE.RESPONSE);
    expect(c.seq).toBe(i + 1);
    expect(c.correlation).toBe(request[0].correlation);
    expect(c.metadata.final).toBe(i === chunks.length - 1);
    expect(c.codec).toBe(RELAY_CODEC.R5G6B5LE);
  });
  const credits = exchange.filter((f) => f.from === "guest" && f.metadata.op === RELAY_OP.CREDIT && f.metadata.targetStream === 1);
  expect(credits.length).toBeGreaterThan(0);
  expect(credits.at(-1)!.metadata.framesReleased).toBe("0000000000000004");
  expect(credits.every((f) => f.stream === 0 && f.type === RELAY_TYPE.PUSH)).toBe(true);
  // Credit accounting: everything sent was released; nothing is in flight; slots and scratch are free.
  expect(g.sender.ledgerView().sentTotals(1)).toEqual({ frames: 1, bytes: request[0] ? link.wire.slice(wireBefore).find((f) => f.from === "guest")!.bytes.length : 0 });
  expect(g.sender.ledgerView().releasedTotals(1)).toEqual(g.sender.ledgerView().sentTotals(1));
  expect(p.sender.ledgerView().sentTotals(1).frames).toBe(4);
  expect(p.sender.ledgerView().releasedTotals(1)).toEqual(p.sender.ledgerView().sentTotals(1));
  expect(g.sender.ledgerView().inFlight(1)).toEqual({ frames: 0, bytes: 0 });
  expect(p.sender.ledgerView().inFlight(1)).toEqual({ frames: 0, bytes: 0 });
  expect(g.receiver.occupancy()).toEqual({ frames: 0, bytes: 0 });
  expect(p.receiver.occupancy()).toEqual({ frames: 0, bytes: 0 });
  expect(g.requests.active).toBe(0);
  expect(p.requests.active).toBe(0);
  expect(g.assembler!.stats()).toMatchObject({ assemblies: 0, stagedBytes: 0, published: 1 });
  expect(g.client!.stats()).toMatchObject({ pending: 0, entries: 1, protocolErrors: 0 });
  expect(g.client!.localEntry(tileRef())).toMatchObject({ revision: "tile-v1", stale: false });
  expect(p.demand.size).toBe(0);
  // The provider never had more than the stream slice in flight.
  expect(Math.max(...link.providerInFlight)).toBeLessThanOrEqual(slice.frames);

  // --- a conditional get for the held revision comes back notModified
  const revalidated = await new Promise<ResourceResult<unknown>>((resolve) => {
    link.guest.get(stream, tileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072, ifRevision: "tile-v1" }, resolve);
  });
  expect(revalidated).toEqual({ ok: true, value: { notModified: true, revision: "tile-v1" } });

  // --- subscribe (reliable-delta): the provider answers, the id is 1, the push channel is reserved
  const delivered: Array<{ revision?: string; resync: boolean; value: unknown }> = [];
  const ended: unknown[] = [];
  const subscribed = await new Promise<ResourceResult<{ subscription?: number }>>((resolve) => {
    link.guest.subscribe(stream, tileRef("tile-v1"), RELAY_DELIVERY.RELIABLE_DELTA, {
      onObject: (o, ctx) => delivered.push({ revision: o.ref.revision, resync: ctx.resyncRequired, value: o.value }),
      onEnd: (e) => ended.push(e),
    }, resolve);
  });
  await link.settle();
  expect(subscribed).toEqual({ ok: true, value: { subscription: 1 } });
  expect(g.client!.subscription(1)).toMatchObject({ stream: 1, delivery: RELAY_DELIVERY.RELIABLE_DELTA, revision: "tile-v1", resyncRequired: false });
  expect(p.authority!.subscriptionEntry(1)).toMatchObject({ stream: 1, active: true, ns: "map/demo" });
  expect(g.assembler!.stats().assemblies).toBe(1); // the push channel reservation

  // --- a snapshot push from the provider (chunked over the same window) reaches the subscriber once
  const pushBytes = bytes(9000, 5);
  const pushed = link.provider.pushObject({ stream, subscription: 1, ref: tileRef("tile-v2"), codec: RELAY_CODEC.R5G6B5LE, data: pushBytes, value: { width: 100, height: 45 } });
  expect(pushed).toEqual({ ok: true, frames: 3 });
  await link.settle();
  expect(delivered).toEqual([{ revision: "tile-v2", resync: false, value: { width: 100, height: 45 } }]);
  expect(g.client!.subscription(1)?.revision).toBe("tile-v2");
  expect(g.client!.localEntry(tileRef())).toMatchObject({ revision: "tile-v2", stale: false });
  expect(p.sender.ledgerView().releasedTotals(1)).toEqual(p.sender.ledgerView().sentTotals(1));
  expect(g.receiver.occupancy()).toEqual({ frames: 0, bytes: 0 });

  // --- invalidate (key scope) on the bound stream: the entry goes stale, the subscription needs resync
  link.provider.invalidate({ stream, scope: RELAY_INVALIDATE_SCOPE.KEY, ref: tileRef("tile-v2"), reason: "source changed" });
  await link.settle();
  expect(g.client!.localEntry(tileRef())).toMatchObject({ revision: "tile-v2", stale: true, generation: 1 });
  expect(g.client!.subscription(1)).toMatchObject({ revision: undefined, resyncRequired: true });
  const invalidateFrames = decoded(link, "provider").filter((f) => f.type === RELAY_TYPE.INVALIDATE);
  expect(invalidateFrames.map((f) => [f.stream, f.correlation, f.metadata.op])).toEqual([[1, 0, RELAY_OP.RESOURCE_INVALIDATE]]);
  // A delta on the invalidated base is delivered marked for resync and does not re-base.
  link.provider.pushObject({ stream, subscription: 1, ref: tileRef("tile-v3"), codec: RELAY_CODEC.R5G6B5LE, data: bytes(64, 7), baseRevision: "tile-v2" });
  await link.settle();
  expect(delivered.at(-1)).toMatchObject({ revision: "tile-v3", resync: true });
  expect(g.client!.subscription(1)).toMatchObject({ revision: undefined, resyncRequired: true });

  // --- unsubscribe: the provider drops the subscription, the guest frees the push channel
  const unsubscribed = await new Promise<ResourceResult<unknown>>((resolve) => { link.guest.unsubscribe(1, resolve); });
  await link.settle();
  expect(unsubscribed).toEqual({ ok: true, value: { subscription: undefined } });
  expect(p.authority!.subscriptionEntry(1)).toBeUndefined();
  expect(g.client!.subscription(1)).toBeUndefined();
  expect(g.assembler!.stats().assemblies).toBe(0);

  // --- cache.evict travels guest -> provider as an advisory on the namespace's stream
  link.guest.reportEvict(tileRef("tile-v2"), "budget");
  await link.settle();
  expect(evicts).toEqual([{ op: RELAY_OP.CACHE_EVICT, resource: tileRef("tile-v2"), args: { reason: "budget" } }]);
  expect(g.client!.localEntry(tileRef())).toBeUndefined();

  // --- liveness rides the sideband: pings consume no control window
  const controlSent = g.sender.ledgerView().sentTotals(0);
  link.clocks.guest.advance(2000);
  await link.settle();
  link.clocks.provider.advance(2000);
  await link.settle();
  expect(link.guest.session.getStats().pingsSent).toBeGreaterThanOrEqual(1);
  expect(link.provider.session.getStats().pingsReceived).toBeGreaterThanOrEqual(1);
  expect(g.sender.ledgerView().sentTotals(0)).toEqual(controlSent);
  expect(link.guest.protocolErrors).toBe(0);
  expect(link.provider.protocolErrors).toBe(0);

  // --- every (direction, stream) seq on the wire is contiguous from 1 on the pinned session
  const perLane = new Map<string, number[]>();
  for (const f of decoded(link)) {
    if (f.session === 0n) continue;
    const lane = `${f.from}:${f.stream}`;
    (perLane.get(lane) ?? perLane.set(lane, []).get(lane)!).push(f.seq);
  }
  for (const [lane, seqs] of perLane) seqs.forEach((s, i) => expect(s, `${lane} at ${i}`).toBe(i + 1));
});

test("B3 window: a six-chunk object over a two-frame stream slice flows only as credit returns; the provider holds the rest as bounded demand", async () => {
  const objectBytes = bytes(20000, 9);
  const objects = new Map([[tileRef().key, { ref: tileRef("v1"), codec: RELAY_CODEC.R5G6B5LE, data: objectBytes }]]);
  const link = makeLink({ providerHooks: serveObjects(objects), sync: false });
  currentProvider = link.provider;
  const ready = link.guest.whenReady();
  link.guest.hello();
  await link.settle();
  await ready;
  // The guest asks for a 2-frame per-stream window at OPEN; min(session, request) makes the slice 2.
  const opened = await link.guest.open({ app: "pocket-map", namespace: "map/demo", profile: PROFILE, rxLimits: { ...RX, windowFrames: 2, windowBytes: 8192 } });
  await link.settle();
  const p = link.provider.inspect()!;
  expect(p.allocations.get(opened.stream)).toEqual({ frames: 2, bytes: 8192 });

  const result = await getObject(link, opened.stream, tileRef());
  await link.settle();
  expect(result.ok).toBe(true);
  if (!result.ok || !("value" in result)) throw new Error("get failed");
  expect(Buffer.compare(Buffer.from((result.value as RelayPublishedObject).data), Buffer.from(objectBytes))).toBe(0);
  const chunks = decoded(link, "provider").filter((f) => f.stream === opened.stream);
  expect(chunks.length).toBe(6);
  expect(Math.max(...link.providerInFlight)).toBeLessThanOrEqual(2);
  expect(p.sender.ledgerView().releasedTotals(opened.stream)).toEqual(p.sender.ledgerView().sentTotals(opened.stream));
  expect(p.demand.size).toBe(0);
  // Credit came back in at least three rounds (2 frames per window).
  const credits = decoded(link, "guest").filter((f) => f.metadata.op === RELAY_OP.CREDIT && f.metadata.targetStream === opened.stream);
  expect(credits.length).toBeGreaterThanOrEqual(3);
  expect(credits.at(-1)!.metadata.framesReleased).toBe("0000000000000006");
});

test("B3 admission: the negotiated maxPending bounds outstanding gets with BUSY before any frame leaves; slots return when terminals are consumed", async () => {
  const held: RelayIncomingRequest[] = [];
  const link = makeLink({ providerRx: { maxPending: 2 }, providerHooks: serveObjects(new Map(), held) });
  currentProvider = link.provider;
  const stream = await connect(link);
  expect(link.guest.negotiation?.rxLimits.maxPending).toBe(2);
  const outcomes: Array<ResourceResult<unknown>> = [];
  const a = link.guest.get(stream, tileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 1024 }, (r) => outcomes.push(r));
  const b = link.guest.get(stream, { ...tileRef(), key: "b" }, { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 1024 }, (r) => outcomes.push(r));
  const c = link.guest.get(stream, { ...tileRef(), key: "c" }, { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 1024 }, (r) => outcomes.push(r));
  expect("correlation" in a && "correlation" in b).toBe(true);
  expect(c).toEqual({ ok: false, code: RELAY_ERROR.BUSY });
  await link.settle();
  expect(decoded(link, "guest").filter((f) => f.stream === stream).length).toBe(2);
  expect(held.length).toBe(2);
  expect(link.guest.inspect()!.requests.active).toBe(2);
  // Answer both: one object, one NOT_FOUND. Both slots free on both ends.
  link.provider.replyObject(held[0], { ref: tileRef("v1"), codec: RELAY_CODEC.R5G6B5LE, data: bytes(100) });
  link.provider.replyError(held[1], RELAY_ERROR.NOT_FOUND);
  await link.settle();
  expect(outcomes.length).toBe(2);
  expect(outcomes[0].ok).toBe(true);
  expect(outcomes[1]).toEqual({ ok: false, error: { code: RELAY_ERROR.NOT_FOUND, message: RELAY_ERROR.NOT_FOUND } });
  expect(link.guest.inspect()!.requests.active).toBe(0);
  expect(link.provider.inspect()!.requests.active).toBe(0);
  const again = link.guest.get(stream, { ...tileRef(), key: "c" }, { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 1024 }, (r) => outcomes.push(r));
  expect("correlation" in again).toBe(true);
  await link.settle();
  expect(held.length).toBe(3);
});

test("B3 wired B1: a malformed terminal sent through the real adapter ends the get as INVALID, frees the slot on both ends and returns its credit", async () => {
  const held: RelayIncomingRequest[] = [];
  const link = makeLink({ providerHooks: serveObjects(new Map(), held) });
  currentProvider = link.provider;
  const stream = await connect(link);
  const outcome = getObject(link, stream, tileRef());
  await link.settle();
  expect(held.length).toBe(1);
  // A schema-invalid successful terminal (unknown key) is a legal frame at L1.
  link.provider.respond({
    type: RELAY_TYPE.RESPONSE, stream, correlation: held[0].correlation,
    metadata: { op: RELAY_OP.RESOURCE_GET, resource: tileRef("v1"), status: RELAY_STATUS.OK, final: true, bogus: 1 },
  });
  await link.settle();
  expect(await outcome).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });
  const g = link.guest.inspect()!;
  const p = link.provider.inspect()!;
  expect(g.client!.stats()).toMatchObject({ pending: 0, protocolErrors: 1 });
  expect(g.assembler!.stats().assemblies).toBe(0);
  expect(g.requests.active).toBe(0);
  expect(p.requests.active).toBe(0);
  expect(p.sender.ledgerView().releasedTotals(stream)).toEqual(p.sender.ledgerView().sentTotals(stream));
  expect(g.receiver.occupancy()).toEqual({ frames: 0, bytes: 0 });
  // The session survives; the next get on the same stream works.
  const objects = new Map([[tileRef().key, { ref: tileRef("v2"), codec: RELAY_CODEC.R5G6B5LE, data: bytes(10) }]]);
  held.length = 0;
  const next = getObject(link, stream, tileRef());
  await link.settle();
  link.provider.replyObject(held[0], objects.get(tileRef().key)!);
  await link.settle();
  expect((await next).ok).toBe(true);
});

test("B3 CANCEL: request.cancel rides the sideband, the provider sees cancelRequested, and the one CANCELLED/none terminal frees both slots", async () => {
  const held: RelayIncomingRequest[] = [];
  const cancels: unknown[] = [];
  const link = makeLink({ providerHooks: { ...serveObjects(new Map(), held), onCancel: (c) => cancels.push(c) } });
  currentProvider = link.provider;
  const stream = await connect(link);
  const outcomes: Array<ResourceResult<unknown>> = [];
  const started = link.guest.get(stream, tileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 1024 }, (r) => outcomes.push(r));
  if (!("correlation" in started)) throw new Error("get refused");
  await link.settle();
  const controlSent = link.guest.inspect()!.sender.ledgerView().sentTotals(0);
  link.guest.cancel(started.correlation, "view unmounted");
  await link.settle();
  expect(cancels).toEqual([{ targetStream: stream, correlation: started.correlation, reason: "view unmounted", request: expect.objectContaining({ cancelRequested: true }) }]);
  expect(held[0].cancelRequested()).toBe(true);
  // The CANCEL frame: type 4, stream 0, the request's correlation, no control window charged.
  const cancelFrames = decoded(link, "guest").filter((f) => f.type === RELAY_TYPE.CANCEL);
  expect(cancelFrames.map((f) => [f.stream, f.correlation, f.metadata.targetStream])).toEqual([[0, started.correlation, stream]]);
  expect(link.guest.inspect()!.sender.ledgerView().sentTotals(0)).toEqual(controlSent);
  // No terminal yet: the slot is held on both ends (§3.9).
  expect(link.guest.inspect()!.requests.active).toBe(1);
  expect(link.provider.inspect()!.requests.active).toBe(1);
  link.provider.replyError(held[0], RELAY_ERROR.CANCELLED, "cancelled", RELAY_EFFECT.NONE);
  await link.settle();
  expect(outcomes).toEqual([{ ok: false, error: { code: RELAY_ERROR.CANCELLED, message: "cancelled" } }]);
  expect(link.guest.inspect()!.requests.active).toBe(0);
  expect(link.provider.inspect()!.requests.active).toBe(0);
  expect(link.guest.protocolErrors).toBe(0);
});

test("C13 sync transport: the guest HELLO and provider HELLO response are each sent once", async () => {
  const link = makeLink({ sync: true });
  const ready = link.guest.whenReady();
  expect(link.guest.hello()).toEqual({ ok: true });
  await link.settle();
  await ready;

  const hello = decoded(link).filter((f) => f.session === 0n && f.metadata.op === RELAY_OP.HELLO);
  expect(hello.filter((f) => f.from === "guest" && f.type === RELAY_TYPE.REQUEST)).toHaveLength(1);
  expect(hello.filter((f) => f.from === "provider" && f.type === RELAY_TYPE.RESPONSE)).toHaveLength(1);
  expect(link.guest.phase).toBe("ready");
  expect(link.provider.phase).toBe("ready");
});

test("B3 sync transport: nested delivery inside trySend keeps the handshake, a get, a subscribe and a push correct", async () => {
  const objects = new Map([[tileRef().key, { ref: tileRef("v1"), codec: RELAY_CODEC.R5G6B5LE, data: bytes(5000, 2) }]]);
  const link = makeLink({ sync: true, providerHooks: serveObjects(objects) });
  currentProvider = link.provider;
  const stream = await connect(link);
  const result = await getObject(link, stream, tileRef());
  await link.settle();
  expect(result.ok).toBe(true);
  if (!result.ok || !("value" in result)) throw new Error("get failed");
  expect((result.value as RelayPublishedObject).data.length).toBe(5000);
  const pushed: RelayPublishedObject[] = [];
  const subscribed = await new Promise<ResourceResult<{ subscription?: number }>>((resolve) => {
    link.guest.subscribe(stream, { ns: "map/demo" }, RELAY_DELIVERY.LATEST_SNAPSHOT, { onObject: (object) => pushed.push(object) }, resolve);
  });
  expect(subscribed).toEqual({ ok: true, value: { subscription: 1 } });
  const pushData = bytes(5000, 3);
  expect(link.provider.pushObject({
    stream, subscription: 1, ref: tileRef("v2"), codec: RELAY_CODEC.R5G6B5LE, data: pushData,
  })).toMatchObject({ ok: true });
  expect(pushed).toHaveLength(1);
  expect(pushed[0].ref.revision).toBe("v2");
  expect(pushed[0].data).toEqual(pushData);
  const synchronousFrames = decoded(link).filter((f) => f.session !== 0n);
  expect(synchronousFrames.filter((f) => f.metadata.op === "resource.push").length).toBeGreaterThan(1);
  expect(synchronousFrames.some((f) => f.metadata.op === RELAY_OP.CREDIT)).toBe(true);
  const g = link.guest.inspect()!;
  const p = link.provider.inspect()!;
  expect(g.sender.ledgerView().inFlight(stream)).toEqual({ frames: 0, bytes: 0 });
  expect(p.sender.ledgerView().inFlight(stream)).toEqual({ frames: 0, bytes: 0 });
  expect(g.outboxFrames + p.outboxFrames).toBe(0);
  for (const [lane, seqs] of Object.entries(decoded(link).filter((f) => f.session !== 0n).reduce<Record<string, number[]>>((acc, f) => {
    (acc[`${f.from}:${f.stream}`] ??= []).push(f.seq); return acc;
  }, {}))) seqs.forEach((s, i) => expect(s, `${lane} at ${i}`).toBe(i + 1));
});

test("C13 busy trySend retains the head frame and later sends queued requests once in order", async () => {
  const held: RelayIncomingRequest[] = [];
  const link = makeLink({ sync: true, providerHooks: serveObjects(new Map(), held) });
  currentProvider = link.provider;
  const stream = await connect(link);
  link.busy.guest = true;

  const first = link.guest.get(stream, tileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 16 }, () => {});
  const secondRef = { ...tileRef(), key: `${tileRef().key}-next` };
  const second = link.guest.get(stream, secondRef, { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 16 }, () => {});
  if (!("correlation" in first) || !("correlation" in second)) throw new Error("requests were not admitted");
  await link.settle();

  expect(link.busyReturns.guest).toBeGreaterThan(0);
  expect(held).toHaveLength(0);
  expect(decoded(link, "guest").filter((f) => f.stream === stream)).toHaveLength(0);
  expect(link.guest.inspect()!.outboxFrames).toBe(1);

  link.busy.guest = false;
  link.guest.flush();
  await link.settle();
  const requests = decoded(link, "guest").filter((f) => f.stream === stream && f.metadata.op === RELAY_OP.RESOURCE_GET);
  expect(requests.map((f) => f.correlation)).toEqual([first.correlation, second.correlation]);
  expect(requests.map((f) => f.seq)).toEqual([1, 2]);
  expect(held.map((r) => r.correlation)).toEqual([first.correlation, second.correlation]);
  expect(link.guest.inspect()!.outboxFrames).toBe(0);
});

test("B3 busy transport: frames stamped with seq wait in the ordered outbox and leave in order once the transport drains", async () => {
  const objects = new Map([[tileRef().key, { ref: tileRef("v1"), codec: RELAY_CODEC.R5G6B5LE, data: bytes(9000, 4) }]]);
  const link = makeLink({ providerHooks: serveObjects(objects) });
  currentProvider = link.provider;
  const stream = await connect(link);
  link.busy.provider = true;
  const outcome = getObject(link, stream, tileRef());
  await link.settle();
  const p = link.provider.inspect()!;
  expect(p.outboxFrames).toBeGreaterThan(0);
  expect(decoded(link, "provider").filter((f) => f.stream === stream).length).toBe(0);
  link.busy.provider = false;
  link.provider.flush();
  await link.settle();
  expect((await outcome).ok).toBe(true);
  const chunks = decoded(link, "provider").filter((f) => f.stream === stream);
  chunks.forEach((c, i) => expect(c.seq).toBe(i + 1));
  expect(link.provider.inspect()!.outboxFrames).toBe(0);
});

test("B3 reset: a seq hole on a business stream resets it on both ends, the slice returns to the window, and a new OPEN takes it", async () => {
  const resets: Array<[string, number, string]> = [];
  const link = makeLink({
    guestHooks: { onStreamReset: (s, r) => resets.push(["guest", s, r]) },
    providerHooks: { onStreamReset: (s, r) => resets.push(["provider", s, r]) },
  });
  currentProvider = link.provider;
  const stream = await connect(link);
  const ended: unknown[] = [];
  await new Promise<void>((resolve) => {
    link.guest.subscribe(stream, tileRef("v1"), RELAY_DELIVERY.LATEST_SNAPSHOT, { onObject() {}, onEnd: (e) => ended.push(e ?? null) }, () => resolve());
  });
  await link.settle();
  expect(link.provider.inspect()!.authority!.subscriptionsOn(stream).length).toBe(1);
  // A provider PUSH on stream 1 with seq 99 (stamped as if from the provider's session).
  const forged = encodeFrame({
    type: RELAY_TYPE.PUSH, codec: RELAY_CODEC.NONE, session: link.guest.session.sessionId, seq: 99, stream,
    correlation: 0, metadata: { op: "resource.push", resource: tileRef("v9"), subscription: 1, final: true, value: {} },
  }, { maxWireBytes: 4096 });
  if (!forged.ok) throw new Error(forged.code);
  link.guest.handleRecord(forged.bytes);
  await link.settle();
  expect(resets).toEqual([["guest", stream, "seq gap"], ["provider", stream, "peer: seq gap"]]);
  expect(ended).toEqual([null]);
  expect(link.guest.client!.subscription(1)).toBeUndefined();
  expect(link.provider.inspect()!.authority!.subscriptionsOn(stream)).toEqual([]);
  expect(link.guest.session.streamInfo(stream)).toBeUndefined();
  expect(link.provider.session.streamInfo(stream)).toBeUndefined();
  const resetFrames = decoded(link, "guest").filter((f) => f.metadata.op === RELAY_OP.RESET);
  expect(resetFrames.map((f) => [f.stream, f.metadata.targetStream])).toEqual([[0, stream]]);
  // The dead stream's slice is back: the next OPEN gets the full six frames again.
  const reopened = await link.guest.open({ app: "pocket-map", namespace: "map/demo", profile: PROFILE });
  await link.settle();
  expect(reopened.stream).toBe(2);
  expect(link.guest.inspect()!.allocations.get(2)).toEqual({ frames: 6, bytes: 24576 });
  expect(link.provider.inspect()!.allocations.get(2)).toEqual({ frames: 6, bytes: 24576 });
  expect(link.guest.inspect()!.sender.ledgerView().sliceOf(1)).toBeUndefined(); // RESET no longer retains a counter row
  expect(link.guest.inspect()!.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 1, correlation: 9, metadata: { op: "x" } }).code).toBe(RELAY_P3_ERROR.STREAM_DEAD);
  expect(link.guest.protocolErrors + link.provider.protocolErrors).toBe(0);
});

for (const sync of [false, true]) {
  test(`namespace stream churn beyond eight ids releases all retired accounting (${sync ? "sync" : "async"})`, async () => {
    const link = makeLink({ sync });
    let stream = await connect(link);
    const session = link.guest.session.sessionId;
    const retired: number[] = [];
    try {
      for (let replacement = 1; replacement <= 32; replacement++) {
        await new Promise<void>((resolve) => {
          link.guest.subscribe(stream, { ns: "map/demo" }, RELAY_DELIVERY.LATEST_SNAPSHOT, { onObject() {} }, result => {
            expect(result.ok).toBe(true);
            resolve();
          });
        });
        await link.settle();
        const old = stream;
        retired.push(old);
        const late = encodeFrame({
          type: RELAY_TYPE.PUSH, codec: RELAY_CODEC.NONE, session, seq: 99, stream: old, correlation: 0,
          metadata: { op: "resource.push", subscription: 1, final: true, resource: tileRef("old"), value: {} },
        });
        if (!late.ok) throw new Error(late.code);
        link.guest.resetStream(old, "namespace replaced");
        await link.settle();
        // The old record must not recreate a seq/window row or reset the
        // next binding, even when it arrives after that binding exists.
        const opened = await link.guest.open({ app: "pocket-map", namespace: "map/demo", profile: PROFILE });
        stream = opened.stream;
        await link.settle();
        expect(stream).toBe(old + 1);
        const errors = link.guest.protocolErrors + link.provider.protocolErrors;
        link.guest.handleRecord(late.bytes);
        link.provider.handleRecord(late.bytes);
        await link.settle();
        expect(link.guest.protocolErrors + link.provider.protocolErrors).toBe(errors);
        for (const endpoint of [link.guest, link.provider]) {
          const b = endpoint.inspect()!;
          expect(endpoint.session.sessionId).toBe(session);
          expect(endpoint.session.streamIds()).toEqual([stream]);
          expect([...b.allocations.keys()]).toEqual([0, stream]);
          expect(b.sender.ledgerView().streamIds()).toEqual([0, stream]);
          expect(b.creditTable.size).toBeLessThanOrEqual(2);
          expect(b.receiver.occupancy()).toEqual({ frames: 0, bytes: 0 });
          for (const id of retired) {
            expect(b.creditTable.counters(id)).toBeUndefined();
            expect(b.authority?.subscriptionsOn(id) ?? []).toEqual([]);
          }
          // Old credit cannot mint capacity on the replacement stream.
          const room = b.sender.ledgerView().available(stream);
          expect(b.sender.applyCredit({ targetStream: old, framesReleased: "0000000000000001", bytesReleased: "0000000000001000" }).ok).toBe(true);
          expect(b.sender.ledgerView().available(stream)).toEqual(room);
          expect(b.sender.admit({ type: RELAY_TYPE.REQUEST, stream: old, correlation: 9, metadata: { op: "x" } }).code).toBe(RELAY_P3_ERROR.STREAM_DEAD);
        }
      }
      expect(link.guest.protocolErrors + link.provider.protocolErrors).toBe(0);
    } finally { link.guest.close(); link.provider.close(); }
  });
}

test("B3 teardown: a fatal from the peer (credit out of range) closes the session, fails pending work and drops the per-session machines", async () => {
  const held: RelayIncomingRequest[] = [];
  const link = makeLink({ providerHooks: serveObjects(new Map(), held) });
  currentProvider = link.provider;
  const stream = await connect(link);
  const outcome = getObject(link, stream, tileRef());
  await link.settle();
  // A relay.credit claiming more frames than the guest sent on the stream,
  // stamped with the next stream-0 seq the guest expects from the provider.
  const bogusCredit = encodeFrame({
    type: RELAY_TYPE.PUSH, codec: RELAY_CODEC.NONE, session: link.guest.session.sessionId,
    seq: decoded(link, "provider").filter((f) => f.stream === 0 && f.session !== 0n).length + 1, stream: 0, correlation: 0,
    metadata: { op: RELAY_OP.CREDIT, targetStream: stream, framesReleased: "0000000000000009", bytesReleased: "0000000000000009" },
  }, { maxWireBytes: 4096 });
  if (!bogusCredit.ok) throw new Error(bogusCredit.code);
  link.guest.handleRecord(bogusCredit.bytes);
  expect(link.guest.phase).toBe("closed");
  expect(link.guest.protocolErrors).toBe(1);
  expect(link.guest.inspect()).toBeUndefined();
  expect(await outcome).toEqual({ ok: false, error: { code: RELAY_ERROR.RESYNC_REQUIRED } });
  expect(link.guest.get(stream, tileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 16 }, () => {})).toEqual({ ok: false, code: RELAY_ERROR.BUSY });
});
