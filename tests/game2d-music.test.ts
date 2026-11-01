// Streamed music and sound effects over the sim audio sink and sim pack host:
// the bytes that reach the ring are the file's, loops are seamless by content,
// and underruns, crossfades and silent hosts behave as framework/src/game2d/music.ts says.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIO_MAX_STREAMS, AUDIO_RING_FRAMES } from "../contracts/spec/audio.ts";
import { PAK_DTYPE } from "../contracts/spec/spec.ts";
import { resetClock } from "../framework/src/clock.ts";
import { loadPack, resetPack } from "../framework/src/pak.ts";
import { createMusicPlayer, createSfxBank } from "../framework/src/game2d/music.ts";
import { createSimAudioSink, type SimAudioSink } from "../platforms/sim/audio.ts";
import { createSimPackHost, type SimPackHost } from "../platforms/sim/pack.ts";
import { pack as encodePak } from "../framework/compiler/pak.ts";

const g = globalThis as { audio?: unknown; pack?: unknown };
let root = "";
let sink: SimAudioSink;
let packHost: SimPackHost;
/** handle -> every sample written to its stream, in order. */
let written: Map<number, number[]>;
let volumes: Map<number, number[]>;

/** A track whose every sample is unique per position: sample i = base + i. */
function ramp(frames: number, base = 0): Int16Array {
  return Int16Array.from({ length: frames }, (_, i) => base + (i % 30000));
}
function asBytes(pcm: Int16Array): Uint8Array {
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}
function mount(files: Record<string, Uint8Array>, options?: { pendingOpens?: number }): void {
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), bytes);
  }
  packHost = createSimPackHost({ root, pendingOpens: options?.pendingOpens });
  g.pack = packHost.ns;
}
/** One frame: pump, then the audio clock. */
function run(player: { pump(): void }, frames: number): void {
  for (let i = 0; i < frames; i++) {
    player.pump();
    sink.tick();
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "music-test-"));
  resetClock();
  sink = createSimAudioSink();
  written = new Map();
  volumes = new Map();
  const ns = sink.ns as {
    writePcm(h: number, pcm: ArrayBuffer): number;
    setVolume(h: number, v: number): void;
  };
  const write = ns.writePcm.bind(ns);
  ns.writePcm = (h, pcm) => {
    const accepted = write(h, pcm);
    const out = written.get(h) ?? [];
    out.push(...new Int16Array(pcm).subarray(0, accepted));
    written.set(h, out);
    return accepted;
  };
  const setVolume = ns.setVolume.bind(ns);
  ns.setVolume = (h, v) => {
    setVolume(h, v);
    volumes.set(h, [...(volumes.get(h) ?? []), v]);
  };
  g.audio = sink.ns;
});
afterEach(() => {
  packHost?.dispose();
  delete g.audio;
  delete g.pack;
  resetPack();
  rmSync(root, { recursive: true, force: true });
});

