import { afterEach, expect, test } from "bun:test";
import { connect as connectSocket } from "node:net";
import { attachRelayChannel, relaySocketChannel, serveRelayTcp, type RelayProviderConnection } from "../tools/relay-wire.ts";
import {
  RELAY_CODEC, RELAY_EFFECT, RELAY_ERROR, RELAY_OP, RELAY_PRIVATE_OP, RELAY_STATUS, RELAY_TYPE,
  type RelayProfileEntry, type RelayRxLimits,
} from "../contracts/spec/relay.ts";
import {
  RelayEndpoint, RelayOperationAuthority, type RelayEndpointHooks, type RelayIncomingRequest, type RelayPrivateOp, type RelayPrivateSchema,
} from "../framework/src/relay/endpoint.ts";
import { SqliteOperationStore } from "./helpers/relay-operation-store.ts";
import { decodeFrame, encodeFrame, type RelayDecodedFrame } from "../framework/src/relay/frame.ts";
import type { RelayLocalCapabilities, RelayScheduler } from "../framework/src/relay/session.ts";

const PROFILE = { name: "org.example.commands", version: 1 };
const OTHER = { name: "org.example.other", version: 1 };
const operationStores: SqliteOperationStore[] = [];
afterEach(() => { for (const store of operationStores.splice(0)) store.db.close(); });
const operationAuthority = (role: string) => {
  const store = new SqliteOperationStore(); operationStores.push(store);
  return new RelayOperationAuthority({ id: `authority-${role}`, store });
};
const RX: RelayRxLimits = {
  maxWireBytes: 4096, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 32768,
  maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 2, maxScratchBytes: 262144,
};
const closed = (properties: Record<string, unknown> = {}, required = Object.keys(properties)): RelayPrivateSchema =>
  ({ type: "object", additionalProperties: false, properties, required });
const argsSchema = () => closed({ n: { type: "integer", minimum: 0, maximum: 100 } });
const valueSchema = () => closed({ ack: { type: "integer", minimum: 0 } });
const op = (patch: Partial<RelayPrivateOp> = {}): RelayPrivateOp => ({
  profile: PROFILE, name: `x.${PROFILE.name}.echo`, direction: "bidirectional", recovery: "idempotent",
  args: argsSchema(), value: valueSchema(), maxWireBytes: 1024, maxObjectBytes: 512, ...patch,
});
type Role = "guest" | "provider";
type Captured = { from: Role; bytes: Uint8Array };
const decode = (record: Uint8Array): RelayDecodedFrame => {
  const result = decodeFrame(record);
  if (!result.ok) throw new Error(result.code);
  return result.frame;
};
const scheduler = (): RelayScheduler => {
  let id = 0;
  return { now: () => 0, setTimeout: () => ++id, clearTimeout: () => {} };
};
const capabilities = (patch: Partial<RelayLocalCapabilities> = {}): RelayLocalCapabilities => ({
  app: "example", versions: [[1, 0]], profiles: [PROFILE, OTHER],
  codecs: [RELAY_CODEC.NONE, RELAY_CODEC.JSON], kinds: [6, 7], rxLimits: RX, ...patch,
});

function pair(options: {
  guestOps?: readonly RelayPrivateOp[]; providerOps?: readonly RelayPrivateOp[];
  guestCaps?: Partial<RelayLocalCapabilities>; providerCaps?: Partial<RelayLocalCapabilities>;
  guestHooks?: RelayEndpointHooks; providerHooks?: RelayEndpointHooks;
  sync?: boolean; reserve?: number;
  transform?: (from: Role, frame: RelayDecodedFrame) => RelayDecodedFrame;
} = {}) {
  const wire: Captured[] = [], held: Captured[] = [];
  const busy = { guest: false, provider: false }, hold = { guest: false, provider: false };
  const endpoints = {} as Record<Role, RelayEndpoint>;
  const route = (from: Role, bytes: Uint8Array) => {
    if (busy[from]) return "busy" as const;
    let copy: Uint8Array = bytes.slice();
    if (options.transform) {
      const encoded = encodeFrame(options.transform(from, decode(copy)));
      if (!encoded.ok) throw new Error(encoded.code);
      copy = encoded.bytes;
    }
    wire.push({ from, bytes: copy });
    const target = endpoints[from === "guest" ? "provider" : "guest"];
    if (hold[from]) held.push({ from, bytes: copy });
    else if (options.sync) target.handleRecord(copy);
    else queueMicrotask(() => target.handleRecord(copy));
    return "accepted" as const;
  };
  for (const role of ["guest", "provider"] as const) {
    let randomSeed = role === "guest" ? 17 : 23;
    endpoints[role] = new RelayEndpoint({ role,
      local: capabilities(role === "guest" ? options.guestCaps : options.providerCaps),
      privateOps: (role === "guest" ? options.guestOps : options.providerOps) ?? [op()],
      operations: operationAuthority(role),
      transport: { peer: { id: `peer-${role}`, grants: ["example"] }, trySend: bytes => route(role, bytes) },
      hooks: role === "guest" ? options.guestHooks : options.providerHooks,
      scheduler: scheduler(), randomBytes: n => new Uint8Array(n).fill(randomSeed++),
      requestReserve: options.reserve,
    });
  }
  const settle = async () => {
    for (let i = 0; i < 32; i++) { await Promise.resolve(); endpoints.guest.flush(); endpoints.provider.flush(); }
  };
  const frames = (from?: Role) => wire.filter(record => !from || record.from === from).map(record => ({ from: record.from, ...decode(record.bytes) }));
  const deliverHeld = () => {
    for (const record of held.splice(0)) endpoints[record.from === "guest" ? "provider" : "guest"].handleRecord(record.bytes);
  };
  return { ...endpoints, wire, busy, hold, held, settle, frames, deliverHeld };
}
type Pair = ReturnType<typeof pair>;
async function connect(link: Pair, profile: RelayProfileEntry = PROFILE, rxLimits?: RelayRxLimits) {
  expect(link.guest.hello()).toEqual({ ok: true });
  await link.settle();
  await link.guest.whenReady();
  expect(link.provider.phase).toBe("ready");
  const opened = link.guest.open({ app: "example", namespace: "example/commands", profile, rxLimits });
  await link.settle();
  return (await opened).stream;
}
function heldRequests() {
  const requests: RelayIncomingRequest[] = [];
  return { requests, hooks: { onRequest: (request: RelayIncomingRequest) => { requests.push(request); return true; } } };
}
const failure = (code: string) => ({ ok: false as const, error: { code, message: code } });

