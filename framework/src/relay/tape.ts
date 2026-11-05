/** Relay frame record/replay adapter (R5 draft §3.11; Q7 default = off).
 *
 * A frame tape records one session's complete wire records — the 4-byte
 * length prefix included — as four-element JSON tuples in capture order:
 *
 *   [direction, seq, frameHex, sha256Hex]
 *
 * direction is "out" (sent to the peer) or "in" (received from it). seq is
 * read from the 48-byte header so a divergence report can name the seq even
 * when the recorded bytes no longer parse. Nothing beyond those four fields
 * is recorded per frame: session, stream, op and payload already live inside
 * frameHex, and no timestamps or labels are added. This file is NOT the
 * input tape (framework/src/devtools.ts v1..v3: {v, masks, touch, …}); a
 * frame tape carries kind "relay-frame" and an input tape handed to the
 * parser is rejected.
 *
 * Recording wraps a complete-record transport:
 *
 *   const t = wrapRelayTransport(inner, { enabled: true, session: sessionN });
 *   t.send(record); t.recv();
 *   const text = stringifyFrameTape(t.relayRecorder!.toTape());
 *
 * With recording off (the default) wrapRelayTransport RETURNS inner itself:
 * no wrapper frame and no hash work sits on the path. With recording on the
 * wrapper transmits first and records only after the transport call
 * succeeds, so the recorder sits off the live path: every frame is sent or
 * returned even when it cannot be recorded (wrong session, seq 0, frame
 * cap). The first frame that cannot be recorded latches an `incomplete`
 * marker onto the tape instead; R5 §3.11 requires a partially lost trace to
 * be marked incomplete and never replayed as deterministic.
 *
 * Replay drives a fake transport over the same send/recv script: recv()
 * hands back the next recorded inbound record and send() hashes the next
 * outbound record against the tape. Every entry is self-verifying: the
 * stored sha256 must match its frameHex. The first mismatch latches with
 * the tape entry's seq and index — the frame equivalent of
 * tools/tape.ts --assert, which names the first divergent frame. */

import { RELAY_HEADER, RELAY_MAGIC } from "../../../contracts/spec/relay.ts";

// --- SHA-256 (FIPS 180-4), sync and dependency-free --------------------------
// frame.ts runs inside QuickJS guests, so the tape hashes without node:crypto;
// the KAT tests cross-check this implementation against node:crypto.

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** SHA-256 of one complete message; returns 32 bytes. Pads into one buffer;
 * frame records are bounded by maxWireBytes, so callers hash whole frames. */
export function sha256Bytes(message: Uint8Array): Uint8Array {
  // Padding: 0x80, zero bytes, 8-byte big-endian bit length; total % 64 == 0.
  const k = (56 - ((message.length + 1) % 64) + 64) % 64;
  const padded = new Uint8Array(message.length + 1 + k + 8);
  padded.set(message);
  padded[message.length] = 0x80;
  new DataView(padded.buffer).setBigUint64(padded.length - 8, BigInt(message.length) * 8n, false);

  const w = new Uint32Array(64);
  const h = Uint32Array.from(SHA256_H0);
  for (let block = 0; block < padded.length; block += 64) {
    const dv = new DataView(padded.buffer, block, 64);
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(t * 4, false);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15], b = w[t - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[t] + w[t]) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outv.setUint32(i * 4, h[i], false);
  return out;
}

/** 64 lowercase hex chars (no "sha256:" prefix; the tape key names it). */
export function sha256Hex(message: Uint8Array): string {
  return toHex(sha256Bytes(message));
}

// --- hex (runtime-neutral; frame.ts guests cannot assume Buffer) --------------

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`relay-tape: odd-length hex (${hex.length} chars)`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = parseInt(hex[i * 2], 16);
    const lo = parseInt(hex[i * 2 + 1], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) {
      throw new Error(`relay-tape: non-hex character at index ${i * 2}`);
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}

// --- tape document ------------------------------------------------------------

export type RelayFrameDirection = "in" | "out";

/** [direction, seq, complete wire record (length prefix included), sha256]. */
export type RelayFrameTapeTuple = readonly [
  direction: RelayFrameDirection,
  seq: number,
  frameHex: string,
  sha256Hex: string,
];

