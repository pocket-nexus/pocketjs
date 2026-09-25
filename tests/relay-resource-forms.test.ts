// O3: product parameter landing. Locally registered resource forms constrain
// resource.get/subscribe args and resource success values; the public
// metadata and ResourceRef stay closed, and rendition keeps its presentation
// meaning.

import { expect, test } from "bun:test";
import {
  RELAY_CODEC, RELAY_DELIVERY, RELAY_ERROR, RELAY_KIND, RELAY_OP, RELAY_STATUS, RELAY_TYPE,
  type RelayProfileEntry, type RelayResourceRef, type RelayRxLimits,
} from "../contracts/spec/relay.ts";
import {
  RelayEndpoint, type RelayEndpointHooks, type RelayIncomingRequest, type RelayResourceForm,
} from "../framework/src/relay/endpoint.ts";
import { decodeFrame, encodeFrame, type RelayDecodedFrame } from "../framework/src/relay/frame.ts";
import { sha256Hex } from "../framework/src/relay/sha256.ts";
import { stringToUtf8 } from "../framework/src/bytes.ts";
import type { RelayLocalCapabilities, RelayScheduler } from "../framework/src/relay/session.ts";
import type { ResourceResult } from "../framework/src/resource-cache.ts";

const PROFILE: RelayProfileEntry = { name: "term.grid", version: 1 };
const OTHER: RelayProfileEntry = { name: "org.example.other", version: 1 };
const RX: RelayRxLimits = {
  maxWireBytes: 4096, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 32768,
  maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 2, maxScratchBytes: 262144,
};

const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object", additionalProperties: false, properties, required }) as const;

const pageArgs = closed({ page: { type: "integer", minimum: 0, maximum: 65535 } });
const pageValue = closed({ lines: { type: "array", items: { type: "string" } }, cursor: { type: "integer", minimum: 0 } });
const lineArgs = closed({ fromLine: { type: "integer", minimum: 0 } });
const pushValue = closed({ line: { type: "integer", minimum: 0 }, text: { type: "string" } });

const form = (patch: Partial<RelayResourceForm> = {}): RelayResourceForm => ({
  profile: PROFILE, kind: RELAY_KIND.TERMINAL_CELLS, argsKey: "term",
  args: pageArgs, value: pageValue, valuePresence: "required", onSubscribe: true, ...patch,
});
const eventForm = (valuePresence: "required" | "optional" = "required"): RelayResourceForm => ({
  profile: PROFILE, kind: RELAY_KIND.EVENT, argsKey: "term-event", args: lineArgs,
  value: pushValue, valuePresence, onSubscribe: true,
});
const formsWithPresence = (valuePresence: "required" | "optional"): readonly RelayResourceForm[] => [
  form({ valuePresence }), eventForm(valuePresence),
];

const ref = (revision = "s-42"): RelayResourceRef => ({
  kind: RELAY_KIND.TERMINAL_CELLS, ns: "term/session-1", key: "scrollback", revision,
  // A presentation token: density/style binding, not a parameter carrier.
  rendition: "grid-density1-v1",
});
const pageValue0 = { lines: ["$ ls", "docs package.json"], cursor: 2 };

type Role = "guest" | "provider";
type Captured = { from: Role; bytes: Uint8Array };

const scheduler = (): RelayScheduler => {
  let id = 0;
  return { now: () => 0, setTimeout: () => ++id, clearTimeout: () => {} };
};
const capabilities = (patch: Partial<RelayLocalCapabilities> = {}): RelayLocalCapabilities => ({
  app: "example", versions: [[1, 0]], profiles: [PROFILE, OTHER],
  codecs: [RELAY_CODEC.NONE, RELAY_CODEC.JSON], kinds: [6, 7, 8], rxLimits: RX, ...patch,
});

function pair(options: {
  guestForms?: readonly RelayResourceForm[];
  providerForms?: readonly RelayResourceForm[];
  guestHooks?: RelayEndpointHooks;
  providerHooks?: RelayEndpointHooks;
  transform?: (from: Role, frame: RelayDecodedFrame) => RelayDecodedFrame;
} = {}) {
  const wire: Captured[] = [];
  const endpoints = {} as Record<Role, RelayEndpoint>;
  const route = (from: Role, bytes: Uint8Array) => {
    let copy: Uint8Array = bytes.slice();
    if (options.transform) {
      const decoded = decodeFrame(copy);
      if (!decoded.ok) throw new Error(decoded.code);
      const encoded = encodeFrame(options.transform(from, decoded.frame));
      if (!encoded.ok) throw new Error(encoded.code);
      copy = encoded.bytes;
    }
    wire.push({ from, bytes: copy });
    endpoints[from === "guest" ? "provider" : "guest"].handleRecord(copy);
    return "accepted" as const;
  };
  for (const role of ["guest", "provider"] as const) {
    let seed = role === "guest" ? 17 : 23;
    endpoints[role] = new RelayEndpoint({ role,
      local: capabilities(),
      resourceForms: (role === "guest" ? options.guestForms : options.providerForms) ?? [form(), eventForm()],
      transport: { peer: { id: `peer-${role}`, grants: ["example"] }, trySend: bytes => route(role, bytes) },
      hooks: role === "guest" ? options.guestHooks : options.providerHooks,
      scheduler: scheduler(), randomBytes: n => new Uint8Array(n).fill(seed++) as Uint8Array<ArrayBuffer>,
    });
  }
  const settle = async () => {
    for (let i = 0; i < 32; i++) { await Promise.resolve(); endpoints.guest.flush(); endpoints.provider.flush(); }
  };
  const frames = (from?: Role) => wire.filter(r => !from || r.from === from).map((r) => {
    const decoded = decodeFrame(r.bytes);
    if (!decoded.ok) throw new Error(decoded.code);
    return { from: r.from, ...decoded.frame };
  });
  return { ...endpoints, wire, settle, frames };
}
type Pair = ReturnType<typeof pair>;

