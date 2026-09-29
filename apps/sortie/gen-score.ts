// apps/sortie/gen-score.ts — synthesizes the MV's soundtrack.
//
//   bun apps/sortie/gen-score.ts        # rewrites apps/sortie/media/sortie.wav
//
// An original score, generated from oscillators and envelopes in this file:
// no sample library, no downloaded audio, nothing anyone else holds a right
// in. Same architecture as apps/music/gen-assets.ts, scaled up to a whole
// arrangement — D minor, 150 BPM, 40.000 s, 22 050 Hz mono s16.
//
// The arrangement is written in BEATS, from ./timing.ts, which is also the
// grid ./app.tsx cuts the picture on. That is the entire synchronisation
// mechanism: a cut at beat 18 and the downbeat at beat 18 are the same number
// in the same file, so the image lands on the hit at 60 Hz without either side
// referring to the other.
//
// The output is committed because apps/sortie/pak.json splices it into the app
// pak: on a host that mounts the audio module the MV plays its own score off
// the device. tools/sortie.ts muxes the same file into the mp4.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BEAT_SECONDS, TOTAL_BEATS } from "./timing.ts";

const RATE = 22_050;
const SECONDS = TOTAL_BEATS * BEAT_SECONDS;
const SAMPLES = Math.round(RATE * SECONDS);
const SPB = RATE * BEAT_SECONDS; // samples per beat
const OUT = join(dirname(fileURLToPath(import.meta.url)), "media");

// ---------------------------------------------------------------------------
// Oscillators — all pure functions of the sample index
// ---------------------------------------------------------------------------

const fract = (x: number): number => x - Math.floor(x);
const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
const saw = (phase: number): number => 2 * fract(phase) - 1;
const tri = (phase: number): number => 1 - 4 * Math.abs(fract(phase) - 0.5);
const sine = (phase: number): number => Math.sin(2 * Math.PI * phase);
const square = (phase: number, duty = 0.5): number => (fract(phase) < duty ? 1 : -1);

/** xorshift noise — deterministic, seeded per voice so layers never correlate. */
function noise(index: number, seed: number): number {
  let v = (index ^ (seed * 0x9e37_79b1)) >>> 0;
  v ^= v << 13;
  v ^= v >>> 17;
  v ^= v << 5;
  return ((v >>> 0) / 0xffff_ffff) * 2 - 1;
}

/** Exponential decay, 1 -> 0 over `tau` seconds. */
const decay = (t: number, tau: number): number => Math.exp(-t / tau);
/** Attack/decay pair for anything that has to bite before it rings. */
const pluck = (t: number, attack: number, tau: number): number =>
  t < attack ? t / attack : decay(t - attack, tau);

// ---------------------------------------------------------------------------
// Voices — each writes into the mix buffer starting at a beat
// ---------------------------------------------------------------------------

const mix = new Float32Array(SAMPLES);

function add(startBeat: number, lengthBeats: number, gain: number, voice: (t: number, i: number) => number): void {
  const from = Math.round(startBeat * SPB);
  const to = Math.min(SAMPLES, from + Math.round(lengthBeats * SPB));
  for (let i = Math.max(0, from); i < to; i++) {
    mix[i] += gain * voice((i - from) / RATE, i - from);
  }
}

/**
 * The brass stab: three saws detuned by a few cents, lowpassed by a one-pole
 * that opens with the envelope. Detuning is what makes seven oscillators sound
 * like a section instead of a synthesizer.
 */
function brass(midi: number, tau: number) {
  const f = hz(midi) / RATE;
  let lp = 0;
  return (t: number, i: number): number => {
    const env = pluck(t, 0.012, tau);
    const raw = (saw(i * f) + saw(i * f * 1.004 + 0.31) + saw(i * f * 0.995 + 0.73)) / 3;
    lp += (raw - lp) * (0.08 + 0.5 * env);
    return lp * env;
  };
}

/** Choir-ish pad: detuned triangles with a slow vibrato, soft attack. */
function pad(midi: number, beats: number) {
  const f = hz(midi) / RATE;
  const total = beats * BEAT_SECONDS;
  return (t: number, i: number): number => {
    const env = Math.min(1, t / 0.35) * Math.min(1, Math.max(0, (total - t) / 0.5));
    const vib = 1 + 0.0016 * sine(t * 4.5);
    return env * ((tri(i * f * vib) + tri(i * f * 1.0031) + tri(i * f * 0.9968 + 0.5)) / 3);
  };
}

