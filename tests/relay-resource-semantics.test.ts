import { expect, test } from "bun:test";
import {
  RELAY_CODEC, RELAY_DELIVERY, RELAY_ERROR, RELAY_KIND, RELAY_OP, RELAY_TYPE,
  type RelayProfileEntry, type RelayResourceRef, type RelayRxLimits,
} from "../contracts/spec/relay.ts";
import {
  RelayEndpoint, type RelayEndpointHooks, type RelayIncomingRequest, type RelayResourceForm,
} from "../framework/src/relay/endpoint.ts";
import { decodeFrame, encodeFrame, type RelayDecodedFrame } from "../framework/src/relay/frame.ts";
import type { RelayLocalCapabilities, RelayScheduler } from "../framework/src/relay/session.ts";
import type { ResourceResult } from "../framework/src/resource-cache.ts";

const PROFILE: RelayProfileEntry = { name: "term.grid", version: 1 };
const RX: RelayRxLimits = {
  maxWireBytes: 4096, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 32768,
  maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 4, maxScratchBytes: 524288,
};
const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object", additionalProperties: false, properties, required }) as const;
const FORM: RelayResourceForm = {
  profile: PROFILE, kind: RELAY_KIND.TERMINAL_CELLS, argsKey: "term",
  args: closed({ page: { type: "integer", minimum: 0 } }),
  value: closed({
    lines: { type: "array", items: { type: "string" } },
    cursor: { type: "integer", minimum: 0 },
  }),
  valuePresence: "required",
  onSubscribe: true,
};
const resourceRef = (revision = "s-42"): RelayResourceRef => ({
  kind: RELAY_KIND.TERMINAL_CELLS, ns: "term/session-1", key: "scrollback", revision,
  rendition: "grid-density1-v1",
});
const page = (cursor: number) => ({ lines: [`line-${cursor}`], cursor });
type Role = "guest" | "provider";

const scheduler = (): RelayScheduler => {
  let id = 0;
  return { now: () => 0, setTimeout: () => ++id, clearTimeout: () => {} };
};
const capabilities = (kinds: number[] = [RELAY_KIND.TERMINAL_CELLS, RELAY_KIND.FILE]): RelayLocalCapabilities => ({
  app: "example", versions: [[1, 0]], profiles: [PROFILE],
  codecs: [RELAY_CODEC.NONE, RELAY_CODEC.JSON],
  kinds, rxLimits: RX,
});

function pair(
  transform?: (from: Role, frame: RelayDecodedFrame) => RelayDecodedFrame,
  providerHooks?: RelayEndpointHooks,
  kinds: { guest?: number[]; provider?: number[] } = {},
) {
  const endpoints = {} as Record<Role, RelayEndpoint>;
  const route = (from: Role, bytes: Uint8Array<ArrayBufferLike>) => {
    let copy: Uint8Array<ArrayBufferLike> = bytes.slice();
    if (transform) {
      const decoded = decodeFrame(copy);
      if (!decoded.ok) throw new Error(decoded.code);
      const encoded = encodeFrame(transform(from, decoded.frame));
      if (!encoded.ok) throw new Error(encoded.code);
      copy = encoded.bytes;
    }
    endpoints[from === "guest" ? "provider" : "guest"].handleRecord(copy);
    return "accepted" as const;
  };
  for (const role of ["guest", "provider"] as const) {
    endpoints[role] = new RelayEndpoint({
      role, local: capabilities(role === "guest" ? kinds.guest : kinds.provider), resourceForms: [FORM],
      hooks: role === "provider" ? providerHooks : undefined,
      transport: { peer: { id: `peer-${role}`, grants: ["example"] }, trySend: bytes => route(role, bytes) },
      scheduler: scheduler(), randomBytes: n => new Uint8Array(n).fill(role === "guest" ? 17 : 23),
    });
  }
  const settle = async () => {
    for (let i = 0; i < 32; i++) {
      await Promise.resolve();
      endpoints.guest.flush();
      endpoints.provider.flush();
    }
  };
  return { ...endpoints, settle };
}

