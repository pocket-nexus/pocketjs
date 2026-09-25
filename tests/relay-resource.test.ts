import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sha256Hex, verifySha256Digest } from "../framework/src/relay/sha256.ts";
import { RelayChunkAssembler } from "../framework/src/relay/assembler.ts";
import { validateRelayMetadata } from "../framework/src/relay/metadata.ts";
import { RELAY_FRAME_ERROR, encodeFrame, prepareFrameBody } from "../framework/src/relay/frame.ts";
import {
  RELAY_MAX_FENCED_REVISIONS,
  RelayIdAllocator,
  RelayResourceAuthority,
  RelayResourceClient,
  createRelayResourceLoad,
  relayResourceKey,
  type RelayResourceEnvelope,
  type RelayResourceIncomingFrame,
  type RelayResourceWire,
} from "../framework/src/relay/resource.ts";
import { createResourceScheduler, type ResourceResult } from "../framework/src/resource-cache.ts";
import {
  RELAY_CODEC,
  RELAY_DELIVERY,
  RELAY_ERROR,
  RELAY_EVICT_REASON,
  RELAY_INVALIDATE_SCOPE,
  RELAY_KIND,
  RELAY_LIMITS,
  RELAY_OP,
  RELAY_STATUS,
  RELAY_TYPE,
  type RelayResourceRef,
} from "../contracts/spec/relay.ts";
import { stringToUtf8 } from "../framework/src/bytes.ts";

const nodeSha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const hex16 = (n: number) => n.toString(16).padStart(16, "0");
const zeros = (n: number) => new Uint8Array(n);

const tileRef = (revision = "tile-v1"): RelayResourceRef => ({
  kind: RELAY_KIND.TILE,
  ns: "map/demo",
  key: "webmercator/demo-raster/z14/x2621/y6332",
  revision,
  rendition: "r5g6b5le-256-v1",
});
const currentTileRef = (): RelayResourceRef => {
  const ref = tileRef();
  delete ref.revision;
  return ref;
};

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-2)
// ---------------------------------------------------------------------------