/** Bass: square through a fixed lowpass — the floor the whole thing sits on. */
function bass(midi: number, tau: number) {
  const f = hz(midi) / RATE;
  let lp = 0;
  return (t: number, i: number): number => {
    const env = pluck(t, 0.006, tau);
    lp += (square(i * f, 0.42) - lp) * 0.12;
    return lp * env;
  };
}

/** Kick: a sine whose pitch falls 140 Hz -> 46 Hz in 60 ms. */
function kick(t: number, i: number): number {
  const f = 46 + 94 * decay(t, 0.03);
  return sine((i * f) / RATE) * decay(t, 0.16);
}

/** Timpani: lower, longer, with a noise transient on the head. */
function timpani(midi: number) {
  const f = hz(midi);
  return (t: number, i: number): number =>
    sine((i * (f + f * 0.7 * decay(t, 0.02))) / RATE) * decay(t, 0.5) +
    noise(i, 7) * decay(t, 0.012) * 0.4;
}

function snare(t: number, i: number): number {
  return (noise(i, 11) * 0.8 + sine((i * 190) / RATE) * 0.4) * decay(t, 0.13);
}

function hat(t: number, i: number): number {
  // Difference of two noise taps = a crude highpass; cheap and dry enough.
  return (noise(i, 23) - noise(i - 1, 23)) * decay(t, 0.022) * 0.5;
}

function crash(t: number, i: number): number {
  return (noise(i, 31) - noise(i - 1, 31) * 0.7) * decay(t, 1.1);
}

/** Riser: noise and a rising sine, both swelling into the hit. */
function riser(beats: number) {
  const total = beats * BEAT_SECONDS;
  return (t: number, i: number): number => {
    const k = t / total;
    return (noise(i, 41) * 0.5 + sine((i * (180 + 900 * k * k)) / RATE) * 0.5) * k * k;
  };
}

/** Alarm: a two-tone siren, the one moment the drums stop. */
function siren(t: number, i: number): number {
  const f = 520 + 180 * square(t * 3.75, 0.5);
  return (square((i * f) / RATE, 0.5) * 0.5 + sine((i * f) / RATE) * 0.5) * Math.min(1, t / 0.05);
}

function bell(midi: number) {
  const f = hz(midi) / RATE;
  return (t: number, i: number): number =>
    (sine(i * f) * decay(t, 1.6) + sine(i * f * 2.76) * decay(t, 0.7) * 0.4) * Math.min(1, t / 0.004);
}

// ---------------------------------------------------------------------------
// The arrangement — beat numbers are ./app.tsx cut boundaries
// ---------------------------------------------------------------------------

// i - VI - III - VII in D minor, one chord per bar.
const ROOTS = [50, 46, 41, 48]; // D2 Bb1 F1 C2
const chordAt = (beat: number): number => ROOTS[Math.floor(beat / 4) % ROOTS.length];

// The riff: two bars of eighths, martial, always landing on the downbeat.
const RIFF: readonly (number | 0)[] = [
  62, 0, 62, 0, 65, 69, 0, 65, // bar 1
  62, 0, 62, 0, 60, 65, 0, 62, // bar 2
];

/** Drone and ticks: 0..9 — the HUD boots.
 *  One continuous drone rather than a retriggered pad: the room is already
 *  running when the MV starts, and the first kick arrives into something. */
add(0, 10, 0.2, pad(38, 10));
add(0, 10, 0.13, pad(45, 10));
add(0, 10, 0.05, (t, i) => noise(i, 3) * Math.min(1, t / 1.5) * 0.5);
for (let b = 0; b < 10; b++) {
  add(b + 0.5, 0.25, 0.12, hat);
  if (b % 2 === 0) add(b, 0.6, 0.3, kick);
  if (b >= 4) add(b + 0.5, 0.5, 0.12, bass(38, 0.18));
}
add(6, 4, 0.16, riser(4));

