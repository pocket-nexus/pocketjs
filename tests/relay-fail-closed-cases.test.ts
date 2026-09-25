// Fail-closed regression cases from the resource-form review rounds. Each
// case asserts the required refusal instead of the vulnerability it found.

import { expect, test } from "bun:test";
import {
  RELAY_CODEC, RELAY_ERROR, RELAY_KIND, RELAY_OP, RELAY_STATUS, RELAY_TYPE,
  type RelayProfileEntry, type RelayResourceRef, type RelayRxLimits,
} from "../contracts/spec/relay.ts";
import {
  RelayEndpoint, type RelayEndpointHooks, type RelayResourceForm,
} from "../framework/src/relay/endpoint.ts";
import { decodeFrame, encodeFrame, type RelayDecodedFrame } from "../framework/src/relay/frame.ts";
import { sha256Hex } from "../framework/src/relay/sha256.ts";
import type { RelayLocalCapabilities, RelayScheduler } from "../framework/src/relay/session.ts";
import type { RelayGetOutcome } from "../framework/src/relay/resource.ts";
import type { ResourceResult } from "../framework/src/resource-cache.ts";

const PROFILE: RelayProfileEntry = { name: "term.grid", version: 1 };
const RX: RelayRxLimits = {
  maxWireBytes: 4096, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 32768,
  maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 2, maxScratchBytes: 262144,
};
const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object", additionalProperties: false, properties, required }) as const;
const form: RelayResourceForm = {
  profile: PROFILE, kind: RELAY_KIND.TERMINAL_CELLS, argsKey: "term",
  args: closed({ page: { type: "integer", minimum: 0 } }),
  value: closed({
    lines: { type: "array", items: { type: "string" } },
    cursor: { type: "integer", minimum: 0 },
  }),
  valuePresence: "required",
  onSubscribe: true,
};
const ref = (): RelayResourceRef => ({
  kind: RELAY_KIND.TERMINAL_CELLS, ns: "term/session-1", key: "scrollback",
  revision: "s-42", rendition: "grid-density1-v1",
});
const page = { lines: ["ok"], cursor: 1 };

type Role = "guest" | "provider";
const scheduler = (): RelayScheduler => {
  let id = 0;
  return { now: () => 0, setTimeout: () => ++id, clearTimeout: () => {} };
};
const capabilities = (): RelayLocalCapabilities => ({
  app: "example", versions: [[1, 0]], profiles: [PROFILE],
  codecs: [RELAY_CODEC.NONE, RELAY_CODEC.JSON],
  kinds: [RELAY_KIND.TERMINAL_CELLS, RELAY_KIND.FILE], rxLimits: RX,
});

