// apps/nexus-touch/scene.ts — the geometry of the Pocket Nexus touch scene.
//
// One 320x480 portrait screen, laid out by the homepage's own layout() for
// that viewport: the floor line, the pocket, the phone scale U and the toy
// radius follow its formulas here, and gen-art.ts measures the rest (the
// wordmark's font size and slots, the lede, the hint) from the homepage
// document itself. gen-art.ts sizes every sprite from these numbers and
// app.tsx places bodies and colliders with them, so art and physics cannot
// drift apart.

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

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
  return [POCKET_CX + (x - 16) * POCKET_K, POCKET_TIP_Y + (y - 28) * POCKET_K];
}

/** The pocket's straight sides into an arced bottom, sampled from the mark. */
export const POCKET_OUTLINE: readonly (readonly [number, number])[] = [
  [5, 13], [5, 20.4], [5.9, 23], [8.6, 25.6], [12, 27.3], [16, 27.8],
  [20, 27.3], [23.4, 25.6], [26.1, 23], [27, 20.4], [27, 13],
];

export const WORD = [
  { ch: "P", color: "pink" },
  { ch: "O", color: "yellow", face: true },
  { ch: "C", color: "cyan" },
  { ch: "K", color: "lilac" },
  { ch: "E", color: "orange" },
  { ch: "T", color: "pink" },
  { ch: "N", color: "cyan" },
  { ch: "E", color: "lilac" },
  { ch: "X", color: "yellow" },
  { ch: "U", color: "pink" },
  { ch: "S", color: "cyan" },
] as const;
/** Letters in the first row. */
export const ROW_SPLIT = 6;
/** The homepage's resting tilt (degrees) and vertical offset (× FS) per letter. */
export const HOME_R = [-5, 3, -2.5, 4, -3, 5, 4, -4, 2.5, -3, 5];
export const HOME_Y = [0.02, -0.03, 0.012, -0.022, 0.026, -0.012, -0.02, 0.028, -0.018, 0.02, -0.026];

/** Square sprite side of a letter sticker (texture and node box). */
export const LETTER_SPRITE = 64;
/** Base toy radius in px (the homepage's 36 at scale U); a toy type scales it. */
export const TOY_R = 36 * U;
export const TOY_SPRITE = 64;
export const PARTICLE_SPRITE = 16;
/** The toy floor-shadow sprite and the ellipse radii drawn in it. */
export const SHADOW_W = 64;
export const SHADOW_H = 16;
export const SHADOW_RX = 30;
export const SHADOW_RY = 7;
/** One eye of the O, centred in its square sprite. */
export const O_EYE_SPRITE = 16;

/** Speech-bubble lines, verbatim from the homepage. */
export const LINES = ["Shh.", "Not yet.", "Soon.", "Sealed.", "Still cooking.", "?"] as const;
export const O_LINES = ["?", "Shh.", "Not yet.", "Soon."] as const;
export const SAYS = ["Not yet.", "Still cooking.", "Shh.", "Sealed.", "Soon."] as const;
