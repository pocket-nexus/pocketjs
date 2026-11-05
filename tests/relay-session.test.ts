import { expect, test } from "bun:test";
import {
  createRelaySession,
  limitsAreUsable,
  RELAY_LIMITS,
  type RelayLocalCapabilities,
  type RelayNegotiation,
  type RelayPeerContext,
  type RelayPhase,
  type RelayScheduler,
  type RelaySession,
  type RelayTransportAdapter,
} from "../framework/src/relay/session.ts";
import { decodeFrame, encodeFrame } from "../framework/src/relay/frame.ts";
import { validateRelaySchema } from "../framework/src/relay/metadata-schema.ts";
import { RELAY_METADATA_SCHEMAS } from "../contracts/spec/relay.ts";
import {
  RELAY_CODEC,
  RELAY_ERROR,
  RELAY_OP,
  RELAY_STATUS,
  RELAY_TYPE,
  type RelayProfileEntry,
  type RelayRxLimits,
} from "../contracts/spec/relay.ts";

// --- deterministic infrastructure --------------------------------------------

const RX_LIMITS: RelayRxLimits = {
  maxWireBytes: 4096, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 32768,
  maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 2, maxScratchBytes: 262144,
};

function fakeScheduler(): RelayScheduler & { advance(ms: number): void; pending: () => number } {
  let now = 0;
  let nextId = 1;
  const jobs = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; jobs.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { jobs.delete(id); },
    pending: () => jobs.size,
    advance(ms: number) {
      const until = now + ms;
      // Fire jobs in deadline order, stepping now to the deadline first: a
      // timer rescheduled inside a callback lands `ms` later (real
      // setTimeout semantics), not at the pre-drain instant.
      for (;;) {
        let dueId = 0;
        let dueAtValue = 0;
        let dueFn: (() => void) | undefined;
        for (const [id, job] of jobs) {
          if (job.at <= until && (dueFn === undefined || job.at < dueAtValue)) {
            dueId = id; dueAtValue = job.at; dueFn = job.fn;
          }
        }
        if (dueFn === undefined) break;
        now = dueAtValue;
        jobs.delete(dueId);
        dueFn();
      }
      now = until;
    },
  };
}

/** Deterministic "random" bytes from a counter so sessions/nonces are
 * reproducible and never all-zero. */
function seededBytes(seed: number) {
  let counter = seed;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      counter = (counter * 1103515245 + 12345) >>> 0;
      out[i] = (counter >>> 16) & 0xff;
    }
    return out;
  };
}

interface CapturedFrame {
  bytes: Uint8Array;
  from: "guest" | "provider";
}

interface PairHooks {
  sync?: boolean;
  guestCaps?: Partial<RelayLocalCapabilities>;
  providerCaps?: Partial<RelayLocalCapabilities>;
  grants?: string[];
  sendPolicy?: {
    guest?: (bytes: Uint8Array) => "accepted" | "busy" | "offline";
    provider?: (bytes: Uint8Array) => "accepted" | "busy" | "offline";
  };
  pingIntervalMs?: number;
  stallMs?: number;
  retryMs?: number;
  onCredit?: (m: Record<string, unknown>) => void;
  onReset?: (m: Record<string, unknown>) => void;
  onBusiness?: (who: "guest" | "provider", f: ReturnType<typeof decodeFrame>) => void;
  authorizeOpen?: (req: { app: string; namespace: string; profile: RelayProfileEntry }) => string | null;
}

interface Pair {
  guest: RelaySession;
  provider: RelaySession;
  clocks: { guest: ReturnType<typeof fakeScheduler>; provider: ReturnType<typeof fakeScheduler> };
  wire: CapturedFrame[];
  phases: { guest: RelayPhase[]; provider: RelayPhase[] };
  deliver: boolean;
  flush: () => Promise<void>;
}

function makePair(hooks: PairHooks = {}): Pair {
  const sync = hooks.sync ?? false;
  const wire: CapturedFrame[] = [];
  const phases = { guest: [] as RelayPhase[], provider: [] as RelayPhase[] };
  const pair: Partial<Pair> = { wire, phases, deliver: true };

  const caps = (app?: string): RelayLocalCapabilities => ({
    app,
    versions: [[1, 0]],
    profiles: [{ name: "map.raster", version: 1 }, { name: "term.cells", version: 1 }],
    codecs: [RELAY_CODEC.NONE, RELAY_CODEC.JSON, RELAY_CODEC.R5G6B5LE],
    kinds: [1, 6],
    rxLimits: RX_LIMITS,
  });
  const peer = (id: string): RelayPeerContext => ({ id, grants: hooks.grants ?? ["pocket-map"] });

  const gClock = fakeScheduler(), pClock = fakeScheduler();
  pair.clocks = { guest: gClock, provider: pClock };

  const route = (from: "guest" | "provider", bytes: Uint8Array,
      policy?: (b: Uint8Array) => "accepted" | "busy" | "offline"): "accepted" | "busy" | "offline" => {
    const decision = policy?.(bytes) ?? "accepted";
    if (decision !== "accepted") return decision;
    wire.push({ bytes: bytes.slice(), from });
    if (!pair.deliver) return "accepted";
    const target = from === "guest" ? "provider" : "guest";
    const deliver = () => (target === "provider" ? provider : guest).handleRecord(bytes);
    if (sync) deliver(); else queueMicrotask(deliver);
    return "accepted";
  };

  const guestAdapter: RelayTransportAdapter = {
    peer: peer("device-1"),
    trySend: (b) => route("guest", b, hooks.sendPolicy?.guest),
  };
  const providerAdapter: RelayTransportAdapter = {
    peer: peer("companion-1"),
    trySend: (b) => route("provider", b, hooks.sendPolicy?.provider),
  };

  const guest = createRelaySession({
    role: "guest",
    transport: guestAdapter,
    local: { ...caps("pocket-map"), ...hooks.guestCaps },
    scheduler: gClock,
    randomBytes: seededBytes(0x47),
    pingIntervalMs: hooks.pingIntervalMs ?? 2000,
    stallMs: hooks.stallMs ?? 15000,
    retryMs: hooks.retryMs ?? 1500,
    onPhase: (p) => phases.guest.push(p),
    onCredit: hooks.onCredit,
    onReset: hooks.onReset,
    onBusinessFrame: (f) => hooks.onBusiness?.("guest", { ok: true, frame: f } as never),
  });
  const provider = createRelaySession({
    role: "provider",
    transport: providerAdapter,
    local: { ...caps(), ...hooks.providerCaps },
    scheduler: pClock,
    randomBytes: seededBytes(0x50),
    pingIntervalMs: hooks.pingIntervalMs ?? 2000,
    stallMs: hooks.stallMs ?? 15000,
    retryMs: hooks.retryMs ?? 1500,
    onPhase: (p) => phases.provider.push(p),
    onBusinessFrame: (f) => hooks.onBusiness?.("provider", { ok: true, frame: f } as never),
    authorizeOpen: hooks.authorizeOpen as never,
  });

  pair.guest = guest; pair.provider = provider;
  pair.flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  return pair as Pair;
}

