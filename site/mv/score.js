// site/mv/score.js — "A Sky in Your Pocket", the score for the PocketJS film.
//
// One original instrumental, written out as note data and synthesized sample by
// sample in plain JavaScript. No Web Audio nodes and no DOM, so the browser
// player (site/mv/player.js) and the offline renderer (tools/render-mv.ts) call
// renderSong() and get the identical buffer: the video's audio track and the
// audio the page plays are the same numbers.
//
// 176 BPM, 4/4, 56 bars — intro 8, verse 16, pre-chorus 8, chorus 16, outro 8.
// film.js reads BAR/SECTIONS from here, so a bar added to the song moves the
// picture with it.

export const BPM = 176;
export const SPB = 60 / BPM; // seconds per beat
export const BAR = 4 * SPB; // seconds per bar
export const BARS = 56;
export const DURATION = BARS * BAR;
export const TAIL = 2.6; // reverb runs past the last note

export const SECTIONS = {
  intro: { from: 0, to: 8 },
  verse1: { from: 8, to: 16 },
  verse2: { from: 16, to: 24 },
  pre: { from: 24, to: 32 },
  chorus: { from: 32, to: 48 },
  outro: { from: 48, to: 56 },
};

// ---------------------------------------------------------------- harmony

const CHORDS = {
  Am: { bass: 45, tones: [57, 60, 64], top: [64, 69, 72] },
  F: { bass: 41, tones: [53, 57, 60], top: [65, 69, 72] },
  C: { bass: 48, tones: [52, 55, 60], top: [64, 67, 72] },
  G: { bass: 43, tones: [55, 59, 62], top: [62, 67, 71] },
  Em: { bass: 40, tones: [52, 55, 59], top: [64, 67, 71] },
};

/** One chord per bar. The film's cuts land on this grid. */
export const BAR_CHORDS = [
  "Am", "Am", "F", "F", "C", "C", "G", "G",
  "Am", "F", "C", "G", "Am", "F", "C", "G",
  "Am", "F", "C", "G", "F", "G", "Em", "Am",
  "F", "G", "Em", "Am", "F", "G", "G", "G",
  "F", "G", "Em", "Am", "F", "G", "C", "C",
  "F", "G", "Em", "Am", "F", "G", "C", "G",
  "Am", "F", "C", "G", "Am", "F", "C", "C",
];

// ---------------------------------------------------------------- notation

const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

