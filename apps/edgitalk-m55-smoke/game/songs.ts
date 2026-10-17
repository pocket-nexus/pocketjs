// Built-in songs. Each song is written as reusable 16-step bars (one step is a
// sixteenth note). The same source produces the audio events sent to the native
// synthesizer and the note chart, so music and gameplay cannot drift apart.

export const VOICE_LEAD = 0;
export const VOICE_BASS = 1;
export const VOICE_DRUM = 2;

export const DRUM_KICK = 0;
export const DRUM_SNARE = 1;
export const DRUM_HAT = 2;

/** Note types in a chart. */
export const NOTE_GROUND = 0;
export const NOTE_AIR = 1;
export const NOTE_BIG_GROUND = 2;
export const NOTE_BIG_AIR = 3;

export interface Song {
  /** Slot in the high-score table. */
  id: number;
  title: string;
  artist: string;
  bpm: number;
  /** 1..3 */
  level: number;
  /** Total length in steps. */
  steps: number;
  /** Flat [stepIndex, noteType, ...]. */
  notes: number[];
  /** Flat [step, voice, note, length, volume, ...]. */
  events: number[];
  custom: boolean;
}

interface Bar {
  /** Lead: 16 whitespace-separated tokens (`c5`, `.` rest, `-` sustain). */
  l: string;
  /** Bass: same syntax. */
  b: string;
  /** Drums: 16 characters (`k` kick, `s` snare, `h` hat, `.` none). */
  d: string;
  /** Chart: 16 characters (`g` ground, `a` air, `G` big ground, `A` big air). */
  c: string;
}

const NAMES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

function midi(token: string): number {
  const letter = NAMES[token.charAt(0)];
  let index = 1;
  let sharp = 0;
  if (token.charAt(index) === "#") {
    sharp = 1;
    index++;
  }
  const octave = parseInt(token.slice(index), 10);
  return 12 * (octave + 1) + letter + sharp;
}

function pushTokens(events: number[], base: number, voice: number, text: string, volume: number): void {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  let last = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === ".") {
      last = -1;
    } else if (token === "-") {
      if (last >= 0) events[last + 3] += 1;
    } else {
      last = events.length;
      events.push(base + i, voice, midi(token), 1, volume);
    }
  }
}

const DRUM_CODE: Record<string, number> = { k: DRUM_KICK, s: DRUM_SNARE, h: DRUM_HAT };
const CHART_CODE: Record<string, number> = {
  g: NOTE_GROUND, a: NOTE_AIR, G: NOTE_BIG_GROUND, A: NOTE_BIG_AIR,
};

function build(
  id: number,
  title: string,
  artist: string,
  bpm: number,
  level: number,
  bars: Record<string, Bar>,
  order: string,
): Song {
  const events: number[] = [];
  const notes: number[] = [];
  for (let i = 0; i < order.length; i++) {
    const bar = bars[order.charAt(i)];
    const base = i * 16;
    pushTokens(events, base, VOICE_LEAD, bar.l, 90);
    pushTokens(events, base, VOICE_BASS, bar.b, 100);
    for (let s = 0; s < 16; s++) {
      const drum = DRUM_CODE[bar.d.charAt(s)];
      if (drum !== undefined) events.push(base + s, VOICE_DRUM, drum, 1, 100);
      const note = CHART_CODE[bar.c.charAt(s)];
      if (note !== undefined) notes.push(base + s, note);
    }
  }
  return { id, title, artist, bpm, level, steps: order.length * 16, notes, events, custom: false };
}

const REST = ". . . . . . . . . . . . . . . .";
const NONE = "................";

// -- 1. Sunny Steps: C major, 112 BPM, easy -------------------------------------
const sunny = build(0, "Sunny Steps", "Edgi", 112, 1, {
  R: { l: REST, b: "c3 - - - - - - - g2 - - - - - - -", d: "k...k...k...k...", c: NONE },
  A: { l: "c5 . e5 . g5 . e5 . c5 . e5 . g5 - - .", b: "c3 - - - . . c3 . g2 - - - . . g2 .", d: "k.h.s.h.k.h.s.h.", c: "g...a...g...a..." },
  B: { l: "d5 . f5 . a5 . f5 . d5 . f5 . a5 - - .", b: "d3 - - - . . d3 . a2 - - - . . a2 .", d: "k.h.s.h.k.h.s.h.", c: "a...g...a...g..." },
  C: { l: "g5 . g5 a5 . g5 . e5 c5 . e5 . g5 - - .", b: "c3 - - - . . c3 . g2 - - - . . g2 .", d: "k.h.s.h.k.h.s.h.", c: "g...a...g.g.a..." },
  D: { l: "c5 - - - e5 - - - g5 - - - c6 - - -", b: "c3 - - - - - - - g2 - - - - - - -", d: "k...h...s...h...", c: "G...a...g...A..." },
}, "RAABBAACCBBAACCAABBCCD");