test("private registration: closed prefixes, profile namespace, duplicates and stream fields reject", () => {
  for (const prefix of ["relay", "resource", "cache", "request", "operation"]) {
    expect(() => pair({ guestOps: [op({ name: `${prefix}.private` })] })).toThrow();
  }
  for (const name of ["x.echo", `x.${PROFILE.name}.`, `x.${PROFILE.name}x.echo`, "x.org.example.foreign.echo",
    `x.${PROFILE.name}.Upper`, `x.${PROFILE.name}.${"a".repeat(65)}`]) {
    expect(() => pair({ guestOps: [op({ name })] })).toThrow();
  }
  expect(() => pair({ guestOps: [op(), op()] })).toThrow();
  expect(() => pair({ guestOps: [op(), op({ recovery: "epoch" })] })).toThrow();
  expect(() => pair({ guestOps: [op({ profile: { ...PROFILE, version: 2 } })] })).toThrow();
  expect(() => pair({ guestOps: [{ ...op(), stream: 0 } as RelayPrivateOp] })).toThrow();
  expect(() => pair({ guestOps: [{ ...op(), direction: "either" } as unknown as RelayPrivateOp] })).toThrow();
});

test("private registration: budgets, descriptor count and schema asset bounds reject", () => {
  for (const field of ["maxWireBytes", "maxObjectBytes"] as const) {
    for (const value of [-1, 0, 1.5, NaN, Infinity, 0x1_0000_0000, RX[field] + 1]) {
      expect(() => pair({ guestOps: [op({ [field]: value })] })).toThrow();
    }
  }
  expect(() => pair({ guestOps: [op({ maxWireBytes: 47 })] })).toThrow();
  expect(() => pair({ guestOps: Array.from({ length: RELAY_PRIVATE_OP.maxEntries + 1 }, (_, n) => op({ name: `x.${PROFILE.name}.op${n}` })) })).toThrow();
  expect(() => pair({ guestOps: [op({ args: closed({ text: { type: "string", const: "a".repeat(65536) } }) })] })).toThrow();
});

test("private registration: schema language rejects unknown keywords, open objects and cycles", () => {
  for (const args of [{}, { ...argsSchema(), additionalProperties: true }, { ...argsSchema(), $ref: "remote" },
    { ...argsSchema(), oneOf: [] }, closed({ n: { type: "number" } }),
    closed({ n: { type: "integer", maxBytes: 5 } }), closed({ s: { type: "string", pattern: "[" } }),
    { ...argsSchema(), required: ["missing"] }, { type: "array", items: [argsSchema()], additionalItems: false }]) {
    expect(() => pair({ guestOps: [op({ args })] })).toThrow();
  }
  const cyclic = closed();
  (cyclic.properties as Record<string, unknown>).self = cyclic;
  expect(() => pair({ guestOps: [op({ args: cyclic })] })).toThrow();
});

test("private negotiation: HELLO intersects op names, directions and budgets; OPEN binds the profile", async () => {
  const a = op(), b = op({ name: `x.${PROFILE.name}.guest` }), c = op({ name: `x.${PROFILE.name}.provider` });
  const link = pair({ guestOps: [a, b], providerOps: [{ ...a, direction: "guest-to-provider", maxWireBytes: 768, maxObjectBytes: 256 }, c] });
  const stream = await connect(link);
  const selected = link.guest.negotiation!.opExt!;
  expect(selected).toEqual([{ profile: PROFILE, name: a.name, direction: "guest-to-provider", recovery: "idempotent", maxWireBytes: 768, maxObjectBytes: 256 }]);
  expect(link.provider.negotiation!.opExt).toEqual(selected);
  expect(link.guest.session.streamInfo(stream)!.opExt).toEqual(selected);
  expect(link.provider.session.streamInfo(stream)!.opExt).toEqual(selected);
  const hello = link.frames().filter(frame => frame.metadata.op === RELAY_OP.HELLO);
  expect(hello).toHaveLength(2);
  expect(JSON.stringify(hello.map(frame => frame.metadata.opExt))).not.toContain("properties");
  const before = link.wire.length;
  expect(await link.guest.request(stream, b.name, { n: 1 })).toEqual(failure(RELAY_ERROR.UNSUPPORTED));
  expect(await link.provider.request(stream, a.name, { n: 1 })).toEqual(failure(RELAY_ERROR.UNSUPPORTED));
  expect(link.wire).toHaveLength(before);
  const other = link.guest.open({ app: "example", namespace: "example/other", profile: OTHER, rxLimits: { ...RX, windowFrames: 1, windowBytes: 4096 } });
  await link.settle();
  expect(await link.guest.request((await other).stream, a.name, { n: 1 })).toEqual(failure(RELAY_ERROR.UNSUPPORTED));
});

test("private negotiation: absent capabilities and recovery mismatch leave the op UNSUPPORTED", async () => {
  for (const providerOps of [[], [op({ recovery: "epoch" })], [op({ direction: "provider-to-guest" })]]) {
    const link = pair({ guestOps: [op({ direction: "guest-to-provider" })], providerOps });
    const stream = await connect(link);
    expect(link.guest.negotiation!.opExt).toBeUndefined();
    expect(await link.guest.request(stream, op().name, { n: 1 })).toEqual(failure(RELAY_ERROR.UNSUPPORTED));
    expect(link.frames().filter(frame => frame.stream === stream)).toHaveLength(0);
  }
});

test("private negotiation: provider does not inject ops into a legacy guest HELLO", async () => {
  const link = pair({ guestOps: [] });
  await connect(link);
  expect(link.frames().filter(frame => frame.metadata.op === RELAY_OP.HELLO).every(frame => !("opExt" in frame.metadata))).toBe(true);
});

for (const sync of [false, true]) test(`private requests: both roles complete once over ${sync ? "synchronous" : "queued"} transport`, async () => {
  const g = heldRequests(), p = heldRequests();
  const link = pair({ sync, guestHooks: g.hooks, providerHooks: p.hooks });
  const stream = await connect(link);
  // Bring both originators to the same correlation: direction is part of the identity.
  while (link.provider.session.allocateCorrelation() < 2) {}
  const guest = link.guest.request(stream, op().name, { n: 7 });
  const provider = link.provider.request(stream, op().name, { n: 9 });
  expect(guest.correlation).toBe(provider.correlation);
  await link.settle();
  expect(g.requests).toHaveLength(1); expect(p.requests).toHaveLength(1);
  for (const endpoint of [link.guest, link.provider]) {
    expect(endpoint.inspect()!.outgoingRequests.active).toBe(1);
    expect(endpoint.inspect()!.incomingRequests.active).toBe(1);
  }
  expect(link.provider.replyValue(p.requests[0], { ack: 7 })).toEqual({ ok: true });
  expect(link.guest.replyValue(g.requests[0], { ack: 9 })).toEqual({ ok: true });
  await link.settle();
  expect(await guest).toEqual({ ok: true, value: { ack: 7 } });
  expect(await provider).toEqual({ ok: true, value: { ack: 9 } });
  expect(link.provider.replyValue(p.requests[0], { ack: 70 }).ok).toBe(false);
  expect(link.guest.replyValue(g.requests[0], { ack: 90 }).ok).toBe(false);
  expect(link.frames().filter(frame => frame.stream === stream && frame.type === RELAY_TYPE.RESPONSE)).toHaveLength(2);
  for (const endpoint of [link.guest, link.provider]) {
    expect(endpoint.inspect()!.outgoingRequests.active + endpoint.inspect()!.incomingRequests.active).toBe(0);
    expect(endpoint.inspect()!.sender.ledgerView().inFlight(stream)).toEqual({ frames: 0, bytes: 0 });
    expect(endpoint.protocolErrors).toBe(0);
  }
});

