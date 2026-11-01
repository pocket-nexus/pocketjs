// Read a PPSSPP DumpAudio recording of the demo and check it against the timeline in ../app.tsx:
// no sample lost in the tone's loop seam, one pitch per second in order through the scale's loop
// seam, no edge above the signal's own slope.
//   bun apps/game2d-pack-demo/verify/audio-check.ts <dump.wav> [music-volume]
import { readFileSync } from "node:fs";

const RATE = 44100;
const bytes = readFileSync(process.argv[2]!);
const volume = Number(process.argv[3] ?? 0.9);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
let offset = 12;
let dataStart = 0;
let dataBytes = 0;
while (offset + 8 <= bytes.length) {
  const id = bytes.toString("latin1", offset, offset + 4);
  const size = view.getUint32(offset + 4, true);
  if (id === "data") {
    dataStart = offset + 8;
    dataBytes = Math.min(size, bytes.length - dataStart);
    break;
  }
  offset += 8 + size + (size & 1);
}
const frames = Math.floor(dataBytes / 4);
const left = new Float64Array(frames);
for (let i = 0; i < frames; i++) left[i] = view.getInt16(dataStart + i * 4, true);

const rms = (from: number, to: number) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += left[i]! * left[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
};
const db = (v: number) => (v > 0 ? 20 * Math.log10(v / 32768) : -Infinity);
/** Amplitude and phase of `f` Hz over [from, to). */
function tone(f: number, from: number, to: number): { amp: number; phase: number } {
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i++) {
    const w = (2 * Math.PI * f * i) / RATE;
    re += left[i]! * Math.cos(w);
    im -= left[i]! * Math.sin(w);
  }
  const n = to - from;
  return { amp: (2 * Math.hypot(re, im)) / n, phase: Math.atan2(im, re) };
}
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

let start = 0;
while (start < frames && Math.abs(left[start]!) < 200) start++;
const at = (seconds: number) => Math.round(start + seconds * RATE);
console.log(`recording ${(frames / RATE).toFixed(2)} s, first sound at ${(start / RATE).toFixed(3)} s, overall ${db(rms(start, frames)).toFixed(1)} dBFS`);

let failed = false;
const check = (ok: boolean, line: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
  if (!ok) failed = true;
};

// ---- tone: 441 Hz, one phase from its start through the 10 s seam to the 15 s crossfade.
// The sound effects play from 4.0 s (frame 270) to about 5.3 s (the last, a 0.6 s chime).
const sfxFrom = 3.9;
const sfxTo = 5.6;
const reference = tone(441, at(1), at(3));
let worstPhase = 0;
let worstAmp = 0;
let worstAt = 0;
for (let t = 0.3; t < 14.8; t += 0.1) {
  if (t + 0.1 > sfxFrom && t < sfxTo) continue;
  const w = tone(441, at(t), at(t + 0.1));
  const phase = Math.abs(wrap(w.phase - reference.phase));
  if (phase > worstPhase) {
    worstPhase = phase;
    worstAt = t;
  }
  worstAmp = Math.max(worstAmp, Math.abs(w.amp - reference.amp) / reference.amp);
}
const driftFrames = (worstPhase / (2 * Math.PI)) * (RATE / 441);
check(driftFrames < 1, `tone phase holds across the 10 s loop seam: worst drift ${driftFrames.toFixed(3)} output frames (at ${worstAt.toFixed(1)} s), amplitude ${reference.amp.toFixed(0)} +/- ${(worstAmp * 100).toFixed(2)}%`);
const expectedAmp = 10000 * volume;
check(Math.abs(reference.amp - expectedAmp) / expectedAmp < 0.03, `tone amplitude ${reference.amp.toFixed(0)}, expected ${expectedAmp} (linear upsample loses a little)`);

// Sample-level residual around the seam: subtract the fitted sine, keep the largest leftover.
function residual(from: number, to: number, fit: { amp: number; phase: number }): number {
  let worst = 0;
  for (let i = from; i < to; i++) {
    const ideal = fit.amp * Math.cos((2 * Math.PI * 441 * i) / RATE + fit.phase);
    worst = Math.max(worst, Math.abs(left[i]! - ideal));
  }
  return worst;
}
const seamFit = tone(441, at(9), at(9.9));
const seam = residual(at(9.9), at(10.1), seamFit);
const away = residual(at(8), at(8.2), seamFit);
check(seam < away * 1.5 + 50, `seam residual at 10 s: ${seam.toFixed(0)} (same fit 2 s earlier: ${away.toFixed(0)}, of ${seamFit.amp.toFixed(0)})`);

/** Largest step between adjacent samples over [from, to), and where. */
function maxStep(from: number, to: number): { step: number; at: number } {
  let step = 0;
  let where = from;
  for (let i = from + 1; i < to; i++) {
    const d = Math.abs(left[i]! - left[i - 1]!);
    if (d > step) {
      step = d;
      where = i;
    }
  }
  return { step, at: where };
}
const toneSlope = ((2 * Math.PI * 441) / RATE) * expectedAmp;
for (const [from, to] of [[0.3, sfxFrom], [sfxTo, 14.8]] as const) {
  const m = maxStep(at(from), at(to));
  check(m.step < toneSlope * 1.3, `largest step ${from}..${to} s: ${m.step.toFixed(0)} (the sine's own slope is ${toneSlope.toFixed(0)})`);
}

