import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connect as connectSocket } from "node:net";
import {
  RELAY_EFFECT, RELAY_ERROR, RELAY_OP, RELAY_STATUS, RELAY_TYPE,
  type RelayOperationEpochArgs, type RelayOperationStatusArgs, type RelayRxLimits,
} from "../contracts/spec/relay.ts";
import {
  RelayEndpoint, RelayMemoryOperationStore, RelayOperationAuthority, RelayOperationStoreError,
  type RelayEndpointHooks, type RelayIncomingRequest, type RelayPrivateCall, type RelayPrivateOp,
} from "../framework/src/relay/endpoint.ts";
import { decodeFrame, encodeFrame, type RelayDecodedFrame } from "../framework/src/relay/frame.ts";
import { prepareOperation } from "../framework/src/relay/operation.ts";
import { preparePrivateOp } from "../framework/src/relay/private-op.ts";
import { SqliteOperationStore } from "./helpers/relay-operation-store.ts";
import { attachRelayChannel, relaySocketChannel, serveRelayTcp } from "../tools/relay-wire.ts";

const PROFILE = { name: "org.example.operations", version: 1 };
const NS = "example/writes", AUTHORITY = "authority-test", EPOCH = "0000000000000001";
const RX: RelayRxLimits = { maxWireBytes: 4096, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 32768,
  maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 2, maxScratchBytes: 262144 };
const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object", additionalProperties: false, properties, required });
const definition = (patch: Partial<RelayPrivateOp> = {}): RelayPrivateOp => ({
  profile: PROFILE, name: `x.${PROFILE.name}.write`, direction: "guest-to-provider", recovery: "durable",
  recoveryOp: RELAY_OP.OPERATION_STATUS, maxWireBytes: 1024, maxObjectBytes: 512,
  args: closed({ n: { type: "integer", minimum: 0 }, label: { type: "string", maxBytes: 64 } }, ["n"]),
  value: closed({ receipt: { type: "string", minLength: 1, maxBytes: 128 } }), ...patch,
});
const ids = (n = 1, opEpoch = EPOCH) => ({ opEpoch, opId: n.toString(16).padStart(32, "0") });
const statusArgs = (n = 1, opEpoch = EPOCH) => ({ authority: AUTHORITY, ns: NS, ...ids(n, opEpoch) });
const receipt = (n = 1) => ({ receipt: `receipt-${n}` });
const decode = (bytes: Uint8Array): RelayDecodedFrame => {
  const decoded = decodeFrame(bytes); if (!decoded.ok) throw new Error(decoded.code); return decoded.frame;
};
const stores: SqliteOperationStore[] = [], cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); for (const store of stores.splice(0)) store.db.close(); });
const store = (path?: string) => { const value = new SqliteOperationStore(path); stores.push(value); return value; };
const authority = (storage = store(), options: { maxOperations?: number; maxRecordBytes?: number } = {}) =>
  new RelayOperationAuthority({ id: AUTHORITY, store: storage, ...options });

