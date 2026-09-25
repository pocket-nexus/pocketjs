/** Relay L1 frame codec — pure encode/decode over Uint8Array.
 *
 * Wire layout (R5 draft §3.3): 4-byte LE length prefix + 48-byte fixed
 * header + strict UTF-8 JSON metadata + raw data. Every integer is
 * little-endian. session is u64 and stays a JS bigint; it never crosses
 * Number.
 *
 * Failures carry fixed codes (RELAY_FRAME_ERROR), never thrown strings:
 *   encodeFrame(input, opts?) -> { ok: true, bytes } | { ok: false, code }
 *   decodeFrame(record, opts?) -> { ok: true, frame } | { ok: false, code }
 *
 * The receiver's limits (maxWireBytes/maxMetaBytes) are checked before the
 * payload is trusted. RelayRecordDecoder validates the length prefix against
 * maxWireBytes before growing its single assembly buffer, so split or
 * coalesced TCP input cannot force an allocation from a forged prefix. */

import {
  RELAY_CODEC,
  RELAY_DEFINED_CODECS,
  RELAY_FRAME,
  RELAY_FRAME_ERROR,
  RELAY_HEADER,
  RELAY_LIMITS,
  RELAY_OP,
  RELAY_STATUS,
  RELAY_TYPE,
  type RelayFrameErrorCode,
} from "../../../contracts/spec/relay.ts";

export { RELAY_FRAME_ERROR };
export type { RelayFrameErrorCode };

const H = RELAY_HEADER;

export interface RelayFrameInput {
  type: number;
  codec?: number;
  /** u64 session; bigint in [0, 2^64-1]. Zero is allowed structurally for
   * the bootstrap HELLO exchange only — the session layer enforces that. */
  session: bigint;
  seq: number;
  stream: number;
  correlation: number;
  metadata: Record<string, unknown>;
  data?: Uint8Array;
}

export interface RelayDecodedFrame {
  type: number;
  codec: number;
  session: bigint;
  seq: number;
  stream: number;
  correlation: number;
  metadata: Record<string, unknown>;
  /** View over the record's data region; copy if you keep it past the call. */
  data: Uint8Array;
}

export interface RelayFrameOptions {
  /** Receiver wire guarantee for this attachment. [R5-P09] */
  maxWireBytes?: number;
  maxMetaBytes?: number;
  /** Negotiated codec set; a value outside it is rejected. [R5-P04] */
  codecs?: Iterable<number>;
  /** When set, every decoded frame must carry this session. Bootstrap
   * session 0 never matches a pinned nonzero session. */
  session?: bigint;
}

type EncodeResult = { ok: true; bytes: Uint8Array } | { ok: false; code: RelayFrameErrorCode };
type DecodeResult =
  | { ok: true; frame: RelayDecodedFrame }
  | { ok: false; code: RelayFrameErrorCode };

function fail(code: RelayFrameErrorCode): DecodeResult {
  return { ok: false, code };
}

const isU32 = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

// --- strict JSON: writer ----------------------------------------------------

class JsonWriteError extends Error {
  code: RelayFrameErrorCode;
  constructor(code: RelayFrameErrorCode) {
    super(code);
    this.code = code;
  }
}

const OP_PATTERN = new RegExp("^[a-z][a-z0-9_.-]{0,63}$");

/** Compact JSON per R5 v1 rules: no NaN/Infinity, integers only and within
 * the JS safe-integer range, no lone Unicode surrogates, depth <= 16. Key
 * order is insertion order (resource identity never depends on it). */
