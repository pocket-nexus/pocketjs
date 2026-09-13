/** Replayable composition. Left/right move one raw-input character, clamped
 * at its bounds. Candidate selections are page-relative Rime keys.
 * The guest owns the transcript; the provider owns dictionaries and conversion. */
export const IME = Object.freeze({ keys: 128, candidates: 5, select: 0x1000000,
  selectAbsolute: 0x2000000, browseSize: 15, browseLimit: 512,
  backspace: 0xff08, enter: 0xff0d, left: 0xff51, right: 0xff53,
  pageUp: 0xff55, pageDown: 0xff56 });
export interface ImeSnapshot {
  preedit: string;
  /** Unformatted input and its caret for device-owned offline editing. */
  raw: string;
  rawCaret: number;
  commit: string;
  candidates: string[];
  page: number;
  last: boolean;
  caret: number;
}
export interface ImeCandidatePage { offset: number; candidates: string[]; last: boolean }
export function validImeBrowse(value: unknown): value is { keys: number[]; offset: number } {
  const v = value as { keys?: unknown; offset?: number } | null;
  return !!v && validImeKeys(v.keys) && Number.isSafeInteger(v.offset) && v.offset! >= 0 && v.offset! < IME.browseLimit;
}
export function validImeKeys(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= IME.keys && value.every(k =>
    Number.isInteger(k) && ((k >= 32 && k <= 126) ||
      [IME.backspace, IME.enter, IME.left, IME.right, IME.pageUp, IME.pageDown].includes(k) ||
      (k >= IME.select && k < IME.select + IME.candidates) ||
      (k >= IME.selectAbsolute && k < IME.selectAbsolute + IME.browseLimit)));
}
