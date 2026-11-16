// Pocket Link 2 wire codec (contracts/spec/link2.ts, docs/POCKET-LINK.md):
// beacon, preamble and version selection, the 12-byte frame header with a
// streaming decoder, the handshake messages and their HMAC-SHA256 proofs.
// Pure functions and one small class; no sockets.
//
// Byte conventions: an HMAC key is the raw 32 bytes of the link key (which
// travels nowhere and is stored as 64 lowercase hex digits); the HMAC message
// is the UTF-8 string of label, nonces and ids as sent, joined by "\n"; a
// proof is 64 lowercase hex digits. A size limit of a JSON string counts the
// bytes of its encoded form in the frame, escapes included, without the two
// quotes.

import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  LINK2_APP_CHANNEL_PREFIX,
  LINK2_APP_MSG_CEILING,
  LINK2_BEACON_BYTES,
  LINK2_BEACON_MAGIC,
  LINK2_BEACON_NAME_BYTES,
  LINK2_CLOSE,
  LINK2_CLOSE_REASON_BYTES,
  LINK2_FEATURE_BYTES,
  LINK2_FLAG,
  LINK2_FRAME,
  LINK2_HEADER_BYTES,
  LINK2_ID_DEVICE_MAX,
  LINK2_ID_HEX,
  LINK2_ID_HUB_BIT,
  LINK2_KEY_BYTES,
  LINK2_LABEL,
  LINK2_MAGIC,
  LINK2_MAX_FEATURES,
  LINK2_MAX_HANDSHAKE,
  LINK2_MIN_PAYLOAD,
  LINK2_MODEL_BYTES,
  LINK2_NAME_BYTES,
  LINK2_NONCE_BYTES,
  LINK2_PAIR_CODE_DIGITS,
  LINK2_PAYLOAD_CEILING,
  LINK2_PING_BYTES,
  LINK2_PREAMBLE_BYTES,
  LINK2_REFUSAL,
  LINK2_REFUSED_MESSAGE_BYTES,
  LINK2_RESET,
  LINK2_TARGET_BYTES,
  LINK2_VERSION,
  type Link2Auth,
  type Link2Challenge,
  type Link2CloseName,
  type Link2Hello,
  type Link2Pair,
  type Link2PairAccept,
  type Link2PairDone,
  type Link2PairOffer,
  type Link2Ready,
  type Link2Refused,
  type Link2RefusalCode,
  type Link2ResetName,
} from "../../../contracts/spec/link2.ts";

/** A rule of §4 or §5 broken by the peer: the connection closes with `code`. */
export class LinkCloseError extends Error {
  constructor(readonly code: Link2CloseName, reason: string) {
    super(reason);
  }
}
/** A caller's own mistake: a value this side must never put on the wire. */
export class LinkEncodeError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ID_RE = /^[0-9a-f]{16}$/;
const hexRe = (bytes: number) => new RegExp(`^[0-9a-f]{${bytes * 2}}$`);
export const NONCE_RE = hexRe(LINK2_NONCE_BYTES);
export const KEY_RE = hexRe(LINK2_KEY_BYTES);
export const PROOF_RE = /^[0-9a-f]{64}$/;
export const HASH_RE = /^[0-9a-f]{16}$/;

export const isLinkId = (value: unknown): value is string => typeof value === "string" && ID_RE.test(value);
export const newLinkId = () => randomBytes(LINK2_ID_HEX / 2).toString("hex");
export const newNonce = () => randomBytes(LINK2_NONCE_BYTES).toString("hex");
export const newKey = () => randomBytes(LINK2_KEY_BYTES).toString("hex");

export const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
export const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));

/** Bytes a string takes inside a JSON frame: its encoded form without quotes. */
export function encodedBytes(value: string): number {
  return encoder.encode(JSON.stringify(value)).length - 2;
}
/** Bytes of a value's JSON as this codec writes it. */
export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/** Longest prefix of `text` whose UTF-8 encoding fits `max` bytes, cut on a
 *  code point. */
export function utf8Prefix(text: string, max: number): Uint8Array {
  let used = 0;
  let kept = "";
  for (const ch of text) {
    const length = encoder.encode(ch).length;
    if (used + length > max) break;
    kept += ch;
    used += length;
  }
  return encoder.encode(kept);
}