function writeMetadata(root: Record<string, unknown>): Uint8Array {
  const out: number[] = [];
  const seen = new Set<unknown>();

  function writeString(s: string) {
    out.push(0x22);
    for (let i = 0; i < s.length; i++) {
      const cp = s.codePointAt(i)!;
      if (cp > 0xffff) i++; // consume the surrogate pair already in `s`
      if (cp >= 0xd800 && cp <= 0xdfff) throw new JsonWriteError(RELAY_FRAME_ERROR.BAD_METADATA);
      if (cp === 0x22 || cp === 0x5c) {
        out.push(0x5c, cp);
      } else if (cp === 0x08) out.push(0x5c, 0x62);
      else if (cp === 0x0c) out.push(0x5c, 0x66);
      else if (cp === 0x0a) out.push(0x5c, 0x6e);
      else if (cp === 0x0d) out.push(0x5c, 0x72);
      else if (cp === 0x09) out.push(0x5c, 0x74);
      else if (cp < 0x20) {
        out.push(0x5c, 0x75);
        const hex = cp.toString(16).padStart(4, "0");
        for (const c of hex) out.push(c.charCodeAt(0));
      } else {
        encodeUtf8CodePoint(cp, out);
      }
    }
    out.push(0x22);
  }

  function writeNumber(n: number) {
    if (!Number.isSafeInteger(n)) throw new JsonWriteError(RELAY_FRAME_ERROR.BAD_METADATA);
    for (const c of String(n)) out.push(c.charCodeAt(0));
  }

  function writeValue(value: unknown, depth: number) {
    if (depth > RELAY_LIMITS.jsonMaxDepth) throw new JsonWriteError(RELAY_FRAME_ERROR.BAD_METADATA);
    if (value === null) { out.push(0x6e, 0x75, 0x6c, 0x6c); return; }
    switch (typeof value) {
      case "boolean":
        for (const c of value ? "true" : "false") out.push(c.charCodeAt(0));
        return;
      case "number": writeNumber(value); return;
      case "string": writeString(value); return;
      case "bigint":
        throw new JsonWriteError(RELAY_FRAME_ERROR.BAD_METADATA);
      case "object": break;
      default:
        throw new JsonWriteError(RELAY_FRAME_ERROR.BAD_METADATA);
    }
    if (seen.has(value)) throw new JsonWriteError(RELAY_FRAME_ERROR.BAD_METADATA);
    seen.add(value);
    if (Array.isArray(value)) {
      out.push(0x5b);
      value.forEach((item, i) => {
        if (i) out.push(0x2c);
        writeValue(item, depth + 1);
      });
      out.push(0x5d);
    } else {
      const obj = value as Record<string, unknown>;
      out.push(0x7b);
      let first = true;
      for (const key of Object.keys(obj)) {
        if (!first) out.push(0x2c);
        first = false;
        writeString(key);
        out.push(0x3a);
        writeValue(obj[key], depth + 1);
      }
      out.push(0x7d);
    }
    seen.delete(value);
  }

  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw new JsonWriteError(RELAY_FRAME_ERROR.BAD_METADATA);
  }
  writeValue(root, 0);
  return Uint8Array.from(out);
}