test("sha256 matches NIST short vectors", () => {
  expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Hex(stringToUtf8("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sha256Hex(stringToUtf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))
    .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

test("sha256 agrees with node across block boundaries", () => {
  for (const n of [1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 4096, 61440, 131072]) {
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) buf[i] = (i * 73 + 17) & 0xff;
    expect(sha256Hex(buf)).toBe(nodeSha(buf));
  }
});

test("verifySha256Digest checks the prefix and hex", () => {
  const bytes = stringToUtf8("abc");
  expect(verifySha256Digest(`sha256:${nodeSha(bytes)}`, bytes)).toBe(true);
  expect(verifySha256Digest(nodeSha(bytes), bytes)).toBe(false);
  expect(verifySha256Digest("sha256:00", bytes)).toBe(false);
  expect(verifySha256Digest(`sha256:${"0".repeat(64)}`, bytes)).toBe(false);
});

// ---------------------------------------------------------------------------
// RelayChunkAssembler
// ---------------------------------------------------------------------------

interface ChunkOpts {
  stream?: number; channel?: number; space?: "get" | "push";
  id?: number; offset?: number; total?: number;
  data: Uint8Array; final?: boolean; digest?: string; revision?: string; codec?: number;
}

function makeAssembler(limits = { maxAssemblies: 2, maxScratchBytes: 1 << 20 }) {
  return new RelayChunkAssembler(limits);
}

function chunk(a: RelayChunkAssembler, o: ChunkOpts) {
  const total = o.total ?? 131072;
  return a.push({
    stream: o.stream ?? 1,
    channel: o.channel ?? 1,
    space: o.space ?? "get",
    codec: o.codec ?? RELAY_CODEC.R5G6B5LE,
    resource: tileRef(o.revision),
    digest: o.digest,
    final: o.final ?? ((o.offset ?? 0) + o.data.length === total),
    transfer: { id: o.id ?? 1, offset: hex16(o.offset ?? 0), total: hex16(total) },
    data: o.data,
  });
}

const reserve = (a: RelayChunkAssembler, channel: number, maxTotal: number, stream = 1, space: "get" | "push" = "get") =>
  a.reserve({ stream, channel, space }, maxTotal);

test("assembler publishes a three-chunk 131072B object only at the final chunk", () => {
  const a = makeAssembler();
  expect(reserve(a, 1, 131072)).toEqual({ ok: true });
  const object = zeros(131072);
  const digest = `sha256:${nodeSha(object)}`;
  expect(chunk(a, { data: zeros(61440), offset: 0, digest })).toEqual({ ok: true, complete: false });
  expect(chunk(a, { data: zeros(61440), offset: 61440, digest })).toEqual({ ok: true, complete: false });
  // Half object is staged, never published.
  expect(a.stats()).toMatchObject({ assemblies: 1, stagedBytes: 131072, enqueued: 1, published: 0 });
  const p3 = chunk(a, { data: zeros(8192), offset: 122880, digest });
  expect(p3.ok).toBe(true);
  if (!p3.ok || !p3.complete) throw new Error("final chunk did not complete");
  expect(p3.bytes.length).toBe(131072);
  expect(p3.resource).toEqual(tileRef());
  // Committed staging bytes were freed at completion; the reservation awaits release.
  expect(a.stats()).toMatchObject({ assemblies: 1, stagedBytes: 131072, peakStagedBytes: 131072, enqueued: 1, published: 1, failed: 0 });
  expect(a.release({ stream: 1, channel: 1, space: "get" })).toBe(true);
  expect(a.stats()).toMatchObject({ assemblies: 0, stagedBytes: 0 });
});

test("assembler reserve-then-accept: a total above the reservation is TOO_LARGE", () => {
  const a = makeAssembler();
  expect(reserve(a, 1, 65536)).toEqual({ ok: true });
  expect(chunk(a, { data: zeros(61440), offset: 0, total: 131072 })).toEqual({ ok: false, code: RELAY_ERROR.TOO_LARGE });
  expect(a.stats()).toMatchObject({ assemblies: 0, stagedBytes: 0, enqueued: 1 });
});

test("assembler returns BUSY when all assembly slots are reserved", () => {
  const a = makeAssembler({ maxAssemblies: 2, maxScratchBytes: 1 << 20 });
  expect(reserve(a, 1, 200)).toEqual({ ok: true });
  expect(reserve(a, 2, 300)).toEqual({ ok: true });
  expect(a.stats().assemblies).toBe(2);
  expect(reserve(a, 3, 400)).toEqual({ ok: false, code: RELAY_ERROR.BUSY });
});

test("assembler returns BUSY when the scratch reservation would exceed the cap", () => {
  const a = makeAssembler({ maxAssemblies: 4, maxScratchBytes: 1000 });
  expect(reserve(a, 1, 600)).toEqual({ ok: true });
  expect(chunk(a, { channel: 1, data: zeros(100), total: 600 })).toMatchObject({ complete: false });
  expect(reserve(a, 2, 500)).toEqual({ ok: false, code: RELAY_ERROR.BUSY });
  expect(a.stats()).toMatchObject({ stagedBytes: 600, peakStagedBytes: 600 });
});

test("a first chunk at a nonzero offset is INVALID and drops the reservation", () => {
  const a = makeAssembler();
  expect(reserve(a, 1, 131072)).toEqual({ ok: true });
  expect(chunk(a, { data: zeros(100), offset: 61440 })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(a.stats()).toMatchObject({ assemblies: 0, enqueued: 1, failed: 1 });
});

test("overlapping and gap chunks reject the assembly and release its scratch", () => {
  const a = makeAssembler();
  expect(reserve(a, 1, 300)).toEqual({ ok: true });
  expect(chunk(a, { data: zeros(100), total: 300 })).toMatchObject({ ok: true });
  expect(chunk(a, { data: zeros(100), offset: 50, total: 300 })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(a.stats()).toMatchObject({ assemblies: 0, stagedBytes: 0, failed: 1 });
  expect(reserve(a, 1, 300)).toEqual({ ok: true });
  expect(chunk(a, { data: zeros(100), total: 300 })).toMatchObject({ ok: true });
  expect(chunk(a, { data: zeros(50), offset: 250, total: 300 })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
});

test("a chunk that changes resource identity, codec or total rejects the assembly", () => {
  const a = makeAssembler();
  expect(reserve(a, 1, 300)).toEqual({ ok: true });
  expect(chunk(a, { data: zeros(100), total: 300 })).toMatchObject({ ok: true });
  expect(chunk(a, { data: zeros(100), offset: 100, total: 300, revision: "tile-v2" }))
    .toEqual({ ok: false, code: RELAY_ERROR.INVALID });

  const b = makeAssembler();
  expect(reserve(b, 1, 400)).toEqual({ ok: true });
  expect(chunk(b, { data: zeros(100), total: 300 })).toMatchObject({ ok: true });
  expect(chunk(b, { data: zeros(100), offset: 100, total: 400 })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });

  const c = makeAssembler();
  expect(reserve(c, 1, 300)).toEqual({ ok: true });
  expect(chunk(c, { data: zeros(100), total: 300 })).toMatchObject({ ok: true });
  expect(chunk(c, { data: zeros(100), offset: 100, total: 300, codec: RELAY_CODEC.OPAQUE_BYTES }))
    .toEqual({ ok: false, code: RELAY_ERROR.INVALID });
});

test("a wrong final flag rejects the assembly", () => {
  const a = makeAssembler();
  expect(reserve(a, 1, 300)).toEqual({ ok: true });
  expect(chunk(a, { data: zeros(100), total: 300, final: true })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
});

test("reusing a transfer id for a second object on a channel rejects", () => {
  const a = makeAssembler();
  expect(reserve(a, 1, 300)).toEqual({ ok: true });
  expect(chunk(a, { id: 9, data: zeros(100), total: 100 })).toMatchObject({ complete: true });
  expect(chunk(a, { id: 9, data: zeros(100), total: 100 })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  // The rejected reuse dropped the reservation; a fresh reservation with a
  // new transfer id is accepted.
  expect(reserve(a, 1, 300)).toEqual({ ok: true });
  expect(chunk(a, { id: 10, data: zeros(100), total: 100 })).toMatchObject({ complete: true });
});

test("a digest mismatch fails; the committed object is never returned", () => {
  const a = makeAssembler();
  expect(reserve(a, 1, 100)).toEqual({ ok: true });
  const wrongDigest = `sha256:${"ab".repeat(32)}`;
  expect(chunk(a, { data: zeros(100), total: 100, digest: wrongDigest })).toMatchObject({ ok: false, code: RELAY_ERROR.INVALID });
  expect(a.stats()).toMatchObject({ published: 0, failed: 1, stagedBytes: 0 });
});

test("abortChannel drops a cancelled request reservation", () => {
  const a = makeAssembler();
  reserve(a, 7, 300, 1);
  reserve(a, 8, 300, 1);
  expect(a.abortChannel({ stream: 1, channel: 7, space: "get" })).toBe(1);
  expect(a.stats()).toMatchObject({ assemblies: 1, stagedBytes: 300 });
});

test("F3: get correlations and subscription ids are separate assembler id spaces", () => {
  const a = makeAssembler({ maxAssemblies: 2, maxScratchBytes: 1 << 20 });
  // get correlation 1 and push subscription id 1 coexist on the same stream.
  expect(a.reserve({ stream: 1, channel: 1, space: "get" }, 300)).toEqual({ ok: true });
  expect(a.reserve({ stream: 1, channel: 1, space: "push" }, 300)).toEqual({ ok: true });
  expect(a.stats().assemblies).toBe(2);
  // The same id inside one space still rejects as a duplicate reservation.
  expect(a.reserve({ stream: 1, channel: 1, space: "get" }, 300)).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  // Chunks land in the space they were reserved for, independently.
  expect(chunk(a, { channel: 1, space: "get", data: zeros(100), total: 100, id: 1 })).toMatchObject({ complete: true });
  expect(chunk(a, { channel: 1, space: "push", data: zeros(100), total: 100, id: 1 })).toMatchObject({ complete: true });
  expect(a.release({ stream: 1, channel: 1, space: "get" })).toBe(true);
  expect(a.release({ stream: 1, channel: 1, space: "push" })).toBe(true);
  expect(a.stats().assemblies).toBe(0);
});

// ---------------------------------------------------------------------------
// Strict metadata schemas (L2)
// ---------------------------------------------------------------------------

test("resource.get request schema rejects malformed args", () => {
  const good = {
    op: RELAY_OP.RESOURCE_GET,
    resource: tileRef(),
    args: { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 },
  };
  expect(validateRelayMetadata(`${RELAY_OP.RESOURCE_GET}.request`, good)).toBeNull();
  expect(validateRelayMetadata(`${RELAY_OP.RESOURCE_GET}.request`, {
    op: RELAY_OP.RESOURCE_GET, resource: tileRef(),
    args: { accept: [], maxObjectBytes: 131072 }, // empty accept
  })).not.toBeNull();
  expect(validateRelayMetadata(`${RELAY_OP.RESOURCE_GET}.request`, {
    op: RELAY_OP.RESOURCE_GET, resource: tileRef(),
    args: { accept: [257], maxObjectBytes: 131072, bogus: 1 }, // unknown arg
  })).not.toBeNull();
  expect(validateRelayMetadata(`${RELAY_OP.RESOURCE_GET}.request`, {
    op: RELAY_OP.RESOURCE_GET,
    args: { accept: [257], maxObjectBytes: 131072 }, // missing resource
  })).not.toBeNull();
});

test("subscribe and invalidate/evict schemas enforce enums and identity", () => {
  expect(validateRelayMetadata(`${RELAY_OP.RESOURCE_SUBSCRIBE}.request`, {
    op: RELAY_OP.RESOURCE_SUBSCRIBE,
    resource: tileRef(),
    args: { delivery: RELAY_DELIVERY.RELIABLE_DELTA },
  })).toBeNull();
  expect(validateRelayMetadata(`${RELAY_OP.RESOURCE_SUBSCRIBE}.request`, {
    op: RELAY_OP.RESOURCE_SUBSCRIBE,
    resource: tileRef(),
    args: { delivery: "once-in-a-while" },
  })).not.toBeNull();
  expect(validateRelayMetadata(RELAY_OP.RESOURCE_INVALIDATE, {
    op: RELAY_OP.RESOURCE_INVALIDATE,
    resource: tileRef(),
    args: { scope: RELAY_INVALIDATE_SCOPE.KEY },
  })).toBeNull();
  expect(validateRelayMetadata(RELAY_OP.RESOURCE_INVALIDATE, {
    op: RELAY_OP.RESOURCE_INVALIDATE,
    args: { scope: "everything" },
  })).not.toBeNull();
  expect(validateRelayMetadata(RELAY_OP.CACHE_EVICT, {
    op: RELAY_OP.CACHE_EVICT, resource: tileRef(), args: { reason: RELAY_EVICT_REASON.BUDGET },
  })).toBeNull();
  expect(validateRelayMetadata(RELAY_OP.CACHE_EVICT, {
    op: RELAY_OP.CACHE_EVICT, resource: tileRef(), args: { reason: "please" },
  })).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Wire harness
// ---------------------------------------------------------------------------

interface SentRequest {
  correlation: number;
  stream: number;
  metadata: Record<string, unknown>;
  data?: Uint8Array;
}

class FakeWire implements RelayResourceWire {
  correlation = 0;
  sent: SentRequest[] = [];
  advises: Record<string, unknown>[] = [];
  cancels: { stream: number; correlation: number; reason?: string }[] = [];
  /** When true, request admission is full (L1 window). */
  refuseRequest = false;

  request(stream: number, metadata: Record<string, unknown>, data?: Uint8Array): number {
    if (this.refuseRequest) return 0;
    const correlation = ++this.correlation;
    this.sent.push({ correlation, stream, metadata, data });
    return correlation;
  }
  advise(metadata: Record<string, unknown>): void {
    this.advises.push(metadata);
  }
  cancel(stream: number, correlation: number, reason?: string): void {
    this.cancels.push({ stream, correlation, reason });
  }
  lastRequest(): SentRequest {
    return this.sent[this.sent.length - 1];
  }
}

function makeClient(opts: { maxObjectBytes?: number; maxAssemblies?: number; maxScratchBytes?: number; codecs?: number[]; wire?: FakeWire } = {}) {
  const wire = opts.wire ?? new FakeWire();
  const assembler = new RelayChunkAssembler({
    maxAssemblies: opts.maxAssemblies ?? 8,
    maxScratchBytes: opts.maxScratchBytes ?? 4 * 1024 * 1024,
  });
  const client = new RelayResourceClient({
    wire,
    negotiated: {
      maxObjectBytes: opts.maxObjectBytes ?? 131072,
      codecs: opts.codecs ?? [RELAY_CODEC.NONE, RELAY_CODEC.JSON, RELAY_CODEC.R5G6B5LE, RELAY_CODEC.OPAQUE_BYTES],
      kinds: Object.values(RELAY_KIND),
    },
    assembler,
  });
  return { wire, assembler, client };
}

function toFrame(env: RelayResourceEnvelope, codec: number = RELAY_CODEC.NONE): RelayResourceIncomingFrame {
  return {
    type: env.type,
    codec: env.data && env.data.length ? codec : RELAY_CODEC.NONE,
    stream: env.stream,
    correlation: env.correlation,
    metadata: env.metadata,
    data: env.data ?? new Uint8Array(0),
  };
}

const feed = (client: RelayResourceClient, env: RelayResourceEnvelope, codec?: number) =>
  client.handleFrame(toFrame(env, codec));

/** The frames of one chunk plan; a refused plan fails the test. */
function chunks(auth: RelayResourceAuthority, input: Parameters<RelayResourceAuthority["chunkObject"]>[0]): RelayResourceEnvelope[] {
  const plan = auth.chunkObject(input);
  if (!plan.ok) throw new Error(`chunkObject refused: ${plan.message}`);
  return plan.frames;
}

// ---------------------------------------------------------------------------
// resource.get / notModified
// ---------------------------------------------------------------------------

test("get delivers a chunked object once, at the final frame, with the value every chunk repeated", () => {
  const { wire, client } = makeClient();
  const results: unknown[] = [];
  const r = client.get(1, tileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 },
    (result) => results.push(result));
  expect("correlation" in r).toBe(true);

  const auth = new RelayResourceAuthority({ maxWireBytes: 65536 });
  const data = zeros(131072);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
  const frames = chunks(auth, {
    type: RELAY_TYPE.RESPONSE, stream: 1, correlation: wire.lastRequest().correlation,
    ref: tileRef(), codec: RELAY_CODEC.R5G6B5LE, data,
    value: { width: 256, height: 256, logicalSize: 256 },
  });
  expect(frames.length).toBe(3);
  for (const f of frames.slice(0, 2)) {
    feed(client, f, RELAY_CODEC.R5G6B5LE);
    expect(results.length).toBe(0); // half object never visible
  }
  feed(client, frames[2], RELAY_CODEC.R5G6B5LE);
  expect(results.length).toBe(1);
  const out = results[0] as { ok: true; value: { data: Uint8Array; ref: RelayResourceRef; value?: unknown } };
  expect(out.ok).toBe(true);
  expect(out.value.data.length).toBe(131072);
  expect(out.value.data[123456]).toBe(123456 & 0xff);
  expect(out.value.ref.revision).toBe("tile-v1");
  expect(out.value.value).toEqual({ width: 256, height: 256, logicalSize: 256 });
});

test("get with ifRevision returns notModified and still names the revision", () => {
  const { wire, client } = makeClient();
  const results: unknown[] = [];
  client.get(1, tileRef("tile-v7"), {
    accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072, ifRevision: "tile-v7",
  }, (result) => results.push(result));

  const auth = new RelayResourceAuthority();
  feed(client, auth.answerNotModified(
    { stream: 1, correlation: wire.lastRequest().correlation },
    tileRef("tile-v7"),
  ));
  const out = results[0] as { ok: true; value: { notModified: true; revision: string } };
  expect(out.ok).toBe(true);
  expect(out.value).toEqual({ notModified: true, revision: "tile-v7" });
});

test("get rejects an unsupported codec or an over-ceiling object before sending", () => {
  const { client } = makeClient({ codecs: [RELAY_CODEC.NONE] });
  const r1 = client.get(1, tileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 100 }, () => {});
  expect(r1).toEqual({ ok: false, code: RELAY_ERROR.INVALID });

  const { client: c2 } = makeClient({ maxObjectBytes: 1000 });
  const r2 = c2.get(1, tileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 5000 }, () => {});
  expect(r2).toEqual({ ok: false, code: RELAY_ERROR.TOO_LARGE });
});

test("get returns BUSY when the L1 request window refuses admission", () => {
  const { client, wire } = makeClient();
  wire.refuseRequest = true;
  const r = client.get(1, tileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, () => {});
  expect(r).toEqual({ ok: false, code: RELAY_ERROR.BUSY });
});

test("a provider TOO_LARGE error terminates the get", () => {
  const { wire, client } = makeClient();
  const results: unknown[] = [];
  client.get(1, tileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, (result) => results.push(result));
  const auth = new RelayResourceAuthority();
  feed(client, auth.answerGetError({ stream: 1, correlation: wire.lastRequest().correlation }, RELAY_ERROR.TOO_LARGE));
  const out = results[0] as { ok: false; error: { code: string } };
  expect(out.ok).toBe(false);
  expect(out.error.code).toBe(RELAY_ERROR.TOO_LARGE);
  expect(client.stats().pending).toBe(0);
});

test("local assembler BUSY: once the assembly budget is full, a new get is refused with BUSY", () => {
  const { client } = makeClient({ maxAssemblies: 1, maxScratchBytes: 4 * 1024 * 1024 });
  const first = client.get(1, tileRef("a"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, () => {});
  expect("correlation" in first).toBe(true);
  // Second get cannot reserve the only assembler slot: refused BUSY before
  // any request is sent, so there is nothing to cancel.
  const second = client.get(1, tileRef("b"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, () => {});
  expect(second).toEqual({ ok: false, code: RELAY_ERROR.BUSY });
});

// ---------------------------------------------------------------------------
// subscribe / push / invalidation
// ---------------------------------------------------------------------------

test("a subscription reserves the push scratch it accepts, not the negotiated ceiling", () => {
  // Two subscriptions whose pushes are small documents leave the assembly
  // budget for the objects a consumer actually gets (§3.7). With the ceiling
  // reserved instead, the second get below would be refused BUSY.
  const { wire, client } = makeClient({ maxAssemblies: 3, maxScratchBytes: 131072 * 2 + 8192 });
  const auth = new RelayResourceAuthority();
  const accept = (label: string) => {
    const request = wire.lastRequest();
    const env = auth.answerSubscribe({ stream: 1, correlation: request.correlation, metadata: request.metadata });
    feed(client, env);
    return { label, id: (env.metadata.value as { subscription: number }).subscription };
  };
  const first = client.subscribe(1, { ns: "map/demo" }, RELAY_DELIVERY.LATEST_SNAPSHOT, { onObject: () => {} }, () => {}, { maxObjectBytes: 4096 });
  expect("correlation" in first).toBe(true);
  accept("catalog");
  const second = client.subscribe(1, { ns: "map/other" }, RELAY_DELIVERY.LATEST_SNAPSHOT, { onObject: () => {} }, () => {}, { maxObjectBytes: 4096 });
  expect("correlation" in second).toBe(true);
  accept("source");
  // 8,192 of the scratch is held by the two push channels; a 131,072-byte
  // get still fits, and so does a second one.
  expect("correlation" in client.get(1, tileRef("a"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, () => {})).toBe(true);
  expect(client.stats().subscriptions).toBe(2);
  // A subscription may not reserve more than the negotiated ceiling.
  expect(client.subscribe(1, { ns: "map/too-big" }, RELAY_DELIVERY.LATEST_SNAPSHOT, { onObject: () => {} }, () => {}, { maxObjectBytes: 131073 }))
    .toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(client.subscribe(1, { ns: "map/zero" }, RELAY_DELIVERY.LATEST_SNAPSHOT, { onObject: () => {} }, () => {}, { maxObjectBytes: 0 }))
    .toEqual({ ok: false, code: RELAY_ERROR.INVALID });
});

test("subscribe reliable-delta receives revision-increasing pushes in order", () => {
  const { wire, client } = makeClient();
  const objects: { revision?: string; resync: boolean }[] = [];
  let subscribed = 0;
  client.subscribe(1, tileRef("r1"), RELAY_DELIVERY.RELIABLE_DELTA, {
    onObject: (o, ctx) => objects.push({ revision: o.ref.revision, resync: ctx.resyncRequired }),
  }, (result) => { if (result.ok) subscribed++; });

  const auth = new RelayResourceAuthority();
  const subEnv = auth.answerSubscribe({ stream: 1, correlation: wire.lastRequest().correlation, metadata: wire.lastRequest().metadata });
  feed(client, subEnv);
  expect(subscribed).toBe(1);
  const subId = (subEnv.metadata.value as { subscription: number }).subscription;

  const push = (revision: string, baseRevision: string) => {
    const frames = chunks(auth, {
      type: RELAY_TYPE.PUSH, stream: 1, correlation: 0, subscription: subId,
      ref: tileRef(revision), codec: RELAY_CODEC.R5G6B5LE,
      data: zeros(100), baseRevision,
    });
    for (const f of frames) feed(client, f, RELAY_CODEC.R5G6B5LE);
  };
  push("r2", "r1");
  push("r3", "r2");
  expect(objects).toEqual([
    { revision: "r2", resync: false },
    { revision: "r3", resync: false },
  ]);
});

test("a reliable delta on the wrong base signals resync and does not advance revision", () => {
  const { wire, client } = makeClient();
  const objects: { revision?: string; resync: boolean }[] = [];
  client.subscribe(1, tileRef("r1"), RELAY_DELIVERY.RELIABLE_DELTA, {
    onObject: (o, ctx) => objects.push({ revision: o.ref.revision, resync: ctx.resyncRequired }),
  }, () => {});
  const auth = new RelayResourceAuthority();
  feed(client, auth.answerSubscribe({ stream: 1, correlation: wire.lastRequest().correlation, metadata: wire.lastRequest().metadata }));
  const id = 1; // the authority's first subscription id
  // r3 delta based on r9 while the client holds r1: broken chain.
  const frames = chunks(auth, {
    type: RELAY_TYPE.PUSH, stream: 1, correlation: 0, subscription: id,
    ref: tileRef("r3"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(100), baseRevision: "r9",
  });
  for (const f of frames) feed(client, f, RELAY_CODEC.R5G6B5LE);
  expect(objects).toEqual([{ revision: "r3", resync: true }]);
  // The held revision fence stays at r1 (no partial apply).
  expect(client.subscription(id)?.revision).toBe("r1");
});

test("out-of-order chunks never publish: a gap frame terminates the push with INVALID", () => {
  const { wire, client } = makeClient();
  let ended: string | undefined;
  client.subscribe(1, tileRef("r1"), RELAY_DELIVERY.LATEST_SNAPSHOT, {
    onObject: () => { throw new Error("must not publish a gapped object"); },
    onEnd: (e) => { ended = e?.code; },
  }, () => {});
  const auth = new RelayResourceAuthority();
  feed(client, auth.answerSubscribe({ stream: 1, correlation: wire.lastRequest().correlation, metadata: wire.lastRequest().metadata }));
  const id = 1;
  const frames = chunks(auth, {
    type: RELAY_TYPE.PUSH, stream: 1, correlation: 0, subscription: id,
    ref: tileRef("r2"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(200000),
  });
  // Deliver chunk 2 before chunk 1.
  expect(frames.length).toBeGreaterThan(1);
  feed(client, frames[1], RELAY_CODEC.R5G6B5LE);
  expect(ended).toBe(RELAY_ERROR.INVALID);
});

test("subscription ids are never reused after unsubscribe", () => {
  const auth = new RelayResourceAuthority();
  const mk = (n: number) => ({
    stream: 1, correlation: n,
    metadata: { op: RELAY_OP.RESOURCE_SUBSCRIBE, resource: tileRef(), args: { delivery: RELAY_DELIVERY.RELIABLE_DELTA } },
  });
  const e1 = auth.answerSubscribe(mk(1));
  const id1 = (e1.metadata.value as { subscription: number }).subscription;
  const e2 = auth.answerSubscribe(mk(2));
  const id2 = (e2.metadata.value as { subscription: number }).subscription;
  expect(id2).toBe(id1 + 1);
  const un = auth.answerUnsubscribe({ stream: 1, correlation: 3, metadata: { op: RELAY_OP.RESOURCE_UNSUBSCRIBE, args: { subscription: id1 } } });
  expect(un.metadata.status).toBe(RELAY_STATUS.OK);
  const e3 = auth.answerSubscribe(mk(4));
  const id3 = (e3.metadata.value as { subscription: number }).subscription;
  expect(id3).toBe(id2 + 1); // not id1
  expect([id1, id2, id3]).toEqual([1, 2, 3]);
});

test("unsubscribe then a queued push is consumed and dropped", () => {
  const { wire, client } = makeClient();
  let published = 0;
  client.subscribe(1, tileRef("r1"), RELAY_DELIVERY.LATEST_SNAPSHOT, {
    onObject: () => { published++; },
  }, () => {});
  const auth = new RelayResourceAuthority();
  feed(client, auth.answerSubscribe({ stream: 1, correlation: wire.lastRequest().correlation, metadata: wire.lastRequest().metadata }));
  const id = 1;
  const un = client.unsubscribe(id);
  expect("correlation" in un).toBe(true);
  feed(client, auth.answerUnsubscribe({ stream: 1, correlation: wire.lastRequest().correlation, metadata: wire.lastRequest().metadata }));
  expect(client.subscription(id)).toBeUndefined();
  // A push already on the wire after unsubscribe.
  const frames = chunks(auth, {
    type: RELAY_TYPE.PUSH, stream: 1, correlation: 0, subscription: id,
    ref: tileRef("r2"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(100),
  });
  for (const f of frames) feed(client, f, RELAY_CODEC.R5G6B5LE);
  expect(published).toBe(0);
});

test("F3: a subscription id equal to an in-flight get correlation does not collide", () => {
  const { wire, client } = makeClient();
  const auth = new RelayResourceAuthority();
  // Get first: wire correlation 1 reserves the get channel of stream 1.
  const getResults: ResourceResult<unknown>[] = [];
  const got = client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 },
    (r) => getResults.push(r as ResourceResult<unknown>));
  expect(got).toEqual({ correlation: 1 });

  // Subscribe: correlation 2 on the wire, but the authority allocates
  // subscription id 1 — an independent id space per §3.6/§3.7.
  const ended: ({ code: string } | undefined)[] = [];
  const objects: unknown[] = [];
  client.subscribe(1, tileRef("r1"), RELAY_DELIVERY.RELIABLE_DELTA, {
    onObject: (o) => objects.push(o),
    onEnd: (e) => ended.push(e),
  }, () => {});
  const answer = auth.answerSubscribe({
    stream: 1, correlation: wire.lastRequest().correlation, metadata: wire.lastRequest().metadata,
  });
  expect((answer.metadata.value as { subscription: number }).subscription).toBe(1);
  feed(client, answer);

  // The subscription must survive and be registered in its own id space.
  expect(ended).toEqual([]);
  expect(client.subscription(1)).toBeDefined();

  // Pushes on subscription 1 deliver while get correlation 1 is still open.
  for (const f of chunks(auth, {
    type: RELAY_TYPE.PUSH, stream: 1, correlation: 0, subscription: 1,
    ref: tileRef("r2"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(64),
  })) feed(client, f, RELAY_CODEC.R5G6B5LE);
  expect(objects.length).toBe(1);

  // The in-flight get completes through its own channel and is not killed by
  // the overlapping subscription id.
  for (const f of chunks(auth, {
    type: RELAY_TYPE.RESPONSE, stream: 1, correlation: 1,
    ref: tileRef("r1"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(64),
  })) feed(client, f, RELAY_CODEC.R5G6B5LE);
  expect(getResults.length).toBe(1);
  expect(getResults[0].ok).toBe(true);
  expect(client.stats().pending).toBe(0);
});

test("invalidate scope=revision removes the local entry and fences an in-flight get", () => {
  const { wire, client } = makeClient();
  const results: unknown[] = [];
  client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, (r) => results.push(r));
  // The get would have published r1; invalidate first.
  const auth = new RelayResourceAuthority();
  feed(client, auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.REVISION, ref: tileRef("r1") }), RELAY_CODEC.NONE);
  // The late response now fences on generation.
  const frames = chunks(auth, {
    type: RELAY_TYPE.RESPONSE, stream: 1, correlation: wire.sent[0].correlation,
    ref: tileRef("r1"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(100),
  });
  for (const f of frames) feed(client, f, RELAY_CODEC.R5G6B5LE);
  const out = results[0] as { ok: false; error: { code: string } };
  expect(out.ok).toBe(false);
  expect(out.error.code).toBe(RELAY_ERROR.RESYNC_REQUIRED);
  expect(client.localEntry(tileRef("r1"))).toBeUndefined();
});

test("invalidate scope=key advances local generation but keeps the stale value", () => {
  const seeded = makeClient();
  const auth = new RelayResourceAuthority();
  const results: unknown[] = [];
  seeded.client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, (r) => results.push(r));
  for (const f of chunks(auth, {
    type: RELAY_TYPE.RESPONSE, stream: 1, correlation: seeded.wire.lastRequest().correlation,
    ref: tileRef("r1"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(100),
  })) seeded.client.handleFrame(toFrame(f, RELAY_CODEC.R5G6B5LE));
  expect(results.length).toBe(1);
  expect(seeded.client.localEntry(tileRef("r1"))?.generation).toBe(0);
  seeded.client.handleFrame(toFrame(auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.KEY, ref: tileRef("r1") })));
  const entry = seeded.client.localEntry(tileRef("r1"));
  expect(entry?.generation).toBe(1); // generation moved forward
  expect(entry?.stale).toBe(true); // value retained but stale
});

test("invalidate scope=namespace moves every matching namespace generation forward", () => {
  const seeded = makeClient();
  const auth = new RelayResourceAuthority();
  const a: RelayResourceRef = { kind: RELAY_KIND.TILE, ns: "map/demo", key: "a", revision: "1", rendition: "x" };
  const b: RelayResourceRef = { kind: RELAY_KIND.TILE, ns: "map/demo", key: "b", revision: "1", rendition: "x" };
  const other: RelayResourceRef = { kind: RELAY_KIND.TILE, ns: "term/demo", key: "c", revision: "1", rendition: "x" };
  for (const ref of [a, b, other]) {
    const corr = seeded.client.get(1, ref, { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, () => {});
    if (!("correlation" in corr)) throw new Error("budget");
    for (const f of chunks(auth, {
      type: RELAY_TYPE.RESPONSE, stream: 1, correlation: corr.correlation,
      ref, codec: RELAY_CODEC.R5G6B5LE, data: zeros(10),
    })) seeded.client.handleFrame(toFrame(f, RELAY_CODEC.R5G6B5LE));
  }
  seeded.client.handleFrame(toFrame(auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.NAMESPACE, ns: "map/demo" })));
  expect(seeded.client.localEntry(a)?.generation).toBe(1);
  expect(seeded.client.localEntry(b)?.generation).toBe(1);
  expect(seeded.client.localEntry(other)?.generation).toBe(0);
});

test("the cache identity excludes revision: every revision of a key shares it", () => {
  expect(relayResourceKey(tileRef("r1"))).toBe(relayResourceKey(tileRef("r2")));
  expect(relayResourceKey(currentTileRef())).toBe(relayResourceKey(tileRef("r2")));
  // rendition and key still distinguish identities.
  expect(relayResourceKey(tileRef("r1")))
    .not.toBe(relayResourceKey({ ...tileRef("r1"), rendition: "r5g6b5le-128-v1" }));
});

test("F1: a key-scope invalidate fences an in-flight revisionless get", () => {
  const { wire, client } = makeClient();
  const auth = new RelayResourceAuthority();
  const results: { ok: boolean; error?: { code: string } }[] = [];
  // §3.5: a get without revision requests the current revision.
  client.get(1, currentTileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 },
    (r) => results.push(r as { ok: boolean; error?: { code: string } }));
  feed(client, auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.KEY, ref: tileRef("r1") }));
  // The late response names the concrete revision (§3.5).
  for (const f of chunks(auth, {
    type: RELAY_TYPE.RESPONSE, stream: 1, correlation: wire.lastRequest().correlation,
    ref: tileRef("r1"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(100),
  })) feed(client, f, RELAY_CODEC.R5G6B5LE);
  expect(results[0].ok).toBe(false);
  expect(results[0].error?.code).toBe(RELAY_ERROR.RESYNC_REQUIRED);
  // The stale object must not be cached as fresh.
  expect(client.localEntry(tileRef("r1"))?.stale).not.toBe(false);
});

test("F1: a revision-scope invalidate fences only the invalidated concrete revision", () => {
  const { wire, client } = makeClient();
  const auth = new RelayResourceAuthority();
  const results: { ok: boolean; error?: { code: string }; value?: { ref?: RelayResourceRef } }[] = [];
  // Revisionless "current version" get.
  client.get(1, currentTileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 },
    (r) => results.push(r as typeof results[number]));
  // r1 is invalidated while the get is in flight.
  feed(client, auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.REVISION, ref: tileRef("r1") }));
  // Authority answers with the current revision, r2: a different concrete
  // revision that the fence must not reject.
  for (const f of chunks(auth, {
    type: RELAY_TYPE.RESPONSE, stream: 1, correlation: wire.lastRequest().correlation,
    ref: tileRef("r2"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(100),
  })) feed(client, f, RELAY_CODEC.R5G6B5LE);
  expect(results[0].ok).toBe(true);
  expect(results[0].value?.ref?.revision).toBe("r2");
  expect(client.localEntry(tileRef("r2"))?.stale).toBe(false);

  // A named-r1 get already in flight when r1 is invalidated must still fence.
  const named: { ok: boolean; error?: { code: string } }[] = [];
  client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 },
    (r) => named.push(r as { ok: boolean; error?: { code: string } }));
  feed(client, auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.REVISION, ref: tileRef("r1") }));
  for (const f of chunks(auth, {
    type: RELAY_TYPE.RESPONSE, stream: 1, correlation: wire.lastRequest().correlation,
    ref: tileRef("r1"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(100),
  })) feed(client, f, RELAY_CODEC.R5G6B5LE);
  expect(named[0].ok).toBe(false);
  expect(named[0].error?.code).toBe(RELAY_ERROR.RESYNC_REQUIRED);
});