/** Longest prefix of `text` whose encoded form (§4.4) fits `max` bytes. */
export function encodedPrefix(text: string, max: number): string {
  let used = 0;
  let kept = "";
  for (const ch of text) {
    const length = encodedBytes(ch);
    if (used + length > max) break;
    kept += ch;
    used += length;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// §2.2 Beacon
// ---------------------------------------------------------------------------

export interface Link2Beacon {
  port: number;
  companion: string;
  name: string;
}

export function encodeBeacon(beacon: Link2Beacon): Uint8Array {
  if (!isLinkId(beacon.companion)) throw new LinkEncodeError("beacon: invalid companion id");
  if (!Number.isInteger(beacon.port) || beacon.port < 1 || beacon.port > 0xffff) {
    throw new LinkEncodeError("beacon: invalid port");
  }
  const out = new Uint8Array(LINK2_BEACON_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, LINK2_BEACON_MAGIC, true);
  out[4] = LINK2_VERSION;
  out[5] = 0;
  view.setUint16(6, beacon.port, true);
  out.set(encoder.encode(beacon.companion), 8);
  out.set(utf8Prefix(beacon.name, LINK2_BEACON_NAME_BYTES), 24);
  return out;
}

/** Null for a datagram a version-2 receiver drops: not 64 bytes, another
 *  magic or version, port 0, or an id that is not 16 lowercase hex digits.
 *  The flags byte is ignored. */
export function decodeBeacon(bytes: Uint8Array): Link2Beacon | null {
  if (bytes.length !== LINK2_BEACON_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== LINK2_BEACON_MAGIC) return null;
  if (bytes[4] !== LINK2_VERSION) return null;
  const port = view.getUint16(6, true);
  if (port === 0) return null;
  const companion = Buffer.from(bytes.subarray(8, 24)).toString("latin1");
  if (!isLinkId(companion)) return null;
  let end = 24;
  while (end < 24 + LINK2_BEACON_NAME_BYTES && bytes[end] !== 0) end++;
  return { port, companion, name: new TextDecoder().decode(bytes.subarray(24, end)) };
}

// ---------------------------------------------------------------------------
// §4.1 Preamble
// ---------------------------------------------------------------------------

export interface Link2Preamble {
  highest: number;
  lowest: number;
  selected: number;
}

export function encodePreamble(preamble: Link2Preamble): Uint8Array {
  const out = new Uint8Array(LINK2_PREAMBLE_BYTES);
  new DataView(out.buffer).setUint32(0, LINK2_MAGIC, true);
  out[4] = preamble.highest;
  out[5] = preamble.lowest;
  out[6] = preamble.selected;
  return out;
}

/** The device's preamble for a client that speaks version 2 alone. */
export const devicePreamble = () => encodePreamble({ highest: LINK2_VERSION, lowest: LINK2_VERSION, selected: 0 });

/** Null when the 8 bytes do not start with the magic. The reserved byte is
 *  not checked: a later version may use it, and this one keeps the rules. */
export function decodePreamble(bytes: Uint8Array): Link2Preamble | null {
  if (bytes.length !== LINK2_PREAMBLE_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== LINK2_MAGIC) return null;
  return { highest: bytes[4], lowest: bytes[5], selected: bytes[6] };
}

/** Hub's choice: the highest version inside both ranges, or 0. A version-1
 *  console's preamble (PKLK, 1, 0, 0, 0) reads as highest 1, lowest 0. */
export function selectVersion(hub: { highest: number; lowest: number }, device: Link2Preamble): number {
  const top = Math.min(hub.highest, device.highest);
  const bottom = Math.max(hub.lowest, device.lowest, 1);
  return top >= bottom ? top : 0;
}

/** The device's check of Hub's preamble: the version to use, or null to close. */
export function acceptSelection(device: { highest: number; lowest: number }, hub: Link2Preamble): number | null {
  if (hub.selected === 0) return null;
  return hub.selected >= device.lowest && hub.selected <= device.highest ? hub.selected : null;
}

// ---------------------------------------------------------------------------
// §4.2, §4.3 Frames
// ---------------------------------------------------------------------------

export interface Link2Frame {
  type: number;
  flags: number;
  id: number;
  payload: Uint8Array;
}

const KNOWN_FLAGS: Record<number, number> = {
  [LINK2_FRAME.ping]: 0,
  [LINK2_FRAME.pong]: 0,
  [LINK2_FRAME.close]: 0,
  [LINK2_FRAME.handshake]: 0,
  [LINK2_FRAME.request]: LINK2_FLAG.app | LINK2_FLAG.body,
  [LINK2_FRAME.reply]: LINK2_FLAG.error,
  [LINK2_FRAME.event]: LINK2_FLAG.app,
  [LINK2_FRAME.cancel]: 0,
  [LINK2_FRAME.data]: LINK2_FLAG.end,
  [LINK2_FRAME.credit]: 0,
  [LINK2_FRAME.reset]: 0,
};
const BEFORE_READY = new Set<number>([LINK2_FRAME.ping, LINK2_FRAME.pong, LINK2_FRAME.close, LINK2_FRAME.handshake]);

/** "device", "hub", or null for 0 and 0x80000000, which are in neither range. */
export function idRange(id: number): "device" | "hub" | null {
  if (id === 0 || id === LINK2_ID_HUB_BIT) return null;
  return id >>> 0 > LINK2_ID_DEVICE_MAX ? "hub" : "device";
}

/** The header and payload checks of §4.2 and §4.7 for a known frame type.
 *  Throws LinkCloseError with the code the receiver closes with. */
export function checkFrame(type: number, flags: number, id: number, length: number): void {
  const known = KNOWN_FLAGS[type];
  if (known === undefined) return;
  if ((flags & ~known) !== 0) throw new LinkCloseError("protocol", `frame 0x${type.toString(16)}: undefined flag`);
  if (type === LINK2_FRAME.request && (flags & LINK2_FLAG.body) !== 0 && (flags & LINK2_FLAG.app) === 0) {
    throw new LinkCloseError("protocol", "REQUEST: BODY without APP");
  }
  const named = idRange(id) !== null;
  switch (type) {
    case LINK2_FRAME.ping:
    case LINK2_FRAME.pong:
      if (id !== 0) throw new LinkCloseError("protocol", "PING/PONG: id is not 0");
      if (length !== LINK2_PING_BYTES) throw new LinkCloseError("protocol", "PING/PONG: payload is not 4 bytes");
      break;
    case LINK2_FRAME.close:
      if (id !== 0) throw new LinkCloseError("protocol", "CLOSE: id is not 0");
      if (length < 4 || length > 4 + LINK2_CLOSE_REASON_BYTES) throw new LinkCloseError("protocol", "CLOSE: bad payload size");
      break;
    case LINK2_FRAME.handshake:
      if (id !== 0) throw new LinkCloseError("protocol", "HANDSHAKE: id is not 0");
      if (length > LINK2_MAX_HANDSHAKE) throw new LinkCloseError("too_large", "HANDSHAKE: over 1,024 bytes");
      break;
    case LINK2_FRAME.request:
    case LINK2_FRAME.reply:
    case LINK2_FRAME.cancel:
      if (!named) throw new LinkCloseError("protocol", "request id is 0 or 0x80000000");
      if (type === LINK2_FRAME.cancel && length !== 0) throw new LinkCloseError("protocol", "CANCEL: payload is not empty");
      break;
    case LINK2_FRAME.event:
      if (id === LINK2_ID_HUB_BIT) throw new LinkCloseError("protocol", "EVENT: id 0x80000000");
      break;
    case LINK2_FRAME.data:
      if (!named) throw new LinkCloseError("protocol", "DATA: stream id is 0 or 0x80000000");
      if (length === 0 && (flags & LINK2_FLAG.end) === 0) throw new LinkCloseError("protocol", "DATA: 0 bytes without END");
      break;
    case LINK2_FRAME.credit:
    case LINK2_FRAME.reset:
      if (!named) throw new LinkCloseError("protocol", "CREDIT/RESET: id is 0 or 0x80000000");
      if (length !== 4) throw new LinkCloseError("protocol", "CREDIT/RESET: payload is not 4 bytes");
      break;
  }
  if ((type === LINK2_FRAME.request || type === LINK2_FRAME.event) && (flags & LINK2_FLAG.app) !== 0 && length < LINK2_APP_CHANNEL_PREFIX) {
    throw new LinkCloseError("protocol", "APP frame without its channel id");
  }
}

/** Encodes one frame. The caller's limit check: a payload over `limit` is a
 *  LinkEncodeError, since a sender never puts one on the wire. */
export function encodeFrame(frame: Link2Frame, limit: number = LINK2_PAYLOAD_CEILING): Uint8Array {
  if (frame.payload.length > limit) throw new LinkEncodeError(`frame payload ${frame.payload.length} over the limit ${limit}`);
  try {
    checkFrame(frame.type, frame.flags, frame.id >>> 0, frame.payload.length);
  } catch (error) {
    throw new LinkEncodeError((error as Error).message);
  }
  if (frame.type === LINK2_FRAME.credit && new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0, true) === 0) {
    throw new LinkEncodeError("CREDIT of 0");
  }
  const out = new Uint8Array(LINK2_HEADER_BYTES + frame.payload.length);
  const view = new DataView(out.buffer);
  out[0] = frame.type;
  out[1] = frame.flags;
  view.setUint16(2, 0, true);
  view.setUint32(4, frame.payload.length, true);
  view.setUint32(8, frame.id >>> 0, true);
  out.set(frame.payload, LINK2_HEADER_BYTES);
  return out;
}

/** Raw header fields, for tests that build frames a sender never would. */
export function encodeRawFrame(type: number, flags: number, reserved: number, id: number, payload: Uint8Array, length = payload.length): Uint8Array {
  const out = new Uint8Array(LINK2_HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  out[0] = type;
  out[1] = flags;
  view.setUint16(2, reserved, true);
  view.setUint32(4, length, true);
  view.setUint32(8, id >>> 0, true);
  out.set(payload, LINK2_HEADER_BYTES);
  return out;
}

/**
 * Streaming frame decoder. `write()` takes bytes as they arrive and `next()`
 * reads one whole frame of them at a time, by the rules in force when it is
 * called. Before `ready()` only HANDSHAKE, PING, PONG and CLOSE are valid and
 * the payload limit is LINK_MAX_HANDSHAKE; `ready(limit)` puts the negotiated
 * limit in force. **The handshake reads with `next()` and calls `ready()` on
 * the frame that changes the rules before it asks for the next one**, so
 * bytes behind `ready` that came in the same read are judged by the rules
 * after `ready` (§3.3). `push()` reads every frame of a chunk by one set of
 * rules. **A header whose `length` is over the limit throws before a payload
 * byte is buffered**, so a forged length cannot drive an allocation. Unknown
 * types after ready are skipped by length. A thrown LinkCloseError carries
 * the code to close with; the decoder is dead after it.
 */
export class Link2FrameDecoder {
  private header = new Uint8Array(LINK2_HEADER_BYTES);
  private headerFill = 0;
  private payload: Uint8Array | null = null;
  private payloadFill = 0;
  private skip = 0;
  /** Frames of an unknown type skipped so far: a peer counts each as a frame received (§4.6). */
  skipped = 0;
  private limit = LINK2_MAX_HANDSHAKE;
  private linked = false;
  private dead = false;
  /** Bytes written and not yet read, in order. */
  private input: Uint8Array[] = [];

  /** `ready` was sent or read: the negotiated payload limit applies from here. */
  ready(limit: number): void {
    if (!Number.isInteger(limit) || limit < LINK2_MIN_PAYLOAD || limit > LINK2_PAYLOAD_CEILING) {
      throw new LinkEncodeError(`payload limit ${limit} outside 1,024..32,768`);
    }
    this.limit = limit;
    this.linked = true;
  }

  /** Bytes this decoder holds: the bytes written and not yet read, and at
   *  most one header and one payload of the limit. */
  get buffered(): number {
    let unread = 0;
    for (const chunk of this.input) unread += chunk.length;
    return this.headerFill + this.payloadFill + unread;
  }

  /** Takes bytes as they arrive and reads none of them; `next()` reads. The
   *  chunk is kept by reference until it is read. Ignored once the decoder is dead. */
  write(chunk: Uint8Array): void {
    if (this.dead || chunk.length === 0) return;
    this.input.push(chunk);
  }

  /** The next whole frame of the bytes written so far, read by the rules in
   *  force now; null when they hold no whole frame yet. */
  next(): Link2Frame | null {
    if (this.dead) throw new LinkCloseError("protocol", "decoder used after an error");
    try {
      while (this.input.length > 0) {
        const chunk = this.input[0];
        if (this.skip > 0) {
          const n = Math.min(this.skip, chunk.length);
          this.skip -= n;
          this.consume(n);
          continue;
        }
        if (this.payload === null) {
          const n = Math.min(LINK2_HEADER_BYTES - this.headerFill, chunk.length);
          this.header.set(chunk.subarray(0, n), this.headerFill);
          this.headerFill += n;
          this.consume(n);
          if (this.headerFill < LINK2_HEADER_BYTES) continue;
          const frame = this.readHeader();
          if (frame !== null) return frame;
          continue;
        }
        const n = Math.min(this.payload.length - this.payloadFill, chunk.length);
        this.payload.set(chunk.subarray(0, n), this.payloadFill);
        this.payloadFill += n;
        this.consume(n);
        if (this.payloadFill === this.payload.length) return this.finish();
      }
      return null;
    } catch (error) {
      this.dead = true;
      this.input = [];
      throw error;
    }
  }

  /** Writes a chunk and reads every frame in it by the rules in force now.
   *  Not for the handshake, where `ready` changes the rules inside a chunk. */
  push(chunk: Uint8Array): Link2Frame[] {
    if (this.dead) throw new LinkCloseError("protocol", "decoder used after an error");
    this.write(chunk);
    const frames: Link2Frame[] = [];
    for (let frame = this.next(); frame !== null; frame = this.next()) frames.push(frame);
    return frames;
  }

  private consume(n: number): void {
    const chunk = this.input[0];
    if (n === chunk.length) this.input.shift();
    else this.input[0] = chunk.subarray(n);
  }

  /** Validates a complete header. Returns a frame when its payload is empty. */
  private readHeader(): Link2Frame | null {
    const view = new DataView(this.header.buffer);
    const type = this.header[0];
    const flags = this.header[1];
    const reserved = view.getUint16(2, true);
    const length = view.getUint32(4, true);
    const id = view.getUint32(8, true);
    if (reserved !== 0) throw new LinkCloseError("protocol", "non-zero reserved field");
    if (!this.linked && !BEFORE_READY.has(type)) {
      throw new LinkCloseError("protocol", `frame 0x${type.toString(16)} before ready`);
    }
    if (this.linked && type === LINK2_FRAME.handshake) throw new LinkCloseError("protocol", "HANDSHAKE after ready");
    if (length > this.limit) throw new LinkCloseError("too_large", `length ${length} over the limit ${this.limit}`);
    this.headerFill = 0;
    if (KNOWN_FLAGS[type] === undefined) {
      this.skip = length;
      this.skipped += 1;
      return null;
    }
    checkFrame(type, flags, id, length);
    if (length === 0) return { type, flags, id, payload: new Uint8Array(0) };
    this.payload = new Uint8Array(length);
    this.payloadFill = 0;
    this.pending = { type, flags, id };
    return null;
  }

  private pending = { type: 0, flags: 0, id: 0 };

  private finish(): Link2Frame {
    const payload = this.payload!;
    this.payload = null;
    this.payloadFill = 0;
    const { type, flags, id } = this.pending;
    if (type === LINK2_FRAME.credit && new DataView(payload.buffer).getUint32(0, true) === 0) {
      throw new LinkCloseError("protocol", "CREDIT of 0");
    }
    if ((type === LINK2_FRAME.close || type === LINK2_FRAME.reset) && new DataView(payload.buffer).getUint16(2, true) !== 0) {
      throw new LinkCloseError("protocol", "CLOSE/RESET: non-zero padding");
    }
    return { type, flags, id, payload };
  }
}

// ---------------------------------------------------------------------------
// Binary control frames
// ---------------------------------------------------------------------------

export function encodePing(counter: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, counter >>> 0, true);
  return encodeFrame({ type: LINK2_FRAME.ping, flags: 0, id: 0, payload });
}
/** The PONG that answers a PING: the same 4 bytes. */
export const encodePong = (ping: Link2Frame) => encodeFrame({ type: LINK2_FRAME.pong, flags: 0, id: 0, payload: ping.payload });

export function encodeClose(code: Link2CloseName, reason = ""): Uint8Array {
  const text = utf8Prefix(reason, LINK2_CLOSE_REASON_BYTES);
  const payload = new Uint8Array(4 + text.length);
  new DataView(payload.buffer).setUint16(0, LINK2_CLOSE[code], true);
  payload.set(text, 4);
  return encodeFrame({ type: LINK2_FRAME.close, flags: 0, id: 0, payload });
}
const CLOSE_NAME = new Map<number, Link2CloseName>(Object.entries(LINK2_CLOSE).map(([name, code]) => [code, name as Link2CloseName]));
/** An unknown code reads as `going_away` (§4.8). */
export function parseClose(frame: Link2Frame): { code: Link2CloseName; number: number; reason: string } {
  const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
  const number = view.getUint16(0, true);
  return { code: CLOSE_NAME.get(number) ?? "going_away", number, reason: new TextDecoder().decode(frame.payload.subarray(4)) };
}

/** Bytes on a stream id; units when `id` is an applet channel's (§5.6). */
export function encodeCredit(id: number, amount: number): Uint8Array {
  if (!Number.isInteger(amount) || amount < 1 || amount > 0xffff_ffff) throw new LinkEncodeError("CREDIT: amount outside 1..2^32-1");
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, amount, true);
  return encodeFrame({ type: LINK2_FRAME.credit, flags: 0, id, payload });
}
export const parseCredit = (frame: Link2Frame) => new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0, true);