type Role = "guest" | "provider";
function pair(options: {
  operations?: RelayOperationAuthority; writer?: string; sync?: boolean; hooks?: RelayEndpointHooks;
  guestOperations?: RelayOperationAuthority;
  definitions?: RelayPrivateOp[]; guestDefinitions?: RelayPrivateOp[];
  transform?: (from: Role, frame: RelayDecodedFrame) => RelayDecodedFrame;
} = {}) {
  const definitions = options.definitions ?? [definition()];
  const requests: RelayIncomingRequest[] = [];
  const wire: Array<{ from: Role; bytes: Uint8Array }> = [], held: Array<{ from: Role; bytes: Uint8Array }> = [];
  const hold = { guest: false, provider: false }, busy = { guest: false, provider: false };
  const endpoints = {} as Record<Role, RelayEndpoint>;
  const route = (from: Role, bytes: Uint8Array) => {
    if (busy[from]) return "busy" as const;
    let record: Uint8Array = bytes.slice();
    if (options.transform) {
      const encoded = encodeFrame(options.transform(from, decode(record)));
      if (!encoded.ok) throw new Error(encoded.code); record = encoded.bytes;
    }
    wire.push({ from, bytes: record });
    if (hold[from]) held.push({ from, bytes: record });
    else if (options.sync) endpoints[from === "guest" ? "provider" : "guest"].handleRecord(record);
    else queueMicrotask(() => endpoints[from === "guest" ? "provider" : "guest"].handleRecord(record));
    return "accepted" as const;
  };
  const operations = options.operations ?? authority();
  for (const role of ["guest", "provider"] as const) {
    let seed = role === "guest" ? 11 : 31;
    endpoints[role] = new RelayEndpoint({ role,
      local: { app: "example", versions: [[1, 0]], profiles: [PROFILE], codecs: [0], kinds: [6], rxLimits: RX },
      privateOps: role === "guest" ? options.guestDefinitions ?? definitions : definitions,
      operations: role === "provider" ? operations : options.guestOperations,
      transport: { peer: { id: role === "guest" ? AUTHORITY : options.writer ?? "writer-one", grants: ["example"] }, trySend: bytes => route(role, bytes) },
      randomBytes: n => new Uint8Array(n).fill(seed++),
      scheduler: { now: () => 0, setTimeout: () => 1, clearTimeout: () => {} },
      hooks: role === "provider" ? { onRequest: request => { requests.push(request); return true; }, ...options.hooks } : undefined,
    });
  }
  cleanups.push(() => { endpoints.guest.close(); endpoints.provider.close(); });
  const settle = async () => { for (let i = 0; i < 32; i++) { await Promise.resolve(); endpoints.guest.flush(); endpoints.provider.flush(); } };
  const connect = async () => {
    expect(endpoints.guest.hello()).toEqual({ ok: true }); await settle(); await endpoints.guest.whenReady();
    const opened = endpoints.guest.open({ app: "example", namespace: NS, profile: PROFILE }); await settle(); return (await opened).stream;
  };
  const result = async <T>(call: RelayPrivateCall<T>) => { await settle(); return await call; };
  const frames = (from?: Role) => wire.filter(record => !from || record.from === from).map(record => decode(record.bytes));
  const drop = () => { endpoints.guest.handleDisconnect("test disconnect"); endpoints.provider.handleDisconnect("test disconnect"); held.length = 0; };
  const deliverHeld = () => { for (const item of held.splice(0)) endpoints[item.from === "guest" ? "provider" : "guest"].handleRecord(item.bytes); };
  return { ...endpoints, requests, wire, held, hold, busy, settle, connect, result, frames, drop, deliverHeld, operations };
}

test("operation.epoch compare-and-advance is idempotent across sessions and storage reopen", async () => {
  const parent = join(process.cwd(), ".pocket-build/validation/task-1289/tests");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "operation-"));
  cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
  const storage = store(join(dir, "receipts.sqlite"));
  const link = pair({ operations: authority(storage) });
  let stream = await link.connect();
  expect(await link.result(link.guest.operationEpoch(stream, { ns: NS, action: "query" }))).toEqual({ ok: true, value: { opEpoch: EPOCH } });
  const advance = { ns: NS, action: "advance" as const, expectedEpoch: EPOCH };
  const first = link.guest.operationEpoch(stream, advance), duplicate = link.guest.operationEpoch(stream, advance);
  const next = { ok: true as const, value: { opEpoch: "0000000000000002" } };
  expect(await link.result(first)).toEqual(next); expect(await link.result(duplicate)).toEqual(next);
  const session = link.guest.inspect()!.session; link.drop(); stream = await link.connect();
  expect(link.guest.inspect()!.session).not.toBe(session);
  expect(await link.result(link.guest.operationEpoch(stream, advance))).toEqual(next);
  const reopened = pair({ operations: authority(store(join(dir, "receipts.sqlite"))) });
  const secondStream = await reopened.connect();
  expect(await reopened.result(reopened.guest.operationEpoch(secondStream, advance))).toEqual(next);
  expect(await reopened.result(reopened.guest.operationEpoch(secondStream, { ...advance, expectedEpoch: "0000000000000002" })))
    .toEqual({ ok: true, value: { opEpoch: "0000000000000003" } });
});

for (const sync of [false, true]) test(`same opId commits one side effect and replays one receipt (${sync ? "sync" : "queued"})`, async () => {
  const storage = store(), link = pair({ operations: authority(storage), sync });
  const stream = await link.connect();
  const first = link.guest.request(stream, definition().name, { n: 1, label: "same" }, ids());
  const duplicate = link.guest.request(stream, definition().name, { label: "same", n: 1 }, ids());
  await link.settle(); expect(link.requests).toHaveLength(1);
  expect(await link.result(link.guest.operationStatus(stream, statusArgs()))).toEqual({ ok: true, value: { state: "pending" } });
  expect(link.requests[0].operation!.commit(receipt(), () => storage.effect("one"))).toEqual({ ok: true });
  const expected = { ok: true as const, value: receipt(), effect: RELAY_EFFECT.COMMITTED };
  expect(await link.result(first)).toEqual(expected); expect(await link.result(duplicate)).toEqual(expected);
  expect(await link.result(link.guest.request(stream, definition().name, { n: 1, label: "same" }, ids()))).toEqual(expected);
  expect(link.requests[0].operation!.commit(receipt(), () => storage.effect("one"))).toEqual({ ok: true });
  expect(storage.hits("one")).toBe(1); expect(link.requests).toHaveLength(1);
  expect(await link.result(link.guest.request(stream, definition().name, { n: 2 }, ids()))).toMatchObject({ ok: false, error: { code: RELAY_ERROR.INVALID }, effect: RELAY_EFFECT.NONE });
  expect(await link.result(link.guest.operationStatus(stream, statusArgs()))).toEqual({ ok: true, value: { state: "committed", ...receipt() } });
  expect(link.guest.inspect()!.outgoingRequests.active).toBe(0); expect(link.provider.inspect()!.incomingRequests.active).toBe(0);
  expect(link.guest.protocolErrors + link.provider.protocolErrors).toBe(0);
});