function getOnce(link: ReturnType<typeof pair>, stream: number, ref = resourceRef()) {
  return new Promise<ResourceResult<{ ref: RelayResourceRef }>>(resolve => {
    const started = link.guest.get(stream, ref, {
      accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096,
      product: { key: "term", value: { page: 1 } },
    }, resolve as never);
    if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
  });
}

async function connect(link: ReturnType<typeof pair>): Promise<number> {
  expect(link.guest.hello()).toEqual({ ok: true });
  await link.settle();
  await link.guest.whenReady();
  const opened = link.guest.open({ app: "example", namespace: "term/session-1", profile: PROFILE });
  await link.settle();
  return (await opened).stream;
}

async function subscribe(
  link: ReturnType<typeof pair>, stream: number, target: RelayResourceRef | { ns: string },
  objects: unknown[], ends: string[],
): Promise<number> {
  const result = await new Promise<ResourceResult<{ subscription?: number }>>(resolve => {
    const started = link.guest.subscribe(stream, target, RELAY_DELIVERY.LATEST_SNAPSHOT, {
      onObject: object => objects.push(object),
      onEnd: error => ends.push(error?.code ?? "closed"),
    }, resolve, "kind" in target ? { product: { key: "term", value: { page: 1 } } } : undefined);
    if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
  });
  await link.settle();
  expect(result.ok).toBe(true);
  if (!result.ok || !("value" in result) || result.value.subscription === undefined) {
    throw new Error("subscribe failed");
  }
  return result.value.subscription;
}

test("ref subscription push filter is enforced by provider and consumer while revision advances", async () => {
  const mutations: Array<[string, (ref: RelayResourceRef) => RelayResourceRef]> = [
    ["namespace", ref => ({ ...ref, ns: "term/other" })],
    ["kind", ref => ({ ...ref, kind: RELAY_KIND.FILE })],
    ["key", ref => ({ ...ref, key: "other" })],
    ["rendition", ref => ({ ...ref, rendition: "other-v1" })],
  ];

  for (const [field, mutate] of mutations) {
    let wireMutation: ((ref: RelayResourceRef) => RelayResourceRef) | undefined;
    const link = pair((from, frame) => {
      if (from !== "provider" || frame.type !== RELAY_TYPE.PUSH || !wireMutation) return frame;
      return { ...frame, metadata: { ...frame.metadata,
        resource: wireMutation(frame.metadata.resource as RelayResourceRef),
      } };
    });
    const objects: unknown[] = [];
    const ends: string[] = [];
    const stream = await connect(link);
    const id = await subscribe(link, stream, resourceRef(), objects, ends);

    const local = link.provider.pushObject({
      stream, subscription: id, ref: mutate(resourceRef("s-43")),
      codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: page(1),
    });
    expect(local, `provider ${field}`).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
    expect(link.guest.client!.subscription(id)).toBeDefined();

    wireMutation = mutate;
    const sent = link.provider.pushObject({
      stream, subscription: id, ref: resourceRef("s-43"),
      codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: page(2),
    });
    expect(sent, `consumer ${field}`).toEqual({ ok: true, frames: 1 });
    await link.settle();
    expect(objects, `consumer ${field}`).toEqual([]);
    expect(ends, `consumer ${field}`).toEqual([RELAY_ERROR.INVALID]);
    expect(link.guest.client!.subscription(id)).toBeUndefined();
  }

  const positive = pair();
  const objects: Array<{ ref: RelayResourceRef }> = [];
  const ends: string[] = [];
  const stream = await connect(positive);
  const id = await subscribe(positive, stream, resourceRef(), objects, ends);
  expect(positive.provider.pushObject({
    stream, subscription: id, ref: resourceRef("s-43"),
    codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: page(3),
  })).toEqual({ ok: true, frames: 1 });
  await positive.settle();
  expect(objects.map(object => object.ref.revision)).toEqual(["s-43"]);
  expect(ends).toEqual([]);
});

