import { expect, test } from "bun:test";
import { decodeFrame, encodeFrame, encodePreparedFrame, prepareFrameBody, RelayRecordDecoder } from "../framework/src/relay/frame.ts";
import {
  RELAY_DELIVERY,
  RELAY_EVICT_REASON,
  RELAY_FRAME,
  RELAY_FRAME_ERROR,
  RELAY_HEADER,
  RELAY_INVALIDATE_SCOPE,
  relayConstantsSnapshot,
} from "../contracts/spec/relay.ts";

const FIX = new URL("./fixtures/relay/", import.meta.url);
const indexJson = await Bun.file(new URL("index.json", FIX)).json() as { vectors: string[] };

interface VectorSpec {
  name: string;
  kind: "valid" | "invalid";
  file: string;
  wireBytes: number;
  options?: { maxWireBytes?: number; maxMetaBytes?: number; codecs?: number[]; session?: string };
  errorCode?: string;
  expect?: {
    type: number; codec: number; session: string; seq: number; stream: number;
    correlation: number; metaBytes: number; dataBytes: number; metadata: unknown;
    dataFillHex?: string; dataHex?: string;
  };
}

async function loadVector(name: string): Promise<{ spec: VectorSpec; bin: Uint8Array }> {
  const spec = await Bun.file(new URL(`vectors/${name}.json`, FIX)).json() as VectorSpec;
  const bin = new Uint8Array(await Bun.file(new URL(spec.file, FIX)).arrayBuffer());
  return { spec, bin };
}

function decodeOptions(spec: VectorSpec) {
  const opts: Parameters<typeof decodeFrame>[1] = {};
  if (spec.options?.maxWireBytes !== undefined) opts.maxWireBytes = spec.options.maxWireBytes;
  if (spec.options?.maxMetaBytes !== undefined) opts.maxMetaBytes = spec.options.maxMetaBytes;
  if (spec.options?.codecs) opts.codecs = spec.options.codecs;
  if (spec.options?.session) opts.session = BigInt("0x" + spec.options.session);
  return opts;
}

test("every legal byte vector decodes to its pinned result", async () => {
  for (const name of indexJson.vectors) {
    const { spec, bin } = await loadVector(name);
    if (spec.kind !== "valid") continue;
    const result = decodeFrame(bin, decodeOptions(spec));
    if (!result.ok) throw new Error(`${name}: rejected ${result.code}`);
    const f = result.frame, e = spec.expect!;
    expect(bin.length).toBe(spec.wireBytes);
    expect(f.type).toBe(e.type);
    expect(f.codec).toBe(e.codec);
    expect(f.session).toBe(BigInt("0x" + e.session));
    expect(f.seq).toBe(e.seq);
    expect(f.stream).toBe(e.stream);
    expect(f.correlation).toBe(e.correlation);
    expect(f.data.length).toBe(e.dataBytes);
    expect(JSON.stringify(f.metadata)).toBe(JSON.stringify(e.metadata));
    if (e.dataFillHex) {
      const fill = parseInt(e.dataFillHex, 16);
      expect(f.data.every((b) => b === fill)).toBe(true);
    }
    if (e.dataHex) expect(Buffer.from(f.data).toString("hex")).toBe(e.dataHex);
  }
});

test("every invalid byte vector rejects with exactly its fixed code", async () => {
  for (const name of indexJson.vectors) {
    const { spec, bin } = await loadVector(name);
    if (spec.kind !== "invalid") continue;
    const result = decodeFrame(bin, decodeOptions(spec));
    expect(result.ok, `${name} should reject`).toBe(false);
    if (!result.ok) expect(result.code === spec.errorCode, `${name}: got ${result.code}`).toBe(true);
  }
});

test("decoding then re-encoding every legal vector is byte-identical", async () => {
  for (const name of indexJson.vectors) {
    const { spec, bin } = await loadVector(name);
    if (spec.kind !== "valid") continue;
    const decoded = decodeFrame(bin, decodeOptions(spec));
    if (!decoded.ok) throw new Error(`${name}: rejected ${decoded.code}`);
    const f = decoded.frame;
    const again = encodeFrame(
      {
        type: f.type, codec: f.codec, session: f.session, seq: f.seq, stream: f.stream,
        correlation: f.correlation, metadata: f.metadata as Record<string, unknown>, data: f.data,
      },
      decodeOptions(spec),
    );
    if (!again.ok) throw new Error(`${name}: re-encode rejected ${again.code}`);
    expect(Buffer.compare(Buffer.from(again.bytes), Buffer.from(bin))).toBe(0);
  }
});