export function encodeReset(id: number, code: Link2ResetName): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint16(0, LINK2_RESET[code], true);
  return encodeFrame({ type: LINK2_FRAME.reset, flags: 0, id, payload });
}
const RESET_NAME = new Map<number, Link2ResetName>(Object.entries(LINK2_RESET).map(([name, code]) => [code, name as Link2ResetName]));
export function parseReset(frame: Link2Frame): { code: Link2ResetName | null; number: number } {
  const number = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint16(0, true);
  return { code: RESET_NAME.get(number) ?? null, number };
}

export const encodeCancel = (id: number) => encodeFrame({ type: LINK2_FRAME.cancel, flags: 0, id, payload: new Uint8Array(0) });

export function encodeData(id: number, bytes: Uint8Array, end = false, limit: number = LINK2_PAYLOAD_CEILING): Uint8Array {
  return encodeFrame({ type: LINK2_FRAME.data, flags: end ? LINK2_FLAG.end : 0, id, payload: bytes }, limit);
}

// ---------------------------------------------------------------------------
// JSON frames
// ---------------------------------------------------------------------------

/** LINK_APP_MSG for a connection: min(8,192, payload limit − 4) (§7.2). */
export const appMessageLimit = (payloadLimit: number) => Math.min(LINK2_APP_MSG_CEILING, payloadLimit - LINK2_APP_CHANNEL_PREFIX);