export interface RelayFrameTapeIncomplete {
  /** Number of complete entries captured before the loss; the frames that
   * are present form a clean prefix of the wire record. */
  readonly index: number;
  /** Why the next frame could not be recorded (the recorder rule). */
  readonly reason: string;
}

export interface RelayFrameTape {
  readonly kind: "relay-frame";
  readonly v: 1;
  /** u64 session as 16 lowercase hex chars; "0000…0" only for a bootstrap
   * tape. Every entry's frame header carries this session. */
  readonly session: string;
  readonly frames: readonly RelayFrameTapeTuple[];
  /** Present when record loss occurred (R5 §3.11: partial record loss marks
   * the trace incomplete). Such a trace verifies as not-OK and must not be
   * replayed as a deterministic script. Absent on a complete trace. */
  readonly incomplete?: RelayFrameTapeIncomplete;
}

/** Implementation cap for the in-memory recorder; the full facts track in
 * R5 §3.11 is meant to stream to disk. Not a wire-protocol constant. */
const DEFAULT_MAX_FRAMES = 1_000_000;
const SESSION_HEX = /^[0-9a-f]{16}$/;

function readRecordHeader(frame: Uint8Array): { session: bigint; seq: number; stream: number } {
  if (frame.length < RELAY_HEADER.reserved.offset + 4) {
    throw new Error(`relay-tape: short record (${frame.length} bytes, header needs 48)`);
  }
  if (
    frame[RELAY_HEADER.magic.offset] !== RELAY_MAGIC[0]
    || frame[RELAY_HEADER.magic.offset + 1] !== RELAY_MAGIC[1]
    || frame[RELAY_HEADER.magic.offset + 2] !== RELAY_MAGIC[2]
    || frame[RELAY_HEADER.magic.offset + 3] !== RELAY_MAGIC[3]
  ) {
    throw new Error("relay-tape: record does not start with PRLY");
  }
  const frameBytes = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, true);
  if (frame.length !== frameBytes + 4) {
    throw new Error(`relay-tape: record is ${frame.length} bytes, prefix declares ${frameBytes + 4}`);
  }
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.length);
  return {
    session: dv.getBigUint64(RELAY_HEADER.session.offset, true),
    seq: dv.getUint32(RELAY_HEADER.seq.offset, true),
    stream: dv.getUint32(RELAY_HEADER.stream.offset, true),
  };
}

/** The identity and order rules one tuple must satisfy, shared by
 * verifyFrameTape and the replay transport so both reach the same verdict
 * (review 1070 N3): the header session is the document session, the tuple
 * seq is the header seq, and within one (direction, stream) seq increases
 * in capture order (a session never reuses or rolls back a seq on the
 * wire; a tape wrapped after READY starts above 1, so contiguity is not
 * required). `last` is the per-(direction, stream) cursor the caller keeps. */
function checkTupleRules(
  header: { session: bigint; seq: number; stream: number },
  direction: RelayFrameDirection,
  seq: number,
  tapeSession: string,
  last: Map<string, number>,
): { code: "record" | "order"; detail: string } | null {
  if (header.session !== BigInt("0x" + tapeSession)) {
    return {
      code: "record",
      detail: `frame session ${header.session.toString(16)} does not match tape session ${tapeSession}`,
    };
  }
  if (header.seq !== seq) {
    return { code: "record", detail: `tuple seq ${seq} does not match header seq ${header.seq}` };
  }
  const lane = `${direction}:${header.stream}`;
  const prev = last.get(lane);
  if (prev !== undefined && seq <= prev) {
    return { code: "order", detail: `${direction} stream ${header.stream} seq ${seq} after seq ${prev}` };
  }
  last.set(lane, seq);
  return null;
}

// --- recorder -----------------------------------------------------------------

export interface RelayFrameRecorderOptions {
  /** Pin every recorded frame to this session. Without it the first
   * recorded frame's session pins the tape. */
  session?: bigint;
  maxFrames?: number;
}

/** First record-loss marker for a passive capture. R5 §3.11: when partial
 * record loss happens the trace is marked incomplete rather than producing a
 * broken deterministic replay. */