async function handshake(pair: Pair): Promise<void> {
  const ready = pair.guest.whenReady();
  const result = pair.guest.hello();
  expect(result.ok).toBe(true);
  await pair.flush();
  await ready;
  expect(pair.guest.phase).toBe("ready");
  expect(pair.provider.phase).toBe("ready");
}

const lastFrames = (pair: Pair, from: "guest" | "provider", n: number) =>
  pair.wire.filter((f) => f.from === from).slice(-n);

/** Assert a local send was refused with exactly `code` (TS narrowing). */
function expectRefused(result: { ok: true } | { ok: false; code: string }, code: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}
// Capture inspection decodes without a session pin: the wire log spans
// session 0 (bootstrap) and the pinned session, and the machine itself
// owns session fencing (tested in its own cases).
const decode = (f: CapturedFrame) => {
  const r = decodeFrame(f.bytes, { maxWireBytes: 4096 });
  if (!r.ok) throw new Error(`captured frame did not decode: ${r.code}`);
  return r.frame;
};

// =============================================================================
// 1. Six-step handshake over a fake-transport pair (sync and async delivery)
// =============================================================================

for (const sync of [false, true]) {
  test(`handshake: HELLO(session 0,seq 1,corr 1) -> selection -> READY, both READY (${sync ? "sync" : "async"} transport)`, async () => {
    const pair = makePair({ sync });
    const ready = pair.guest.whenReady();
    const hello = pair.guest.hello();
    expect(hello.ok).toBe(true);

    // The first frame is the bootstrap HELLO: session 0, seq 1, corr 1.
    const first = pair.wire[0];
    expect(first.from).toBe("guest");
    const helloFrame = decode(first);
    expect(helloFrame.session).toBe(0n);
    expect(helloFrame.seq).toBe(1);
    expect(helloFrame.stream).toBe(0);
    expect(helloFrame.correlation).toBe(1);
    expect(helloFrame.metadata.op).toBe(RELAY_OP.HELLO);
    expect(first.bytes.length).toBeLessThanOrEqual(RELAY_LIMITS.bootstrapMaxWireBytes);

    await pair.flush();
    const negotiation: RelayNegotiation = await ready;
    expect(pair.guest.phase).toBe("ready");
    expect(pair.provider.phase).toBe("ready");

    // Provider selection rode session 0 and echoed the boot nonce.
    const helloResp = pair.wire.find((f) => f.from === "provider"
      && decode(f).metadata.op === RELAY_OP.HELLO)!;
    const resp = decode(helloResp);
    expect(resp.session).toBe(0n);
    expect(resp.correlation).toBe(1);
    expect(resp.metadata.bootNonce).toBe(helloFrame.metadata.bootNonce);
    expect(resp.metadata.session).toMatch(/^[0-9a-f]{16}$/);
    expect(resp.metadata.session).not.toBe("0000000000000000");
    expect(helloResp.bytes.length).toBeLessThanOrEqual(RELAY_LIMITS.bootstrapMaxWireBytes);

    // READY and its ack ride the new session with seq restarted at 1.
    const sid = pair.guest.sessionId;
    expect(sid).not.toBe(0n);
    const readyReq = pair.wire.find((f) => f.from === "guest"
      && decode(f).metadata.op === RELAY_OP.READY)!;
    expect(decode(readyReq).seq).toBe(1);
    expect(pair.provider.sessionId).toBe(sid);

    expect(negotiation.version).toEqual([1, 0]);
    // Intersection: provider offers both profiles and all three codecs.
    expect(negotiation.profiles).toEqual([
      { name: "map.raster", version: 1 }, { name: "term.cells", version: 1 },
    ]);
    expect(negotiation.codecs).toEqual([0, 1, 257]);
    expect(negotiation.grants).toEqual(["pocket-map"]);
    expect(negotiation.rxLimits.maxWireBytes).toBe(RX_LIMITS.maxWireBytes);
  });
}

test("a reset stream id cannot be rebound by a later OPEN response", async () => {
  const pair = makePair({ sync: true });
  await handshake(pair);
  const request = { app: "pocket-map", namespace: "map/demo", profile: { name: "map.raster", version: 1 } };
  const opened = await pair.guest.open(request);
  const firstResponse = decode(lastFrames(pair, "provider", 1)[0]);
  pair.guest.forgetStream(opened.stream);
  pair.provider.forgetStream(opened.stream);
  pair.deliver = false;
  const pending = pair.guest.open(request);
  const nextRequest = decode(lastFrames(pair, "guest", 1)[0]);
  const reused = encodeFrame({
    type: RELAY_TYPE.RESPONSE, session: pair.guest.sessionId, seq: firstResponse.seq + 1, stream: 0,
    correlation: nextRequest.correlation, metadata: firstResponse.metadata,
  });
  if (!reused.ok) throw new Error(reused.code);
  pair.guest.handleRecord(reused.bytes);
  await expect(pending).rejects.toBe("BAD_STREAM");
  expect(pair.guest.streamIds()).toEqual([]);
  pair.guest.close(); pair.provider.close();
});

test("u32 stream exhaustion returns RESYNC_REQUIRED and never wraps the id", async () => {
  const pair = makePair({ sync: true });
  await handshake(pair);
  // Exercise the wire boundary without billions of OPEN messages.
  (pair.provider as unknown as { nextProviderStream: number }).nextProviderStream = 0xffffffff;
  const request = { app: "pocket-map", namespace: "map/demo", profile: { name: "map.raster", version: 1 } };
  const last = await pair.guest.open(request);
  expect(last.stream).toBe(0xffffffff);
  pair.guest.forgetStream(last.stream);
  pair.provider.forgetStream(last.stream);
  await expect(pair.guest.open(request)).rejects.toBe(RELAY_ERROR.RESYNC_REQUIRED);
  expect(pair.guest.streamIds()).toEqual([]);
  expect(pair.provider.streamIds()).toEqual([]);
  pair.guest.close(); pair.provider.close();
});

// =============================================================================
// 2. OPEN allocates provider-owned, never-reused streams; per-stream seq spaces
// =============================================================================