export interface JsonFrameOptions {
  /** REPLY: the ERROR flag. */
  error?: boolean;
  /** REQUEST, EVENT: the APP flag with this channel id before the object. */
  channel?: number;
  /** REQUEST with a channel: a body follows on the request id. */
  body?: boolean;
  /** The payload limit in force; the default is the ceiling. */
  limit?: number;
}

/** One JSON object as the vectors fix it: no whitespace, keys in the order
 *  of the object. With `channel`, the object is checked against LINK_APP_MSG
 *  as the sender's own endpoint does (§7.2). */
export function encodeJsonFrame(type: number, id: number, object: unknown, options: JsonFrameOptions = {}): Uint8Array {
  const limit = options.limit ?? LINK2_PAYLOAD_CEILING;
  const json = encoder.encode(JSON.stringify(object));
  let flags = 0;
  let payload = json;
  if (options.error) flags |= LINK2_FLAG.error;
  if (options.channel !== undefined) {
    if (json.length > appMessageLimit(limit)) throw new LinkEncodeError(`too_large: applet object of ${json.length} bytes over ${appMessageLimit(limit)}`);
    flags |= LINK2_FLAG.app;
    if (options.body) flags |= LINK2_FLAG.body;
    payload = new Uint8Array(4 + json.length);
    new DataView(payload.buffer).setUint32(0, options.channel >>> 0, true);
    payload.set(json, 4);
  }
  return encodeFrame({ type, flags, id, payload }, type === LINK2_FRAME.handshake ? LINK2_MAX_HANDSHAKE : limit);
}