function midi(name) {
  const m = /^([a-g])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note: ${name}`);
  return 12 * (Number(m[3]) + 1) + PC[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}

// A melody is one string per bar, tokens on a fixed grid: a note name starts a
// note, `~` holds the one before it, `-` is a rest. Eight tokens to the bar is
// an eighth-note grid; sixteen is sixteenths.
function melody(startBar, bars, gain = 1) {
  const out = [];
  bars.forEach((line, i) => {
    const tokens = line.trim().split(/\s+/);
    const step = 4 / tokens.length;
    tokens.forEach((tok, j) => {
      const beat = (startBar + i) * 4 + j * step;
      if (tok === "~") {
        if (out.length) out[out.length - 1].dur += step;
        return;
      }
      if (tok === "-") return;
      out.push({ beat, dur: step, note: midi(tok), gain });
    });
  });
  return out;
}

// ---------------------------------------------------------------- the tune

// Verse — the question, stepping around the A minor triad and never settling.
const VERSE_LEAD = melody(8, [
  "-  -  e4 g4 a4 ~  b4 ~",
  "c5 ~  b4 a4 g4 ~  -  -",
  "-  e4 g4 c5 b4 ~  g4 ~",
  "a4 ~  g4 e4 d4 ~  ~  -",
  "-  -  e4 g4 a4 ~  c5 ~",
  "d5 ~  c5 a4 g4 ~  -  -",
  "-  g4 a4 c5 d5 ~  e5 ~",
  "d5 ~  b4 g4 a4 ~  ~  ~",
]).concat(
  melody(16, [
    "e5 ~  d5 c5 b4 ~  a4 ~",
    "-  a4 c5 d5 c5 ~  a4 ~",
    "g4 ~  e4 g4 c5 ~  b4 ~",
    "d5 ~  d5 b4 g4 ~  -  -",
    "-  f4 a4 c5 f5 ~  e5 ~",
    "d5 ~  b4 d5 g5 ~  ~  -",
    "-  e5 d5 b4 g4 ~  b4 ~",
    "a4 ~  ~  ~  -  -  -  -",
  ]),
);

// Pre-chorus — the same shape climbing a step at a time, then clearing out for
// the snare roll in bar 31.
const PRE_LEAD = melody(24, [
  "-  f4 g4 a4 c5 ~  a4 ~",
  "b4 ~  a4 b4 d5 ~  b4 ~",
  "-  g4 a4 b4 e5 ~  d5 ~",
  "c5 ~  b4 a4 e4 ~  -  -",
  "-  a4 c5 f5 e5 ~  c5 ~",
  "-  b4 d5 g5 f5 ~  d5 ~",
  "e5 ~  d5 b4 g4 ~  a4 ~",
  "-  -  -  -  -  -  -  -",
]);

// Chorus — wide leaps, long landings.
const CHORUS_LEAD = melody(32, [
  "-  c5 f5 ~  e5 ~  c5 ~",
  "d5 ~  b4 ~  d5 ~  g5 ~",
  "-  e5 g5 ~  e5 ~  b4 ~",
  "c5 ~  a4 ~  e5 ~  ~  -",
  "-  f5 e5 c5 a4 ~  c5 ~",
  "d5 ~  d5 b4 g4 ~  b4 ~",
  "c5 ~  e5 g5 ~  ~  e5 ~",
  "d5 ~  c5 ~  ~  -  -  -",
  "-  c5 f5 ~  a5 ~  g5 ~",
  "f5 ~  d5 ~  b4 ~  d5 ~",
  "-  e5 g5 b5 ~  a5 g5 ~",
  "e5 ~  ~  c5 a4 ~  ~  -",
  "-  a4 c5 f5 g5 ~  a5 ~",
  "g5 ~  f5 d5 b4 ~  d5 ~",
  "e5 ~  g5 ~  c6 ~  ~  ~",
  "b5 ~  ~  ~  ~  -  -  -",
]);

// Outro — the melody put down one phrase at a time.
const OUTRO_LEAD = melody(48, [
  "-  -  e4 g4 a4 ~  ~  -",
  "-  c5 a4 g4 f4 ~  ~  -",
  "-  e4 g4 c5 ~  ~  -  -",
  "d5 ~  b4 g4 ~  ~  -  -",
  "-  -  a4 ~  e4 ~  -  -",
  "-  -  f4 ~  c5 ~  -  -",
  "c5 ~  ~  ~  ~  ~  ~  ~",
  "-  -  -  -  -  -  -  -",
]);

/** The sung line, for the lyric timing in lyrics.js and the picture in film.js. */
export const LEAD = [...VERSE_LEAD, ...PRE_LEAD, ...CHORUS_LEAD, ...OUTRO_LEAD];

// ---------------------------------------------------------------- drums

// Sixteen steps to the bar. `x` hit, `X` accent, `o` open hat, `.` rest.
const KITS = {
  silent: { k: "................", s: "................", h: "................" },
  pulse: { k: "................", s: "................", h: "x.......x......." },
  soft: { k: "X.......x.......", s: "................", h: "x.x.x.x.x.x.x.x." },
  verse: { k: "X.....x.x.......", s: "....X.......x...", h: "x.x.x.x.x.x.x.o." },
  pre: { k: "X..x..x.x.....x.", s: "....X.......X...", h: "xxxxxxxxxxxxxxxx" },
  drive: { k: "X..x..x.X..x..x.", s: "....X...x...X...", h: "XxxxXxxxXxxxXxxo" },
  half: { k: "X.......x.....x.", s: "....X.......X...", h: "x.x.x.x.x.x.x.x." },
};

const BAR_KITS = [
  "silent", "silent", "pulse", "pulse", "soft", "soft", "soft", "verse",
  "verse", "verse", "verse", "verse", "verse", "verse", "verse", "verse",
  "verse", "verse", "verse", "verse", "verse", "verse", "verse", "verse",
  "pre", "pre", "pre", "pre", "pre", "pre", "pre", "roll",
  "drive", "drive", "drive", "drive", "drive", "drive", "drive", "drive",
  "drive", "drive", "drive", "drive", "drive", "drive", "drive", "drive",
  "half", "half", "half", "half", "soft", "soft", "pulse", "silent",
];

function drumEvents() {
  const out = [];
  const hit = (beat, inst, gain, dur = 0.25) => out.push({ beat, dur, inst, gain, note: 0 });
  for (let b = 0; b < BARS; b++) {
    const kit = BAR_KITS[b];
    if (kit === "roll") {
      // Bar 31: a sixteenth-note snare roll that walks up into the chorus.
      for (let i = 0; i < 16; i++) hit(b * 4 + i * 0.25, "snare", 0.18 + (i / 15) * 0.7);
      hit(b * 4, "kick", 1);
      continue;
    }
    const pat = KITS[kit];
    for (let i = 0; i < 16; i++) {
      const beat = b * 4 + i * 0.25;
      if (pat.k[i] !== ".") hit(beat, "kick", pat.k[i] === "X" ? 1 : 0.78);
      if (pat.s[i] !== ".") hit(beat, "snare", pat.s[i] === "X" ? 0.92 : 0.36);
      const h = pat.h[i];
      if (h === "o") hit(beat, "openhat", 0.5, 0.5);
      else if (h !== ".") hit(beat, "hat", h === "X" ? 0.5 : 0.3);
    }
  }
  // Cymbals mark the section doors.
  for (const b of [8, 24, 32, 40, 48]) out.push({ beat: b * 4, dur: 2, inst: "crash", gain: b === 32 ? 1 : 0.6, note: 0 });
  return out;
}

// ---------------------------------------------------------------- arrangement

function arrangement() {
  const events = [];
  const add = (inst, beat, dur, note, gain = 1, pan = 0) =>
    events.push({ inst, beat, dur, note, gain, pan });

  for (let b = 0; b < BARS; b++) {
    const chord = CHORDS[BAR_CHORDS[b]];
    const beat0 = b * 4;
    const inIntro = b < 8;
    const inVerse = b >= 8 && b < 24;
    const inPre = b >= 24 && b < 32;
    const inChorus = b >= 32 && b < 48;
    const inOutro = b >= 48;

    // Bass — whole notes under the intro, eighths once the drums arrive, and
    // an octave push through the chorus.
    if (inIntro) {
      if (b >= 4) add("bass", beat0, 3.9, chord.bass, 0.8);
    } else if (inOutro) {
      add("bass", beat0, b < 54 ? 3.9 : 7.8, chord.bass, 0.75);
    } else {
      const push = inChorus ? [0, 0, 12, 0, 0, 0, 12, 0] : [0, 0, 0, 0, 0, 0, 12, 0];
      for (let i = 0; i < 8; i++) {
        add("bass", beat0 + i * 0.5, 0.45, chord.bass + push[i], i % 2 === 0 ? 0.95 : 0.6);
      }
    }

    // Piano — the one voice that plays in every bar of the song.
    if (inIntro || inOutro) {
      const arp = [...chord.tones, ...chord.top];
      for (let i = 0; i < 8; i++) {
        const n = arp[i % arp.length] + (i >= 5 ? 12 : 0);
        add("piano", beat0 + i * 0.5, 1.2, n, 0.5 - (i % 2) * 0.14, i % 2 ? 0.2 : -0.2);
      }
    } else {
      for (const n of chord.tones) add("piano", beat0, 2.4, n, 0.42, -0.15);
      for (const n of chord.tones) add("piano", beat0 + 2, 1.9, n + 12, 0.3, 0.15);
      if (inChorus) for (let i = 0; i < 8; i++) add("piano", beat0 + i * 0.5, 0.6, chord.top[i % 3] + 12, 0.22, 0.3);
    }

    // Pad — the sky behind everything, from the pre-chorus on.
    if (inPre || inChorus) {
      const swell = inPre ? 0.2 + ((b - 24) / 8) * 0.25 : 0.5;
      for (const n of chord.tones) add("pad", beat0, 4, n + 12, swell);
    }

    // Chip arpeggio — the handheld's own voice, sixteenths, hard left, and it
    // never stops once it starts.
    if (b >= 2) {
      const arp = [...chord.tones, chord.tones[1] + 12, chord.top[2], chord.tones[1] + 12];
      const level = inIntro ? 0.2 : inVerse ? 0.3 : inPre ? 0.36 : inChorus ? 0.44 : 0.24;
      for (let i = 0; i < 16; i++) {
        const up = inChorus && i % 8 >= 4 ? 12 : 0;
        add("chip", beat0 + i * 0.25, 0.22, arp[i % arp.length] + up, level * (i % 4 === 0 ? 1 : 0.68), -0.55);
      }
    }
  }

  // Lead — the melody, with two echoes a dotted eighth apart.
  const leadLevel = (beat) => (beat < 32 * 4 ? 0.62 : beat < 48 * 4 ? 0.78 : 0.5);
  for (const n of LEAD) {
    add("lead", n.beat, n.dur, n.note, leadLevel(n.beat), 0.08);
    add("lead", n.beat + 0.75, n.dur, n.note, leadLevel(n.beat) * 0.3, -0.5);
    add("lead", n.beat + 1.5, n.dur, n.note, leadLevel(n.beat) * 0.13, 0.5);
  }
  // The chorus melody doubled an octave up on the chip voice, so the hook reads
  // as something a handheld could play.
  for (const n of CHORUS_LEAD) add("chip", n.beat, Math.min(n.dur, 0.5), n.note + 12, 0.3, 0.45);

  for (const d of drumEvents()) add(d.inst, d.beat, d.dur, d.note, d.gain, 0);
  return events;
}

// ---------------------------------------------------------------- synthesis

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// PolyBLEP: rounds the discontinuity of a saw or square so the high notes in
// the chorus do not alias into gravel.
function blep(t, dt) {
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
}

function envelope(t, len, a, d, s, r) {
  if (t < a) return t / a;
  if (t < a + d) return 1 + (s - 1) * ((t - a) / d);
  if (t < len) return s;
  const u = (t - len) / r;
  return u >= 1 ? -1 : s * (1 - u) * (1 - u);
}

/** Deterministic noise — the drums must be identical in every render. */
function noiseSource(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return (x / 0x7fffffff) - 1;
  };
}

const VOICES = {
  // Struck string: a few partials, each dying faster than the one below it.
  piano(write, e, sr) {
    const f = mtof(e.note);
    const len = Math.min(e.dur, 2.6);
    const n = Math.ceil((len + 0.9) * sr);
    const parts = [1, 2, 3.01, 4.04, 5.9];
    const amps = [1, 0.46, 0.22, 0.11, 0.05];
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const decay = Math.exp(-t * 3.2);
      if (decay < 1e-4) break;
      const amp = decay * (1 - Math.exp(-t * 700)); // 1.4 ms of attack, not a click
      let s = 0;
      for (let p = 0; p < parts.length; p++) {
        s += amps[p] * Math.sin(2 * Math.PI * f * parts[p] * t) * Math.exp(-t * (1.1 + p * 1.6));
      }
      write(i, s * amp * 0.17 * e.gain, 0.5);
    }
  },

  // Three detuned saws under a falling filter: the voice that carries the hook.
  lead(write, e, sr) {
    const f = mtof(e.note);
    const len = Math.max(e.dur, 0.12);
    const rel = 0.22;
    const n = Math.ceil((len + rel + 0.02) * sr);
    const det = [-0.0045, 0, 0.0052];
    const ph = [0.11, 0.37, 0.72];
    let lp = 0, bp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const a = envelope(t, len, 0.008, 0.16, 0.72, rel);
      if (a < 0) break;
      const vib = t > 0.16 ? 1 + 0.006 * Math.sin(2 * Math.PI * 5.4 * (t - 0.16)) : 1;
      let s = 0;
      for (let v = 0; v < 3; v++) {
        const fv = f * (1 + det[v]) * vib;
        const dt = fv / sr;
        ph[v] += dt;
        if (ph[v] >= 1) ph[v] -= 1;
        s += (2 * ph[v] - 1 - blep(ph[v], dt)) * 0.33;
      }
      // State-variable lowpass, cutoff sweeping down with the envelope. The
      // Chamberlin form only stays stable while the normalized cutoff is under
      // about a sixth of the rate; past that it self-oscillates into NaN, so
      // the clamp is the filter's limit and not a tone choice. At 44.1/48 kHz
      // the sweep tops out near 0.08 and never reaches it.
      const cut = Math.min(0.16, (1100 + 2600 * Math.max(a, 0)) / sr);
      const fc = 2 * Math.sin(Math.PI * cut);
      lp += fc * bp;
      bp += fc * (s - lp - 0.9 * bp);
      write(i, lp * a * 0.2 * e.gain, 0.34);
    }
  },

  // Square wave, quarter duty, one frame of pitch drop at the attack.
  chip(write, e, sr) {
    const f = mtof(e.note);
    const len = Math.max(e.dur, 0.06);
    const n = Math.ceil((len + 0.05) * sr);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const a = envelope(t, len, 0.001, 0.07, 0.42, 0.05);
      if (a < 0) break;
      const fv = f * (t < 0.012 ? 1 + (0.012 - t) * 3 : 1);
      const dt = fv / sr;
      ph += dt;
      if (ph >= 1) ph -= 1;
      const duty = 0.25;
      const s = (ph < duty ? 1 : -1) + blep(ph, dt) - blep((ph + 1 - duty) % 1, dt);
      write(i, s * a * 0.1 * e.gain, 0.12);
    }
  },

  // Sine sub plus a filtered saw, so it survives a phone speaker.
  bass(write, e, sr) {
    const f = mtof(e.note);
    const len = Math.max(e.dur, 0.1);
    const n = Math.ceil((len + 0.09) * sr);
    let ph = 0, lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const a = envelope(t, len, 0.005, 0.09, 0.8, 0.08);
      if (a < 0) break;
      const dt = f / sr;
      ph += dt;
      if (ph >= 1) ph -= 1;
      const saw = 2 * ph - 1 - blep(ph, dt);
      lp += (saw - lp) * Math.min(1, (420 * 2 * Math.PI) / sr);
      write(i, (Math.sin(2 * Math.PI * ph) * 0.8 + lp * 0.55) * a * 0.22 * e.gain, 0.1);
    }
  },

  // Slow triangles, wide, the only voice with a long attack.
  pad(write, e, sr) {
    const f = mtof(e.note);
    const len = Math.max(e.dur, 0.5);
    const n = Math.ceil((len + 0.8) * sr);
    const det = [-0.008, -0.002, 0.003, 0.009];
    const ph = [0.2, 0.45, 0.63, 0.91];
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const a = envelope(t, len, 0.32, 0.4, 0.8, 0.75);
      if (a < 0) break;
      let s = 0;
      for (let v = 0; v < 4; v++) {
        ph[v] += (f * (1 + det[v])) / sr;
        if (ph[v] >= 1) ph[v] -= 1;
        s += (2 * Math.abs(2 * ph[v] - 1) - 1) * 0.25;
      }
      write(i, s * a * 0.075 * e.gain, 0.5);
    }
  },

  kick(write, e, sr) {
    const n = Math.ceil(0.34 * sr);
    let ph = 0;
    const rnd = noiseSource(0x9e37 + Math.round(e.beat * 97));
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = 46 + 116 * Math.exp(-t * 52);
      ph += f / sr;
      const body = Math.sin(2 * Math.PI * ph) * Math.exp(-t * 9.5);
      const click = t < 0.006 ? rnd() * (1 - t / 0.006) * 0.5 : 0;
      write(i, (body + click) * 0.62 * e.gain, 0.02);
    }
  },

  snare(write, e, sr) {
    const n = Math.ceil(0.2 * sr);
    const rnd = noiseSource(0x51ed + Math.round(e.beat * 131));
    let hp = 0, prev = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const raw = rnd();
      hp = 0.86 * (hp + raw - prev);
      prev = raw;
      const noise = hp * Math.exp(-t * 26);
      const tone = (Math.sin(2 * Math.PI * 188 * t) + Math.sin(2 * Math.PI * 247 * t)) * 0.4 * Math.exp(-t * 42);
      write(i, (noise * 0.75 + tone) * 0.32 * e.gain, 0.22);
    }
  },

  hat(write, e, sr) {
    const n = Math.ceil(0.06 * sr);
    const rnd = noiseSource(0x2f1a + Math.round(e.beat * 211));
    let hp = 0, prev = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const raw = rnd();
      hp = 0.94 * (hp + raw - prev);
      prev = raw;
      write(i, hp * Math.exp(-t * 95) * 0.15 * e.gain, 0.05);
    }
  },

  openhat(write, e, sr) {
    const n = Math.ceil(0.3 * sr);
    const rnd = noiseSource(0x71c3 + Math.round(e.beat * 173));
    let hp = 0, prev = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const raw = rnd();
      hp = 0.93 * (hp + raw - prev);
      prev = raw;
      write(i, hp * Math.exp(-t * 11) * 0.12 * e.gain, 0.1);
    }
  },

  crash(write, e, sr) {
    const n = Math.ceil(2.1 * sr);
    const rnd = noiseSource(0x1d0f + Math.round(e.beat * 59));
    let hp = 0, prev = 0, lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const raw = rnd();
      hp = 0.9 * (hp + raw - prev);
      prev = raw;
      lp += (hp - lp) * 0.6;
      write(i, lp * Math.exp(-t * 2.4) * 0.12 * e.gain, 0.42);
    }
  },
};

// Schroeder reverb: four combs into two allpasses, fed from the per-voice send.
function reverb(sendL, sendR, sr) {
  const scale = sr / 44100;
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => ({
    buf: new Float32Array(Math.round(d * scale)),
    i: 0,
    lp: 0,
  }));
  const allpass = [556, 441, 341, 225].map((d) => ({ buf: new Float32Array(Math.round(d * scale)), i: 0 }));
  const run = (input, offset) => {
    const out = new Float32Array(input.length);
    for (const c of combs) { c.buf.fill(0); c.i = 0; c.lp = 0; }
    for (const a of allpass) { a.buf.fill(0); a.i = 0; }
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      let s = 0;
      for (let c = offset; c < combs.length; c += 2) {
        const comb = combs[c];
        const y = comb.buf[comb.i];
        comb.lp += (y - comb.lp) * 0.34; // damping: the tail loses its top
        comb.buf[comb.i] = x + comb.lp * 0.83;
        comb.i = (comb.i + 1) % comb.buf.length;
        s += y;
      }
      s *= 0.34;
      for (let a = offset; a < allpass.length; a += 2) {
        const ap = allpass[a];
        const y = ap.buf[ap.i];
        ap.buf[ap.i] = s + y * 0.5;
        ap.i = (ap.i + 1) % ap.buf.length;
        s = y - s * 0.5;
      }
      out[i] = s;
    }
    return out;
  };
  return [run(sendL, 0), run(sendR, 1)];
}

/**
 * Render the whole song. Returns interleaved-free stereo planes plus the frame
 * count, which is all both callers need.
 */
export function renderSong(sampleRate = 44100) {
  const total = Math.ceil((DURATION + TAIL) * sampleRate);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const sendL = new Float32Array(total);
  const sendR = new Float32Array(total);

  for (const e of arrangement()) {
    const start = Math.round(e.beat * SPB * sampleRate);
    if (start >= total) continue;
    const pan = e.pan ?? 0;
    const gl = Math.cos((pan + 1) * Math.PI / 4);
    const gr = Math.sin((pan + 1) * Math.PI / 4);
    const write = (i, s, send) => {
      const k = start + i;
      if (k < 0 || k >= total) return;
      L[k] += s * gl;
      R[k] += s * gr;
      sendL[k] += s * gl * send;
      sendR[k] += s * gr * send;
    };
    VOICES[e.inst](write, { ...e, dur: e.dur * SPB }, sampleRate);
  }

  const [wetL, wetR] = reverb(sendL, sendR, sampleRate);

  // Master: reverb in, soft clip, fade the last bar out, normalize.
  let peak = 0;
  const fadeFrom = DURATION - BAR * 1.5;
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const fade = t <= fadeFrom ? 1 : Math.max(0, 1 - (t - fadeFrom) / (BAR * 1.5 + TAIL));
    const l = Math.tanh((L[i] + wetL[i] * 0.5) * 1.1) * fade;
    const r = Math.tanh((R[i] + wetR[i] * 0.5) * 1.1) * fade;
    L[i] = l;
    R[i] = r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  const norm = peak > 0 ? 0.94 / peak : 1;
  for (let i = 0; i < total; i++) { L[i] *= norm; R[i] *= norm; }

  return { left: L, right: R, sampleRate, length: total, duration: total / sampleRate };
}