function pair(options: {
  providerHooks?: RelayEndpointHooks;
  transform?: (from: Role, frame: RelayDecodedFrame) => RelayDecodedFrame;
} = {}) {
  const endpoints = {} as Record<Role, RelayEndpoint>;
  const route = (from: Role, bytes: Uint8Array<ArrayBufferLike>) => {
    let copy: Uint8Array<ArrayBufferLike> = bytes.slice();
    if (options.transform) {
      const decoded = decodeFrame(copy);
      if (!decoded.ok) throw new Error(decoded.code);
      const encoded = encodeFrame(options.transform(from, decoded.frame));
      if (!encoded.ok) throw new Error(encoded.code);
      copy = encoded.bytes;
    }
    endpoints[from === "guest" ? "provider" : "guest"].handleRecord(copy);
    return "accepted" as const;
  };
  for (const role of ["guest", "provider"] as const) {
    endpoints[role] = new RelayEndpoint({
      role, local: capabilities(), resourceForms: [form],
      hooks: role === "provider" ? options.providerHooks : undefined,
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

async function connect(link: ReturnType<typeof pair>): Promise<number> {
  expect(link.guest.hello()).toEqual({ ok: true });
  await link.settle();
  await link.guest.whenReady();
  const opened = link.guest.open({ app: "example", namespace: "term/session-1", profile: PROFILE });
  await link.settle();
  return (await opened).stream;
}

function getOnce(link: ReturnType<typeof pair>, stream: number, accept: number = RELAY_CODEC.NONE) {
  return new Promise<ResourceResult<RelayGetOutcome>>((resolve) => {
    const started = link.guest.get(stream, ref(), {
      accept: [accept], maxObjectBytes: 4096, product: { key: "term", value: { page: 1 } },
    }, resolve);
    if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
  });
}

test("fail-closed A: response kind substitution ends the request as INVALID", async () => {
  let localProvider: RelayEndpoint | undefined;
  let localReply: unknown;
  const local = pair({ providerHooks: { onGet(request) {
    localReply = localProvider!.replyObject(request, {
      ref: { ...ref(), kind: RELAY_KIND.FILE }, codec: RELAY_CODEC.NONE,
      data: new Uint8Array(), value: { lines: "not-an-array", cursor: -1 },
    });
  } } });
  localProvider = local.provider;
  const localResult = await getOnce(local, await connect(local));
  await local.settle();
  expect(localReply).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(localResult.ok).toBe(false);
  if (localResult.ok) throw new Error("response kind substitution was accepted");
  expect((localResult.error as { code: string }).code).toBe(RELAY_ERROR.INVALID);

  let provider: RelayEndpoint | undefined;
  const link = pair({
    providerHooks: { onGet(request) {
      provider!.replyObject(request, { ref: ref(), codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: page });
    } },
    transform(from, frame) {
      if (from !== "provider" || frame.type !== RELAY_TYPE.RESPONSE
          || frame.metadata.op !== RELAY_OP.RESOURCE_GET || frame.metadata.status !== RELAY_STATUS.OK) return frame;
      return { ...frame, metadata: { ...frame.metadata,
        resource: { ...(frame.metadata.resource as RelayResourceRef), kind: RELAY_KIND.FILE },
        value: { lines: "not-an-array", cursor: -1 },
      } };
    },
  });
  provider = link.provider;
  const result = await getOnce(link, await connect(link));
  await link.settle();
  expect(result).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });
  expect(link.guest.inspect()!.client!.stats()).toMatchObject({ pending: 0, protocolErrors: 1 });
});

test("fail-closed B: codec-1 rejects duplicate keys and malformed UTF-8 on both ends", async () => {
  const duplicate = new TextEncoder().encode('{"lines":[],"cursor":1,"cursor":2}');
  const prefix = new TextEncoder().encode('{"lines":["');
  const suffix = new TextEncoder().encode('"],"cursor":1}');
  const malformed = new Uint8Array(prefix.length + 2 + suffix.length);
  malformed.set(prefix);
  malformed.set([0xc0, 0xaf], prefix.length);
  malformed.set(suffix, prefix.length + 2);

  for (const badBytes of [duplicate, malformed]) {
    let producer: RelayEndpoint | undefined;
    let produced: unknown;
    const outbound = pair({ providerHooks: { onGet(request) {
      produced = producer!.replyObject(request, { ref: ref(), codec: RELAY_CODEC.JSON, data: badBytes });
    } } });
    producer = outbound.provider;
    const outboundResult = await getOnce(outbound, await connect(outbound), RELAY_CODEC.JSON);
    await outbound.settle();
    expect(produced).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
    expect(outboundResult.ok).toBe(false);
    if (outboundResult.ok) throw new Error("invalid producer JSON was accepted");
    expect((outboundResult.error as { code: string }).code).toBe(RELAY_ERROR.INVALID);

    let provider: RelayEndpoint | undefined;
    const inbound = pair({
      providerHooks: { onGet(request) {
        const good = new TextEncoder().encode(JSON.stringify(page));
        provider!.replyObject(request, { ref: ref(), codec: RELAY_CODEC.JSON, data: good });
      } },
      transform(from, frame) {
        if (from !== "provider" || frame.type !== RELAY_TYPE.RESPONSE || !frame.data.length) return frame;
        return { ...frame, data: badBytes, metadata: { ...frame.metadata,
          transfer: { ...(frame.metadata.transfer as Record<string, unknown>),
            total: badBytes.length.toString(16).padStart(16, "0") },
          digest: `sha256:${sha256Hex(badBytes)}`,
        } };
      },
    });
    provider = inbound.provider;
    const inboundResult = await getOnce(inbound, await connect(inbound), RELAY_CODEC.JSON);
    await inbound.settle();
    expect(inboundResult).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });
    expect(inbound.guest.inspect()!.client!.stats()).toMatchObject({ pending: 0, protocolErrors: 1 });
  }
});

test("fail-closed C: codec-1 rejects simultaneous metadata and data values", async () => {
  const dataValue = { lines: ["data"], cursor: 1 };
  const metadataValue = { lines: ["metadata"], cursor: 2 };
  const json = new TextEncoder().encode(JSON.stringify(dataValue));

  let producer: RelayEndpoint | undefined;
  let produced: unknown;
  const outbound = pair({ providerHooks: { onGet(request) {
    produced = producer!.replyObject(request, {
      ref: ref(), codec: RELAY_CODEC.JSON, data: json, value: metadataValue,
    });
  } } });
  producer = outbound.provider;
  const outboundResult = await getOnce(outbound, await connect(outbound), RELAY_CODEC.JSON);
  await outbound.settle();
  expect(produced).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(outboundResult.ok).toBe(false);
  if (outboundResult.ok) throw new Error("conflicting producer values were accepted");
  expect((outboundResult.error as { code: string }).code).toBe(RELAY_ERROR.INVALID);

  let provider: RelayEndpoint | undefined;
  const inbound = pair({
    providerHooks: { onGet(request) {
      provider!.replyObject(request, { ref: ref(), codec: RELAY_CODEC.JSON, data: json });
    } },
    transform(from, frame) {
      if (from !== "provider" || frame.type !== RELAY_TYPE.RESPONSE || !frame.data.length) return frame;
      return { ...frame, metadata: { ...frame.metadata, value: metadataValue } };
    },
  });
  provider = inbound.provider;
  const inboundResult = await getOnce(inbound, await connect(inbound), RELAY_CODEC.JSON);
  await inbound.settle();
  expect(inboundResult).toEqual({ ok: false, error: { code: RELAY_ERROR.INVALID } });
  expect(inbound.guest.inspect()!.client!.stats()).toMatchObject({ pending: 0, protocolErrors: 1 });
});
