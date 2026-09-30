// Audio module SDK — the thin guest-side algebra over the `audio` spec
// (contracts/spec/audio.ts). Framework-agnostic (no solid-js, no JSX): the
// same file serves ./audio, ./vue-vapor/audio and ./octane/audio.
//
// Layering (the tiles.ts shape, one level up):
//   WAV bytes in the app pak (audio:wav.<name>, raw-blob pak.json route)
//     -> decodeWav()               guest-side RIFF parse, cold path, once
//     -> createWavPlayer()         credit-driven pump over the audio ops
//     -> globalThis.audio          the mounted module namespace (or absent)
//
// The player follows law 1: it mirrors its free-frame budget and cursor
// guest-side, so a frame's hot path is poll-drain + at most one writePcm —
// never a query. Hosts without the module (goldens and targets without
// `audio.pcm`) leave `globalThis.audio` unset; every player call degrades to
// a silent no-op and the app's tick-driven UI is byte-identical either way.

import {
  AUDIO_MAX_CHANNELS,
  AUDIO_PAK_WAV_PREFIX,
  AUDIO_RATES,
  AUDIO_RING_FRAMES,
} from "../../contracts/spec/audio.ts";
import { get as pakGet, hasPack } from "./pak.ts";

export { AUDIO_RATES, AUDIO_RING_FRAMES } from "../../contracts/spec/audio.ts";

/** The mounted audio namespace — one method per spec op (AUDIO_OP codes). */
export interface AudioOps {
  createStream(sampleRate: number, channels: number): number;
  destroyStream(handle: number): void;
  /** Interleaved s16 LE at the stream rate; BORROWED for the call. */
  writePcm(handle: number, pcm: ArrayBuffer): number;
  play(handle: number): void;
  pause(handle: number): void;
  stop(handle: number): void;
  setVolume(handle: number, volume: number): void;
  endStream(handle: number): void;
  poll(): string | undefined;
}

/** The audio module namespace, or null where the host doesn't mount one.
 *  A live lookup (not cached): hosts install `globalThis.audio` before eval
 *  and reset it per app load, exactly like `globalThis.ui`. */
export function audioHost(): AudioOps | null {
  const ns = (globalThis as { audio?: unknown }).audio;
  if (!ns || typeof ns !== "object") return null;
  return typeof (ns as AudioOps).createStream === "function" ? (ns as AudioOps) : null;
}

// ---------------------------------------------------------------------------
// WAV decode (the reference decoder for the audio:wav.* data contract)
// ---------------------------------------------------------------------------

export interface WavPcm {
  readonly sampleRate: number;
  readonly channels: number;
  /** Sample frames (samples per channel). */
  readonly frames: number;
  /** Interleaved s16, a view over the source bytes' data chunk. */
  readonly data: Int16Array;
}

/** QuickJS-safe u32 LE read (no TextDecoder, DataView handles alignment). */
function fourcc(v: DataView, off: number): number {
  return v.getUint32(off, true);
}

const RIFF = 0x46464952; // "RIFF"
const WAVE = 0x45564157; // "WAVE"
const FMT_ = 0x20746d66; // "fmt "
const DATA = 0x61746164; // "data"

/**
 * Parse a RIFF/WAVE file into PCM. Accepts exactly the spec shape — PCM
 * (format 1), 16-bit, 1..2 channels, rate in AUDIO_RATES — and throws on
 * anything else: an unplayable asset is a build mistake, not a runtime
 * condition to limp through.
 */
export function decodeWav(bytes: Uint8Array): WavPcm {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 44 || fourcc(v, 0) !== RIFF || fourcc(v, 8) !== WAVE) {
    throw new Error("audio: not a RIFF/WAVE file");
  }
  let sampleRate = 0;
  let channels = 0;
  let dataOff = -1;
  let dataLen = 0;
  // Chunk walk: WAVs in the wild carry LIST/fact/cue chunks between fmt and
  // data; skip anything unknown (chunks are word-aligned).
  for (let off = 12; off + 8 <= bytes.byteLength; ) {
    const id = fourcc(v, off);
    const size = v.getUint32(off + 4, true);
    if (id === FMT_) {
      const format = v.getUint16(off + 8, true);
      channels = v.getUint16(off + 10, true);
      sampleRate = v.getUint32(off + 12, true);
      const bits = v.getUint16(off + 22, true);
      if (format !== 1 || bits !== 16) {
        throw new Error(`audio: WAV must be 16-bit PCM (format ${format}, ${bits} bits)`);
      }
    } else if (id === DATA) {
      dataOff = off + 8;
      dataLen = Math.min(size, bytes.byteLength - dataOff);
    }
    off += 8 + size + (size & 1);
  }
  if (dataOff < 0) throw new Error("audio: WAV has no data chunk");
  if (channels < 1 || channels > AUDIO_MAX_CHANNELS) {
    throw new Error(`audio: WAV must be mono or stereo (${channels} channels)`);
  }
  if (!(AUDIO_RATES as readonly number[]).includes(sampleRate)) {
    throw new Error(`audio: WAV rate ${sampleRate} not in [${AUDIO_RATES.join(", ")}]`);
  }
  const bytesPerFrame = 2 * channels;
  const frames = Math.floor(dataLen / bytesPerFrame);
  // s16 needs 2-byte alignment; pak blobs are 16-aligned but the data chunk
  // offset inside the WAV may not be — copy in that (rare) case.
  const abs = bytes.byteOffset + dataOff;
  const data =
    abs % 2 === 0
      ? new Int16Array(bytes.buffer, abs, frames * channels)
      : new Int16Array(bytes.slice(dataOff, dataOff + frames * bytesPerFrame).buffer);
  return { sampleRate, channels, frames, data };
}

