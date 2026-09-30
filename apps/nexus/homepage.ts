// apps/nexus/homepage.ts — the pocket.nexus homepage's numbers and bodies,
// shared by the Pocket Nexus scenes: the 3DS pair of screens here and the
// iPod touch screen in apps/nexus-touch.
//
// The word, the toys, the spill's rhythm, the springs and the speech lines
// are the homepage's (site/nexus/public/index.html). A scene supplies its
// own geometry, its phone scale U and its font size FS; the constructors
// below turn the homepage's numbers into @pocketjs/framework/physics options
// at that scale.

import type { Body, BodyOptions, Collider, Emitter, JellyOptions, Vec, ViewSpec, World, Zone } from "@pocketjs/framework/physics";

export const DEG = 180 / Math.PI;

// ---- the word -------------------------------------------------------------------------

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
/** The resting tilt (degrees) and vertical offset (× FS) per letter. */
export const HOME_R = [-5, 3, -2.5, 4, -3, 5, 4, -4, 2.5, -3, 5];
export const HOME_Y = [0.02, -0.03, 0.012, -0.022, 0.026, -0.012, -0.02, 0.028, -0.018, 0.02, -0.026];
/** The baked idle motion per letter (motion.ts); full literals for the build's class scan. */
export const BOB = ["animate-bob-0", "animate-bob-1", "animate-bob-2", "animate-bob-3", "animate-bob-4", "animate-bob-5",
  "animate-bob-6", "animate-bob-7", "animate-bob-8", "animate-bob-9", "animate-bob-10"];
/** The spill: an accelerating rhythm (s after the start) and shorter hops (s) as it speeds up. */
export const SPIT_AT = [0, 0.25, 0.47, 0.66, 0.83, 0.98, 1.16, 1.28, 1.39, 1.49, 1.58];
export const SPIT_TF = [0.66, 0.64, 0.62, 0.6, 0.58, 0.56, 0.56, 0.54, 0.52, 0.5, 0.5];
/** Speech-bubble lines, verbatim. */
export const LINES = ["Shh.", "Not yet.", "Soon.", "Sealed.", "Still cooking.", "?"] as const;
export const O_LINES = ["?", "Shh.", "Not yet.", "Soon."] as const;
export const SAYS = ["Not yet.", "Still cooking.", "Shh.", "Sealed.", "Soon."] as const;

// ---- the toys ---------------------------------------------------------------------------

export interface ToyDef {
  /** Radius × the base toy radius. */
  size: number;
  /** Collision circle radius × the toy's radius (circles). */
  col: number;
  restitution: number;
  /** Rounded-box half extents and corner × the toy's radius. */
  box?: readonly [number, number, number];
  /** The PocketJS handheld and the mystery box: they turn upright and stay near. */
  special?: boolean;
  /** Top edge × the toy's radius, where a tag sits. */
  top: number;
}
const TOY_DEFS = {
  star: { size: 1.0, col: 0.9, restitution: 0.5, top: 1 },
  spark: { size: 0.88, col: 0.66, restitution: 0.55, top: 1 },
  heart: { size: 0.84, col: 0.9, restitution: 0.42, top: 1 },
  cursor: { size: 0.86, col: 0.78, restitution: 0.38, top: 1 },
  gear: { size: 0.95, col: 0.95, restitution: 0.3, top: 1 },
  bolt: { size: 0.9, col: 0.72, restitution: 0.45, top: 1 },
  cart: { size: 0.95, col: 0.9, restitution: 0.22, box: [0.8, 0.96, 0.16], top: 0.96 },
  planet: { size: 1.08, col: 0.8, restitution: 0.42, top: 1 },
  bubble: { size: 0.95, col: 0.9, restitution: 0.3, box: [0.96, 0.8, 0.3], top: 0.8 },
  dpad: { size: 0.9, col: 0.92, restitution: 0.36, top: 1 },
  ghost: { size: 0.92, col: 0.92, restitution: 0.3, box: [0.95, 0.95, 0.24], top: 0.95 },
  ball: { size: 0.64, col: 1.0, restitution: 0.8, top: 1 },
  pjs: { size: 1.28, col: 0.86, restitution: 0.22, box: [1, 0.72, 0.4], special: true, top: 0.98 },
  mystery: { size: 1.0, col: 0.95, restitution: 0.2, box: [0.86, 0.86, 0.2], special: true, top: 0.86 },
} as const satisfies Record<string, ToyDef>;
export type ToyType = keyof typeof TOY_DEFS;
export const TOYS: Record<ToyType, ToyDef> = TOY_DEFS;
export const REGULAR = ["star", "spark", "heart", "cursor", "gear", "bolt", "cart", "planet", "bubble", "dpad", "ghost", "ball"] as const;