for (const sync of [false, true]) {
  test(`OPEN allows eight live streams with monotonic ids; seq runs per (session, stream, direction) (${sync ? "sync" : "async"})`, async () => {
    const business: unknown[] = [];
    const pair = makePair({ sync, onBusiness: (_w, f) => business.push((f as { frame: unknown }).frame) });
    await handshake(pair);
    const sid = pair.guest.sessionId;

    const open1 = await pair.guest.open({
      app: "pocket-map", namespace: "map/demo",
      profile: { name: "map.raster", version: 1 }, codecs: [0, 1],
    });
    await pair.flush();
    expect(open1.stream).toBe(1);
    const open2 = await pair.guest.open({
      app: "pocket-map", namespace: "map/term",
      profile: { name: "term.cells", version: 1 },
    });
    await pair.flush();
    expect(open2.stream).toBe(2);
    expect(pair.provider.streamInfo(1)?.namespace).toBe("map/demo");
    expect(pair.provider.streamInfo(2)?.namespace).toBe("map/term");

    // Business frames on stream 1 start seq 1 in each direction, while
    // stream 0 (READY seq 1, OPEN seq 2) keeps its own counter.
    const g = pair.guest.sendBusiness({
      type: RELAY_TYPE.REQUEST, stream: 1, correlation: 1,
      metadata: { op: "resource.get", resource: { kind: 1, ns: "map/demo", key: "z/1", rendition: "r5g6b5le-256-v1" } },
    });
    expect(g.ok).toBe(true);
    const p = pair.provider.sendBusiness({
      type: RELAY_TYPE.PUSH, stream: 1,
      metadata: { op: "map.chunk", subscription: 1, final: true },
    });
    expect(p.ok).toBe(true);
    await pair.flush();
    expect(business.length).toBe(2);

    const guestBiz = decode(lastFrames(pair, "guest", 1)[0]);
    const providerBiz = decode(lastFrames(pair, "provider", 1)[0]);
    expect(guestBiz.stream).toBe(1); expect(guestBiz.seq).toBe(1);
    expect(providerBiz.stream).toBe(1); expect(providerBiz.seq).toBe(1);

    // A ninth non-zero stream is refused BUSY (maxStreams = 8).
    for (let i = 3; i <= 8; i++) {
      const r = await pair.guest.open({
        app: "pocket-map", namespace: `ns/${i}`,
        profile: { name: "map.raster", version: 1 },
      });
      expect(r.stream).toBe(i);
      await pair.flush();
    }
    await expect(pair.guest.open({
      app: "pocket-map", namespace: "ns/9", profile: { name: "map.raster", version: 1 },
    })).rejects.toBe(RELAY_ERROR.BUSY);
    // Free one binding without ending the session. The next id is 9, not
    // a reuse of 1, and the number of live bindings remains capped at 8.
    pair.guest.forgetStream(1);
    pair.provider.forgetStream(1);
    const ninth = await pair.guest.open({
      app: "pocket-map", namespace: "ns/9", profile: { name: "map.raster", version: 1 },
    });
    await pair.flush();
    expect(ninth.stream).toBe(9);
    expect(pair.guest.streamIds()).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pair.provider.streamIds()).toEqual(pair.guest.streamIds());
    expect(pair.guest.sessionId).toBe(sid);
    await expect(pair.guest.open({
      app: "pocket-map", namespace: "ns/10", profile: { name: "map.raster", version: 1 },
    })).rejects.toBe(RELAY_ERROR.BUSY);

    // Business before a known stream, and on stream 0, are refused locally.
    const badStream = pair.guest.sendBusiness({ type: 3, stream: 99, metadata: { op: "x" } });
    expect(badStream.ok).toBe(false);
    if (!badStream.ok) expect(badStream.code).toBe("BAD_STREAM");
    const streamZero = pair.guest.sendBusiness({ type: 3, stream: 0, metadata: { op: "x" } });
    expect(streamZero.ok).toBe(false);
    if (!streamZero.ok) expect(streamZero.code).toBe("BAD_STREAM");
  });
}

// =============================================================================
// 3. Negotiation matrix
// =============================================================================

test("negotiation: no common version -> UNSUPPORTED error then the provider disconnects", async () => {
  const pair = makePair({ guestCaps: { versions: [[2, 0]] } });
  const ready = pair.guest.whenReady();
  expect(pair.guest.hello().ok).toBe(true);
  await pair.flush();
  await expect(ready).rejects.toThrow(/UNSUPPORTED/);
  expect(pair.guest.phase).toBe("closed");
  expect(pair.provider.phase).toBe("closed");
  expect(pair.guest.getStats().handshakeFailures).toBe(1);
});

test("negotiation: no common profile -> UNSUPPORTED", async () => {
  const pair = makePair({
    guestCaps: { profiles: [{ name: "vault.doc", version: 9 }] },
  });
  const ready = pair.guest.whenReady();
  pair.guest.hello();
  await pair.flush();
  await expect(ready).rejects.toThrow(/UNSUPPORTED/);
});

test("negotiation: no common kind -> UNSUPPORTED", async () => {
  const pair = makePair({ guestCaps: { kinds: [3, 8] } });
  const ready = pair.guest.whenReady();
  pair.guest.hello();
  await pair.flush();
  await expect(ready).rejects.toThrow(/UNSUPPORTED/);
});

test("negotiation: app outside adapter grants -> UNAUTHORIZED", async () => {
  const pair = makePair({ grants: ["pocket-term"] });
  const ready = pair.guest.whenReady();
  pair.guest.hello();
  await pair.flush();
  await expect(ready).rejects.toThrow(/UNAUTHORIZED/);
  expect(pair.guest.phase).toBe("closed");
});

test("negotiation: rxLimits are min(local, peer); a smaller peer shrinks every field", async () => {
  const smaller: RelayRxLimits = {
    ...RX_LIMITS,
    maxWireBytes: 2048,
    maxMetaBytes: 1024,
    windowFrames: 4,
    maxPending: 2,
  };
  const pair = makePair({ providerCaps: { rxLimits: smaller } });
  await handshake(pair);
  const n = pair.guest.negotiation!;
  expect(n.rxLimits.maxWireBytes).toBe(2048);
  expect(n.rxLimits.maxMetaBytes).toBe(1024);
  expect(n.rxLimits.windowFrames).toBe(4);
  expect(n.rxLimits.maxPending).toBe(2);
  // Fields where the peer was not smaller keep the local value.
  expect(n.rxLimits.windowBytes).toBe(RX_LIMITS.windowBytes);
  expect(n.rxLimits.maxObjectBytes).toBe(RX_LIMITS.maxObjectBytes);
});

test("negotiation: a peer advertising unusable limits (zero / window smaller than one frame) is refused", () => {
  const zero: RelayRxLimits = { ...RX_LIMITS, maxPending: 0 };
  const windowTooSmall: RelayRxLimits = { ...RX_LIMITS, windowBytes: 32 };
  expect(limitsAreUsable(zero)).toBe(false);
  expect(limitsAreUsable(windowTooSmall)).toBe(false);
  expect(limitsAreUsable(RX_LIMITS)).toBe(true);
});

test("negotiation: codecs are the exact intersection in client order, always including 0", async () => {
  const pair = makePair({
    providerCaps: { codecs: [RELAY_CODEC.NONE, RELAY_CODEC.R5G6B5LE, RELAY_CODEC.FONT3] },
  });
  await handshake(pair);
  expect(pair.guest.negotiation!.codecs).toEqual([0, 257]);
});

test("B-2 negotiation: kinds are the exact intersection on both ends (guest [1,6,7] vs provider [1])", async () => {
  const pair = makePair({
    guestCaps: { kinds: [1, 6, 7] },
    providerCaps: { kinds: [1] },
  });
  await handshake(pair);
  // Draft §3.2 field table: codecs/kinds are chosen by mutual intersection;
  // a value not selected is rejected. Both ends must record the same set.
  expect(pair.provider.negotiation!.kinds).toEqual([1]);
  expect(pair.guest.negotiation!.kinds).toEqual([1]);
});

