/** Offload v1. JSON records are length-prefixed UTF-8 on the wire.
 * The UI copies bounded records; only the provider executes capabilities. */
export const OFFLOAD = Object.freeze({
  version: 1, recordBytes: 4096, payloadChars: 2500, pending: 8,
  deliveriesPerFrame: 1, submissionsPerFrame: 2, timeoutFrames: 600,
  port: 8741,
});

export interface OffloadOps {
  /** Device-local provider. Separate providers have independent credits and
   * generations; a host with one local provider may alias this to the root.
   * No pairing is needed; host capability/path policy controls access. */
  local?: OffloadOps;
  /** Positive authenticated connection generation; zero/negative = offline. */
  session(): number;
  /** Nonwaiting bounded copy. False means no credit; caller retains work. */
  submit(record: string): boolean;
  /** At most one complete record per host frame. Never performs IO. */
  take(): string | undefined;
  /** 2-bit coverage; width 4..512 in multiples of 4, height 1..128.
   * Power-of-two envelope: min width 8, min height 16, at most 8192 pixels
   * on POSIX hosts; the 3DS permits 16384 envelope pixels for multiline text.
   * Source coverage stays within 8192 pixels and one upload per frame.
   * Foreground is ABGR. Optional columns carry one lowercase hex palette index
   * per column; palette contains 1..16 concatenated RGB hex colors. */
  uploadCoverage?(base64: string, width: number, height: number, foreground: number, columns?: string, palette?: string): number;
}
export interface OffloadRequest { v: 1; id: number; method: string; payload: string }
export interface OffloadReply { id: number; payload?: string; error?: string }