function encodeUtf8CodePoint(cp: number, out: number[]) {
  if (cp < 0x80) {
    out.push(cp);
  } else if (cp < 0x800) {
    out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  } else if (cp < 0x10000) {
    out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  } else {
    out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
}

// --- strict JSON: parser -----------------------------------------------------

/** Parse one value with the relay's strict wire JSON rules. */
export function parseRelayJson(bytes: Uint8Array): unknown {
  const p = new Parser(bytes);
  p.ws();
  const value = p.value(0);
  p.ws();
  if (p.pos !== bytes.length) throw RELAY_FRAME_ERROR.BAD_METADATA;
  return value;
}

/** Parses strict UTF-8 JSON straight off the wire. Rejects invalid UTF-8
 * (including overlong encodings and the U+D800..U+DFFF byte range),
 * duplicate object keys, NaN/Infinity, non-integer or unsafe numbers and
 * nesting past the depth cap. Metadata's root must be an object. */
function parseMetadata(bytes: Uint8Array): Record<string, unknown> {
  const value = parseRelayJson(bytes);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw RELAY_FRAME_ERROR.BAD_METADATA;
  return value as Record<string, unknown>;
}

class Parser {
  pos = 0;
  constructor(private bytes: Uint8Array) {}

  private peek(): number {
    return this.pos < this.bytes.length ? this.bytes[this.pos] : -1;
  }
  ws() {
    while (true) {
      const b = this.peek();
      if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) this.pos++;
      else return;
    }
  }
  value(depth: number): unknown {
    if (depth > RELAY_LIMITS.jsonMaxDepth) throw RELAY_FRAME_ERROR.BAD_METADATA;
    this.ws();
    const b = this.peek();
    if (b === 0x7b) return this.object(depth);
    if (b === 0x5b) return this.array(depth);
    if (b === 0x22) return this.string();
    if (b === 0x2d || (b >= 0x30 && b <= 0x39)) return this.number();
    if (b === 0x74) return this.literal("true", true);
    if (b === 0x66) return this.literal("false", false);
    if (b === 0x6e) return this.literal("null", null);
    throw RELAY_FRAME_ERROR.BAD_METADATA;
  }
  private literal(word: string, value: unknown) {
    for (const c of word) {
      if (this.peek() !== c.charCodeAt(0)) throw RELAY_FRAME_ERROR.BAD_METADATA;
      this.pos++;
    }
    return value;
  }
  private object(depth: number): Record<string, unknown> {
    this.pos++; // {
    // Null prototype: assigning `out["__proto__"]` on a plain {} invokes
    // the setter and the key never becomes an own property, so a wire
    // `__proto__` would silently vanish (and could inject fields). A null
    // prototype keeps it as a normal own key the strict schema then sees.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    this.ws();
    if (this.peek() === 0x7d) { this.pos++; return out; }
    while (true) {
      this.ws();
      if (this.peek() !== 0x22) throw RELAY_FRAME_ERROR.BAD_METADATA;
      const key = this.string();
      this.ws();
      if (this.peek() !== 0x3a) throw RELAY_FRAME_ERROR.BAD_METADATA;
      this.pos++;
      const v = this.value(depth + 1);
      if (Object.prototype.hasOwnProperty.call(out, key)) throw RELAY_FRAME_ERROR.BAD_METADATA;
      out[key] = v;
      this.ws();
      const c = this.peek();
      if (c === 0x2c) { this.pos++; continue; }
      if (c === 0x7d) { this.pos++; return out; }
      throw RELAY_FRAME_ERROR.BAD_METADATA;
    }
  }
  private array(depth: number): unknown[] {
    this.pos++; // [
    const out: unknown[] = [];
    this.ws();
    if (this.peek() === 0x5d) { this.pos++; return out; }
    while (true) {
      out.push(this.value(depth + 1));
      this.ws();
      const c = this.peek();
      if (c === 0x2c) { this.pos++; continue; }
      if (c === 0x5d) { this.pos++; return out; }
      throw RELAY_FRAME_ERROR.BAD_METADATA;
    }
  }
  private string(): string {
    this.pos++; // opening quote
    const out: number[] = [];
    while (true) {
      const b = this.peek();
      if (b < 0) throw RELAY_FRAME_ERROR.BAD_METADATA;
      if (b === 0x22) { this.pos++; return String.fromCodePoint(...out); }
      if (b < 0x20) throw RELAY_FRAME_ERROR.BAD_METADATA;
      if (b === 0x5c) {
        this.pos++;
        const e = this.peek();
        this.pos++;
        switch (e) {
          case 0x22: out.push(0x22); break;
          case 0x5c: out.push(0x5c); break;
          case 0x2f: out.push(0x2f); break;
          case 0x62: out.push(0x08); break;
          case 0x66: out.push(0x0c); break;
          case 0x6e: out.push(0x0a); break;
          case 0x72: out.push(0x0d); break;
          case 0x74: out.push(0x09); break;
          case 0x75: {
            const hi = this.hex4();
            if (hi >= 0xd800 && hi <= 0xdbff) {
              if (this.peek() !== 0x5c) throw RELAY_FRAME_ERROR.BAD_METADATA;
              this.pos++;
              if (this.peek() !== 0x75) throw RELAY_FRAME_ERROR.BAD_METADATA;
              this.pos++;
              const lo = this.hex4();
              if (lo < 0xdc00 || lo > 0xdfff) throw RELAY_FRAME_ERROR.BAD_METADATA;
              out.push(0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00));
            } else if (hi >= 0xdc00 && hi <= 0xdfff) {
              throw RELAY_FRAME_ERROR.BAD_METADATA;
            } else {
              out.push(hi);
            }
            break;
          }
          default: throw RELAY_FRAME_ERROR.BAD_METADATA;
        }
      } else {
        out.push(this.utf8CodePoint());
      }
    }
  }
  private hex4(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.peek();
      this.pos++;
      const d = b >= 0x30 && b <= 0x39 ? b - 0x30
        : b >= 0x61 && b <= 0x66 ? b - 0x61 + 10
        : b >= 0x41 && b <= 0x46 ? b - 0x41 + 10
        : (() => { throw RELAY_FRAME_ERROR.BAD_METADATA; })();
      v = (v << 4) + d;
    }
    return v;
  }
  /** Reads one strict UTF-8 code point: no overlong, no surrogate range,
   * capped at U+10FFFF. */
  private utf8CodePoint(): number {
    const a = this.bytes[this.pos++];
    let cp: number, len: number, min: number;
    if (a < 0x80) return a;
    if (a >= 0xc2 && a <= 0xdf) { cp = a & 0x1f; len = 1; min = 0x80; }
    else if (a >= 0xe0 && a <= 0xef) {
      // E0 second byte starts at A0 (no overlong); ED stops at 9F (no surrogates).
      cp = a & 0x0f; len = 2;
      min = a === 0xe0 ? 0x0800 : 0x1000;
    }
    else if (a >= 0xf0 && a <= 0xf4) {
      // F0 second byte starts at 90 (no overlong); F4 stops at 8F (<= U+10FFFF).
      cp = a & 0x07; len = 3;
      min = a === 0xf0 ? 0x10000 : 0x10000;
    }
    else throw RELAY_FRAME_ERROR.BAD_METADATA;
    for (let i = 0; i < len; i++) {
      const b = this.peek();
      if (b < 0x80 || b > 0xbf) throw RELAY_FRAME_ERROR.BAD_METADATA;
      this.pos++;
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw RELAY_FRAME_ERROR.BAD_METADATA;
    return cp;
  }
  private number(): number {
    const start = this.pos;
    if (this.peek() === 0x2d) this.pos++;
    let sawDigit = false, sawDot = false, sawExp = false;
    const digit = () => {
      const b = this.peek();
      if (b >= 0x30 && b <= 0x39) { this.pos++; sawDigit = true; return true; }
      return false;
    };
    const first = this.peek();
    if (first === 0x30) {
      // A leading zero stands alone: no fractional or exponent part follows
      // in the integer-only grammar, and a second digit would be a leading
      // zero (rejected when the next byte is a digit below).
      this.pos++;
      sawDigit = true;
      if (this.peek() >= 0x30 && this.peek() <= 0x39) throw RELAY_FRAME_ERROR.BAD_METADATA;
    } else if (first >= 0x31 && first <= 0x39) {
      while (digit()) { /* */ }
    } else throw RELAY_FRAME_ERROR.BAD_METADATA;
    if (this.peek() === 0x2e) {
      sawDot = true; this.pos++;
      if (!digit()) throw RELAY_FRAME_ERROR.BAD_METADATA;
      while (digit()) { /* */ }
    }
    const e = this.peek();
    if (e === 0x65 || e === 0x45) {
      sawExp = true; this.pos++;
      const sign = this.peek();
      if (sign === 0x2b || sign === 0x2d) this.pos++;
      if (!digit()) throw RELAY_FRAME_ERROR.BAD_METADATA;
      while (digit()) { /* */ }
    }
    if (!sawDigit) throw RELAY_FRAME_ERROR.BAD_METADATA;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(this.bytes.subarray(start, this.pos));
    // Draft v1: ordinary JSON numbers are safe integers — fractions and
    // exponent notation are rejected. Leading-zero forms were rejected above.
    if (sawDot || sawExp) throw RELAY_FRAME_ERROR.BAD_METADATA;
    const n = Number(text);
    if (!Number.isSafeInteger(n)) throw RELAY_FRAME_ERROR.BAD_METADATA;
    return n;
  }
}