test("namespace subscription filters only namespace on provider and consumer", async () => {
  let corruptNamespace = false;
  const link = pair((from, frame) => {
    if (from !== "provider" || frame.type !== RELAY_TYPE.PUSH || !corruptNamespace) return frame;
    return { ...frame, metadata: { ...frame.metadata,
      resource: { ...(frame.metadata.resource as RelayResourceRef), ns: "term/other" },
    } };
  });
  const objects: Array<{ ref: RelayResourceRef }> = [];
  const ends: string[] = [];
  const stream = await connect(link);
  const id = await subscribe(link, stream, { ns: "term/session-1" }, objects, ends);
  const fileRef: RelayResourceRef = {
    kind: RELAY_KIND.FILE, ns: "term/session-1", key: "font", revision: "f-1", rendition: "font3",
  };

  expect(link.provider.pushObject({
    stream, subscription: id, ref: fileRef, codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: { slot: 19 },
  })).toEqual({ ok: true, frames: 1 });
  await link.settle();
  expect(objects.map(object => object.ref)).toEqual([fileRef]);

  expect(link.provider.pushObject({
    stream, subscription: id, ref: { ...fileRef, ns: "term/other" },
    codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: { slot: 20 },
  })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(link.guest.client!.subscription(id)).toBeDefined();

  corruptNamespace = true;
  expect(link.provider.pushObject({
    stream, subscription: id, ref: { ...fileRef, revision: "f-2" },
    codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: { slot: 21 },
  })).toEqual({ ok: true, frames: 1 });
  await link.settle();
  expect(objects).toHaveLength(1);
  expect(ends).toEqual([RELAY_ERROR.INVALID]);
  expect(link.guest.client!.subscription(id)).toBeUndefined();
});

test("get responses bind ns, key, revision, and rendition on provider and consumer", async () => {
  const mutations: Array<[string, (ref: RelayResourceRef) => RelayResourceRef]> = [
    ["namespace", ref => ({ ...ref, ns: "term/other" })],
    ["key", ref => ({ ...ref, key: "other" })],
    ["revision", ref => ({ ...ref, revision: "s-other" })],
    ["rendition", ref => ({ ...ref, rendition: "other-v1" })],
  ];

  for (const [field, mutate] of mutations) {
    let localReply: unknown;
    let provider: RelayEndpoint | undefined;
    const local = pair(undefined, { onGet(request) {
      localReply = provider!.replyObject(request, {
        ref: mutate(resourceRef()), codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: page(1),
      });
    } });
    provider = local.provider;
    const localResult = await getOnce(local, await connect(local));
    await local.settle();
    expect(localReply, `provider ${field}`).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
    expect(localResult.ok, `provider ${field}`).toBe(false);
    if (localResult.ok) throw new Error(`provider accepted substituted ${field}`);
    expect((localResult.error as { code: string }).code).toBe(RELAY_ERROR.INVALID);

    let wireMutation: ((ref: RelayResourceRef) => RelayResourceRef) | undefined = mutate;
    let peer: RelayEndpoint | undefined;
    const inbound = pair((from, frame) => {
      if (from !== "provider" || frame.type !== RELAY_TYPE.RESPONSE
          || frame.metadata.op !== RELAY_OP.RESOURCE_GET
          || frame.metadata.status !== "ok" || !wireMutation) return frame;
      return { ...frame, metadata: { ...frame.metadata,
        resource: wireMutation(frame.metadata.resource as RelayResourceRef),
      } };
    }, { onGet(request) {
      peer!.replyObject(request, {
        ref: resourceRef(), codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: page(2),
      });
    } });
    peer = inbound.provider;
    const inboundResult = await getOnce(inbound, await connect(inbound));
    await inbound.settle();
    expect(inboundResult, `consumer ${field}`).toEqual({
      ok: false, error: { code: RELAY_ERROR.INVALID },
    });
    expect(inbound.guest.client!.stats()).toMatchObject({ pending: 0, protocolErrors: 1 });
    wireMutation = undefined;
  }
});

test("get identity binding covers notModified and permits a concrete revision for current", async () => {
  let request: RelayIncomingRequest | undefined;
  let provider: RelayEndpoint | undefined;
  const local = pair(undefined, { onGet(incoming) { request = incoming; } });
  provider = local.provider;
  const resultPromise = getOnce(local, await connect(local));
  await local.settle();
  expect(provider.replyNotModified(request!, { ...resourceRef(), revision: "s-other" }))
    .toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  await local.settle();
  expect(await resultPromise).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID,
    message: "response resource differs from request resource" } });

  let currentProvider: RelayEndpoint | undefined;
  const current = pair(undefined, { onGet(incoming) {
    currentProvider!.replyObject(incoming, {
      ref: resourceRef("s-current"), codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: page(3),
    });
  } });
  currentProvider = current.provider;
  const currentRef = resourceRef();
  delete currentRef.revision;
  const currentResult = await getOnce(current, await connect(current), currentRef);
  await current.settle();
  expect(currentResult.ok).toBe(true);
  if (currentResult.ok && "value" in currentResult) {
    expect(currentResult.value.ref.revision).toBe("s-current");
  }
});