describe("streaming", () => {
  test("a track plays to its end, in order, without a miss, and closes its file", () => {
    const pcm = ramp(30_000);
    mount({ "a.pcm": asBytes(pcm) });
    const music = createMusicPlayer();
    music.play("a.pcm");
    expect(music.current()).toBe("a.pcm");
    run(music, 120); // 2 s of 22 050 Hz: long enough to drain 30 000 frames
    expect(written.get(1)!).toEqual([...pcm]);
    expect(music.current()).toBe(null);
    expect(music.stats().underruns).toBe(0);
    expect(music.stats().bytesRead).toBe(pcm.byteLength);
    expect(packHost.openCount()).toBe(0);
    expect(sink.log).toContain("op destroyStream 1");
    expect(sink.consumedFrames()).toBe(30_000);
  });

  test("one read per pump, in 8 KiB blocks", () => {
    mount({ "a.pcm": asBytes(ramp(400_000)) }); // long enough not to wrap in 300 frames
    const music = createMusicPlayer();
    music.play("a.pcm", { loop: true });
    const reads = () => packHost.log.filter((l) => l.startsWith("read ")).length;
    let previous = 0;
    for (let i = 0; i < 300; i++) {
      music.pump();
      sink.tick();
      expect(reads() - previous).toBeLessThanOrEqual(1);
      previous = reads();
    }
    for (const line of packHost.log.filter((l) => l.startsWith("read "))) {
      expect(line.endsWith(" 8192")).toBe(true);
    }
  });

  test("play starts only after the first write, so a track never opens on an empty ring", () => {
    mount({ "a.pcm": asBytes(ramp(50_000)) });
    const music = createMusicPlayer();
    music.play("a.pcm");
    run(music, 1);
    const write = sink.log.findIndex((l) => l.startsWith("op writePcm"));
    const play = sink.log.indexOf("op play 1");
    expect(write).toBeGreaterThanOrEqual(0);
    expect(play).toBeGreaterThan(write);
  });

  test("the ring never holds less than three blocks in steady state", () => {
    mount({ "a.pcm": asBytes(ramp(200_000)) });
    const music = createMusicPlayer();
    music.play("a.pcm", { loop: true });
    run(music, 10); // settle: the first pumps fill the ring block by block
    let lowest = Infinity;
    for (let i = 0; i < 600; i++) {
      music.pump();
      sink.tick();
      const queued = (written.get(1)?.length ?? 0) - sink.consumedFrames();
      lowest = Math.min(lowest, queued);
    }
    expect(lowest).toBeGreaterThanOrEqual(3 * 4096 - 400);
    expect(music.stats().underruns).toBe(0);
  });
});

describe("looping", () => {
  test("the wrap is byte-exact: end of file runs straight into the loop start", () => {
    const pcm = ramp(10_000);
    mount({ "a.pcm": asBytes(pcm) });
    const music = createMusicPlayer();
    music.play("a.pcm", { loop: true, loopStartFrames: 1000 });
    run(music, 600);
    const out = written.get(1)!;
    expect(out.length).toBeGreaterThan(30_000);
    const expected: number[] = [...pcm];
    while (expected.length < out.length) expected.push(...pcm.subarray(1000));
    expect(out).toEqual(expected.slice(0, out.length));
    expect(music.current()).toBe("a.pcm");
    expect(music.stats().underruns).toBe(0);
    expect(packHost.openCount()).toBe(1);
  });

  test("a loop shorter than one block wraps several times inside it", () => {
    const pcm = ramp(1000);
    mount({ "a.pcm": asBytes(pcm) });
    const music = createMusicPlayer();
    music.play("a.pcm", { loop: true });
    run(music, 200);
    const out = written.get(1)!;
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(pcm[i % 1000]!);
    expect(out.length).toBeGreaterThan(5000);
  });

  test("a loop start past the end falls back to frame 0", () => {
    const pcm = ramp(5000);
    mount({ "a.pcm": asBytes(pcm) });
    const music = createMusicPlayer();
    music.play("a.pcm", { loop: true, loopStartFrames: 999_999 });
    run(music, 100);
    const out = written.get(1)!;
    expect(out.slice(5000, 5100)).toEqual([...pcm.subarray(0, 100)]);
  });

  test("a final odd byte is ignored", () => {
    const pcm = asBytes(ramp(100));
    const odd = new Uint8Array(pcm.length + 1);
    odd.set(pcm);
    mount({ "a.pcm": odd });
    const music = createMusicPlayer();
    music.play("a.pcm");
    run(music, 60);
    expect(written.get(1)!.length).toBe(100);
    expect(music.current()).toBe(null);
  });
});

describe("underrun", () => {
  test("a stalled pump starves once per episode and recovers in order", () => {
    const pcm = ramp(200_000);
    mount({ "a.pcm": asBytes(pcm) });
    const music = createMusicPlayer();
    music.play("a.pcm", { loop: true });
    run(music, 10);
    // No pumps for 2 s: the ring (at most 743 ms) runs dry.
    for (let i = 0; i < 120; i++) sink.tick();
    run(music, 60);
    expect(music.stats().underruns).toBe(1);
    // Recovery keeps the file's order: nothing skipped, nothing repeated.
    const out = written.get(1)!;
    expect(out).toEqual([...pcm.subarray(0, out.length)]);
    const consumedAfter = sink.consumedFrames();
    run(music, 60);
    expect(sink.consumedFrames()).toBeGreaterThan(consumedAfter);
    expect(music.stats().underruns).toBe(1);
  });
});