export interface JsonPayload {
  /** The channel id of an APP frame. */
  channel?: number;
  /** The JSON object; null when the bytes are not one JSON object. */
  object: Record<string, unknown> | null;
  /** Bytes of the JSON object in the frame. */
  bytes: number;
}

/** Splits an APP frame's channel id from its object and parses the object.
 *  A payload that is not a JSON object gives `object: null`: the receiver
 *  answers a request with `malformed` and ignores an event (§4.7). */
export function parseJsonPayload(frame: Link2Frame): JsonPayload {
  let bytes = frame.payload;
  let channel: number | undefined;
  if ((frame.type === LINK2_FRAME.request || frame.type === LINK2_FRAME.event) && (frame.flags & LINK2_FLAG.app) !== 0) {
    channel = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    bytes = bytes.subarray(4);
  }
  let object: Record<string, unknown> | null = null;
  try {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error("byte-order mark");
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) object = parsed as Record<string, unknown>;
  } catch {
    object = null;
  }
  return { channel, object, bytes: bytes.length };
}

// ---------------------------------------------------------------------------
// §3.4, §3.5 Handshake
// ---------------------------------------------------------------------------

export function proofMessage(label: string, deviceNonce: string, hubNonce: string, device: string, companion: string): string {
  return [label, deviceNonce, hubNonce, device, companion].join("\n");
}
export function linkHmac(keyHex: string, message: string): string {
  if (!KEY_RE.test(keyHex)) throw new LinkEncodeError("link key is not 64 lowercase hex digits");
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(message, "utf8").digest("hex");
}
export const companionProof = (key: string, nD: string, nC: string, device: string, companion: string) =>
  linkHmac(key, proofMessage(LINK2_LABEL.companion, nD, nC, device, companion));
