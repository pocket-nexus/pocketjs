// Types for site/mv/lyrics.js — the words and the bars they land on.

export declare const TITLE_JA: string;
export declare const TITLE_EN: string;

export interface Lyric {
  /** The downbeat the line lands on. */
  bar: number;
  /** How many bars it stays up. */
  bars: number;
  ja: string;
  en: string;
  /** Chorus lines, set large and centred. */
  slam?: boolean;
  /** Lines that name an API, set in the mono face. */
  code?: boolean;
}
export declare const LYRICS: Lyric[];

/** The line on screen at bar `b`, or null. */
export declare function lyricAt(b: number): Lyric | null;

export declare const SOURCE: string[];
export declare const FACTS: string[];
export declare const DEVICES: string[];
