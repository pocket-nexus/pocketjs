/** Offload v1. JSON records are length-prefixed UTF-8 on the wire.
 * The UI copies bounded records; only the provider executes capabilities. */
export const OFFLOAD = Object.freeze({
  version: 1, recordBytes: 4096, payloadChars: 2500, pending: 8,
  deliveriesPerFrame: 1, submissionsPerFrame: 2, timeoutFrames: 600,
  port: 8741,
});

export interface OffloadOps {
  /** Device-local provider with independent credits and generation. No pairing
   * is needed; the host's local capability/path policy controls access. */
  local?: OffloadOps;
  /** Positive authenticated connection generation; zero/negative = offline. */
  session(): number;
  /** Nonwaiting bounded copy. False means no credit; caller retains work. */
  submit(record: string): boolean;
  /** At most one complete record per host frame. Never performs IO. */
  take(): string | undefined;
  /** Borrow one native image ticket. At most one <=256x256 upload per frame.
   * Pixels stay outside the JS heap. releaseImage returns staging credit. */
  uploadImage?(token: number): number;
  releaseImage?(token: number): void;
  /** 2-bit coverage; width 4..512 in multiples of 4, height 1..128.
   * Power-of-two envelope: min width 8, min height 16, at most 8192 pixels
   * on POSIX hosts; the 3DS permits 16384 envelope pixels for multiline text.
   * Source coverage stays within 8192 pixels and one upload per frame.
   * Foreground is ABGR. Optional columns carry one lowercase hex palette index
   * per column; palette contains 1..16 concatenated RGB hex colors. */
  uploadCoverage?(base64: string, width: number, height: number, foreground: number, columns?: string, palette?: string): number;
}
export interface OffloadRequest { v: 1; id: number; method: string; payload: string; response?: "image" }
export interface OffloadImageTicket { token: number; width: number; height: number }
export interface OffloadReply { id: number; payload?: string; error?: string; image?: OffloadImageTicket }

/** Optional image response extension. The record length's high bit selects a
 * binary image; JSON retains its 4096-byte limit. Header is 16 bytes: PIMG,
 * u32 request ID, u16 width, u16 height, u32 format (all little endian).
 * Format 0 = row-major R5G6B5 little endian (PSM_5650), 16..256 power-of-two
 * dimensions. No codec, base64, palette expansion or pixels in guest JS. */
export const OFFLOAD_IMAGE = Object.freeze({ headerBytes: 16, maxSide: 256, maxBytes: 256 * 256 * 2, slots: 8, flag: 0x80000000 });
export interface OffloadImage { width: number; height: number; pixels: Uint8Array; format: "r5g6b5" }
export interface OffloadProviderReply { id: number; payload?: string; error?: string; image?: OffloadImage }