export const consoleProof = (key: string, nD: string, nC: string, device: string, companion: string) =>
  linkHmac(key, proofMessage(LINK2_LABEL.console, nD, nC, device, companion));
/** Constant-time comparison of two proofs as sent. */
export function proofEquals(a: string, b: string): boolean {
  if (!PROOF_RE.test(a) || !PROOF_RE.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// ---------------------------------------------------------------------------
// §3.11 Pairing by a code the device shows
// ---------------------------------------------------------------------------

const CODE_RE = new RegExp(`^[0-9]{${LINK2_PAIR_CODE_DIGITS}}$`);
export const isPairCode = (value: unknown): value is string => typeof value === "string" && CODE_RE.test(value);
/** A code as a device makes one: uniform over the 10^digits values. */
export const newPairCode = () => String(randomInt(10 ** LINK2_PAIR_CODE_DIGITS)).padStart(LINK2_PAIR_CODE_DIGITS, "0");
/** HMAC-SHA256 keyed with the code's digits as they are shown (ASCII). */
function codeHmac(code: string, message: string): Buffer {
  if (!isPairCode(code)) throw new LinkEncodeError(`a pairing code is ${LINK2_PAIR_CODE_DIGITS} decimal digits`);
  return createHmac("sha256", Buffer.from(code, "ascii")).update(message, "utf8").digest();
}
/** Hub's proof that the code its owner entered is the one the device shows. */
export const pairCompanionProof = (code: string, nD: string, nC: string, device: string, companion: string) =>
  codeHmac(code, proofMessage(LINK2_LABEL.pairCompanion, nD, nC, device, companion)).toString("hex");
/** The link key XOR HMAC(code, …): Hub masks the key with it and the device
 *  unmasks it with the same call. */
export function pairMaskKey(code: string, keyHex: string, nD: string, nC: string, device: string, companion: string): string {
  if (!KEY_RE.test(keyHex)) throw new LinkEncodeError("link key is not 64 lowercase hex digits");
  const mask = codeHmac(code, proofMessage(LINK2_LABEL.pairKey, nD, nC, device, companion));
  const key = Buffer.from(keyHex, "hex");
  for (let i = 0; i < key.length; i++) key[i] ^= mask[i];
  return key.toString("hex");
}
/** The device's proof that it unmasked the key: keyed with the link key. */
export const pairConsoleProof = (key: string, nD: string, nC: string, device: string, companion: string) =>
  linkHmac(key, proofMessage(LINK2_LABEL.pairConsole, nD, nC, device, companion));

/** Hub's reading of a `pair` object: the message, or why it is malformed. */
export function parsePair(object: Record<string, unknown> | null): Link2Pair | { refused: "malformed"; why: string } {
  const bad = (why: string) => ({ refused: "malformed" as const, why });
  if (object === null || object.t !== "pair") return bad("not a pair");
  if (!isLinkId(object.device)) return bad("device");
  if (typeof object.nonce !== "string" || !NONCE_RE.test(object.nonce)) return bad("nonce");
  if (typeof object.name !== "string" || encodedBytes(object.name) > LINK2_NAME_BYTES) return bad("name");
  if (typeof object.model !== "string" || encodedBytes(object.model) > LINK2_MODEL_BYTES) return bad("model");
  if (typeof object.target !== "string" || encodedBytes(object.target) > LINK2_TARGET_BYTES) return bad("target");
  return { t: "pair", device: object.device, nonce: object.nonce, name: object.name, model: object.model, target: object.target };
}
export function parsePairOffer(object: Record<string, unknown> | null): Link2PairOffer | null {
  if (object === null || object.t !== "pair.offer" || !isLinkId(object.companion)) return null;
  if (typeof object.name !== "string" || encodedBytes(object.name) > LINK2_NAME_BYTES) return null;
  if (typeof object.nonce !== "string" || !NONCE_RE.test(object.nonce)) return null;
  if (typeof object.proof !== "string" || !PROOF_RE.test(object.proof)) return null;
  if (typeof object.key !== "string" || !KEY_RE.test(object.key)) return null;
  return { t: "pair.offer", companion: object.companion, name: object.name, nonce: object.nonce, proof: object.proof, key: object.key };
}
export function parsePairAccept(object: Record<string, unknown> | null): Link2PairAccept | null {
  if (object === null || object.t !== "pair.accept" || typeof object.proof !== "string" || !PROOF_RE.test(object.proof)) return null;
  return { t: "pair.accept", proof: object.proof };
}

const validPayloadOffer = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= LINK2_MIN_PAYLOAD && value <= LINK2_PAYLOAD_CEILING;

/** The payload limit of a connection (§4.4). */
export function payloadLimit(helloMax: number, readyMax: number): number {
  if (!validPayloadOffer(helloMax) || !validPayloadOffer(readyMax)) throw new LinkEncodeError("maxPayload outside 1,024..32,768");
  return Math.min(helloMax, readyMax);
}

function featureList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > LINK2_MAX_FEATURES) return null;
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || encodedBytes(entry) > LINK2_FEATURE_BYTES) return null;
  }
  return value as string[];
}
/** A `features` list within its limits, or null (§6.1): for hello, ready and
 *  the `features` event, whose receiver closes with `protocol` on null. */