test("B-2 negotiation: kinds intersection keeps guest order and rejects 6/7 the provider did not pick", async () => {
  const pair = makePair({
    guestCaps: { kinds: [7, 6, 1] },
    providerCaps: { kinds: [1, 6] },
  });
  await handshake(pair);
  // Provider filters the guest's offer into its own set, so guest order
  // [7,6,1] narrows to [6,1]; both ends record the same list.
  expect(pair.guest.negotiation!.kinds).toEqual([6, 1]);
  expect(pair.provider.negotiation!.kinds).toEqual([6, 1]);
});

test("B-2 handshake: a HELLO response claiming a kind the guest never offered tears the guest down", async () => {
  // Capture a well-formed provider response from a donor pair, then hand a
  // copy to a fresh guest with its own bootNonce but kinds [3,8] (the
  // default guest offers only [1,6]).
  const donor = makePair();
  donor.guest.hello();
  await donor.flush();
  const real = decode(donor.wire.find((f) => f.from === "provider")!);
  expect(real.metadata.op).toBe(RELAY_OP.HELLO);

  const solo = makePair();
  solo.guest.hello(); // async transport: only the guest HELLO is on the wire
  const ownHello = decode(solo.wire[0]);
  expect(ownHello.metadata.op).toBe(RELAY_OP.HELLO);
  solo.provider.close(); // never deliver the real response
  expect(solo.guest.phase).toBe("hello-sent");

  const bytes = encodeFrame({
    type: RELAY_TYPE.RESPONSE, codec: 0, session: 0n, seq: 1, stream: 0, correlation: 1,
    metadata: {
      ...real.metadata,
      bootNonce: ownHello.metadata.bootNonce, // pass the replay check first
      kinds: [3, 8],
    },
  }, { maxWireBytes: 4096, codecs: [0] });
  if (!bytes.ok) throw new Error(bytes.code);
  solo.guest.handleRecord(bytes.bytes);
  expect(solo.guest.phase).toBe("closed");
});

test("B-4 schema: the HELLO response requires kinds, so an omitted field fails at both ends", () => {
  // The provider validates its own response against this schema before
  // the send (controlResponse) and the guest validates what it receives:
  // one required entry covers both ends.
  const schema = RELAY_METADATA_SCHEMAS[`${RELAY_OP.HELLO}.response`] as Record<string, unknown>;
  const response = {
    op: RELAY_OP.HELLO, status: RELAY_STATUS.OK, final: true,
    bootNonce: "00112233445566778899aabbccddeeff",
    peerNonce: "ffeeddccbbaa99887766554433221100",
    session: "0102030405060708", selected: [1, 0],
    profiles: [{ name: "map.raster", version: 1 }],
    codecs: [0], kinds: [1], grants: ["pocket-map"], rxLimits: RX_LIMITS,
  };
  expect(validateRelaySchema(schema, response)).toBeNull();
  const { kinds: _omittedKinds, ...withoutKinds } = response;
  expect(validateRelaySchema(schema, withoutKinds)).toContain("missing kinds");
  // codecs stays optional: its fallback is the codec set [0], which never
  // claims a codec the peer did not confirm.
  const { codecs: _omittedCodecs, ...withoutCodecs } = response;
  expect(validateRelaySchema(schema, withoutCodecs)).toBeNull();
});

test("B-4 handshake: a HELLO response without kinds is UNSUPPORTED and closes the guest", async () => {
  // Review 988 replayed the pre-fix provider: it narrows the guest offer
  // [1,6,7] to [1] but its response carries no kinds field, and the old
  // guest fell back to its whole offer. The field is now required: the
  // guest closes instead of claiming an intersection the peer never
  // confirmed.
  const donor = makePair({ guestCaps: { kinds: [1, 6, 7] }, providerCaps: { kinds: [1] } });
  await handshake(donor);
  expect(donor.provider.negotiation!.kinds).toEqual([1]);
  const real = decode(donor.wire.find((f) => f.from === "provider"
    && decode(f).metadata.op === RELAY_OP.HELLO)!);
  const { kinds: _omitted, ...withoutKinds } = real.metadata;

  const solo = makePair({ guestCaps: { kinds: [1, 6, 7] }, providerCaps: { kinds: [1] } });
  const ready = solo.guest.whenReady();
  solo.guest.hello(); // async transport: only the guest HELLO is on the wire
  const ownHello = decode(solo.wire[0]);
  solo.provider.close(); // never deliver the real response
  expect(solo.guest.phase).toBe("hello-sent");

  const stripped = encodeFrame({
    type: RELAY_TYPE.RESPONSE, codec: 0, session: 0n, seq: 1, stream: 0, correlation: 1,
    metadata: { ...withoutKinds, bootNonce: ownHello.metadata.bootNonce },
  }, { maxWireBytes: 4096, codecs: [0] });
  if (!stripped.ok) throw new Error(stripped.code);
  solo.guest.handleRecord(stripped.bytes);
  expect(solo.guest.phase).toBe("closed");
  expect(solo.guest.negotiation).toBeUndefined();
  expect(solo.guest.getStats().handshakeFailures).toBe(1);
  await expect(ready).rejects.toThrow(/UNSUPPORTED/);
});

test("OPEN outside grants or with a non-negotiated profile/codec is refused", async () => {
  const pair = makePair();
  await handshake(pair);
  await expect(pair.guest.open({
    app: "pocket-term", namespace: "x", profile: { name: "map.raster", version: 1 },
  })).rejects.toBe(RELAY_ERROR.UNAUTHORIZED);
  await expect(pair.guest.open({
    app: "pocket-map", namespace: "x", profile: { name: "vault.doc", version: 1 },
  })).rejects.toBe(RELAY_ERROR.UNSUPPORTED);
  await expect(pair.guest.open({
    app: "pocket-map", namespace: "x", profile: { name: "map.raster", version: 1 },
    codecs: [RELAY_CODEC.FONT3],
  })).rejects.toBe(RELAY_ERROR.UNSUPPORTED);
});

test("authorizeOpen hook can refuse with a stable error code", async () => {
  const pair = makePair({ authorizeOpen: () => RELAY_ERROR.BUSY });
  await handshake(pair);
  await expect(pair.guest.open({
    app: "pocket-map", namespace: "x", profile: { name: "map.raster", version: 1 },
  })).rejects.toBe(RELAY_ERROR.BUSY);
  expect(pair.provider.streamInfo(1)).toBeUndefined();
});

// =============================================================================
// 4. Reconnect / realm reset: a new session carries nothing over; old frames die
// =============================================================================