test("unnegotiated kinds are refused for local get and ref subscribe before sending", async () => {
  const link = pair(undefined, undefined, {
    guest: [RELAY_KIND.TERMINAL_CELLS, RELAY_KIND.FILE], provider: [RELAY_KIND.FILE],
  });
  const stream = await connect(link);
  let getCompleted = false;
  expect(link.guest.get(stream, resourceRef(), {
    accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096,
    product: { key: "term", value: { page: 1 } },
  }, () => { getCompleted = true; })).toEqual({ ok: false, code: RELAY_ERROR.UNSUPPORTED });
  let subscribeCompleted = false;
  expect(link.guest.subscribe(stream, resourceRef(), RELAY_DELIVERY.LATEST_SNAPSHOT, { onObject() {} },
    () => { subscribeCompleted = true; }, { product: { key: "term", value: { page: 1 } } }))
    .toEqual({ ok: false, code: RELAY_ERROR.UNSUPPORTED });
  await link.settle();
  expect(getCompleted).toBe(false);
  expect(subscribeCompleted).toBe(false);
  expect(link.guest.inspect()!.outgoingRequests.active).toBe(0);
});

test("provider rejects unnegotiated get and subscribe kinds before handlers or subscriptions", async () => {
  for (const op of [RELAY_OP.RESOURCE_GET, RELAY_OP.RESOURCE_SUBSCRIBE] as const) {
    let handlerRan = false;
    let provider: RelayEndpoint | undefined;
    const link = pair((from, frame) => {
      if (from !== "guest" || frame.type !== RELAY_TYPE.REQUEST || frame.metadata.op !== op) return frame;
      return { ...frame, metadata: { ...frame.metadata,
        resource: { ...(frame.metadata.resource as RelayResourceRef), kind: RELAY_KIND.TERMINAL_CELLS },
      } };
    }, { onGet(request) {
      handlerRan = true;
      provider!.replyObject(request, {
        ref: resourceRef(), codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: page(1),
      });
    } }, {
      guest: [RELAY_KIND.TERMINAL_CELLS, RELAY_KIND.FILE], provider: [RELAY_KIND.FILE],
    });
    provider = link.provider;
    const stream = await connect(link);
    const fileRef: RelayResourceRef = {
      kind: RELAY_KIND.FILE, ns: "term/session-1", key: "font", revision: "f-1", rendition: "font3",
    };
    const result = await new Promise<ResourceResult<unknown>>(resolve => {
      const started = op === RELAY_OP.RESOURCE_GET
        ? link.guest.get(stream, fileRef, { accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096 }, resolve as never)
        : link.guest.subscribe(stream, fileRef, RELAY_DELIVERY.LATEST_SNAPSHOT, { onObject() {} }, resolve as never);
      if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
    });
    await link.settle();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`${op} admitted an unnegotiated kind`);
    expect((result.error as { code: string }).code).toBe(RELAY_ERROR.UNSUPPORTED);
    expect(handlerRan).toBe(false);
    expect(link.provider.authority!.subscriptionsOn(stream)).toEqual([]);
  }
});