// -- 2. Neon Pulse: A minor, 128 BPM, medium ------------------------------------
const neon = build(1, "Neon Pulse", "Edgi", 128, 2, {
  R: { l: REST, b: "a2 - - - - - - - a2 - - - - - - -", d: "k...k...k...k...", c: NONE },
  A: { l: "a4 . a4 c5 . e5 . d5 c5 . a4 . g4 . a4 .", b: "a2 . a2 . a2 . a2 . f2 . f2 . g2 . g2 .", d: "k.h.s.hkk.h.s.h.", c: "g.a.g.a.g.a.g.a." },
  B: { l: "f4 . f4 a4 . c5 . a#4 a4 . f4 . e4 . f4 .", b: "f2 . f2 . f2 . f2 . e2 . e2 . e2 . e2 .", d: "k.h.s.hkk.h.s.h.", c: "g.a.a.g.g.a.a.g." },
  C: { l: "e5 e5 . e5 . d5 . c5 . a4 c5 . d5 . e5 .", b: "a2 . a2 a2 . a2 . a2 . a2 a2 . a2 . a2 .", d: "k.hkskh.k.hks.h.", c: "g.a.g.g.a.a.g.a." },
  D: { l: "a4 - - - - - - - . . . . . . . .", b: "a2 - - - - - - - . . . . . . . .", d: "k.......k.......", c: "G..............." },
}, "RAABBAACCBBAACCAABBCCAACCD");

// -- 3. Cat Rush: E minor, 150 BPM, hard -----------------------------------------
const rush = build(2, "Cat Rush", "Edgi", 150, 3, {
  R: { l: REST, b: "e2 - - - - - - - e2 - - - - - - -", d: "k...k...k...k...", c: NONE },
  A: { l: "e5 . e5 g5 . b5 . g5 e5 . d5 . e5 g5 . .", b: "e2 . e2 e2 . e2 . e2 e2 . e2 . e2 e2 . e2", d: "k.hks.hkk.hks.hs", c: "g.ga.g.ag.a.ga.." },
  B: { l: "g5 . g5 a5 . b5 . a5 g5 . e5 . g5 a5 . .", b: "g2 . g2 g2 . g2 . g2 c3 . c3 . c3 c3 . c3", d: "k.hks.hkk.hks.hs", c: "a.ag.a.ga.g.ag.." },
  C: { l: "b5 a5 g5 a5 b5 . b5 . a5 g5 e5 g5 a5 . g5 .", b: "e2 e2 . e2 e2 . e2 . a2 a2 . a2 a2 . b2 .", d: "kkhkskhkkkhkskhs", c: "ga.gag.a.ggaa.g." },
  D: { l: "e5 - - - - - - - . . . . . . . .", b: "e2 - - - - - - - . . . . . . . .", d: "k.......k.......", c: "A..............." },
}, "RAABBAACCBBAACCAABBCCAACCBBCCD");

export const BUILTIN_SONGS: Song[] = [sunny, neon, rush];

/** Milliseconds for a chart step. */
export function stepMs(bpm: number): number {
  return 15000 / bpm;
}

/**
 * Parse a custom song pushed by the companion tool. The JSON layout is
 * `{ title, bpm, notes: [step, type, ...], events: [step, voice, note, len, vol, ...] }`.
 * Returns undefined when the payload is missing or malformed.
 */
export function parseCustomSong(text: string): Song | undefined {
  if (text.length < 8) return undefined;
  let data: {
    title?: unknown; bpm?: unknown; level?: unknown; steps?: unknown;
    notes?: unknown; events?: unknown;
  };
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  const bpm = data.bpm;
  const notes = data.notes;
  const events = data.events;
  if (typeof bpm !== "number" || bpm < 60 || bpm > 240) return undefined;
  if (!Array.isArray(notes) || !Array.isArray(events)) return undefined;
  if (notes.length < 2 || notes.length % 2 !== 0 || events.length % 5 !== 0) return undefined;
  for (let i = 0; i < notes.length; i++) {
    if (typeof notes[i] !== "number") return undefined;
  }
  for (let i = 0; i < events.length; i++) {
    if (typeof events[i] !== "number") return undefined;
  }
  let steps = typeof data.steps === "number" ? data.steps : 0;
  for (let i = 0; i < notes.length; i += 2) steps = Math.max(steps, notes[i] + 8);
  // The baked fonts only carry printable ASCII.
  const title = typeof data.title === "string"
    ? data.title.slice(0, 12).replace(/[^\x20-\x7e]/g, "?")
    : "Custom";
  const level = typeof data.level === "number" ? Math.max(1, Math.min(3, Math.round(data.level))) : 2;
  return { id: 3, title, artist: "PC", bpm, level, steps, notes, events, custom: true };
}
