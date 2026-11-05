// Independent cross-family review regression: a present content value
// shaped as {notModified:true} cannot bypass a product's required value
// schema. The public conditional-GET 304 terminal
// (codec-0 metadata value {notModified:true}, no data region) is a distinct
// public result intercepted before product form validation and must keep
// working. Product content carriers are: GET codec-1 JSON data, PUSH codec-0
// metadata value, PUSH codec-1 JSON data.
//
// This file is reviewer-owned: its harness is independent of
// tests/relay-resource-forms.test.ts and it covers marker variants the
// maintained suite does not (notModified:false/1/"true", marker together with
// the required fields, null/array/string carriers) at unit, provider and
// guest boundaries, under both required and optional valuePresence.

import { expect, test } from "bun:test";
import {
  RELAY_CODEC, RELAY_DELIVERY, RELAY_ERROR, RELAY_KIND, RELAY_OP, RELAY_STATUS, RELAY_TYPE,
  type RelayProfileEntry, type RelayResourceRef, type RelayRxLimits,
} from "../contracts/spec/relay.ts";
import {
  RelayEndpoint, type RelayEndpointHooks, type RelayResourceForm,
} from "../framework/src/relay/endpoint.ts";
import { decodeFrame, encodeFrame, type RelayDecodedFrame } from "../framework/src/relay/frame.ts";
import { RelayResourceForms } from "../framework/src/relay/resource-form.ts";
import { sha256Hex } from "../framework/src/relay/sha256.ts";
import { stringToUtf8 } from "../framework/src/bytes.ts";
import type { RelayLocalCapabilities, RelayScheduler } from "../framework/src/relay/session.ts";
import type { ResourceResult } from "../framework/src/resource-cache.ts";

const PROFILE: RelayProfileEntry = { name: "term.grid", version: 1 };
const RX: RelayRxLimits = {
  maxWireBytes: 4096, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 32768,
  maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 2, maxScratchBytes: 262144,
};

const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object", additionalProperties: false, properties, required }) as const;
const pageSchema = closed({
  lines: { type: "array", items: { type: "string" } },
  cursor: { type: "integer", minimum: 0 },
});
const pageValue = { lines: ["$ ls", "docs"], cursor: 2 };
const requiredForm: RelayResourceForm = {
  profile: PROFILE, kind: RELAY_KIND.TERMINAL_CELLS, value: pageSchema, valuePresence: "required",
};
const optionalForm: RelayResourceForm = { ...requiredForm, valuePresence: "optional" };
const formsWith = (presence: "required" | "optional"): readonly RelayResourceForm[] =>
  [presence === "required" ? requiredForm : optionalForm];

const ref = (revision = "s-42"): RelayResourceRef => ({
  kind: RELAY_KIND.TERMINAL_CELLS, ns: "term/session-1", key: "scrollback", revision, rendition: "g1",
});
const markerJson = stringToUtf8(JSON.stringify({ notModified: true }));

type Role = "guest" | "provider";
const scheduler = (): RelayScheduler => {
  let id = 0;
  return { now: () => 0, setTimeout: () => ++id, clearTimeout: () => {} };
};
const capabilities = (): RelayLocalCapabilities => ({
  app: "example", versions: [[1, 0]], profiles: [PROFILE],
  codecs: [RELAY_CODEC.NONE, RELAY_CODEC.JSON], kinds: [6, 7, 8], rxLimits: RX,
});

