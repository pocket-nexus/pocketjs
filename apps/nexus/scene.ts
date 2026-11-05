// apps/nexus/scene.ts — the shared geometry of the Pocket Nexus 3DS scene.
//
// The scene lives on the 320x240 touch screen; the top screen belongs to the
// system (the agent's stage). The physics world is that screen: the wordmark
// sits in two rows along the top edge, the lede under it, and the pocket on
// the floor line below. gen-art.ts sizes every sprite from these numbers and
// app.tsx places bodies and colliders with them, so art and physics cannot
// drift apart.

import { markPoint } from "./homepage.ts";

/** The homepage's phone scale for springs, speeds and toy sizes, and gravity. */
export const U = 0.58;
export const G = 2500 * U;

export const W = 320;
export const H = 240;

/** Letter font size in px; the homepage's springs scale with it. */
export const FS = 50;
/** Square sprite side of a letter sticker (texture and node box): its ink plus the keyline. */
export const LETTER_SPRITE = 64;
/** Horizontal gap between letters, and between the two rows, in px. */
export const LETTER_GAP = FS * 0.04;
export const ROW_GAP = FS * 0.1;
/** Top of the wordmark block. */
export const WORD_TOP = 7;

/** The lede: its sprite, the font size and line box the bake sets it in, and its top. */
export const LEDE_SPRITE_W = 512;
export const LEDE_SPRITE_H = 64;
export const LEDE_FONT = 10;
export const LEDE_MAX_W = 296;
export const LEDE_GAP = 6;

/** Pocket: mark units (the 32-unit mark) to px, and where its tip sits. */
export const POCKET_K = 3.6;
export const POCKET_PW = 22 * POCKET_K;
export const POCKET_PH = 15 * POCKET_K;
/** Keyline width of the pocket outline. */
export const POCKET_LW = Math.max(6, POCKET_PW * 0.04);
/** Floor line and the pocket tip. */
export const FLOOR_Y = 222;
export const POCKET_CX = W / 2;
export const POCKET_TIP_Y = FLOOR_Y - 8;
export const POCKET_TOP_Y = POCKET_TIP_Y - POCKET_PH;
/** The pocket sprites are POCKET_SPRITE square with the tip at POCKET_TIP_IN_SPRITE. */
export const POCKET_SPRITE = 128;
export const POCKET_TIP_IN_SPRITE = 108;

/** Base toy radius in px; a toy type scales it. */
export const TOY_R = 16;
export const TOY_SPRITE = 64;
export const PARTICLE_SPRITE = 16;

/** A point of the pocket outline in screen px, from mark units. */
export function pocketPoint(x: number, y: number): [number, number] {
  return markPoint(POCKET_K, POCKET_CX, POCKET_TIP_Y, x, y);
}