export interface RelayFrameIncompleteState {
  /** Entries captured before the loss; the stored frames are a clean prefix
   * of the wire record up to this index. */
  readonly index: number;
  /** The recorder rule the lost frame violated. */
  readonly reason: string;
}

/** Passive observer of one session's complete wire records. Allocates no
 * hash state and performs no work unless note()/observe() is called;
 * construct one only when recording is enabled (Q7 default off).
 *
 * Two entry points: note() enforces the tape rules and throws (the strict
 * API for direct use); observe() never throws and latches the first failure
 * as `incomplete` instead, which is the path the transport wrapper uses so
 * recording cannot change live-path behavior. */
export class RelayFrameRecorder {
  private _framesRecorded = 0;
  private _bytesRecorded = 0;
  private readonly entries: [RelayFrameDirection, number, string, string][] = [];
  private readonly maxFrames: number;
  private pinnedSession: bigint | null;
  private _incomplete: RelayFrameIncompleteState | null = null;

  get framesRecorded(): number { return this._framesRecorded; }
  get bytesRecorded(): number { return this._bytesRecorded; }
  /** First record-loss marker, or null on a still-complete capture. */
  get incomplete(): RelayFrameIncompleteState | null { return this._incomplete; }

  constructor(options: RelayFrameRecorderOptions = {}) {
    this.maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
    this.pinnedSession = options.session ?? null;
  }

  note(frame: Uint8Array, direction: RelayFrameDirection): void {
    if (direction !== "in" && direction !== "out") {
      throw new Error(`relay-tape: direction must be "in" or "out", got ${String(direction)}`);
    }
    const { session, seq } = readRecordHeader(frame);
    if (seq === 0) throw new Error("relay-tape: frame seq is 0 (seq starts at 1 per direction)");
    if (this.pinnedSession === null) this.pinnedSession = session;
    else if (session !== this.pinnedSession) {
      throw new Error(
        `relay-tape: frame session ${session.toString(16).padStart(16, "0")} `
          + `does not match tape session ${this.pinnedSession.toString(16).padStart(16, "0")}`,
      );
    }
    if (this.entries.length >= this.maxFrames) {
      throw new Error(`relay-tape: frame cap ${this.maxFrames} reached`);
    }
    const frameHex = toHex(frame);
    this.entries.push([direction, seq, frameHex, sha256Hex(frame)]);
    this._framesRecorded++;
    this._bytesRecorded += frame.length;
  }

  noteOut(frame: Uint8Array): void { this.note(frame, "out"); }
  noteIn(frame: Uint8Array): void { this.note(frame, "in"); }

  /** Passive entry point for the transport wrapper. Returns whether the
   * frame was appended. Never throws: a rejected frame latches the first
   * loss as `incomplete` and is omitted, and no later frame is appended, so
   * the captured entries stay a clean single-session prefix (R5 §3.11:
   * partial loss marks the trace incomplete; the live transport keeps
   * carrying every frame). */
  observe(frame: Uint8Array, direction: RelayFrameDirection): boolean {
    if (this._incomplete) return false;
    try {
      this.note(frame, direction);
      return true;
    } catch (e) {
      this._incomplete = { index: this.entries.length, reason: (e as Error).message };
      return false;
    }
  }

  observeOut(frame: Uint8Array): boolean { return this.observe(frame, "out"); }
  observeIn(frame: Uint8Array): boolean { return this.observe(frame, "in"); }

  toTape(): RelayFrameTape {
    if (this.entries.length === 0) {
      if (this._incomplete) {
        throw new Error(
          `relay-tape: cannot serialize a trace that lost its frame before any valid record `
            + `(${this._incomplete.reason})`,
        );
      }
      throw new Error("relay-tape: cannot serialize a tape with no frames");
    }
    return {
      kind: "relay-frame",
      v: 1,
      session: this.pinnedSession!.toString(16).padStart(16, "0"),
      frames: this.entries.map((e) => [...e] as RelayFrameTapeTuple),
      ...(this._incomplete ? { incomplete: { ...this._incomplete } } : {}),
    };
  }
}

