// Streamed music and short sound effects for the 2D game layer.
//
// Music is raw s16le mono PCM in a pack file (contracts/spec/pack.ts) read one
// block at a time into one reused buffer, so a track costs its ring slot and
// that block, never its length in the JS heap. Sound effects are WAV entries,
// decoded once into their own buffers; a later play passes the cached buffer
// to writePcm, which the host copies into its ring (contracts/spec/audio.ts).
//
// Both drive the audio module from one router: audio.poll() is one queue for
// every stream, so whoever drains it first hands each event to the owner of
// its handle. A createWavPlayer in the same app drains the same queue and
// discards other streams' events; use one or the other.
//
// The module's four streams are shared: one for music, one more while a
// crossfade runs, and one per sounding effect. A crossfade that finds no free
// stream fades the old track out first and starts the new one when a stream
// frees up. A host without `audio` or `pack` plays silence and every call is a
// safe no-op.

import { audioHost, type AudioOps, AUDIO_RATES, AUDIO_RING_FRAMES, decodeWav } from "../audio-api.ts";
import { simulationHz } from "../clock.ts";
import { get as pakGet, hasPack } from "../pak.ts";
import {
  AUDIO_PAK_WAV_PREFIX,
} from "../../../contracts/spec/audio.ts";
import { PACK_OPEN_PENDING, type PackOps } from "../../../contracts/spec/pack.ts";

/**
 * Bytes per read, the same at every rate. 8 KiB is 4096 mono frames: 186 ms at
 * 22 050 Hz, one read every 11 frames at 60 Hz. The player refills when a whole
 * block fits in the ring, so at least three blocks stay queued and a slow read
 * has about 550 ms (22 050 Hz) or 280 ms (44 100 Hz) to finish.
 */
const BLOCK_BYTES = 8192;
const BLOCK_FRAMES = BLOCK_BYTES / 2;

const DEFAULT_RATE = 22050;

/** Sound effects up to the ring size take one write; longer ones are cut into
 *  chunks of this many frames and fed by credit. */
const SFX_CHUNK_FRAMES = 8192;
const SFX_DEFAULT_VOICES = 3;

function packHost(): PackOps | null {
  const ns = (globalThis as { pack?: unknown }).pack;
  if (!ns || typeof ns !== "object") return null;
  return typeof (ns as PackOps).open === "function" ? (ns as PackOps) : null;
}

function nowMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return perf?.now ? perf.now() : Date.now();
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// Audio event router
// ---------------------------------------------------------------------------

interface AudioEvent {
  t?: string;
  h?: number;
  free?: number;
}

const routes = new Map<number, (event: AudioEvent) => void>();

function drainAudio(ns: AudioOps): void {
  for (let line = ns.poll(); line !== undefined; line = ns.poll()) {
    let event: AudioEvent;
    try {
      event = JSON.parse(line) as AudioEvent;
    } catch {
      continue;
    }
    if (event.h !== undefined) routes.get(event.h)?.(event);
  }
}

// ---------------------------------------------------------------------------
// MusicPlayer
// ---------------------------------------------------------------------------

export interface MusicPlayOptions {
  rate?: 44100 | 22050 | 11025;
  /** Default false: the track ends once and current() returns null. */
  loop?: boolean;
  /** Frame the loop returns to. Default 0. */
  loopStartFrames?: number;
  /** Sets the master volume, as setVolume does. Default: leave it as it is. */
  volume?: number;
  /** Fade this track in, and fade the track it replaces out over the same
   *  time. 0 or absent replaces at once. */
  fadeInMs?: number;
}

export interface MusicPlayerStats {
  /** Starved episodes across every track (edge-triggered by the host). */
  underruns: number;
  bytesRead: number;
  /** Slowest single pack.read seen, in milliseconds. */
  readMsMax?: number;
  /** Tracks whose file did not open. */
  missing: number;
}

export interface MusicPlayer {
  /** Start `path` (a pack path). No-op when `path` is already the current
   *  track; call stop() first to restart it. */
  play(path: string, opts?: MusicPlayOptions): void;
  stop(fadeOutMs?: number): void;
  setVolume(v: number): void;
  /** Call once per frame. At most one read happens per call, plus one more on
   *  the frame a loop wraps. */
  pump(): void;
  /** The track asked for, until it ends, stops, or fails to open. */
  current(): string | null;
  stats(): MusicPlayerStats;
}