test("F1: revision scope removes only the current concrete revision; an invalidate for another revision keeps it", () => {
  const seeded = makeClient();
  const auth = new RelayResourceAuthority();
  const serve = (revision: string) => {
    const out = seeded.client.get(1, tileRef(revision), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, () => {});
    if (!("correlation" in out)) throw new Error("budget");
    for (const f of chunks(auth, {
      type: RELAY_TYPE.RESPONSE, stream: 1, correlation: out.correlation,
      ref: tileRef(revision), codec: RELAY_CODEC.R5G6B5LE, data: zeros(10),
    })) seeded.client.handleFrame(toFrame(f, RELAY_CODEC.R5G6B5LE));
  };
  // The resident cache holds the current revision per revision-less identity;
  // publishing r2 replaces r1 at a frame boundary (§3.7).
  serve("r1");
  serve("r2");
  const current = seeded.client.localEntry(tileRef("r2"));
  expect(current?.ref.revision).toBe("r2");
  // A revision invalidate for the stale r1 must not remove the resident r2.
  seeded.client.handleFrame(toFrame(auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.REVISION, ref: tileRef("r1") })));
  expect(seeded.client.localEntry(tileRef("r2"))?.ref.revision).toBe("r2");
  expect(seeded.client.localEntry(tileRef("r2"))?.stale).toBe(false);
  // An invalidate for the concrete current revision removes it.
  seeded.client.handleFrame(toFrame(auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.REVISION, ref: tileRef("r2") })));
  expect(seeded.client.localEntry(tileRef("r2"))).toBeUndefined();

  // Key scope marks the current revision stale without deleting it.
  serve("r3");
  seeded.client.handleFrame(toFrame(auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.KEY, ref: tileRef("r3") })));
  expect(seeded.client.localEntry(tileRef("r3"))?.stale).toBe(true);
});