describe("track changes", () => {
  test("a hard change replaces the stream on the next pump and closes the old file", () => {
    mount({ "a.pcm": asBytes(ramp(100_000)), "b.pcm": asBytes(ramp(100_000, 5)) });
    const music = createMusicPlayer();
    music.play("a.pcm", { loop: true });
    run(music, 30);
    music.play("b.pcm", { loop: true });
    expect(music.current()).toBe("b.pcm");
    run(music, 3);
    expect(sink.log).toContain("op destroyStream 1");
    expect(written.get(2)![0]).toBe(5);
    expect(packHost.openCount()).toBe(1);
  });

  test("a crossfade runs both streams, then frees the old one at gain 0", () => {
    mount({ "a.pcm": asBytes(ramp(100_000)), "b.pcm": asBytes(ramp(100_000, 5)) });
    const music = createMusicPlayer();
    music.play("a.pcm", { loop: true });
    run(music, 30);
    music.play("b.pcm", { loop: true, fadeInMs: 500 });
    run(music, 10); // mid-fade
    expect(packHost.openCount()).toBe(2);
    expect(sink.log).not.toContain("op destroyStream 1");
    run(music, 40); // 500 ms is 30 frames at 60 Hz
    expect(sink.log).toContain("op destroyStream 1");
    expect(packHost.openCount()).toBe(1);
    const a = volumes.get(1)!;
    const b = volumes.get(2)!;
    expect(a.at(-1)).toBe(0);
    expect(b[0]).toBe(0);
    expect(b.at(-1)).toBe(1);
    for (let i = 1; i < b.length; i++) expect(b[i]!).toBeGreaterThanOrEqual(b[i - 1]!);
    for (let i = 1; i < a.length; i++) expect(a[i]!).toBeLessThanOrEqual(a[i - 1]!);
    expect(music.stats().underruns).toBe(0);
  });

  test("stop with a fade: current is null at once, the stream goes when the fade ends", () => {
    mount({ "a.pcm": asBytes(ramp(100_000)) });
    const music = createMusicPlayer();
    music.play("a.pcm", { loop: true, volume: 0.5 });
    run(music, 10);
    music.stop(100);
    expect(music.current()).toBe(null);
    run(music, 3);
    expect(sink.log).not.toContain("op destroyStream 1");
    run(music, 6);
    expect(sink.log).toContain("op destroyStream 1");
    expect(packHost.openCount()).toBe(0);
    expect(volumes.get(1)!.at(-1)).toBe(0);
  });

  test("stop without a fade is immediate, and play of the same path is a no-op", () => {
    mount({ "a.pcm": asBytes(ramp(100_000)) });
    const music = createMusicPlayer();
    music.play("a.pcm", { loop: true });
    run(music, 10);
    const reads = packHost.log.length;
    music.play("a.pcm", { loop: true });
    run(music, 1);
    expect(sink.log.filter((l) => l.startsWith("op createStream"))).toHaveLength(1);
    expect(packHost.log.length).toBeGreaterThanOrEqual(reads);
    music.stop();
    expect(sink.log).toContain("op destroyStream 1");
    expect(packHost.openCount()).toBe(0);
    music.play("a.pcm");
    run(music, 1);
    expect(sink.log.filter((l) => l.startsWith("op createStream"))).toHaveLength(2);
  });

  test("setVolume scales fades and survives track changes", () => {
    mount({ "a.pcm": asBytes(ramp(100_000)), "b.pcm": asBytes(ramp(100_000)) });
    const music = createMusicPlayer();
    music.setVolume(0.5);
    music.play("a.pcm", { loop: true });
    run(music, 2);
    expect(volumes.get(1)!.at(-1)).toBe(0.5);
    music.setVolume(0.25);
    expect(volumes.get(1)!.at(-1)).toBe(0.25);
    music.play("b.pcm", { loop: true, fadeInMs: 100 });
    run(music, 12);
    expect(volumes.get(2)!.at(-1)).toBe(0.25);
  });

  test("a crossfade with every stream taken fades the old track first, then starts", () => {
    mount({ "a.pcm": asBytes(ramp(100_000)), "b.pcm": asBytes(ramp(100_000, 5)) });
    const music = createMusicPlayer();
    music.play("a.pcm", { loop: true });
    run(music, 5);
    const ns = sink.ns as { createStream(r: number, c: number): number };
    for (let i = 1; i < AUDIO_MAX_STREAMS; i++) expect(ns.createStream(22050, 1)).toBeGreaterThanOrEqual(0);
    music.play("b.pcm", { loop: true, fadeInMs: 100 });
    run(music, 2);
    expect(written.get(5)).toBeUndefined(); // b has no stream yet
    run(music, 10); // a's fade ends and frees its stream
    expect(sink.log).toContain("op destroyStream 1");
    expect(written.get(5)![0]).toBe(5);
    expect(music.current()).toBe("b.pcm");
  });
});