// ---- the pocket ---------------------------------------------------------------------------

/** The pocket's straight sides into an arced bottom, in the 32-unit mark's units. */
export const POCKET_OUTLINE: readonly Vec[] = [
  [5, 13], [5, 20.4], [5.9, 23], [8.6, 25.6], [12, 27.3], [16, 27.8],
  [20, 27.3], [23.4, 25.6], [26.1, 23], [27, 20.4], [27, 13],
];
/** A mark point in px: `k` px per unit, the tip (16, 28) at (cx, tipY). */
export function markPoint(k: number, cx: number, tipY: number, x: number, y: number): [number, number] {
  return [cx + (x - 16) * k, tipY + (y - 28) * k];
}

// ---- randomness and small math ---------------------------------------------------------------

export interface Random {
  /** Uniform in [0, 1). */
  (): number;
  /** Uniform in [a, b). */
  range(a: number, b: number): number;
  pick<T>(list: readonly T[]): T;
}
/** A seeded generator (mulberry32), so a run is a function of its input tape;
 *  the world's own generators drive particles. */
export function seededRandom(start: number): Random {
  let seed = start | 0;
  const random = (() => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Random;
  random.range = (a, b) => a + random() * (b - a);
  random.pick = (list) => list[Math.floor(random() * list.length)];
  return random;
}
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Degrees wrapped to [-180, 180). */
export const wrapDeg = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

// ---- bodies at a scene's scale -----------------------------------------------------------------

/** A letter's collision half extents: its ink box plus 5 font units. */
export function letterHalf(l: { w: number; ih: number }, fs: number): [number, number] {
  return [l.w / 2 + (5 * fs) / 100, l.ih / 2 + (5 * fs) / 100];
}

/** A landing squash: velocity per px/s, clamped, with a spin kick (°/s per unit). */
export const landing = (fs: number) => ({ gain: 1.55 / fs, min: 1.4, max: 6.4, spin: 9 });

/** A letter's body: a jelly rounded box resting on its layout slot with the
 *  homepage's springs. The scene adds views, picking and the parked start. */
export function letterBody(l: { w: number; ih: number; rcK: number }, i: number, fs: number): BodyOptions {
  const [hw, hh] = letterHalf(l, fs);
  const jelly: JellyOptions = {
    squash: { stiffness: 540, damping: 12, limit: 0.42, across: 0.6, along: 1 },
    impact: 8 / fs,
    land: landing(fs),
    lean: { stiffness: 320, damping: 11, gain: 3.2 / fs, limit: 14, impact: (2.2 / fs) * DEG },
    pulse: { stiffness: 340, damping: 20 },
    stretch: { gain: 0.055 / fs, limit: 0.16 },
    pivot: l.ih * 0.44,
  };
  return {
    shape: { box: [hw, hh], corner: Math.min(hw, hh) * l.rcK },
    density: 0.2, inertia: 1.4, restitution: 1, friction: 0.55,
    layer: 2, mask: 1, hitSpeed: 300,
    anchor: {
      to: "layout", angle: HOME_R[i],
      spring: { stiffness: 190, damping: 13 }, spin: { stiffness: 230, damping: 13 }, airGravity: fs * 11,
    },
    jelly,
  };
}

/** The spill's flight for a letter whose slot is `home`: out of the mouth a
 *  little toward it, a full turn, arriving `tf` s later. */
export function spillFlight(
  home: Vec, hh: number, pocket: { cx: number; top: number; pw: number }, fs: number, tf: number, random: Random,
) {
  const x0 = pocket.cx + clamp((home[0] - pocket.cx) * 0.12, -pocket.pw * 0.2, pocket.pw * 0.2);
  const y0 = pocket.top + hh * 0.25;
  const dir = home[0] >= x0 ? 1 : -1;
  return {
    from: [x0, y0] as Vec, duration: tf, turn: dir * 360, endOffset: dir * random.range(8, 15),
    arrive: fs * random.range(3.9, 4.5), grow: 0.3,
  };
}

/** The pocket: an immovable jelly body on its layout box that owns the
 *  outline collider (toys faster than 420·U px/s rock and squash it) and a
 *  zone inside the outline. `outline` is in world px. */
export function pocketBodies(world: World, views: readonly ViewSpec[], outline: readonly Vec[], pad: number, pivot: number, u: number):
  { pocket: Body; wall: Collider; inside: Zone } {
  const pocket = world.body({
    views, mass: 0,
    anchor: { to: "layout", spin: { stiffness: 170, damping: 5 } },
    jelly: { squash: { stiffness: 560, damping: 15, limit: 2, across: 0.12, along: 0.15 }, pulse: { stiffness: 340, damping: 20 }, pivot },
  });
  const wall = world.collider({
    shape: { chain: outline, radius: pad },
    layer: 4, restitution: 1, friction: 0.75,
    owner: { body: pocket, squash: 1 / (900 * u), squashLimit: 3, spin: DEG / (2600 * u), spinLimit: 0.9 * DEG, minSpeed: 420 * u },
  });
  const inside = world.zone({ shape: { chain: outline, closed: true }, mask: 1 });
  return { pocket, wall, inside };
}

/** A block of text the toys bonk: a jelly body on its layout box that owns a
 *  rounded box around the text's ink `{l, t, r, b}` (world px). */
export function textShelf(world: World, view: ViewSpec, ink: { l: number; t: number; r: number; b: number }, u: number): Body {
  const shelf = world.body({
    views: [view], mass: 0,
    anchor: { to: "layout", spin: { stiffness: 230, damping: 13 } },
    jelly: { squash: { stiffness: 540, damping: 12, limit: 0.2, across: 0.75, along: 1 } },
  });
  world.collider({
    shape: { box: [(ink.r - ink.l) / 2 + 4, (ink.b - ink.t) / 2 + 1], at: [(ink.l + ink.r) / 2, (ink.t + ink.b) / 2], corner: 4 },
    layer: 4, restitution: 1, friction: 0.75,
    owner: { body: shelf, squash: 1 / 1400, squashLimit: 1, spin: 0.03, spinLimit: 40, minSpeed: 260 * u },
  });
  return shelf;
}

// ---- particles ----------------------------------------------------------------------------------

/** Keyline bursts off letters: the homepage's burst() at font size fs. */
export function burstEmitter(world: World, views: readonly ViewSpec[], textures: readonly string[], fs: number): Emitter {
  const sc = (fs / 200) * 0.5 + 0.5;
  return world.emitter({
    views, textures,
    life: [0.62, 0.82], speed: [42 * 6 * sc, 78 * 6 * sc], size: [0.75, 1.25], spin: [0, 420], drag: 6, gravity: [0, 240],
    scale: "pop", alpha: "constant",
  });
}
/** Stars and dots thrown out of the pocket's mouth. */
export function sparkEmitter(world: World, views: readonly ViewSpec[], textures: readonly string[], u: number): Emitter {
  return world.emitter({
    views, textures,
    life: [0.45, 0.85], speed: [260 * u, 760 * u], size: [0.45, 0.8], spin: [0, 500], gravity: [0, 1100 * u],
    scale: "constant", alpha: "fade",
  });
}
/** Twinkles drifting up out of the pocket. */
export function twinkleEmitter(world: World, views: readonly ViewSpec[], textures: readonly string[], u: number): Emitter {
  return world.emitter({
    views, textures,
    life: [1.6, 2.8], speed: [30 * u, 70 * u], size: [0.25, 0.45], gravity: [0, -10 * u],
    scale: "constant", alpha: "twinkle", stream: { angle: -90, spread: 40 },
  });
}
