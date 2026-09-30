// apps/nexus-touch/scene.ts — the geometry of the Pocket Nexus touch scene.
//
// One 320x480 portrait screen, laid out by the homepage's own layout() for
// that viewport: the floor line, the pocket, the phone scale U and the toy
// radius follow its formulas here, and gen-art.ts measures the rest (the
// wordmark's font size and slots, the lede, the hint) from the homepage
// document itself. gen-art.ts sizes every sprite from these numbers and
// app.tsx places bodies and colliders with them, so art and physics cannot
// drift apart.

import { clamp, markPoint } from "../nexus/homepage.ts";

export const W = 320;
export const H = 480;
/** The homepage's scale for springs, speeds and toy sizes. */
export const U = clamp(Math.min(W / 1300, H / 860), 0.58, 1.15);
export const G = 2500 * U;

/** The floor line and the pocket, from the homepage's layout(). */
export const FLOOR_Y = H - clamp(H * 0.075, 60, 74);
export const POCKET_PW = clamp(Math.min(W * 0.46, H * 0.25), 112, 300);
export const POCKET_K = POCKET_PW / 22;
export const POCKET_PH = 15 * POCKET_K;
export const POCKET_CX = W / 2;
export const POCKET_TIP_Y = FLOOR_Y - 8;
export const POCKET_TOP_Y = POCKET_TIP_Y - POCKET_PH;
/** Keyline width of the pocket outline, and the collision pad around it. */
export const POCKET_LW = clamp(POCKET_PW * 0.04, 6, 13);
export const POCKET_PAD = POCKET_LW / 2 + 3;
/** The pocket sprites are POCKET_SPRITE_W x POCKET_SPRITE_H with the tip at
 *  (POCKET_SPRITE_W / 2, POCKET_TIP_IN_SPRITE). */
export const POCKET_SPRITE_W = 256;
export const POCKET_SPRITE_H = 128;
export const POCKET_TIP_IN_SPRITE = 108;
/** The mouth sprite is drawn open; the app squashes it to rest with scaleY. */
export const MOUTH_W = 128;
export const MOUTH_H = 32;
/** The mouth's scaleY when open by `open` (the homepage's mry in units of
 *  1.5·k); at rest it is open 0.16. */
export const mouthScale = (open: number) => (open * 1.5 * POCKET_K) / (MOUTH_H / 2 - 3);
export const MOUTH_REST = mouthScale(0.16);
/** The eye sprites, centred on the eye line. */
export const EYES_W = 64;
export const EYES_H = 32;

/** A point of the pocket outline in screen px, from mark units. */
export function pocketPoint(x: number, y: number): [number, number] {
  return markPoint(POCKET_K, POCKET_CX, POCKET_TIP_Y, x, y);
}

/** Square sprite side of a letter sticker (texture and node box). */
export const LETTER_SPRITE = 64;
/** Base toy radius in px (the homepage's 36 at scale U); a toy type scales it. */
export const TOY_R = 36 * U;
export const TOY_SPRITE = 64;
export const PARTICLE_SPRITE = 16;
/** One eye of the O, centred in its square sprite. */
export const O_EYE_SPRITE = 16;
