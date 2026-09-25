/** Deterministic generator for the cross-language Relay byte vectors.
 *
 * Run from PocketJS/:  bun tests/fixtures/relay/generate.ts
 *
 * Outputs (committed; C and Rust frame-layer tasks consume them read-only):
 *   constants.json          snapshot of every constants/spec/relay.ts export
 *   index.json              ordered vector file names
 *   vectors/<name>.bin      exact wire record (length prefix included)
 *   vectors/<name>.json     expected decode result or fixed error code
 *
 * The nine `example-*` vectors reproduce R5 draft §3.12 byte-for-byte:
 * wireBytes and the 48-byte headerHex asserted in this generator must equal
 * the draft tables. */

import {
  RELAY_KIND,
  RELAY_OP,
  RELAY_TYPE,
  relayConstantsSnapshot,
} from "../../../contracts/spec/relay.ts";
import { encodeFrame, RELAY_FRAME_ERROR, type RelayFrameOptions } from "../../../framework/src/relay/frame.ts";

const ROOT = new URL(".", import.meta.url);
const VECTORS = new URL("vectors/", ROOT);

// --- vector model ------------------------------------------------------------

interface ValidExpect {
  type: number;
  codec: number;
  session: string; // 16 lowercase hex chars
  seq: number;
  stream: number;
  correlation: number;
  metaBytes: number;
  dataBytes: number;
  metadata: unknown;
  /** Uniform data fill (one hex byte repeated dataBytes times). */
  dataFillHex?: string;
  /** Exact data bytes when not uniform. */
  dataHex?: string;
}
interface ValidVector {
  name: string;
  kind: "valid";
  options?: RelayFrameOptionsJSON;
  expect: ValidExpect;
  /** When set, assert the encoded 48-byte header against draft §3.12. */
  draftHeaderHex?: string;
  draftWireBytes?: number;
}
interface InvalidVector {
  name: string;
  kind: "invalid";
  options?: RelayFrameOptionsJSON;
  errorCode: string;
}
type Vector = ValidVector | InvalidVector;

interface RelayFrameOptionsJSON {
  maxWireBytes?: number;
  maxMetaBytes?: number;
  codecs?: number[];
  session?: string;
}

// --- helpers -----------------------------------------------------------------

const SESSION = "0102030405060708";
const SID = BigInt("0x" + SESSION);

const RX_LIMITS = {
  maxWireBytes: 4096, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 32768,
  maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 2, maxScratchBytes: 262144,
};
const BULK_LIMITS = { ...RX_LIMITS, maxWireBytes: 65536, maxObjectBytes: 131072, maxScratchBytes: 524288 };
const MATERIALIZE = {
  residentRamBytes: 4194304, gpuBytes: 4194304, transientBytes: 524288,
  maxWidth: 256, maxHeight: 256, maxDecodedBytes: 131072,
};
const CONTROL_OPTS: RelayFrameOptionsJSON = { maxWireBytes: 4096, maxMetaBytes: 2048 };
const BULK_OPTS: RelayFrameOptionsJSON = { maxWireBytes: 65536, maxMetaBytes: 2048, codecs: [0, 1, 257, 258, 259, 260] };

const vectors: Vector[] = [];
function valid(v: ValidVector) { vectors.push(v); }
function invalid(v: InvalidVector) { vectors.push(v); }

function encodeOrThrow(name: string, input: Parameters<typeof encodeFrame>[0]) {
  const result = encodeFrame(input);
  if (!result.ok) throw new Error(`${name}: encode rejected: ${result.code}`);
  return result.bytes;
}


// --- legal control vectors (§3.2/§3.6) ---------------------------------------

valid({
  name: "hello",
  kind: "valid",
  options: CONTROL_OPTS,
  expect: {
    type: RELAY_TYPE.REQUEST, codec: 0, session: "0000000000000000", seq: 1, stream: 0, correlation: 1,
    metaBytes: -1, dataBytes: 0,
    metadata: {
      op: RELAY_OP.HELLO,
      versions: [[1, 0]],
      bootNonce: "00112233445566778899aabbccddeeff",
      app: "pocket-map",
      profiles: [{ name: "map.raster", version: 1 }, { name: "term.cells", version: 1 }],
      codecs: [0, 1, 257, 259],
      kinds: [RELAY_KIND.TILE, RELAY_KIND.TERMINAL_CELLS],
      rxLimits: RX_LIMITS,
      materialize: MATERIALIZE,
      transport: { id: "tcp-paired" },
    },
  },
});

