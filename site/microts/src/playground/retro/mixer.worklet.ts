// Four-channel software synth: a line-by-line port of pocket-retro runtime/gba/src/audio.rs.
// Every audio tick (76 samples, about 1/239 s) the SDK sequencer gives each channel a
// tone, a 16.16 fixed-point phase step and an amplitude; this mixes at 18157 Hz, then resamples linearly to the AudioContext rate.

const RATE = 18157;
const SAMPLES_PER_TICK = 76;
const RAMP_SAMPLES = 16;
const CHANNELS = 4;
const QUEUE_TICKS = 32;

const WAVES = [
  [1, 3, 5, 7, 9, 11, 13, 15, 15, 13, 11, 9, 7, 5, 3, 1, -1, -3, -5, -7, -9, -11, -13, -15, -15, -13, -11, -9, -7, -5, -3, -1],
  [15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15],
  [15, 15, 15, 15, 15, 15, 15, 15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15, -15],
];

interface Voice {
  tone: number;
  step: number;
  amplitude: number;
}
const SILENT: Voice = { tone: -1, step: 0, amplitude: 0 };

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

class RetroMixer extends AudioWorkletProcessor {
  private queue: Voice[][] = [];
  private current: Voice[] = Array.from({ length: CHANNELS }, () => SILENT);
  private sounding: Voice[] = Array.from({ length: CHANNELS }, () => SILENT);
  private level = new Int32Array(CHANNELS);
  private phase = new Uint32Array(CHANNELS);
  private noise = new Uint32Array(CHANNELS).fill(0x7001);
  private tick = new Float32Array(SAMPLES_PER_TICK);
  private sum = new Int32Array(SAMPLES_PER_TICK);
  private cursor = SAMPLES_PER_TICK;
  private prev = 0;
  private next = 0;
  private frac = 0;
  private consumed = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ type: string; voices?: Int32Array }>) => {
      if (e.data.type === "voices" && e.data.voices) this.push(e.data.voices);
      else if (e.data.type === "reset") this.reset();
    };
  }

  private reset() {
    this.queue = [];
    this.current = this.current.map(() => SILENT);
    this.sounding = this.sounding.map(() => SILENT);
    this.level.fill(0);
    this.phase.fill(0);
    this.noise.fill(0x7001);
    this.cursor = SAMPLES_PER_TICK;
  }

  private push(records: Int32Array) {
    for (let at = 0; at + 3 * CHANNELS <= records.length; at += 3 * CHANNELS) {
      if (this.queue.length >= QUEUE_TICKS) break;
      const slot: Voice[] = [];
      for (let c = 0; c < CHANNELS; c++)
        slot.push({ tone: records[at + c * 3]!, step: records[at + c * 3 + 1]! >>> 0, amplitude: records[at + c * 3 + 2]! });
      this.queue.push(slot);
    }
  }

  // Mix the 76 samples of the next tick; an empty queue holds the previous voices, as the GBA host does
  private mixTick() {
    const next = this.queue.shift();
    if (next) this.current = next;
    if (++this.consumed % 8 === 0) this.port.postMessage({ type: "queued", queued: this.queue.length });
    const sum = this.sum;
    sum.fill(0);
    for (let c = 0; c < CHANNELS; c++) {
      const voice = this.current[c]!;
      const target = voice.tone < 0 ? 0 : voice.amplitude;
      if (voice.tone >= 0) this.sounding[c] = voice;
      const from = this.level[c]!;
      this.level[c] = target;
      const played = this.sounding[c]!;
      if (played.tone < 0 || (from === 0 && target === 0)) continue;
      let position = this.phase[c]!;
      if (played.tone === 3) {
        position &= 0xffff;
        let lfsr = this.noise[c]!;
        for (let i = 0; i < SAMPLES_PER_TICK; i++) {
          const amplitude = i < RAMP_SAMPLES ? from + (((target - from) * (i + 1)) >> 4) : target;
          position += played.step;
          while (position >= 0x10000) {
            position -= 0x10000;
            const feedback = (lfsr ^ (lfsr >> 1)) & 1;
            lfsr = (lfsr >> 1) | (feedback << 14);
          }
          sum[i] += (lfsr & 1) === 0 ? 15 * amplitude : -15 * amplitude;
        }
        this.noise[c] = lfsr;
      } else {
        const wave = WAVES[played.tone > 2 ? 2 : played.tone]!;
        for (let i = 0; i < SAMPLES_PER_TICK; i++) {
          const amplitude = i < RAMP_SAMPLES ? from + (((target - from) * (i + 1)) >> 4) : target;
          position = (position + played.step) >>> 0;
          sum[i] += wave[(position >>> 16) & 31]! * amplitude;
        }
      }
      this.phase[c] = position >>> 0;
    }
    for (let i = 0; i < SAMPLES_PER_TICK; i++) {
      const v = sum[i]! >> 6;
      this.tick[i] = (v > 127 ? 127 : v < -128 ? -128 : v) / 128;
    }
    this.cursor = 0;
  }

  private nextSample(): number {
    if (this.cursor >= SAMPLES_PER_TICK) this.mixTick();
    return this.tick[this.cursor++]!;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const step = RATE / sampleRate;
    const left = out[0];
    for (let i = 0; i < left.length; i++) {
      this.frac += step;
      while (this.frac >= 1) {
        this.frac -= 1;
        this.prev = this.next;
        this.next = this.nextSample();
      }
      left[i] = this.prev + (this.next - this.prev) * this.frac;
    }
    for (let ch = 1; ch < out.length; ch++) out[ch]!.set(left);
    return true;
  }
}

registerProcessor("retro-mixer", RetroMixer);