/** One track in flight: its file, its stream, its fade. */
interface Voice {
  path: string;
  rate: number;
  loop: boolean;
  loopStartBytes: number;
  fh: number; // -1 until open() answers
  size: number; // bytes, whole frames only
  pos: number; // next byte to read
  handle: number; // stream, -1 until created
  free: number; // mirror of ring space
  started: boolean; // play() sent
  ended: boolean; // endStream sent
  tail: ArrayBuffer | null; // bytes a partial accept left over
  gain: number;
  gainTo: number;
  gainPerMs: number;
  sentVolume: number;
  fadeInMs: number;
  /** Destroy at the end of the fade. */
  retiring: boolean;
}

export function createMusicPlayer(): MusicPlayer {
  const block = new Uint8Array(BLOCK_BYTES);
  /** Newest last. Only the last can be the current track. */
  const voices: Voice[] = [];
  let master = 1;
  let wanted: string | null = null;
  let underruns = 0;
  let bytesRead = 0;
  let readMsMax = 0;
  let missing = 0;

  function currentVoice(): Voice | null {
    const v = voices[voices.length - 1];
    return v && !v.retiring ? v : null;
  }

  function fadeTo(v: Voice, gainTo: number, ms: number): void {
    v.gainTo = gainTo;
    v.gainPerMs = ms > 0 ? Math.abs(gainTo - v.gain) / ms : Infinity;
  }

  function applyVolume(ns: AudioOps, v: Voice): void {
    if (v.handle < 0) return;
    const volume = master * v.gain;
    if (volume !== v.sentVolume) {
      v.sentVolume = volume;
      ns.setVolume(v.handle, volume);
    }
  }

  function release(ns: AudioOps | null, v: Voice): void {
    if (v.handle >= 0) {
      routes.delete(v.handle);
      if (ns) ns.destroyStream(v.handle);
      v.handle = -1;
    }
    if (v.fh >= 0) {
      packHost()?.close(v.fh);
      v.fh = -1;
    }
  }

  function remove(ns: AudioOps | null, v: Voice): void {
    release(ns, v);
    const i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
  }

  /** Retire `v`: fade out when it is sounding and asked to, drop otherwise. */
  function retire(ns: AudioOps | null, v: Voice, fadeMs: number): void {
    if (fadeMs > 0 && v.started) {
      v.retiring = true;
      fadeTo(v, 0, fadeMs);
    } else {
      remove(ns, v);
    }
  }

  /** Bring a new voice's file and stream up. True once it can be fed. */
  function ready(ns: AudioOps, pack: PackOps, v: Voice): boolean {
    if (v.fh < 0) {
      const fh = pack.open(v.path);
      if (fh === PACK_OPEN_PENDING) return false;
      if (fh < 0) {
        missing++;
        wanted = null;
        fadeOthers(ns, v);
        remove(ns, v);
        return false;
      }
      v.fh = fh;
      const size = pack.size(fh);
      v.size = size > 0 ? size - size % 2 : 0;
      if (v.loopStartBytes >= v.size) v.loopStartBytes = 0;
      if (v.size === 0) {
        wanted = null;
        fadeOthers(ns, v);
        remove(ns, v);
        return false;
      }
    }
    if (v.handle < 0) {
      const handle = ns.createStream(v.rate, 1);
      if (handle < 0) {
        // Every stream is in use. Make room: older tracks start leaving now,
        // and this voice asks again on the next pump.
        fadeOthers(ns, v);
        return false;
      }
      v.handle = handle;
      routes.set(handle, (event) => onEvent(ns, v, event));
      v.sentVolume = -1;
      applyVolume(ns, v);
    }
    return true;
  }

  function onEvent(ns: AudioOps, v: Voice, event: AudioEvent): void {
    if (event.t === "credit" && typeof event.free === "number") v.free = event.free;
    else if (event.t === "underrun") {
      if (!v.ended) underruns++;
    } else if (event.t === "ended") {
      if (voices[voices.length - 1] === v) wanted = null;
      remove(ns, v);
    }
  }

  /** Fade out every voice older than `keep`, over its fade time. */
  function fadeOthers(ns: AudioOps, keep: Voice): void {
    for (const other of voices.slice()) {
      if (other !== keep && !other.retiring) retire(ns, other, keep.fadeInMs);
    }
  }

  function readInto(pack: PackOps, v: Voice, dst: Uint8Array): number {
    const started = nowMs();
    const n = pack.read(v.fh, v.pos, dst);
    const ms = nowMs() - started;
    if (ms > readMsMax) readMsMax = ms;
    if (n > 0) {
      bytesRead += n;
      v.pos += n;
    }
    return n;
  }

  /** Fill `block`, wrapping at the file's end when looping. Bytes filled. */
  function fillBlock(pack: PackOps, v: Voice): number {
    const firstEnd = v.pos + BLOCK_BYTES;
    if (firstEnd <= v.size) {
      const n = readInto(pack, v, block);
      return n < 0 ? 0 : n;
    }
    // The wrap (or the last block): the only path that pays for subarrays.
    let filled = 0;
    while (filled < BLOCK_BYTES) {
      const remaining = v.size - v.pos;
      if (remaining <= 0) {
        if (!v.loop) break;
        v.pos = v.loopStartBytes;
        continue;
      }
      const piece = block.subarray(filled, filled + Math.min(remaining, BLOCK_BYTES - filled));
      const n = readInto(pack, v, piece);
      if (n <= 0) break; // the file shrank or the read failed: stop short
      filled += n;
    }
    return filled;
  }

  /** Put one block in `v`'s ring. */
  function feed(ns: AudioOps, pack: PackOps, v: Voice): void {
    if (v.tail) {
      const frames = v.tail.byteLength / 2;
      const accepted = ns.writePcm(v.handle, v.tail);
      v.free -= accepted;
      v.tail = accepted < frames ? v.tail.slice(accepted * 2) : null;
      return;
    }
    const filled = fillBlock(pack, v);
    if (filled > 0) {
      const frames = filled / 2;
      const buffer = filled === BLOCK_BYTES ? block.buffer : block.slice(0, filled).buffer;
      const accepted = ns.writePcm(v.handle, buffer as ArrayBuffer);
      v.free -= accepted;
      if (accepted < frames) v.tail = block.slice(accepted * 2, filled).buffer as ArrayBuffer;
    }
    if (!v.started && filled > 0) {
      v.started = true;
      ns.play(v.handle);
      // A replacement fades in once it sounds; the old track leaves on the same clock.
      fadeOthers(ns, v);
      if (v.fadeInMs > 0) fadeTo(v, 1, v.fadeInMs);
    }
    if (filled < BLOCK_BYTES && !v.tail) {
      if (v.started) {
        v.ended = true;
        ns.endStream(v.handle);
      } else {
        if (voices[voices.length - 1] === v) wanted = null;
        remove(ns, v);
      }
    }
  }

  function advanceFades(ns: AudioOps): void {
    const ms = 1000 / simulationHz();
    for (const v of voices.slice()) {
      if (v.started && v.gain !== v.gainTo) {
        const step = v.gainPerMs * ms;
        v.gain = v.gain < v.gainTo ? Math.min(v.gain + step, v.gainTo) : Math.max(v.gain - step, v.gainTo);
        applyVolume(ns, v);
      }
      if (v.retiring && v.gain === 0) remove(ns, v);
    }
  }

  return {
    play(path: string, opts?: MusicPlayOptions): void {
      if (opts?.volume !== undefined) master = clamp01(opts.volume);
      const ns = audioHost();
      if (wanted === path) {
        const active = currentVoice();
        if (ns && active) applyVolume(ns, active);
        return;
      }
      wanted = path;
      const pack = packHost();
      if (!ns || !pack) return; // silent host: current() still tracks the request
      const rate = opts?.rate ?? DEFAULT_RATE;
      if (!(AUDIO_RATES as readonly number[]).includes(rate)) {
        wanted = null;
        return;
      }
      // A voice that never sounded has nothing to fade: drop it. A second
      // crossfade while one runs keeps only the track sounding loudest.
      for (const v of voices.slice()) {
        if (!v.started) remove(ns, v);
      }
      while (voices.filter((v) => v.retiring).length > 1) remove(ns, voices[0]!);
      const fadeInMs = opts?.fadeInMs ?? 0;
      voices.push({
        path,
        rate,
        loop: opts?.loop ?? false,
        loopStartBytes: Math.max(0, Math.floor(opts?.loopStartFrames ?? 0)) * 2,
        fh: -1,
        size: 0,
        pos: 0,
        handle: -1,
        free: AUDIO_RING_FRAMES,
        started: false,
        ended: false,
        tail: null,
        gain: fadeInMs > 0 ? 0 : 1,
        gainTo: fadeInMs > 0 ? 0 : 1,
        gainPerMs: 0,
        sentVolume: -1,
        fadeInMs,
        retiring: false,
      });
    },
    stop(fadeOutMs?: number): void {
      wanted = null;
      const ns = audioHost();
      for (const v of voices.slice()) {
        if (!v.retiring) retire(ns, v, fadeOutMs ?? 0);
      }
    },
    setVolume(v: number): void {
      master = clamp01(v);
      const ns = audioHost();
      if (!ns) return;
      for (const voice of voices) applyVolume(ns, voice);
    },
    pump(): void {
      const ns = audioHost();
      const pack = packHost();
      if (!ns || !pack || voices.length === 0) {
        if (ns) drainAudio(ns);
        return;
      }
      drainAudio(ns);
      advanceFades(ns);
      // One read per pump: serve the voice with the least time queued.
      let hungriest: Voice | null = null;
      let leastQueued = Infinity;
      for (const v of voices.slice()) {
        if (!v.retiring && !ready(ns, pack, v)) continue;
        if (v.ended || v.handle < 0 || v.free < BLOCK_FRAMES) continue;
        const queued = (AUDIO_RING_FRAMES - v.free) / v.rate;
        if (queued < leastQueued) {
          leastQueued = queued;
          hungriest = v;
        }
      }
      if (hungriest) feed(ns, pack, hungriest);
    },
    current: () => wanted,
    stats: () => ({ underruns, bytesRead, readMsMax, missing }),
  };
}