valid({
  name: "hello-response",
  kind: "valid",
  options: CONTROL_OPTS,
  expect: {
    type: RELAY_TYPE.RESPONSE, codec: 0, session: "0000000000000000", seq: 1, stream: 0, correlation: 1,
    metaBytes: -1, dataBytes: 0,
    metadata: {
      op: RELAY_OP.HELLO, status: "ok", final: true,
      bootNonce: "00112233445566778899aabbccddeeff",
      peerNonce: "ffeeddccbbaa99887766554433221100",
      session: SESSION,
      selected: [1, 0],
      profiles: [{ name: "map.raster", version: 1 }],
      grants: ["pocket-map"],
      rxLimits: BULK_LIMITS,
      transport: { id: "tcp-paired" },
    },
  },
});

valid({
  name: "ready",
  kind: "valid",
  options: CONTROL_OPTS,
  expect: {
    type: RELAY_TYPE.REQUEST, codec: 0, session: SESSION, seq: 1, stream: 0, correlation: 1,
    metaBytes: -1, dataBytes: 0,
    metadata: { op: RELAY_OP.READY, selected: [1, 0] },
  },
});

valid({
  name: "ready-response",
  kind: "valid",
  options: CONTROL_OPTS,
  expect: {
    type: RELAY_TYPE.RESPONSE, codec: 0, session: SESSION, seq: 1, stream: 0, correlation: 1,
    metaBytes: -1, dataBytes: 0,
    metadata: { op: RELAY_OP.READY, status: "ok", final: true },
  },
});

valid({
  name: "open",
  kind: "valid",
  options: CONTROL_OPTS,
  expect: {
    type: RELAY_TYPE.REQUEST, codec: 0, session: SESSION, seq: 2, stream: 0, correlation: 2,
    metaBytes: -1, dataBytes: 0,
    metadata: {
      op: RELAY_OP.OPEN, app: "pocket-map", namespace: "map/demo",
      profile: { name: "map.raster", version: 1 },
      codecs: [0, 1, 257],
      rxLimits: BULK_LIMITS,
    },
  },
});

valid({
  name: "open-response",
  kind: "valid",
  options: CONTROL_OPTS,
  expect: {
    type: RELAY_TYPE.RESPONSE, codec: 0, session: SESSION, seq: 2, stream: 0, correlation: 2,
    metaBytes: -1, dataBytes: 0,
    metadata: {
      op: RELAY_OP.OPEN, status: "ok", final: true, stream: 1, namespace: "map/demo",
      profile: { name: "map.raster", version: 1 }, rxLimits: BULK_LIMITS,
    },
  },
});

valid({
  name: "ping",
  kind: "valid",
  options: CONTROL_OPTS,
  expect: {
    type: RELAY_TYPE.REQUEST, codec: 0, session: SESSION, seq: 3, stream: 0, correlation: 3,
    metaBytes: -1, dataBytes: 0,
    metadata: { op: RELAY_OP.PING, token: 12345 },
  },
});

valid({
  name: "credit",
  kind: "valid",
  options: CONTROL_OPTS,
  expect: {
    type: RELAY_TYPE.PUSH, codec: 0, session: SESSION, seq: 4, stream: 0, correlation: 0,
    metaBytes: -1, dataBytes: 0,
    metadata: {
      op: RELAY_OP.CREDIT, targetStream: 1,
      framesReleased: "0000000000000003", bytesReleased: "000000000000a000",
    },
  },
});

valid({
  name: "cancel",
  kind: "valid",
  options: CONTROL_OPTS,
  expect: {
    type: RELAY_TYPE.CANCEL, codec: 0, session: SESSION, seq: 5, stream: 0, correlation: 1,
    metaBytes: -1, dataBytes: 0,
    metadata: { op: RELAY_OP.REQUEST_CANCEL, targetStream: 2, reason: "user-dismissed" },
  },
});

valid({
  name: "invalidate",
  kind: "valid",
  options: CONTROL_OPTS,
  expect: {
    type: RELAY_TYPE.INVALIDATE, codec: 0, session: SESSION, seq: 6, stream: 0, correlation: 0,
    metaBytes: -1, dataBytes: 0,
    metadata: {
      op: RELAY_OP.RESOURCE_INVALIDATE,
      resource: {
        kind: RELAY_KIND.TILE, ns: "map/demo",
        key: "webmercator/demo-raster/z14/x2621/y6332",
        revision: "tile-v2", rendition: "r5g6b5le-256-v1",
      },
      args: { scope: "revision", reason: "source-update" },
    },
  },
});