test("private synchronous handler can reply before request() returns", async () => {
  let link: Pair;
  link = pair({ sync: true, providerHooks: { onRequest(request) { link.provider.replyValue(request, { ack: 3 }); return true; } } });
  const stream = await connect(link);
  const call = link.guest.request(stream, op().name, { n: 3 });
  expect(call.correlation).toBeGreaterThan(0);
  expect(await call).toEqual({ ok: true, value: { ack: 3 } });
  expect(link.guest.inspect()!.outgoingRequests.active).toBe(0);
});

test("private accepted is nonterminal; terminal uniqueness holds while transport is busy", async () => {
  const p = heldRequests();
  const link = pair({ providerHooks: p.hooks });
  const stream = await connect(link);
  const call = link.guest.request(stream, op().name, { n: 1 });
  let completions = 0; void call.then(() => completions++);
  await link.settle();
  const request = p.requests[0];
  const accepted = { type: RELAY_TYPE.RESPONSE, stream, correlation: request.correlation,
    metadata: { op: request.op, status: RELAY_STATUS.ACCEPTED, final: false } };
  expect(link.provider.respond(accepted)).toEqual({ ok: true });
  await link.settle();
  expect(completions).toBe(0);
  expect(link.guest.inspect()!.outgoingRequests.active).toBe(1);
  expect(link.provider.respond(accepted).ok).toBe(false);
  link.busy.provider = true;
  expect(link.provider.replyValue(request, { ack: 1 })).toEqual({ ok: true });
  expect(link.provider.replyValue(request, { ack: 2 }).ok).toBe(false);
  link.provider.replyError(request, RELAY_ERROR.CANCELLED, "cancel", RELAY_EFFECT.NONE);
  link.busy.provider = false;
  await link.settle();
  expect(await call).toEqual({ ok: true, value: { ack: 1 } });
  expect(completions).toBe(1);
  expect(link.frames("provider").filter(frame => frame.stream === stream && frame.metadata.final === true)).toHaveLength(1);
});

test("private schema rejects locally without consuming correlation, credit or transport", async () => {
  const link = pair();
  const stream = await connect(link);
  const before = link.wire.length, credit = link.guest.inspect()!.sender.ledgerView().sentTotals(stream);
  for (const args of [{ n: -1 }, { n: 101 }, { n: 1.5 }, {}, { n: 1, extra: true }, { n: 1, constructor: 1 }]) {
    const call = link.guest.request(stream, op().name, args);
    expect(await call).toEqual(failure(RELAY_ERROR.INVALID)); expect(call.correlation).toBe(0);
  }
  expect(await link.guest.request(stream, op().name, { n: 1 }, { op: "relay.ping" } as never)).toEqual(failure(RELAY_ERROR.INVALID));
  expect(await link.guest.request(0, op().name, { n: 1 })).toEqual(failure(RELAY_ERROR.UNSUPPORTED));
  expect(await link.guest.request(stream, "resource.private", { n: 1 })).toEqual(failure(RELAY_ERROR.UNSUPPORTED));
  expect(await link.guest.request(stream, `x.${PROFILE.name}.unknown`, { n: 1 })).toEqual(failure(RELAY_ERROR.UNSUPPORTED));
  await link.settle();
  expect(link.wire).toHaveLength(before);
  expect(link.guest.inspect()!.sender.ledgerView().sentTotals(stream)).toEqual(credit);
  expect(link.guest.inspect()!.outgoingRequests.active).toBe(0);
  expect(link.guest.request(stream, op().name, { n: 1 }).correlation).toBe(3);
  await link.settle();
});