/** Countdown: 10..17 — one timpani per beat, the riser tightening. */
for (let b = 10; b < 18; b++) {
  add(b, 1, 0.5, timpani(41));
  add(b, 0.6, 0.3, kick);
  if (b >= 14) add(b + 0.5, 0.25, 0.16, hat);
  add(b, 1, 0.08, pad(38, 1.05));
}
add(14, 4, 0.22, riser(4));
add(18, 4, 0.5, crash);

/** Title: 18..25 — the theme arrives with the card. */
for (let b = 18; b < 26; b++) {
  const step = (b - 18) * 2;
  add(b, 0.9, 0.34, kick);
  if (b % 2 === 1) add(b, 0.6, 0.2, snare);
  add(b, 2, 0.16, pad(chordAt(b) + 12, 2));
  add(b, 2, 0.12, pad(chordAt(b) + 19, 2));
  add(b, 0.9, 0.3, bass(chordAt(b), 0.4));
  for (const half of [0, 1]) {
    const note = RIFF[(step + half) % RIFF.length];
    if (note) add(b + half * 0.5, 0.5, 0.2, brass(note, 0.18));
  }
}

/** Negations: 26..35 — a stab on every cut, nothing between them. */
for (let b = 26; b < 36; b++) {
  add(b, 0.5, 0.42, kick);
  add(b, 0.45, 0.26, brass(chordAt(b) + 12, 0.1));
  add(b, 0.45, 0.2, brass(chordAt(b) + 19, 0.1));
  add(b, 0.5, 0.26, bass(chordAt(b), 0.18));
  if (b % 2 === 1) add(b + 0.5, 0.3, 0.18, snare);
}

/** ＤＯＭ、不在: 36..39 — one held chord under the card. */
add(36, 4, 0.2, pad(50, 4));
add(36, 4, 0.15, pad(57, 4));
add(36, 4, 0.12, pad(62, 4));
add(36, 2, 0.45, timpani(38));
add(38, 2, 0.3, timpani(38));

/** The stack: 40..47 — the groove, four slabs, four beats each. */
for (let b = 40; b < 48; b++) {
  const step = (b - 40) * 2;
  add(b, 0.9, 0.36, kick);
  add(b + 0.5, 0.25, 0.14, hat);
  if (b % 2 === 1) add(b, 0.6, 0.24, snare);
  add(b, 1, 0.3, bass(chordAt(b), 0.35));
  add(b, 2, 0.14, pad(chordAt(b) + 12, 2));
  for (const half of [0, 1]) {
    const note = RIFF[(step + half) % RIFF.length];
    if (note) add(b + half * 0.5, 0.5, 0.22, brass(note + 12, 0.16));
  }
}

/** Two cards: 48..55 — half time, the pad carries it. */
for (let b = 48; b < 56; b += 2) {
  add(b, 2, 0.5, timpani(38));
  add(b, 2, 0.2, pad(chordAt(b) + 12, 2));
  add(b, 2, 0.15, pad(chordAt(b) + 17, 2));
  add(b, 1, 0.24, bass(chordAt(b), 0.5));
}

/** Sync: 56..63 — sixteenth arpeggio, the gauge climbing. */
const ARP = [62, 65, 69, 74, 69, 65];
for (let b = 56; b < 64; b++) {
  add(b, 0.9, 0.34, kick);
  if (b % 2 === 1) add(b, 0.6, 0.22, snare);
  add(b, 1, 0.28, bass(chordAt(b), 0.3));
  for (let s = 0; s < 4; s++) {
    const note = ARP[(((b - 56) * 4 + s) % ARP.length + ARP.length) % ARP.length];
    add(b + s * 0.25, 0.25, 0.16, brass(note + 12, 0.07));
  }
  add(b, 2, 0.13, pad(chordAt(b) + 24, 2));
}

/** 同期率、六十: 64..69 — the arpeggio thins, the pad swells. */
for (let b = 64; b < 70; b++) {
  add(b, 0.8, 0.3, kick);
  add(b, 2, 0.18, pad(chordAt(b) + 12, 2));
  add(b, 2, 0.14, pad(chordAt(b) + 19, 2));
  if (b >= 67) add(b, 1, 0.3, timpani(38));
}
add(67, 3, 0.25, riser(3));

/** 警告: 70..71 — everything stops but the siren. */
add(70, 2, 0.3, siren);
add(70, 0.5, 0.45, crash);

