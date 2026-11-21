// Run: bun tools/build.ts music-main && bun test --conditions=browser tests/audio-sim.test.ts

import { expect, test } from "bun:test";
import { BTN } from "../contracts/spec/spec.ts";
import { bootWorld, scriptToMasks, type ScriptEvent } from "../programs/sim/sim.ts";
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

async function runMusic(): Promise<SimAudioSink> {
  const sink = createSimAudioSink();
  const world = await bootWorld("music-main", 60, { audio: sink.ns });
  const frames = SECONDS * 60;
  const { masks, analogs } = scriptToMasks(SCRIPT, 60, frames);
  for (let f = 0; f < frames; f++) {
    world.frame(masks[f], analogs[f]);
    for (let t = 0; t < world.ticksPerFrame; t++) {
      world.tick();
      sink.tick(); // the virtual audio clock advances WITH the core clock
    }
  }
  return sink;
}

test("music demo journey consumes deterministic PCM", async () => {
  const sinkA = await runMusic();
  const sinkB = await runMusic();
  // The demo really streamed audio: one 22.05 kHz mono stream, actual frames.
  expect(sinkA.log.some((l) => l.startsWith("op createStream 22050 1"))).toBe(true);
  expect(sinkA.consumedFrames()).toBeGreaterThan(0);
  // A healthy pump never starves the ring on the virtual clock.
  expect(sinkA.log.some((l) => l.includes('"underrun"'))).toBe(false);
  expect(sinkB.consumedFrames()).toBe(sinkA.consumedFrames());
  expect(sinkB.log).toEqual(sinkA.log);
}, 60_000);
