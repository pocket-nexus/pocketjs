// Audio module unit tests: the WAV reference decoder, the pinned
// consumption formula, the committed music-demo assets, and the SDK's
// credit-driven pump against the deterministic sim sink (which doubles as
// the module's reference core). Headless sim journeys live in
// tests/audio-sim.test.ts; this file needs no built bundle.

import { describe, expect, test } from "bun:test";
import {
  AUDIO_RATES,
  AUDIO_RING_FRAMES,
  audioFramesForTick,
} from "../contracts/spec/audio.ts";
import { createWavPlayer, decodeWav } from "../framework/src/audio-api.ts";
import { createSimAudioSink } from "../hosts/sim/audio.ts";

// --- the pinned consumption formula ---------------------------------------

describe("audioFramesForTick", () => {
  test("sums to exactly the rate over any 60-tick window", () => {
    for (const rate of AUDIO_RATES) {
      for (const start of [0, 1, 30, 59, 600]) {
        let sum = 0;
        for (let t = start; t < start + 60; t++) sum += audioFramesForTick(rate, t);
        expect(sum).toBe(rate);
      }
    }
  });

  test("never deviates more than one frame from rate/60", () => {
    for (const rate of AUDIO_RATES) {
      const ideal = rate / 60;
      for (let t = 0; t < 240; t++) {
        expect(Math.abs(audioFramesForTick(rate, t) - ideal)).toBeLessThanOrEqual(1);
      }
    }
  });

  test("zero drift holds at any declared realm rate", () => {
    for (const ticksPerSecond of [90, 120, 240]) {
      for (const rate of AUDIO_RATES) {
        for (const start of [0, 1, 59, 600]) {
          let sum = 0;
          for (let t = start; t < start + ticksPerSecond; t++) {
            sum += audioFramesForTick(rate, t, ticksPerSecond);
          }
          expect(sum).toBe(rate);
        }
        const ideal = rate / ticksPerSecond;
        for (let t = 0; t < 2 * ticksPerSecond; t++) {
          expect(
            Math.abs(audioFramesForTick(rate, t, ticksPerSecond) - ideal),
          ).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

// --- decodeWav (the audio:wav.* data-contract reference decoder) -----------

function wavBytes(pcm: Int16Array, sampleRate: number, channels: number): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2 * channels, true);
  view.setUint16(32, 2 * channels, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return bytes;
}

describe("decodeWav", () => {
  test("round-trips a stereo WAV", () => {
    const pcm = new Int16Array([100, -100, 2000, -2000, 32767, -32768]);
    const wav = decodeWav(wavBytes(pcm, 44100, 2));
    expect(wav.sampleRate).toBe(44100);
    expect(wav.channels).toBe(2);
    expect(wav.frames).toBe(3);
    expect([...wav.data]).toEqual([...pcm]);
  });

  test("skips unknown chunks between fmt and data", () => {
    const pcm = new Int16Array([1, 2, 3, 4]);
    const base = wavBytes(pcm, 22050, 1);
    // Splice a 6-byte LIST chunk (odd payload size exercises word padding).
    const junk = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 5, 0, 0, 0, 9, 9, 9, 9, 9, 0]);
    const spliced = new Uint8Array(base.length + junk.length);
    spliced.set(base.subarray(0, 36), 0);
    spliced.set(junk, 36);
    spliced.set(base.subarray(36), 36 + junk.length);
    new DataView(spliced.buffer).setUint32(4, spliced.length - 8, true);
    const wav = decodeWav(spliced);
    expect(wav.frames).toBe(4);
    expect([...wav.data]).toEqual([1, 2, 3, 4]);
  });

  test("refuses what the contract refuses", () => {
    const pcm = new Int16Array([0, 0]);
    expect(() => decodeWav(wavBytes(pcm, 48000, 1))).toThrow(/rate/);
    const bad8bit = wavBytes(pcm, 22050, 1);
    new DataView(bad8bit.buffer).setUint16(34, 8, true);
    expect(() => decodeWav(bad8bit)).toThrow(/16-bit/);
    expect(() => decodeWav(new Uint8Array(10))).toThrow(/RIFF/);
  });
});

// --- the committed demo assets (gen-assets.ts determinism pins) ------------

describe("apps/music media", () => {
  const TRACKS = [
    ["midnight-replay", "34fdd4a10df245b5fab986bba0a8d5595366f0ffc4544d5b3290b34eba8ee62d"],
    ["glass-horizon", "d967a8a7efd2f82b2bd705a83a09e5f6ac7b239af83b06ef66c0aaa7b3abacb0"],
    ["static-bloom", "181c335aa911bb1e053d2b87c11dbc1d5482a21a888343ee8ccc7919b13c56cd"],
  ] as const;

  test("every track is exactly the demo timeline: 5 s, 22.05 kHz mono", async () => {
    for (const [name] of TRACKS) {
      const bytes = new Uint8Array(
        await Bun.file(new URL(`../apps/music/media/${name}.wav`, import.meta.url)).arrayBuffer(),
      );
      const wav = decodeWav(bytes);
      expect(wav.sampleRate).toBe(22050);
      expect(wav.channels).toBe(1);
      // 300 frames at 60 Hz — the track clock IS the demo's tick counter.
      expect(wav.frames).toBe(300 * (22050 / 60));
    }
  });

  test("bytes are pinned (bun apps/music/gen-assets.ts is deterministic)", async () => {
    for (const [name, sha] of TRACKS) {
      const bytes = await Bun.file(
        new URL(`../apps/music/media/${name}.wav`, import.meta.url),
      ).arrayBuffer();
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      expect(`${name}:${digest}`).toBe(`${name}:${sha}`);
    }
  });
});

// --- the SDK pump against the sim sink (credit flow end to end) ------------

describe("WavPlayer x sim sink", () => {
  test("credit-driven pump feeds, drains, and ends deterministically", () => {
    const sink = createSimAudioSink();
    (globalThis as Record<string, unknown>).audio = sink.ns;
    try {
      const player = createWavPlayer();
      // One second of ramp at 22.05 kHz mono.
      const frames = 22050;
      const data = new Int16Array(frames);
      for (let i = 0; i < frames; i++) data[i] = (i % 2000) - 1000;
      expect(player.loadPcm({ sampleRate: 22050, channels: 1, frames, data })).toBe(true);
      player.play();
      expect(player.playing()).toBe(true);

      // 90 ticks: 1 s of audio consumed in 60, then the drain + ended event.
      for (let t = 0; t < 90; t++) {
        player.pump();
        sink.tick();
      }
      player.pump(); // observe the final batch
      expect(sink.consumedFrames()).toBe(frames);
      expect(player.playing()).toBe(false); // ended event landed
      expect(player.stats().underruns).toBe(0);
      expect(sink.log.some((l) => l.includes('"ended"'))).toBe(true);

      // The whole exchange is reproducible bit for bit.
      const sink2 = createSimAudioSink();
      (globalThis as Record<string, unknown>).audio = sink2.ns;
      const player2 = createWavPlayer();
      player2.loadPcm({ sampleRate: 22050, channels: 1, frames, data });
      player2.play();
      for (let t = 0; t < 90; t++) {
        player2.pump();
        sink2.tick();
      }
      player2.pump();
      expect(sink2.pcmHash()).toBe(sink.pcmHash());
      expect(sink2.log).toEqual(sink.log);
    } finally {
      delete (globalThis as Record<string, unknown>).audio;
    }
  });

  test("a declared-rate sink consumes the same PCM bytes, retimed", () => {
    const run = (ticksPerSecond: number, ticks: number) => {
      const sink = createSimAudioSink(ticksPerSecond);
      (globalThis as Record<string, unknown>).audio = sink.ns;
      const player = createWavPlayer();
      const frames = 22050;
      const data = new Int16Array(frames);
      for (let i = 0; i < frames; i++) data[i] = (i % 2000) - 1000;
      player.loadPcm({ sampleRate: 22050, channels: 1, frames, data });
      player.play();
      for (let t = 0; t < ticks; t++) {
        player.pump();
        sink.tick();
      }
      player.pump();
      return { sink, player };
    };
    try {
      // 1.5 virtual seconds at each rate: the whole 1 s track plus drain.
      const at60 = run(60, 90);
      const at120 = run(120, 180);
      expect(at60.sink.consumedFrames()).toBe(22050);
      expect(at120.sink.consumedFrames()).toBe(22050);
      // The declared rate changes per-tick chunking, never the byte-stream.
      expect(at120.sink.pcmHash()).toBe(at60.sink.pcmHash());
      expect(at120.player.stats().underruns).toBe(0);
      expect(at120.player.playing()).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>).audio;
    }
  });

  test("underrun is edge-reported and playback survives it", () => {
    const sink = createSimAudioSink();
    (globalThis as Record<string, unknown>).audio = sink.ns;
    try {
      const ns = sink.ns as {
        createStream(r: number, c: number): number;
        writePcm(h: number, b: ArrayBuffer): number;
        play(h: number): void;
      };
      const h = ns.createStream(22050, 1);
      expect(h).toBeGreaterThan(0);
      ns.play(h);
      sink.tick(); // starves immediately
      sink.tick(); // still starved — must NOT re-report
      const underruns = sink.log.filter((l) => l.includes('"underrun"'));
      expect(underruns.length).toBe(1);
      // Feed it again: consumption resumes.
      const chunk = new Int16Array(4096);
      ns.writePcm(h, chunk.buffer as ArrayBuffer);
      sink.tick();
      expect(sink.consumedFrames()).toBeGreaterThan(0);
    } finally {
      delete (globalThis as Record<string, unknown>).audio;
    }
  });

  test("guest mirror math: free-frame budget never exceeds the ring", () => {
    const sink = createSimAudioSink();
    (globalThis as Record<string, unknown>).audio = sink.ns;
    try {
      const player = createWavPlayer();
      const frames = AUDIO_RING_FRAMES * 3;
      const data = new Int16Array(frames);
      player.loadPcm({ sampleRate: 22050, channels: 1, frames, data });
      player.play();
      for (let t = 0; t < 30; t++) {
        player.pump();
        sink.tick();
        const pos = player.positionFrames();
        expect(pos).toBeGreaterThanOrEqual(0);
        expect(pos).toBeLessThanOrEqual(frames);
      }
      expect(sink.log.some((l) => l.includes("underrun"))).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>).audio;
    }
  });
});
