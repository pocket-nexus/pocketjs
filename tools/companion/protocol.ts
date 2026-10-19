// Pocket Link wire codec (contracts/spec/link.ts): beacon, preamble, frames,
// the HMAC-SHA256 handshake proofs, the masked pairing key and the pairing
// URI. Shared by the companion daemon and the reference console client.
//
// Byte conventions the contract leaves implicit, fixed here for every
// implementation: an HMAC key is the RAW bytes of the secret (the pairing key
// is 32 bytes, the pairing secret 16 bytes; both travel as lowercase hex), the
// HMAC message is the UTF-8 label string built from the hex nonces and ids as
// sent, and every proof travels as 64 lowercase hex digits.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  LINK_BEACON_BYTES,
  LINK_BEACON_FLAG_PAIRING,
  LINK_BEACON_MAGIC,
  LINK_BEACON_NAME_BYTES,
  LINK_FRAME,
  LINK_HEADER_BYTES,
  LINK_ID_HEX,
  LINK_KEY_BYTES,
  LINK_LABEL,
  LINK_MAGIC,
  LINK_MAX_CTRL,
  LINK_MAX_DATA,
  LINK_MAX_FRAME,
  LINK_NONCE_BYTES,
  LINK_PAIR_MAX_HOSTS,
  LINK_PAIR_SCHEME,
  LINK_PAIR_SECRET_BYTES,
  LINK_PAIR_URI_MAX,
  LINK_PREAMBLE_BYTES,
  LINK_VERSION,
} from "../../contracts/spec/link.ts";

export class LinkProtocolError extends Error {}

const ID_RE = /^[0-9a-f]{16}$/;
const hexRe = (bytes: number) => new RegExp(`^[0-9a-f]{${bytes * 2}}$`);
export const NONCE_RE = hexRe(LINK_NONCE_BYTES);
export const KEY_RE = hexRe(LINK_KEY_BYTES);
export const SECRET_RE = hexRe(LINK_PAIR_SECRET_BYTES);
export const PROOF_RE = /^[0-9a-f]{64}$/;

export const isLinkId = (value: unknown): value is string => typeof value === "string" && ID_RE.test(value);
export const newLinkId = () => randomBytes(LINK_ID_HEX / 2).toString("hex");
export const newNonce = () => randomBytes(LINK_NONCE_BYTES).toString("hex");
export const newKey = () => randomBytes(LINK_KEY_BYTES).toString("hex");
export const newPairSecret = () => randomBytes(LINK_PAIR_SECRET_BYTES).toString("hex");

// ---------------------------------------------------------------------------
// Beacon
// ---------------------------------------------------------------------------

export interface LinkBeacon {
  version: number;
  pairing: boolean;
  port: number;
  companion: string;
  name: string;
}

/** Longest prefix of `text` whose UTF-8 encoding fits `max` bytes, cut on a
 *  code point boundary. */