for (const state of ["committed", "rejected"] as const) test(`unknown -> operation.status -> ${state} never resends or reexecutes the write`, async () => {
  const storage = store(), operations = authority(storage);
  const link = pair({ operations }); let stream = await link.connect();
  const call = link.guest.request(stream, definition().name, { n: 1 }, ids()); await link.settle();
  const handle = link.requests[0].operation!;
  link.provider.replyError(link.requests[0], RELAY_ERROR.OUTCOME_UNKNOWN, "journal recovery required", RELAY_EFFECT.UNKNOWN);
  expect(await link.result(call)).toMatchObject({ ok: false, error: { code: RELAY_ERROR.OUTCOME_UNKNOWN }, effect: RELAY_EFFECT.UNKNOWN });
  link.drop(); stream = await link.connect();
  expect(link.frames("guest").filter(frame => frame.metadata.op === definition().name)).toHaveLength(1);
  expect(await link.result(link.guest.operationStatus(stream, statusArgs()))).toEqual({ ok: true, value: { state: "unknown" } });
  expect(await link.result(link.guest.request(stream, definition().name, { n: 1 }, ids()))).toMatchObject({ ok: false, effect: RELAY_EFFECT.UNKNOWN });
  expect(handle.commit(receipt(), () => storage.effect("must-not-reexecute"))).toEqual({ ok: false, code: RELAY_ERROR.OUTCOME_UNKNOWN });
  expect(storage.hits("must-not-reexecute")).toBe(0); expect(link.requests).toHaveLength(1);
  expect(handle.reconcile(state === "committed" ? { state, value: receipt() } : { state, code: RELAY_ERROR.STALE_BASE })).toEqual({ ok: true });
  expect(await link.result(link.guest.operationStatus(stream, statusArgs())))
    .toEqual({ ok: true, value: { state, ...(state === "committed" ? receipt() : {}) } });
});

test("committed receipt survives lost response and replacement endpoints", async () => {
  const storage = store(), link = pair({ operations: authority(storage) }); const stream = await link.connect();
  const call = link.guest.request(stream, definition().name, { n: 1 }, ids()); await link.settle();
  link.hold.provider = true;
  expect(link.requests[0].operation!.commit(receipt(), () => storage.effect("write"))).toEqual({ ok: true });
  link.drop(); expect(await call).toMatchObject({ ok: false, effect: RELAY_EFFECT.UNKNOWN });
  const replacement = pair({ operations: authority(storage) }), newStream = await replacement.connect();
  expect(await replacement.result(replacement.guest.operationStatus(newStream, statusArgs())))
    .toEqual({ ok: true, value: { state: "committed", ...receipt() } });
  expect(await replacement.result(replacement.guest.request(newStream, definition().name, { n: 1 }, ids())))
    .toEqual({ ok: true, value: receipt(), effect: RELAY_EFFECT.COMMITTED });
  expect(replacement.requests).toHaveLength(0); expect(storage.hits("write")).toBe(1);
});

test("CANCEL before commit returns CANCELLED/none and fences a late commit", async () => {
  const storage = store(), link = pair({ operations: authority(storage) }), stream = await link.connect();
  const first = link.guest.request(stream, definition().name, { n: 1 }, ids());
  const duplicate = link.guest.request(stream, definition().name, { n: 1 }, ids()); await link.settle();
  first.cancel(); first.cancel(); await link.settle();
  expect(await first).toMatchObject({ ok: false, error: { code: RELAY_ERROR.CANCELLED }, effect: RELAY_EFFECT.NONE });
  expect(await duplicate).toEqual(await first);
  expect(link.requests[0].operation!.commit(receipt(), () => storage.effect("cancelled")))
    .toEqual({ ok: false, code: RELAY_ERROR.CANCELLED });
  expect(storage.hits("cancelled")).toBe(0);
  expect(await link.result(link.guest.operationStatus(stream, statusArgs()))).toEqual({ ok: true, value: { state: "rejected" } });
  expect(link.frames("provider").filter(frame => frame.stream === stream && frame.metadata.op === definition().name && frame.metadata.final)).toHaveLength(2);
});