test("invalidate after subscribe forces resync on the next delta", () => {
  const { wire, client } = makeClient();
  const marks: boolean[] = [];
  client.subscribe(1, tileRef("r1"), RELAY_DELIVERY.RELIABLE_DELTA, {
    onObject: (_o, ctx) => marks.push(ctx.resyncRequired),
  }, () => {});
  const auth = new RelayResourceAuthority();
  feed(client, auth.answerSubscribe({ stream: 1, correlation: wire.lastRequest().correlation, metadata: wire.lastRequest().metadata }));
  client.applyInvalidate({
    op: RELAY_OP.RESOURCE_INVALIDATE,
    resource: tileRef("r1"),
    args: { scope: RELAY_INVALIDATE_SCOPE.KEY },
  });
  const frames = chunks(auth, {
    type: RELAY_TYPE.PUSH, stream: 1, correlation: 0, subscription: 1,
    ref: tileRef("r2"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(100), baseRevision: "r1",
  });
  for (const f of frames) feed(client, f, RELAY_CODEC.R5G6B5LE);
  expect(marks).toEqual([true]);
});

test("F2: a full snapshot re-bases a resyncing reliable-delta subscription", () => {
  const { wire, client } = makeClient();
  const auth = new RelayResourceAuthority();
  const marks: { revision?: string; resync: boolean }[] = [];
  client.subscribe(1, tileRef("r1"), RELAY_DELIVERY.RELIABLE_DELTA, {
    onObject: (o, ctx) => marks.push({ revision: o.ref.revision, resync: ctx.resyncRequired }),
  }, () => {});
  feed(client, auth.answerSubscribe({ stream: 1, correlation: wire.lastRequest().correlation, metadata: wire.lastRequest().metadata }));
  const subscription = 1; // the authority's first subscription id

  // The key is invalidated: the client drops its base and wants a resync.
  client.applyInvalidate({
    op: RELAY_OP.RESOURCE_INVALIDATE, resource: tileRef("r1"),
    args: { scope: RELAY_INVALIDATE_SCOPE.KEY },
  });

  // §3.7 recovery: a full snapshot carries no baseRevision.
  for (const f of chunks(auth, {
    type: RELAY_TYPE.PUSH, stream: 1, correlation: 0, subscription,
    ref: tileRef("r2"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(64),
  })) feed(client, f, RELAY_CODEC.R5G6B5LE);
  expect(client.subscription(subscription)?.revision).toBe("r2");
  expect(client.subscription(subscription)?.resyncRequired).toBe(false);

  // A delta on the snapshot base applies cleanly.
  for (const f of chunks(auth, {
    type: RELAY_TYPE.PUSH, stream: 1, correlation: 0, subscription,
    ref: tileRef("r3"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(64), baseRevision: "r2",
  })) feed(client, f, RELAY_CODEC.R5G6B5LE);

  // The boundary snapshot is delivered marked; later objects are clean.
  expect(marks).toEqual([
    { revision: "r2", resync: true },
    { revision: "r3", resync: false },
  ]);
});

test("F2: a delta alone never clears the resync flag; recovery needs the snapshot", () => {
  const { wire, client } = makeClient();
  const auth = new RelayResourceAuthority();
  const marks: boolean[] = [];
  client.subscribe(1, tileRef("r1"), RELAY_DELIVERY.RELIABLE_DELTA, {
    onObject: (_o, ctx) => marks.push(ctx.resyncRequired),
  }, () => {});
  feed(client, auth.answerSubscribe({ stream: 1, correlation: wire.lastRequest().correlation, metadata: wire.lastRequest().metadata }));
  client.applyInvalidate({
    op: RELAY_OP.RESOURCE_INVALIDATE, resource: tileRef("r1"),
    args: { scope: RELAY_INVALIDATE_SCOPE.KEY },
  });
  // Two deltas while resyncing: both stay marked and the base never advances.
  for (const revision of ["r2", "r3"]) {
    for (const f of chunks(auth, {
      type: RELAY_TYPE.PUSH, stream: 1, correlation: 0, subscription: 1,
      ref: tileRef(revision), codec: RELAY_CODEC.R5G6B5LE, data: zeros(64), baseRevision: "r1",
    })) feed(client, f, RELAY_CODEC.R5G6B5LE);
  }
  expect(marks).toEqual([true, true]);
  expect(client.subscription(1)?.revision).toBeUndefined();
  expect(client.subscription(1)?.resyncRequired).toBe(true);
});

// ---------------------------------------------------------------------------
// release (remote lease) and evict (local, no ACK — Q5)
// ---------------------------------------------------------------------------

test("resource.release ACKs a provider lease; an unknown lease is NOT_FOUND", () => {
  const { wire, client } = makeClient();
  const auth = new RelayResourceAuthority();
  const lease = auth.allocateLease();
  expect(auth.leaseCount()).toBe(1);
  const results: unknown[] = [];
  client.release(1, tileRef(), lease, (r) => results.push(r));
  feed(client, auth.answerRelease({ stream: 1, correlation: wire.lastRequest().correlation, metadata: wire.lastRequest().metadata }));
  expect((results[0] as { ok: true }).ok).toBe(true);
  expect(auth.leaseCount()).toBe(0);

  client.release(1, tileRef(), 999, (r) => results.push(r));
  feed(client, auth.answerRelease({ stream: 1, correlation: wire.lastRequest().correlation, metadata: wire.lastRequest().metadata }));
  const out = results[1] as { ok: false; error: { code: string } };
  expect(out.ok).toBe(false);
  expect(out.error.code).toBe(RELAY_ERROR.NOT_FOUND);
});

test("local eviction sends one cache.evict advisory and never waits for an ACK (Q5)", () => {
  const { wire, client } = makeClient();
  // Seed an entry.
  const auth = new RelayResourceAuthority();
  const corr = client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, () => {});
  if (!("correlation" in corr)) throw new Error("budget");
  for (const f of chunks(auth, {
    type: RELAY_TYPE.RESPONSE, stream: 1, correlation: corr.correlation,
    ref: tileRef("r1"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(10),
  })) client.handleFrame(toFrame(f, RELAY_CODEC.R5G6B5LE));
  expect(client.localEntry(tileRef("r1"))).toBeDefined();

  client.reportEvict(tileRef("r1"), RELAY_EVICT_REASON.BUDGET);
  expect(client.localEntry(tileRef("r1"))).toBeUndefined();
  expect(wire.advises.length).toBe(1);
  expect(wire.advises[0]).toMatchObject({
    op: RELAY_OP.CACHE_EVICT,
    args: { reason: RELAY_EVICT_REASON.BUDGET },
  });
  // There is no response correlation and no pending request awaiting an ACK.
  expect(client.stats().pending).toBe(0);
});

test("id allocator never wraps or reuses", () => {
  const ids = new RelayIdAllocator();
  expect(ids.allocate()).toBe(1);
  expect(ids.allocate()).toBe(2);
  expect(ids.allocated()).toBe(2);
});

// ---------------------------------------------------------------------------
// Authority chunking round-trip: contiguous offsets, final flag, digest
// ---------------------------------------------------------------------------

test("authority chunks respect the wire ceiling with contiguous offsets and one final chunk", () => {
  const auth = new RelayResourceAuthority({ maxWireBytes: 65536, maxMetaBytes: 2048 });
  const data = zeros(131072);
  const frames = chunks(auth, {
    type: RELAY_TYPE.RESPONSE, stream: 1, correlation: 1,
    ref: tileRef(), codec: RELAY_CODEC.R5G6B5LE, data,
    value: { width: 256, height: 256 },
  });
  let offset = 0;
  frames.forEach((f, i) => {
    const t = f.metadata.transfer as { offset: string; total: string };
    expect(Number(BigInt("0x" + t.offset))).toBe(offset);
    offset += f.data!.length;
    expect(f.metadata.final).toBe(i === frames.length - 1);
    expect(f.codec).toBe(RELAY_CODEC.R5G6B5LE);
    // 48B header + metadata + data within the wire ceiling, metadata within
    // the metadata ceiling: the canonical encoder accepts every chunk.
    const metaLen = stringToUtf8(JSON.stringify(f.metadata)).length;
    expect(48 + metaLen + f.data!.length).toBeLessThanOrEqual(65536);
    expect(metaLen).toBeLessThanOrEqual(2048);
    expect(prepareFrameBody({ type: f.type, codec: f.codec, stream: f.stream, metadata: f.metadata, data: f.data },
      { maxWireBytes: 65536, maxMetaBytes: 2048 }).ok).toBe(true);
  });
  expect(offset).toBe(131072);
  // Distinct objects get distinct, non-reused transfer ids.
  const again = chunks(auth, {
    type: RELAY_TYPE.RESPONSE, stream: 1, correlation: 2,
    ref: tileRef(), codec: RELAY_CODEC.R5G6B5LE, data: zeros(10),
  });
  const idA = (frames[0].metadata.transfer as { id: number }).id;
  const idB = (again[0].metadata.transfer as { id: number }).id;
  expect(idB).toBeGreaterThan(idA);
});

// ---------------------------------------------------------------------------
// Review 1070 M1: resource keys must not alias across field boundaries
// ---------------------------------------------------------------------------

test("M1: two refs whose fields contain the old delimiter are two identities in the cache and in the assembler", () => {
  // Review 1070's RESOURCE_KEY_COLLISION probe: with a `|` join both refs
  // mapped to one key, the second publication overwrote the first entry and
  // a lookup of the first returned the second ref.
  const left: RelayResourceRef = { kind: RELAY_KIND.TILE, ns: "a", key: "b|c", revision: "r1", rendition: "x" };
  const right: RelayResourceRef = { kind: RELAY_KIND.TILE, ns: "a|b", key: "c", revision: "r2", rendition: "x" };
  expect(relayResourceKey(left)).not.toBe(relayResourceKey(right));
  const { wire, client } = makeClient();
  const auth = new RelayResourceAuthority();
  for (const ref of [left, right]) {
    const started = client.get(1, ref, { accept: [RELAY_CODEC.OPAQUE_BYTES], maxObjectBytes: 16 }, () => {});
    expect("correlation" in started).toBe(true);
    for (const env of chunks(auth, {
      type: RELAY_TYPE.RESPONSE, stream: 1, correlation: wire.lastRequest().correlation,
      ref, codec: RELAY_CODEC.OPAQUE_BYTES, data: zeros(8),
    })) feed(client, env, RELAY_CODEC.OPAQUE_BYTES);
  }
  expect(client.stats().entries).toBe(2);
  expect(client.localEntry(left)?.ref).toEqual(left);
  expect(client.localEntry(right)?.ref).toEqual(right);

  // The assembler compares chunk identity the same way: a second chunk that
  // names the aliasing identity is an identity change, hence INVALID.
  const a = makeAssembler();
  expect(reserve(a, 1, 16)).toEqual({ ok: true });
  const push = (ref: RelayResourceRef, offset: number, final: boolean) => a.push({
    stream: 1, channel: 1, space: "get", codec: RELAY_CODEC.OPAQUE_BYTES, resource: ref,
    final, transfer: { id: 1, offset: hex16(offset), total: hex16(16) }, data: zeros(8),
  });
  expect(push({ ...left, revision: "r" }, 0, false)).toEqual({ ok: true, complete: false });
  expect(push({ ...right, revision: "r" }, 8, true)).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
});

// ---------------------------------------------------------------------------
// Review 1070 N1: error envelopes have their own schemas; subscribe holds the
// revision the authority named
// ---------------------------------------------------------------------------

test("N1: authority error envelopes validate against the op's .error schema, carry the resource when known, and clip the message by bytes", () => {
  // Review 1070's L2_SCHEMA_AND_SUBSCRIBE_REVISION probe: the get error
  // failed `$.resource: required` and the subscribe error `$.value: required`
  // against the success schemas. Errors now have a shape of their own.
  const auth = new RelayResourceAuthority();
  const getRequest = {
    op: RELAY_OP.RESOURCE_GET, resource: tileRef("r1"), args: { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 16 },
  };
  const getError = auth.answerGetError({ stream: 1, correlation: 1, metadata: getRequest }, RELAY_ERROR.TOO_LARGE);
  expect(validateRelayMetadata(`${RELAY_OP.RESOURCE_GET}.error`, getError.metadata)).toBeNull();
  expect(getError.metadata.resource).toEqual(tileRef("r1"));
  expect(getError.metadata.value).toBeUndefined();
  // Without a valid request there is no ref to echo; the envelope stays valid.
  const bare = auth.answerGetError({ stream: 1, correlation: 1 }, RELAY_ERROR.NOT_FOUND);
  expect(validateRelayMetadata(`${RELAY_OP.RESOURCE_GET}.error`, bare.metadata)).toBeNull();
  expect(bare.metadata.resource).toBeUndefined();
  const malformedRequest = auth.answerGetError({ stream: 1, correlation: 1, metadata: { op: RELAY_OP.RESOURCE_GET, resource: { kind: 1 } } }, RELAY_ERROR.INVALID);
  expect(malformedRequest.metadata.resource).toBeUndefined();

  const subError = auth.answerSubscribe({
    stream: 1, correlation: 2, metadata: { op: RELAY_OP.RESOURCE_SUBSCRIBE, args: { delivery: "invalid" } },
  });
  expect(validateRelayMetadata(`${RELAY_OP.RESOURCE_SUBSCRIBE}.error`, subError.metadata)).toBeNull();
  const unsubError = auth.answerUnsubscribe({ stream: 1, correlation: 3, metadata: { op: RELAY_OP.RESOURCE_UNSUBSCRIBE, args: { subscription: 99 } } });
  expect(validateRelayMetadata(`${RELAY_OP.RESOURCE_UNSUBSCRIBE}.error`, unsubError.metadata)).toBeNull();
  const releaseError = auth.answerRelease({ stream: 1, correlation: 4, metadata: { op: RELAY_OP.RESOURCE_RELEASE, resource: tileRef(), args: { lease: 5 } } });
  expect(validateRelayMetadata(`${RELAY_OP.RESOURCE_RELEASE}.error`, releaseError.metadata)).toBeNull();

  // A 200-character two-byte message clips to at most 160 UTF-8 bytes, on a
  // character boundary, and an empty message falls back to the code.
  const wide = auth.answerGetError({ stream: 1, correlation: 1 }, RELAY_ERROR.BUSY, "é".repeat(200));
  const message = (wide.metadata.error as { message: string }).message;
  expect(stringToUtf8(message).length).toBe(160);
  expect(message).toBe("é".repeat(80));
  expect(validateRelayMetadata(`${RELAY_OP.RESOURCE_GET}.error`, wide.metadata)).toBeNull();
  const empty = auth.answerGetError({ stream: 1, correlation: 1 }, RELAY_ERROR.BUSY, "");
  expect((empty.metadata.error as { message: string }).message).toBe(RELAY_ERROR.BUSY);
});

test("N1: a successful subscribe response names the revision the subscription holds; a namespace subscription holds none", () => {
  const { wire, client } = makeClient();
  const hinted: RelayResourceRef = { kind: RELAY_KIND.TILE, ns: "n", key: "k", revision: "hint", rendition: "x" };
  const outcomes: unknown[] = [];
  const started = client.subscribe(1, hinted, RELAY_DELIVERY.RELIABLE_DELTA, { onObject() {} }, (r) => outcomes.push(r));
  expect("correlation" in started).toBe(true);
  client.handleFrame({
    type: RELAY_TYPE.RESPONSE, codec: RELAY_CODEC.NONE, stream: 1, correlation: wire.lastRequest().correlation,
    metadata: {
      op: RELAY_OP.RESOURCE_SUBSCRIBE, resource: { ...hinted, revision: "authority-current" },
      status: RELAY_STATUS.OK, final: true, value: { subscription: 77 },
    },
    data: new Uint8Array(0),
  });
  expect(client.subscription(77)?.revision).toBe("authority-current");
  // The app callback keeps its {subscription} shape.
  expect(outcomes).toEqual([{ ok: true, value: { subscription: 77 } }]);
  // The first delta must base on the named revision, not the hint.
  const auth = new RelayResourceAuthority();
  const delivered: Array<{ revision?: string; resync: boolean }> = [];
  client.subscription(77)!.handler.onObject = (o, ctx) => delivered.push({ revision: o.ref.revision, resync: ctx.resyncRequired });
  for (const f of chunks(auth, {
    type: RELAY_TYPE.PUSH, stream: 1, correlation: 0, subscription: 77,
    ref: { ...hinted, revision: "next" }, codec: RELAY_CODEC.OPAQUE_BYTES, data: zeros(4), baseRevision: "authority-current",
  })) feed(client, f, RELAY_CODEC.OPAQUE_BYTES);
  expect(delivered).toEqual([{ revision: "next", resync: false }]);
  expect(client.subscription(77)?.revision).toBe("next");

  // A response without a resource (namespace subscription) leaves the
  // revision undefined; the response echoing the hint unchanged keeps it.
  client.subscribe(1, { ns: "n" }, RELAY_DELIVERY.LATEST_SNAPSHOT, { onObject() {} }, () => {});
  feed(client, auth.answerSubscribe({ stream: 1, correlation: wire.lastRequest().correlation, metadata: wire.lastRequest().metadata }));
  const nsId = auth.idsAllocated().subscription;
  expect(client.subscription(nsId)?.revision).toBeUndefined();
  client.subscribe(1, hinted, RELAY_DELIVERY.LATEST_SNAPSHOT, { onObject() {} }, () => {});
  feed(client, auth.answerSubscribe({ stream: 1, correlation: wire.lastRequest().correlation, metadata: wire.lastRequest().metadata }));
  expect(client.subscription(auth.idsAllocated().subscription)?.revision).toBe("hint");
});

test("N1: a response carrying another op than the pending request ends it as INVALID", () => {
  const { wire, client, assembler } = makeClient();
  const outcomes: unknown[] = [];
  client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 8 }, (r) => outcomes.push(r));
  client.handleFrame({
    type: RELAY_TYPE.RESPONSE, codec: RELAY_CODEC.NONE, stream: 1, correlation: wire.lastRequest().correlation,
    metadata: { op: RELAY_OP.RESOURCE_SUBSCRIBE, status: RELAY_STATUS.OK, final: true, value: { subscription: 1 } },
    data: new Uint8Array(0),
  });
  expect(outcomes).toEqual([{ ok: false, error: { code: RELAY_ERROR.INVALID } }]);
  expect(client.stats()).toMatchObject({ pending: 0, subscriptions: 0, protocolErrors: 1 });
  expect(assembler.stats().assemblies).toBe(0);
  // A schema-invalid error envelope (a value on an error) ends a get the same way.
  client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 8 }, (r) => outcomes.push(r));
  client.handleFrame({
    type: RELAY_TYPE.RESPONSE, codec: RELAY_CODEC.NONE, stream: 1, correlation: wire.lastRequest().correlation,
    metadata: { op: RELAY_OP.RESOURCE_GET, status: RELAY_STATUS.ERROR, final: true, error: { code: "BUSY", message: "x" }, value: {} },
    data: new Uint8Array(0),
  });
  expect(outcomes[1]).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });
  expect(client.stats()).toMatchObject({ pending: 0, protocolErrors: 2 });
});

