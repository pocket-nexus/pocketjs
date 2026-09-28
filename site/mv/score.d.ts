// Types for site/mv/score.js. The song ships as JavaScript so the browser can
// load it without a build step and Bun can import the same file; this is what
// tests/site-film.test.ts and tools/render-mv.ts see.

export declare const BPM: number;
export declare const SPB: number;
export declare const BAR: number;
export declare const BARS: number;
export declare const DURATION: number;
export declare const TAIL: number;

export interface Section {
  from: number;
  to: number;
}
export declare const SECTIONS: Record<"intro" | "verse1" | "verse2" | "pre" | "chorus" | "outro", Section>;

/** One chord name per bar. */
export declare const BAR_CHORDS: string[];

export interface Note {
  /** Beats from the first downbeat. */
  beat: number;
  /** Length in beats. */
  dur: number;
  /** MIDI note number. */
  note: number;
  gain: number;
}
/** The sung line, for lyric timing and the picture. */
export declare const LEAD: Note[];

export interface Song {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  length: number;
  duration: number;
}
/** Synthesize the whole song. Deterministic: same rate in, same samples out. */
export declare function renderSong(sampleRate?: number): Song;