// ---------------------------------------------------------------------------
// WavPlayer — credit-driven pump, one track at a time
// ---------------------------------------------------------------------------

/** Cap on frames converted+written per pump: bounds the per-tick copy cost
 *  (4096 stereo frames = 16 KB) while refilling a draining ring in well under
 *  its ~740 ms capacity. */
const WRITE_CHUNK_FRAMES = 4096;

export interface WavPlayerStats {
  readonly underruns: number;
}

export interface WavPlayer {
  /** Load `audio:wav.<name>` from the pak (or pass decoded PCM directly).
   *  Destroys the previous track's stream. False if the module is absent,
   *  the pak entry is missing, or the stream was refused. */
  load(name: string): boolean;
  loadPcm(pcm: WavPcm): boolean;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Pause, flush the ring and rewind to frame 0. */
  stop(): void;
  setVolume(volume: number): void;
  /** Call once per frame (from the app's onFrame): drains this tick's event
   *  batch and feeds the ring within the credit budget. */
  pump(): void;
  playing(): boolean;
  /** Best-effort played frames: written minus still-queued (mirror math). */
  positionFrames(): number;
  durationFrames(): number;
  stats(): WavPlayerStats;
  /** Destroy the stream and drop the track. */
  dispose(): void;
}

export function createWavPlayer(): WavPlayer {
  let pcm: WavPcm | null = null;
  let handle = -1;
  let cursor = 0; // frames written so far
  let free = AUDIO_RING_FRAMES; // guest mirror of ring space (credit resets it)
  let isPlaying = false;
  // Credit discipline works both ways: the host's clock starts consuming the
  // moment the stream plays, so the player never opens the tap on an empty
  // ring — play() on an unfed track is deferred until pump()'s first write
  // (one tick later at most), which is what keeps a track switch from
  // opening with a spurious underrun.
  let pendingPlay = false;
  let ended = false; // endStream sent for this track
  let volume = 1;
  let underruns = 0;

  function dropStream(): void {
    const ns = audioHost();
    if (ns && handle >= 0) ns.destroyStream(handle);
    handle = -1;
  }

  function loadPcm(next: WavPcm): boolean {
    dropStream();
    pcm = next;
    cursor = 0;
    free = AUDIO_RING_FRAMES;
    ended = false;
    pendingPlay = isPlaying; // fresh ring is empty: play after the first feed
    const ns = audioHost();
    if (!ns) return false;
    handle = ns.createStream(next.sampleRate, next.channels);
    if (handle < 0) return false;
    ns.setVolume(handle, volume);
    return true;
  }

  function drainEvents(ns: AudioOps): void {
    for (let line = ns.poll(); line !== undefined; line = ns.poll()) {
      let ev: { t?: string; h?: number; free?: number };
      try {
        ev = JSON.parse(line) as typeof ev;
      } catch {
        continue; // a malformed event is a host bug; skip, don't wedge the pump
      }
      if (ev.h !== handle) continue; // another player's stream
      if (ev.t === "credit" && typeof ev.free === "number") free = ev.free;
      else if (ev.t === "underrun") underruns++;
      else if (ev.t === "ended") isPlaying = false;
    }
  }

  function play(): void {
    isPlaying = true;
    const ns = audioHost();
    if (!ns || handle < 0) return;
    if (cursor > 0) ns.play(handle);
    else pendingPlay = true; // pump() opens the tap after it pours
  }

  function pause(): void {
    isPlaying = false;
    pendingPlay = false;
    const ns = audioHost();
    if (ns && handle >= 0) ns.pause(handle);
  }

  return {
    load(name: string): boolean {
      if (!hasPack()) return false;
      let bytes: Uint8Array;
      try {
        bytes = pakGet(AUDIO_PAK_WAV_PREFIX + name);
      } catch {
        return false; // asset not shipped (e.g. a pakless legacy build)
      }
      return loadPcm(decodeWav(bytes));
    },
    loadPcm,
    play,
    pause,
    toggle(): void {
      if (isPlaying) pause();
      else play();
    },
    stop(): void {
      isPlaying = false;
      pendingPlay = false;
      cursor = 0;
      free = AUDIO_RING_FRAMES; // stop flushes the ring; credit will confirm
      ended = false;
      const ns = audioHost();
      if (ns && handle >= 0) ns.stop(handle);
    },
    setVolume(v: number): void {
      volume = v < 0 ? 0 : v > 1 ? 1 : v;
      const ns = audioHost();
      if (ns && handle >= 0) ns.setVolume(handle, volume);
    },
    pump(): void {
      const ns = audioHost();
      if (!ns || handle < 0 || !pcm) return;
      drainEvents(ns);
      if (!isPlaying || cursor >= pcm.frames) return;
      const want = Math.min(free, pcm.frames - cursor, WRITE_CHUNK_FRAMES);
      if (want > 0) {
        const ch = pcm.channels;
        const slice = pcm.data.slice(cursor * ch, (cursor + want) * ch);
        const accepted = ns.writePcm(handle, slice.buffer as ArrayBuffer);
        cursor += accepted;
        free -= accepted;
      }
      if (pendingPlay && cursor > 0) {
        pendingPlay = false;
        ns.play(handle);
      }
      if (cursor >= pcm.frames && !ended) {
        ended = true;
        ns.endStream(handle);
      }
    },
    playing: () => isPlaying,
    positionFrames(): number {
      const queued = AUDIO_RING_FRAMES - free;
      const played = cursor - queued;
      return played < 0 ? 0 : played;
    },
    durationFrames: () => (pcm ? pcm.frames : 0),
    stats: () => ({ underruns }),
    dispose(): void {
      dropStream();
      pcm = null;
      isPlaying = false;
    },
  };
}