// ---------------------------------------------------------------------------
// Review 1070 M3: transfer ids increase on a channel; a non-adjacent reuse rejects
// ---------------------------------------------------------------------------

test("M3: on one push channel the transfer ids 1, 2, 1 reject the third object; a lower id after a higher one rejects too", () => {
  // Review 1070's NONADJACENT_TRANSFER_REUSE probe: only the immediately
  // previous id was remembered, so 1, 2, 1 completed three objects.
  const a = new RelayChunkAssembler({ maxAssemblies: 1, maxScratchBytes: 64 });
  expect(a.reserve({ stream: 1, channel: 7, space: "push" }, 64)).toEqual({ ok: true });
  const ref: RelayResourceRef = { kind: RELAY_KIND.TILE, ns: "n", key: "k", revision: "r", rendition: "x" };
  const push = (id: number) => a.push({
    stream: 1, channel: 7, space: "push", codec: RELAY_CODEC.OPAQUE_BYTES, resource: ref,
    final: true, transfer: { id, offset: hex16(0), total: hex16(8) }, data: zeros(8),
  });
  expect(push(1)).toMatchObject({ ok: true, complete: true });
  expect(push(2)).toMatchObject({ ok: true, complete: true });
  expect(push(1)).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  // The rejection dropped the channel's reservation, as every INVALID does.
  expect(a.stats()).toMatchObject({ assemblies: 0, published: 2, failed: 1 });

  // Ids are allocated monotonically, so a lower id after a higher one is a
  // reuse of an already-passed id and rejects as well; a higher id proceeds.
  expect(a.reserve({ stream: 1, channel: 8, space: "push" }, 64)).toEqual({ ok: true });
  const push8 = (id: number) => a.push({
    stream: 1, channel: 8, space: "push", codec: RELAY_CODEC.OPAQUE_BYTES, resource: ref,
    final: true, transfer: { id, offset: hex16(0), total: hex16(8) }, data: zeros(8),
  });
  expect(push8(5)).toMatchObject({ ok: true, complete: true });
  expect(push8(9)).toMatchObject({ ok: true, complete: true });
  expect(push8(7)).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
});

// ---------------------------------------------------------------------------
// Review 1070 M2: generation markers are bounded by entries + pending gets
// ---------------------------------------------------------------------------

test("M2: invalidating, evicting and resetting 64 identities leaves no generation marker behind", () => {
  // Review 1070's GENERATION_MARKERS_AFTER_EVICT_RESET probe: entries=0 but
  // generationMarkers=64 before the fix.
  const count = 64;
  const { wire, client } = makeClient({ maxAssemblies: 1, maxObjectBytes: 16, maxScratchBytes: 16 });
  const auth = new RelayResourceAuthority();
  const refs: RelayResourceRef[] = [];
  for (let i = 0; i < count; i++) {
    const ref: RelayResourceRef = { kind: RELAY_KIND.TILE, ns: "growth", key: `k${i}`, revision: "r1", rendition: "x" };
    refs.push(ref);
    const started = client.get(1, ref, { accept: [RELAY_CODEC.OPAQUE_BYTES], maxObjectBytes: 16 }, () => {});
    expect("correlation" in started).toBe(true);
    for (const env of chunks(auth, {
      type: RELAY_TYPE.RESPONSE, stream: 1, correlation: wire.lastRequest().correlation,
      ref, codec: RELAY_CODEC.OPAQUE_BYTES, data: zeros(8),
    })) feed(client, env, RELAY_CODEC.OPAQUE_BYTES);
  }
  expect(client.stats()).toMatchObject({ entries: count, generationMarkers: 0 });
  client.applyInvalidate({ op: RELAY_OP.RESOURCE_INVALIDATE, args: { scope: RELAY_INVALIDATE_SCOPE.NAMESPACE, namespace: "growth" } });
  // The resident (stale) entries mirror the moved markers.
  expect(client.stats()).toMatchObject({ entries: count, generationMarkers: count });
  for (const ref of refs) client.reportEvict(ref, RELAY_EVICT_REASON.BUDGET);
  expect(client.stats()).toMatchObject({ entries: 0, generationMarkers: 0 });
  client.resetStream(1);
  expect(client.stats()).toMatchObject({ entries: 0, pending: 0, generationMarkers: 0 });
});