function pair(options: {
  guestForms?: readonly RelayResourceForm[];
  providerForms?: readonly RelayResourceForm[];
  providerHooks?: RelayEndpointHooks;
  transform?: (from: Role, frame: RelayDecodedFrame) => RelayDecodedFrame;
} = {}) {
  const wire: Array<{ from: Role; bytes: Uint8Array }> = [];
  const endpoints = {} as Record<Role, RelayEndpoint>;
  const route = (from: Role, bytes: Uint8Array) => {
    let copy = bytes.slice();
    if (options.transform) {
      const decoded = decodeFrame(copy);
      if (!decoded.ok) throw new Error(decoded.code);
      const encoded = encodeFrame(options.transform(from, decoded.frame));
      if (!encoded.ok) throw new Error(encoded.code);
      copy = encoded.bytes as Uint8Array<ArrayBuffer>;
    }
    wire.push({ from, bytes: copy });
    endpoints[from === "guest" ? "provider" : "guest"].handleRecord(copy as Uint8Array<ArrayBuffer>);
    return "accepted" as const;
  };
  for (const role of ["guest", "provider"] as const) {
    const seed = role === "guest" ? 17 : 23;
    endpoints[role] = new RelayEndpoint({
      role, local: capabilities(),
      resourceForms: (role === "guest" ? options.guestForms : options.providerForms) ?? [requiredForm],
      transport: { peer: { id: `peer-${role}`, grants: ["example"] }, trySend: b => route(role, b) },
      hooks: role === "provider" ? options.providerHooks : undefined,
      scheduler: scheduler(),
      randomBytes: (() => { let s = seed; return (n: number) => new Uint8Array(n).fill(s++) as Uint8Array<ArrayBuffer>; })(),
    });
  }
  const settle = async () => {
    for (let i = 0; i < 32; i++) { await Promise.resolve(); endpoints.guest.flush(); endpoints.provider.flush(); }
  };
  const frames = (from?: Role) => wire.filter(r => !from || r.from === from).map(r => {
    const decoded = decodeFrame(r.bytes);
    if (!decoded.ok) throw new Error(decoded.code);
    return { from: r.from, ...decoded.frame };
  });
  return { ...endpoints, wire, settle, frames };
}
type Pair = ReturnType<typeof pair>;

async function connect(link: Pair): Promise<number> {
  expect(link.guest.hello()).toEqual({ ok: true });
  await link.settle();
  await link.guest.whenReady();
  const opened = link.guest.open({ app: "example", namespace: "term/session-1", profile: PROFILE });
  await link.settle();
  return (await opened).stream;
}

const getOnce = (link: Pair, stream: number, args: Record<string, unknown>) =>
  new Promise<ResourceResult<unknown>>(resolve => {
    const started = link.guest.get(stream, ref(), args as never, resolve);
    if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
  });

async function subscribe(link: Pair, stream: number, onObject: (o: unknown) => void, onEnd: (e?: { code: string }) => void) {
  const complete = await new Promise<ResourceResult<{ subscription?: number }>>(resolve => {
    link.guest.subscribe(stream, { ns: "term/session-1" }, RELAY_DELIVERY.LATEST_SNAPSHOT,
      { onObject, onEnd }, resolve);
  });
  await link.settle();
  if (!complete.ok || !("value" in complete)) throw new Error("subscribe failed");
  return complete.value.subscription!;
}

// ---------------------------------------------------------------------------
// 1. Unit boundary: validateValue itself, required and optional forms
// ---------------------------------------------------------------------------

const presentMarkers: Array<[string, unknown]> = [
  ["bare marker", { notModified: true }],
  ["false marker", { notModified: false }],
  ["numeric marker", { notModified: 1 }],
  ["string marker", { notModified: "true" }],
  ["marker beside required fields", { notModified: true, ...pageValue }],
  ["null", null],
  ["array", []],
  ["string", '{"notModified":true}'],
  ["number", 7],
  ["marker nested where a string item belongs", { lines: [{ notModified: true }], cursor: 0 }],
];

for (const presence of ["required", "optional"] as const) {
  test(`validateValue: every present marker-shaped value hits the ${presence} schema`, () => {
    const forms = new RelayResourceForms(formsWith(presence), [PROFILE]);
    for (const [label, value] of presentMarkers) {
      const verdict = forms.validateValue(PROFILE, RELAY_KIND.TERMINAL_CELLS, value);
      expect(verdict, `${presence}/${label}`).not.toBeNull();
    }
    // A present, well-formed object still passes.
    expect(forms.validateValue(PROFILE, RELAY_KIND.TERMINAL_CELLS, pageValue)).toBeNull();
    // Only an absent carrier is governed by valuePresence.
    const absent = forms.validateValue(PROFILE, RELAY_KIND.TERMINAL_CELLS, undefined);
    expect(absent).toBe(presence === "required"
      ? "resource value is required by the installed form" : null);
  });
}