// named get / final response / push covering the §3.6 vocabulary directly
valid({
  name: "get",
  kind: "valid",
  options: BULK_OPTS,
  expect: {
    type: RELAY_TYPE.REQUEST, codec: 0, session: SESSION, seq: 1, stream: 1, correlation: 1,
    metaBytes: -1, dataBytes: 0,
    metadata: {
      op: RELAY_OP.RESOURCE_GET,
      resource: {
        kind: RELAY_KIND.TEXTURE, ns: "app/demo", key: "icons/gear",
        rendition: "indexed8-32-v1",
      },
      args: { accept: [260], maxObjectBytes: 4096, ifRevision: "r2" },
    },
  },
});

valid({
  name: "response-final",
  kind: "valid",
  options: BULK_OPTS,
  expect: {
    type: RELAY_TYPE.RESPONSE, codec: 0, session: SESSION, seq: 1, stream: 1, correlation: 1,
    metaBytes: -1, dataBytes: 0,
    metadata: {
      op: RELAY_OP.RESOURCE_GET,
      resource: {
        kind: RELAY_KIND.TEXTURE, ns: "app/demo", key: "icons/gear",
        revision: "r3", rendition: "indexed8-32-v1",
      },
      status: "ok", final: true,
      value: { notModified: false, width: 32, height: 32 },
    },
  },
});

valid({
  name: "push",
  kind: "valid",
  options: CONTROL_OPTS,
  expect: {
    type: RELAY_TYPE.PUSH, codec: 0, session: SESSION, seq: 7, stream: 2, correlation: 0,
    metaBytes: -1, dataBytes: 0,
    metadata: {
      op: "term.grid", subscription: 7, final: true,
      resource: {
        kind: RELAY_KIND.TERMINAL_CELLS, ns: "term/demo", key: "sid-7/grid",
        revision: "g2-s11", rendition: "cells-80x24-v1",
      },
    },
  },
});

// codec 1: one strict JSON value carried in the data region [R5-P04]
valid({
  name: "data-codec1-json",
  kind: "valid",
  options: BULK_OPTS,
  expect: {
    type: RELAY_TYPE.RESPONSE, codec: 1, session: SESSION, seq: 2, stream: 4, correlation: 1,
    metaBytes: -1, dataBytes: -1,
    metadata: {
      op: "vault.rows",
      resource: {
        kind: RELAY_KIND.TEXT_LAYOUT, ns: "vault/demo", key: "note-9/rows",
        revision: "content1", rendition: "runs-w376-fontset1-v1",
      },
      status: "ok", final: true,
    },
    dataHex: Buffer.from(JSON.stringify({ rows: [[0, "Relay", 0]], next: 1, total: 3 })).toString("hex"),
  },
});

// --- the nine draft §3.12 examples (byte-pinned) ------------------------------

const mapResource = {
  kind: 1, ns: "map/demo", key: "webmercator/demo-raster/z14/x2621/y6332",
  revision: "tile-v1", rendition: "r5g6b5le-256-v1",
};
const termResource = { kind: 6, ns: "term/demo", key: "sid-7/grid", revision: "g2-s10", rendition: "cells-80x24-v1" };
const vaultResource = {
  kind: 4, ns: "vault/demo", key: "note-42/rows/0/count/1",
  revision: "content7-layout12", rendition: "runs-w376-fontset1-v1",
};
const mapDigest = "sha256:fa43239bcee7b97ca62f007cc68487560a39e19f74f3dde7486db3f98df8e471";

interface DraftCase {
  name: string;
  type: number;
  codec: number;
  seq: number;
  stream: number;
  correlation: number;
  meta: Record<string, unknown>;
  dataBytes: number;
  options: RelayFrameOptionsJSON;
  headerHex: string;
  wireBytes: number;
}