// --- transport wrapper --------------------------------------------------------

/** Complete-record transport; one call is one wire record including its
 * 4-byte length prefix. RelayRecordDecoder reassembles records below recv. */
export interface RelayFrameTransport {
  send(frame: Uint8Array): void;
  recv(): Uint8Array | null | undefined;
}

export interface RelayFrameWrapOptions extends RelayFrameRecorderOptions {
  /** Q7: recording is opt-in and defaults to false. */
  enabled?: boolean;
}

export interface RelayRecordingTransport<T extends RelayFrameTransport> extends RelayFrameTransport {
  readonly relayRecorder: RelayFrameRecorder;
  send(frame: Uint8Array): void;
  recv(): Uint8Array | null;
}

/** Wrap a complete-record transport. Disabled (default): returns inner
 * itself, so the hot path keeps its original object identity and gains no
 * per-frame work. Enabled: every frame crosses the wire first and is handed
 * to the recorder only after the transport call succeeds, so a recorder
 * rejection (session change, seq 0, frame cap) marks the trace incomplete —
 * it never suppresses, delays, or reorders a frame (R5 §3.11 record mode). */
export function wrapRelayTransport<T extends RelayFrameTransport>(
  inner: T,
  options: RelayFrameWrapOptions = {},
): T | RelayRecordingTransport<T> {
  if (!options.enabled) return inner;
  const recorder = new RelayFrameRecorder({ session: options.session, maxFrames: options.maxFrames });
  const wrapped = {
    relayRecorder: recorder,
    send(frame: Uint8Array): void {
      inner.send(frame);
      recorder.observeOut(frame);
    },
    recv(): Uint8Array | null {
      const frame = inner.recv();
      if (frame) recorder.observeIn(frame);
      return frame ?? null;
    },
  } as RelayRecordingTransport<T>;
  return wrapped;
}

// --- parse / stringify --------------------------------------------------------

export function stringifyFrameTape(tape: RelayFrameTape): string {
  return JSON.stringify(tape);
}

/** Parse and shape-validate a frame tape JSON text. Rejects the input tape
 * format and every structural deviation; frame bytes themselves are checked
 * later by verifyFrameTape / the replay transport. */
export function parseFrameTape(text: string): RelayFrameTape {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`relay-tape: tape is not JSON: ${(e as Error).message}`);
  }
  if (typeof doc !== "object" || doc === null) throw new Error("relay-tape: tape root is not an object");
  const o = doc as Record<string, unknown>;
  if (Array.isArray(o.masks)) {
    throw new Error("relay-tape: this is an input tape (v1..v3); frame tapes have kind \"relay-frame\"");
  }
  if (o.kind !== "relay-frame") throw new Error(`relay-tape: kind must be "relay-frame", got ${String(o.kind)}`);
  if (o.v !== 1) throw new Error(`relay-tape: unsupported tape v ${String(o.v)}`);
  if (typeof o.session !== "string" || !SESSION_HEX.test(o.session)) {
    throw new Error("relay-tape: session must be 16 lowercase hex chars");
  }
  if (!Array.isArray(o.frames)) throw new Error("relay-tape: frames is not an array");
  const frames: RelayFrameTapeTuple[] = [];
  for (let i = 0; i < o.frames.length; i++) {
    const e = o.frames[i] as unknown;
    const why = `relay-tape: frames[${i}]`;
    if (!Array.isArray(e) || e.length !== 4) throw new Error(`${why} is not a 4-tuple`);
    const [direction, seq, frameHex, digest] = e as unknown[];
    if (direction !== "in" && direction !== "out") throw new Error(`${why}: direction must be "in"/"out"`);
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= 0 || seq > 0xffffffff) {
      throw new Error(`${why}: seq must be a u32 > 0`);
    }
    if (typeof frameHex !== "string" || frameHex.length < 96 || frameHex.length % 2 !== 0) {
      throw new Error(`${why}: frameHex must be even-length hex of at least one 48-byte record`);
    }
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`${why}: sha256 must be 64 lowercase hex chars`);
    }
    frames.push([direction, seq, frameHex, digest]);
  }
  let incomplete: RelayFrameTapeIncomplete | undefined;
  if (o.incomplete !== undefined) {
    const why = "relay-tape: incomplete";
    if (typeof o.incomplete !== "object" || o.incomplete === null || Array.isArray(o.incomplete)) {
      throw new Error(`${why} must be an object`);
    }
    const m = o.incomplete as Record<string, unknown>;
    if (typeof m.index !== "number" || !Number.isInteger(m.index) || m.index < 0 || m.index > frames.length) {
      throw new Error(`${why}.index must be an integer in 0..frames.length`);
    }
    if (typeof m.reason !== "string" || m.reason.length === 0) {
      throw new Error(`${why}.reason must be a non-empty string`);
    }
    incomplete = { index: m.index, reason: m.reason };
  }
  return { kind: "relay-frame", v: 1, session: o.session, frames, ...(incomplete ? { incomplete } : {}) };
}