// --- envelope rules shared by encode and decode ------------------------------

function validateEnvelope(meta: Record<string, unknown>, type: number): RelayFrameErrorCode | null {
  if (typeof meta.op !== "string" || !OP_PATTERN.test(meta.op)) return RELAY_FRAME_ERROR.BAD_ENVELOPE;
  if (type === RELAY_TYPE.RESPONSE) {
    if (typeof meta.final !== "boolean") return RELAY_FRAME_ERROR.BAD_ENVELOPE;
    if (meta.status !== RELAY_STATUS.OK && meta.status !== RELAY_STATUS.ACCEPTED && meta.status !== RELAY_STATUS.ERROR) {
      return RELAY_FRAME_ERROR.BAD_ENVELOPE;
    }
  }
  if (type === RELAY_TYPE.CANCEL) {
    if (meta.op !== RELAY_OP.REQUEST_CANCEL) return RELAY_FRAME_ERROR.BAD_ENVELOPE;
    if (!isU32(meta.targetStream)) return RELAY_FRAME_ERROR.BAD_ENVELOPE;
  }
  return null;
}

// --- prepared bodies (P3 send scheduler) -------------------------------------

/** A frame whose header fields are not known yet. The P3 scheduler admits
 * work before it allocates seq (R5 §3.3: seq is assigned at selection), so
 * metadata is serialized and size-checked once at admission. */
