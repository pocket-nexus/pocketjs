// Pocket Runtime development wire protocol.
//
// One authenticated TCP connection carries ordered control and bulk frames.
// JSON is used only for the existing Pocket DevTools control/log protocol;
// `.pocket` bytes and screenshots stay binary and never enter QuickJS.

import { crc32 } from "node:zlib";

export const POCKET_RUNTIME_WIRE_MAGIC = 0x54524b50; // 'PKRT' little-endian
export const POCKET_RUNTIME_DISCOVERY_MAGIC = 0x44524b50; // 'PKRD' little-endian
export const POCKET_RUNTIME_WIRE_VERSION = 1;
export const POCKET_RUNTIME_WIRE_PORT = 8131;
export const POCKET_RUNTIME_DISCOVERY_REQUEST_BYTES = 8;
export const POCKET_RUNTIME_DISCOVERY_REPLY_BYTES = 64;
export const POCKET_RUNTIME_DISCOVERY_REQUEST = 1;
export const POCKET_RUNTIME_DISCOVERY_REPLY = 2;
export const POCKET_RUNTIME_TOKEN_BYTES = 32;
export const POCKET_RUNTIME_HELLO_BYTES = 8 + POCKET_RUNTIME_TOKEN_BYTES;
export const POCKET_RUNTIME_ACK_BYTES = 24;
export const POCKET_RUNTIME_FRAME_HEADER_BYTES = 8;
export const POCKET_RUNTIME_MAX_FRAME_BYTES = 64 * 1024;
/** The largest control record a TOOL may send: a device sizes its inbound ring
 *  from this. Records travelling the other way are bounded by the frame, since
 *  a device queues them into a buffer already sized for one — a devtools tree
 *  dump runs past 16 KiB on any app of a few hundred nodes. */
export const POCKET_RUNTIME_MAX_CTRL_BYTES = 16 * 1024;
export const POCKET_RUNTIME_PACKAGE_BEGIN_BYTES = 12;
export const POCKET_RUNTIME_SCREENSHOT_BEGIN_BYTES = 24;
export const POCKET_RUNTIME_SCREENSHOT_FORMAT_ROTATED_RGB8 = 1;
/** Ack flags: the listener is up; the Runtime installs and launches .3dsx files. */
export const POCKET_RUNTIME_ACK_FLAG_LISTENING = 1;
export const POCKET_RUNTIME_ACK_FLAG_NATIVE = 2;
/** A .3dsx travels under a bare file name and lands at sdmc:/3ds/<name>. */
export const POCKET_RUNTIME_NATIVE_NAME_BYTES = 64;
export const POCKET_RUNTIME_NATIVE_BEGIN_BYTES = 12 + POCKET_RUNTIME_NATIVE_NAME_BYTES;
export const POCKET_RUNTIME_LAUNCH_BYTES = 4 + POCKET_RUNTIME_NATIVE_NAME_BYTES;
/** A 3DSX header alone is 0x20 bytes. */
export const POCKET_RUNTIME_NATIVE_MIN_BYTES = 0x20;
export const POCKET_RUNTIME_NATIVE_MAX_BYTES = 32 * 1024 * 1024;
export const POCKET_RUNTIME_NATIVE_FLAG_LAUNCH = 1;

export const POCKET_RUNTIME_MSG = {
  ping: 0x01,
  pong: 0x02,
  ctrl: 0x10,
  packageBegin: 0x20,
  packageChunk: 0x21,
  packageCommit: 0x22,
  packageAbort: 0x23,
  nativeBegin: 0x24,
  nativeChunk: 0x25,
  nativeCommit: 0x26,
  nativeAbort: 0x27,
  launch: 0x28,
  screenshotBegin: 0x30,
  screenshotChunk: 0x31,
  screenshotEnd: 0x32,
  statusRequest: 0x40,
} as const;

export interface PocketRuntimeAck {
  readonly accepted: boolean;
  readonly status: number;
  readonly hostAbi: number;
  readonly generation: number;
  readonly flags: number;
  readonly activeHash: bigint;
}

export interface PocketRuntimeFrame {
  readonly type: number;
  readonly flags: number;
  readonly payload: Uint8Array;
}