// --- verify / replay ----------------------------------------------------------

export type RelayFrameDivergenceCode =
  | "digest" // stored sha256 does not match the frame bytes
  | "direction" // send/recv happened where the tape expected the opposite
  | "record" // frame bytes are not one complete PRLY record of this session with the tuple's seq
  | "order" // seq went backwards or repeated within one (direction, stream)
  | "empty" // the tape carries no frames
  | "unexpected" // a frame was sent after the tape ran out
  | "incomplete" // replay ended with tape entries left
  | "tape-incomplete"; // the trace itself carries a record-loss marker

export interface RelayFrameDivergence {
  /** Tuple index of the first frame that disagreed. */
  index: number;
  direction: RelayFrameDirection;
  /** seq label copied from the tape tuple (stable even if the header bytes
   * are the part that was tampered with). */
  seq: number;
  code: RelayFrameDivergenceCode;
  detail: string;
}

export interface RelayFrameTapeVerdict {
  ok: boolean;
  /** Number of tuples checked before the verdict. */
  frames: number;
  divergence?: RelayFrameDivergence;
}

/** Check every tuple's record shape, identity, order and sha256 in capture
 * order. Returns the first divergence (index + seq) — the --assert
 * semantics. A trace that carries a record-loss marker is not OK regardless
 * of its stored prefix (R5 §3.11: partial loss bars a deterministic
 * verdict), and a tape with no frames is not a verdict either. */
export function verifyFrameTape(tape: RelayFrameTape): RelayFrameTapeVerdict {
  if (tape.incomplete) {
    return {
      ok: false,
      frames: tape.incomplete.index,
      divergence: {
        index: tape.incomplete.index,
        direction: "out",
        seq: 0,
        code: "tape-incomplete",
        detail: `trace marked incomplete after ${tape.incomplete.index} recorded frame(s): ${tape.incomplete.reason}`,
      },
    };
  }
  if (tape.frames.length === 0) return divergence(0, "out", 0, "empty", "tape carries no frames");
  const last = new Map<string, number>();
  for (let i = 0; i < tape.frames.length; i++) {
    const [direction, seq, frameHex, digest] = tape.frames[i];
    let bytes: Uint8Array;
    try {
      bytes = fromHex(frameHex);
    } catch (e) {
      return divergence(i, direction, seq, "record", (e as Error).message);
    }
    let header: ReturnType<typeof readRecordHeader>;
    try {
      header = readRecordHeader(bytes);
    } catch (e) {
      return divergence(i, direction, seq, "record", (e as Error).message);
    }
    const rule = checkTupleRules(header, direction, seq, tape.session, last);
    if (rule) return divergence(i, direction, seq, rule.code, rule.detail);
    const actual = sha256Hex(bytes);
    if (actual !== digest) {
      return divergence(i, direction, seq, "digest", `expected ${digest}, computed ${actual}`);
    }
  }
  return { ok: true, frames: tape.frames.length };
}

function divergence(
  index: number,
  direction: RelayFrameDirection,
  seq: number,
  code: RelayFrameDivergenceCode,
  detail: string,
): RelayFrameTapeVerdict {
  return { ok: false, frames: index, divergence: { index, direction, seq, code, detail } };
}