export interface RelayFrameBodyInput {
  type: number;
  codec?: number;
  stream: number;
  metadata: Record<string, unknown>;
  data?: Uint8Array;
}

export interface RelayPreparedBody {
  type: number;
  codec: number;
  stream: number;
  meta: Uint8Array;
  data: Uint8Array;
  /** 44 + metaBytes + dataBytes; does not include the length prefix. */
  frameBytes: number;
  /** Full wire record length: frameBytes + 4. Wire credit charges this. */
  wireBytes: number;
}

type PrepareBodyResult =
  | { ok: true; body: RelayPreparedBody }
  | { ok: false; code: RelayFrameErrorCode };

/** Validates type/codec/stream and the metadata/data body, and serializes
 * metadata once. maxWireBytes/maxMetaBytes/codecs are enforced here so the
 * admission decision already reflects every body-level bound. */
export function prepareFrameBody(
  input: RelayFrameBodyInput,
  options: Pick<RelayFrameOptions, "maxWireBytes" | "maxMetaBytes" | "codecs"> = {},
): PrepareBodyResult {
  const type = input.type;
  if (!(type >= RELAY_TYPE.REQUEST && type <= RELAY_TYPE.INVALIDATE)) return { ok: false, code: RELAY_FRAME_ERROR.BAD_TYPE };

  const codec = input.codec ?? RELAY_CODEC.NONE;
  if (!isU32(codec) || codec > 0xffff) return { ok: false, code: RELAY_FRAME_ERROR.BAD_CODEC };
  const allowed = options.codecs ? new Set(options.codecs) : new Set(RELAY_DEFINED_CODECS);
  if (!allowed.has(codec)) return { ok: false, code: RELAY_FRAME_ERROR.BAD_CODEC };

  if (!isU32(input.stream)) return { ok: false, code: RELAY_FRAME_ERROR.BAD_LENGTH };
  // §3.6: a CANCEL rides the control stream. The stream is fixed at prepare
  // time, so the prepared path refuses it here, before metadata is serialized,
  // with the code the one-shot encoder, decodeFrame, C and Rust report.
  if (type === RELAY_TYPE.CANCEL && input.stream !== 0) return { ok: false, code: RELAY_FRAME_ERROR.BAD_CORRELATION };

  return buildBody(type, codec, input.stream, input.metadata, input.data, options);
}

/** Stamps session/seq/stream/correlation onto a prepared body. The envelope
 * already fixed type/stream; only the four per-frame header values remain. */
export function encodePreparedFrame(
  body: RelayPreparedBody,
  header: { session: bigint; seq: number; correlation: number },
): EncodeResult {
  if (typeof header.session !== "bigint" || header.session < 0n || header.session > 0xffffffffffffffffn) {
    return { ok: false, code: RELAY_FRAME_ERROR.BAD_SESSION };
  }
  if (!isU32(header.seq) || header.seq === 0) return { ok: false, code: RELAY_FRAME_ERROR.BAD_SEQ };
  if (!isU32(header.correlation)) return { ok: false, code: RELAY_FRAME_ERROR.BAD_CORRELATION };
  const correlationRequired = body.type === RELAY_TYPE.REQUEST
    || body.type === RELAY_TYPE.RESPONSE || body.type === RELAY_TYPE.CANCEL;
  if (correlationRequired ? header.correlation === 0 : header.correlation !== 0) {
    return { ok: false, code: RELAY_FRAME_ERROR.BAD_CORRELATION };
  }
  return { ok: true, bytes: assembleBody(body, header.session, header.seq, header.correlation) };
}

// --- encode ------------------------------------------------------------------

