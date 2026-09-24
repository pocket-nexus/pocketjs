// hosts/sim/audio.ts — the deterministic (virtual-clock) implementation of
// the audio module (contracts/spec/audio.ts) for the headless sim host.
//
// Where the browser host's worklet consumes on the device clock, this sink
// consumes EXACTLY audioFramesForTick(rate, n, ticksPerSecond) source frames
// on each core tick a stream spends playing — the formula pinned in the
// spec, at the realm's declared rate (default 60; a runner driving a non-60
// realm must construct the sink at that rate). Everything
// downstream is therefore a pure function of (tick index, op stream): the
// consumed PCM byte-stream, the credit/underrun/ended event log, all of it
// byte-reproducible. tests/audio-sim.test.ts runs the music demo through two
// identical scenarios and asserts hash equality, and runs it with the sink
// ABSENT to prove the demo's pixels don't depend on the module (the golden
// safety property).
//
// Inject via bootWorld's extraGlobals: { audio: sink.ns }, and advance with
// sink.tick() alongside every world.tick() (the runner owns the pairing, the
// way hosts/sim/launcher.ts owns launcher policy per virtual frame).

import {
  AUDIO_MAX_STREAMS,
  AUDIO_RATES,
  AUDIO_RING_FRAMES,
  audioFramesForTick,
} from "../../contracts/spec/audio.ts";

interface SimStream {
  rate: number;
  channels: number;
  ring: Int16Array; // capacity AUDIO_RING_FRAMES source frames, interleaved
  writePos: number; // absolute source frames written
  readPos: number; // absolute source frames consumed
  playedTicks: number; // ticks spent playing (the formula's tick index)
  playing: boolean;
  endFlagged: boolean;
  starved: boolean;
  lastFree: number; // last credit value emitted
  volume: number;
}

export interface SimAudioSink {
  /** The `globalThis.audio` namespace (one method per AUDIO_OP). */
  ns: Record<string, unknown>;
  /** Advance the virtual audio clock one core tick (call beside world.tick()). */
  tick(): void;
  /** FNV-1a over every consumed PCM byte, in consumption order. */
  pcmHash(): number;
  /** Total source frames consumed across all streams. */
  consumedFrames(): number;
  /** Every op call and emitted event, in order (for trace assertions). */
  log: string[];
}

export function createSimAudioSink(ticksPerSecond = 60): SimAudioSink {
  const streams = new Map<number, SimStream>();
  const events: string[] = [];
  const log: string[] = [];
  let nextHandle = 1;
  let hash = 0x811c9dc5; // FNV-1a offset basis
  let consumed = 0;

  function eat(byte: number): void {
    hash = (hash ^ byte) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  function emit(event: object): void {
    const line = JSON.stringify(event);
    events.push(line);
    log.push("event " + line);
  }

  const ns = {
    createStream(rate: number, channels: number): number {
      log.push(`op createStream ${rate} ${channels}`);
      if (!(AUDIO_RATES as readonly number[]).includes(rate)) return -1;
      if (channels < 1 || channels > 2 || streams.size >= AUDIO_MAX_STREAMS) return -1;
      const handle = nextHandle++;
      streams.set(handle, {
        rate,
        channels,
        ring: new Int16Array(AUDIO_RING_FRAMES * channels),
        writePos: 0,
        readPos: 0,
        playedTicks: 0,
        playing: false,
        endFlagged: false,
        starved: false,
        lastFree: AUDIO_RING_FRAMES,
        volume: 1,
      });
      return handle;
    },
    destroyStream(handle: number): void {
      log.push(`op destroyStream ${handle}`);
      streams.delete(handle);
    },
    writePcm(handle: number, pcm: ArrayBuffer): number {
      const s = streams.get(handle);
      if (!s) return 0;
      const src = new Int16Array(pcm);
      const frames = Math.floor(src.length / s.channels);
      const accepted = Math.min(frames, AUDIO_RING_FRAMES - (s.writePos - s.readPos));
      for (let i = 0; i < accepted; i++) {
        const dst = ((s.writePos + i) % AUDIO_RING_FRAMES) * s.channels;
        for (let c = 0; c < s.channels; c++) s.ring[dst + c] = src[i * s.channels + c];
      }
      s.writePos += accepted;
      log.push(`op writePcm ${handle} ${frames} -> ${accepted}`);
      return accepted;
    },
    play(handle: number): void {
      log.push(`op play ${handle}`);
      const s = streams.get(handle);
      if (s) s.playing = true;
    },
    pause(handle: number): void {
      log.push(`op pause ${handle}`);
      const s = streams.get(handle);
      if (s) s.playing = false;
    },
    stop(handle: number): void {
      log.push(`op stop ${handle}`);
      const s = streams.get(handle);
      if (!s) return;
      s.playing = false;
      s.readPos = s.writePos; // flush without consuming (nothing hashed)
      s.playedTicks = 0;
      s.endFlagged = false;
      s.starved = false;
    },
    setVolume(handle: number, volume: number): void {
      log.push(`op setVolume ${handle} ${volume}`);
      const s = streams.get(handle);
      if (s) s.volume = volume;
    },
    endStream(handle: number): void {
      log.push(`op endStream ${handle}`);
      const s = streams.get(handle);
      if (s) s.endFlagged = true;
    },
    poll(): string | undefined {
      return events.length ? events.shift() : undefined;
    },
  };

  return {
    ns,
    tick(): void {
      // Handle order is creation order (Map preserves insertion): the hash
      // and event order are stable by construction.
      for (const [handle, s] of streams) {
        if (s.playing) {
          const want = audioFramesForTick(s.rate, s.playedTicks, ticksPerSecond);
          s.playedTicks++;
          const avail = s.writePos - s.readPos;
          const take = Math.min(want, avail);
          for (let i = 0; i < take; i++) {
            const src = ((s.readPos + i) % AUDIO_RING_FRAMES) * s.channels;
            for (let c = 0; c < s.channels; c++) {
              const v = s.ring[src + c] & 0xffff;
              eat(v & 0xff);
              eat(v >> 8);
            }
          }
          s.readPos += take;
          consumed += take;
          if (take < want) {
            if (s.endFlagged) {
              s.playing = false;
              emit({ t: "ended", h: handle });
            } else if (!s.starved) {
              s.starved = true;
              emit({ t: "underrun", h: handle });
            }
          } else {
            s.starved = false;
          }
        }
        const free = AUDIO_RING_FRAMES - (s.writePos - s.readPos);
        if (free !== s.lastFree) {
          s.lastFree = free;
          emit({ t: "credit", h: handle, free });
        }
      }
    },
    pcmHash: () => hash,
    consumedFrames: () => consumed,
    log,
  };
}