test("CANCEL after commit preserves committed while the success waits in the outbox", async () => {
  const storage = store(), link = pair({ operations: authority(storage) }), stream = await link.connect();
  const call = link.guest.request(stream, definition().name, { n: 1 }, ids()); await link.settle();
  link.busy.provider = true;
  expect(link.requests[0].operation!.commit(receipt(), () => storage.effect("committed"))).toEqual({ ok: true });
  call.cancel(); await link.settle();
  link.provider.replyError(link.requests[0], RELAY_ERROR.CANCELLED, "late", RELAY_EFFECT.NONE);
  link.busy.provider = false; await link.settle();
  expect(await call).toEqual({ ok: true, value: receipt(), effect: RELAY_EFFECT.COMMITTED });
  expect(storage.hits("committed")).toBe(1);
  const terminals = link.frames("provider").filter(frame => frame.metadata.op === definition().name && frame.metadata.final);
  expect(terminals).toHaveLength(1); expect(terminals[0].metadata.effect).toBe(RELAY_EFFECT.COMMITTED);
});

test("CANCEL overtaking REQUEST prevents the handler and leaves a rejection tombstone", async () => {
  const link = pair(), stream = await link.connect(); link.busy.guest = true;
  const blocking = link.guest.request(stream, definition().name, { n: 2 }, ids(2));
  const call = link.guest.request(stream, definition().name, { n: 1 }, ids()); call.cancel();
  link.busy.guest = false; await link.settle();
  expect(await call).toMatchObject({ ok: false, error: { code: RELAY_ERROR.CANCELLED }, effect: RELAY_EFFECT.NONE });
  expect(link.requests.map(request => request.correlation)).toEqual([blocking.correlation]);
  expect(await link.result(link.guest.request(stream, definition().name, { n: 1 }, ids())))
    .toMatchObject({ ok: false, error: { code: RELAY_ERROR.CANCELLED }, effect: RELAY_EFFECT.NONE });
  expect(link.requests).toHaveLength(1); blocking.cancel(); await link.result(blocking);
});

test("epoch recovery deduplicates same epoch/id and retires old ids", async () => {
  const storage = store(), input = definition({ recovery: "epoch", recoveryOp: undefined });
  const link = pair({ definitions: [input], operations: authority(storage) }), stream = await link.connect();
  const first = link.guest.request(stream, input.name, { n: 1 }, ids()); await link.settle();
  expect(link.requests[0].operation!.commit(receipt(), () => storage.effect("input"))).toEqual({ ok: true });
  expect((await link.result(first)).ok).toBe(true);
  expect((await link.result(link.guest.request(stream, input.name, { n: 1 }, ids()))).ok).toBe(true);
  expect(storage.hits("input")).toBe(1); expect(link.requests).toHaveLength(1);
  const advanced = await link.result(link.guest.operationEpoch(stream, { ns: NS, action: "advance", expectedEpoch: EPOCH }));
  expect(advanced).toEqual({ ok: true, value: { opEpoch: "0000000000000002" } });
  expect(await link.result(link.guest.request(stream, input.name, { n: 1 }, ids())))
    .toMatchObject({ ok: false, error: { code: RELAY_ERROR.STALE_BASE }, effect: RELAY_EFFECT.NONE });
  const fresh = link.guest.request(stream, input.name, { n: 1 }, ids(1, "0000000000000002")); await link.settle();
  expect(link.requests).toHaveLength(2); link.requests[1].operation!.commit(receipt(2), () => storage.effect("input"));
  expect((await link.result(fresh)).ok).toBe(true); expect(storage.hits("input")).toBe(2);
});

test("receipt capacity returns BUSY; pending and unknown block advance until settlement", async () => {
  const link = pair({ operations: authority(store(), { maxOperations: 1 }) }), stream = await link.connect();
  const call = link.guest.request(stream, definition().name, { n: 1 }, ids()); await link.settle();
  const advance = () => link.result(link.guest.operationEpoch(stream, { ns: NS, action: "advance", expectedEpoch: EPOCH }));
  expect(await advance()).toMatchObject({ ok: false, error: { code: RELAY_ERROR.BUSY } });
  expect(await link.result(link.guest.request(stream, definition().name, { n: 2 }, ids(2))))
    .toMatchObject({ ok: false, error: { code: RELAY_ERROR.BUSY }, effect: RELAY_EFFECT.NONE });
  link.provider.replyError(link.requests[0], RELAY_ERROR.OUTCOME_UNKNOWN, "pending journal", RELAY_EFFECT.UNKNOWN);
  expect((await link.result(call)).ok).toBe(false); expect(await advance()).toMatchObject({ ok: false, error: { code: RELAY_ERROR.BUSY } });
  link.requests[0].operation!.reconcile({ state: "rejected", code: RELAY_ERROR.STALE_BASE });
  expect(await advance()).toEqual({ ok: true, value: { opEpoch: "0000000000000002" } });
  expect(await link.result(link.guest.operationStatus(stream, statusArgs()))).toEqual({ ok: true, value: { state: "unknown" } });
  expect(await link.result(link.guest.request(stream, definition().name, { n: 2 }, ids(2))))
    .toMatchObject({ ok: false, error: { code: RELAY_ERROR.STALE_BASE } });
});