export function encodeFrame(input: RelayFrameInput, options: RelayFrameOptions = {}): EncodeResult {
  const type = input.type;
  if (!(type >= RELAY_TYPE.REQUEST && type <= RELAY_TYPE.INVALIDATE)) return { ok: false, code: RELAY_FRAME_ERROR.BAD_TYPE };

  const codec = input.codec ?? RELAY_CODEC.NONE;
  if (!isU32(codec) || codec > 0xffff) return { ok: false, code: RELAY_FRAME_ERROR.BAD_CODEC };
  const allowed = options.codecs ? new Set(options.codecs) : new Set(RELAY_DEFINED_CODECS);
  if (!allowed.has(codec)) return { ok: false, code: RELAY_FRAME_ERROR.BAD_CODEC };

  if (typeof input.session !== "bigint" || input.session < 0n || input.session > 0xffffffffffffffffn) {
    return { ok: false, code: RELAY_FRAME_ERROR.BAD_SESSION };
  }
  if (!isU32(input.seq) || input.seq === 0) return { ok: false, code: RELAY_FRAME_ERROR.BAD_SEQ };
  if (!isU32(input.stream)) return { ok: false, code: RELAY_FRAME_ERROR.BAD_LENGTH };
  if (!isU32(input.correlation)) return { ok: false, code: RELAY_FRAME_ERROR.BAD_CORRELATION };
  const correlationRequired = type === RELAY_TYPE.REQUEST || type === RELAY_TYPE.RESPONSE || type === RELAY_TYPE.CANCEL;
  if (correlationRequired ? input.correlation === 0 : input.correlation !== 0) {
    return { ok: false, code: RELAY_FRAME_ERROR.BAD_CORRELATION };
  }
  // §3.6: a CANCEL rides the control stream. The header field decides this,
  // so the C and Rust frame layers refuse it before any metadata is read.
  if (type === RELAY_TYPE.CANCEL && input.stream !== 0) return { ok: false, code: RELAY_FRAME_ERROR.BAD_CORRELATION };

  const built = buildBody(type, codec, input.stream, input.metadata ?? {}, input.data, options);
  if (!built.ok) return built;
  return { ok: true, bytes: assembleBody(built.body, input.session, input.seq, input.correlation) };
}

/** Body-level checks shared by prepareFrameBody and encodeFrame: codec-0 data
 * rule, strict metadata, envelope, u32 length math, receiver size limits. */
function buildBody(
  type: number,
  codec: number,
  stream: number,
  metadataInput: Record<string, unknown> | undefined,
  dataInput: Uint8Array | undefined,
  options: Pick<RelayFrameOptions, "maxWireBytes" | "maxMetaBytes" | "codecs">,
): PrepareBodyResult {
  const data = dataInput ?? new Uint8Array(0);
  if (codec === RELAY_CODEC.NONE && data.length !== 0) return { ok: false, code: RELAY_FRAME_ERROR.BAD_CODEC };

  let meta: Uint8Array;
  const metadata = metadataInput ?? {};
  try {
    meta = writeMetadata(metadata);
  } catch (e) {
    return { ok: false, code: e instanceof JsonWriteError ? e.code : RELAY_FRAME_ERROR.BAD_METADATA };
  }
  const envelope = validateEnvelope(metadata, type);
  if (envelope) return { ok: false, code: envelope };

  if (!Number.isSafeInteger(meta.length) || meta.length > 0xffffffff || data.length > 0xffffffff) {
    return { ok: false, code: RELAY_FRAME_ERROR.BAD_LENGTH };
  }
  const frameBytes = RELAY_FRAME.headerBodyBytes + meta.length + data.length;
  if (frameBytes > 0xffffffff) return { ok: false, code: RELAY_FRAME_ERROR.BAD_LENGTH };
  const wireBytes = frameBytes + RELAY_FRAME.lengthPrefixBytes;
  if (options.maxMetaBytes !== undefined && meta.length > options.maxMetaBytes) {
    return { ok: false, code: RELAY_FRAME_ERROR.META_TOO_LARGE };
  }
  if (options.maxWireBytes !== undefined && wireBytes > options.maxWireBytes) {
    return { ok: false, code: RELAY_FRAME_ERROR.WIRE_TOO_LARGE };
  }
  return { ok: true, body: { type, codec, stream, meta, data, frameBytes, wireBytes } };
}