async function connect(link: Pair, profile: RelayProfileEntry = PROFILE, namespace = "term/session-1") {
  expect(link.guest.hello()).toEqual({ ok: true });
  await link.settle();
  await link.guest.whenReady();
  const opened = link.guest.open({ app: "example", namespace, profile });
  await link.settle();
  return (await opened).stream;
}

const getOnce = (link: Pair, stream: number, target: RelayResourceRef, args: Record<string, unknown>) =>
  new Promise<ResourceResult<unknown>>((resolve) => {
    const started = link.guest.get(stream, target, args as never, resolve);
    if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
  });

const servePage = (requests?: RelayIncomingRequest[]) => ({
  onGet(request: RelayIncomingRequest) {
    requests?.push(request);
    currentProvider!.replyObject(request, { ref: ref((request.metadata.resource as RelayResourceRef | undefined)?.revision),
      codec: RELAY_CODEC.NONE, data: new Uint8Array(0), value: pageValue0 });
  },
});
let currentProvider: RelayEndpoint | undefined;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("form registration binds to an installed profile and a defined kind", () => {
  const uninstalled = { name: "org.example.uninstalled", version: 1 };
  expect(() => new RelayEndpoint({ role: "guest", transport: { peer: { id: "x", grants: [] }, trySend: () => "accepted" },
    local: capabilities(), resourceForms: [form({ profile: uninstalled })] })).toThrow("installed profile");
  expect(() => new RelayEndpoint({ role: "guest", transport: { peer: { id: "x", grants: [] }, trySend: () => "accepted" },
    local: capabilities(), resourceForms: [form({ kind: 9 })] })).toThrow("defined RELAY_KIND");
  expect(() => new RelayEndpoint({ role: "guest", transport: { peer: { id: "x", grants: [] }, trySend: () => "accepted" },
    local: capabilities(), resourceForms: [form({ onSubscribe: false }), form({ onSubscribe: false })] })).toThrow("duplicate resource form");
});

test("form registration: argsKey is a product token distinct from public keys", () => {
  for (const argsKey of ["accept", "maxObjectBytes", "ifRevision", "delivery", "namespace", "Term", "x.y", ""]) {
    expect(() => new RelayEndpoint({ role: "guest", transport: { peer: { id: "x", grants: [] }, trySend: () => "accepted" },
      local: capabilities(), resourceForms: [form({ argsKey })] })).toThrow("argsKey");
  }
  // Two profiles cannot claim one key name on one endpoint.
  const clash: RelayResourceForm = { ...form(), profile: OTHER, kind: RELAY_KIND.FILE };
  expect(() => new RelayEndpoint({ role: "guest", transport: { peer: { id: "x", grants: [] }, trySend: () => "accepted" },
    local: capabilities(), resourceForms: [form(), clash] })).toThrow("claimed by two profiles");
});