test("validateValue: a kind without an installed form neither validates nor marker-bypasses", () => {
  const forms = new RelayResourceForms([requiredForm], [PROFILE]);
  // No form => no local constraint; content is the product binary validator's job.
  expect(forms.validateValue(PROFILE, RELAY_KIND.FILE, { notModified: true })).toBeNull();
  expect(forms.validateValue(PROFILE, RELAY_KIND.FILE, undefined)).toBeNull();
});

// ---------------------------------------------------------------------------
// 2. Provider boundary: marker content never leaves a form-aware provider
// ---------------------------------------------------------------------------

for (const presence of ["required", "optional"] as const) {
  test(`provider (${presence}): GET codec-1 marker data is refused, legal 304 stays available`, async () => {
    let provider: RelayEndpoint | undefined;
    let markerReply: unknown;
    let notModifiedReply: unknown;
    const link = pair({
      providerForms: formsWith(presence),
      providerHooks: {
        onGet(request) {
          const args = request.metadata.args as { ifRevision?: string };
          if (args.ifRevision) {
            notModifiedReply = provider!.replyNotModified(request, ref());
          } else {
            markerReply = provider!.replyObject(request, { ref: ref(), codec: RELAY_CODEC.JSON, data: markerJson });
          }
        },
      },
    });
    provider = link.provider;
    const stream = await connect(link);

    const markerResult = await getOnce(link, stream, {
      accept: [RELAY_CODEC.JSON], maxObjectBytes: 4096,
    });
    await link.settle();
    expect(markerReply).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
    expect(markerResult).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID, message: "missing lines" } });
    expect(link.frames("provider").filter(f => f.type === RELAY_TYPE.RESPONSE
      && f.metadata.op === RELAY_OP.RESOURCE_GET && f.metadata.status === RELAY_STATUS.OK)).toEqual([]);

    // The public 304 path is independent: conditional GET still gets notModified.
    const revalidated = await new Promise<ResourceResult<unknown>>(resolve => {
      const started = link.guest.get(stream, ref(), {
        accept: [RELAY_CODEC.JSON, RELAY_CODEC.NONE], maxObjectBytes: 4096, ifRevision: "s-42",
      }, resolve);
      if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
    });
    await link.settle();
    expect(notModifiedReply).toEqual({ ok: true });
    expect(revalidated).toEqual({ ok: true, value: { notModified: true, revision: "s-42" } });
  });
}