test("M2: a marker survives an eviction while a get that captured the older generation is in flight, and fences that get", () => {
  const { wire, client } = makeClient();
  const auth = new RelayResourceAuthority();
  const deliver = (correlation: number, ref: RelayResourceRef) => {
    for (const env of chunks(auth, { type: RELAY_TYPE.RESPONSE, stream: 1, correlation, ref, codec: RELAY_CODEC.R5G6B5LE, data: zeros(8) })) {
      feed(client, env, RELAY_CODEC.R5G6B5LE);
    }
  };
  // Seed a resident r1.
  client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 8 }, () => {});
  deliver(wire.lastRequest().correlation, tileRef("r1"));
  expect(client.stats()).toMatchObject({ entries: 1, generationMarkers: 0 });

  // A second get captures generation 0; a key-scope invalidate moves the
  // identity to 1; the resident entry is evicted before the response lands.
  const results: Array<ResourceResult<unknown>> = [];
  client.get(1, currentTileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 8 }, (r) => results.push(r));
  const inFlight = wire.lastRequest().correlation;
  feed(client, auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.KEY, ref: tileRef("r1") }));
  client.reportEvict(tileRef("r1"), RELAY_EVICT_REASON.BUDGET);
  expect(client.stats()).toMatchObject({ entries: 0, pending: 1, generationMarkers: 1 });
  // The late response is fenced; the marker goes with the get.
  deliver(inFlight, tileRef("r2"));
  expect(results).toEqual([{ ok: false, error: { code: RELAY_ERROR.RESYNC_REQUIRED } }]);
  expect(client.stats()).toMatchObject({ entries: 0, pending: 0, generationMarkers: 0 });

  // A fresh get after the prune captures the reset counter and publishes.
  client.get(1, currentTileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 8 }, (r) => results.push(r));
  deliver(wire.lastRequest().correlation, tileRef("r3"));
  expect(results[1]?.ok).toBe(true);
  expect(client.localEntry(tileRef())?.revision).toBe("r3");
  // A resident entry keeps its marker after an invalidate until it is evicted.
  feed(client, auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.KEY, ref: tileRef("r3") }));
  expect(client.stats()).toMatchObject({ entries: 1, generationMarkers: 1 });
  expect(client.localEntry(tileRef())?.stale).toBe(true);
  // A revision-scope invalidate of the resident revision releases both.
  feed(client, auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.REVISION, ref: tileRef("r3") }));
  expect(client.stats()).toMatchObject({ entries: 0, generationMarkers: 0 });
});

// ---------------------------------------------------------------------------
// Review 1070 B2: chunk metadata against the negotiated maxMetaBytes
// ---------------------------------------------------------------------------

const metaBytesOf = (meta: Record<string, unknown>) => stringToUtf8(JSON.stringify(meta)).length;

test("B2: a chunk plan whose metadata exceeds the negotiated maxMetaBytes is refused TOO_LARGE, never handed to the encoder", () => {
  // Review 1070's CHUNK_META_CAP probe: standard bulk limits, a legal 4000
  // byte value.note. Before the fix the chunker emitted 4,308-byte metadata
  // and encodeFrame refused the authority's own frame with META_TOO_LARGE.
  const auth = new RelayResourceAuthority({
    maxWireBytes: RELAY_LIMITS.bulkMaxWireBytes, maxMetaBytes: RELAY_LIMITS.bulkMaxMetaBytes,
  });
  const ref: RelayResourceRef = { kind: RELAY_KIND.TILE, ns: "map/demo", key: "k", revision: "r1", rendition: "rgb" };
  const plan = auth.chunkObject({
    type: RELAY_TYPE.RESPONSE, stream: 1, correlation: 1, ref,
    codec: RELAY_CODEC.OPAQUE_BYTES, data: zeros(4096), value: { note: "x".repeat(4000) },
  });
  expect(plan.ok).toBe(false);
  if (plan.ok) throw new Error("plan accepted");
  expect(plan.code).toBe(RELAY_ERROR.TOO_LARGE);
  expect(plan.limit).toBe("maxMetaBytes");
  expect(plan.metaBytes).toBeGreaterThan(RELAY_LIMITS.bulkMaxMetaBytes);

  // The same object with a value under the ceiling chunks, and every chunk
  // encodes under the bulk limits the receiver negotiated.
  const fits = auth.chunkObject({
    type: RELAY_TYPE.RESPONSE, stream: 1, correlation: 1, ref,
    codec: RELAY_CODEC.OPAQUE_BYTES, data: zeros(4096), value: { note: "x".repeat(1500) },
  });
  expect(fits.ok).toBe(true);
  if (!fits.ok) throw new Error(fits.message);
  for (const chunk of fits.frames) {
    expect(metaBytesOf(chunk.metadata)).toBeLessThanOrEqual(RELAY_LIMITS.bulkMaxMetaBytes);
    const encoded = encodeFrame({
      type: chunk.type, codec: chunk.codec, session: 0x0102030405060708n, seq: 1,
      stream: chunk.stream, correlation: chunk.correlation, metadata: chunk.metadata, data: chunk.data,
    }, { maxWireBytes: RELAY_LIMITS.bulkMaxWireBytes, maxMetaBytes: RELAY_LIMITS.bulkMaxMetaBytes });
    expect(encoded.ok).toBe(true);
  }
  // The wire ceiling is refused the same way when metadata leaves no data room.
  const tight = new RelayResourceAuthority({ maxWireBytes: 300, maxMetaBytes: 2048 });
  const noRoom = tight.chunkObject({ type: RELAY_TYPE.PUSH, stream: 1, correlation: 0, subscription: 1, ref, codec: RELAY_CODEC.OPAQUE_BYTES, data: zeros(10) });
  expect(noRoom.ok).toBe(false);
  if (noRoom.ok) throw new Error("plan accepted");
  expect(noRoom.limit).toBe("maxWireBytes");
  expect(48 + noRoom.metaBytes + 1).toBeGreaterThan(300);
  // A zero-length object is one final chunk under the same two checks.
  const empty = auth.chunkObject({ type: RELAY_TYPE.PUSH, stream: 1, correlation: 0, subscription: 1, ref, codec: RELAY_CODEC.OPAQUE_BYTES, data: zeros(0) });
  expect(empty.ok && empty.frames.length === 1 && empty.frames[0].metadata.final === true && empty.frames[0].codec === RELAY_CODEC.NONE).toBe(true);
});

test("B2 property: under random tiny negotiated limits every planned chunk encodes, or the plan names the limit its metadata cannot fit", () => {
  let seed = 0x1087;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 0x100000000; };
  const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  let accepted = 0, refusedMeta = 0, refusedWire = 0;
  for (let run = 0; run < 400; run++) {
    const maxMetaBytes = between(150, 700);
    const maxWireBytes = between(RELAY_LIMITS.controlMaxWireBytes / 16, 1500);
    const auth = new RelayResourceAuthority({ maxWireBytes, maxMetaBytes });
    const total = between(0, 3000);
    const data = new Uint8Array(total);
    for (let i = 0; i < total; i++) data[i] = (i * 31 + run) & 0xff;
    const push = rnd() < 0.5;
    const ref: RelayResourceRef = {
      kind: RELAY_KIND.TILE, ns: "n".repeat(between(1, 20)), key: "k".repeat(between(1, 40)),
      revision: `r${run}`, rendition: "x",
    };
    const plan = auth.chunkObject({
      type: push ? RELAY_TYPE.PUSH : RELAY_TYPE.RESPONSE, stream: 1,
      correlation: push ? 0 : 1, subscription: push ? 3 : undefined, ref,
      codec: RELAY_CODEC.OPAQUE_BYTES, data,
      ...(rnd() < 0.7 ? { value: { note: "v".repeat(between(0, 400)) } } : {}),
      ...(push && rnd() < 0.3 ? { baseRevision: "b" } : {}),
    });
    if (!plan.ok) {
      expect(plan.code).toBe(RELAY_ERROR.TOO_LARGE);
      if (plan.limit === "maxMetaBytes") { expect(plan.metaBytes).toBeGreaterThan(maxMetaBytes); refusedMeta++; }
      else { expect(48 + plan.metaBytes + 1).toBeGreaterThan(maxWireBytes); refusedWire++; }
      continue;
    }
    accepted++;
    let offset = 0;
    plan.frames.forEach((f, i) => {
      // The L1 encoder accepts every chunk under the negotiated limits.
      const body = prepareFrameBody({ type: f.type, codec: f.codec, stream: f.stream, metadata: f.metadata, data: f.data },
        { maxWireBytes, maxMetaBytes });
      expect(body.ok, `run ${run}: ${body.ok ? "" : body.code}`).toBe(true);
      const t = f.metadata.transfer as { offset: string; total: string };
      expect(Number(BigInt("0x" + t.offset))).toBe(offset);
      expect(Number(BigInt("0x" + t.total))).toBe(total);
      offset += f.data!.length;
      expect(f.metadata.final).toBe(i === plan.frames.length - 1);
      if (!f.metadata.final) expect(f.data!.length).toBeGreaterThan(0);
    });
    expect(offset).toBe(total);
    expect(Buffer.concat(plan.frames.map((f) => Buffer.from(f.data!)))).toEqual(Buffer.from(data));
  }
  // The generator covered every branch.
  expect(accepted).toBeGreaterThan(50);
  expect(refusedMeta).toBeGreaterThan(5);
  expect(refusedWire).toBeGreaterThan(5);
  // The pre-fix failure is what the encoder returns for metadata over the
  // ceiling; the plan refuses first, so this code never reaches the wire.
  expect(RELAY_FRAME_ERROR.META_TOO_LARGE).toBe("META_TOO_LARGE");
});

// ---------------------------------------------------------------------------
// Batch 5: resource-cache adapter — 72 tiles x 40960B Doc scenario
// ---------------------------------------------------------------------------

test("adapter: 72 tiles x 40960B enqueue/publish counts and peak resident bytes", () => {
  const TILES = 72;
  const TILE_BYTES = 40960;
  const MAX_CONCURRENT = 4;
  const { wire, client, assembler } = makeClient({
    maxObjectBytes: TILE_BYTES, maxAssemblies: MAX_CONCURRENT, maxScratchBytes: MAX_CONCURRENT * TILE_BYTES,
  });
  const auth = new RelayResourceAuthority({ maxWireBytes: 65536 });

  const scheduler = createResourceScheduler({
    maxConcurrent: MAX_CONCURRENT,
    startsPerFrame: MAX_CONCURRENT,
    completionsPerFrame: MAX_CONCURRENT,
    maxCollections: 1,
  });
  const refs: RelayResourceRef[] = Array.from({ length: TILES }, (_unused, i) => ({
    kind: RELAY_KIND.TILE, ns: "doc/demo", key: `page-17/tile/${i}`,
    revision: "layout-12", rendition: "coverage2-256x16-v1",
  }));
  const cache = scheduler.createCache<RelayResourceRef, Uint8Array, Uint8Array>({
    key: relayResourceKey,
    maxEntries: TILES,
    maxCost: TILES * TILE_BYTES,
    maxResponseBytes: TILE_BYTES,
    cost: () => TILE_BYTES,
    load: createRelayResourceLoad({ client, stream: 1, accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: TILE_BYTES }),
    materialize: (raw) => raw,
  });

  // All 72 demands are reconciled up front; cost is reserved before loading.
  const admitted = cache.reconcile(refs.map((input, i) => ({ input, priority: i })));
  expect(admitted).toBe(TILES);
  expect(cache.stats().cost).toBe(TILES * TILE_BYTES);

  let peakReadyBytes = 0;
  let frames = 0;
  const maxFrames = 200;
  while (cache.stats().ready < TILES && frames < maxFrames) {
    scheduler.step(); // starts <= 4 loads; each client.get enqueues a get
    // Serve every request started this frame with one chunked tile.
    for (const req of wire.sent.splice(0)) {
      if (req.metadata.op !== RELAY_OP.RESOURCE_GET) continue;
      const out = chunks(auth, {
        type: RELAY_TYPE.RESPONSE, stream: 1, correlation: req.correlation,
        ref: req.metadata.resource as RelayResourceRef, codec: RELAY_CODEC.R5G6B5LE,
        data: zeros(TILE_BYTES),
      });
      for (const env of out) client.handleFrame(toFrame(env, RELAY_CODEC.R5G6B5LE));
    }
    scheduler.step(); // delivers completions -> materialize -> ready
    peakReadyBytes = Math.max(peakReadyBytes, cache.stats().ready * TILE_BYTES);
    frames++;
  }

  expect(cache.stats().ready).toBe(TILES);
  expect(frames).toBeGreaterThan(0);
  // Every tile was enqueued (one get) and published (one assembled object).
  expect(assembler.stats().enqueued).toBe(TILES);
  expect(assembler.stats().published).toBe(TILES);
  expect(assembler.stats().failed).toBe(0);
  // Resident set peaks at the full 72-tile reservation; in-flight scratch
  // never exceeds maxConcurrent tiles.
  expect(peakReadyBytes).toBe(TILES * TILE_BYTES);
  expect(assembler.stats().peakStagedBytes).toBe(MAX_CONCURRENT * TILE_BYTES);
  scheduler.dispose();
});

test("adapter declines (returns false) on BUSY so the scheduler retries next frame", () => {
  const TILE_BYTES = 40960;
  const { client } = makeClient({ maxObjectBytes: TILE_BYTES, maxAssemblies: 1, maxScratchBytes: TILE_BYTES });
  const load = createRelayResourceLoad({ client, stream: 1, accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: TILE_BYTES });
  // First load reserves the single slot and starts.
  const first = load(tileRef("a"), () => {});
  expect(first).not.toBe(false);
  // Second load cannot reserve: declined start (resource-cache retries later).
  const second = load(tileRef("b"), () => {});
  expect(second).toBe(false);
});