test("form registration: schemas use the closed local dialect", () => {
  const open = { type: "object", properties: { page: { type: "integer" } } };
  expect(() => new RelayEndpoint({ role: "guest", transport: { peer: { id: "x", grants: [] }, trySend: () => "accepted" },
    local: capabilities(), resourceForms: [form({ args: open })] })).toThrow("closed properties");
  expect(() => new RelayEndpoint({ role: "guest", transport: { peer: { id: "x", grants: [] }, trySend: () => "accepted" },
    local: capabilities(), resourceForms: [form({ args: { type: "object", additionalProperties: false,
      properties: { page: { type: "integer", bogusKeyword: 1 } } } })] })).toThrow("unsupported schema keyword");
  expect(() => new RelayEndpoint({ role: "guest", transport: { peer: { id: "x", grants: [] }, trySend: () => "accepted" },
    local: capabilities(), resourceForms: [form({ value: { type: "string" } })] })).toThrow("value schema must be an object");
  expect(() => new RelayEndpoint({ role: "guest", transport: { peer: { id: "x", grants: [] }, trySend: () => "accepted" },
    local: capabilities(), resourceForms: [form({ valuePresence: undefined })] })).toThrow("valuePresence");
  expect(() => new RelayEndpoint({ role: "guest", transport: { peer: { id: "x", grants: [] }, trySend: () => "accepted" },
    local: capabilities(), resourceForms: [form({ value: undefined, valuePresence: "optional" })] })).toThrow("requires value");
  expect(() => new RelayEndpoint({ role: "guest", transport: { peer: { id: "x", grants: [] }, trySend: () => "accepted" },
    local: capabilities(), resourceForms: [form({ valuePresence: "sometimes" as "required" })] })).toThrow("valuePresence");
  expect(() => new RelayEndpoint({ role: "guest", transport: { peer: { id: "x", grants: [] }, trySend: () => "accepted" },
    local: capabilities(), resourceForms: [form({ unknownField: 1 } as unknown as RelayResourceForm)] })).toThrow("unknown resource form field");
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test("product args round-trip at the registered key; rendition stays a presentation token", async () => {
  const requests: RelayIncomingRequest[] = [];
  const link = pair({ providerHooks: servePage(requests) });
  currentProvider = link.provider;
  const stream = await connect(link);

  const result = await getOnce(link, stream, ref(), {
    accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096, product: { key: "term", value: { page: 7 } },
  });
  await link.settle();
  expect(result.ok).toBe(true);
  if (!result.ok || !("value" in result)) throw new Error("get failed");
  expect((result.value as { value: unknown }).value).toEqual(pageValue0);

  // Provider saw the public args plus the one namespaced object — not a
  // rendition-encoded parameter and not a top-level field.
  const seen = requests[0]!.metadata.args as Record<string, unknown>;
  expect(seen).toEqual({ accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096, term: { page: 7 } });
  const seenRef = requests[0]!.metadata.resource as RelayResourceRef;
  expect(seenRef.rendition).toBe("grid-density1-v1");
  expect(seenRef).not.toHaveProperty("term");

  // The wire request carries args.term and an untouched rendition.
  const requestFrame = link.frames("guest").find(f => f.metadata.op === RELAY_OP.RESOURCE_GET && f.stream === stream)!;
  expect((requestFrame.metadata.args as Record<string, unknown>).term).toEqual({ page: 7 });
  expect((requestFrame.metadata.resource as RelayResourceRef).rendition).toBe("grid-density1-v1");
});

test("product subscribe args round-trip for both ref and namespace targets", async () => {
  const link = pair();
  currentProvider = link.provider;
  const stream = await connect(link);

  const nsResult = await new Promise<ResourceResult<{ subscription?: number }>>((resolve) => {
    const started = link.guest.subscribe(stream, { ns: "term/session-1" }, RELAY_DELIVERY.LATEST_SNAPSHOT,
      { onObject: () => {}, onEnd: () => {} }, resolve,
      { product: { key: "term-event", value: { fromLine: 12 } } });
    if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
  });
  await link.settle();
  expect(nsResult.ok).toBe(true);
  const subscribeFrame = link.frames("guest").find(f => f.metadata.op === RELAY_OP.RESOURCE_SUBSCRIBE)!;
  expect(subscribeFrame.metadata.args).toMatchObject({ delivery: RELAY_DELIVERY.LATEST_SNAPSHOT,
    namespace: "term/session-1", "term-event": { fromLine: 12 } });

  const refResult = await new Promise<ResourceResult<{ subscription?: number }>>((resolve) => {
    const started = link.guest.subscribe(stream, ref(), RELAY_DELIVERY.LATEST_SNAPSHOT,
      { onObject: () => {}, onEnd: () => {} }, resolve,
      { product: { key: "term", value: { page: 3 } } });
    if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
  });
  await link.settle();
  // The TERMINAL_CELLS form accepts term on subscribe (onSubscribe: true);
  // the page object validates against its args schema.
  expect(refResult.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Local (send-side) rejection
// ---------------------------------------------------------------------------

test("guest rejects unknown product keys and type mismatches before any frame", async () => {
  const link = pair({ providerHooks: servePage() });
  currentProvider = link.provider;
  const stream = await connect(link);
  const wireCount = link.wire.length;

  const unknown = await getOnce(link, stream, ref(), {
    accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096, product: { key: "vault", value: {} },
  });
  expect(unknown).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });

  const badType = await getOnce(link, stream, ref(), {
    accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096, product: { key: "term", value: { page: "7" } },
  });
  expect(badType).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });

  const outOfRange = await getOnce(link, stream, ref(), {
    accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096, product: { key: "term", value: { page: -1 } },
  });
  expect(outOfRange).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });

  const unknownNested = await getOnce(link, stream, ref(), {
    accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096, product: { key: "term", value: { page: 1, zoom: 2 } },
  });
  expect(unknownNested).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });

  // Nothing left the endpoint: every refusal is local.
  expect(link.wire.length).toBe(wireCount);
});

test("a form on another profile does not admit the key on this stream", async () => {
  const link = pair({ providerHooks: servePage() });
  currentProvider = link.provider;
  const stream = await connect(link, OTHER);
  const refused = await getOnce(link, stream, ref(), {
    accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096, product: { key: "term", value: { page: 1 } },
  });
  expect(refused).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });
});

// ---------------------------------------------------------------------------
// Peer (receive-side) rejection
// ---------------------------------------------------------------------------