export const parseFeatures = featureList;

const str = (value: unknown, max: number): value is string => typeof value === "string" && encodedBytes(value) <= max;

/** Hub's reading of a `hello` object: the message, or the refusal `malformed`
 *  (§3.8) when a field is missing, has the wrong type or breaks its limit. */
export function parseHello(object: Record<string, unknown> | null): Link2Hello | { refused: "malformed"; why: string } {
  const bad = (why: string) => ({ refused: "malformed" as const, why });
  if (object === null || object.t !== "hello") return bad("not a hello");
  if (!isLinkId(object.device)) return bad("device");
  if (!isLinkId(object.companion)) return bad("companion");
  if (typeof object.nonce !== "string" || !NONCE_RE.test(object.nonce)) return bad("nonce");
  if (!str(object.name, LINK2_NAME_BYTES)) return bad("name");
  if (!str(object.model, LINK2_MODEL_BYTES)) return bad("model");
  if (!str(object.target, LINK2_TARGET_BYTES) || object.target.length === 0) return bad("target");
  if (typeof object.hostAbi !== "number" || !Number.isInteger(object.hostAbi) || object.hostAbi < 0 || object.hostAbi > 0xffff_ffff) return bad("hostAbi");
  const features = featureList(object.features);
  if (features === null) return bad("features");
  if (!validPayloadOffer(object.maxPayload)) return bad("maxPayload");
  return {
    t: "hello",
    device: object.device,
    companion: object.companion,
    nonce: object.nonce,
    name: object.name,
    model: object.model,
    target: object.target,
    hostAbi: object.hostAbi,
    features,
    maxPayload: object.maxPayload,
  };
}

