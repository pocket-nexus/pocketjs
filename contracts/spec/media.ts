/** Encoded media playback. Control stays on the guest; transport, decode and
 * audio scheduling belong to the native worker. Binary data never enters JS. */
export const MEDIA = Object.freeze({
  version: 1, magic: 0x564d4b50, headerBytes: 32, packetHeaderBytes: 16,
  packetBytes: 128 * 1024, width: 512, height: 256,
  sampleRate: 22050, channels: 2, audioFrames: 1024,
  tokenChars: 64,
  packetCredits: 8,
});
export const MEDIA_PACKET = Object.freeze({ video: 1, audio: 2, end: 3, error: 4 });
export interface MediaSource {
  /** Numeric IPv4 address of the paired companion's media endpoint. */
  host: string;
  port: number;
  /** Ephemeral stream ticket issued by that companion. */
  token: string;
}
export type MediaPhase = "idle" | "opening" | "buffering" | "playing" | "paused" | "ended" | "error";
export interface MediaStatus {
  phase: MediaPhase;
  positionMs: number;
  bufferedMs: number;
  decodedFrames: number;
  presentedFrames: number;
  droppedFrames: number;
  receivedBytes: number;
  decodeMaxUs: number;
  audioUnderruns: number;
  hardware: boolean;
  error: string;
}
export interface MediaOps {
  /** Nonwaiting latest-command handoff; a new open invalidates older work. */
  open(host: string, port: number, token: string): boolean;
  close(): void;
  paused(value: boolean): void;
  volume(value: number): void;
  /** Ordinary host texture handle; the native renderer owns its pixel updates. */
  texture(): number;
  /** Bounded snapshot. No socket, filesystem or decoder calls on the UI. */
  status(): string;
}
export function validMediaSource(source: MediaSource): boolean {
  return typeof source?.host === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(source.host)
    && source.host.split(".").every(p => Number(p) <= 255)
    && Number.isInteger(source.port) && source.port > 0 && source.port <= 65535
    && typeof source.token === "string" && /^[0-9a-f]{64}$/.test(source.token);
}
