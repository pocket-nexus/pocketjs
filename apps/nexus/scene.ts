// apps/nexus/scene.ts — the shared geometry of the Pocket Nexus 3DS scene.
//
// One physics world spans both screens: the 400x240 top screen sits at the
// world origin, the 320x240 bottom screen is centred under it past a hinge
// gap, the way the two panels sit in the console. gen-art.ts sizes every
// sprite from these numbers and app.tsx places bodies and colliders with
// them, so art and physics cannot drift apart.

import { markPoint } from "./homepage.ts";

/** The homepage's phone scale for springs, speeds and toy sizes, and gravity. */
export const U = 0.58;
export const G = 2500 * U;

export const TOP_W = 400;
export const TOP_H = 240;
export const BOTTOM_W = 320;
export const BOTTOM_H = 240;
/** World px between the top screen's bottom edge and the bottom screen's top. */
export const HINGE = 56;
/** World origin of the bottom screen. */
export const BOTTOM_X = (TOP_W - BOTTOM_W) / 2;
export const BOTTOM_Y = TOP_H + HINGE;

/** Letter font size in px; the homepage's springs scale with it. */
export const FS = 72;
/** Square sprite side of a letter sticker (texture and node box). */
export const LETTER_SPRITE = 128;
/** Horizontal gap between letters, and between the two rows, in px. */
export const LETTER_GAP = FS * 0.04;
export const ROW_GAP = FS * 0.1;
/** Top of the wordmark block on the top screen. */
export const WORD_TOP = 16;

/** Pocket: mark units (the 32-unit mark) to px, and where its tip sits. */
export const POCKET_K = 4.6;
export const POCKET_PW = 22 * POCKET_K;
export const POCKET_PH = 15 * POCKET_K;
/** Keyline width of the pocket outline. */
export const POCKET_LW = Math.max(6, POCKET_PW * 0.04);
/** Bottom-screen floor line and the pocket tip (bottom-screen coordinates). */
export const FLOOR_Y = 214;
export const POCKET_CX = BOTTOM_W / 2;
export const POCKET_TIP_Y = FLOOR_Y - 8;
export const POCKET_TOP_Y = POCKET_TIP_Y - POCKET_PH;
/** The pocket sprites are POCKET_SPRITE square with the tip at POCKET_TIP_IN_SPRITE. */
export const POCKET_SPRITE = 128;
export const POCKET_TIP_IN_SPRITE = 108;

/** Base toy radius in px (the homepage's 36 at its 0.58 phone scale); a toy type scales it. */
export const TOY_R = 21;
export const TOY_SPRITE = 64;
export const PARTICLE_SPRITE = 16;

/** A point of the pocket outline in bottom-screen px, from mark units. */
export function pocketPoint(x: number, y: number): [number, number] {
  return markPoint(POCKET_K, POCKET_CX, POCKET_TIP_Y, x, y);
}
