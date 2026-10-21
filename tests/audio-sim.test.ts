// Deterministic sim journeys for the audio module through the REAL music
// demo bundle (dist/music-main.js): the sim sink (platforms/sim/audio.ts) is the
// virtual-clock embodiment of contracts/spec/audio.ts, injected through
// bootWorld's extraGlobals exactly the way a device host mounts the
// namespace.
//
// Two claims are pinned here:
//   1. Determinism — two identical journeys consume byte-identical PCM and
//      produce identical op/event logs (the multi-clock module's
//      virtual-clock story, docs/RUNTIMES.md §5 discipline).
//   2. Golden safety — the journey's PIXEL hashes are identical with the
//      module mounted and absent. The tick clock owns the UI; audio only
//      follows it. This is what keeps all 17 committed music goldens
//      (web/psp/vita × 3 frameworks) valid without re-baking.
//
// Run: bun tools/build.ts music-main && bun test --conditions=browser tests/audio-sim.test.ts

import { expect, test } from "bun:test";
import { BTN } from "../contracts/spec/spec.ts";
import { bootWorld, fnv1a, scriptToMasks, type ScriptEvent } from "../programs/sim/sim.ts";
import { createSimAudioSink, type SimAudioSink } from "../platforms/sim/audio.ts";

// The golden-spec journey (tests/golden-specs.ts music-main), extended to 3 s:
// focus the cover, pause, walk focus down, select a row (play), skip a track.
const SCRIPT: ScriptEvent[] = [
  { at: 4 / 60, press: BTN.DOWN },
  { at: 10 / 60, press: BTN.CIRCLE }, // pause on the cover
  { at: 30 / 60, press: BTN.DOWN },
  { at: 36 / 60, press: BTN.DOWN },
  { at: 42 / 60, press: BTN.CIRCLE }, // select a track row -> playing again
  { at: 70 / 60, press: BTN.RTRIGGER }, // skip
];
const SECONDS = 3;

async function runMusic(withAudio: boolean): Promise<{ hashes: string[]; sink: SimAudioSink | null }> {
  const sink = withAudio ? createSimAudioSink() : null;
  const world = await bootWorld("music-main", 60, sink ? { audio: sink.ns } : undefined);
  const frames = SECONDS * 60;
  const { masks, analogs } = scriptToMasks(SCRIPT, 60, frames);
  const hashes: string[] = [];
  for (let f = 0; f < frames; f++) {
    world.frame(masks[f], analogs[f]);
    for (let t = 0; t < world.ticksPerFrame; t++) {
      world.tick();
      sink?.tick(); // the virtual audio clock advances WITH the core clock
    }
    hashes.push(fnv1a(world.render()));
  }
  return { hashes, sink };
}

test("music demo journey consumes deterministic PCM", async () => {
  const a = await runMusic(true);
  const b = await runMusic(true);
  const sinkA = a.sink!;
  const sinkB = b.sink!;
  // The demo really streamed audio: one 22.05 kHz mono stream, actual frames.
  expect(sinkA.log.some((l) => l.startsWith("op createStream 22050 1"))).toBe(true);
  expect(sinkA.consumedFrames()).toBeGreaterThan(0);
  // A healthy pump never starves the ring on the virtual clock.
  expect(sinkA.log.some((l) => l.includes('"underrun"'))).toBe(false);
  // Byte-exact reproducibility: consumed PCM, op order, event order.
  expect(sinkB.pcmHash()).toBe(sinkA.pcmHash());
  expect(sinkB.consumedFrames()).toBe(sinkA.consumedFrames());
  expect(sinkB.log).toEqual(sinkA.log);
}, 60_000);

test("pixels are byte-identical with and without the audio module", async () => {
  const withAudio = await runMusic(true);
  const silent = await runMusic(false);
  expect(silent.hashes.length).toBe(withAudio.hashes.length);
  expect(withAudio.hashes).toEqual(silent.hashes);
}, 60_000);