test("reconnect: frames from the pinned-old session are dropped, no business delivery", async () => {
  const pair = makePair();
  await handshake(pair);
  const oldSid = pair.guest.sessionId;
  // Capture a frame that belonged to the old session (provider push).
  const stale = encodeFrame({
    type: RELAY_TYPE.PUSH, codec: 0, session: oldSid, seq: 99, stream: 1, correlation: 0,
    metadata: { op: "map.chunk", subscription: 1, final: true },
  }, { maxWireBytes: 4096, codecs: [0] });
  if (!stale.ok) throw new Error(stale.code);
  const staleBytes = stale.bytes;

  // Physical reconnect: both sides forget the session; a fresh HELLO runs.
  pair.guest.handleDisconnect("tcp reset");
  pair.provider.handleDisconnect("tcp reset");
  await pair.flush();
  expect(pair.guest.sessionId).toBe(0n);
  await handshake(pair);
  expect(pair.guest.sessionId).not.toBe(oldSid);

  const before = pair.guest.getStats().framesReceived;
  pair.guest.handleRecord(staleBytes); // old session -> BAD_SESSION
  expect(pair.guest.getStats().droppedStaleSession).toBe(1);
  expect(pair.guest.getStats().framesReceived).toBe(before);
  expect(pair.guest.phase).toBe("ready");
});

test("guest realm reset starts a fresh session; seq and credits do not carry over", async () => {
  const pair = makePair();
  await handshake(pair);
  const opened = await pair.guest.open({
    app: "pocket-map", namespace: "map/demo", profile: { name: "map.raster", version: 1 },
  });
  await pair.flush();
  pair.guest.sendBusiness({ type: 3, stream: opened.stream, metadata: { op: "x", subscription: 1 } });
  await pair.flush();
  const oldSid = pair.guest.sessionId;

  pair.guest.realmReset();
  pair.provider.handleDisconnect("guest realm reset");
  await pair.flush();
  expect(pair.guest.phase).toBe("idle");

  await handshake(pair);
  expect(pair.guest.sessionId).not.toBe(oldSid);
  // Stream bindings and seq spaces are gone: the old stream id is unknown
  // until OPEN allocates it again, and the new seq starts at 1.
  expect(pair.provider.streamInfo(1)).toBeUndefined();
  const again = await pair.guest.open({
    app: "pocket-map", namespace: "map/demo", profile: { name: "map.raster", version: 1 },
  });
  await pair.flush();
  expect(again.stream).toBe(1); // re-allocated from 1 on the new session
  expect(pair.guest.sendBusiness({
    type: 3, stream: 1, metadata: { op: "y", subscription: 1 },
  }).ok).toBe(true);
  const sid = pair.guest.sessionId;
  expect(decode(lastFrames(pair, "guest", 1)[0]).seq).toBe(1);
});

// =============================================================================
// 5. Liveness: ping 2 s, stall 15 s, busy retry 1.5 s
// =============================================================================

test("ping: REQUEST every 2 s with an echoed u32 token; one outstanding ping", async () => {
  const pair = makePair();
  await handshake(pair);
  pair.clocks.guest.advance(2000);
  await pair.flush();
  expect(pair.guest.getStats().pingsSent).toBe(1);
  expect(pair.provider.getStats().pingsReceived).toBe(1);
  const sid = pair.guest.sessionId;
  const pingFrame = decode(lastFrames(pair, "guest", 1)[0]);
  expect(pingFrame.metadata.op).toBe(RELAY_OP.PING);
  const token = pingFrame.metadata.token;
  const pong = lastFrames(pair, "provider", 1)[0];
  expect(decode(pong).metadata.token).toBe(token);
  // The answered ping cleared the outstanding slot; the next interval
  // sends ping 2 instead of being suppressed.
  pair.clocks.guest.advance(2000);
  await pair.flush();
  expect(pair.guest.getStats().pingsSent).toBe(2);
  expect(pair.guest.phase).toBe("ready");
});

test("stall: 15 s without an inbound frame tears the session down", async () => {
  const pair = makePair({ pingIntervalMs: 10 ** 9 });
  await handshake(pair);
  // Freeze the line after READY; the provider answers nothing.
  pair.deliver = false;
  pair.clocks.provider.advance(15000);
  expect(pair.provider.phase).toBe("closed");
  expect(pair.provider.getStats().pingTimeouts).toBe(1);
});

test("retry: a BUSY adapter on HELLO retries after 1.5 s and then completes", async () => {
  let busyOnce = true;
  const pair = makePair({
    sendPolicy: { guest: () => { if (busyOnce) { busyOnce = false; return "busy"; } return "accepted"; } },
    retryMs: 1500,
  });
  const first = pair.guest.hello();
  expect(first.ok).toBe(false);
  if (!first.ok) expect(first.code).toBe("BUSY");
  expect(pair.guest.phase).toBe("idle");
  expect(pair.guest.getStats().helloBusyRetries).toBe(1);
  pair.clocks.guest.advance(1500);
  await pair.flush();
  expect(pair.guest.phase).toBe("ready");
  expect(pair.provider.phase).toBe("ready");
});

test("offline: a dead adapter while sending tears the session down", () => {
  const pair = makePair({
    sendPolicy: { guest: () => "offline" },
  });
  const result = pair.guest.hello();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe("OFFLINE");
  expect(pair.guest.phase).toBe("closed");
});

// =============================================================================
// 6. Property: seq is contiguous and strictly increasing per (session, stream,
//    direction), and restarts at 1 on every new session
// =============================================================================

test("property: 300 random frames keep contiguous per-space seq; new sessions restart at 1", async () => {
  function mulberry32(seed: number) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(0x52455353);
  for (let round = 0; round < 2; round++) {
    const pair = makePair();
    await handshake(pair);
    const sid = pair.guest.sessionId;
    const openCount = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < openCount; i++) {
      // eslint-disable-next-line no-await-in-loop
      await pair.guest.open({
        app: "pocket-map", namespace: `ns/${i + 1}`, profile: { name: "map.raster", version: 1 },
      });
      // eslint-disable-next-line no-await-in-loop
      await pair.flush();
    }
    const perSpace: Record<string, number[]> = {};
    const observe = () => {
      for (const f of pair.wire) {
        const dec = decode(f);
        if (dec.session !== sid) continue; // bootstrap frames rode session 0
        const key = `${f.from}:${dec.stream}`;
        (perSpace[key] ??= []).push(dec.seq);
      }
      pair.wire.length = 0;
    };
    for (let i = 0; i < 300; i++) {
      const stream = 1 + Math.floor(rnd() * openCount);
      const sender = rnd() < 0.5 ? pair.guest : pair.provider;
      const result = sender.sendBusiness({
        type: RELAY_TYPE.PUSH, stream,
        metadata: { op: "map.chunk", subscription: stream, n: i, final: true },
      });
      if (!result.ok) throw new Error(`frame ${i}: ${result.code}`);
    }
    await pair.flush();
    observe();
    for (const [key, seqs] of Object.entries(perSpace)) {
      let prev = 0;
      for (const seq of seqs) {
        expect(seq, `${key} gap/dup`).toBe(prev + 1);
        prev = seq;
      }
    }
    // Stream 0 carried READY + openCount OPEN frames from the guest and
    // READY ack (+pings suppressed) from the provider: contiguous from 1.
    expect(perSpace["guest:0"][0]).toBe(1);
    expect(perSpace["provider:0"][0]).toBe(1);
    pair.guest.close(); pair.provider.close();
  }
});