test("the prepared-frame path refuses a CANCEL off stream 0 with the vector's code", async () => {
  // §3.6: a CANCEL rides header stream 0. cancel-nonzero-stream pins
  // BAD_CORRELATION for decodeFrame; prepareFrameBody fixes the stream before
  // encodePreparedFrame stamps seq/correlation, so it must give the same
  // answer, and the legal cancel must still reproduce its committed bytes.
  const { spec, bin } = await loadVector("cancel");
  const f = spec.expect!;
  const body = { type: f.type, codec: f.codec, metadata: f.metadata as Record<string, unknown> };
  const refused = prepareFrameBody({ ...body, stream: 1 }, decodeOptions(spec));
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.code).toBe(RELAY_FRAME_ERROR.BAD_CORRELATION);
  const oneShot = encodeFrame({ ...body, stream: 1, session: BigInt("0x" + f.session), seq: f.seq, correlation: f.correlation }, decodeOptions(spec));
  expect(oneShot.ok).toBe(false);
  if (!oneShot.ok) expect(oneShot.code).toBe(RELAY_FRAME_ERROR.BAD_CORRELATION);

  const prepared = prepareFrameBody({ ...body, stream: 0 }, decodeOptions(spec));
  if (!prepared.ok) throw new Error(`legal cancel rejected at prepare: ${prepared.code}`);
  const encoded = encodePreparedFrame(prepared.body, { session: BigInt("0x" + f.session), seq: f.seq, correlation: f.correlation });
  if (!encoded.ok) throw new Error(`legal cancel rejected at encode: ${encoded.code}`);
  expect(Buffer.compare(Buffer.from(encoded.bytes), Buffer.from(bin))).toBe(0);
});

// --- property tests with a deterministic PRNG (reproducible, no flake) --------

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMetadata(rnd: () => number, depth: number): unknown {
  const roll = rnd();
  if (depth > 3) return rnd() < 0.5 ? randomInt(rnd) : randomString(rnd);
  if (roll < 0.3) return randomInt(rnd);
  if (roll < 0.5) return randomString(rnd);
  if (roll < 0.6) return rnd() < 0.5;
  if (roll < 0.8) {
    const n = Math.floor(rnd() * 5);
    return Array.from({ length: n }, () => randomMetadata(rnd, depth + 1));
  }
  const out: Record<string, unknown> = {};
  const n = Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) out["k" + i] = randomMetadata(rnd, depth + 1);
  return out;
}
function randomInt(rnd: () => number) {
  // stay a safe integer; exercise negatives and zero
  return Math.floor(rnd() * 2_000_000) - 1_000_000;
}
function randomString(rnd: () => number) {
  const alphabet = ["a", "b", "z", "0", ".", "_", "-", " ", "café", "协议", "🎮", "𝕏", "\n", '"', "\\"];
  let s = "";
  const n = Math.floor(rnd() * 8);
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
  return s;
}

test("round-trip property: 300 random metadata/data frames encode and decode identically", () => {
  const rnd = mulberry32(0x52454c41);
  for (let i = 0; i < 300; i++) {
    const useData = rnd() < 0.5;
    const codec = useData ? 1 : 0;
    const data = useData ? Uint8Array.from({ length: Math.floor(rnd() * 64) }, () => Math.floor(rnd() * 256)) : new Uint8Array(0);
    // Root metadata must stay an object; wrap a scalar result under `v`
    // instead of spreading it (string spread would index surrogate pairs).
    const randomRoot = randomMetadata(rnd, 0);
    const metadata: Record<string, unknown> = { op: "resource.get" };
    if (randomRoot !== null && typeof randomRoot === "object" && !Array.isArray(randomRoot)) {
      Object.assign(metadata, randomRoot);
    } else {
      metadata.v = randomRoot;
    }
    const encoded = encodeFrame({
      type: 1, codec, session: (BigInt(Math.floor(rnd() * 0xffffffff)) << 32n) | BigInt(Math.floor(rnd() * 0xffffffff)),
      seq: 1 + Math.floor(rnd() * 1000), stream: Math.floor(rnd() * 8),
      correlation: 1 + Math.floor(rnd() * 1000),
      metadata, data,
    }, { maxWireBytes: 65536, maxMetaBytes: 4096, codecs: [0, 1] });
    if (!encoded.ok) throw new Error(`iter ${i}: encode rejected ${encoded.code}`);
    const decoded = decodeFrame(encoded.bytes, { codecs: [0, 1] });
    if (!decoded.ok) throw new Error(`iter ${i}: decode rejected ${decoded.code}`);
    expect(decoded.frame.type).toBe(1);
    expect(decoded.frame.codec).toBe(codec);
    expect(JSON.stringify(decoded.frame.metadata)).toBe(JSON.stringify(metadata));
    expect(Buffer.compare(Buffer.from(decoded.frame.data), Buffer.from(data))).toBe(0);
  }
});