const draftCases: DraftCase[] = [
  {
    name: "example-map.get", type: 1, codec: 0, seq: 1, stream: 1, correlation: 1, dataBytes: 0,
    options: CONTROL_OPTS,
    meta: {
      op: "resource.get", resource: mapResource,
      args: { accept: [257], maxObjectBytes: 131072 }, budgetMs: 9000,
    },
    headerHex: "0a 01 00 00 50 52 4c 59 01 00 01 00 30 00 00 00 08 07 06 05 04 03 02 01 01 00 00 00 01 00 00 00 01 00 00 00 de 00 00 00 00 00 00 00 00 00 00 00",
    wireBytes: 270,
  },
  {
    name: "example-map.chunk1", type: 2, codec: 257, seq: 1, stream: 1, correlation: 1, dataBytes: 61440,
    options: BULK_OPTS,
    meta: {
      op: "resource.get", resource: mapResource, status: "ok", final: false,
      value: { width: 256, height: 256, logicalSize: 256 },
      transfer: { id: 1, offset: "0000000000000000", total: "0000000000020000" },
      digest: mapDigest,
    },
    headerHex: "b9 f1 00 00 50 52 4c 59 01 00 02 00 30 00 01 01 08 07 06 05 04 03 02 01 01 00 00 00 01 00 00 00 01 00 00 00 8d 01 00 00 00 f0 00 00 00 00 00 00",
    wireBytes: 61885,
  },
  {
    name: "example-map.chunk2", type: 2, codec: 257, seq: 2, stream: 1, correlation: 1, dataBytes: 61440,
    options: BULK_OPTS,
    meta: {
      op: "resource.get", resource: mapResource, status: "ok", final: false,
      value: { width: 256, height: 256, logicalSize: 256 },
      transfer: { id: 1, offset: "000000000000f000", total: "0000000000020000" },
      digest: mapDigest,
    },
    headerHex: "b9 f1 00 00 50 52 4c 59 01 00 02 00 30 00 01 01 08 07 06 05 04 03 02 01 02 00 00 00 01 00 00 00 01 00 00 00 8d 01 00 00 00 f0 00 00 00 00 00 00",
    wireBytes: 61885,
  },
  {
    name: "example-map.chunk3", type: 2, codec: 257, seq: 3, stream: 1, correlation: 1, dataBytes: 8192,
    options: BULK_OPTS,
    meta: {
      op: "resource.get", resource: mapResource, status: "ok", final: true,
      value: { width: 256, height: 256, logicalSize: 256 },
      transfer: { id: 1, offset: "000000000001e000", total: "0000000000020000" },
      digest: mapDigest,
    },
    headerHex: "b8 21 00 00 50 52 4c 59 01 00 02 00 30 00 01 01 08 07 06 05 04 03 02 01 03 00 00 00 01 00 00 00 01 00 00 00 8c 01 00 00 00 20 00 00 00 00 00 00",
    wireBytes: 8636,
  },
  {
    name: "example-term.subscribe", type: 1, codec: 0, seq: 1, stream: 2, correlation: 1, dataBytes: 0,
    options: CONTROL_OPTS,
    meta: {
      op: "resource.subscribe", resource: termResource,
      args: { delivery: "reliable-delta" },
    },
    headerHex: "d7 00 00 00 50 52 4c 59 01 00 01 00 30 00 00 00 08 07 06 05 04 03 02 01 01 00 00 00 02 00 00 00 01 00 00 00 ab 00 00 00 00 00 00 00 00 00 00 00",
    wireBytes: 219,
  },
  {
    name: "example-term.subscribed", type: 2, codec: 0, seq: 1, stream: 2, correlation: 1, dataBytes: 0,
    options: CONTROL_OPTS,
    meta: {
      op: "resource.subscribe", resource: termResource,
      status: "ok", final: true, value: { subscription: 7 },
    },
    headerHex: "e8 00 00 00 50 52 4c 59 01 00 02 00 30 00 00 00 08 07 06 05 04 03 02 01 01 00 00 00 02 00 00 00 01 00 00 00 bc 00 00 00 00 00 00 00 00 00 00 00",
    wireBytes: 236,
  },
  {
    name: "example-term.grid", type: 3, codec: 0, seq: 2, stream: 2, correlation: 0, dataBytes: 0,
    options: CONTROL_OPTS,
    meta: {
      op: "term.grid", resource: termResource, subscription: 7, final: true,
      value: {
        sid: 7, gen: 2, gridSeq: 10, mode: "snapshot", cols: 80, rows: 24,
        defaultCell: [32, -1, -1],
        rowUpdates: [[0, [0, "relay ready", -1, -1]]],
        cursor: [11, 0, 1],
        inputEpoch: "0000000000000002", ackInputSeq: "0000000000000016",
      },
    },
    headerHex: "ab 01 00 00 50 52 4c 59 01 00 03 00 30 00 00 00 08 07 06 05 04 03 02 01 02 00 00 00 02 00 00 00 00 00 00 00 7f 01 00 00 00 00 00 00 00 00 00 00",
    wireBytes: 431,
  },
  {
    name: "example-vault.rows", type: 1, codec: 0, seq: 1, stream: 3, correlation: 1, dataBytes: 0,
    options: CONTROL_OPTS,
    meta: {
      op: "resource.get", resource: vaultResource,
      args: { first: 0, count: 1, maxObjectBytes: 4096 },
    },
    headerHex: "fe 00 00 00 50 52 4c 59 01 00 01 00 30 00 00 00 08 07 06 05 04 03 02 01 01 00 00 00 03 00 00 00 01 00 00 00 d2 00 00 00 00 00 00 00 00 00 00 00",
    wireBytes: 258,
  },
  {
    name: "example-vault.layout", type: 2, codec: 0, seq: 1, stream: 3, correlation: 1, dataBytes: 0,
    options: CONTROL_OPTS,
    meta: {
      op: "resource.get", resource: vaultResource, status: "ok", final: true,
      value: {
        mode: "positioned-source-runs", width: 376, offsetUnit: "utf16",
        rows: [{ index: 0, k: 0, l: 0, s: 0, height: 18, r: [[0, "Relay", 0], [80, "协议", 1]] }],
        next: 1, total: 32,
      },
    },
    headerHex: "9c 01 00 00 50 52 4c 59 01 00 02 00 30 00 00 00 08 07 06 05 04 03 02 01 01 00 00 00 03 00 00 00 01 00 00 00 70 01 00 00 00 00 00 00 00 00 00 00",
    wireBytes: 416,
  },
];

