// apps/sortie/timing.ts — the one grid the picture, the score and the recorder
// all derive from. Plain data: ./app.tsx, ./gen-score.ts and tools/sortie.ts
// each import it, so none of them can drift from the other two.
//
// 150 BPM, 4/4. At 60 Hz a beat is exactly 24 frames and a bar exactly 96, so
// every cut and every drum hit lands on a whole frame — no rounding anywhere
// in the pipeline.

export const BPM = 150;
export const BEAT_SECONDS = 60 / BPM; // 0.4 s
export const BEATS_PER_BAR = 4;

/** Length of the MV in beats. ./app.tsx asserts its cut list sums to this. */
export const TOTAL_BEATS = 100;

/** 40.000 s — 2400 frames at 60 Hz, 25 bars of score. */
export const RUNTIME_SECONDS = TOTAL_BEATS * BEAT_SECONDS;