test("F4: a notModified revalidation keeps the resident bytes instead of materializing 0 bytes", () => {
  const TILE_BYTES = 4096;
  const { wire, client } = makeClient({ maxObjectBytes: TILE_BYTES });
  const auth = new RelayResourceAuthority({ maxWireBytes: 65536 });
  const scheduler = createResourceScheduler({
    maxConcurrent: 1, startsPerFrame: 1, completionsPerFrame: 1, maxCollections: 1,
  });
  const ref: RelayResourceRef = {
    kind: RELAY_KIND.TILE, ns: "doc/demo", key: "page-1/tile/0",
    revision: "layout-12", rendition: "coverage2-256x16-v1",
  };
  let materializations = 0;
  const cache = scheduler.createCache<RelayResourceRef, Uint8Array, Uint8Array>({
    key: relayResourceKey,
    maxEntries: 1, maxCost: TILE_BYTES, maxResponseBytes: TILE_BYTES,
    cost: () => TILE_BYTES, maxAgeFrames: 1,
    load: createRelayResourceLoad({
      client, stream: 1, accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: TILE_BYTES,
      ifRevisionFor: (input) => input.revision,
    }),
    materialize: (raw) => { materializations++; return raw; },
  });
  cache.reconcile([{ input: ref, priority: 0 }]);

  // Round 1: a real 4096 B object lands in the cache.
  scheduler.step();
  for (const req of wire.sent.splice(0)) {
    for (const env of chunks(auth, {
      type: RELAY_TYPE.RESPONSE, stream: 1, correlation: req.correlation,
      ref, codec: RELAY_CODEC.R5G6B5LE, data: zeros(TILE_BYTES),
    })) feed(client, env, RELAY_CODEC.R5G6B5LE);
  }
  scheduler.step();
  expect((cache.state(ref) as { value: Uint8Array }).value.byteLength).toBe(TILE_BYTES);
  expect(materializations).toBe(1);

  // Round 2: aged out, conditional get comes back notModified (no bytes).
  scheduler.step();
  const revalidation = wire.sent.splice(0);
  expect(revalidation.length).toBe(1);
  expect((revalidation[0].metadata.args as { ifRevision?: string }).ifRevision).toBe("layout-12");
  feed(client, auth.answerNotModified({ stream: 1, correlation: revalidation[0].correlation }, ref));
  scheduler.step();

  // The resident 4096 B value survives and is not rematerialized (§3.8 TTL).
  const state = cache.state(ref);
  expect(state.status).toBe("ready");
  expect((state as { value: Uint8Array }).value.byteLength).toBe(TILE_BYTES);
  expect(materializations).toBe(1);
  scheduler.dispose();
});

test("M12 teeth: notModified must be final and name a concrete revision", () => {
  const { wire, client, assembler } = makeClient();
  const results: unknown[] = [];
  client.get(1, tileRef("r1"), {
    accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072, ifRevision: "r1",
  }, (r) => results.push(r));

  // notModified without a concrete revision on the resource is malformed:
  // §3.6 requires the response to still name the revision. It must not be
  // delivered as {notModified:true, revision:undefined}; the get ends as
  // INVALID and its reservation is released (review 1070 B1).
  client.handleFrame({
    type: RELAY_TYPE.RESPONSE, codec: RELAY_CODEC.NONE, stream: 1,
    correlation: wire.lastRequest().correlation,
    metadata: {
      op: RELAY_OP.RESOURCE_GET,
      resource: { kind: RELAY_KIND.TILE, ns: "map/demo", key: "k", rendition: "x" },
      status: RELAY_STATUS.OK, final: true, value: { notModified: true },
    },
    data: new Uint8Array(0),
  });
  expect(results).toEqual([{ ok: false, error: { code: RELAY_ERROR.INVALID } }]);
  expect(client.stats().protocolErrors).toBe(1);
  expect(client.stats().pending).toBe(0);
  expect(assembler.stats().assemblies).toBe(0);

  // notModified without final is non-terminal and rejected the same way.
  const results2: unknown[] = [];
  client.get(1, tileRef("r2"), {
    accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072, ifRevision: "r2",
  }, (r) => results2.push(r));
  client.handleFrame({
    type: RELAY_TYPE.RESPONSE, codec: RELAY_CODEC.NONE, stream: 1,
    correlation: wire.lastRequest().correlation,
    metadata: {
      op: RELAY_OP.RESOURCE_GET, resource: tileRef("r2"),
      status: RELAY_STATUS.OK, final: false, value: { notModified: true },
    },
    data: new Uint8Array(0),
  });
  expect(results2).toEqual([{ ok: false, error: { code: RELAY_ERROR.INVALID } }]);
  expect(client.stats().protocolErrors).toBe(2);
  expect(client.stats().pending).toBe(0);
  expect(assembler.stats().assemblies).toBe(0);
});

// ---------------------------------------------------------------------------
// Review 1070 B1: a malformed terminal must release pending state
// ---------------------------------------------------------------------------

/** A schema-invalid successful response for `correlation` (an unknown key). */
const malformedOk = (correlation: number, ref: RelayResourceRef, final: boolean): RelayResourceIncomingFrame => ({
  type: RELAY_TYPE.RESPONSE, codec: RELAY_CODEC.NONE, stream: 1, correlation,
  metadata: { op: RELAY_OP.RESOURCE_GET, resource: ref, status: RELAY_STATUS.OK, final, bogus: 1 },
  data: new Uint8Array(0),
});

test("B1: two malformed successful terminals release both pending gets and their assembler slots; a third get is admitted", () => {
  // Review 1070's MALFORMED_TERMINAL_LEAK probe: maxAssemblies=2, two gets
  // answered by schema-invalid `status:"ok", final:true` responses. Before
  // the fix the client kept pending=2 / assemblies=2 and the third get was
  // BUSY for the life of the stream.
  const { wire, client, assembler } = makeClient({ maxAssemblies: 2, maxObjectBytes: 4096 });
  const ref = (key: string): RelayResourceRef => ({ kind: RELAY_KIND.TILE, ns: "map/demo", key, revision: "r1", rendition: "rgb" });
  const outcomes: Array<ResourceResult<unknown>> = [];
  for (const key of ["one", "two"]) {
    const started = client.get(1, ref(key), { accept: [RELAY_CODEC.OPAQUE_BYTES], maxObjectBytes: 4096 }, (r) => outcomes.push(r));
    expect("correlation" in started).toBe(true);
    client.handleFrame(malformedOk(wire.lastRequest().correlation, ref(key), true));
  }
  expect(outcomes).toEqual([
    { ok: false, error: { code: RELAY_ERROR.INVALID } },
    { ok: false, error: { code: RELAY_ERROR.INVALID } },
  ]);
  expect(client.stats()).toMatchObject({ pending: 0, protocolErrors: 2 });
  expect(assembler.stats()).toMatchObject({ assemblies: 0, stagedBytes: 0 });
  const third = client.get(1, ref("three"), { accept: [RELAY_CODEC.OPAQUE_BYTES], maxObjectBytes: 4096 }, () => {});
  expect("correlation" in third).toBe(true);
  // The late well-formed terminal for a request that ended as INVALID is
  // consumed and dropped: no second completion, no new protocol error.
  const auth = new RelayResourceAuthority();
  feed(client, auth.answerNotModified({ stream: 1, correlation: wire.sent[0].correlation }, ref("one")));
  expect(outcomes.length).toBe(2);
  expect(client.stats()).toMatchObject({ pending: 1, protocolErrors: 2 });
});

test("B1: a malformed non-final response ends the get as INVALID too, and a malformed error body ends it as INVALID", () => {
  const { wire, client, assembler } = makeClient({ maxAssemblies: 1 });
  const outcomes: Array<ResourceResult<unknown>> = [];
  client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, (r) => outcomes.push(r));
  client.handleFrame(malformedOk(wire.lastRequest().correlation, tileRef("r1"), false));
  expect(outcomes).toEqual([{ ok: false, error: { code: RELAY_ERROR.INVALID } }]);
  expect(client.stats().pending).toBe(0);
  expect(assembler.stats().assemblies).toBe(0);

  // The slot is free again: a second get is admitted; its error terminal
  // without an error.code is malformed and ends it as INVALID as well.
  const started = client.get(1, tileRef("r2"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 }, (r) => outcomes.push(r));
  expect("correlation" in started).toBe(true);
  client.handleFrame({
    type: RELAY_TYPE.RESPONSE, codec: RELAY_CODEC.NONE, stream: 1, correlation: wire.lastRequest().correlation,
    metadata: { op: RELAY_OP.RESOURCE_GET, status: RELAY_STATUS.ERROR, final: true, error: { message: "no code" } },
    data: new Uint8Array(0),
  });
  expect(outcomes[1]).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });
  expect(client.stats()).toMatchObject({ pending: 0, protocolErrors: 2 });
  expect(assembler.stats().assemblies).toBe(0);

  // A subscribe answered by a malformed terminal is released the same way.
  const sub = client.subscribe(1, tileRef("r1"), RELAY_DELIVERY.RELIABLE_DELTA, { onObject() {} }, (r) => outcomes.push(r));
  expect("correlation" in sub).toBe(true);
  client.handleFrame({
    type: RELAY_TYPE.RESPONSE, codec: RELAY_CODEC.NONE, stream: 1, correlation: wire.lastRequest().correlation,
    metadata: { op: RELAY_OP.RESOURCE_SUBSCRIBE, status: RELAY_STATUS.OK, final: true, value: { subscription: "seven" } },
    data: new Uint8Array(0),
  });
  expect(outcomes[2]).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });
  expect(client.stats()).toMatchObject({ pending: 0, subscriptions: 0, protocolErrors: 3 });
});

// ---------------------------------------------------------------------------
// P4f: review 989 follow-ups (G1 single generation counter, G2 bounded
// revision markers, G3 subscribe withdrawal) and its mutation killers
// ---------------------------------------------------------------------------

test("G1: the identity generation is one monotonic counter moved once per invalidate", () => {
  const { client } = makeClient();
  const auth = new RelayResourceAuthority();
  const results: Record<string, { ok: boolean; error?: { code: string } }> = {};
  const answer = (correlation: number, revision: string) => {
    for (const f of chunks(auth, {
      type: RELAY_TYPE.RESPONSE, stream: 1, correlation,
      ref: tileRef(revision), codec: RELAY_CODEC.R5G6B5LE, data: zeros(100),
    })) feed(client, f, RELAY_CODEC.R5G6B5LE);
  };
  const getFor = (name: string) => {
    const out = client.get(1, currentTileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 },
      (r) => { results[name] = r as { ok: boolean; error?: { code: string } }; });
    if (!("correlation" in out)) throw new Error("budget");
    return out.correlation;
  };
  const invalidateKey = () =>
    feed(client, auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.KEY, ref: tileRef("r1") }));

  answer(getFor("g0"), "r1");
  const gens: number[] = [client.localEntry(tileRef("r1"))!.generation];
  // Two concurrent gets for the identity, then one key-scope invalidate: the
  // counter moves once, not once per matching in-flight get.
  const c1 = getFor("g1");
  const c2 = getFor("g2");
  invalidateKey();
  gens.push(client.localEntry(tileRef("r1"))!.generation);
  answer(c1, "r1");
  answer(c2, "r1");
  expect(results.g1.error?.code).toBe(RELAY_ERROR.RESYNC_REQUIRED);
  expect(results.g2.error?.code).toBe(RELAY_ERROR.RESYNC_REQUIRED);
  // A get captured after the first invalidate, then a second invalidate.
  const c3 = getFor("g3");
  invalidateKey();
  gens.push(client.localEntry(tileRef("r1"))!.generation);
  answer(c3, "r1");
  expect(gens).toEqual([0, 1, 2]);
  // The late r1 response is fenced and the invalidated entry stays stale;
  // review 989 G1 published it as fresh because the entries loop wrote
  // entry.generation + 1 over a counter the pending loop had pushed higher.
  expect(results.g3.ok).toBe(false);
  expect(results.g3.error?.code).toBe(RELAY_ERROR.RESYNC_REQUIRED);
  expect(client.localEntry(tileRef("r1"))!.stale).toBe(true);
  // A get captured after the last invalidate lands, and the entry it stores
  // carries the same counter the fence compared: one counter, no drift.
  const c4 = getFor("g4");
  answer(c4, "r2");
  expect(results.g4.ok).toBe(true);
  expect(client.localEntry(tileRef("r2"))).toMatchObject({ revision: "r2", generation: 2, stale: false });
});