export function utf8Prefix(text: string, max: number): Uint8Array {
  const encoder = new TextEncoder();
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

export function encodeBeacon(beacon: Omit<LinkBeacon, "version">): Uint8Array {
  if (!isLinkId(beacon.companion)) throw new LinkProtocolError("beacon: invalid companion id");
  if (!Number.isInteger(beacon.port) || beacon.port < 1 || beacon.port > 0xffff) {
    throw new LinkProtocolError("beacon: invalid port");
  }
  const out = new Uint8Array(LINK_BEACON_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, LINK_BEACON_MAGIC, true);
  out[4] = LINK_VERSION;
  out[5] = beacon.pairing ? LINK_BEACON_FLAG_PAIRING : 0;
  view.setUint16(6, beacon.port, true);
  out.set(new TextEncoder().encode(beacon.companion), 8);
  out.set(utf8Prefix(beacon.name, LINK_BEACON_NAME_BYTES), 24);
  return out;
}

export function decodeBeacon(bytes: Uint8Array): LinkBeacon | null {
  if (bytes.length !== LINK_BEACON_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== LINK_BEACON_MAGIC) return null;
  const companion = new TextDecoder().decode(bytes.subarray(8, 24));
  if (!isLinkId(companion)) return null;
  let end = 24;
  while (end < 24 + LINK_BEACON_NAME_BYTES && bytes[end] !== 0) end++;
  return {
    version: bytes[4],
    pairing: (bytes[5] & LINK_BEACON_FLAG_PAIRING) !== 0,
    port: view.getUint16(6, true),
    companion,
    name: new TextDecoder().decode(bytes.subarray(24, end)),
  };
}

// ---------------------------------------------------------------------------
// Preamble + frames
// ---------------------------------------------------------------------------

export function encodePreamble(version = LINK_VERSION): Uint8Array {
  const out = new Uint8Array(LINK_PREAMBLE_BYTES);
  new DataView(out.buffer).setUint32(0, LINK_MAGIC, true);
  out[4] = version;
  return out;
}

/** The preamble's version, or null when the magic does not match. */
export function decodePreamble(bytes: Uint8Array): number | null {
  if (bytes.length < LINK_PREAMBLE_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === LINK_MAGIC ? bytes[4] : null;
}

export function encodeFrame(type: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > LINK_MAX_FRAME) throw new LinkProtocolError("frame too long");
  const out = new Uint8Array(LINK_HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  out[0] = type;
  view.setUint32(4, payload.length, true);
  out.set(payload, LINK_HEADER_BYTES);
  return out;
}

export type LinkCtrl = { t: string; [field: string]: unknown };

export function encodeCtrl(message: LinkCtrl): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  if (payload.length > LINK_MAX_CTRL) throw new LinkProtocolError(`ctrl message too long (${payload.length} bytes)`);
  return encodeFrame(LINK_FRAME.ctrl, payload);
}

export function encodeData(stream: number, bytes: Uint8Array): Uint8Array {
  if (bytes.length > LINK_MAX_DATA) throw new LinkProtocolError("data chunk too long");
  const payload = new Uint8Array(4 + bytes.length);
  new DataView(payload.buffer).setUint32(0, stream >>> 0, true);
  payload.set(bytes, 4);
  return encodeFrame(LINK_FRAME.data, payload);
}

export const encodePing = () => encodeFrame(LINK_FRAME.ping);
export const encodePong = () => encodeFrame(LINK_FRAME.pong);

export type LinkFrame =
  | { type: "ping" }
  | { type: "pong" }
  | { type: "ctrl"; message: LinkCtrl }
  | { type: "data"; stream: number; bytes: Uint8Array }
  | { type: "unknown"; code: number };

/** Incremental frame decoder. With `preamble: true` the first 8 bytes must be
 *  the connection preamble; its version is reported through `onPreamble`.
 *  Throws LinkProtocolError on a frame longer than LINK_MAX_FRAME, a ctrl
 *  frame that is not one JSON object, or a short data frame — the caller
 *  closes the connection. */
export class LinkFrameDecoder {
  private buffer = new Uint8Array(0);
  private preambleDone: boolean;

  constructor(private readonly options: { preamble?: boolean; onPreamble?: (version: number) => void } = {}) {
    this.preambleDone = !options.preamble;
  }

  push(chunk: Uint8Array): LinkFrame[] {
    if (this.buffer.length === 0) this.buffer = chunk.slice();
    else {
      const next = new Uint8Array(this.buffer.length + chunk.length);
      next.set(this.buffer);
      next.set(chunk, this.buffer.length);
      this.buffer = next;
    }
    const frames: LinkFrame[] = [];
    let off = 0;
    if (!this.preambleDone) {
      if (this.buffer.length < LINK_PREAMBLE_BYTES) return frames;
      const version = decodePreamble(this.buffer);
      if (version === null) throw new LinkProtocolError("bad preamble");
      this.preambleDone = true;
      off = LINK_PREAMBLE_BYTES;
      this.options.onPreamble?.(version);
    }
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
    while (this.buffer.length - off >= LINK_HEADER_BYTES) {
      const type = this.buffer[off];
      const length = view.getUint32(off + 4, true);
      if (length > LINK_MAX_FRAME) throw new LinkProtocolError(`frame of ${length} bytes exceeds ${LINK_MAX_FRAME}`);
      if (this.buffer.length - off - LINK_HEADER_BYTES < length) break;
      const payload = this.buffer.subarray(off + LINK_HEADER_BYTES, off + LINK_HEADER_BYTES + length);
      off += LINK_HEADER_BYTES + length;
      frames.push(parseFrame(type, payload));
    }
    this.buffer = this.buffer.slice(off);
    return frames;
  }
}

function parseFrame(type: number, payload: Uint8Array): LinkFrame {
  switch (type) {
    case LINK_FRAME.ping:
      return { type: "ping" };
    case LINK_FRAME.pong:
      return { type: "pong" };
    case LINK_FRAME.ctrl: {
      if (payload.length > LINK_MAX_CTRL) throw new LinkProtocolError("ctrl frame too long");
      let message: unknown;
      try {
        message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
      } catch {
        throw new LinkProtocolError("ctrl frame is not JSON");
      }
      if (!message || typeof message !== "object" || Array.isArray(message) || typeof (message as LinkCtrl).t !== "string") {
        throw new LinkProtocolError("ctrl frame is not a message object");
      }
      return { type: "ctrl", message: message as LinkCtrl };
    }
    case LINK_FRAME.data: {
      if (payload.length < 4) throw new LinkProtocolError("data frame without stream id");
      const stream = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true);
      return { type: "data", stream, bytes: payload.slice(4) };
    }
    default:
      return { type: "unknown", code: type };
  }
}

// ---------------------------------------------------------------------------
// Handshake proofs
// ---------------------------------------------------------------------------