function assembleBody(body: RelayPreparedBody, session: bigint, seq: number, correlation: number): Uint8Array {
  const out = new Uint8Array(body.wireBytes);
  const dv = new DataView(out.buffer);
  dv.setUint32(H.frameBytes.offset, body.frameBytes, true);
  out.set([0x50, 0x52, 0x4c, 0x59], H.magic.offset);
  out[H.major.offset] = RELAY_FRAME.major;
  out[H.minor.offset] = RELAY_FRAME.minor;
  out[H.type.offset] = body.type;
  out[H.flags.offset] = 0;
  dv.setUint16(H.headerBytes.offset, RELAY_FRAME.headerBytes, true);
  dv.setUint16(H.codec.offset, body.codec, true);
  dv.setBigUint64(H.session.offset, session, true);
  dv.setUint32(H.seq.offset, seq, true);
  dv.setUint32(H.stream.offset, body.stream, true);
  dv.setUint32(H.correlation.offset, correlation, true);
  dv.setUint32(H.metaBytes.offset, body.meta.length, true);
  dv.setUint32(H.dataBytes.offset, body.data.length, true);
  dv.setUint32(H.reserved.offset, 0, true);
  out.set(body.meta, RELAY_FRAME.headerBytes);
  out.set(body.data, RELAY_FRAME.headerBytes + body.meta.length);
  return out;
}

// --- decode ------------------------------------------------------------------

export function decodeFrame(record: Uint8Array, options: RelayFrameOptions = {}): DecodeResult {
  if (record.length < RELAY_FRAME.headerBytes) return fail(RELAY_FRAME_ERROR.SHORT_HEADER);

  const dv = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const frameBytes = dv.getUint32(H.frameBytes.offset, true);
  if (frameBytes < RELAY_FRAME.headerBodyBytes) return fail(RELAY_FRAME_ERROR.BAD_PREFIX);

  // Limit check precedes any trust in the declared payload size.
  if (options.maxWireBytes !== undefined && frameBytes + RELAY_FRAME.lengthPrefixBytes > options.maxWireBytes) {
    return fail(RELAY_FRAME_ERROR.WIRE_TOO_LARGE);
  }
  const wireBytes = frameBytes + RELAY_FRAME.lengthPrefixBytes;
  if (record.length < wireBytes) return fail(RELAY_FRAME_ERROR.TRUNCATED);
  if (record.length !== wireBytes) return fail(RELAY_FRAME_ERROR.BAD_LENGTH);

  if (record[H.magic.offset] !== 0x50 || record[H.magic.offset + 1] !== 0x52
    || record[H.magic.offset + 2] !== 0x4c || record[H.magic.offset + 3] !== 0x59) {
    return fail(RELAY_FRAME_ERROR.BAD_MAGIC);
  }
  if (record[H.major.offset] !== RELAY_FRAME.major || record[H.minor.offset] !== RELAY_FRAME.minor) {
    return fail(RELAY_FRAME_ERROR.BAD_VERSION);
  }
  const type = record[H.type.offset];
  if (type < RELAY_TYPE.REQUEST || type > RELAY_TYPE.INVALIDATE) return fail(RELAY_FRAME_ERROR.BAD_TYPE);
  if (record[H.flags.offset] !== 0) return fail(RELAY_FRAME_ERROR.BAD_FLAGS);
  if (dv.getUint16(H.headerBytes.offset, true) !== RELAY_FRAME.headerBytes) {
    return fail(RELAY_FRAME_ERROR.BAD_HEADER_SIZE);
  }
  const codec = dv.getUint16(H.codec.offset, true);
  const session = dv.getBigUint64(H.session.offset, true);
  const seq = dv.getUint32(H.seq.offset, true);
  const stream = dv.getUint32(H.stream.offset, true);
  const correlation = dv.getUint32(H.correlation.offset, true);
  const metaBytes = dv.getUint32(H.metaBytes.offset, true);
  const dataBytes = dv.getUint32(H.dataBytes.offset, true);
  if (dv.getUint32(H.reserved.offset, true) !== 0) return fail(RELAY_FRAME_ERROR.BAD_RESERVED);

  if (frameBytes !== RELAY_FRAME.headerBodyBytes + metaBytes + dataBytes) {
    return fail(RELAY_FRAME_ERROR.BAD_LENGTH);
  }
  if (options.maxMetaBytes !== undefined && metaBytes > options.maxMetaBytes) {
    return fail(RELAY_FRAME_ERROR.META_TOO_LARGE);
  }
  const allowed = options.codecs ? new Set(options.codecs) : new Set(RELAY_DEFINED_CODECS);
  if (!allowed.has(codec)) return fail(RELAY_FRAME_ERROR.BAD_CODEC);
  if (codec === RELAY_CODEC.NONE && dataBytes !== 0) return fail(RELAY_FRAME_ERROR.BAD_CODEC);
  if (options.session !== undefined && session !== options.session) return fail(RELAY_FRAME_ERROR.BAD_SESSION);
  if (seq === 0) return fail(RELAY_FRAME_ERROR.BAD_SEQ);

  const correlationRequired = type === RELAY_TYPE.REQUEST || type === RELAY_TYPE.RESPONSE || type === RELAY_TYPE.CANCEL;
  if (correlationRequired ? correlation === 0 : correlation !== 0) {
    return fail(RELAY_FRAME_ERROR.BAD_CORRELATION);
  }
  if (type === RELAY_TYPE.CANCEL && stream !== 0) return fail(RELAY_FRAME_ERROR.BAD_CORRELATION);

  let metadata: Record<string, unknown>;
  try {
    metadata = parseMetadata(record.subarray(RELAY_FRAME.headerBytes, RELAY_FRAME.headerBytes + metaBytes));
  } catch (e) {
    return fail(typeof e === "string" ? e as RelayFrameErrorCode : RELAY_FRAME_ERROR.BAD_METADATA);
  }
  const envelope = validateEnvelope(metadata, type);
  if (envelope) return fail(envelope);

  return {
    ok: true,
    frame: {
      type,
      codec,
      session,
      seq,
      stream,
      correlation,
      metadata,
      data: record.subarray(RELAY_FRAME.headerBytes + metaBytes, RELAY_FRAME.headerBytes + metaBytes + dataBytes),
    },
  };
}