test("provider (required): codec-0 metadata marker and absent carrier are refused; variant markers too", async () => {
  const link = pair({ providerForms: [requiredForm] });
  const stream = await connect(link);
  const request = { stream, correlation: 9, op: RELAY_OP.RESOURCE_GET,
    metadata: { op: RELAY_OP.RESOURCE_GET, resource: ref(), args: { accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096 } } };
  const send = (patch: Record<string, unknown>) =>
    link.provider.replyObject(request as never, { ref: ref(), codec: RELAY_CODEC.NONE, data: new Uint8Array(0), ...patch });

  for (const value of [{ notModified: true }, { notModified: false }, { notModified: 1 }, { notModified: true, ...pageValue }]) {
    expect(send({ value: value as never })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  }
  // Absent carrier on a required form is the presence rule, not the marker rule.
  expect(send({})).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
});

test("provider (optional): absent carrier admitted, present marker still refused", async () => {
  const link = pair({ providerForms: [optionalForm] });
  const stream = await connect(link);
  const request = { stream, correlation: 9, op: RELAY_OP.RESOURCE_GET,
    metadata: { op: RELAY_OP.RESOURCE_GET, resource: ref(), args: { accept: [RELAY_CODEC.NONE], maxObjectBytes: 4096 } } };
  expect(link.provider.replyObject(request as never,
    { ref: ref(), codec: RELAY_CODEC.NONE, data: new Uint8Array(0) })).toEqual({ ok: true, frames: 1 });
  expect(link.provider.replyObject(request as never,
    { ref: ref(), codec: RELAY_CODEC.NONE, data: new Uint8Array(0), value: { notModified: true } as never }))
    .toEqual({ ok: false, code: RELAY_ERROR.INVALID });
});

for (const [label, codec, data, value] of [
  ["codec-0 metadata", RELAY_CODEC.NONE, new Uint8Array(0), { notModified: true }],
  ["codec-1 JSON data", RELAY_CODEC.JSON, markerJson, undefined],
] as const) {
  test(`provider: notModified-shaped push ${label} is refused with zero push frames`, async () => {
    const link = pair({ guestForms: [], providerForms: [requiredForm] });
    const stream = await connect(link);
    const id = await subscribe(link, stream, () => {}, () => {});
    const before = link.frames("provider").filter(f => f.type === RELAY_TYPE.PUSH).length;
    expect(link.provider.pushObject({
      stream, subscription: id, ref: ref("s-43"), codec, data, value: value as never,
    })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
    await link.settle();
    expect(link.frames("provider").filter(f => f.type === RELAY_TYPE.PUSH).length).toBe(before);
  });
}

// ---------------------------------------------------------------------------
// 3. Guest boundary: marker frames from a formless peer deliver no content
// ---------------------------------------------------------------------------

test("guest (required): inbound GET codec-1 marker ends INVALID with the pending slot released", async () => {
  let peer: RelayEndpoint | undefined;
  const link = pair({
    guestForms: [requiredForm], providerForms: [],
    providerHooks: { onGet(request) { peer!.replyObject(request, { ref: ref(), codec: RELAY_CODEC.JSON, data: markerJson }); } },
  });
  peer = link.provider;
  const result = await getOnce(link, await connect(link), { accept: [RELAY_CODEC.JSON], maxObjectBytes: 4096 });
  await link.settle();
  expect(result).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });
  expect(link.guest.client!.stats()).toMatchObject({ pending: 0, protocolErrors: 1 });
});

for (const [label, value] of [
  ["bare marker", { notModified: true }],
  ["false marker", { notModified: false }],
  ["numeric marker", { notModified: 1 }],
  ["marker beside required fields", { notModified: true, ...pageValue }],
] as const) {
  test(`guest (required): inbound codec-0 push ${label} delivers no object and ends INVALID`, async () => {
    const objects: unknown[] = [];
    const ends: Array<string | undefined> = [];
    const link = pair({ guestForms: [requiredForm], providerForms: [] });
    const stream = await connect(link);
    const id = await subscribe(link, stream, o => objects.push(o), e => ends.push(e?.code));
    expect(link.provider.pushObject({
      stream, subscription: id, ref: ref("s-43"), codec: RELAY_CODEC.NONE,
      data: new Uint8Array(0), value: value as never,
    })).toEqual({ ok: true, frames: 1 });
    await link.settle();
    expect(objects).toEqual([]);
    expect(ends).toEqual([RELAY_ERROR.INVALID]);
  });
}

test("guest (required): inbound codec-1 push marker data delivers no object and ends INVALID", async () => {
  const objects: unknown[] = [];
  const ends: Array<string | undefined> = [];
  const link = pair({ guestForms: [requiredForm], providerForms: [] });
  const stream = await connect(link);
  const id = await subscribe(link, stream, o => objects.push(o), e => ends.push(e?.code));
  expect(link.provider.pushObject({
    stream, subscription: id, ref: ref("s-43"), codec: RELAY_CODEC.JSON, data: markerJson,
  })).toEqual({ ok: true, frames: 1 });
  await link.settle();
  expect(objects).toEqual([]);
  expect(ends).toEqual([RELAY_ERROR.INVALID]);
});

test("guest (required): double-value codec-1 GET (schema-valid data plus marker metadata) is INVALID", async () => {
  let peer: RelayEndpoint | undefined;
  const good = stringToUtf8(JSON.stringify(pageValue));
  const link = pair({
    guestForms: [requiredForm], providerForms: [],
    providerHooks: { onGet(request) { peer!.replyObject(request, { ref: ref(), codec: RELAY_CODEC.JSON, data: good }); } },
    transform: (from, frame) => {
      if (from !== "provider" || frame.type !== RELAY_TYPE.RESPONSE || !frame.data.length) return frame;
      return { ...frame, metadata: { ...frame.metadata, value: { notModified: true } } };
    },
  });
  peer = link.provider;
  const result = await getOnce(link, await connect(link), { accept: [RELAY_CODEC.JSON], maxObjectBytes: 4096 });
  await link.settle();
  expect(result).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });
});