// ---------------------------------------------------------------------------
// Sound effects
// ---------------------------------------------------------------------------

export interface SfxEntry {
  /** The name play() takes. */
  name: string;
  /** Pak key. Default `audio:wav.<name>`. */
  key?: string;
  /** A WAV file in a pack instead of the pak; loaded once on a later pump. */
  path?: string;
  /** Per-sound volume, 0..1. Default 1. */
  volume?: number;
}

export interface SfxPlayOptions {
  /** Multiplies the bank and sound volumes, 0..1. */
  volume?: number;
}

export interface SfxBankStats {
  plays: number;
  /** Plays that cut the oldest sounding voice. */
  steals: number;
  /** Plays dropped: unknown or unloaded sound, or no stream to be had. */
  dropped: number;
  /** Sounds decoded so far (each happens once). */
  decoded: number;
}

export interface SfxBank {
  /** Start a sound. False when it could not start. */
  play(name: string, opts?: SfxPlayOptions): boolean;
  setVolume(v: number): void;
  stopAll(): void;
  /** Call once per frame. */
  pump(): void;
  stats(): SfxBankStats;
  /** Stop everything and drop the decoded sounds. */
  dispose(): void;
}

interface Sound {
  entry: SfxEntry;
  volume: number;
  rate: number;
  channels: number;
  /** Whole interleaved PCM chunks, each its own ArrayBuffer so a play writes
   *  without a slice. */
  chunks: ArrayBuffer[] | null;
  frames: number;
  /** Decode failed or the file is missing; do not retry. */
  failed: boolean;
}