export interface LinkHandshakeInputs {
  /** Console nonce (hello.nonce), hex as sent. */
  nD: string;
  /** Companion nonce (challenge.nonce), hex as sent. */
  nC: string;
  device: string;
  companion: string;
}

const hexBytes = (hex: string) => Buffer.from(hex, "hex");

export function linkHmac(secretHex: string, message: string): Buffer {
  return createHmac("sha256", hexBytes(secretHex)).update(message, "utf8").digest();
}

export function proofMessage(label: string, h: LinkHandshakeInputs): string {
  return `${label}\n${h.nD}\n${h.nC}\n${h.device}\n${h.companion}`;
}

export const companionProof = (secretHex: string, h: LinkHandshakeInputs) =>
  linkHmac(secretHex, proofMessage(LINK_LABEL.companion, h)).toString("hex");

export const consoleProof = (secretHex: string, h: LinkHandshakeInputs) =>
  linkHmac(secretHex, proofMessage(LINK_LABEL.console, h)).toString("hex");

export const keyMaskMessage = (nD: string, nC: string) => `${LINK_LABEL.key}\n${nD}\n${nC}`;

/** paired.key = key XOR HMAC(secret, "pocket-link/1/key\n" + nD + "\n" + nC).
 *  The same function unmasks. */
export function maskKey(keyHex: string, secretHex: string, nD: string, nC: string): string {
  const key = hexBytes(keyHex);
  if (key.length !== LINK_KEY_BYTES) throw new LinkProtocolError("key must be 32 bytes");
  const mask = linkHmac(secretHex, keyMaskMessage(nD, nC));
  const out = Buffer.alloc(LINK_KEY_BYTES);
  for (let i = 0; i < LINK_KEY_BYTES; i++) out[i] = key[i] ^ mask[i];
  return out.toString("hex");
}

/** Constant-time comparison of two hex proofs. */
export function proofEquals(a: unknown, b: string): boolean {
  if (typeof a !== "string" || !PROOF_RE.test(a) || !PROOF_RE.test(b)) return false;
  return timingSafeEqual(hexBytes(a), hexBytes(b));
}

// ---------------------------------------------------------------------------
// Pairing URI
// ---------------------------------------------------------------------------

export interface LinkPairUri {
  version: number;
  companion: string;
  hosts: string[];
  port: number;
  secret: string;
  name: string;
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export const isIPv4 = (value: string) => IPV4_RE.test(value);

/** RFC 3986 unreserved characters stay literal; every other byte is %XX. */
function percentEncode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Build the pairing URI. Hosts beyond LINK_PAIR_MAX_HOSTS are dropped; the
 *  name is shortened (on a code point boundary) until the URI is shorter than
 *  LINK_PAIR_URI_MAX bytes — the console learns the full name from `paired`. */
export function buildPairUri(input: Omit<LinkPairUri, "version">): string {
  if (!isLinkId(input.companion)) throw new LinkProtocolError("pair uri: invalid companion id");
  if (!SECRET_RE.test(input.secret)) throw new LinkProtocolError("pair uri: invalid secret");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 0xffff) throw new LinkProtocolError("pair uri: invalid port");
  const hosts = input.hosts.slice(0, LINK_PAIR_MAX_HOSTS);
  if (hosts.length === 0 || !hosts.every(isIPv4)) throw new LinkProtocolError("pair uri: needs 1-3 IPv4 hosts");
  const head = `${LINK_PAIR_SCHEME}?v=${LINK_VERSION}&c=${input.companion}&h=${hosts.join(",")}&p=${input.port}&s=${input.secret}&n=`;
  const chars = [...input.name];
  for (let n = chars.length; n >= 0; n--) {
    const uri = head + percentEncode(chars.slice(0, n).join(""));
    if (Buffer.byteLength(uri) < LINK_PAIR_URI_MAX) return uri;
  }
  throw new LinkProtocolError("pair uri: too long even without a name");
}

export function parsePairUri(uri: string): LinkPairUri | null {
  if (typeof uri !== "string" || Buffer.byteLength(uri) >= LINK_PAIR_URI_MAX) return null;
  const prefix = `${LINK_PAIR_SCHEME}?`;
  if (!uri.startsWith(prefix)) return null;
  const fields = new Map<string, string>();
  for (const part of uri.slice(prefix.length).split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    try {
      fields.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)));
    } catch {
      return null;
    }
  }
  const version = Number(fields.get("v"));
  const companion = fields.get("c") ?? "";
  const hosts = (fields.get("h") ?? "").split(",").filter(Boolean);
  const port = Number(fields.get("p"));
  const secret = fields.get("s") ?? "";
  if (version !== LINK_VERSION || !isLinkId(companion) || !SECRET_RE.test(secret)) return null;
  if (hosts.length === 0 || hosts.length > LINK_PAIR_MAX_HOSTS || !hosts.every(isIPv4)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 0xffff) return null;
  return { version, companion, hosts, port, secret, name: fields.get("n") ?? "" };
}