test("private value schema rejection leaves the request answerable and emits no wire", async () => {
  const p = heldRequests(), link = pair({ providerHooks: p.hooks });
  const stream = await connect(link), call = link.guest.request(stream, op().name, { n: 1 });
  await link.settle();
  const before = link.wire.length;
  expect(link.provider.replyValue(p.requests[0], { ack: "wrong" })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(link.provider.replyValue(p.requests[0], { ack: 1, extra: true })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(link.wire).toHaveLength(before);
  expect(link.provider.inspect()!.incomingRequests.active).toBe(1);
  expect(link.provider.replyValue(p.requests[0], { ack: 1 })).toEqual({ ok: true });
  await link.settle();
  expect(await call).toEqual({ ok: true, value: { ack: 1 } });
});

test("private budgets count UTF-8 object bytes and the entire record; OPEN can narrow them", async () => {
  const definition = op({ args: closed({ text: { type: "string" } }), maxWireBytes: 512, maxObjectBytes: 24 });
  const p = heldRequests(), link = pair({ guestOps: [definition], providerOps: [definition], providerHooks: p.hooks });
  const stream = await connect(link);
  expect(await link.guest.request(stream, definition.name, { text: "界".repeat(5) })).toEqual(failure(RELAY_ERROR.TOO_LARGE));
  const small = link.guest.request(stream, definition.name, { text: "界".repeat(4) });
  await link.settle();
  expect(p.requests).toHaveLength(1);
  link.provider.replyValue(p.requests[0], { ack: 1 }); await link.settle();
  expect((await small).ok).toBe(true);
  const wide = op({ args: definition.args, maxWireBytes: 256, maxObjectBytes: 1024 });
  const second = pair({ guestOps: [wide], providerOps: [wide] });
  const s = await connect(second);
  expect(await second.guest.request(s, wide.name, { text: "a".repeat(230) })).toEqual(failure(RELAY_ERROR.TOO_LARGE));
  const narrowed = pair();
  const n = await connect(narrowed, PROFILE, { ...RX, maxWireBytes: 512, maxObjectBytes: 6 });
  expect(narrowed.guest.session.streamInfo(n)!.opExt![0]).toMatchObject({ maxWireBytes: 512, maxObjectBytes: 6 });
  expect(await narrowed.guest.request(n, op().name, { n: 1 })).toEqual(failure(RELAY_ERROR.TOO_LARGE));
});

for (const initiator of ["guest", "provider"] as const) test(`private CANCEL: ${initiator} retains its slot until CANCELLED/none`, async () => {
  const g = heldRequests(), p = heldRequests(), cancels: number[] = [];
  const link = pair({ guestHooks: { ...g.hooks, onCancel: cancel => cancels.push(cancel.correlation) },
    providerHooks: { ...p.hooks, onCancel: cancel => cancels.push(cancel.correlation) } });
  const stream = await connect(link);
  const receiver = initiator === "guest" ? link.provider : link.guest;
  const requests = initiator === "guest" ? p.requests : g.requests;
  const call = link[initiator].request(stream, op().name, { n: 1 });
  await link.settle();
  const credit = link[initiator].inspect()!.sender.ledgerView().sentTotals(0);
  call.cancel("done"); call.cancel("duplicate");
  await link.settle();
  expect(requests[0].cancelRequested()).toBe(true);
  expect(cancels).toEqual([call.correlation]);
  expect(link[initiator].inspect()!.outgoingRequests.active).toBe(1);
  expect(receiver.inspect()!.incomingRequests.active).toBe(1);
  expect(link[initiator].inspect()!.sender.ledgerView().sentTotals(0)).toEqual(credit);
  expect(link.frames(initiator).filter(frame => frame.type === RELAY_TYPE.CANCEL)).toHaveLength(1);
  receiver.replyError(requests[0], RELAY_ERROR.CANCELLED, "cancelled", RELAY_EFFECT.NONE);
  await link.settle();
  expect(await call).toEqual({ ok: false, error: { code: RELAY_ERROR.CANCELLED, message: "cancelled" }, effect: RELAY_EFFECT.NONE });
  expect(link[initiator].inspect()!.outgoingRequests.active).toBe(0);
  call.cancel(); await link.settle();
  expect(link.frames(initiator).filter(frame => frame.type === RELAY_TYPE.CANCEL)).toHaveLength(1);
});

test("private CANCEL: identical correlations in opposite directions cannot cancel each other", async () => {
  const g = heldRequests(), p = heldRequests(), link = pair({ guestHooks: g.hooks, providerHooks: p.hooks });
  const stream = await connect(link);
  while (link.provider.session.allocateCorrelation() < 2) {}
  const a = link.guest.request(stream, op().name, { n: 1 }), b = link.provider.request(stream, op().name, { n: 2 });
  await link.settle();
  a.cancel(); await link.settle();
  expect(p.requests[0].cancelRequested()).toBe(true); expect(g.requests[0].cancelRequested()).toBe(false);
  expect(link.provider.inspect()!.outgoingRequests.get(b.correlation)!.cancelRequested).toBe(false);
  link.provider.replyError(p.requests[0], RELAY_ERROR.CANCELLED, "cancelled", RELAY_EFFECT.NONE);
  link.guest.replyValue(g.requests[0], { ack: 2 }); await link.settle();
  expect((await a).ok).toBe(false); expect(await b).toEqual({ ok: true, value: { ack: 2 } });
});

test("private CANCEL race: a success in the outbox wins and is delivered once", async () => {
  const p = heldRequests(), link = pair({ providerHooks: p.hooks });
  const stream = await connect(link), call = link.guest.request(stream, op().name, { n: 1 });
  await link.settle();
  link.busy.provider = true;
  link.provider.replyValue(p.requests[0], { ack: 1 });
  call.cancel(); await link.settle();
  link.provider.replyError(p.requests[0], RELAY_ERROR.CANCELLED, "cancelled", RELAY_EFFECT.NONE);
  link.busy.provider = false; await link.settle();
  expect(await call).toEqual({ ok: true, value: { ack: 1 } });
  expect(link.frames("provider").filter(frame => frame.stream === stream && frame.metadata.final === true)).toHaveLength(1);
});

test("private CANCEL can overtake a queued REQUEST without losing the cancellation", async () => {
  const p = heldRequests(), cancelIds: number[] = [];
  const link = pair({ providerHooks: { ...p.hooks, onCancel: cancel => cancelIds.push(cancel.correlation) } });
  const stream = await connect(link);
  link.busy.guest = true;
  const first = link.guest.request(stream, op().name, { n: 1 });
  const second = link.guest.request(stream, op().name, { n: 2 });
  second.cancel(); second.cancel();
  link.busy.guest = false; await link.settle();
  expect(p.requests.map(request => request.correlation)).toEqual([first.correlation, second.correlation]);
  expect(p.requests[0].cancelRequested()).toBe(false); expect(p.requests[1].cancelRequested()).toBe(true);
  expect(cancelIds).toEqual([second.correlation]);
  const order = link.frames("guest").filter(frame => frame.type === RELAY_TYPE.CANCEL || frame.stream === stream);
  expect(order.map(frame => frame.type)).toEqual([RELAY_TYPE.REQUEST, RELAY_TYPE.CANCEL, RELAY_TYPE.REQUEST]);
  link.provider.replyValue(p.requests[0], { ack: 1 });
  link.provider.replyError(p.requests[1], RELAY_ERROR.CANCELLED, "cancelled", RELAY_EFFECT.NONE); await link.settle();
  expect((await first).ok).toBe(true); expect((await second).ok).toBe(false);
  expect(link.guest.protocolErrors + link.provider.protocolErrors).toBe(0);
});

test("private CANCEL sideband saturation keeps one retry per request and releases none early", async () => {
  const p = heldRequests(), link = pair({ providerHooks: p.hooks });
  const stream = await connect(link);
  const calls = Array.from({ length: 6 }, (_, n) => link.guest.request(stream, op().name, { n }));
  await link.settle(); link.busy.guest = true;
  for (const call of calls) for (let repeat = 0; repeat < 20; repeat++) call.cancel();
  expect(link.guest.inspect()!.outgoingRequests.active).toBe(6);
  link.busy.guest = false; await link.settle();
  expect(link.frames("guest").filter(frame => frame.type === RELAY_TYPE.CANCEL)).toHaveLength(6);
  expect(p.requests.every(request => request.cancelRequested())).toBe(true);
  for (const request of p.requests) link.provider.replyError(request, RELAY_ERROR.CANCELLED, "cancelled", RELAY_EFFECT.NONE);
  await link.settle(); expect((await Promise.all(calls)).every(result => !result.ok)).toBe(true);
  expect(link.guest.inspect()!.outgoingRequests.active).toBe(0);
});

test("private P3 BUSY: full credit returns a local error, retaining every admitted frame with contiguous seq", async () => {
  const p = heldRequests();
  const link = pair({ providerHooks: p.hooks });
  const stream = await connect(link, PROFILE, { ...RX, windowFrames: 2, windowBytes: 8192 }); link.busy.guest = true;
  const first = link.guest.request(stream, op().name, { n: 1 });
  const second = link.guest.request(stream, op().name, { n: 2 });
  for (let i = 0; i < 20; i++) expect(await link.guest.request(stream, op().name, { n: 3 })).toEqual(failure(RELAY_ERROR.BUSY));
  const inspection = link.guest.inspect()!;
  expect(inspection.outgoingRequests.active).toBe(2);
  expect(inspection.outboxFrames + inspection.sender.queuedFrames(stream)).toBe(2);
  expect(inspection.demand.size).toBe(0);
  expect(p.requests).toHaveLength(0);
  link.busy.guest = false; await link.settle();
  expect(p.requests.map(request => request.correlation)).toEqual([first.correlation, second.correlation]);
  const frames = link.frames("guest").filter(frame => frame.stream === stream);
  expect(frames.map(frame => frame.seq)).toEqual([1, 2]);
  for (const request of p.requests) link.provider.replyValue(request, { ack: (request.metadata.args as { n: number }).n });
  await link.settle(); expect((await Promise.all([first, second])).every(result => result.ok)).toBe(true);
  const third = link.guest.request(stream, op().name, { n: 3 }); await link.settle();
  link.provider.replyValue(p.requests[2], { ack: 3 }); await link.settle(); expect((await third).ok).toBe(true);
  expect(link.frames("guest").filter(frame => frame.stream === stream).map(frame => frame.seq)).toEqual([1, 2, 3]);
  expect(link.guest.inspect()!.sender.ledgerView().sentTotals(stream)).toEqual(link.guest.inspect()!.sender.ledgerView().releasedTotals(stream));
});

test("private pending shares guest capacity with resource requests and can use the input reserve", async () => {
  const p = heldRequests(), gets: RelayIncomingRequest[] = [];
  const rx = { ...RX, maxPending: 2 };
  const link = pair({ reserve: 1, guestCaps: { rxLimits: rx }, providerCaps: { rxLimits: rx },
    providerHooks: { ...p.hooks, onGet: request => gets.push(request) } });
  const stream = await connect(link);
  const ref = { kind: 7, ns: "example/commands", key: "data", rendition: "json" };
  const first = link.guest.get(stream, ref, { accept: [1], maxObjectBytes: 32 }, () => {});
  expect("correlation" in first).toBe(true);
  expect(link.guest.get(stream, ref, { accept: [1], maxObjectBytes: 32 }, () => {})).toEqual({ ok: false, code: RELAY_ERROR.BUSY });
  const call = link.guest.request(stream, op().name, { n: 1 });
  await link.settle();
  expect(await link.guest.request(stream, op().name, { n: 2 })).toEqual(failure(RELAY_ERROR.BUSY));
  expect(link.guest.inspect()!.outgoingRequests.active).toBe(2);
  link.provider.replyValue(p.requests[0], { ack: 1 });
  link.provider.replyError(gets[0], RELAY_ERROR.NOT_FOUND); await link.settle();
  expect((await call).ok).toBe(true); expect(link.guest.inspect()!.outgoingRequests.active).toBe(0);
});

test("private negotiation rejects forged HELLO selections and malformed offers as UNSUPPORTED", async () => {
  for (const patch of [{ name: `x.${PROFILE.name}.not-offered` }, { profile: { ...PROFILE, version: 2 } },
    { maxWireBytes: 2048 }, { direction: "wrong" }, { recovery: "epoch" }, { stream: 0 }]) {
    const link = pair({ transform(from, frame) {
      if (from === "provider" && frame.metadata.op === RELAY_OP.HELLO) {
        frame.metadata.opExt = [{ ...(frame.metadata.opExt as object[])[0], ...patch }];
      }
      return frame;
    } });
    const ready = link.guest.whenReady().catch(error => error);
    link.guest.hello(); await link.settle();
    expect(link.guest.phase).toBe("closed"); expect(String(await ready)).toContain(RELAY_ERROR.UNSUPPORTED);
    expect(link.frames("guest").filter(frame => frame.metadata.op === RELAY_OP.READY)).toHaveLength(0);
  }
  const bad = pair({ transform(from, frame) {
    if (from === "guest" && frame.metadata.op === RELAY_OP.HELLO) frame.metadata.opExt = [{ stream: 0 }];
    return frame;
  } });
  bad.guest.hello(); await bad.settle();
  expect(bad.frames("provider")[0].metadata.error).toMatchObject({ code: RELAY_ERROR.UNSUPPORTED });
});

test("private OPEN refuses profile substitution before granting a business stream", async () => {
  const link = pair({ transform(from, frame) {
    if (from === "provider" && frame.metadata.op === RELAY_OP.OPEN) frame.metadata.profile = OTHER;
    return frame;
  } });
  link.guest.hello(); await link.settle();
  const opened = link.guest.open({ app: "example", namespace: "example/commands", profile: PROFILE }).catch(error => error);
  await link.settle(); expect(await opened).toBe(RELAY_ERROR.UNSUPPORTED);
  expect(link.guest.session.streamIds()).toEqual([]); expect(link.guest.phase).toBe("closed");
});

test("private capabilities and pending OPEN do not alias caller-owned objects", async () => {
  const definition = op(); const local = capabilities();
  const p = heldRequests(), link = pair({ guestOps: [definition], providerOps: [op()], guestCaps: local, providerHooks: p.hooks });
  definition.name = "relay.ping";
  (definition.args.properties as Record<string, unknown>).n = { type: "string" };
  local.profiles = [OTHER];
  const stream = await connect(link);
  expect(() => { link.guest.negotiation!.opExt![0].direction = "provider-to-guest"; }).toThrow();
  expect(() => { link.guest.session.streamInfo(stream)!.profile.name = "changed"; }).toThrow();
  const call = link.guest.request(stream, op().name, { n: 1 }); await link.settle();
  link.provider.replyValue(p.requests[0], { ack: 1 }); await link.settle(); expect((await call).ok).toBe(true);
});

test("private malformed inbound args and unknown ops never reach either role's handler", async () => {
  for (const from of ["guest", "provider"] as const) {
    for (const mutation of ["args", "op", "envelope", "codec"] as const) {
      const g = heldRequests(), p = heldRequests();
      const link = pair({ guestHooks: g.hooks, providerHooks: p.hooks, transform(role, frame) {
        if (role === from && frame.type === RELAY_TYPE.REQUEST && frame.stream !== 0) {
          if (mutation === "args") frame.metadata.args = { n: "bad" };
          else if (mutation === "op") frame.metadata.op = `x.${PROFILE.name}.unknown`;
          else if (mutation === "codec") { frame.codec = RELAY_CODEC.JSON; frame.data = new TextEncoder().encode("{}"); }
          else frame.metadata.rogue = true;
        }
        return frame;
      } });
      const stream = await connect(link), call = link[from].request(stream, op().name, { n: 1 });
      await link.settle(); expect(g.requests.length + p.requests.length).toBe(0);
      const response = link.frames().find(frame => frame.stream === stream && frame.type === RELAY_TYPE.RESPONSE)!;
      expect(response.metadata.error).toMatchObject({ code: mutation === "op" || mutation === "codec" ? RELAY_ERROR.UNSUPPORTED : RELAY_ERROR.INVALID });
      if (mutation === "op") { link[from].close(); }
      expect((await call).ok).toBe(false);
    }
  }
});

test("private response op and stream must match pending; late duplicates cannot settle a second time", async () => {
  const p = heldRequests(), link = pair({ providerHooks: p.hooks });
  const stream = await connect(link, PROFILE, { ...RX, windowFrames: 3, windowBytes: 12288 });
  const call = link.guest.request(stream, op().name, { n: 1 });
  let settled = 0; void call.then(() => settled++); await link.settle();
  const base = { type: RELAY_TYPE.RESPONSE, stream, correlation: call.correlation, metadata: { op: `x.${PROFILE.name}.wrong`, status: "ok", final: true, value: { ack: 2 } } };
  expect(link.provider.inspect()!.sender.admit(base).ok).toBe(true); link.provider.flush(); await link.settle();
  expect(settled).toBe(0); expect(link.guest.inspect()!.outgoingRequests.active).toBe(1);
  const other = link.guest.open({ app: "example", namespace: "other", profile: OTHER, rxLimits: { ...RX, windowFrames: 1, windowBytes: 4096 } });
  await link.settle();
  const otherStream = (await other).stream;
  expect(link.provider.inspect()!.sender.admit({ ...base, stream: otherStream, metadata: { ...base.metadata, op: op().name } }).ok).toBe(true);
  link.provider.flush(); await link.settle();
  expect(settled).toBe(0); expect(link.guest.inspect()!.outgoingRequests.active).toBe(1);
  link.provider.replyValue(p.requests[0], { ack: 1 }); await link.settle();
  expect(await call).toEqual({ ok: true, value: { ack: 1 } });
  expect(link.provider.inspect()!.sender.admit({ ...base, metadata: { ...base.metadata, op: op().name } }).ok).toBe(true);
  link.provider.flush(); await link.settle(); expect(settled).toBe(1);
  expect(link.guest.inspect()!.outgoingRequests.active).toBe(0);
});

test("private invalid response is a single local error and returns credit", async () => {
  const p = heldRequests(), link = pair({ providerHooks: p.hooks, transform(from, frame) {
    if (from === "provider" && frame.type === RELAY_TYPE.RESPONSE && frame.stream !== 0) frame.metadata.value = { ack: "bad" };
    return frame;
  } });
  const stream = await connect(link), call = link.guest.request(stream, op().name, { n: 1 }); await link.settle();
  link.provider.replyValue(p.requests[0], { ack: 1 }); await link.settle();
  expect(await call).toEqual({ ...failure(RELAY_ERROR.INVALID), effect: RELAY_EFFECT.UNKNOWN });
  expect(link.guest.inspect()!.outgoingRequests.active).toBe(0);
  expect(link.guest.inspect()!.receiver.occupancy()).toEqual({ frames: 0, bytes: 0 });
});

test("private durable registration requires a receipt query and validates write identifiers", async () => {
  const query = op({ name: `x.${PROFILE.name}.status`, args: closed({ opId: { type: "string", pattern: "^[0-9a-f]{32}$" } }) });
  const mutation = op({ name: `x.${PROFILE.name}.commit`, recovery: "durable", recoveryOp: query.name,
    value: closed({ receipt: { type: "string", minLength: 1 } }) });
  expect(() => pair({ guestOps: [mutation] })).toThrow();
  expect(() => pair({ guestOps: [query, { ...mutation, value: valueSchema() }] })).toThrow();
  const p = heldRequests(), link = pair({ guestOps: [query, mutation], providerOps: [query, mutation], providerHooks: p.hooks });
  const stream = await connect(link);
  expect(await link.guest.request(stream, mutation.name, { n: 1 })).toEqual(failure(RELAY_ERROR.INVALID));
  expect(await link.guest.request(stream, mutation.name, { n: 1 }, { opEpoch: "0", opId: "a".repeat(32) })).toEqual(failure(RELAY_ERROR.INVALID));
  const call = link.guest.request(stream, mutation.name, { n: 1 }, { opEpoch: "0".repeat(15) + "1", opId: "a".repeat(32) });
  await link.settle();
  expect(p.requests[0].metadata).toMatchObject({ opEpoch: "0".repeat(15) + "1", opId: "a".repeat(32) });
  expect(link.provider.replyValue(p.requests[0], { ack: 1 })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  p.requests[0].operation!.commit({ receipt: "committed-1" }, () => {}); await link.settle();
  expect(await call).toEqual({ ok: true, value: { receipt: "committed-1" }, effect: RELAY_EFFECT.COMMITTED });
});

test("private reset and disconnect settle once, fence old callbacks and never replay epoch commands", async () => {
  for (const recovery of ["idempotent", "epoch"] as const) {
    const definition = op({ recovery }), p = heldRequests();
    const link = pair({ guestOps: [definition], providerOps: [definition], providerHooks: p.hooks });
    const ids = recovery === "epoch" ? { opEpoch: "0000000000000001", opId: "a".repeat(32) } : {};
    let stream = await connect(link), call = link.guest.request(stream, definition.name, { n: 1 }, ids); await link.settle();
    let completions = 0; void call.then(() => completions++);
    link.guest.resetStream(stream, "reset"); await link.settle();
    expect(await call).toMatchObject({ ok: false, error: { code: recovery === "idempotent" ? RELAY_ERROR.RESYNC_REQUIRED : RELAY_ERROR.OUTCOME_UNKNOWN }, effect: "unknown" });
    expect(completions).toBe(1); expect(link.provider.replyValue(p.requests[0], { ack: 1 }).ok).toBe(false);
    link.guest.handleDisconnect("drop"); link.provider.handleDisconnect("drop");
    stream = await connect(link);
    expect(link.frames("guest").filter(frame => frame.type === RELAY_TYPE.REQUEST && frame.stream !== 0)).toHaveLength(1);
    call = link.guest.request(stream, definition.name, { n: 2 }, recovery === "epoch" ? { ...ids, opId: "b".repeat(32) } : {}); await link.settle();
    link.guest.handleDisconnect("drop again"); link.provider.handleDisconnect("drop again");
    expect((await call).ok).toBe(false);
  }
});

test("private delayed reply cannot answer the same correlation in a replacement session", async () => {
  const p = heldRequests(), link = pair({ providerHooks: p.hooks });
  let stream = await connect(link);
  const oldCall = link.guest.request(stream, op().name, { n: 1 }); await link.settle();
  const old = p.requests[0];
  link.guest.handleDisconnect("replacement"); link.provider.handleDisconnect("replacement");
  expect((await oldCall).ok).toBe(false);
  stream = await connect(link);
  const newCall = link.guest.request(stream, op().name, { n: 2 }); await link.settle();
  expect(newCall.correlation).toBe(oldCall.correlation);
  expect(p.requests[1].session).not.toBe(old.session);
  expect(link.provider.replyValue(old, { ack: 1 })).toEqual({ ok: false, code: RELAY_ERROR.RESYNC_REQUIRED });
  expect(link.provider.replyError(old, RELAY_ERROR.NOT_FOUND)).toEqual({ ok: false, code: RELAY_ERROR.RESYNC_REQUIRED });
  link.provider.replyValue(p.requests[1], { ack: 2 }); await link.settle();
  expect(await newCall).toEqual({ ok: true, value: { ack: 2 } });
});

test("private peer cannot reuse a completed request id or cancel the wrong stream", async () => {
  const p = heldRequests(), link = pair({ providerHooks: p.hooks });
  const stream = await connect(link, PROFILE, { ...RX, windowFrames: 2, windowBytes: 8192 });
  const opened = link.guest.open({ app: "example", namespace: "second", profile: PROFILE, rxLimits: { ...RX, windowFrames: 2, windowBytes: 8192 } });
  await link.settle(); const other = (await opened).stream;
  const call = link.guest.request(stream, op().name, { n: 1 }); await link.settle();
  expect(link.guest.inspect()!.sender.cancel(other, call.correlation, "wrong stream").ok).toBe(true);
  link.guest.flush(); await link.settle(); expect(p.requests[0].cancelRequested()).toBe(false);
  link.provider.replyValue(p.requests[0], { ack: 1 }); await link.settle(); expect((await call).ok).toBe(true);
  expect(link.guest.inspect()!.sender.admit({ type: RELAY_TYPE.REQUEST, stream, correlation: call.correlation,
    metadata: { op: op().name, args: { n: 2 } } }).ok).toBe(true);
  link.guest.flush(); await link.settle();
  expect(p.requests).toHaveLength(1); expect(link.provider.inspect()!.incomingRequests.active).toBe(0);
});

test("private inbound direction is checked before either handler", async () => {
  const g = heldRequests(), definition = op({ direction: "guest-to-provider" });
  const link = pair({ guestOps: [definition], providerOps: [definition], guestHooks: g.hooks });
  const stream = await connect(link);
  expect(link.provider.inspect()!.sender.admit({ type: RELAY_TYPE.REQUEST, stream, correlation: 100,
    metadata: { op: definition.name, args: { n: 1 } } }).ok).toBe(true);
  link.provider.flush(); await link.settle();
  expect(g.requests).toHaveLength(0);
  const response = link.frames("guest").find(frame => frame.stream === stream && frame.type === RELAY_TYPE.RESPONSE)!;
  expect(response.metadata.error).toMatchObject({ code: RELAY_ERROR.UNSUPPORTED });
});

test("private invalid nonterminal resets the stream and releases the pending slot", async () => {
  const p = heldRequests(), link = pair({ providerHooks: p.hooks });
  const stream = await connect(link), call = link.guest.request(stream, op().name, { n: 1 }); await link.settle();
  expect(link.provider.inspect()!.sender.admit({ type: RELAY_TYPE.RESPONSE, stream, correlation: call.correlation,
    metadata: { op: op().name, status: RELAY_STATUS.OK, final: false, value: { ack: 1 } } }).ok).toBe(true);
  link.provider.flush(); await link.settle();
  expect(await call).toEqual({ ...failure(RELAY_ERROR.RESYNC_REQUIRED), effect: RELAY_EFFECT.UNKNOWN });
  expect(link.guest.inspect()!.outgoingRequests.active).toBe(0);
  expect(link.guest.inspect()!.receiver.occupancy()).toEqual({ frames: 0, bytes: 0 });
  expect(link.guest.protocolErrors).toBe(1);
});

test("private CANCELLED requires a valid effect and an error code from the closed set", async () => {
  const p = heldRequests(), link = pair({ providerHooks: p.hooks });
  const stream = await connect(link), call = link.guest.request(stream, op().name, { n: 1 }); await link.settle();
  expect(link.provider.replyError(p.requests[0], RELAY_ERROR.CANCELLED)).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(link.provider.replyError(p.requests[0], "PRODUCT_ERROR")).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(link.provider.replyError(p.requests[0], RELAY_ERROR.CANCELLED, "cancelled", "maybe")).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  link.provider.replyError(p.requests[0], RELAY_ERROR.CANCELLED, "cancelled", RELAY_EFFECT.UNKNOWN); await link.settle();
  expect(await call).toEqual({ ok: false, error: { code: RELAY_ERROR.CANCELLED, message: "cancelled" }, effect: RELAY_EFFECT.UNKNOWN });
});

test("private responder demand holds at most accepted plus one terminal while its window is full", async () => {
  const g = heldRequests(), p = heldRequests(), link = pair({ guestHooks: g.hooks, providerHooks: p.hooks });
  const stream = await connect(link, PROFILE, { ...RX, windowFrames: 1, windowBytes: 4096 });
  link.hold.provider = true;
  const reverse = link.provider.request(stream, op().name, { n: 2 });
  const call = link.guest.request(stream, op().name, { n: 1 }); await link.settle();
  const request = p.requests[0];
  expect(link.provider.respond({ type: RELAY_TYPE.RESPONSE, stream, correlation: call.correlation,
    metadata: { op: request.op, status: RELAY_STATUS.ACCEPTED, final: false } }).ok).toBe(true);
  expect(link.provider.replyValue(request, { ack: 1 }).ok).toBe(true);
  for (let i = 0; i < 20; i++) expect(link.provider.replyValue(request, { ack: i }).ok).toBe(false);
  expect(link.provider.inspect()!.demand.get(stream)).toHaveLength(2);
  expect(link.provider.inspect()!.incomingRequests.active).toBe(1);
  link.hold.provider = false; link.deliverHeld(); await link.settle();
  link.guest.replyValue(g.requests[0], { ack: 2 }); await link.settle();
  expect((await call).ok).toBe(true); expect((await reverse).ok).toBe(true);
  expect(link.provider.inspect()!.demand.size).toBe(0);
});

test("private local tuples and enums validate args and value without opening the envelope", async () => {
  const definition = op({ args: closed({ input: { type: "array", minItems: 2, maxItems: 2, additionalItems: false,
    items: [{ type: "string", enum: ["left", "right"] }, { type: "integer", minimum: 1, maximum: 3 }] } }) });
  const p = heldRequests(), link = pair({ guestOps: [definition], providerOps: [definition], providerHooks: p.hooks });
  const stream = await connect(link);
  for (const input of [["up", 1], ["left"], ["left", 4], ["left", 2, 3]]) {
    expect(await link.guest.request(stream, definition.name, { input })).toEqual(failure(RELAY_ERROR.INVALID));
  }
  const call = link.guest.request(stream, definition.name, { input: ["left", 2] }); await link.settle();
  link.provider.replyValue(p.requests[0], { ack: 2 }); await link.settle(); expect((await call).ok).toBe(true);
});

test("private handler exceptions return OUTCOME_UNKNOWN once after an admitted command", async () => {
  const link = pair({ providerHooks: { onRequest() { throw new Error("product failure"); } } });
  const stream = await connect(link), call = link.guest.request(stream, op().name, { n: 1 }); await link.settle();
  expect(await call).toMatchObject({ ok: false, error: { code: RELAY_ERROR.OUTCOME_UNKNOWN }, effect: RELAY_EFFECT.UNKNOWN });
  expect(link.guest.inspect()!.outgoingRequests.active + link.provider.inspect()!.incomingRequests.active).toBe(0);
});

test("private automatic errors that exceed the op budget reset instead of stranding the caller", async () => {
  for (const handler of [undefined, () => { throw new Error("product failure"); }]) {
    const definition = op({ maxWireBytes: 180, recovery: "epoch" });
    const link = pair({ guestOps: [definition], providerOps: [definition], providerHooks: { onRequest: handler } });
    const stream = await connect(link), call = link.guest.request(stream, definition.name, { n: 1 },
      { opEpoch: "0000000000000001", opId: "a".repeat(32) });
    const results: unknown[] = [];
    void call.then(result => results.push(result));
    await link.settle();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, error: { code: RELAY_ERROR.OUTCOME_UNKNOWN }, effect: RELAY_EFFECT.UNKNOWN });
    expect(link.guest.inspect()!.outgoingRequests.active + link.provider.inspect()!.incomingRequests.active).toBe(0);
    expect(link.guest.session.streamInfo(stream)).toBeUndefined();
    expect(link.frames("provider").filter(frame => frame.type === RELAY_TYPE.RESPONSE && frame.stream === stream)).toHaveLength(0);
  }
});

test("private ops negotiate and run in both directions through serveRelayTcp", async () => {
  let connection: RelayProviderConnection | undefined;
  const server = await serveRelayTcp({ local: capabilities(), privateOps: [op()],
    authenticate: () => ({ id: "device", grants: ["example"] }),
    onConnection: value => { connection = value; },
    hooks: { onRequest(request) { connection!.endpoint.replyValue(request, { ack: 1 }); return true; } },
  });
  const socket = connectSocket(server.port, "127.0.0.1");
  let guest: RelayEndpoint | undefined;
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const channel = relaySocketChannel(socket, { id: "companion", grants: ["example"] });
    guest = new RelayEndpoint({ role: "guest", local: capabilities(), privateOps: [op()],
      transport: { peer: channel.peer, trySend: bytes => channel.send(bytes) ? "accepted" : "busy" },
      hooks: { onRequest(request) { guest!.replyValue(request, { ack: 2 }); return true; } },
    });
    attachRelayChannel(guest, channel);
    expect(guest.hello().ok).toBe(true); await guest.whenReady();
    const opened = await guest.open({ app: "example", namespace: "example/commands", profile: PROFILE });
    expect(await guest.request(opened.stream, op().name, { n: 1 })).toEqual({ ok: true, value: { ack: 1 } });
    expect(await connection!.endpoint.request(opened.stream, op().name, { n: 2 })).toEqual({ ok: true, value: { ack: 2 } });
  } finally {
    guest?.close(); connection?.close(); socket.destroy(); await server.close();
  }
});