describe("hosts that cannot help", () => {
  test("a pending open retries until the file arrives", () => {
    const pcm = ramp(5000);
    mount({ "a.pcm": asBytes(pcm) }, { pendingOpens: 3 });
    const music = createMusicPlayer();
    music.play("a.pcm", { loop: true });
    run(music, 3);
    expect(sink.log.filter((l) => l.startsWith("op createStream"))).toHaveLength(0);
    run(music, 2);
    expect(written.get(1)!.slice(0, 10)).toEqual([...pcm.subarray(0, 10)]);
  });

  test("a missing file clears current and counts", () => {
    mount({});
    const music = createMusicPlayer();
    music.play("nope.pcm");
    run(music, 2);
    expect(music.current()).toBe(null);
    expect(music.stats().missing).toBe(1);
    expect(packHost.openCount()).toBe(0);
  });

  test("a missing replacement fades the old track out instead of leaving it", () => {
    mount({ "a.pcm": asBytes(ramp(100_000)) });
    const music = createMusicPlayer();
    music.play("a.pcm", { loop: true });
    run(music, 5);
    music.play("nope.pcm", { fadeInMs: 50 });
    run(music, 10);
    expect(music.current()).toBe(null);
    expect(sink.log).toContain("op destroyStream 1");
  });

  test("no pack module, no audio module, or neither: silent and never throwing", () => {
    for (const setup of [
      () => { mount({}); delete g.audio; },
      () => { delete g.pack; },
      () => { delete g.pack; delete g.audio; },
    ]) {
      setup();
      const music = createMusicPlayer();
      const sfx = createSfxBank(["blip"]);
      music.setVolume(0.5);
      music.play("a.pcm", { loop: true, fadeInMs: 100 });
      expect(music.current()).toBe("a.pcm");
      run({ pump: () => { music.pump(); sfx.pump(); } }, 5);
      expect(sfx.play("blip")).toBe(false);
      sfx.setVolume(0.5);
      sfx.stopAll();
      sfx.dispose();
      music.stop(100);
      expect(music.current()).toBe(null);
      expect(music.stats()).toMatchObject({ underruns: 0, bytesRead: 0 });
      g.audio = sink.ns;
    }
  });

  test("a bad rate clears the request instead of throwing", () => {
    mount({ "a.pcm": asBytes(ramp(100)) });
    const music = createMusicPlayer();
    music.play("a.pcm", { rate: 48000 as 44100 });
    run(music, 2);
    expect(music.current()).toBe(null);
  });
});

/** A complete RIFF/WAVE around s16 mono samples. */
function wav(samples: Int16Array, rate = 22050): Uint8Array {
  const out = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(out.buffer);
  const tag = (off: number, s: string) => { for (let i = 0; i < 4; i++) out[off + i] = s.charCodeAt(i); };
  tag(0, "RIFF"); view.setUint32(4, 36 + samples.byteLength, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, samples.byteLength, true);
  out.set(asBytes(samples), 44);
  return out;
}

function installPak(entries: Record<string, Uint8Array>): void {
  const pak = encodePak(Object.entries(entries).map(([key, data]) => ({ key, dtype: PAK_DTYPE.u8, data })));
  loadPack(pak.buffer.slice(pak.byteOffset, pak.byteOffset + pak.byteLength) as ArrayBuffer);
}