/** The fleet: 72..83 — one hammer per machine. */
for (let b = 72; b < 84; b++) {
  add(b, 0.55, 0.45, kick);
  add(b, 0.5, 0.3, brass(chordAt(b) + 12, 0.1));
  add(b, 0.5, 0.22, brass(chordAt(b) + 24, 0.1));
  add(b, 0.6, 0.3, bass(chordAt(b), 0.22));
  add(b + 0.5, 0.3, 0.2, snare);
  add(b + 0.75, 0.25, 0.12, hat);
}

/** 全機、発進: 84..87 — the peak. */
add(84, 1, 0.6, crash);
for (let b = 84; b < 88; b++) {
  const step = (b - 84) * 2;
  add(b, 0.9, 0.42, kick);
  add(b, 0.6, 0.26, snare);
  add(b, 1, 0.34, bass(chordAt(b) - 12, 0.35));
  add(b, 4, 0.18, pad(chordAt(b) + 12, 4));
  for (const half of [0, 1]) {
    const note = RIFF[(step + half) % RIFF.length];
    if (note) add(b + half * 0.5, 0.5, 0.26, brass(note + 12, 0.18));
  }
}

/** The end card: 88..99 — one last statement, then the room. */
for (let b = 88; b < 96; b++) {
  const step = (b - 88) * 2;
  add(b, 0.9, 0.3, kick);
  if (b % 2 === 1) add(b, 0.6, 0.2, snare);
  add(b, 1, 0.26, bass(50, 0.4));
  add(b, 2, 0.16, pad(62, 2));
  for (const half of [0, 1]) {
    const note = RIFF[(step + half) % RIFF.length];
    if (note) add(b + half * 0.5, 0.5, 0.18, brass(note, 0.18));
  }
}
add(95, 1, 0.5, crash);
add(96, 4, 0.3, pad(50, 4));
add(96, 4, 0.22, pad(62, 4));
add(96, 4, 0.18, pad(69, 4));
add(96, 4, 0.3, bell(74));
add(97.5, 2.5, 0.2, bell(81));

// ---------------------------------------------------------------------------
// Master: a short slap delay for depth, soft clip, fade out on the last beat
// ---------------------------------------------------------------------------

const DELAY = Math.round(SPB * 0.375); // a dotted eighth behind the beat
for (let i = DELAY; i < SAMPLES; i++) mix[i] += mix[i - DELAY] * 0.16;

const FADE = Math.round(SPB * 2);
const pcm = new Int16Array(SAMPLES);
let peak = 0;
for (let i = 0; i < SAMPLES; i++) peak = Math.max(peak, Math.abs(mix[i]));
const norm = 0.92 / peak;
for (let i = 0; i < SAMPLES; i++) {
  const fade = i > SAMPLES - FADE ? (SAMPLES - i) / FADE : 1;
  // tanh-shaped soft clip: keeps the stabs from squaring off on the peaks
  const v = Math.tanh(mix[i] * norm * 1.25) * 0.85 * fade;
  pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
}

// ---------------------------------------------------------------------------

const header = new DataView(new ArrayBuffer(44));
const ascii = (offset: number, text: string) => {
  for (let i = 0; i < text.length; i++) header.setUint8(offset + i, text.charCodeAt(i));
};
ascii(0, "RIFF");
header.setUint32(4, 36 + pcm.byteLength, true);
ascii(8, "WAVEfmt ");
header.setUint32(16, 16, true);
header.setUint16(20, 1, true); // PCM
header.setUint16(22, 1, true); // mono
header.setUint32(24, RATE, true);
header.setUint32(28, RATE * 2, true);
header.setUint16(32, 2, true);
header.setUint16(34, 16, true);
ascii(36, "data");
header.setUint32(40, pcm.byteLength, true);

const wav = new Uint8Array(44 + pcm.byteLength);
wav.set(new Uint8Array(header.buffer), 0);
wav.set(new Uint8Array(pcm.buffer), 44);
mkdirSync(OUT, { recursive: true });
await Bun.write(join(OUT, "sortie.wav"), wav);
console.log(
  `sortie: media/sortie.wav ${SECONDS.toFixed(3)} s, ${RATE} Hz mono, ` +
    `${SAMPLES} samples, ${(wav.length / 1024).toFixed(0)} KiB`,
);