test("private inbound wire budget counts whitespace that metadata decoding removes", async () => {
  const p = heldRequests(), definition = op({ maxWireBytes: 256 });
  const link = pair({ guestOps: [definition], providerOps: [definition], providerHooks: p.hooks });
  const stream = await connect(link); link.hold.guest = true;
  const call = link.guest.request(stream, definition.name, { n: 1 }); await link.settle();
  const original = link.held.shift()!.bytes;
  const header = new DataView(original.buffer, original.byteOffset, original.byteLength);
  const metaLength = header.getUint32(36, true);
  const padding = 200;
  const padded = new Uint8Array(original.length + padding);
  padded.set(original.subarray(0, 48)); padded.fill(0x20, 48, 48 + padding); padded.set(original.subarray(48), 48 + padding);
  const view = new DataView(padded.buffer); view.setUint32(0, padded.length - 4, true); view.setUint32(36, metaLength + padding, true);
  expect(decode(padded).metadata.args).toEqual({ n: 1 });
  // This forged record has a different byte-credit charge than the sender's original.
  // Capture the receiver's refusal without feeding its larger credit back to that sender.
  link.hold.guest = false; link.hold.provider = true; link.provider.handleRecord(padded); await link.settle();
  expect(p.requests).toHaveLength(0);
  expect(link.frames("provider").find(frame => frame.stream === stream && frame.type === RELAY_TYPE.RESPONSE)!.metadata.error)
    .toMatchObject({ code: RELAY_ERROR.TOO_LARGE });
  link.guest.close(); expect((await call).ok).toBe(false);
});