test("provider answers INVALID for a product key without a form, a wrong type and an unknown key", async () => {
  const inject = (extra: Record<string, unknown>) => (from: Role, frame: RelayDecodedFrame) => {
    if (from !== "guest" || frame.metadata.op !== RELAY_OP.RESOURCE_GET) return frame;
    return { ...frame, metadata: { ...frame.metadata,
      args: { ...(frame.metadata.args as Record<string, unknown>), ...extra } } };
  };
  // `term:{page:1}` with no provider form, a type mismatch under the form,
  // and an arbitrary unknown key — none may reach onGet.
  for (const [extra, providerForms] of [
    [{ term: { page: 1 } }, [] as RelayResourceForm[]],
    [{ term: { page: "1" } }, [form()]],
    [{ bogus: 1 }, [form()]],
  ] as const) {
    const link = pair({
      providerForms,
      transform: inject(extra),
      providerHooks: { onGet: () => { throw new Error("onGet must not run on invalid args"); } },
    });
    currentProvider = link.provider;
    const stream = await connect(link);
    const result = await getOnce(link, stream, ref(), { accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096 });
    await link.settle();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect((result.error as { code: string }).code).toBe(RELAY_ERROR.INVALID);
  }
});

test("provider rejects a registered-shaped key sent on a different profile's stream", async () => {
  const link = pair({
    providerHooks: { onGet: () => { throw new Error("onGet must not run"); } },
    transform: (from, frame) => {
      if (from !== "guest" || frame.metadata.op !== RELAY_OP.RESOURCE_GET) return frame;
      return { ...frame, metadata: { ...frame.metadata,
        args: { ...(frame.metadata.args as Record<string, unknown>), term: { page: 1 } } } };
    },
  });
  currentProvider = link.provider;
  const stream = await connect(link, OTHER);
  const result = await getOnce(link, stream, ref(), { accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096 });
  await link.settle();
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect((result.error as { code: string }).code).toBe(RELAY_ERROR.INVALID);
});

test("public ResourceRef and args still reject arbitrary properties on the peer path", async () => {
  const cases: Array<(frame: RelayDecodedFrame) => RelayDecodedFrame> = [
    frame => ({ ...frame, metadata: { ...frame.metadata,
      resource: { ...(frame.metadata.resource as Record<string, unknown>), term: { page: 1 } } } }),
    frame => ({ ...frame, metadata: { ...frame.metadata,
      args: { ...(frame.metadata.args as Record<string, unknown>), sneaky: true } } }),
  ];
  for (const mutate of cases) {
    const link = pair({
      transform: (from, frame) => from === "guest" && frame.metadata.op === RELAY_OP.RESOURCE_GET ? mutate(frame) : frame,
      providerHooks: { onGet: () => { throw new Error("onGet must not run"); } },
    });
    currentProvider = link.provider;
    const stream = await connect(link);
    const result = await getOnce(link, stream, ref(), { accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096 });
    await link.settle();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect((result.error as { code: string }).code).toBe(RELAY_ERROR.INVALID);
  }
});

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

test("required form rejects notModified-shaped codec-1 GET content", async () => {
  const marker = stringToUtf8(JSON.stringify({ notModified: true }));
  let provider: RelayEndpoint | undefined;
  let produced: unknown;
  const link = pair({
    providerHooks: {
      onGet(request) {
        produced = provider!.replyObject(request, {
          ref: ref(), codec: RELAY_CODEC.JSON, data: marker,
        });
      },
    },
  });
  provider = link.provider;
  const result = await getOnce(link, await connect(link), ref(), {
    accept: [RELAY_CODEC.JSON], maxObjectBytes: 4096,
  });
  await link.settle();

  expect(produced).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(result).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID,
    message: "missing lines" } });
  expect(link.frames("provider").filter(frame => frame.type === RELAY_TYPE.RESPONSE
    && frame.metadata.op === RELAY_OP.RESOURCE_GET
    && frame.metadata.status === RELAY_STATUS.OK)).toEqual([]);

  let peer: RelayEndpoint | undefined;
  let injected: unknown;
  const inbound = pair({
    guestForms: formsWithPresence("required"), providerForms: [],
    providerHooks: {
      onGet(request) {
        injected = peer!.replyObject(request, {
          ref: ref(), codec: RELAY_CODEC.JSON, data: marker,
        });
      },
    },
  });
  peer = inbound.provider;
  const inboundResult = await getOnce(inbound, await connect(inbound), ref(), {
    accept: [RELAY_CODEC.JSON], maxObjectBytes: 4096,
  });
  await inbound.settle();
  expect(injected).toEqual({ ok: true, frames: 1 });
  expect(inboundResult).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });
  expect(inbound.guest.client!.stats()).toMatchObject({ pending: 0, protocolErrors: 1 });
});