export interface RelayFrameReplay {
  /** Fake inbound: the next recorded "in" record, or null when the script
   * next expects the replayed peer to send. Null also covers a latched
   * divergence and an exhausted tape. */
  recv(): Uint8Array | null;
  /** Fake outbound: hash and order-check one record against the tape. */
  send(frame: Uint8Array): void;
  /** ok only with no divergence and every tuple consumed. */
  result(): RelayFrameTapeVerdict;
  /** Tuples verified so far. */
  readonly framesChecked: number;
}

/** Build the fake transport a replayed session stack drives. Entry bytes
 * are verified lazily at the send/recv step that consumes them, under the
 * same identity and order rules as verifyFrameTape. A trace carrying a
 * record-loss marker, or no frames at all, is refused: R5 §3.11 says
 * partial loss must not manufacture a deterministic replay, and an empty
 * script verifies nothing. */
export function createRelayFrameReplay(tape: RelayFrameTape): RelayFrameReplay {
  if (tape.incomplete) {
    throw new Error(
      `relay-tape: refusing to replay an incomplete trace `
        + `(${tape.incomplete.index} recorded frame(s); ${tape.incomplete.reason})`,
    );
  }
  if (tape.frames.length === 0) throw new Error("relay-tape: refusing to replay a tape with no frames");
  let i = 0;
  let first: RelayFrameDivergence | null = null;
  const last = new Map<string, number>();

  function fail(code: RelayFrameDivergenceCode, detail: string): void {
    if (first) return;
    const [direction, seq] = i < tape.frames.length
      ? [tape.frames[i][0], tape.frames[i][1]]
      : ["out" as RelayFrameDirection, 0];
    first = { index: i, direction, seq, code, detail };
  }

  /** Verify tuple i's bytes/digest and the PRLY record shape. With a
   * produced frame, compare its hash to the stored digest; without one,
   * verify the recorded bytes themselves. Returns bytes or null after the
   * first divergence latches. */
  function checkEntry(frame?: Uint8Array): Uint8Array | null {
    if (i >= tape.frames.length) {
      fail("unexpected", "frame after the recorded script ended");
      return null;
    }
    const [direction, seq, frameHex, digest] = tape.frames[i];
    let bytes: Uint8Array;
    try {
      bytes = fromHex(frameHex);
    } catch (e) {
      fail("record", (e as Error).message);
      return null;
    }
    let header: ReturnType<typeof readRecordHeader>;
    try {
      header = readRecordHeader(bytes);
    } catch (e) {
      fail("record", (e as Error).message);
      return null;
    }
    const rule = checkTupleRules(header, direction, seq, tape.session, last);
    if (rule) {
      fail(rule.code, rule.detail);
      return null;
    }
    if (frame !== undefined) {
      if (sha256Hex(frame) !== digest) {
        fail("digest", `produced frame does not match recorded ${direction} seq ${seq}`);
        return null;
      }
    } else if (sha256Hex(bytes) !== digest) {
      fail("digest", `recorded ${direction} seq ${seq} fails its stored sha256`);
      return null;
    }
    i++;
    return bytes;
  }

  const api: RelayFrameReplay = {
    recv() {
      if (first) return null;
      if (i >= tape.frames.length) return null;
      if (tape.frames[i][0] !== "in") return null;
      const bytes = checkEntry();
      return bytes ? bytes.slice() : null;
    },
    send(frame: Uint8Array) {
      if (first) return;
      if (i >= tape.frames.length) {
        fail("unexpected", "send after the recorded script ended");
        return;
      }
      if (tape.frames[i][0] !== "out") {
        fail("direction", `send where tape entry ${i} is inbound seq ${tape.frames[i][1]}`);
        return;
      }
      checkEntry(frame);
    },
    result(): RelayFrameTapeVerdict {
      if (first) return { ok: false, frames: first.index, divergence: first };
      if (i < tape.frames.length) {
        const [direction, seq] = tape.frames[i];
        return {
          ok: false,
          frames: i,
          divergence: { index: i, direction, seq, code: "incomplete", detail: `${tape.frames.length - i} recorded frames were never replayed` },
        };
      }
      return { ok: true, frames: i };
    },
    get framesChecked() { return i; },
  };
  return api;
}