test("guest (required): wrong-type and null codec-0 push content delivers no object (schema or public schema)", async () => {
  const objects: unknown[] = [];
  for (const value of [null, ["x"], "notModified", 42] as const) {
    const link = pair({ guestForms: [requiredForm], providerForms: [] });
    const stream = await connect(link);
    const id = await subscribe(link, stream, o => objects.push(o), () => {});
    // A formless peer can be made to emit any metadata via the wire.
    const sent = link.provider.pushObject({
      stream, subscription: id, ref: ref("s-43"), codec: RELAY_CODEC.NONE,
      data: new Uint8Array(0), value: value as never,
    });
    await link.settle();
    // Whether the provider's own loose emitter accepted it or not, the guest
    // with the required form must never publish it.
    expect(sent.ok).toBe(true);
  }
  expect(objects).toEqual([]);
});

// ---------------------------------------------------------------------------
// 4. Legal behavior must survive: 304, legal content, optional absence
// ---------------------------------------------------------------------------

test("legal conditional GET 304 succeeds end to end with a required value form installed", async () => {
  let provider: RelayEndpoint | undefined;
  const link = pair({
    providerHooks: { onGet(request) { provider!.replyNotModified(request, ref()); } },
  });
  provider = link.provider;
  const stream = await connect(link);
  const result = await new Promise<ResourceResult<unknown>>(resolve => {
    const started = link.guest.get(stream, ref(), {
      accept: [RELAY_CODEC.JSON, RELAY_CODEC.NONE], maxObjectBytes: 4096, ifRevision: "s-42",
    }, resolve);
    if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
  });
  await link.settle();
  expect(result).toEqual({ ok: true, value: { notModified: true, revision: "s-42" } });
});

test("schema-legal codec-1 content still delivers on GET and PUSH under both presences", async () => {
  for (const presence of ["required", "optional"] as const) {
    const json = stringToUtf8(JSON.stringify(pageValue));
    const objects: unknown[] = [];
    let peer: RelayEndpoint | undefined;
    const link = pair({
      guestForms: formsWith(presence), providerForms: formsWith(presence),
      providerHooks: { onGet(request) { peer!.replyObject(request, { ref: ref(), codec: RELAY_CODEC.JSON, data: json }); } },
    });
    peer = link.provider;
    const stream = await connect(link);
    const got = await getOnce(link, stream, { accept: [RELAY_CODEC.JSON], maxObjectBytes: 4096 });
    await link.settle();
    expect(got.ok).toBe(true);

    const id = await subscribe(link, stream,
      o => objects.push(JSON.parse(new TextDecoder().decode((o as { data: Uint8Array }).data))), () => {});
    expect(link.provider.pushObject({
      stream, subscription: id, ref: ref("s-43"), codec: RELAY_CODEC.JSON, data: json,
    })).toEqual({ ok: true, frames: 1 });
    await link.settle();
    expect(objects).toEqual([pageValue]);
  }
});

test("optional form accepts absent push content; a follow-up marker push still ends the subscription", async () => {
  const objects: unknown[] = [];
  const ends: Array<string | undefined> = [];
  const link = pair({ guestForms: [optionalForm], providerForms: [optionalForm] });
  const stream = await connect(link);
  const id = await subscribe(link, stream, o => objects.push(o), e => ends.push(e?.code));
  expect(link.provider.pushObject({
    stream, subscription: id, ref: ref("s-43"), codec: RELAY_CODEC.NONE, data: new Uint8Array(0),
  })).toEqual({ ok: true, frames: 1 });
  await link.settle();
  expect(objects.length).toBe(1);
  expect(ends).toEqual([]);
  // Subscription survives the legal empty push; a marker push then closes it INVALID.
  expect(link.provider.pushObject({
    stream, subscription: id, ref: ref("s-44"), codec: RELAY_CODEC.NONE,
    data: new Uint8Array(0), value: { notModified: true } as never,
  })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
});