test("private durable capability disappears when its receipt query is outside the intersection", async () => {
  const query = op({ name: `x.${PROFILE.name}.status` });
  const write = op({ name: `x.${PROFILE.name}.write`, recovery: "durable", recoveryOp: query.name,
    value: closed({ receipt: { type: "string" } }) });
  const link = pair({ guestOps: [query, write], providerOps: [op()] });
  const stream = await connect(link);
  expect(await link.guest.request(stream, write.name, { n: 1 }, { opId: "a".repeat(32), opEpoch: "1".repeat(16) }))
    .toEqual(failure(RELAY_ERROR.UNSUPPORTED));
});

test("private durable disconnect is OUTCOME_UNKNOWN and reconnect sends no mutation", async () => {
  const query = op({ name: `x.${PROFILE.name}.status` });
  const write = op({ name: `x.${PROFILE.name}.write`, recovery: "durable", recoveryOp: query.name,
    value: closed({ receipt: { type: "string" } }) });
  const p = heldRequests(), link = pair({ guestOps: [query, write], providerOps: [query, write], providerHooks: p.hooks });
  const stream = await connect(link);
  const call = link.guest.request(stream, write.name, { n: 1 }, { opId: "a".repeat(32), opEpoch: "0000000000000001" });
  await link.settle(); link.guest.handleDisconnect("unknown write"); link.provider.handleDisconnect("unknown write");
  expect(await call).toEqual({ ...failure(RELAY_ERROR.OUTCOME_UNKNOWN), effect: RELAY_EFFECT.UNKNOWN });
  await connect(link);
  expect(link.frames("guest").filter(frame => frame.metadata.op === write.name)).toHaveLength(1);
});