// ---- crossfade: the tone leaves over 1 s from 15 s, the scale arrives on the same clock.
const before = tone(441, at(14.5), at(14.9)).amp;
const middle = tone(441, at(15.4), at(15.6)).amp;
const after = tone(441, at(16.2), at(16.6)).amp;
check(middle > before * 0.3 && middle < before * 0.7 && after < before * 0.02, `crossfade: tone ${before.toFixed(0)} -> ${middle.toFixed(0)} -> ${after.toFixed(0)}`);
const fadeStep = maxStep(at(14.9), at(16.2));
const peakSlope = ((2 * Math.PI * 330) / RATE) * 12000 * volume + toneSlope;
check(fadeStep.step < peakSlope * 1.3, `largest step through the crossfade: ${fadeStep.step.toFixed(0)} (both signals' slopes sum to ${peakSlope.toFixed(0)})`);

// ---- scale: 15 s + n seconds holds note n mod 60, in order, through the 60 s wrap at 75 s.
const noteHz = (note: number) => 220 * 2 ** (note / 15);
const scaleStart = 15;
const stopAt = (4890 - 30) / 60; // the 1 s fade-out starts here
let wrong: string[] = [];
let lastNote = 0;
for (let i = 1; scaleStart + i + 1 < stopAt; i++) {
  const from = at(scaleStart + i + 0.25);
  const to = at(scaleStart + i + 0.75);
  const note = i % 60;
  const want = tone(noteHz(note), from, to).amp;
  const total = rms(from, to) * Math.SQRT2;
  if (want < total * 0.9) wrong.push(`${i}: ${want.toFixed(0)}/${total.toFixed(0)}`);
  lastNote = i;
}
check(wrong.length === 0, `notes 1..${lastNote} at their own second (includes ${lastNote - 59} past the wrap): ${wrong.length} wrong${wrong.length ? " " + wrong.slice(0, 5).join(" ") : ""}`);

// Each note starts at phase 0, so its phase gives its start position to a fraction of a period: a
// lost or repeated sample anywhere shows as an offset from exact one-second spacing.
const notes: { i: number; period: number; start: number }[] = [];
for (let i = 2; scaleStart + i + 1 < stopAt; i++) {
  const f = noteHz(i % 60);
  // X = sum x[n] e^(-jwn) with x[n] = A sin(w(n - s)): phase(X) = -w s - pi/2.
  const { phase } = tone(f, at(scaleStart + i + 0.25), at(scaleStart + i + 0.75));
  notes.push({ i, period: RATE / f, start: ((-phase - Math.PI / 2) / (2 * Math.PI)) * (RATE / f) });
}
const noteOffset = (note: (typeof notes)[number], base: number) => {
  const raw = base + note.i * RATE - note.start;
  return Math.abs(raw - Math.round(raw / note.period) * note.period);
};
let bestBase = 0;
let bestWorst = Infinity;
for (let base = at(scaleStart) - 2000; base < at(scaleStart) + 6000; base += 0.25) {
  const worst = Math.max(...notes.map((note) => noteOffset(note, base)));
  if (worst < bestWorst) {
    bestWorst = worst;
    bestBase = base;
  }
}
check(bestWorst < 1, `note starts sit exactly one second apart through the wrap: worst offset ${bestWorst.toFixed(2)} output frames over ${notes.length} notes (scale starts ${((bestBase - at(scaleStart)) / RATE * 1000).toFixed(1)} ms after 15 s)`);

let worstRatio = 0;
let worstNote = 0;
for (let i = 2; scaleStart + i + 1 < stopAt; i++) {
  const note = i % 60;
  const m = maxStep(at(scaleStart + i - 0.1), at(scaleStart + i + 0.9));
  const slope = ((2 * Math.PI * Math.max(noteHz(note), noteHz((note + 59) % 60))) / RATE) * 12000 * volume;
  if (m.step / slope > worstRatio) {
    worstRatio = m.step / slope;
    worstNote = i;
  }
}
check(worstRatio < 1.2, `no edge in the scale: largest step is ${worstRatio.toFixed(2)} of the note's own slope (second ${worstNote})`);
const seamAt = Math.round(bestBase + 60 * RATE);
console.log(`     at the 60 s wrap (${(seamAt / RATE).toFixed(3)} s in the recording): ${db(rms(seamAt - 32, seamAt + 32)).toFixed(1)} dBFS at the seam, largest step within 5 ms ${maxStep(seamAt - 220, seamAt + 220).step.toFixed(0)}`);

// ---- stop: the fade ends in silence. The churn phase runs slow frames, so its clock is not 60 Hz;
// look at the recording's last second, and for the fade as a level that falls without a jump.
const tail = rms(frames - RATE, frames);
check(tail < 2, `silent at the end of the recording: ${db(tail).toFixed(1)} dBFS`);
let fadeEnd = frames - RATE;
while (fadeEnd > 0 && Math.abs(left[fadeEnd]!) < 2) fadeEnd--;
let fadeBegin = fadeEnd;
while (fadeBegin > 0 && rms(fadeBegin - 2205, fadeBegin) < 0.9 * rms(at(stopAt - 4), at(stopAt - 3))) fadeBegin -= 2205;
const lastStep = maxStep(fadeBegin, Math.min(frames, fadeEnd + 200));
check(lastStep.step < 2000, `fade-out: ${((fadeEnd - fadeBegin) / RATE).toFixed(2)} s from full level to silence at ${(fadeEnd / RATE).toFixed(2)} s, largest step ${lastStep.step.toFixed(0)}`);

process.exit(failed ? 1 : 0);