interface SfxVoice {
  handle: number;
  sound: Sound;
  chunk: number; // next chunk to write
  free: number;
  ended: boolean;
  order: number; // play sequence, for stealing the oldest
}

function decodeSound(sound: Sound, bytes: Uint8Array): void {
  try {
    const pcm = decodeWav(bytes);
    sound.rate = pcm.sampleRate;
    sound.channels = pcm.channels;
    sound.frames = pcm.frames;
    const samples = pcm.channels * (pcm.frames <= AUDIO_RING_FRAMES ? pcm.frames : SFX_CHUNK_FRAMES);
    const chunks: ArrayBuffer[] = [];
    for (let at = 0; at < pcm.data.length; at += samples) {
      chunks.push(pcm.data.slice(at, at + samples).buffer as ArrayBuffer);
    }
    sound.chunks = chunks;
  } catch {
    sound.failed = true;
  }
}

export function createSfxBank(
  entries: ReadonlyArray<string | SfxEntry>,
  options?: { voices?: number },
): SfxBank {
  const sounds = new Map<string, Sound>();
  for (const raw of entries) {
    const entry: SfxEntry = typeof raw === "string" ? { name: raw } : raw;
    sounds.set(entry.name, {
      entry,
      volume: entry.volume ?? 1,
      rate: 0,
      channels: 0,
      chunks: null,
      frames: 0,
      failed: false,
    });
  }
  let packLeft = 0;
  for (const sound of sounds.values()) if (sound.entry.path) packLeft++;
  const maxVoices = Math.max(1, options?.voices ?? SFX_DEFAULT_VOICES);
  const voices: SfxVoice[] = [];
  let bankVolume = 1;
  let order = 0;
  let plays = 0;
  let steals = 0;
  let dropped = 0;
  let decoded = 0;

  function loadFromPak(sound: Sound): void {
    if (!hasPack()) {
      sound.failed = true;
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = pakGet(sound.entry.key ?? AUDIO_PAK_WAV_PREFIX + sound.entry.name);
    } catch {
      sound.failed = true;
      return;
    }
    decodeSound(sound, bytes);
    if (!sound.failed) decoded++;
  }

  /** One pack-file sound per pump, so a bank of them does not stall a frame. */
  function loadOneFromPack(pack: PackOps): void {
    if (packLeft === 0) return;
    for (const sound of sounds.values()) {
      const path = sound.entry.path;
      if (!path || sound.chunks || sound.failed) continue;
      const fh = pack.open(path);
      if (fh === PACK_OPEN_PENDING) return;
      packLeft--;
      if (fh < 0) {
        sound.failed = true;
        continue;
      }
      const bytes = new Uint8Array(Math.max(0, pack.size(fh)));
      const n = pack.read(fh, 0, bytes);
      pack.close(fh);
      if (n !== bytes.length) sound.failed = true;
      else decodeSound(sound, bytes);
      if (!sound.failed) decoded++;
      return;
    }
  }

  function freeVoice(ns: AudioOps | null, voice: SfxVoice): void {
    routes.delete(voice.handle);
    if (ns) ns.destroyStream(voice.handle);
    const i = voices.indexOf(voice);
    if (i >= 0) voices.splice(i, 1);
  }

  function oldest(): SfxVoice | null {
    let found: SfxVoice | null = null;
    for (const voice of voices) if (!found || voice.order < found.order) found = voice;
    return found;
  }

  function writeNext(ns: AudioOps, voice: SfxVoice): void {
    const chunks = voice.sound.chunks!;
    const frames = chunks[voice.chunk]!.byteLength / (2 * voice.sound.channels);
    if (voice.free < frames) return;
    const accepted = ns.writePcm(voice.handle, chunks[voice.chunk]!);
    voice.free -= accepted;
    voice.chunk++; // a partial accept means a racing flush (spec); the rest is dropped
    if (voice.chunk >= chunks.length && !voice.ended) {
      voice.ended = true;
      ns.endStream(voice.handle);
    }
  }

  function start(ns: AudioOps, sound: Sound, volume: number): boolean {
    if (voices.length >= maxVoices) {
      steals++;
      freeVoice(ns, oldest()!);
    }
    let handle = ns.createStream(sound.rate, sound.channels);
    if (handle < 0 && voices.length > 0) {
      steals++;
      freeVoice(ns, oldest()!);
      handle = ns.createStream(sound.rate, sound.channels);
    }
    if (handle < 0) return false;
    const voice: SfxVoice = { handle, sound, chunk: 0, free: AUDIO_RING_FRAMES, ended: false, order: order++ };
    routes.set(handle, (event) => {
      if (event.t === "credit" && typeof event.free === "number") voice.free = event.free;
      else if (event.t === "ended") freeVoice(ns, voice);
    });
    voices.push(voice);
    ns.setVolume(handle, volume);
    writeNext(ns, voice);
    ns.play(handle);
    return true;
  }

  return {
    play(name: string, opts?: SfxPlayOptions): boolean {
      const ns = audioHost();
      if (!ns) return false;
      const sound = sounds.get(name);
      if (!sound) {
        dropped++;
        return false;
      }
      if (!sound.chunks && !sound.failed && !sound.entry.path) loadFromPak(sound);
      if (!sound.chunks || sound.chunks.length === 0) {
        dropped++;
        return false;
      }
      plays++;
      const ok = start(ns, sound, clamp01(bankVolume * sound.volume * (opts?.volume ?? 1)));
      if (!ok) dropped++;
      return ok;
    },
    setVolume(v: number): void {
      bankVolume = clamp01(v);
    },
    stopAll(): void {
      const ns = audioHost();
      for (const voice of voices.slice()) freeVoice(ns, voice);
    },
    pump(): void {
      const ns = audioHost();
      if (!ns) return;
      drainAudio(ns);
      const pack = packHost();
      if (pack) loadOneFromPack(pack);
      for (const voice of voices) {
        if (voice.chunk < voice.sound.chunks!.length) writeNext(ns, voice);
      }
    },
    stats: () => ({ plays, steals, dropped, decoded }),
    dispose(): void {
      const ns = audioHost();
      for (const voice of voices.slice()) freeVoice(ns, voice);
      sounds.clear();
    },
  };
}