test("G2: revision markers on an in-flight get are bounded; overflow fences the whole get", () => {
  const { wire, client } = makeClient();
  const auth = new RelayResourceAuthority();
  const results: { ok: boolean; error?: { code: string } }[] = [];
  client.get(1, currentTileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 },
    (r) => results.push(r as { ok: boolean; error?: { code: string } }));
  const correlation = wire.lastRequest().correlation;
  const N = 5000;
  for (let i = 0; i < N; i++) {
    feed(client, auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.REVISION, ref: tileRef(`r${i}`) }));
  }
  // §3.8 bounded markers: review 989 G2 measured N entries and quadratic
  // time on this path.
  expect(client.stats().fencedRevisions).toBeLessThanOrEqual(RELAY_MAX_FENCED_REVISIONS);
  // Past the bound the marker escalates to the whole get: a response naming
  // a revision that was never invalidated is dropped too (a re-fetch, never a
  // guess about which revision the burst reached).
  for (const f of chunks(auth, {
    type: RELAY_TYPE.RESPONSE, stream: 1, correlation,
    ref: tileRef("r-current"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(16),
  })) feed(client, f, RELAY_CODEC.R5G6B5LE);
  expect(results[0].ok).toBe(false);
  expect(results[0].error?.code).toBe(RELAY_ERROR.RESYNC_REQUIRED);
  expect(client.localEntry(tileRef("r-current"))).toBeUndefined();
  expect(client.stats()).toMatchObject({ pending: 0, fencedRevisions: 0 });
  // The escalation belongs to that get alone: the re-fetch lands.
  const again: { ok: boolean }[] = [];
  client.get(1, currentTileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 },
    (r) => again.push(r as { ok: boolean }));
  for (const f of chunks(auth, {
    type: RELAY_TYPE.RESPONSE, stream: 1, correlation: wire.lastRequest().correlation,
    ref: tileRef("r-current"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(16),
  })) feed(client, f, RELAY_CODEC.R5G6B5LE);
  expect(again[0].ok).toBe(true);
  expect(client.localEntry(tileRef("r-current"))).toMatchObject({ revision: "r-current", stale: false });
});

test("G2: below the bound the fence stays exact and a repeated revision is one marker", () => {
  const { client } = makeClient();
  const auth = new RelayResourceAuthority();
  const results: { ok: boolean; error?: { code: string } }[] = [];
  const start = () => {
    const out = client.get(1, currentTileRef(), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072 },
      (r) => results.push(r as { ok: boolean; error?: { code: string } }));
    if (!("correlation" in out)) throw new Error("budget");
    return out.correlation;
  };
  const answer = (correlation: number, revision: string) => {
    for (const f of chunks(auth, {
      type: RELAY_TYPE.RESPONSE, stream: 1, correlation,
      ref: tileRef(revision), codec: RELAY_CODEC.R5G6B5LE, data: zeros(16),
    })) feed(client, f, RELAY_CODEC.R5G6B5LE);
  };
  const invalidate = (revision: string) =>
    feed(client, auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.REVISION, ref: tileRef(revision) }));

  // The same revision invalidated many times is one marker, and a response
  // for another revision lands.
  const c1 = start();
  for (let i = 0; i < 100; i++) invalidate("r1");
  expect(client.stats().fencedRevisions).toBe(1);
  answer(c1, "r2");
  expect(results[0].ok).toBe(true);

  // Exactly the bound: every named revision is fenced, an unnamed one lands.
  const c2 = start();
  for (let i = 0; i < RELAY_MAX_FENCED_REVISIONS; i++) invalidate(`s${i}`);
  expect(client.stats().fencedRevisions).toBe(RELAY_MAX_FENCED_REVISIONS);
  answer(c2, "s3");
  expect(results[1].error?.code).toBe(RELAY_ERROR.RESYNC_REQUIRED);
  const c3 = start();
  for (let i = 0; i < RELAY_MAX_FENCED_REVISIONS; i++) invalidate(`s${i}`);
  answer(c3, "s-new");
  expect(results[2].ok).toBe(true);

  // One distinct revision past the bound: the get is fenced as a whole and
  // its markers are released.
  const c4 = start();
  for (let i = 0; i <= RELAY_MAX_FENCED_REVISIONS; i++) invalidate(`t${i}`);
  expect(client.stats().fencedRevisions).toBe(0);
  answer(c4, "t-new");
  expect(results[3].error?.code).toBe(RELAY_ERROR.RESYNC_REQUIRED);
  expect(client.localEntry(tileRef("t-new"))?.revision).toBe("s-new");
});

test("G3: a push reservation that fails after the subscribe was sent withdraws the provider subscription", () => {
  const { wire, client } = makeClient({ maxAssemblies: 1 });
  const auth = new RelayResourceAuthority();
  const ended: ({ code: string } | undefined)[] = [];
  const completions: { ok: boolean; error?: { code: string } }[] = [];
  const sub = client.subscribe(1, tileRef("r1"), RELAY_DELIVERY.LATEST_SNAPSHOT,
    { onObject: () => { throw new Error("must not deliver"); }, onEnd: (e) => ended.push(e) },
    (r) => completions.push(r as { ok: boolean; error?: { code: string } }));
  expect("correlation" in sub).toBe(true);
  const subscribeReq = wire.lastRequest();
  // Between the send and the terminal response a get takes the last slot.
  const got = client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 1024 }, () => {});
  expect("correlation" in got).toBe(true);
  const answer = auth.answerSubscribe({ stream: 1, correlation: subscribeReq.correlation, metadata: subscribeReq.metadata });
  const id = (answer.metadata.value as { subscription: number }).subscription;
  feed(client, answer);
  // This end admitted nothing and says so to the caller and the handler;
  // review 989 G3 completed the subscribe ok with an id the client never held.
  expect(ended).toEqual([{ code: RELAY_ERROR.BUSY }]);
  expect(completions).toEqual([{ ok: false, error: { code: RELAY_ERROR.BUSY } }]);
  expect(client.subscription(id)).toBeUndefined();
  // The provider holds it active until the withdrawal on the wire is answered.
  expect(auth.subscriptionEntry(id)?.active).toBe(true);
  const withdrawal = wire.lastRequest();
  expect(withdrawal.stream).toBe(1);
  expect(withdrawal.metadata).toEqual({ op: RELAY_OP.RESOURCE_UNSUBSCRIBE, args: { subscription: id } });
  feed(client, auth.answerUnsubscribe({ stream: 1, correlation: withdrawal.correlation, metadata: withdrawal.metadata }));
  expect(auth.subscriptionEntry(id)).toBeUndefined();
  // Only the get is still pending; a push already on the wire is dropped.
  expect(client.stats()).toMatchObject({ pending: 1, subscriptions: 0, orphanedSubscriptions: 0 });
  for (const f of chunks(auth, {
    type: RELAY_TYPE.PUSH, stream: 1, correlation: 0, subscription: id,
    ref: tileRef("r2"), codec: RELAY_CODEC.R5G6B5LE, data: zeros(16),
  })) feed(client, f, RELAY_CODEC.R5G6B5LE);
  expect(client.stats().protocolErrors).toBe(0);
});

test("G3: subscribe refuses BUSY before sending when the assembly budget is full", () => {
  const { wire, client } = makeClient({ maxAssemblies: 1 });
  client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 1024 }, () => {});
  const sentBefore = wire.sent.length;
  const ended: unknown[] = [];
  const out = client.subscribe(1, tileRef("r1"), RELAY_DELIVERY.LATEST_SNAPSHOT,
    { onObject: () => {}, onEnd: (e) => ended.push(e) }, () => { throw new Error("no request, no completion"); });
  // Reserve-then-accept (§3.7), as the get path: nothing reaches the
  // provider, so nothing can leak there; the caller retries on a later frame.
  expect(out).toEqual({ ok: false, code: RELAY_ERROR.BUSY });
  expect(wire.sent.length).toBe(sentBefore);
  expect(ended).toEqual([]);
});

test("G3: a withdrawal the request window refuses is retried on the next incoming frame", () => {
  const { wire, client } = makeClient({ maxAssemblies: 1 });
  const auth = new RelayResourceAuthority();
  client.subscribe(1, tileRef("r1"), RELAY_DELIVERY.LATEST_SNAPSHOT, { onObject: () => {} }, () => {});
  const subscribeReq = wire.lastRequest();
  const getResults: unknown[] = [];
  client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 1024 }, (r) => getResults.push(r));
  const getReq = wire.lastRequest();
  const answer = auth.answerSubscribe({ stream: 1, correlation: subscribeReq.correlation, metadata: subscribeReq.metadata });
  const id = (answer.metadata.value as { subscription: number }).subscription;
  wire.refuseRequest = true; // the L1 request window is full when the response lands
  feed(client, answer);
  expect(wire.lastRequest()).toBe(getReq);
  expect(client.stats().orphanedSubscriptions).toBe(1);
  // Still full: an unrelated frame changes nothing.
  feed(client, auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.KEY, ref: tileRef("r1") }));
  expect(client.stats().orphanedSubscriptions).toBe(1);
  expect(wire.lastRequest()).toBe(getReq);
  // The get's terminal response frees the window; the withdrawal goes out then.
  wire.refuseRequest = false;
  feed(client, auth.answerGetError({ stream: 1, correlation: getReq.correlation }, RELAY_ERROR.NOT_FOUND));
  expect(getResults.length).toBe(1);
  const withdrawal = wire.lastRequest();
  expect(withdrawal.metadata).toEqual({ op: RELAY_OP.RESOURCE_UNSUBSCRIBE, args: { subscription: id } });
  expect(client.stats().orphanedSubscriptions).toBe(0);
  feed(client, auth.answerUnsubscribe({ stream: 1, correlation: withdrawal.correlation, metadata: withdrawal.metadata }));
  expect(auth.subscriptionEntry(id)).toBeUndefined();
  expect(client.stats()).toMatchObject({ pending: 0, orphanedSubscriptions: 0 });
});

test("G3: a stream reset drops a pending withdrawal with the stream's subscriptions", () => {
  const { wire, client } = makeClient({ maxAssemblies: 1 });
  const auth = new RelayResourceAuthority();
  client.subscribe(1, tileRef("r1"), RELAY_DELIVERY.LATEST_SNAPSHOT, { onObject: () => {} }, () => {});
  const subscribeReq = wire.lastRequest();
  client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 1024 }, () => {});
  wire.refuseRequest = true;
  feed(client, auth.answerSubscribe({ stream: 1, correlation: subscribeReq.correlation, metadata: subscribeReq.metadata }));
  expect(client.stats().orphanedSubscriptions).toBe(1);
  // relay.reset / session end: the provider ends every subscription of the
  // stream itself, so the withdrawal has nothing left to withdraw.
  client.resetStream(1);
  wire.refuseRequest = false;
  const sentBefore = wire.sent.length;
  feed(client, auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.KEY, ref: tileRef("r1") }));
  expect(wire.sent.length).toBe(sentBefore);
  expect(client.stats()).toMatchObject({ pending: 0, subscriptions: 0, orphanedSubscriptions: 0 });
});

/** Review 989's three mutation killers (artifact 9565), taken in as written
 * up to the shared helpers: each is the sole test that turns one mutation
 * of the P4r delta red (A5, B5, C5 in the review's mutation round). */

test("TEETH A5: a notModified naming an invalidated revision is fenced", () => {
  const { wire, client } = makeClient();
  const auth = new RelayResourceAuthority();
  const results: { ok: boolean; error?: { code: string } }[] = [];
  client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 131072, ifRevision: "r1" },
    (r) => results.push(r as { ok: boolean; error?: { code: string } }));
  feed(client, auth.buildInvalidate({ stream: 1, scope: RELAY_INVALIDATE_SCOPE.REVISION, ref: tileRef("r1") }));
  feed(client, auth.answerNotModified({ stream: 1, correlation: wire.lastRequest().correlation }, tileRef("r1")));
  expect(results[0].ok).toBe(false);
  expect(results[0].error?.code).toBe(RELAY_ERROR.RESYNC_REQUIRED);
});

test("TEETH B5: a wrong-base delta latches resync for the next object", () => {
  const { wire, client } = makeClient();
  const auth = new RelayResourceAuthority();
  const marks: boolean[] = [];
  client.subscribe(1, tileRef("r1"), RELAY_DELIVERY.RELIABLE_DELTA,
    { onObject: (_o, ctx) => marks.push(ctx.resyncRequired) }, () => {});
  feed(client, auth.answerSubscribe({
    stream: 1, correlation: wire.lastRequest().correlation, metadata: wire.lastRequest().metadata,
  }));
  const id = client.subscription(1)!.id;
  const push = (revision: string, baseRevision?: string) => {
    for (const f of chunks(auth, {
      type: RELAY_TYPE.PUSH, stream: 1, correlation: 0, subscription: id,
      ref: tileRef(revision), codec: RELAY_CODEC.R5G6B5LE, data: zeros(64), baseRevision,
    })) feed(client, f, RELAY_CODEC.R5G6B5LE);
  };
  push("r2", "wrong");
  expect(client.subscription(id)!.resyncRequired).toBe(true);
  // The held base is still r1, so a delta on r1 must stay marked until a
  // full snapshot recovers the subscription.
  push("r3", "r1");
  expect(marks).toEqual([true, true]);
});

test("TEETH C5: a post-send reservation failure withdraws the request", () => {
  const { wire, client } = makeClient({ maxAssemblies: 4 });
  client.get(1, tileRef("r1"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 1024 }, () => {});
  wire.correlation = 0; // the wire hands out an already-reserved correlation
  const second = client.get(1, tileRef("r2"), { accept: [RELAY_CODEC.R5G6B5LE], maxObjectBytes: 1024 }, () => {});
  expect(second).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(wire.cancels).toEqual([{ stream: 1, correlation: 1, reason: "busy" }]);
});