// =============================================================================
// 7. Credit/reset hooks and unknown control traffic
// =============================================================================

test("relay.credit PUSH reaches the credit hook, never the business hook", async () => {
  const credits: Record<string, unknown>[] = [];
  const business: unknown[] = [];
  const pair = makePair({
    pingIntervalMs: 10 ** 9,
    onCredit: (m) => credits.push(m),
    onBusiness: () => business.push(1),
  });
  await handshake(pair);
  const sid = pair.guest.sessionId;
  // Provider sent exactly READY-ack (stream 0 seq 1) after READY; credit
  // is the next stream-0 frame, seq 2.
  const credit = encodeFrame({
    type: RELAY_TYPE.PUSH, codec: 0, session: sid, seq: 2, stream: 0, correlation: 0,
    metadata: {
      op: RELAY_OP.CREDIT, targetStream: 1,
      framesReleased: "0000000000000003", bytesReleased: "000000000000a000",
    },
  }, { maxWireBytes: 4096, codecs: [0] });
  if (!credit.ok) throw new Error(credit.code);
  pair.guest.handleRecord(credit.bytes);
  expect(credits.length).toBe(1);
  expect(credits[0].targetStream).toBe(1);
  expect(business.length).toBe(0);
});

test("relay.reset PUSH drops the stream binding and fires onReset", async () => {
  const resets: Record<string, unknown>[] = [];
  const pair = makePair({ pingIntervalMs: 10 ** 9, onReset: (m) => resets.push(m) });
  await handshake(pair);
  await pair.guest.open({
    app: "pocket-map", namespace: "map/demo", profile: { name: "map.raster", version: 1 },
  });
  await pair.flush();
  const sid = pair.guest.sessionId;
  // provider stream0: ready-ack seq1, open-response seq2 -> reset seq3.
  const reset = encodeFrame({
    type: RELAY_TYPE.PUSH, codec: 0, session: sid, seq: 3, stream: 0, correlation: 0,
    metadata: { op: RELAY_OP.RESET, targetStream: 1, reason: "profile-reload" },
  }, { maxWireBytes: 4096, codecs: [0] });
  if (!reset.ok) throw new Error(reset.code);
  pair.guest.handleRecord(reset.bytes);
  expect(resets.length).toBe(1);
  // A business frame on the reset stream is now refused locally.
  expectRefused(pair.guest.sendBusiness({
    type: 3, stream: 1, metadata: { op: "x", subscription: 1 },
  }), "BAD_STREAM");
});

test("an unknown op arriving on stream 0 after READY ends the session", async () => {
  const pair = makePair({ pingIntervalMs: 10 ** 9 });
  await handshake(pair);
  const sid = pair.guest.sessionId;
  const rogue = encodeFrame({
    type: RELAY_TYPE.PUSH, codec: 0, session: sid, seq: 2, stream: 0, correlation: 0,
    metadata: { op: "vendor.frobnicate" },
  }, { maxWireBytes: 4096, codecs: [0] });
  if (!rogue.ok) throw new Error(rogue.code);
  pair.guest.handleRecord(rogue.bytes);
  expect(pair.guest.phase).toBe("closed");
});

test("business frames before READY are not admitted (send) and not delivered (recv)", async () => {
  const pair = makePair();
  // Before HELLO.
  expectRefused(pair.guest.sendBusiness({ type: 3, stream: 1, metadata: { op: "x" } }), "NOT_READY");
  pair.guest.hello();
  await pair.flush();
  expect(pair.guest.phase).toBe("ready");

  // A session-zero business frame that raced the handshake is a stale
  // session (nonzero session required) and never reaches the hook.
  const delivered: number[] = [];
  const pair2 = makePair({ onBusiness: () => delivered.push(1) });
  pair2.guest.hello();
  await pair2.flush();
  const forged = encodeFrame({
    type: RELAY_TYPE.PUSH, codec: 0, session: 0xabcdefn, seq: 1, stream: 1, correlation: 0,
    metadata: { op: "race.frame", subscription: 1 },
  }, { maxWireBytes: 4096, codecs: [0] });
  if (!forged.ok) throw new Error(forged.code);
  pair2.provider.handleRecord(forged.bytes); // no session pinned yet
  expect(pair2.provider.getStats().droppedStaleSession).toBe(1);
  expect(delivered.length).toBe(0);
});

// =============================================================================
// 8. Strict metadata validation
// =============================================================================

test("metadata-schema: the control schemas reject unknown props, bad types, over-byte strings and bad hex", () => {
  const hello = RELAY_METADATA_SCHEMAS[`${RELAY_OP.HELLO}.request`] as Record<string, unknown>;
  const base = {
    op: "relay.hello", versions: [[1, 0]],
    bootNonce: "00112233445566778899aabbccddeeff", app: "pocket-map",
    profiles: [{ name: "map.raster", version: 1 }],
    codecs: [0], kinds: [1], rxLimits: {
      maxWireBytes: 4096, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 32768,
      maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 2, maxScratchBytes: 262144,
    },
  };
  expect(validateRelaySchema(hello, base)).toBeNull();
  expect(validateRelaySchema(hello, { ...base, extra: 1 })).toContain("unknown");
  expect(validateRelaySchema(hello, { ...base, versions: [[1]] })).not.toBeNull();
  expect(validateRelaySchema(hello, { ...base, bootNonce: "ABCDEF" })).not.toBeNull();
  expect(validateRelaySchema(hello, { ...base, codecs: [70000] })).not.toBeNull();
  // 65 ASCII bytes exceeds the 64-byte app bound; a multibyte string is
  // counted in UTF-8 bytes, not JS chars.
  expect(validateRelaySchema(hello, { ...base, app: "a".repeat(65) })).not.toBeNull();
  expect(validateRelaySchema(hello, {
    ...base, app: "协".repeat(22), // 66 UTF-8 bytes in 22 chars
  })).not.toBeNull();

  const limits = base.rxLimits;
  expect(validateRelaySchema(hello, { ...base, rxLimits: { ...limits, maxWireBytes: -1 } })).not.toBeNull();
  expect(validateRelaySchema(hello, { ...base, rxLimits: { ...limits, windowBytes: 9999999999 } })).not.toBeNull();
});

test("metadata-schema: unknown keys named after Object.prototype members do not bypass strictness", () => {
  const ping = RELAY_METADATA_SCHEMAS[`${RELAY_OP.PING}.request`] as Record<string, unknown>;
  // A plain-object schema's prototype chain exposes these names; the
  // unknown-property check must look at own properties only (Review 937 B-1).
  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty",
      "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"]) {
    const smuggled: Record<string, unknown> = { op: RELAY_OP.PING, token: 1 };
    smuggled[key] = "x";
    expect(validateRelaySchema(ping, smuggled)).toContain("unknown");
  }
  // Control: the rule fires for an ordinary unknown key too.
  expect(validateRelaySchema(ping, { op: RELAY_OP.PING, token: 1, plain: 1 })).toContain("unknown");
});