test("operation scope binds authenticated writer, authority, namespace and profile", async () => {
  const operations = authority(), a = pair({ operations }), stream = await a.connect();
  const call = a.guest.request(stream, definition().name, { n: 1 }, ids()); await a.settle();
  a.requests[0].operation!.commit(receipt(), () => {}); await a.result(call);
  const b = pair({ operations, writer: "writer-two" }), other = await b.connect();
  expect(await b.result(b.guest.operationStatus(other, statusArgs()))).toEqual({ ok: true, value: { state: "unknown" } });
  expect(await a.result(a.guest.operationStatus(stream, { ...statusArgs(), authority: "wrong" })))
    .toMatchObject({ ok: false, error: { code: RELAY_ERROR.UNAUTHORIZED } });
  expect(await a.guest.operationStatus(stream, { ...statusArgs(), ns: "example/other" }))
    .toMatchObject({ ok: false, error: { code: RELAY_ERROR.UNAUTHORIZED } });
  expect(operations.status("writer-one", statusArgs(), { ...PROFILE, version: 2 })).toEqual({ ok: true, value: { state: "unknown" } });
  const second = b.guest.request(other, definition().name, { n: 2 }, ids()); await b.settle();
  expect(b.requests).toHaveLength(1); second.cancel(); await b.result(second);
});

test("durable registration fails without durable storage; public recovery needs no private query op", async () => {
  expect(() => pair({ operations: new RelayOperationAuthority({ id: AUTHORITY, store: new RelayMemoryOperationStore() }) })).toThrow("durable operation store");
  const link = pair(), stream = await link.connect();
  expect(link.guest.negotiation!.opExt).toHaveLength(1);
  expect((await link.result(link.guest.operationEpoch(stream, { ns: NS, action: "query" }))).ok).toBe(true);
  const unsupported = pair({ guestDefinitions: [] }), noOps = await unsupported.connect();
  expect(await unsupported.guest.operationEpoch(noOps, { ns: NS, action: "query" }))
    .toMatchObject({ ok: false, error: { code: RELAY_ERROR.UNSUPPORTED } });
  expect(await link.guest.operationEpoch(0, { ns: NS, action: "query" }))
    .toMatchObject({ ok: false, error: { code: RELAY_ERROR.UNSUPPORTED } });
});

test("operation schemas reject malformed ids, unknown fields, bad actions and widened receipts", async () => {
  const link = pair(), stream = await link.connect(), before = link.wire.length;
  const epochInvalid = [{ ns: NS, action: "advance" }, { ns: NS, action: "reset" },
    { ns: NS, action: "query", expectedEpoch: "1" }, { ns: NS, action: "query", extra: true }];
  for (const args of epochInvalid) expect(await link.guest.operationEpoch(stream, args as RelayOperationEpochArgs))
    .toMatchObject({ ok: false, error: { code: RELAY_ERROR.INVALID } });
  for (const patch of [{ opId: "A".repeat(32) }, { opEpoch: 1 }, { ns: "" }, { authority: "" }, { extra: 1 }]) {
    expect(await link.guest.operationStatus(stream, { ...statusArgs(), ...patch } as RelayOperationStatusArgs))
      .toMatchObject({ ok: false, error: { code: RELAY_ERROR.INVALID } });
  }
  for (const recovery of ["durable", "epoch"] as const) {
    const op = definition({ recovery, recoveryOp: recovery === "durable" ? RELAY_OP.OPERATION_STATUS : undefined });
    for (const patch of [{}, { opEpoch: EPOCH }, { ...ids(), opId: "bad" }]) expect(preparePrivateOp(op,
      { type: RELAY_TYPE.REQUEST, stream, metadata: { op: op.name, args: { n: 1 }, ...patch } }, RX))
      .toEqual({ ok: false, code: RELAY_ERROR.INVALID });
    for (const meta of [
      { status: RELAY_STATUS.OK, value: receipt() },
      { status: RELAY_STATUS.OK, effect: RELAY_EFFECT.NONE, value: receipt() },
      { status: RELAY_STATUS.ERROR, error: { code: RELAY_ERROR.CANCELLED, message: "bad" }, effect: RELAY_EFFECT.COMMITTED },
    ]) expect(preparePrivateOp(op, { type: RELAY_TYPE.RESPONSE, stream, metadata: { op: op.name, final: true, ...meta } }, RX))
      .toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  }
  for (const value of [{ state: "done" }, { state: "committed", receipt: { arbitrary: true } }, { state: "unknown", receipt: "bad" }, { state: "pending", extra: true }]) {
    expect(prepareOperation(RELAY_OP.OPERATION_STATUS, { type: RELAY_TYPE.RESPONSE, stream, metadata: {
      op: RELAY_OP.OPERATION_STATUS, status: RELAY_STATUS.OK, final: true, value,
    } }, RX, [definition()])).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  }
  expect(link.wire).toHaveLength(before); expect(link.guest.inspect()!.outgoingRequests.active).toBe(0);
});