for (const c of draftCases) {
  const data = new Uint8Array(c.dataBytes);
  const bytes = encodeOrThrow(c.name, {
    type: c.type, codec: c.codec, session: SID, seq: c.seq, stream: c.stream,
    correlation: c.correlation, metadata: c.meta, data,
  });
  const headerHex = Buffer.from(bytes.subarray(0, 48)).toString("hex").match(/.{2}/g)!.join(" ");
  if (headerHex !== c.headerHex) {
    throw new Error(`${c.name}: header drift from draft §3.12\n got ${headerHex}\nwant ${c.headerHex}`);
  }
  if (bytes.length !== c.wireBytes) throw new Error(`${c.name}: wire ${bytes.length} != ${c.wireBytes}`);
  valid({
    name: c.name,
    kind: "valid",
    options: c.options,
    expect: {
      type: c.type, codec: c.codec, session: SESSION, seq: c.seq, stream: c.stream,
      correlation: c.correlation, metaBytes: -1, dataBytes: c.dataBytes,
      metadata: c.meta,
      ...(c.dataBytes ? { dataFillHex: "00" } : {}),
    },
    draftHeaderHex: c.headerHex,
    draftWireBytes: c.wireBytes,
  });
}

// --- invalid vectors ----------------------------------------------------------


// Each invalid vector ships a complete standalone .bin built here; base bytes
// come from named/legal vectors and are then mutated exactly once (or cut).
function invalidFromBase(opts: {
  name: string;
  base: ValidVector;
  baseBytes: Uint8Array;
  mutate?: (b: Uint8Array) => Uint8Array | void;
  truncate?: number;
  options?: RelayFrameOptionsJSON;
  errorCode: string;
}) {
  const copy = new Uint8Array(opts.baseBytes.length);
  copy.set(opts.baseBytes);
  const grown = opts.mutate?.(copy);
  const b = (grown ? new Uint8Array(grown) : copy);
  const bin = opts.truncate !== undefined ? b.subarray(0, opts.truncate) : b;
  invalid({
    name: opts.name, kind: "invalid",
    options: opts.options ?? opts.base.options,
    errorCode: opts.errorCode,
  });
  pendingBins.set(opts.name, bin);
}

const pendingBins = new Map<string, Uint8Array>();