test("malformed inbound control metadata fails the strict schema and ends the session", async () => {
  const pair = makePair({ pingIntervalMs: 10 ** 9 });
  await handshake(pair);
  const sid = pair.guest.sessionId;
  // Provider stream 0 has sent only the READY ack (seq 1); a PING with a
  // token above u32 violates ping.request and must not be answered.
  const badPing = encodeFrame({
    type: RELAY_TYPE.REQUEST, codec: 0, session: sid, seq: 2, stream: 0, correlation: 5,
    metadata: { op: RELAY_OP.PING, token: 0x1_0000_0000 },
  }, { maxWireBytes: 4096, codecs: [0] });
  if (!badPing.ok) throw new Error(badPing.code);
  pair.guest.handleRecord(badPing.bytes);
  expect(pair.guest.phase).toBe("closed");
  expect(pair.guest.getStats().pingsReceived).toBe(0);
});

test("a duplicate stream-0 seq ends the session", async () => {
  const pair = makePair({ pingIntervalMs: 10 ** 9 });
  await handshake(pair);
  const sid = pair.guest.sessionId;
  // Replay the provider's READY ack (session sid, stream 0, seq 1).
  const readyAck = pair.wire.filter((f) => f.from === "provider")
    .map((f) => decode(f)).find((f) => f.metadata.op === RELAY_OP.READY)!;
  const replay = encodeFrame({
    type: readyAck.type, codec: readyAck.codec, session: sid,
    seq: readyAck.seq, stream: 0, correlation: readyAck.correlation,
    metadata: readyAck.metadata as Record<string, unknown>,
  }, { maxWireBytes: 4096, codecs: [0] });
  if (!replay.ok) throw new Error(replay.code);
  pair.guest.handleRecord(replay.bytes);
  expect(pair.guest.phase).toBe("closed");
});

// =============================================================================
// 9. Mutation (one): a single-byte wire mutation of the bootstrap HELLO must
//    never establish a session
// =============================================================================

// =============================================================================
// 10. Review 937 adversarial cases
// =============================================================================

/** Encode a frame straight from an own-property metadata object, bypassing
 *  the sending machine so a hostile peer can smuggle any key the parser or
 *  strict validator might mishandle. */
function rawFrame(input: {
  type: number; session: bigint; seq: number; stream: number; correlation: number;
  metadata: Record<string, unknown>;
}, codecs: number[] = [0]) {
  const encoded = encodeFrame({ codec: 0, ...input }, { maxWireBytes: 4096, codecs });
  if (!encoded.ok) throw new Error(encoded.code);
  return encoded.bytes;
}

test("B-1 wire: a READY-session PING carrying `constructor` is refused, never answered", async () => {
  const pair = makePair({ sync: true, pingIntervalMs: 10 ** 9 });
  pair.guest.hello();
  expect(pair.provider.phase).toBe("ready");
  const sid = pair.provider.sessionId;
  // Provider has accepted only the READY (new session, stream 0, seq 1);
  // the hostile frame is stream 0 seq 2.
  const before = pair.wire.length;
  const smuggled: Record<string, unknown> = { op: RELAY_OP.PING, token: 5 };
  Object.defineProperty(smuggled, "constructor", { value: "smuggled", enumerable: true });
  pair.provider.handleRecord(rawFrame({
    type: RELAY_TYPE.REQUEST, session: sid, seq: 2, stream: 0, correlation: 9,
    metadata: smuggled,
  }));
  // Strict validation fails the frame: the session tears down and the peer
  // never spends a frame answering the smuggled PING.
  expect(pair.provider.phase).toBe("closed");
  expect(pair.wire.slice(before).some((f) => f.from === "provider")).toBe(false);
  expect(pair.provider.getStats().pingsReceived).toBe(0);
});

test("D-1 relay.reset targeting stream 0 is refused without wiping the control seq space", async () => {
  const pair = makePair({ sync: true, pingIntervalMs: 10 ** 9 });
  pair.guest.hello();
  expect(pair.guest.phase).toBe("ready");
  const sid = pair.guest.sessionId;
  // Guest's new-session stream-0 rx seq stands at 1 (READY ack); the forged
  // reset is seq 2 and a legitimate credit follows at seq 3.
  pair.guest.handleRecord(rawFrame({
    type: RELAY_TYPE.PUSH, session: sid, seq: 2, stream: 0, correlation: 0,
    metadata: { op: RELAY_OP.RESET, targetStream: 0, reason: "hostile" },
  }));
  pair.guest.handleRecord(rawFrame({
    type: RELAY_TYPE.PUSH, session: sid, seq: 3, stream: 0, correlation: 0,
    metadata: {
      op: RELAY_OP.CREDIT, targetStream: 1,
      framesReleased: "0000000000000001", bytesReleased: "0000000000000040",
    },
  }));
  // §3.6 scopes relay.reset to a business stream; stream 0 is reserved. The
  // reset action is refused, the session survives and seq stays contiguous.
  expect(pair.guest.phase).toBe("ready");
  expect(pair.guest.getStats().droppedStaleSeq).toBe(0);
});

test("D-2 a frame on an un-opened stream does not poison its rx seq after OPEN allocates it", async () => {
  let delivered = 0;
  const pair = makePair({ sync: true, pingIntervalMs: 10 ** 9, onBusiness: () => { delivered++; } });
  pair.guest.hello();
  expect(pair.guest.phase).toBe("ready");
  const sid = pair.guest.sessionId;
  // Early/hostile PUSH on stream 1 before OPEN allocates it.
  pair.guest.handleRecord(rawFrame({
    type: RELAY_TYPE.PUSH, session: sid, seq: 1, stream: 1, correlation: 0,
    metadata: { op: "map.tile" },
  }));
  // OPEN now allocates stream 1 for real; the binding starts from a clean
  // per-stream seq space.
  const opened = await pair.guest.open({
    app: "pocket-map", namespace: "tiles",
    profile: { name: "map.raster", version: 1 },
  });
  expect(opened.stream).toBe(1);
  // Provider's first business frame on the new stream is seq 1 (§3.2 step 5).
  pair.guest.handleRecord(rawFrame({
    type: RELAY_TYPE.PUSH, session: sid, seq: 1, stream: 1, correlation: 0,
    metadata: { op: "map.tile" },
  }));
  expect({ delivered, staleSeq: pair.guest.getStats().droppedStaleSeq })
    .toEqual({ delivered: 1, staleSeq: 0 });
});

test("D-3 decode: a `__proto__` metadata key stays an own property and cannot inject fields", () => {
  const metadata: Record<string, unknown> = { op: RELAY_OP.PING };
  Object.defineProperty(metadata, "__proto__", {
    value: { polluted: true }, enumerable: true, configurable: true,
  });
  const encoded = encodeFrame({
    type: RELAY_TYPE.PUSH, codec: 0, session: 0n, seq: 1, stream: 0, correlation: 0,
    metadata,
  }, { maxWireBytes: 4096, codecs: [0] });
  if (!encoded.ok) throw new Error(encoded.code);
  const decoded = decodeFrame(encoded.bytes, { maxWireBytes: 4096 });
  if (!decoded.ok) throw new Error(decoded.code);
  const own = Object.prototype.hasOwnProperty.call(decoded.frame.metadata, "__proto__");
  const polluted = (decoded.frame.metadata as Record<string, unknown>).polluted === true;
  expect({ own, polluted }).toEqual({ own: true, polluted: false });
});