for (const [label, codec, data, value] of [
  ["codec-0 metadata", RELAY_CODEC.NONE, new Uint8Array(0), { notModified: true }],
  ["codec-1 JSON data", RELAY_CODEC.JSON, stringToUtf8(JSON.stringify({ notModified: true })), undefined],
] as const) {
  test("required form rejects notModified-shaped push " + label, async () => {
    const objects: unknown[] = [];
    const ends: string[] = [];
    const link = pair();
    currentProvider = link.provider;
    const stream = await connect(link);
    const complete = await new Promise<ResourceResult<{ subscription?: number }>>((resolve) => {
      link.guest.subscribe(stream, { ns: "term/session-1" }, RELAY_DELIVERY.LATEST_SNAPSHOT,
        { onObject: object => objects.push(object), onEnd: error => ends.push(error?.code ?? "") }, resolve);
    });
    await link.settle();
    const id = (complete as { ok: true; value: { subscription: number } }).value.subscription;
    const before = link.frames("provider").filter(frame => frame.type === RELAY_TYPE.PUSH).length;

    expect(link.provider.pushObject({
      stream, subscription: id, ref: ref("s-43"), codec, data, value,
    })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
    await link.settle();
    expect(objects).toEqual([]);
    expect(ends).toEqual([]);
    expect(link.frames("provider").filter(frame => frame.type === RELAY_TYPE.PUSH).length).toBe(before);

    const inboundObjects: unknown[] = [];
    const inboundEnds: string[] = [];
    const inbound = pair({ guestForms: formsWithPresence("required"), providerForms: [] });
    currentProvider = inbound.provider;
    const inboundStream = await connect(inbound);
    const inboundComplete = await new Promise<ResourceResult<{ subscription?: number }>>((resolve) => {
      inbound.guest.subscribe(inboundStream, { ns: "term/session-1" }, RELAY_DELIVERY.LATEST_SNAPSHOT,
        { onObject: object => inboundObjects.push(object),
          onEnd: error => inboundEnds.push(error?.code ?? "") }, resolve);
    });
    await inbound.settle();
    const inboundId = (inboundComplete as { ok: true; value: { subscription: number } }).value.subscription;
    expect(inbound.provider.pushObject({
      stream: inboundStream, subscription: inboundId, ref: ref("s-44"), codec, data, value,
    })).toEqual({ ok: true, frames: 1 });
    await inbound.settle();
    expect(inboundObjects).toEqual([]);
    expect(inboundEnds).toEqual([RELAY_ERROR.INVALID]);
  });
}

test("required form preserves a legal conditional GET notModified response", async () => {
  let provider: RelayEndpoint | undefined;
  let produced: unknown;
  const link = pair({
    providerHooks: {
      onGet(request) {
        produced = provider!.replyNotModified(request, ref());
      },
    },
  });
  provider = link.provider;
  const stream = await connect(link);
  const result = await new Promise<ResourceResult<unknown>>((resolve) => {
    const started = link.guest.get(stream, ref(), {
      accept: [RELAY_CODEC.JSON], maxObjectBytes: 4096, ifRevision: "s-42",
      product: { key: "term", value: { page: 1 } },
    }, resolve);
    if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
  });
  await link.settle();

  expect(produced).toEqual({ ok: true });
  expect(result).toEqual({ ok: true, value: { notModified: true, revision: "s-42" } });
});

test("provider rejects present codec-0 values outside required and optional schemas", async () => {
  for (const valuePresence of ["required", "optional"] as const) {
    const link = pair({ providerForms: formsWithPresence(valuePresence) });
    currentProvider = link.provider;
    const stream = await connect(link);
    const request = { stream, correlation: 9, op: RELAY_OP.RESOURCE_GET,
      metadata: { op: RELAY_OP.RESOURCE_GET, resource: ref(), args: { accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096 } } };
    const before = link.frames("provider").length;
    const refused = link.provider.replyObject(request as unknown as RelayIncomingRequest,
      { ref: ref(), codec: RELAY_CODEC.NONE, data: new Uint8Array(0), value: { lines: ["x"], cursor: -1 } });
    expect(refused).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
    // The one terminal is the INVALID error; no success object or chunk frame.
    await link.settle();
    const after = link.frames("provider").slice(before);
    expect(after.length).toBe(1);
    expect(after[0]!.metadata.status).toBe(RELAY_STATUS.ERROR);
    expect(after[0]!.data.length).toBe(0);
  }
});

test("guest rejects present codec-0 values outside required and optional schemas", async () => {
  for (const valuePresence of ["required", "optional"] as const) {
    const installed = formsWithPresence(valuePresence);
    const link = pair({
      guestForms: installed, providerForms: installed,
      providerHooks: {
        onGet(request) {
          currentProvider!.replyObject(request, { ref: ref(), codec: RELAY_CODEC.NONE, data: new Uint8Array(0),
            value: { lines: ["ok"], cursor: 0 } });
        },
      },
      transform: (from, frame) => {
        if (from !== "provider" || frame.metadata.op !== RELAY_OP.RESOURCE_GET
            || frame.metadata.status !== RELAY_STATUS.OK) return frame;
        return { ...frame, metadata: { ...frame.metadata, value: { lines: "ok", cursor: 0 } } };
      },
    });
    currentProvider = link.provider;
    const stream = await connect(link);
    const result = await getOnce(link, stream, ref(), { accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096 });
    await link.settle();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect((result.error as { code: string }).code).toBe(RELAY_ERROR.INVALID);
  }
});

test("valuePresence controls absent codec-0 and empty codec-1 get content on both ends", async () => {
  for (const codec of [RELAY_CODEC.NONE, RELAY_CODEC.JSON]) {
    for (const valuePresence of ["required", "optional"] as const) {
      let produced: unknown;
      const providerCheck = pair({
        guestForms: formsWithPresence("optional"),
        providerForms: formsWithPresence(valuePresence),
        providerHooks: { onGet(request) {
          produced = currentProvider!.replyObject(request, {
            ref: ref(), codec, data: new Uint8Array(0),
          });
        } },
      });
      currentProvider = providerCheck.provider;
      const providerResult = await getOnce(providerCheck, await connect(providerCheck), ref(), {
        accept: [codec], maxObjectBytes: 4096,
      });
      await providerCheck.settle();
      if (valuePresence === "required") {
        expect(produced).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
        expect(providerResult.ok).toBe(false);
      } else {
        expect(produced).toEqual({ ok: true, frames: 1 });
        expect(providerResult.ok).toBe(true);
        if (!providerResult.ok) throw new Error("optional value was refused");
        expect("value" in providerResult && (providerResult.value as { value?: unknown }).value).toBeUndefined();
      }

      let injected: unknown;
      const guestCheck = pair({
        guestForms: formsWithPresence(valuePresence),
        providerForms: formsWithPresence("optional"),
        providerHooks: { onGet(request) {
          injected = currentProvider!.replyObject(request, {
            ref: ref(), codec, data: new Uint8Array(0),
          });
        } },
      });
      currentProvider = guestCheck.provider;
      const guestResult = await getOnce(guestCheck, await connect(guestCheck), ref(), {
        accept: [codec], maxObjectBytes: 4096,
      });
      await guestCheck.settle();
      expect(injected).toEqual({ ok: true, frames: 1 });
      expect(guestResult.ok).toBe(valuePresence === "optional");
      if (!guestResult.ok) expect((guestResult.error as { code: string }).code).toBe(RELAY_ERROR.INVALID);
    }
  }
});

test("codec-1 JSON data validates against the value schema on both ends", async () => {
  const json = stringToUtf8(JSON.stringify(pageValue0));
  for (const valuePresence of ["required", "optional"] as const) {
    const installed = formsWithPresence(valuePresence);
    const link = pair({
      guestForms: installed, providerForms: installed,
      providerHooks: {
        onGet(request) {
          currentProvider!.replyObject(request, { ref: ref(), codec: RELAY_CODEC.JSON, data: json });
        },
      },
    });
    currentProvider = link.provider;
    const stream = await connect(link);
    const good = await getOnce(link, stream, ref(), { accept: [RELAY_CODEC.JSON], maxObjectBytes: 4096 });
    await link.settle();
    expect(good.ok).toBe(true);

    // Provider-local refusal before chunking.
    const request = { stream, correlation: 9, op: RELAY_OP.RESOURCE_GET,
      metadata: { op: RELAY_OP.RESOURCE_GET, resource: ref(), args: { accept: [RELAY_CODEC.JSON], maxObjectBytes: 4096 } } };
    const refused = link.provider.replyObject(request as unknown as RelayIncomingRequest,
      { ref: ref(), codec: RELAY_CODEC.JSON, data: stringToUtf8(JSON.stringify({ lines: [], cursor: "no" })) });
    expect(refused).toEqual({ ok: false, code: RELAY_ERROR.INVALID });

    // Inbound JSON with a matching digest but a value the form rejects.
    const bad = pair({
      guestForms: installed, providerForms: installed,
      providerHooks: {
        onGet(req) {
          badProvider!.replyObject(req, { ref: ref(), codec: RELAY_CODEC.JSON, data: json });
        },
      },
      transform: (from, frame) => {
        if (from !== "provider" || frame.type !== RELAY_TYPE.RESPONSE || !frame.data.length) return frame;
        const data = stringToUtf8(JSON.stringify({ lines: [], cursor: "no" }));
        return { ...frame, data, metadata: { ...frame.metadata, digest: `sha256:${sha256Hex(data)}` } };
      },
    });
    let badProvider: RelayEndpoint | undefined;
    badProvider = bad.provider;
    const s = await connect(bad);
    const result = await getOnce(bad, s, ref(), { accept: [RELAY_CODEC.JSON], maxObjectBytes: 4096 });
    await bad.settle();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect((result.error as { code: string }).code).toBe(RELAY_ERROR.INVALID);
  }
});

test("required and optional forms validate codec-1 pushes on both ends", async () => {
  const json = stringToUtf8(JSON.stringify(pageValue0));
  for (const valuePresence of ["required", "optional"] as const) {
    const installed = formsWithPresence(valuePresence);
    const objects: unknown[] = [];
    const ends: string[] = [];
    const link = pair({ guestForms: installed, providerForms: installed });
    currentProvider = link.provider;
    const stream = await connect(link);
    const complete = await new Promise<ResourceResult<{ subscription?: number }>>((resolve) => {
      link.guest.subscribe(stream, { ns: "term/session-1" }, RELAY_DELIVERY.LATEST_SNAPSHOT,
        { onObject: o => objects.push(o), onEnd: e => ends.push(e?.code ?? "") }, resolve);
    });
    await link.settle();
    const id = (complete as { ok: true; value: { subscription: number } }).value.subscription;
    expect(link.provider.pushObject({ stream, subscription: id, ref: ref(), codec: RELAY_CODEC.JSON,
      data: json })).toEqual({ ok: true, frames: 1 });
    await link.settle();
    expect(objects.length).toBe(1);
    expect(ends).toEqual([]);
    expect(link.provider.pushObject({ stream, subscription: id, ref: ref("s-43"), codec: RELAY_CODEC.JSON,
      data: stringToUtf8(JSON.stringify({ lines: [], cursor: "bad" })) }))
      .toEqual({ ok: false, code: RELAY_ERROR.INVALID });

    const injectedObjects: unknown[] = [];
    const injectedEnds: string[] = [];
    const injected = pair({
      guestForms: installed, providerForms: installed,
      transform(from, frame) {
        if (from !== "provider" || frame.type !== RELAY_TYPE.PUSH || !frame.data.length) return frame;
        const data = stringToUtf8(JSON.stringify({ lines: [], cursor: "bad" }));
        return { ...frame, data, metadata: { ...frame.metadata, digest: `sha256:${sha256Hex(data)}` } };
      },
    });
    currentProvider = injected.provider;
    const injectedStream = await connect(injected);
    const injectedComplete = await new Promise<ResourceResult<{ subscription?: number }>>((resolve) => {
      injected.guest.subscribe(injectedStream, { ns: "term/session-1" }, RELAY_DELIVERY.LATEST_SNAPSHOT,
        { onObject: o => injectedObjects.push(o), onEnd: e => injectedEnds.push(e?.code ?? "") }, resolve);
    });
    await injected.settle();
    const injectedId = (injectedComplete as { ok: true; value: { subscription: number } }).value.subscription;
    expect(injected.provider.pushObject({ stream: injectedStream, subscription: injectedId, ref: ref(),
      codec: RELAY_CODEC.JSON, data: json })).toEqual({ ok: true, frames: 1 });
    await injected.settle();
    expect(injectedObjects).toEqual([]);
    expect(injectedEnds).toEqual([RELAY_ERROR.INVALID]);
  }
});

test("valuePresence controls missing push values on both ends", async () => {
  for (const codec of [RELAY_CODEC.NONE, RELAY_CODEC.JSON]) {
    for (const valuePresence of ["required", "optional"] as const) {
      const providerObjects: unknown[] = [];
      const providerCheck = pair({
        guestForms: formsWithPresence("optional"),
        providerForms: formsWithPresence(valuePresence),
      });
      currentProvider = providerCheck.provider;
      const stream = await connect(providerCheck);
      const complete = await new Promise<ResourceResult<{ subscription?: number }>>((resolve) => {
        providerCheck.guest.subscribe(stream, { ns: "term/session-1" }, RELAY_DELIVERY.LATEST_SNAPSHOT,
          { onObject: o => providerObjects.push(o) }, resolve);
      });
      await providerCheck.settle();
      const id = (complete as { ok: true; value: { subscription: number } }).value.subscription;
      const produced = providerCheck.provider.pushObject({
        stream, subscription: id, ref: ref(), codec, data: new Uint8Array(0),
      });
      expect(produced.ok).toBe(valuePresence === "optional");
      await providerCheck.settle();
      expect(providerObjects.length).toBe(valuePresence === "optional" ? 1 : 0);

      const guestObjects: unknown[] = [];
      const guestEnds: string[] = [];
      const guestCheck = pair({
        guestForms: formsWithPresence(valuePresence),
        providerForms: formsWithPresence("optional"),
      });
      currentProvider = guestCheck.provider;
      const guestStream = await connect(guestCheck);
      const guestComplete = await new Promise<ResourceResult<{ subscription?: number }>>((resolve) => {
        guestCheck.guest.subscribe(guestStream, { ns: "term/session-1" }, RELAY_DELIVERY.LATEST_SNAPSHOT,
          { onObject: o => guestObjects.push(o), onEnd: e => guestEnds.push(e?.code ?? "") }, resolve);
      });
      await guestCheck.settle();
      const guestId = (guestComplete as { ok: true; value: { subscription: number } }).value.subscription;
      expect(guestCheck.provider.pushObject({
        stream: guestStream, subscription: guestId, ref: ref(), codec, data: new Uint8Array(0),
      })).toEqual({ ok: true, frames: 1 });
      await guestCheck.settle();
      expect(guestObjects.length).toBe(valuePresence === "optional" ? 1 : 0);
      expect(guestEnds).toEqual(valuePresence === "required" ? [RELAY_ERROR.INVALID] : []);
    }
  }
});

test("a pushed object validates against the subscription form; a bad push ends the subscription", async () => {
  const objects: unknown[] = [];
  const ends: string[] = [];
  const link = pair();
  currentProvider = link.provider;
  const stream = await connect(link);
  const complete = await new Promise<ResourceResult<{ subscription?: number }>>((resolve) => {
    link.guest.subscribe(stream, { ns: "term/session-1" }, RELAY_DELIVERY.LATEST_SNAPSHOT,
      { onObject: (o) => objects.push(o.value), onEnd: (e) => ends.push(e?.code ?? "") }, resolve);
  });
  await link.settle();
  expect(complete.ok).toBe(true);
  const id = (complete as { ok: true; value: { subscription: number } }).value.subscription;
  const pushRef: RelayResourceRef = { kind: RELAY_KIND.EVENT, ns: "term/session-1", key: "evt-1", revision: "e1", rendition: "v1" };

  const pushed = link.provider.pushObject({ stream, subscription: id, ref: pushRef,
    codec: RELAY_CODEC.NONE, data: new Uint8Array(0), value: { line: 3, text: "prompt" } });
  expect(pushed).toEqual({ ok: true, frames: 1 });
  await link.settle();
  expect(objects).toEqual([{ line: 3, text: "prompt" }]);

  const refused = link.provider.pushObject({ stream, subscription: id, ref: pushRef,
    codec: RELAY_CODEC.NONE, data: new Uint8Array(0), value: { line: "3", text: "prompt" } });
  expect(refused).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
});

test("provider answers INVALID for malformed subscribe product args and for an unregistered subscribe key", async () => {
  const inject = (extra: Record<string, unknown>) => (from: Role, frame: RelayDecodedFrame) => {
    if (from !== "guest" || frame.metadata.op !== RELAY_OP.RESOURCE_SUBSCRIBE) return frame;
    return { ...frame, metadata: { ...frame.metadata,
      args: { ...(frame.metadata.args as Record<string, unknown>), ...extra } } };
  };
  // Unknown namespace key; type mismatch on the registered event key.
  for (const extra of [{ bogus: 1 }, { "term-event": { fromLine: "1" } }] as const) {
    const link = pair({
      transform: inject(extra),
      providerHooks: { onGet: () => { throw new Error("subscribe must be refused"); } },
    });
    currentProvider = link.provider;
    const stream = await connect(link);
    const result = await new Promise<ResourceResult<{ subscription?: number }>>((resolve) => {
      const started = link.guest.subscribe(stream, { ns: "term/session-1" }, RELAY_DELIVERY.LATEST_SNAPSHOT,
        { onObject: () => {}, onEnd: () => {} }, resolve);
      if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
    });
    await link.settle();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect((result.error as { code: string }).code).toBe(RELAY_ERROR.INVALID);
  }

  // The TERMINAL_CELLS key on a ref subscribe where the form opted out of
  // subscribe: the public schema stays closed and the key is unknown there.
  const link = pair({
    providerForms: [form({ onSubscribe: false }), eventForm()],
    transform: (from, frame) => {
      if (from !== "guest" || frame.metadata.op !== RELAY_OP.RESOURCE_SUBSCRIBE) return frame;
      return { ...frame, metadata: { ...frame.metadata,
        args: { ...(frame.metadata.args as Record<string, unknown>), term: { page: 1 } } } };
    },
  });
  currentProvider = link.provider;
  const stream = await connect(link);
  const result = await new Promise<ResourceResult<{ subscription?: number }>>((resolve) => {
    const started = link.guest.subscribe(stream, ref(), RELAY_DELIVERY.LATEST_SNAPSHOT,
      { onObject: () => {}, onEnd: () => {} }, resolve);
    if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
  });
  await link.settle();
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect((result.error as { code: string }).code).toBe(RELAY_ERROR.INVALID);
});

test("rendition regression: two requests share one rendition and differ only in the product args key", async () => {
  const pages = new Map<number, unknown>();
  const link = pair({
    providerHooks: {
      onGet(request) {
        const args = request.metadata.args as { term?: { page: number } };
        const page = args.term?.page ?? 0;
        pages.set(page, true);
        currentProvider!.replyObject(request, {
          ref: ref("s-42"), codec: RELAY_CODEC.NONE, data: new Uint8Array(0),
          value: { lines: [`page ${page}`], cursor: page },
        });
      },
    },
  });
  currentProvider = link.provider;
  const stream = await connect(link);
  const shared = ref();
  const first = await getOnce(link, stream, shared, {
    accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096, product: { key: "term", value: { page: 1 } },
  });
  const second = await getOnce(link, stream, shared, {
    accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096, product: { key: "term", value: { page: 2 } },
  });
  await link.settle();
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(pages.has(1)).toBe(true);
  expect(pages.has(2)).toBe(true);
  // Both wire requests carry the same rendition; the page lives in args.term.
  const gets = link.frames("guest").filter(f => f.metadata.op === RELAY_OP.RESOURCE_GET);
  expect(gets.map(f => (f.metadata.resource as RelayResourceRef).rendition)).toEqual(["grid-density1-v1", "grid-density1-v1"]);
  expect(gets.map(f => (f.metadata.args as { term: { page: number } }).term.page)).toEqual([1, 2]);
});