describe("sound effects", () => {
  const blip = ramp(2000, 100);
  const boom = ramp(3000, 200);

  test("three overlap, and a fourth steals the oldest", () => {
    installPak({ "audio:wav.blip": wav(blip), "audio:wav.boom": wav(boom) });
    const sfx = createSfxBank(["blip", "boom"]);
    expect(sfx.play("blip")).toBe(true);
    expect(sfx.play("boom")).toBe(true);
    expect(sfx.play("blip")).toBe(true);
    expect(written.get(1)!.slice(0, 3)).toEqual([100, 101, 102]);
    expect(written.get(2)!.slice(0, 3)).toEqual([200, 201, 202]);
    expect(sink.log.filter((l) => l === "op play 1" || l === "op play 2" || l === "op play 3")).toHaveLength(3);
    expect(sfx.stats().steals).toBe(0);
    expect(sfx.play("boom")).toBe(true);
    expect(sfx.stats().steals).toBe(1);
    expect(sink.log).toContain("op destroyStream 1");
  });

  test("the WAV decodes once; every play writes the same cached buffer", () => {
    installPak({ "audio:wav.blip": wav(blip) });
    const seen: ArrayBuffer[] = [];
    const ns = sink.ns as { writePcm(h: number, pcm: ArrayBuffer): number };
    const write = ns.writePcm;
    ns.writePcm = (h, pcm) => {
      seen.push(pcm);
      return write(h, pcm);
    };
    const sfx = createSfxBank(["blip"]);
    for (let i = 0; i < 10; i++) {
      expect(sfx.play("blip")).toBe(true);
      run(sfx, 10);
    }
    expect(sfx.stats().decoded).toBe(1);
    expect(seen).toHaveLength(10);
    for (const buffer of seen) expect(buffer).toBe(seen[0]!);
    expect(seen[0]!.byteLength).toBe(blip.byteLength);
  });

  test("streams are released when a sound ends, so music keeps its stream", () => {
    installPak({ "audio:wav.blip": wav(blip) });
    mount({ "a.pcm": asBytes(ramp(100_000)) });
    const music = createMusicPlayer();
    const sfx = createSfxBank(["blip"]);
    const both = { pump() { music.pump(); sfx.pump(); } };
    music.play("a.pcm", { loop: true });
    run(both, 5);
    sfx.play("blip");
    run(both, 30); // 2000 frames at 22 050 Hz is 5.4 frames at 60 Hz
    expect(sink.log.filter((l) => l.startsWith("op destroyStream"))).toHaveLength(1);
    // Events route by handle: neither consumer lost its credit.
    run(both, 300);
    expect(music.stats().underruns).toBe(0);
    expect(music.current()).toBe("a.pcm");
  });

  test("a sound longer than the ring is fed by credit", () => {
    const long = ramp(AUDIO_RING_FRAMES * 2 + 100, 7);
    installPak({ "audio:wav.long": wav(long) });
    const sfx = createSfxBank(["long"]);
    expect(sfx.play("long")).toBe(true);
    run(sfx, 240);
    expect(written.get(1)!).toEqual([...long]);
    expect(sink.log).toContain("op destroyStream 1");
  });

  test("volume multiplies bank, sound and play", () => {
    installPak({ "audio:wav.blip": wav(blip) });
    const sfx = createSfxBank([{ name: "blip", volume: 0.5 }]);
    sfx.setVolume(0.5);
    sfx.play("blip", { volume: 0.5 });
    expect(volumes.get(1)!.at(-1)).toBe(0.125);
  });

  test("an unknown or absent sound drops the play", () => {
    installPak({});
    const sfx = createSfxBank(["absent"]);
    expect(sfx.play("absent")).toBe(false);
    expect(sfx.play("never-declared")).toBe(false);
    expect(sfx.stats().dropped).toBe(2);
  });

  test("a sound in a pack file loads on a later pump, once", () => {
    mount({ "s/blip.wav": wav(blip) }, { pendingOpens: 1 });
    const sfx = createSfxBank([{ name: "blip", path: "s/blip.wav" }]);
    expect(sfx.play("blip")).toBe(false);
    run(sfx, 2);
    expect(sfx.play("blip")).toBe(true);
    expect(sfx.stats().decoded).toBe(1);
    expect(packHost.openCount()).toBe(0);
    expect(written.get(1)!.slice(0, 2)).toEqual([100, 101]);
  });
});
