// apps/nexus-touch/scene.ts — the geometry of a Pocket Nexus touch scene.
//
// One portrait screen, laid out by the homepage's own layout() for its
// size: the floor line, the pocket, the phone scale U and the toy radius
// follow its formulas here, and gen-art.ts measures the rest (the wordmark's
// font size FS and slots, the lede, the hint) from the homepage document.
// Sprite sides are the powers of two that hold each part at that geometry.
// gen-art.ts sizes every sprite from these numbers and app.tsx places bodies
// and colliders with them, so art and physics cannot drift apart.

import { clamp, markPoint } from "../nexus/homepage.ts";

const pow2 = (n: number) => {
  let p = 8;
  while (p < n) p *= 2;
  return p;
};

export type TouchScene = ReturnType<typeof touchScene>;

/** The scene for a `w`×`h` screen whose wordmark the homepage set at `fs` px. */
export function touchScene(w: number, h: number, fs: number) {
  /** The homepage's scale for springs, speeds and toy sizes. */
  const u = clamp(Math.min(w / 1300, h / 860), 0.58, 1.15);
  const floorY = h - clamp(h * 0.075, 60, 74);
  const pw = clamp(Math.min(w * 0.46, h * 0.25), 112, 300);
  const k = pw / 22;
  const lw = clamp(pw * 0.04, 6, 13);
  const tipY = floorY - 8;
  const spriteH = pow2(15.72 * k + lw + 26);
  const mouthH = 32;
  return {
    W: w,
    H: h,
    U: u,
    G: 2500 * u,
    FS: fs,
    /** The floor line and the pocket, from the homepage's layout(). */
    FLOOR_Y: floorY,
    POCKET_PW: pw,
    POCKET_K: k,
    POCKET_PH: 15 * k,
    POCKET_CX: w / 2,
    POCKET_TIP_Y: tipY,
    POCKET_TOP_Y: tipY - 15 * k,
    /** Keyline width of the pocket outline, and the collision pad around it. */
    POCKET_LW: lw,
    POCKET_PAD: lw / 2 + 3,
    /** The pocket sprites hold the outline, its corner studs and keyline, with
     *  the tip at (POCKET_SPRITE_W / 2, POCKET_TIP_IN_SPRITE). */
    POCKET_SPRITE_W: pow2(22 * k + lw + 6 + 2 * (0.72 * k + 2)),
    POCKET_SPRITE_H: spriteH,
    POCKET_TIP_IN_SPRITE: spriteH - 20,
    /** The mouth sprite is drawn open; the app squashes it to rest with scaleY. */
    MOUTH_W: pow2(20.4 * k + 8),
    MOUTH_H: mouthH,
    /** The eye sprites, centred on the eye line. */
    EYES_W: pow2(7.5 * k + 4),
    EYES_H: pow2(3 * k + 4),
    /** Square sprite side of a letter sticker: its ink plus the keyline. */
    LETTER_SPRITE: pow2(0.88 * fs),
    /** Base toy radius in px (the homepage's 36 at scale U); a toy type scales it. */
    TOY_R: 36 * u,
    TOY_SPRITE: 64,
    PARTICLE_SPRITE: 16,
    /** One eye of the O, centred in its square sprite. */
    O_EYE_SPRITE: 16,
    /** The mouth's scaleY when open by `open` (the homepage's mry in units of
     *  1.5·k); at rest it is open 0.16. */
    mouthScale: (open: number) => (open * 1.5 * k) / (mouthH / 2 - 3),
    /** A point of the pocket outline in screen px, from mark units. */
    pocketPoint: (x: number, y: number) => markPoint(k, w / 2, tipY, x, y),
  };
}