// Build bins for the named/valid vectors first so mutations can reference one.
const legalBins = new Map<string, Uint8Array>();
function legalBytes(v: ValidVector): Uint8Array {
  const cached = legalBins.get(v.name);
  if (cached) return cached;
  const e = v.expect;
  let data: Uint8Array = new Uint8Array(0);
  if (e.dataHex) {
    data = Buffer.from(e.dataHex, "hex");
  } else if (e.dataBytes > 0) {
    if (!e.dataFillHex) throw new Error(`${v.name}: dataBytes without fill/hex`);
    data = new Uint8Array(e.dataBytes).fill(parseInt(e.dataFillHex, 16));
  }
  const session = e.session === "0000000000000000" ? 0n : BigInt("0x" + e.session);
  const bytes = encodeOrThrow(v.name, {
    type: e.type, codec: e.codec, session, seq: e.seq, stream: e.stream,
    correlation: e.correlation, metadata: e.metadata as Record<string, unknown>, data,
  });
  legalBins.set(v.name, bytes);
  return bytes;
}

const hello = vectors.find(v => v.name === "hello") as ValidVector;
const mapGet = vectors.find(v => v.name === "example-map.get") as ValidVector;
const ping = vectors.find(v => v.name === "ping") as ValidVector;
const chunk1 = vectors.find(v => v.name === "example-map.chunk1") as ValidVector;

const helloBytes = legalBytes(hello);
const mapGetBytes = legalBytes(mapGet);
const pingBytes = legalBytes(ping);
const chunkBytes = legalBytes(chunk1);

const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

invalidFromBase({ name: "bad-magic", base: mapGet, baseBytes: mapGetBytes, mutate: b => b.set(Buffer.from("NOPE"), 4), errorCode: RELAY_FRAME_ERROR.BAD_MAGIC });
invalidFromBase({ name: "bad-major", base: mapGet, baseBytes: mapGetBytes, mutate: b => { b[8] = 2; }, errorCode: RELAY_FRAME_ERROR.BAD_VERSION });
invalidFromBase({ name: "bad-minor", base: mapGet, baseBytes: mapGetBytes, mutate: b => { b[9] = 1; }, errorCode: RELAY_FRAME_ERROR.BAD_VERSION });
invalidFromBase({ name: "bad-type", base: mapGet, baseBytes: mapGetBytes, mutate: b => { b[10] = 6; }, errorCode: RELAY_FRAME_ERROR.BAD_TYPE });
invalidFromBase({ name: "bad-flags", base: mapGet, baseBytes: mapGetBytes, mutate: b => { b[11] = 0x80; }, errorCode: RELAY_FRAME_ERROR.BAD_FLAGS });
invalidFromBase({ name: "bad-header-size", base: mapGet, baseBytes: mapGetBytes, mutate: b => b.set(u32le(47).subarray(0, 2), 12), errorCode: RELAY_FRAME_ERROR.BAD_HEADER_SIZE });
invalidFromBase({ name: "bad-reserved", base: mapGet, baseBytes: mapGetBytes, mutate: b => b.set(u32le(1), 44), errorCode: RELAY_FRAME_ERROR.BAD_RESERVED });
invalidFromBase({
  name: "length-inequality", base: mapGet, baseBytes: mapGetBytes,
  // Bump frameBytes and append the matching byte so total wire length stays
  // consistent; the header equation frameBytes == 44+meta+data then fails.
  mutate: b => {
    const out = Buffer.concat([Buffer.from(b), Buffer.from([0])]);
    out.set(u32le(new DataView(out.buffer, out.byteOffset).getUint32(0, true) + 1), 0);
    return out;
  },
  errorCode: RELAY_FRAME_ERROR.BAD_LENGTH,
});
invalidFromBase({ name: "truncated", base: mapGet, baseBytes: mapGetBytes, truncate: mapGetBytes.length - 1, errorCode: RELAY_FRAME_ERROR.TRUNCATED });
invalidFromBase({ name: "short-header", base: mapGet, baseBytes: mapGetBytes, truncate: 16, errorCode: RELAY_FRAME_ERROR.SHORT_HEADER });
invalidFromBase({
  name: "wire-too-large", base: mapGet, baseBytes: mapGetBytes,
  options: { maxWireBytes: 100, maxMetaBytes: 2048 },
  errorCode: RELAY_FRAME_ERROR.WIRE_TOO_LARGE,
});
invalidFromBase({
  name: "meta-too-large", base: mapGet, baseBytes: mapGetBytes,
  options: { maxWireBytes: 4096, maxMetaBytes: 10 },
  errorCode: RELAY_FRAME_ERROR.META_TOO_LARGE,
});
invalidFromBase({ name: "bad-session-pin", base: mapGet, baseBytes: mapGetBytes, options: { ...CONTROL_OPTS, session: "0000000000000099" }, errorCode: RELAY_FRAME_ERROR.BAD_SESSION });
invalidFromBase({ name: "seq-zero", base: mapGet, baseBytes: mapGetBytes, mutate: b => b.set(u32le(0), 24), errorCode: RELAY_FRAME_ERROR.BAD_SEQ });
invalidFromBase({ name: "correlation-zero-request", base: mapGet, baseBytes: mapGetBytes, mutate: b => b.set(u32le(0), 32), errorCode: RELAY_FRAME_ERROR.BAD_CORRELATION });
// §3.6: a CANCEL rides the control stream and names its target in
// metadata.targetStream. The legal cancel vector with header bytes 28..32
// (stream) set to 1; the rule is a header field, so it is BAD_CORRELATION in
// all three frame layers rather than an envelope error.
const cancel = vectors.find(v => v.name === "cancel") as ValidVector;
invalidFromBase({ name: "cancel-nonzero-stream", base: cancel, baseBytes: legalBytes(cancel), mutate: b => b.set(u32le(1), 28), errorCode: RELAY_FRAME_ERROR.BAD_CORRELATION });
invalidFromBase({ name: "codec-not-negotiated", base: chunk1, baseBytes: chunkBytes, mutate: b => { /* 257 stays; options restrict */ }, options: { maxWireBytes: 65536, maxMetaBytes: 2048, codecs: [0] }, errorCode: RELAY_FRAME_ERROR.BAD_CODEC });
invalidFromBase({
  name: "codec0-with-data", base: mapGet, baseBytes: mapGetBytes,
  // Codec 0 but dataBytes 1: append the byte so the length equation holds;
  // the codec/data mismatch is what must reject.
  mutate: b => {
    const out = Buffer.concat([Buffer.from(b), Buffer.from([0])]);
    out.set(u32le(1), 40); // dataBytes = 1
    out.set(u32le(new DataView(out.buffer, out.byteOffset).getUint32(0, true) + 1), 0);
    return out;
  },
  errorCode: RELAY_FRAME_ERROR.BAD_CODEC,
});