test("D-3 wire: a PING carrying `__proto__` is rejected as an unknown key, not absorbed", async () => {
  const pair = makePair({ sync: true, pingIntervalMs: 10 ** 9 });
  pair.guest.hello();
  expect(pair.provider.phase).toBe("ready");
  const sid = pair.provider.sessionId;
  const before = pair.wire.length;
  const metadata: Record<string, unknown> = { op: RELAY_OP.PING, token: 5 };
  Object.defineProperty(metadata, "__proto__", {
    value: { polluted: true }, enumerable: true, configurable: true,
  });
  pair.provider.handleRecord(rawFrame({
    type: RELAY_TYPE.REQUEST, session: sid, seq: 2, stream: 0, correlation: 9,
    metadata,
  }));
  expect(pair.provider.phase).toBe("closed");
  expect(pair.wire.slice(before).some((f) => f.from === "provider")).toBe(false);
});

test("mutation: flipping one magic byte of the HELLO record rejects at the frame layer", () => {
  const pair = makePair();
  pair.guest.hello();
  const record = pair.wire[0].bytes.slice();
  expect(record[4]).toBe(0x50); // 'P' of PRLY
  record[4] = 0x58; // 'X'
  pair.provider.handleRecord(record);
  expect(pair.provider.phase).toBe("closed");
  expect(pair.provider.getStats().droppedDecodeError).toBe(1);
  expect(pair.provider.getStats().handshakeFailures).toBe(0); // rejected below session layer
});

// =============================================================================
// 11. Review 937 test teeth: BUSY rollback, bootNonce echo, pong token
// =============================================================================

test("T-1 a BUSY ping does not burn a stream-0 seq (the retry is the next seq)", async () => {
  let busy = false;
  const pair = makePair({
    sync: true,
    sendPolicy: { guest: () => (busy ? "busy" : "accepted") },
  });
  await handshake(pair);
  const seqAfterReady = decode(lastFrames(pair, "guest", 1)[0]).seq;
  busy = true;
  pair.clocks.guest.advance(2000); // ping attempt -> BUSY, seq rolled back
  busy = false;
  pair.clocks.guest.advance(1500); // retry timer -> the ping is admitted
  const ping = decode(lastFrames(pair, "guest", 1)[0]);
  expect(ping.metadata.op).toBe(RELAY_OP.PING);
  expect(ping.seq).toBe(seqAfterReady + 1);
});

test("T-2 a HELLO response echoing the wrong bootNonce tears the guest down", async () => {
  // Donor pair supplies a well-formed provider HELLO response.
  const donor = makePair({ sync: false });
  await handshake(donor);
  const real = decode(donor.wire.find((f) => f.from === "provider"
    && decode(f).metadata.op === RELAY_OP.HELLO)!);

  // A fresh guest parked in hello-sent, never given the real response.
  const solo = makePair({ sync: false });
  solo.guest.hello();
  expect(solo.guest.phase).toBe("hello-sent");

  const forged = encodeFrame({
    type: RELAY_TYPE.RESPONSE, codec: 0, session: 0n, seq: 1, stream: 0, correlation: 1,
    metadata: { ...real.metadata, bootNonce: "f".repeat(32) },
  }, { maxWireBytes: 4096, codecs: [0] });
  if (!forged.ok) throw new Error(forged.code);
  solo.guest.handleRecord(forged.bytes);
  expect(solo.guest.phase).toBe("closed");
});

test("T-3 a pong carrying a token we never sent does not satisfy the outstanding ping", async () => {
  // Delivery is withheld after READY so the ping leaves and stays
  // outstanding without any help from the send ordering: the provider
  // never sees it. A forged pong with a wrong token must not clear the
  // slot; the matching token must.
  const pair = makePair({ pingIntervalMs: 2000, retryMs: 1500 });
  await handshake(pair);
  pair.deliver = false;
  pair.clocks.guest.advance(2000); // guest ping goes out; nobody answers
  const ping = decode(lastFrames(pair, "guest", 1)[0]);
  expect(ping.metadata.op).toBe(RELAY_OP.PING);
  expect(pair.guest.getStats().pingsSent).toBe(1);

  // Provider stream 0 has sent only the READY ack (seq 1); forged pongs
  // continue its seq space so they pass the inbound-seq check.
  const pong = (seq: number, token: number) => {
    const r = encodeFrame({
      type: RELAY_TYPE.RESPONSE, codec: 0, session: pair.guest.sessionId,
      seq, stream: 0, correlation: ping.correlation,
      metadata: { op: RELAY_OP.PING, status: RELAY_STATUS.OK, final: true, token },
    }, { maxWireBytes: 4096, codecs: [0] });
    if (!r.ok) throw new Error(r.code);
    return r.bytes;
  };
  const token = ping.metadata.token as number;
  pair.guest.handleRecord(pong(2, (token ^ 0x5a5a) >>> 0));
  expect(pair.guest.phase).toBe("ready");
  expect(pair.guest.getStats().droppedStaleSeq).toBe(1);

  // Still outstanding: the next interval must not start a second ping.
  pair.clocks.guest.advance(2000);
  expect(pair.guest.getStats().pingsSent).toBe(1);

  // The matching token clears the slot, and the next interval pings again.
  pair.guest.handleRecord(pong(3, token));
  expect(pair.guest.getStats().droppedStaleSeq).toBe(1);
  pair.clocks.guest.advance(2000);
  expect(pair.guest.getStats().pingsSent).toBe(2);
});

test("B-5 a synchronous adapter answers the ping inside emit(); the pong is accepted and heartbeats continue", () => {
  // Review 988: the token was recorded after emit() returned, so the pong
  // a synchronous adapter delivered inside the send found no outstanding
  // token, was dropped as stale, blocked every later ping and the guest
  // hit the stall deadline. The token is now published before the send.
  const pair = makePair({ sync: true, pingIntervalMs: 2000, stallMs: 15000, retryMs: 1500 });
  pair.guest.hello();
  expect(pair.guest.phase).toBe("ready");
  pair.clocks.guest.advance(2000);
  expect(pair.provider.getStats().pingsReceived).toBe(1);
  expect(pair.guest.getStats().pingsSent).toBe(1);
  expect(pair.guest.getStats().droppedStaleSeq).toBe(0);

  // Past the stall deadline the guest is alive and has pinged every
  // interval: 8 pings over 17 s, each answered inside its own send.
  pair.clocks.guest.advance(15001);
  expect({
    phase: pair.guest.phase,
    sent: pair.guest.getStats().pingsSent,
    received: pair.provider.getStats().pingsReceived,
    stale: pair.guest.getStats().droppedStaleSeq,
    timeouts: pair.guest.getStats().pingTimeouts,
  }).toEqual({ phase: "ready", sent: 8, received: 8, stale: 0, timeouts: 0 });
});