test("incoming public schema and namespace checks run before epoch advancement", async () => {
  for (const args of [{ ns: NS, action: "advance" }, { ns: NS, action: "advance", expectedEpoch: EPOCH, extra: true },
    { ns: "example/other", action: "advance", expectedEpoch: EPOCH }]) {
    const link = pair({ transform(from, frame) {
      if (from === "guest" && frame.metadata.op === RELAY_OP.OPERATION_EPOCH) frame.metadata.args = args; return frame;
    } });
    const stream = await link.connect();
    expect(await link.result(link.guest.operationEpoch(stream, { ns: NS, action: "advance", expectedEpoch: EPOCH })))
      .toMatchObject({ ok: false });
    expect(link.operations.epoch("writer-one", { ns: NS, action: "query" })).toEqual({ ok: true, value: { opEpoch: EPOCH } });
  }
});

test("transaction rollback leaves no effect and invalid result never executes the callback", async () => {
  const storage = store(), link = pair({ operations: authority(storage) }), stream = await link.connect();
  const call = link.guest.request(stream, definition().name, { n: 1 }, ids()); await link.settle();
  const operation = link.requests[0].operation!;
  expect(operation.reconcile({ state: "committed", value: receipt() })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(link.provider.replyValue(link.requests[0], receipt())).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(operation.commit({ receipt: 1 }, () => storage.effect("invalid"))).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(operation.commit(receipt(), () => { storage.effect("rolled-back"); throw new Error("crash"); }))
    .toEqual({ ok: false, code: RELAY_ERROR.OUTCOME_UNKNOWN });
  expect(storage.hits("invalid") + storage.hits("rolled-back")).toBe(0);
  expect(await link.result(link.guest.operationStatus(stream, statusArgs()))).toEqual({ ok: true, value: { state: "unknown" } });
  expect(operation.commit(receipt(), () => storage.effect("must-not-retry"))).toEqual({ ok: false, code: RELAY_ERROR.OUTCOME_UNKNOWN });
  expect(storage.hits("must-not-retry")).toBe(0);
  call.cancel(); await link.result(call);
});

test("a second connection observing pending work cannot cancel it by disconnecting", async () => {
  const storage = store(), operations = authority(storage);
  const owner = pair({ operations }), observer = pair({ operations });
  const a = await owner.connect(), b = await observer.connect();
  const original = owner.guest.request(a, definition().name, { n: 1 }, ids()); await owner.settle();
  const duplicate = observer.guest.request(b, definition().name, { n: 1 }, ids()); await observer.settle();
  expect(owner.requests).toHaveLength(1); expect(observer.requests).toHaveLength(0);
  observer.drop(); expect(await duplicate).toMatchObject({ ok: false, effect: RELAY_EFFECT.UNKNOWN });
  expect(owner.requests[0].operation!.commit(receipt(), () => storage.effect("owner"))).toEqual({ ok: true });
  expect(await owner.result(original)).toEqual({ ok: true, value: receipt(), effect: RELAY_EFFECT.COMMITTED });
  expect(storage.hits("owner")).toBe(1);
});

test("pending work owned outside this endpoint completes its observer as unknown for status queries", async () => {
  const storage = store(), original = pair({ operations: authority(storage) });
  const stream = await original.connect();
  const call = original.guest.request(stream, definition().name, { n: 1 }, ids()); await original.settle();
  const other = pair({ operations: authority(storage) }), second = await other.connect();
  expect(await other.result(other.guest.request(second, definition().name, { n: 1 }, ids())))
    .toMatchObject({ ok: false, error: { code: RELAY_ERROR.OUTCOME_UNKNOWN }, effect: RELAY_EFFECT.UNKNOWN });
  expect(other.requests).toHaveLength(0);
  expect(await other.result(other.guest.operationStatus(second, statusArgs()))).toEqual({ ok: true, value: { state: "pending" } });
  original.requests[0].operation!.commit(receipt(), () => storage.effect("one")); await original.result(call);
  expect(await other.result(other.guest.operationStatus(second, statusArgs())))
    .toEqual({ ok: true, value: { state: "committed", ...receipt() } });
  expect(storage.hits("one")).toBe(1);
});

test("epoch callback throwing after input cannot become CANCELLED/none or run again", async () => {
  const input = definition({ recovery: "epoch", recoveryOp: undefined });
  const operations = new RelayOperationAuthority({ id: AUTHORITY, store: new RelayMemoryOperationStore() });
  const link = pair({ definitions: [input], operations }), stream = await link.connect();
  const queried = await link.result(link.guest.operationEpoch(stream, { ns: NS, action: "query" }));
  if (!queried.ok) throw new Error(queried.error.code);
  const epoch = queried.value.opEpoch; let writes = 0;
  const call = link.guest.request(stream, input.name, { n: 1 }, ids(1, epoch)); await link.settle();
  expect(link.requests[0].operation!.commit(receipt(), () => { writes++; throw new RelayOperationStoreError(RELAY_ERROR.INVALID); }))
    .toEqual({ ok: false, code: RELAY_ERROR.OUTCOME_UNKNOWN });
  call.cancel(); expect(await link.result(call)).toMatchObject({ ok: false, effect: RELAY_EFFECT.UNKNOWN });
  expect(link.requests[0].operation!.commit(receipt(), () => writes++)).toEqual({ ok: false, code: RELAY_ERROR.OUTCOME_UNKNOWN });
  expect(writes).toBe(1);
  expect(await link.result(link.guest.request(stream, input.name, { n: 1 }, ids(1, epoch))))
    .toMatchObject({ ok: false, effect: RELAY_EFFECT.UNKNOWN });
  expect(link.requests).toHaveLength(1);
});

test("new input authority assigns a fresh epoch and fences a request from lost memory", async () => {
  const input = definition({ recovery: "epoch", recoveryOp: undefined });
  const a = new RelayOperationAuthority({ id: AUTHORITY, store: new RelayMemoryOperationStore(1, "0000000000000010") });
  const b = new RelayOperationAuthority({ id: AUTHORITY, store: new RelayMemoryOperationStore(1, "0000000000000020") });
  expect(a.epoch("writer-one", { ns: NS, action: "query" })).toEqual({ ok: true, value: { opEpoch: "0000000000000010" } });
  const link = pair({ definitions: [input], operations: b }), stream = await link.connect();
  expect(await link.result(link.guest.operationEpoch(stream, { ns: NS, action: "query" })))
    .toEqual({ ok: true, value: { opEpoch: "0000000000000020" } });
  expect(await link.result(link.guest.request(stream, input.name, { n: 1 }, ids(1, "0000000000000010"))))
    .toMatchObject({ ok: false, error: { code: RELAY_ERROR.STALE_BASE }, effect: RELAY_EFFECT.NONE });
  expect(link.requests).toHaveLength(0);
  expect(b.epoch("writer-two", { ns: NS, action: "query" })).toEqual({ ok: false, code: RELAY_ERROR.BUSY });
});

test("epoch u64 exhaustion refuses advance and future epochs cannot execute", async () => {
  const storage = store();
  storage.transact({ authority: AUTHORITY, writer: "writer-one", ns: NS }, () =>
    ({ state: { opEpoch: "ffffffffffffffff", records: [] }, value: undefined }));
  const link = pair({ operations: authority(storage) }), stream = await link.connect();
  expect(await link.result(link.guest.operationEpoch(stream, { ns: NS, action: "advance", expectedEpoch: "ffffffffffffffff" })))
    .toMatchObject({ ok: false, error: { code: RELAY_ERROR.RESYNC_REQUIRED } });
  const fresh = pair(), freshStream = await fresh.connect();
  expect(await fresh.result(fresh.guest.request(freshStream, definition().name, { n: 1 }, ids(1, "0000000000000002"))))
    .toMatchObject({ ok: false, error: { code: RELAY_ERROR.STALE_BASE } });
  expect(fresh.requests).toHaveLength(0);
});

test("public query occupies normal request slots and full credit returns BUSY without transport", async () => {
  const link = pair(), stream = await link.connect(); link.hold.provider = true;
  const calls = Array.from({ length: 6 }, () => link.guest.operationEpoch(stream, { ns: NS, action: "query" }));
  await link.settle(); const count = link.wire.length;
  const refused = link.guest.operationEpoch(stream, { ns: NS, action: "query" });
  expect(refused.correlation).toBe(0); expect(await refused).toMatchObject({ ok: false, error: { code: RELAY_ERROR.BUSY } });
  expect(link.wire).toHaveLength(count);
  link.hold.provider = false; link.deliverHeld(); await link.settle();
  for (const call of calls) expect((await call).ok).toBe(true);
  expect(link.guest.inspect()!.outgoingRequests.active).toBe(0);
});

test("forged operation response fails closed and frees request slots", async () => {
  const link = pair({ transform(from, frame) {
    if (from === "provider" && frame.metadata.op === RELAY_OP.OPERATION_STATUS) {
      frame.metadata.value = { state: "committed", receipt: { unregistered: true } };
    }
    return frame;
  } }), stream = await link.connect();
  expect(await link.result(link.guest.operationStatus(stream, statusArgs()))).toMatchObject({ ok: false, error: { code: RELAY_ERROR.RESYNC_REQUIRED } });
  expect(link.guest.protocolErrors).toBe(1); expect(link.guest.inspect()!.outgoingRequests.active).toBe(0);
});

test("TCP reconnect queries the shared authority receipt without executing a second write", async () => {
  const storage = store(), operations = authority(storage);
  const local = { app: "example", versions: [[1, 0] as const], profiles: [PROFILE], codecs: [0], kinds: [6], rxLimits: RX };
  const server = await serveRelayTcp({ local, privateOps: [definition()], operations,
    authenticate: () => ({ id: "socket-writer", grants: ["example"] }),
    hooks: { onRequest(request) {
      request.operation!.commit(receipt(), () => storage.effect("socket")); return true;
    } },
  });
  const guests: RelayEndpoint[] = [];
  try {
    const connect = async () => {
      const socket = connectSocket({ port: server.port, host: "127.0.0.1" });
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      const channel = relaySocketChannel(socket, { id: AUTHORITY, grants: ["example"] });
      const guest = new RelayEndpoint({ role: "guest", local, privateOps: [definition()],
        transport: { peer: channel.peer, trySend: bytes => channel.closed ? "offline" : channel.send(bytes) ? "accepted" : "busy" },
      });
      guests.push(guest); attachRelayChannel(guest, channel); guest.hello(); await guest.whenReady();
      const opened = await guest.open({ app: "example", namespace: NS, profile: PROFILE });
      return { guest, stream: opened.stream, channel };
    };
    const first = await connect();
    expect(await first.guest.request(first.stream, definition().name, { n: 1 }, ids()))
      .toEqual({ ok: true, value: receipt(), effect: RELAY_EFFECT.COMMITTED });
    first.guest.close(); first.channel.destroy();
    const second = await connect();
    expect(await second.guest.operationStatus(second.stream, statusArgs()))
      .toEqual({ ok: true, value: { state: "committed", ...receipt() } });
    expect(await second.guest.request(second.stream, definition().name, { n: 1 }, ids()))
      .toEqual({ ok: true, value: receipt(), effect: RELAY_EFFECT.COMMITTED });
    expect(storage.hits("socket")).toBe(1); second.channel.destroy();
  } finally { for (const guest of guests) guest.close(); await server.close(); }
});

test("provider-originated mutations use guest receipts and the same public query direction", async () => {
  const input = definition({ direction: "bidirectional" }), guestStore = store();
  const link = pair({ definitions: [input], guestOperations: authority(guestStore) }), stream = await link.connect();
  const epoch = await link.result(link.provider.operationEpoch(stream, { ns: NS, action: "query" }));
  expect(epoch).toEqual({ ok: true, value: { opEpoch: EPOCH } });
  // With no guest handler, the authority records one rejected operation.
  expect(await link.result(link.provider.request(stream, input.name, { n: 1 }, ids())))
    .toMatchObject({ ok: false, error: { code: RELAY_ERROR.UNSUPPORTED }, effect: RELAY_EFFECT.NONE });
  expect(await link.result(link.provider.operationStatus(stream, statusArgs())))
    .toEqual({ ok: true, value: { state: "rejected" } });
  expect(link.provider.inspect()!.outgoingRequests.active).toBe(0);
});

test("record byte ceiling refuses a commit before applying its side effect", async () => {
  const storage = store(), link = pair({ operations: authority(storage, { maxRecordBytes: 256 }) }), stream = await link.connect();
  const call = link.guest.request(stream, definition().name, { n: 1 }, ids()); await link.settle();
  expect(link.requests).toHaveLength(1);
  expect(link.requests[0].operation!.commit(receipt(), () => storage.effect("oversize")))
    .toEqual({ ok: false, code: RELAY_ERROR.TOO_LARGE });
  expect(storage.hits("oversize")).toBe(0);
  link.drop(); expect(await call).toMatchObject({ ok: false, effect: RELAY_EFFECT.UNKNOWN });
});