test("push enforces negotiated kind at provider and consumer for namespace subscriptions", async () => {
  let inject = false;
  const link = pair((from, frame) => {
    if (from !== "provider" || frame.type !== RELAY_TYPE.PUSH || !inject) return frame;
    return { ...frame, metadata: { ...frame.metadata, resource: {
      ...(frame.metadata.resource as RelayResourceRef), kind: RELAY_KIND.TERMINAL_CELLS,
    } } };
  }, undefined, {
    guest: [RELAY_KIND.TERMINAL_CELLS, RELAY_KIND.FILE], provider: [RELAY_KIND.FILE],
  });
  const objects: unknown[] = [];
  const ends: string[] = [];
  const stream = await connect(link);
  const id = await subscribe(link, stream, { ns: "term/session-1" }, objects, ends);
  expect(link.provider.pushObject({
    stream, subscription: id, ref: resourceRef(), codec: RELAY_CODEC.NONE,
    data: new Uint8Array(), value: page(1),
  })).toEqual({ ok: false, code: RELAY_ERROR.UNSUPPORTED });
  expect(link.guest.client!.subscription(id)).toBeDefined();

  inject = true;
  const fileRef: RelayResourceRef = {
    kind: RELAY_KIND.FILE, ns: "term/session-1", key: "font", revision: "f-1", rendition: "font3",
  };
  expect(link.provider.pushObject({
    stream, subscription: id, ref: fileRef, codec: RELAY_CODEC.NONE,
    data: new Uint8Array(), value: { slot: 19 },
  })).toEqual({ ok: true, frames: 1 });
  await link.settle();
  expect(objects).toEqual([]);
  expect(ends).toEqual([RELAY_ERROR.UNSUPPORTED]);
  expect(link.guest.client!.subscription(id)).toBeUndefined();
});

test("negotiated kind admission covers release, evict, and invalidate paths", async () => {
  let mutateGuestRef = false;
  let mutateProviderRef = false;
  let evictions = 0;
  const link = pair((from, frame) => {
    if (from === "guest" && mutateGuestRef && frame.metadata.resource) {
      return { ...frame, metadata: { ...frame.metadata, resource: {
        ...(frame.metadata.resource as RelayResourceRef), kind: RELAY_KIND.TERMINAL_CELLS,
      } } };
    }
    if (from === "provider" && mutateProviderRef && frame.type === RELAY_TYPE.INVALIDATE
        && frame.metadata.resource) {
      return { ...frame, metadata: { ...frame.metadata, resource: {
        ...(frame.metadata.resource as RelayResourceRef), kind: RELAY_KIND.TERMINAL_CELLS,
      } } };
    }
    return frame;
  }, { onEvict() { evictions++; } }, {
    guest: [RELAY_KIND.TERMINAL_CELLS, RELAY_KIND.FILE], provider: [RELAY_KIND.FILE],
  });
  const stream = await connect(link);
  const fileRef: RelayResourceRef = {
    kind: RELAY_KIND.FILE, ns: "term/session-1", key: "font", revision: "f-1", rendition: "font3",
  };
  const lease = link.provider.authority!.allocateLease();
  expect(link.guest.release(stream, resourceRef(), lease)).toEqual({ ok: false, code: RELAY_ERROR.UNSUPPORTED });
  expect(link.provider.invalidate({ stream, scope: "key", ref: resourceRef() }))
    .toEqual({ ok: false, code: RELAY_ERROR.UNSUPPORTED });
  link.guest.reportEvict(resourceRef(), "budget");
  await link.settle();
  expect(evictions).toBe(0);

  mutateGuestRef = true;
  const releaseResult = await new Promise<ResourceResult<unknown>>(resolve => {
    const started = link.guest.release(stream, fileRef, lease, resolve as never);
    if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
  });
  await link.settle();
  expect(releaseResult.ok).toBe(false);
  if (releaseResult.ok) throw new Error("release admitted an unnegotiated kind");
  expect((releaseResult.error as { code: string }).code).toBe(RELAY_ERROR.UNSUPPORTED);
  link.guest.reportEvict(fileRef, "budget");
  await link.settle();
  expect(evictions).toBe(0);

  mutateGuestRef = false;
  mutateProviderRef = true;
  const before = link.guest.client!.stats().protocolErrors;
  expect(link.provider.invalidate({ stream, scope: "key", ref: fileRef })).toEqual({ ok: true });
  await link.settle();
  expect(link.guest.client!.stats().protocolErrors).toBe(before + 1);
});