export interface PocketRuntimeScreenshotBegin {
  readonly frame: number;
  readonly topWidth: number;
  readonly topHeight: number;
  readonly auxiliaryWidth: number;
  readonly auxiliaryHeight: number;
  readonly format: number;
  readonly topBytes: number;
  readonly auxiliaryBytes: number;
}

export interface PocketRuntimeDiscovery {
  readonly hostAbi: number;
  readonly port: number;
  readonly flags: number;
  readonly generation: number;
  readonly activeHash: bigint;
  readonly deviceId: bigint;
  readonly target: string;
  readonly label: string;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function fixedText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

export function pocketRuntimeDeviceId(token: Uint8Array): bigint {
  if (token.length !== POCKET_RUNTIME_TOKEN_BYTES) {
    throw new Error(`Pocket Runtime token must be ${POCKET_RUNTIME_TOKEN_BYTES} bytes`);
  }
  let hash = 0xcbf29ce484222325n;
  for (const byte of token) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

export function encodePocketRuntimeDiscoveryRequest(): Uint8Array {
  const bytes = new Uint8Array(POCKET_RUNTIME_DISCOVERY_REQUEST_BYTES);
  const data = view(bytes);
  data.setUint32(0, POCKET_RUNTIME_DISCOVERY_MAGIC, true);
  data.setUint8(4, POCKET_RUNTIME_WIRE_VERSION);
  data.setUint8(5, POCKET_RUNTIME_DISCOVERY_REQUEST);
  return bytes;
}

export function decodePocketRuntimeDiscoveryReply(
  bytes: Uint8Array,
): PocketRuntimeDiscovery {
  if (bytes.length !== POCKET_RUNTIME_DISCOVERY_REPLY_BYTES) {
    throw new Error(`Pocket Runtime discovery reply must be ${POCKET_RUNTIME_DISCOVERY_REPLY_BYTES} bytes`);
  }
  const data = view(bytes);
  if (data.getUint32(0, true) !== POCKET_RUNTIME_DISCOVERY_MAGIC ||
      data.getUint8(4) !== POCKET_RUNTIME_WIRE_VERSION ||
      data.getUint8(5) !== POCKET_RUNTIME_DISCOVERY_REPLY) {
    throw new Error("Pocket Runtime discovery reply has the wrong identity");
  }
  const target = fixedText(bytes.subarray(32, 48));
  const label = fixedText(bytes.subarray(48, 64));
  if (!target) throw new Error("Pocket Runtime discovery reply has no target");
  return {
    hostAbi: data.getUint16(6, true),
    port: data.getUint16(8, true),
    flags: data.getUint16(10, true),
    generation: data.getUint32(12, true),
    activeHash: data.getBigUint64(16, true),
    deviceId: data.getBigUint64(24, true),
    target,
    label,
  };
}

export function encodePocketRuntimeHello(token: Uint8Array): Uint8Array {
  if (token.length !== POCKET_RUNTIME_TOKEN_BYTES) {
    throw new Error(`Pocket Runtime token must be ${POCKET_RUNTIME_TOKEN_BYTES} bytes`);
  }
  const bytes = new Uint8Array(POCKET_RUNTIME_HELLO_BYTES);
  const data = view(bytes);
  data.setUint32(0, POCKET_RUNTIME_WIRE_MAGIC, true);
  data.setUint8(4, POCKET_RUNTIME_WIRE_VERSION);
  data.setUint8(5, 0);
  data.setUint16(6, token.length, true);
  bytes.set(token, 8);
  return bytes;
}

export function decodePocketRuntimeAck(bytes: Uint8Array): PocketRuntimeAck {
  if (bytes.length !== POCKET_RUNTIME_ACK_BYTES) {
    throw new Error(`Pocket Runtime ack must be ${POCKET_RUNTIME_ACK_BYTES} bytes`);
  }
  const data = view(bytes);
  if (data.getUint32(0, true) !== POCKET_RUNTIME_WIRE_MAGIC) {
    throw new Error("Pocket Runtime ack has the wrong magic");
  }
  if (data.getUint8(4) !== POCKET_RUNTIME_WIRE_VERSION) {
    throw new Error(`Pocket Runtime protocol version ${data.getUint8(4)} is unsupported`);
  }
  const status = data.getUint8(5);
  return {
    accepted: status === 0,
    status,
    hostAbi: data.getUint16(6, true),
    generation: data.getUint32(8, true),
    flags: data.getUint32(12, true),
    activeHash: data.getBigUint64(16, true),
  };
}

export function encodePocketRuntimeFrame(
  type: number,
  payload: Uint8Array = new Uint8Array(0),
  flags = 0,
): Uint8Array {
  if (!Number.isInteger(type) || type < 0 || type > 0xff ||
      !Number.isInteger(flags) || flags < 0 || flags > 0xff) {
    throw new Error("Pocket Runtime frame type or flags are outside one byte");
  }
  if (payload.length > POCKET_RUNTIME_MAX_FRAME_BYTES) {
    throw new Error(`Pocket Runtime frame exceeds ${POCKET_RUNTIME_MAX_FRAME_BYTES} bytes`);
  }
  const bytes = new Uint8Array(POCKET_RUNTIME_FRAME_HEADER_BYTES + payload.length);
  const data = view(bytes);
  data.setUint8(0, type);
  data.setUint8(1, flags);
  data.setUint16(2, 0, true);
  data.setUint32(4, payload.length, true);
  bytes.set(payload, POCKET_RUNTIME_FRAME_HEADER_BYTES);
  return bytes;
}

export function encodePocketRuntimePackageBegin(
  length: number,
  footerHash: bigint,
): Uint8Array {
  if (!Number.isSafeInteger(length) || length <= 0 || length > 24 * 1024 * 1024) {
    throw new Error("Pocket Runtime package length is outside the 24 MiB limit");
  }
  if (footerHash <= 0n || footerHash > 0xffffffffffffffffn) {
    throw new Error("Pocket Runtime package footer hash is outside unsigned 64-bit range");
  }
  const bytes = new Uint8Array(POCKET_RUNTIME_PACKAGE_BEGIN_BYTES);
  const data = view(bytes);
  data.setUint32(0, length, true);
  data.setBigUint64(4, footerHash, true);
  return bytes;
}

/** A `.pocket` or `.3dsx` chunk: u32 absolute offset, then the bytes. */
export function encodePocketRuntimeChunk(
  offset: number,
  bytes: Uint8Array,
): Uint8Array {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 0xffffffff || bytes.length === 0) {
    throw new Error("Pocket Runtime chunk has an invalid offset or empty payload");
  }
  if (bytes.length + 4 > POCKET_RUNTIME_MAX_FRAME_BYTES) {
    throw new Error("Pocket Runtime chunk is too large");
  }
  const payload = new Uint8Array(4 + bytes.length);
  view(payload).setUint32(0, offset, true);
  payload.set(bytes, 4);
  return payload;
}

/** 6..64 bytes of [A-Za-z0-9._-], ending in ".3dsx", not starting with a dot:
 *  one file directly under sdmc:/3ds/. */
export function pocketRuntimeNativeNameValid(name: string): boolean {
  return name.length <= POCKET_RUNTIME_NATIVE_NAME_BYTES &&
    /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.3dsx$/i.test(name);
}

function nativeNameBytes(name: string): Uint8Array {
  if (!pocketRuntimeNativeNameValid(name)) {
    throw new Error(`"${name}" is not a .3dsx file name the Runtime accepts`);
  }
  return new TextEncoder().encode(name);
}

/** u32 length, u32 CRC-32, u8 flags, u8 name length, u16 zero, 64 name bytes. */
export function encodePocketRuntimeNativeBegin(
  length: number,
  crc32: number,
  name: string,
  flags = 0,
): Uint8Array {
  if (!Number.isSafeInteger(length) || length < POCKET_RUNTIME_NATIVE_MIN_BYTES ||
      length > POCKET_RUNTIME_NATIVE_MAX_BYTES) {
    throw new Error("Pocket Runtime .3dsx length is outside 32 bytes..32 MiB");
  }
  if ((flags & ~POCKET_RUNTIME_NATIVE_FLAG_LAUNCH) !== 0) {
    throw new Error("Pocket Runtime .3dsx flags are unknown");
  }
  const encoded = nativeNameBytes(name);
  const bytes = new Uint8Array(POCKET_RUNTIME_NATIVE_BEGIN_BYTES);
  const data = view(bytes);
  data.setUint32(0, length, true);
  data.setUint32(4, crc32 >>> 0, true);
  data.setUint8(8, flags);
  data.setUint8(9, encoded.length);
  bytes.set(encoded, 12);
  return bytes;
}

/** u8 name length, three zero bytes, 64 name bytes. */
export function encodePocketRuntimeLaunch(name: string): Uint8Array {
  const encoded = nativeNameBytes(name);
  const bytes = new Uint8Array(POCKET_RUNTIME_LAUNCH_BYTES);
  bytes[0] = encoded.length;
  bytes.set(encoded, 4);
  return bytes;
}

/** zlib's CRC-32, the check the Runtime applies to a .3dsx transfer. */
export function pocketRuntimeCrc32(bytes: Uint8Array): number {
  return crc32(bytes) >>> 0;
}

export function decodePocketRuntimeScreenshotBegin(
  payload: Uint8Array,
): PocketRuntimeScreenshotBegin {
  if (payload.length !== POCKET_RUNTIME_SCREENSHOT_BEGIN_BYTES) {
    throw new Error("Pocket Runtime screenshot begin payload has the wrong size");
  }
  const data = view(payload);
  const result = {
    frame: data.getUint32(0, true),
    topWidth: data.getUint16(4, true),
    topHeight: data.getUint16(6, true),
    auxiliaryWidth: data.getUint16(8, true),
    auxiliaryHeight: data.getUint16(10, true),
    format: data.getUint8(12),
    topBytes: data.getUint32(16, true),
    auxiliaryBytes: data.getUint32(20, true),
  };
  if (result.format !== POCKET_RUNTIME_SCREENSHOT_FORMAT_ROTATED_RGB8) {
    throw new Error(`Pocket Runtime screenshot format ${result.format} is unsupported`);
  }
  if (result.topBytes !== result.topWidth * result.topHeight * 3 ||
      result.auxiliaryBytes !== result.auxiliaryWidth * result.auxiliaryHeight * 3) {
    throw new Error("Pocket Runtime screenshot byte counts do not match its surfaces");
  }
  return result;
}

/** Incremental decoder for an ordered TCP byte stream. */
export class PocketRuntimeFrameDecoder {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): PocketRuntimeFrame[] {
    if (chunk.length > 0) {
      const joined = new Uint8Array(this.#buffer.length + chunk.length);
      joined.set(this.#buffer);
      joined.set(chunk, this.#buffer.length);
      this.#buffer = joined;
    }
    const frames: PocketRuntimeFrame[] = [];
    let offset = 0;
    while (this.#buffer.length - offset >= POCKET_RUNTIME_FRAME_HEADER_BYTES) {
      const header = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset + offset,
        POCKET_RUNTIME_FRAME_HEADER_BYTES,
      );
      if (header.getUint16(2, true) !== 0) {
        throw new Error("Pocket Runtime frame has non-zero reserved header bytes");
      }
      const length = header.getUint32(4, true);
      if (length > POCKET_RUNTIME_MAX_FRAME_BYTES) {
        throw new Error(`Pocket Runtime frame advertises ${length} bytes`);
      }
      const total = POCKET_RUNTIME_FRAME_HEADER_BYTES + length;
      if (this.#buffer.length - offset < total) break;
      frames.push({
        type: header.getUint8(0),
        flags: header.getUint8(1),
        payload: this.#buffer.slice(
          offset + POCKET_RUNTIME_FRAME_HEADER_BYTES,
          offset + total,
        ),
      });
      offset += total;
    }
    if (offset > 0) this.#buffer = this.#buffer.slice(offset);
    return frames;
  }

  get pendingBytes(): number {
    return this.#buffer.length;
  }
}

export function pocketPackageFooterHash(bytes: Uint8Array): bigint {
  if (bytes.length < 8) throw new Error("Pocket package is truncated");
  return view(bytes).getBigUint64(bytes.length - 8, true);
}