// Metadata-text corruptions: rebuild the frame from hello so the JSON region
// edits survive even when they change metaBytes-independent length math.
function metadataCorruption(opts: { name: string; body: (metaStart: number, metaEnd: number, b: Uint8Array) => Uint8Array | void; errorCode: string }) {
  const base = new Uint8Array(helloBytes.length);
  base.set(helloBytes);
  const metaStart = 48;
  const metaEnd = metaStart + new DataView(base.buffer, base.byteOffset).getUint32(36, true);
  const out = opts.body(metaStart, metaEnd, base) ?? base;
  invalid({ name: opts.name, kind: "invalid", options: CONTROL_OPTS, errorCode: opts.errorCode });
  pendingBins.set(opts.name, out);
}
metadataCorruption({
  name: "meta-not-utf8",
  body: (s, e, b) => {
    // Replace the first metadata string's opening content byte with 0xFF.
    const idx = Buffer.from(b).indexOf(Buffer.from('"relay.hello"'), s);
    b[idx + 8] = 0xff; // inside the ASCII name -> invalid UTF-8
  },
  errorCode: RELAY_FRAME_ERROR.BAD_METADATA,
});
// The UTF-8 rule covers exactly the metaBytes region. Built from a frame that
// carries data: the metadata's closing brace becomes a two-byte lead and the
// first data byte becomes its continuation byte, so a validator that scanned
// past the region boundary would see one well-formed sequence and accept.
const codec1 = vectors.find(v => v.name === "data-codec1-json") as ValidVector;
const codec1Bytes = legalBytes(codec1);
invalidFromBase({
  name: "meta-utf8-cut-at-data", base: codec1, baseBytes: codec1Bytes,
  mutate: b => {
    const metaEnd = 48 + new DataView(b.buffer, b.byteOffset).getUint32(36, true);
    b[metaEnd - 1] = 0xc3; // last metadata byte: a lead that needs one more
    b[metaEnd] = 0xa9;     // first data byte: the continuation that would complete it
  },
  errorCode: RELAY_FRAME_ERROR.BAD_METADATA,
});
metadataCorruption({
  name: "meta-duplicate-key",
  body: (s, e, b) => {
    const injected = Buffer.from(',"op":"relay.ready"');
    // Insert before the metadata closing brace so the second "op" is a
    // genuine duplicate object key.
    const out = Buffer.concat([Buffer.from(b.subarray(0, e - 1)), injected, Buffer.from(b.subarray(e - 1))]);
    const dv = new DataView(out.buffer, out.byteOffset);
    dv.setUint32(0, dv.getUint32(0, true) + injected.length, true);
    dv.setUint32(36, dv.getUint32(36, true) + injected.length, true);
    return out;
  },
  errorCode: RELAY_FRAME_ERROR.BAD_METADATA,
});
metadataCorruption({
  name: "meta-float-number",
  body: (s, e, b) => {
    // 4096 is the first u32 limit value; 4.50 is same length, fractional.
    const idx = Buffer.from(b).indexOf(Buffer.from("4096"), s);
    if (idx < 0) throw new Error("float vector: 4096 token missing");
    b.set(Buffer.from("4.50"), idx);
  },
  errorCode: RELAY_FRAME_ERROR.BAD_METADATA,
});
metadataCorruption({
  name: "meta-nan",
  body: (s, e, b) => {
    // 32768 (windowBytes) is a 5-char token; "NaN00" begins with bare NaN.
    const idx = Buffer.from(b).indexOf(Buffer.from("32768"), s);
    if (idx < 0) throw new Error("nan vector: 32768 token missing");
    b.set(Buffer.from("NaN00"), idx);
  },
  errorCode: RELAY_FRAME_ERROR.BAD_METADATA,
});
metadataCorruption({
  name: "meta-lone-surrogate",
  body: (s, e, b) => {
    // Replace the app name value with a string containing \ud800.
    const needle = Buffer.from('"pocket-map"');
    const idx = Buffer.from(b).indexOf(needle, s);
    const replacement = Buffer.from('"\\ud800"');
    const out = Buffer.concat([
      Buffer.from(b.subarray(0, idx)),
      replacement,
      Buffer.from(b.subarray(idx + needle.length)),
    ]);
    const delta = replacement.length - needle.length;
    const dv = new DataView(out.buffer, out.byteOffset);
    dv.setUint32(0, dv.getUint32(0, true) + delta, true);
    dv.setUint32(36, dv.getUint32(36, true) + delta, true);
    return out;
  },
  errorCode: RELAY_FRAME_ERROR.BAD_METADATA,
});
metadataCorruption({
  name: "envelope-response-no-final",
  body: (s, e, b) => {
    // Turn hello (REQUEST) into a RESPONSE whose metadata lacks status/final.
    b[10] = RELAY_TYPE.RESPONSE;
  },
  errorCode: RELAY_FRAME_ERROR.BAD_ENVELOPE,
});