// --- streaming record reassembly ---------------------------------------------

export interface RelayPushResult {
  ok: boolean;
  /** Complete records in arrival order; empty on a protocol error. */
  frames: Uint8Array[];
  code?: RelayFrameErrorCode;
}

/** Reassembles length-prefixed records from arbitrarily split or coalesced
 * input. One fixed buffer of maxWireBytes+4 is allocated up front; the
 * declared length is validated against that cap before bytes accumulate. */
export class RelayRecordDecoder {
  private buffer: Uint8Array;
  private have = 0;

  constructor(private readonly maxWireBytes: number = RELAY_LIMITS.defaultMaxWireBytes) {
    if (maxWireBytes < RELAY_FRAME.headerBytes) throw new Error("maxWireBytes below 48");
    this.buffer = new Uint8Array(maxWireBytes + RELAY_FRAME.lengthPrefixBytes);
  }

  reset() {
    this.have = 0;
  }

  push(chunk: Uint8Array): RelayPushResult {
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      // Fill until the 4-byte prefix is present.
      if (this.have < RELAY_FRAME.lengthPrefixBytes) {
        const n = Math.min(
          RELAY_FRAME.lengthPrefixBytes - this.have,
          this.buffer.length - this.have,
          chunk.length - offset,
        );
        this.buffer.set(chunk.subarray(offset, offset + n), this.have);
        this.have += n;
        offset += n;
        if (this.have < RELAY_FRAME.lengthPrefixBytes) continue;
        const declared = new DataView(this.buffer.buffer, this.buffer.byteOffset).getUint32(0, true);
        if (declared < RELAY_FRAME.headerBodyBytes) {
          this.have = 0;
          return { ok: false, frames, code: RELAY_FRAME_ERROR.BAD_PREFIX };
        }
        if (declared + RELAY_FRAME.lengthPrefixBytes > this.maxWireBytes) {
          this.have = 0;
          return { ok: false, frames, code: RELAY_FRAME_ERROR.WIRE_TOO_LARGE };
        }
      }
      const declared = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(0, true);
      const wireBytes = declared + RELAY_FRAME.lengthPrefixBytes;
      const n = Math.min(wireBytes - this.have, chunk.length - offset);
      this.buffer.set(chunk.subarray(offset, offset + n), this.have);
      this.have += n;
      offset += n;
      if (this.have === wireBytes) {
        frames.push(this.buffer.slice(0, wireBytes));
        this.have = 0;
      }
    }
    return { ok: true, frames };
  }
}
