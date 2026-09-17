#!/usr/bin/env bun
// vapor/scripts/promo/music.ts — an original chiptune/electro bed for the
// promo video, synthesized from scratch (square arps, triangle bass, noise
// hats, sine kick), so the soundtrack is as engine-made as the footage.
//
// 125 BPM, A minor, Am F C G. Structure keyed to the storyboard — the lead
// melody MUST enter at bar 10 (19.2 s), the exact frame the three-console
// gameplay starts (promo.ts SEG.play.start = 1152). Keep them in sync.
//   bars  1-4   intro: arp + soft pad          (title, component code)
//   bars  5-8   + hats and bass                (code, TS -> C split)
//   bars  9-10  + kick, groove settles          (split lands)
//   bars 11-18  full groove + lead melody       (three-console gameplay)
//   bars 19-21  breakdown, kick softens         (numbers)
//   bars 22-24  resolve and fade                (close)

import { join } from "node:path";

const SR = 44100;
const BPM = 125;
const BEAT = 60 / BPM; // 0.48 s
const BAR = BEAT * 4;
const BARS = 24;
const DUR = 2814 / 60; // == the promo timeline (TOTAL frames / fps); trailing 0.8 s rings out
const N = Math.floor(SR * DUR);

// A minor: chord roots (Hz) for Am, F, C, G (low octave)
const A2 = 110.0, F2 = 87.31, C3 = 130.81, G2 = 98.0;
const CHORDS: number[][] = [
  [A2, A2 * 2 ** (3 / 12), A2 * 2 ** (7 / 12)], // Am: A C E
  [F2, F2 * 2 ** (4 / 12), F2 * 2 ** (7 / 12)], // F:  F A C
  [C3, C3 * 2 ** (4 / 12), C3 * 2 ** (7 / 12)], // C:  C E G
  [G2, G2 * 2 ** (4 / 12), G2 * 2 ** (7 / 12)], // G:  G B D
];
// A minor pentatonic for the lead (one octave up + extensions)
const PENTA = [440.0, 523.25, 587.33, 659.25, 783.99, 880.0];

const buf = new Float32Array(N);

function square(ph: number, duty = 0.5): number {
  return (ph % 1) < duty ? 1 : -1;
}
function tri(ph: number): number {
  const p = ph % 1;
  return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
}
let noiseState = 0x1234;
function noise(): number {
  noiseState ^= noiseState << 13; noiseState &= 0xffffffff;
  noiseState ^= noiseState >>> 17;
  noiseState ^= noiseState << 5; noiseState &= 0xffffffff;
  return ((noiseState >>> 0) / 0xffffffff) * 2 - 1;
}

/** Add one voiced note: simple attack/decay envelope. */
function note(
  start: number, dur: number, freq: number, amp: number,
  osc: (ph: number) => number, attack = 0.005, release = 0.05,
): void {
  const s0 = Math.floor(start * SR);
  const n = Math.floor(dur * SR);
  for (let i = 0; i < n && s0 + i < N; i++) {
    const t = i / SR;
    let env = 1;
    if (t < attack) env = t / attack;
    else if (t > dur - release) env = Math.max(0, (dur - t) / release);
    buf[s0 + i] += osc(freq * t) * amp * env;
  }
}

function kick(start: number, amp = 0.9): void {
  const s0 = Math.floor(start * SR);
  const n = Math.floor(0.16 * SR);
  for (let i = 0; i < n && s0 + i < N; i++) {
    const t = i / SR;
    const f = 40 + 120 * Math.exp(-t * 30); // pitch drop 160 -> 40 Hz
    const env = Math.exp(-t * 18);
    buf[s0 + i] += Math.sin(2 * Math.PI * f * t) * amp * env;
  }
}

function hat(start: number, amp = 0.16, dur = 0.03): void {
  const s0 = Math.floor(start * SR);
  const n = Math.floor(dur * SR);
  for (let i = 0; i < n && s0 + i < N; i++) {
    const env = Math.exp((-i / SR) * 120);
    buf[s0 + i] += noise() * amp * env;
  }
}

for (let bar = 0; bar < BARS; bar++) {
  const t0 = bar * BAR;
  const chord = CHORDS[bar % 4];
  const groove = bar >= 8 && bar < 21;
  const full = bar >= 10 && bar < 18; // bar 10 = 19.2 s = gameplay in
  const fading = bar >= 21;

  // arp: 16th-note square through chord tones, two octaves
  const arpAmp = fading ? 0.05 : bar < 4 ? 0.07 : 0.09;
  for (let s = 0; s < 16; s++) {
    const tone = chord[s % 3] * (s % 6 >= 3 ? 4 : 2);
    note(t0 + s * (BEAT / 4), BEAT / 4 - 0.01, tone, arpAmp, (p) => square(p, 0.25));
  }
  // pad: soft detuned triangle chord, whole bar
  for (const f of chord) {
    note(t0, BAR, f * 2, 0.035, tri, 0.4, 0.6);
    note(t0, BAR, f * 2 * 1.003, 0.028, tri, 0.4, 0.6);
  }
  // bass: triangle 8ths on the root
  if (bar >= 4 && !fading) {
    for (let s = 0; s < 8; s++) {
      note(t0 + s * (BEAT / 2), BEAT / 2 - 0.03, chord[0], s % 2 ? 0.16 : 0.22, tri, 0.004, 0.03);
    }
  }
  // hats: 16ths, off-beat accents
  if (bar >= 4 && !fading) {
    for (let s = 0; s < 16; s++) hat(t0 + s * (BEAT / 4), s % 4 === 2 ? 0.2 : 0.09);
  }
  // kick: four on the floor, softened for the numbers breakdown
  if (groove) for (let b = 0; b < 4; b++) kick(t0 + b * BEAT, bar >= 18 ? 0.55 : 0.85);
  // lead: a pentatonic phrase over the gameplay section, with echo
  if (full) {
    const PHRASE = [0, 2, 3, 2, 4, 3, 2, 1]; // indices into PENTA
    for (let s = 0; s < 8; s++) {
      const f = PENTA[PHRASE[(s + bar * 3) % 8]];
      const st = t0 + s * (BEAT / 2);
      note(st, BEAT / 2 - 0.05, f, 0.11, (p) => square(p, 0.5), 0.008, 0.08);
      note(st + BEAT * 0.75, BEAT / 2 - 0.05, f, 0.045, (p) => square(p, 0.5), 0.008, 0.08); // echo
    }
  }
}

// master: gentle fade-in, fade-out over the last 2.5 s, soft-clip
const fadeIn = Math.floor(0.4 * SR);
const fadeOut = Math.floor(2.5 * SR);
for (let i = 0; i < N; i++) {
  let v = buf[i];
  if (i < fadeIn) v *= i / fadeIn;
  if (i > N - fadeOut) v *= (N - i) / fadeOut;
  buf[i] = Math.tanh(v * 1.4) * 0.85;
}

// 16-bit PCM WAV
const pcm = new Int16Array(N);
for (let i = 0; i < N; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(buf[i] * 32767)));
const data = new Uint8Array(pcm.buffer);
const header = new ArrayBuffer(44);
const dv = new DataView(header);
const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
w(0, "RIFF"); dv.setUint32(4, 36 + data.length, true); w(8, "WAVE");
w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
dv.setUint32(24, SR, true); dv.setUint32(28, SR * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
w(36, "data"); dv.setUint32(40, data.length, true);

const out = join(import.meta.dir, "..", "..", "..", "dist", "vapor", "promo", "music.wav");
await Bun.write(out, new Blob([header, data]));
console.log(`${out} (${DUR.toFixed(1)}s)`);