// --- write outputs -------------------------------------------------------------

await Bun.$`rm -rf ${VECTORS}`.quiet();
await Bun.$`mkdir -p ${VECTORS}`.quiet();

const index: string[] = [];
let validCount = 0;
let invalidCount = 0;

for (const v of vectors) {
  index.push(v.name);
  const bin = v.kind === "valid" ? legalBytes(v) : pendingBins.get(v.name)!;
  await Bun.write(new URL(`vectors/${v.name}.bin`, ROOT), bin);

  if (v.kind === "valid") {
    validCount++;
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const metaBytes = dv.getUint32(36, true);
    const dataBytes = dv.getUint32(40, true);
    // Fill in the byte counts the case author left as -1.
    v.expect.metaBytes = metaBytes;
    v.expect.dataBytes = dataBytes;
    const json = {
      name: v.name, kind: "valid", file: `vectors/${v.name}.bin`, wireBytes: bin.length,
      options: v.options ?? {},
      expect: v.expect,
      ...(v.draftHeaderHex ? { draft: { headerHex: v.draftHeaderHex, wireBytes: v.draftWireBytes } } : {}),
    };
    await Bun.write(new URL(`vectors/${v.name}.json`, ROOT), JSON.stringify(json, null, 2) + "\n");
  } else {
    invalidCount++;
    const json = {
      name: v.name, kind: "invalid", file: `vectors/${v.name}.bin`, wireBytes: bin.length,
      options: v.options ?? {},
      errorCode: v.errorCode,
    };
    await Bun.write(new URL(`vectors/${v.name}.json`, ROOT), JSON.stringify(json, null, 2) + "\n");
  }
}

await Bun.write(new URL("index.json", ROOT), JSON.stringify({ vectors: index }, null, 2) + "\n");
await Bun.write(new URL("constants.json", ROOT), JSON.stringify(relayConstantsSnapshot(), null, 2) + "\n");
console.log(`relay vectors: ${validCount} valid, ${invalidCount} invalid, ${index.length} total`);