test("single-byte mutation of any header byte changes or rejects the frame", async () => {
  const { bin } = await loadVector("example-term.grid");
  const baseline = decodeFrame(bin, { maxWireBytes: 4096 });
  if (!baseline.ok) throw new Error("baseline should decode");
  for (let offset = 0; offset < RELAY_FRAME.headerBytes; offset++) {
    for (const bit of [0x01, 0x80]) {
      const mutated = bin.slice();
      mutated[offset] ^= bit;
      if (mutated[offset] === bin[offset]) continue;
      const result = decodeFrame(mutated, { maxWireBytes: 4096 });
      const identical = result.ok
        && result.frame.type === baseline.frame.type
        && result.frame.codec === baseline.frame.codec
        && result.frame.session === baseline.frame.session
        && result.frame.seq === baseline.frame.seq
        && result.frame.stream === baseline.frame.stream
        && result.frame.correlation === baseline.frame.correlation
        && JSON.stringify(result.frame.metadata) === JSON.stringify(baseline.frame.metadata);
      expect(identical, `offset ${offset} bit ${bit} left the frame unchanged`).toBe(false);
    }
  }
});

test("mutating one validated field is rejected (the test would go red if validation were removed)", async () => {
  const { bin } = await loadVector("example-map.get");
  const flip = (offset: number, value: number) => {
    const b = bin.slice();
    b[offset] = value;
    return b;
  };
  expect(decodeFrame(flip(RELAY_HEADER.flags.offset, 1)).ok).toBe(false);
  expect(decodeFrame(bin.slice().fill(0x58, RELAY_HEADER.magic.offset, RELAY_HEADER.magic.offset + 4)).ok).toBe(false);
  const bigger = bin.slice();
  new DataView(bigger.buffer).setUint32(RELAY_HEADER.metaBytes.offset, 9999, true);
  expect(decodeFrame(bigger, { maxMetaBytes: 2048 }).ok).toBe(false);
});

test("record decoder reassembles fragmented and coalesced records, split every width 1..512", async () => {
  const a = (await loadVector("ping")).bin;
  const b = (await loadVector("credit")).bin;
  const stream = Buffer.concat([Buffer.from(a), Buffer.from(b)]);
  for (let width = 1; width <= 512; width++) {
    const decoder = new RelayRecordDecoder(4096);
    const out: Uint8Array[] = [];
    for (let i = 0; i < stream.length; i += width) {
      const pushed = decoder.push(stream.subarray(i, i + width));
      expect(pushed.ok, `width ${width}: ${pushed.code}`).toBe(true);
      out.push(...pushed.frames);
    }
    expect(out.length).toBe(2);
    expect(Buffer.compare(Buffer.from(out[0]), Buffer.from(a))).toBe(0);
    expect(Buffer.compare(Buffer.from(out[1]), Buffer.from(b))).toBe(0);
  }
});

test("record decoder rejects an oversized length prefix without buffering it", () => {
  const decoder = new RelayRecordDecoder(4096);
  const forged = new Uint8Array(48);
  new DataView(forged.buffer).setUint32(0, 0x00100000, true); // frameBytes far over cap
  const pushed = decoder.push(forged);
  expect(pushed.ok).toBe(false);
});

test("benchmark: encode + decode 10,000 small frames", () => {
  const metadata = { op: "relay.ping", token: 42, note: "benchmark" };
  const input = {
    type: 1 as const, codec: 0, session: 0x0102030405060708n, seq: 1, stream: 0,
    correlation: 1, metadata,
  };
  const first = encodeFrame(input);
  if (!first.ok) throw new Error(first.code);
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    const enc = encodeFrame(input);
    if (!enc.ok) throw new Error(enc.code);
    const dec = decodeFrame(enc.bytes);
    if (!dec.ok) throw new Error(dec.code);
  }
  const ms = performance.now() - start;
  console.log(`relay encode+decode 10000 frames: ${ms.toFixed(1)} ms (${(ms / 10_000 * 1000).toFixed(2)} µs/frame)`);
  expect(ms).toBeLessThan(5000);
});

// Review 1070 N2: the L2 string enums are part of the cross-language
// snapshot, so tests/contract.ts detects drift in them like any other family.
test("the constants snapshot carries the L2 delivery, invalidate-scope and evict-reason enums", async () => {
  const snapshot = relayConstantsSnapshot();
  expect(snapshot.delivery).toEqual(RELAY_DELIVERY);
  expect(snapshot.invalidateScope).toEqual(RELAY_INVALIDATE_SCOPE);
  expect(snapshot.evictReason).toEqual(RELAY_EVICT_REASON);
  const committed = await Bun.file(new URL("constants.json", FIX)).json() as Record<string, unknown>;
  expect(committed.delivery).toEqual(RELAY_DELIVERY);
  expect(committed.invalidateScope).toEqual(RELAY_INVALIDATE_SCOPE);
  expect(committed.evictReason).toEqual(RELAY_EVICT_REASON);
});