export function parseChallenge(object: Record<string, unknown> | null): Link2Challenge | null {
  if (object === null || object.t !== "challenge") return null;
  if (typeof object.nonce !== "string" || !NONCE_RE.test(object.nonce)) return null;
  if (typeof object.proof !== "string" || !PROOF_RE.test(object.proof)) return null;
  return { t: "challenge", nonce: object.nonce, proof: object.proof };
}
export function parseAuth(object: Record<string, unknown> | null): Link2Auth | null {
  if (object === null || object.t !== "auth" || typeof object.proof !== "string" || !PROOF_RE.test(object.proof)) return null;
  return { t: "auth", proof: object.proof };
}

/** The device's reading of `ready`. A `maxPayload` outside the range, or any
 *  other broken field, throws LinkCloseError `protocol` (§3.4). */
export function parseReady(object: Record<string, unknown> | null): Link2Ready {
  const bad = (why: string): never => {
    throw new LinkCloseError("protocol", `ready: ${why}`);
  };
  if (object === null || object.t !== "ready") return bad("not a ready");
  if (!str(object.name, LINK2_NAME_BYTES)) return bad("name");
  const features = featureList(object.features);
  if (features === null) return bad("features");
  if (!validPayloadOffer(object.maxPayload)) return bad("maxPayload");
  const clock = object.clock as { utc?: unknown; local?: unknown } | undefined;
  if (typeof clock !== "object" || clock === null || typeof clock.utc !== "number" || typeof clock.local !== "number") return bad("clock");
  return { t: "ready", name: object.name as string, features, maxPayload: object.maxPayload as number, clock: { utc: clock.utc, local: clock.local } };
}

export function parseRefused(object: Record<string, unknown> | null): Link2Refused | null {
  if (object === null || object.t !== "refused" || typeof object.code !== "string") return null;
  if (!(LINK2_REFUSAL as readonly string[]).includes(object.code)) return null;
  return { t: "refused", code: object.code as Link2RefusalCode, message: typeof object.message === "string" ? object.message : "" };
}

/** A HANDSHAKE frame; a message over LINK_MAX_HANDSHAKE is the caller's error. */
export const encodeHandshake = (message: Link2Hello | Link2Challenge | Link2Auth | Link2Ready | Link2Refused | Link2Pair | Link2PairOffer | Link2PairAccept | Link2PairDone) =>
  encodeJsonFrame(LINK2_FRAME.handshake, 0, message);

export function refused(code: Link2RefusalCode, message: string): Link2Refused {
  return { t: "refused", code, message: encodedPrefix(message, LINK2_REFUSED_MESSAGE_BYTES) };
}
