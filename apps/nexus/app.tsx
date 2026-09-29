// apps/nexus/app.tsx — the pocket.nexus homepage on the Nintendo 3DS.
//
// One physics world spans both screens (scene.ts). The bottom screen holds
// the pocket and the toys; the stylus pops, grabs and flings them. The first
// tap opens the pocket and it spits POCKET NEXUS up through the hinge onto
// the top screen, where the letters land in their layout slots as jelly
// bodies. Toys flung hard enough fly up there too and knock the letters.
//
// The app declares bodies and issues commands at interaction edges; the core
// integrates every tick and writes the poses into the nodes
// (@pocketjs/framework/physics). Per-frame JS is the event drain, the stylus
// drag target while a toy is held, and the d-pad tilt.

import { createSignal, For, onCleanup, onMount } from "solid-js";
import { AuxiliarySurface, Image, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate } from "@pocketjs/framework/animation";
import { after, virtualNow } from "@pocketjs/framework/clock";
import { createGesture } from "@pocketjs/framework/gesture";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { createWorld, type Body, type Collider, type Emitter, type World } from "@pocketjs/framework/physics";
import * as S from "./scene.ts";
import {
  BACKDROP_ART, COPY_ART, HINT_ART, LEDE_ART, LEDE_BOX, LETTER_ART, O_FACE, PARTICLE_ART, POCKET_ART, TOY_ART, WORD_BOX,
} from "./art.ts";

// ---- numbers from the homepage (U = its 0.58 phone scale) -----------------------

const U = 0.58;
const G = 2500 * U;
const DEG = 180 / Math.PI;
const FS = S.FS;
const SIZE = FS / 100;
const ROW_H = WORD_BOX.rowH;
const LEDE_TOP = S.WORD_TOP + WORD_BOX.h + 8;
const LEDE_LEFT = (S.TOP_W - 512) / 2;
const SPIT_AT = [0, 0.25, 0.47, 0.66, 0.83, 0.98, 1.16, 1.28, 1.39, 1.49, 1.58];
const SPIT_TF = [0.66, 0.64, 0.62, 0.6, 0.58, 0.56, 0.56, 0.54, 0.52, 0.5, 0.5];
const BOB = ["animate-bob-0", "animate-bob-1", "animate-bob-2", "animate-bob-3", "animate-bob-4", "animate-bob-5",
  "animate-bob-6", "animate-bob-7", "animate-bob-8", "animate-bob-9", "animate-bob-10"];
/** Toy node slots, and the live toys kept before the oldest fades out. */
const TOY_CAP = 12;
const LIVE_TOYS = 10;
/** A letter's landing squash: velocity per px/s, clamped, with a spin kick (°/s per unit). */
const LAND = { gain: 1.55 / FS, min: 1.4, max: 6.4, spin: 9 };
const O_INDEX = LETTER_ART.findIndex((l) => l.ch === "O");

/** Pocket landmarks in world px (scene.ts places the bottom screen in the world). */
const PX = S.BOTTOM_X + S.POCKET_CX;
const PTOP = S.BOTTOM_Y + S.POCKET_TOP_Y;
const FLOOR = S.BOTTOM_Y + S.FLOOR_Y;
const PW = S.POCKET_PW;
const PAD = S.POCKET_LW / 2 + 3;
/** The pocket's 128px sprite frame, placed so its tip lands on the floor line. */
const POCKET_LEFT = S.POCKET_CX - S.POCKET_SPRITE / 2;
const POCKET_TOP = S.POCKET_TIP_Y - S.POCKET_TIP_IN_SPRITE;
const POCKET_PIVOT = S.POCKET_TIP_IN_SPRITE - S.POCKET_SPRITE / 2;
const MOUTH_Y = S.POCKET_TIP_IN_SPRITE - 15 * S.POCKET_K;
const MOUTH_REST = 0.09;
const EYES_SHOWN_Y = MOUTH_Y - 5;
const EYES_HIDDEN = 18;

interface ToyDef { size: number; col: number; e: number; box?: readonly [number, number, number]; special?: boolean }
const TOYS: Record<keyof typeof TOY_ART, ToyDef> = {
  star: { size: 1.0, col: 0.9, e: 0.5 },
  spark: { size: 0.88, col: 0.66, e: 0.55 },
  heart: { size: 0.84, col: 0.9, e: 0.42 },
  cursor: { size: 0.86, col: 0.78, e: 0.38 },
  gear: { size: 0.95, col: 0.95, e: 0.3 },
  bolt: { size: 0.9, col: 0.72, e: 0.45 },
  cart: { size: 0.95, col: 0.9, e: 0.22, box: [0.8, 0.96, 0.16] },
  planet: { size: 1.08, col: 0.8, e: 0.42 },
  bubble: { size: 0.95, col: 0.9, e: 0.3, box: [0.96, 0.8, 0.3] },
  dpad: { size: 0.9, col: 0.92, e: 0.36 },
  ghost: { size: 0.92, col: 0.92, e: 0.3, box: [0.95, 0.95, 0.24] },
  ball: { size: 0.64, col: 1.0, e: 0.8 },
  pjs: { size: 1.28, col: 0.86, e: 0.22, box: [1, 0.72, 0.4], special: true },
  mystery: { size: 1.0, col: 0.95, e: 0.2, box: [0.86, 0.86, 0.2], special: true },
};
const REGULAR = ["star", "spark", "heart", "cursor", "gear", "bolt", "cart", "planet", "bubble", "dpad", "ghost", "ball"] as const;
type ToyType = keyof typeof TOYS;

// ---- seeded randomness (the world's own generator drives particles) --------------

let seed = 0x5eed2026;
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rand = (a: number, b: number) => a + random() * (b - a);
const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Degrees wrapped to [-180, 180). */
const wrapDeg = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Runs `run` once the nodes before it exist; the last child of the auxiliary
 *  surface mounts after every ref on both surfaces is set. */
function AfterMount(props: { run: () => void }) {
  onMount(() => props.run());
  return null;
}

/** Style object for an absolutely placed box. */
function box(x: number, y: number, w: number, h: number, extra: Record<string, number> = {}) {
  return { posType: 1, insetL: x, insetT: y, width: w, height: h, ...extra };
}

// ---- the wordmark: two flex rows whose slots are the letters' anchors -----------

const ROWS = [LETTER_ART.slice(0, S.ROW_SPLIT), LETTER_ART.slice(S.ROW_SPLIT)];

export default function Nexus() {
  // -- nodes ---------------------------------------------------------------------
  const sticker: NodeMirror[] = [];
  const shadow: NodeMirror[] = [];
  const ghost: NodeMirror[] = [];
  const toyTop: NodeMirror[] = [];
  const toyBottom: NodeMirror[] = [];
  const burstTop: NodeMirror[] = [];
  const burstBottom: NodeMirror[] = [];
  const twinkles: NodeMirror[] = [];
  let backWrap: NodeMirror | undefined, eyesWrap: NodeMirror | undefined, frontWrap: NodeMirror | undefined;
  let mouth: NodeMirror | undefined, eyes: NodeMirror | undefined, glow: NodeMirror | undefined;
  let haze: NodeMirror | undefined, lede: NodeMirror | undefined, copy: NodeMirror | undefined, hint: NodeMirror | undefined;

  // -- reactive bits (only at edges) ---------------------------------------------------
  const [shown, setShown] = createSignal<readonly boolean[]>(LETTER_ART.map(() => false));
  const [oFace, setOFace] = createSignal<string>(O_FACE.shut);
  const [eyeArt, setEyeArt] = createSignal<string>(POCKET_ART.eyes);
  const [toySrc, setToySrc] = createSignal<readonly string[]>(Array.from({ length: TOY_CAP }, () => TOY_ART.star));
  const [toySize, setToySize] = createSignal<readonly number[]>(Array.from({ length: TOY_CAP }, () => S.TOY_SPRITE));
  const [toyOn, setToyOn] = createSignal<readonly boolean[]>(Array.from({ length: TOY_CAP }, () => false));
  const setAt = <T,>(get: () => readonly T[], set: (v: readonly T[]) => void, i: number, v: T) => {
    const next = get().slice();
    next[i] = v;
    set(next);
  };

  // -- the world -------------------------------------------------------------------
  let world: World | undefined;
  let pocket: Body;
  let pocketWall: Collider;
  const letters: Body[] = [];
  let burstsTop: Emitter, burstsBottom: Emitter, ambient: Emitter;
  interface Toy {
    slot: number; type: ToyType; body: Body; r: number; born: number;
    touched: boolean; cleared: boolean; gone: boolean;
    /** The side a special was aimed at; spitOut sends it back there. */
    side: number;
    /** Seconds a special has rested tilted. */
    tilted: number;
  }
  const toys: (Toy | undefined)[] = Array.from({ length: TOY_CAP }, () => undefined);
  let phase: "sleep" | "spill" | "play" = "sleep";
  let lastPop = -1, lastInteract = 0, landed = 0, userPopped = false, spawnCount = 0, sideFlip = 1, mysteryHopAt = 0;
  let bag: ToyType[] = [];
  // pending timers; each removes itself when it fires
  const timers = new Set<() => void>();
  function later(seconds: number, fn: () => void) {
    const cancel = after(seconds, () => {
      timers.delete(cancel);
      fn();
    });
    timers.add(cancel);
  }
  onCleanup(() => {
    for (const cancel of timers) cancel();
    timers.clear();
    world?.destroy();
  });

  function setup() {
    const w = createWorld({
      gravity: [0, G],
      substeps: 2,
      seed: 20260929,
      surfaces: { primary: [0, 0], auxiliary: [S.BOTTOM_X, S.BOTTOM_Y] },
      maxSpeed: 4200 * U,
    });
    world = w;
    // the room: the top screen's walls funnel through the hinge into the
    // bottom screen and its floor; the top edge is a ceiling, as on the homepage
    const [bx, by] = w.toWorld(0, 0, "auxiliary");
    const right = bx + S.BOTTOM_W;
    w.collider({
      shape: { chain: [[0, 0], [0, S.TOP_H], [bx, by], [bx, FLOOR], [right, FLOOR], [right, by], [S.TOP_W, S.TOP_H], [S.TOP_W, 0]], radius: 4, closed: true },
      layer: 4, restitution: 1, friction: 0.75,
    });
    pocket = w.body({
      views: [backWrap!, eyesWrap!, frontWrap!],
      mass: 0,
      anchor: { to: "layout", spin: { stiffness: 170, damping: 5 } },
      jelly: { squash: { stiffness: 560, damping: 15, limit: 2, across: 0.12, along: 0.15 }, pivot: POCKET_PIVOT },
    });
    const outline = S.POCKET_OUTLINE.map(([x, y]) => w.toWorld(...S.pocketPoint(x, y), "auxiliary"));
    // toys that strike the pocket faster than 420·U px/s rock and squash it
    pocketWall = w.collider({
      shape: { chain: outline, radius: PAD },
      layer: 4, restitution: 1, friction: 0.75,
      owner: { body: pocket, squash: 1 / (900 * U), squashLimit: 3, spin: DEG / (2600 * U), spinLimit: 0.9 * DEG, minSpeed: 420 * U },
    });
    const inside = w.zone({ shape: { chain: outline, closed: true }, mask: 1 });
    inside.onEnter((body) => {
      const toy = toys.find((t) => t?.body === body);
      if (toy && toy.cleared && !toy.gone && virtualNow() - toy.born > 0.5) {
        if (toy.touched) swallow(toy);
        else spitOut(toy);
      }
    });
    // the lede is a shelf the toys bonk
    const ledeBody = w.body({
      views: [lede!],
      mass: 0,
      anchor: { to: "layout", spin: { stiffness: 230, damping: 13 } },
      jelly: { squash: { stiffness: 540, damping: 12, limit: 0.2, across: 0.75, along: 1 } },
    });
    w.collider({
      shape: { box: [(LEDE_BOX.r - LEDE_BOX.l) / 2 + 4, (LEDE_BOX.b - LEDE_BOX.t) / 2 + 1], at: [LEDE_LEFT + (LEDE_BOX.l + LEDE_BOX.r) / 2, LEDE_TOP + (LEDE_BOX.t + LEDE_BOX.b) / 2], corner: 4 },
      layer: 4, restitution: 1, friction: 0.75,
      owner: { body: ledeBody, squash: 1 / 1400, squashLimit: 1, spin: 0.03, spinLimit: 40, minSpeed: 260 * U },
    });

    // letters: parked in the pocket until the spill
    LETTER_ART.forEach((l, i) => {
      const hw = l.w / 2 + 5 * SIZE, hh = l.ih / 2 + 5 * SIZE;
      const body = w.body({
        views: [sticker[i], { node: shadow[i], offset: [5 * SIZE, 7 * SIZE] }, ghost[i]],
        shape: { box: [hw, hh], corner: Math.min(hw, hh) * l.rcK },
        density: 0.2, inertia: 1.4, restitution: 1, friction: 0.55,
        layer: 2, mask: 1, hitSpeed: 300,
        asleep: true, position: [PX, PTOP + 40],
        anchor: {
          to: "layout", angle: S.HOME_R[i],
          spring: { stiffness: 190, damping: 13 }, spin: { stiffness: 230, damping: 13 }, airGravity: FS * 11,
        },
        jelly: {
          squash: { stiffness: 540, damping: 12, limit: 0.42, across: 0.6, along: 1 },
          impact: 8 / FS,
          land: LAND,
          lean: { stiffness: 320, damping: 11, gain: 3.2 / FS, limit: 14, impact: (2.2 / FS) * DEG },
          pulse: { stiffness: 340, damping: 20 },
          stretch: { gain: 0.055 / FS, limit: 0.16 },
          pivot: l.ih * 0.44,
        },
      });
      body.onLand((speed) => letterLanded(i, speed));
      body.onHit((hit) => {
        if (hit.speed > 520 * U) {
          // sparks fly off the letter, back toward the toy
          burstsTop.burst(hit.x, hit.y, 4, { angle: Math.atan2(-hit.ny, -hit.nx) * DEG, spread: 120, speed: 0.6 });
          if (i === O_INDEX && hit.speed > 850 * U) faceFor("wince", 0.6);
        }
      });
      letters.push(body);
    });

    burstsTop = w.emitter({
      views: burstTop,
      textures: [...PARTICLE_ART.burst, ...PARTICLE_ART.bdot],
      life: [0.62, 0.82], speed: [250, 470], size: [0.8, 1.25], spin: [0, 420], drag: 6, gravity: [0, 240],
      scale: "pop", alpha: "constant",
    });
    burstsBottom = w.emitter({
      views: burstBottom,
      textures: [...PARTICLE_ART.star, ...PARTICLE_ART.dot],
      life: [0.45, 0.85], speed: [260 * U, 760 * U], size: [0.45, 0.9], spin: [0, 500], gravity: [0, 1100 * U],
      scale: "constant", alpha: "fade",
    });
    ambient = w.emitter({
      views: twinkles,
      textures: [PARTICLE_ART.star[0], PARTICLE_ART.star[1], PARTICLE_ART.star[2]],
      life: [1.6, 2.8], speed: [30 * U, 70 * U], size: [0.25, 0.45], gravity: [0, -10 * U],
      scale: "constant", alpha: "twinkle", stream: { angle: -90, spread: 40 },
    });
    ambient.stream(3.2, PX - PW * 0.38, PTOP - 6, PW * 0.76, 6);
    scheduleIdle();
    scheduleBlink();
    peekSoon(1.2);
    tendSpecials();
  }

  // -- the pocket ------------------------------------------------------------------------
  function flash() {
    if (mouth) {
      animate(mouth, "scaleY", 0.62, { dur: 60, easing: "out" });
      later(0.08, () => mouth && animate(mouth, "scaleY", MOUTH_REST, { dur: 650, easing: "out" }));
    }
    if (glow) {
      animate(glow, "opacity", 1, { dur: 60, easing: "out" });
      later(0.1, () => glow && animate(glow, "opacity", 0, { dur: 800, easing: "out" }));
    }
  }
  function peek(seconds: number, happy: boolean) {
    if (!eyes) return;
    setEyeArt(happy ? POCKET_ART.happy : POCKET_ART.eyes);
    animate(eyes, "translateY", 0, { easing: "spring-bouncy" });
    later(seconds, () => eyes && animate(eyes, "translateY", EYES_HIDDEN, { dur: 260, easing: "in" }));
  }
  function peekSoon(seconds: number) {
    later(seconds, () => {
      if (phase === "sleep") {
        peek(rand(1.2, 2), false);
        pocket.kick({ spin: pick([-1, 1]) * rand(50, 80), squash: 3 });
      }
      peekSoon(rand(3.5, 6));
    });
  }
  function pocketBurst(n: number) {
    for (let i = 0; i < n; i++) burstsBottom.burst(PX + rand(-0.3, 0.3) * PW, PTOP - 2, 1, { angle: -90 + rand(-60, 60), spread: 0 });
  }
  function pop() {
    const now = virtualNow();
    if (now - lastPop < 0.1) return;
    lastPop = now;
    lastInteract = now;
    pocket.press(0);
    pocket.kick({ squash: -13 });
    flash();
    peek(0.8, true);
    spawn(nextType());
    pocketBurst(14);
    if (!userPopped && phase === "play") {
      userPopped = true;
      if (hint) animate(hint, "opacity", 0, { dur: 350 });
    }
  }

  // -- the spill -------------------------------------------------------------------------
  function open() {
    if (phase !== "sleep") return;
    phase = "spill";
    lastInteract = virtualNow();
    if (hint) animate(hint, "opacity", 0, { dur: 250 });
    // the pocket shivers, stretches up, then lets go
    pocket.press(-0.22);
    [70, -140, 140, -120, 90].forEach((spin, k) => later(k * 0.05, () => pocket.kick({ spin })));
    const base = 0.3;
    later(base - 0.02, () => pocket.press(0));
    LETTER_ART.forEach((_, i) => later(base + SPIT_AT[i], () => launch(i, SPIT_TF[i])));
    const end = base + SPIT_AT[10] + SPIT_TF[10];
    later(end - 0.38, () => popSpecial("pjs", 0.5));
    later(end - 0.28, () => {
      if (lede) animate(lede, "opacity", 1, { dur: 700, easing: "out" });
      if (copy) animate(copy, "opacity", 1, { dur: 700, easing: "out" });
    });
    later(end - 0.24, () => popSpecial("mystery", -0.44));
    later(end + 0.04, () => { phase = "play"; });
    later(end + 0.37, () => { if (!userPopped && hint) animate(hint, "opacity", 1, { dur: 400 }); });
  }
  function launch(i: number, tf: number) {
    // the core reads the slot from layout; the flight starts beneath it
    const [hx] = letters[i].home ?? [PX, 0];
    const l = LETTER_ART[i];
    const x0 = PX + clamp((hx - PX) * 0.12, -PW * 0.2, PW * 0.2);
    const y0 = PTOP + (l.ih / 2) * 0.25;
    const dir = hx >= x0 ? 1 : -1;
    setAt(shown, setShown, i, true);
    letters[i].launch({ from: [x0, y0], duration: tf, turn: dir * 360, endOffset: dir * rand(8, 15), arrive: FS * rand(3.9, 4.5), grow: 0.3 });
    if (i === O_INDEX) setOFace(O_FACE.wince);
    pocket.press(0);
    pocket.kick({ squash: -13 });
    flash();
    pocketBurst(9);
  }
  // every landing nudges the row neighbours; the spill's arrivals also throw sparks
  function letterLanded(i: number, speed: number) {
    const kick = clamp(speed * LAND.gain, LAND.min, LAND.max);
    for (const n of [i - 1, i + 1]) {
      if (n < 0 || n >= letters.length || (i < S.ROW_SPLIT) !== (n < S.ROW_SPLIT) || !shown()[n]) continue;
      letters[n].kick({ squash: kick * 0.38 });
      letters[n].impulse(0, FS * kick * 0.09);
    }
    if (phase === "spill") {
      const [x, y] = letters[i].home ?? [letters[i].x, letters[i].y];
      burstsTop.burst(x, y + LETTER_ART[i].ih * 0.4, 5, { angle: -90, spread: 150, speed: 0.45 });
      landed++;
      if (haze) animate(haze, "opacity", landed / LETTER_ART.length, { dur: 400, easing: "out" });
      if (i === O_INDEX) wake();
    }
  }
  // the O lands with its eyes shut, opens them, looks around and blinks
  function wake() {
    setOFace(O_FACE.shut);
    later(0.22, () => setOFace(O_FACE.open));
    later(0.44, () => setOFace(O_FACE.left));
    later(0.8, () => setOFace(O_FACE.right));
    later(1.12, () => setOFace(O_FACE.blink));
    later(1.25, () => setOFace(O_FACE.open));
  }
  let faceUntil = 0;
  function faceFor(state: keyof typeof O_FACE, seconds: number) {
    if (!shown()[O_INDEX]) return;
    setOFace(O_FACE[state]);
    faceUntil = virtualNow() + seconds;
    later(seconds, () => { if (virtualNow() >= faceUntil - 1e-6) setOFace(O_FACE.open); });
  }
  function scheduleBlink() {
    later(rand(2.2, 5.2), () => {
      if (oFace() === O_FACE.open) {
        setOFace(O_FACE.blink);
        later(0.13, () => { if (oFace() === O_FACE.blink) setOFace(O_FACE.open); });
      }
      scheduleBlink();
    });
  }
  function hop(i: number, power: number) {
    letters[i].hop(FS * 2.8 * power, 4 * power, 80 * power);
  }
  function wave() {
    if (phase !== "play") return;
    lastInteract = virtualNow();
    // a ripple along the word, spins alternating letter to letter
    letters.forEach((body, j) => {
      later(j * 0.055, () => body.kick({ squash: 3 }));
      later(j * 0.055 + 0.09, () => {
        body.hop(FS * 2.5, 5);
        body.kick({ spin: (j % 2 ? 1 : -1) * 70 });
      });
    });
    faceFor("happy", 0.9);
  }
  function scheduleIdle() {
    later(rand(4.2, 7.6), () => {
      if (phase === "play" && virtualNow() - lastInteract > 3.5 && !held) {
        const roll = random();
        if (roll < 0.45) hop(Math.floor(random() * letters.length), 0.45);
        else if (roll < 0.8) faceFor(pick(["left", "right"] as const), 1.1);
        else peek(rand(1.3, 2.3), false);
      }
      scheduleIdle();
    });
  }

  // -- toys ----------------------------------------------------------------------------------
  function nextType(): ToyType {
    spawnCount++;
    const alive = (type: ToyType) => toys.some((t) => t && !t.gone && t.type === type);
    if (spawnCount % 6 === 0 && !alive("pjs")) return "pjs";
    if (spawnCount % 8 === 4 && !alive("mystery")) return "mystery";
    if (bag.length === 0) {
      bag = [...REGULAR];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop()!;
  }
  /** A free node slot; else the oldest leaving toy's, else the oldest ordinary toy's. */
  function freeSlot(): number {
    const free = toys.findIndex((t) => !t);
    if (free >= 0) return free;
    const oldest = (ok: (t: Toy) => boolean) =>
      toys.reduce<Toy | undefined>((best, t) => (t && ok(t) && (!best || t.born < best.born) ? t : best), undefined);
    const toy = oldest((t) => t.gone) ?? oldest((t) => !TOYS[t.type].special) ?? toys[0]!;
    discard(toy);
    return toy.slot;
  }
  function discard(toy: Toy) {
    toy.gone = true;
    toy.body.destroy();
    if (grabbed === toy) grabbed = undefined;
    if (toys[toy.slot] !== toy) return;
    toys[toy.slot] = undefined;
    setAt(toyOn, setToyOn, toy.slot, false);
  }
  function fadeOut(toy: Toy) {
    toy.gone = true;
    animate(toyBottom[toy.slot], "opacity", 0, { dur: 600 });
    animate(toyTop[toy.slot], "opacity", 0, { dur: 600 });
    later(0.6, () => discard(toy));
  }
  /** Past LIVE_TOYS, the oldest ordinary toy that is not held fades out. */
  function enforceCap() {
    const live = toys.filter((t): t is Toy => !!t && !t.gone).sort((a, b) => a.born - b.born);
    let excess = live.length - LIVE_TOYS;
    for (const toy of live) {
      if (excess <= 0) break;
      if (TOYS[toy.type].special || toy === grabbed) continue;
      fadeOut(toy);
      excess--;
    }
  }
  function makeToy(type: ToyType, x: number, y: number, vx: number, vy: number, spin: number): Toy {
    const def = TOYS[type];
    const slot = freeSlot();
    const r = S.TOY_R * def.size * rand(0.94, 1.06);
    const scale = r / S.TOY_R;
    setAt(toySrc, setToySrc, slot, TOY_ART[type]);
    setAt(toySize, setToySize, slot, S.TOY_SPRITE * scale);
    setAt(toyOn, setToyOn, slot, true);
    for (const node of [toyBottom[slot], toyTop[slot]]) animate(node, "opacity", 1, { dur: 1 });
    const inertia = def.box ? (0.42 * 3) / (def.box[0] ** 2 + def.box[1] ** 2) : 0.5 / (0.5 * def.col * def.col);
    const body = world!.body({
      views: [toyBottom[slot], toyTop[slot]],
      shape: def.box ? { box: [def.box[0] * r, def.box[1] * r], corner: def.box[2] * r } : { circle: def.col * r },
      mass: r * r, inertia,
      restitution: def.e, friction: 0.35, bounceSpeed: 110 * U, hitSpeed: 420 * U,
      pickable: true, ghost: pocketWall, layer: 1, mask: 7,
      position: [x, y], velocity: [vx, vy], spin, angle: rand(-20, 20),
      maxSpin: 1600,
      // specials turn upright in the air; resting, tendSpecials hops them upright
      anchor: def.special ? { to: [0, 0], axes: ["angle"], spin: { stiffness: 16, damping: 1.4 }, free: true } : undefined,
      jelly: {
        squash: { stiffness: 900, damping: 20, limit: 0.35, across: 0.65, along: 1, axis: "impact" },
        dent: { gain: 1 / (5200 * U), limit: 0.3 },
        minSpeed: 260 * U,
      },
    });
    const toy: Toy = { slot, type, body, r, born: virtualNow(), touched: false, cleared: false, gone: false, side: 0, tilted: 0 };
    if (type === "mystery") mysteryHopAt = virtualNow() + rand(4, 8);
    body.onClear(() => { toy.cleared = true; });
    body.onHit((hit) => {
      if (hit.speed > 1100 * U && hit.ny < -0.7) burstsBottom.burst(hit.x, hit.y, 3, { angle: -90, spread: 90, speed: 0.35 });
    });
    toys[slot] = toy;
    enforceCap();
    return toy;
  }
  /** Out of the mouth on an arc that lands beside the pocket; now and then high
   *  enough to reach the top screen. `aim` in [-1, 1] picks the side and distance. */
  function spawn(type: ToyType, aim = 0, flat = false, spinScale = 1): Toy {
    const def = TOYS[type];
    const r = S.TOY_R * def.size;
    const x = PX + rand(-0.1, 0.1) * PW, y = PTOP + r * 0.25;
    sideFlip = random() < 0.8 ? -sideFlip : sideFlip;
    const side = aim ? Math.sign(aim) : sideFlip;
    const room = S.POCKET_TOP_Y - r * 0.8, lo = r + PAD + 8;
    const apex = !flat && random() < 0.3 ? rand(260, 440) : clamp(rand(0.55, 0.95) * room, lo, room);
    const vy = -Math.sqrt(2 * G * apex);
    const half = S.BOTTOM_W / 2 - r - 10, minD = Math.min(half, PW / 2 + r + 18);
    const dist = aim ? side * lerp(minD, half, Math.abs(aim)) : side * clamp(rand(0.18, 0.86) * half, minD, half);
    const dy = FLOOR - r - y;
    const tf = (-vy + Math.sqrt(vy * vy + 2 * G * dy)) / G;
    let vx = dist / tf;
    const need = (PW / 2 + r + 12) / ((2 * -vy) / G);
    if (Math.abs(vx) < need) vx = side * need;
    const spin = side * (def.special ? rand(0.5, 2) : rand(2, 9)) * DEG * spinScale;
    return makeToy(type, x, y, vx, vy, spin);
  }
  // the spill's specials plop down beside the pocket and stay near where they land
  function popSpecial(type: ToyType, aim: number) {
    pocket.kick({ squash: -11 });
    flash();
    const toy = spawn(type, aim, true, 0.4);
    toy.side = Math.sign(aim);
    toy.body.settle(0.22, 0.15);
    pocketBurst(8);
  }
  function spitOut(toy: Toy) {
    const vy = rand(700, 860) * U;
    const side = toy.side || (Math.abs(toy.body.x - PX) > 4 ? Math.sign(toy.body.x - PX) : pick([-1, 1]));
    const need = (PW / 2 + toy.r + 16) / ((2 * vy) / G);
    toy.body.teleport(toy.body.x, Math.min(toy.body.y, PTOP - PAD - toy.r * 0.6));
    toy.body.setVelocity(side * Math.max(need, rand(180, 320) * U), -vy, side * rand(4, 9) * DEG);
    toy.body.kick({ squash: 8 });
    pocket.kick({ squash: 7 });
    flash();
  }
  // into the mouth over 0.38 s: x eases in, y falls as t², the toy turns 6 rad/s and shrinks to half
  function swallow(toy: Toy) {
    if (grabbed === toy) release();
    toy.gone = true;
    const x = toy.body.x, y = toy.body.y;
    const to: [number, number] = [PX + (x - PX) * 0.3, PTOP + toy.r * 1.4];
    toy.body.launch({ from: [x, y], to, duration: 0.38, turn: 6 * 0.38 * DEG, arrive: (2 * (to[1] - y)) / 0.38, endScale: 0.5 });
    toy.body.onLand(() => discard(toy));
    pocket.kick({ squash: 5 });
    peek(1.2, true);
    for (let i = 0; i < 5; i++) ambient.burst(PX + rand(-0.2, 0.2) * PW, PTOP - 6, 1, { angle: -90, spread: 50, speed: rand(3, 5) });
  }
  // a special resting tilted past 0.45 rad for 0.8 s hops and turns upright
  // over its flight; the mystery box also hops now and then
  function tendSpecials() {
    const step = 0.2;
    later(step, () => {
      for (const toy of toys) {
        if (!toy || toy.gone || toy === grabbed || !TOYS[toy.type].special) continue;
        const b = toy.body;
        const off = wrapDeg(b.angle);
        if (b.speed < 45 * U && Math.abs(b.spin) < 1.5 * DEG && Math.abs(off) > 0.45 * DEG) {
          toy.tilted += step;
          if (toy.tilted > 0.8) {
            const vy = 560 * U;
            b.setVelocity(b.vx, -vy, -off / ((2 * vy) / G));
            b.kick({ squash: 3 });
            toy.tilted = 0;
          }
        } else toy.tilted = 0;
        if (toy.type === "mystery" && virtualNow() > mysteryHopAt) {
          mysteryHopAt = virtualNow() + rand(4, 8);
          const g = b.grounded;
          if (g >= 0 && g < 0.1 && Math.abs(b.vy) < 40) b.setVelocity(b.vx, -rand(280, 420) * U, b.spin + rand(-3, 3) * DEG);
        }
      }
      tendSpecials();
    });
  }
  function tapToy(toy: Toy) {
    const b = toy.body;
    if (toy.type === "mystery") {
      b.setVelocity(b.vx, Math.min(b.vy, -330 * U), b.spin + rand(-120, 120));
      b.kick({ spin: pick([-1, 1]) * 400 });
      return;
    }
    b.setVelocity(b.vx, Math.min(b.vy, -620 * U), b.spin + rand(-570, 570));
    b.kick({ squash: 8 });
  }

  // -- the stylus ---------------------------------------------------------------------------
  let grabbed: Toy | undefined;
  let held = false;
  let pressedPocket = false;
  let downAt = 0, downX = 0, downY = 0, moved = 0;
  let lastTap = { t: -1, x: 0, y: 0 };
  const onPocket = (x: number, y: number) =>
    Math.abs(x - S.POCKET_CX) < PW / 2 + S.POCKET_LW && y > S.POCKET_TOP_Y - 14 && y < S.POCKET_TIP_Y + 6;
  function release() {
    if (!grabbed) return;
    grabbed.body.release();
    grabbed = undefined;
  }
  createGesture({
    surface: "auxiliary",
    onDown(c) {
      held = true;
      downAt = virtualNow(); downX = c.x; downY = c.y; moved = 0;
      lastInteract = downAt;
      if (!world) return;
      const body = world.pick(c.x, c.y, "auxiliary", 8);
      const toy = body && toys.find((t) => t?.body === body && !t.gone);
      if (toy) {
        grabbed = toy;
        toy.touched = true;
        toy.body.grab(c.x, c.y, { surface: "auxiliary" });
        return;
      }
      if (onPocket(c.x, c.y)) {
        pressedPocket = true;
        pocket.press(0.75);
        return;
      }
      burstsBottom.burst(...world.toWorld(c.x, c.y, "auxiliary"), 6, { angle: 0, spread: 360, speed: 0.28 });
      if (downAt - lastTap.t < 0.34 && Math.hypot(c.x - lastTap.x, c.y - lastTap.y) < 40) {
        wave();
        lastTap = { t: -1, x: 0, y: 0 };
      } else lastTap = { t: downAt, x: c.x, y: c.y };
    },
    onMove(c) {
      moved = Math.max(moved, Math.hypot(c.x - downX, c.y - downY));
      if (grabbed) grabbed.body.drag(c.x, c.y, "auxiliary");
    },
    onUp() {
      held = false;
      if (grabbed) {
        const toy = grabbed;
        release();
        if (moved < 8 && virtualNow() - downAt < 0.4) tapToy(toy);
        return;
      }
      if (pressedPocket) {
        pressedPocket = false;
        pocket.press(0);
        if (phase === "sleep") open();
        else if (phase === "play") pop();
      }
    },
    onCancel() {
      held = false;
      release();
      if (pressedPocket) {
        pressedPocket = false;
        pocket.press(0);
      }
    },
  });

  // -- buttons -----------------------------------------------------------------------------
  onButtonPress(BTN.CIRCLE, () => (phase === "sleep" ? open() : wave()));
  onButtonPress(BTN.TRIANGLE | BTN.SQUARE, () => { if (phase === "play") pop(); });
  onButtonPress(BTN.CROSS, () => { if (phase === "play") { lastInteract = virtualNow(); hop(Math.floor(random() * letters.length), 1); } });
  let tilt = 0;
  onFrame((buttons) => {
    if (!world) return;
    // d-pad or shoulders tilt the world
    const left = buttons & (BTN.LEFT | BTN.LTRIGGER), right = buttons & (BTN.RIGHT | BTN.RTRIGGER);
    const next = (right ? 1 : 0) - (left ? 1 : 0);
    if (next !== tilt) {
      tilt = next;
      world.setGravity(tilt * G * 0.45, G);
    }
  });

  // -- the view --------------------------------------------------------------------------
  const pool = (list: NodeMirror[], count: number, src: string) =>
    <For each={Array.from({ length: count }, (_, i) => i)}>
      {(i) => <Image ref={(el) => (list[i] = el)} src={src} style={box(0, 0, S.PARTICLE_SPRITE, S.PARTICLE_SPRITE, { opacity: 0 })} />}
    </For>;
  const toyLayer = (list: NodeMirror[]) =>
    <For each={Array.from({ length: TOY_CAP }, (_, i) => i)}>
      {(i) => (
        <Image
          ref={(el) => (list[i] = el)}
          src={toySrc()[i]}
          style={box(0, 0, toySize()[i], toySize()[i], { opacity: toyOn()[i] ? 1 : 0 })}
        />
      )}
    </For>;

  return (
    <View style={box(0, 0, S.TOP_W, S.TOP_H)}>
      <Image src={BACKDROP_ART.top} style={box(0, 0, 512, 256)} />
      <Image ref={(el) => (haze = el)} src={BACKDROP_ART.haze} style={box(S.TOP_W / 2 - 256, S.WORD_TOP + WORD_BOX.h / 2 - 128, 512, 256, { opacity: 0 })} />
      {toyLayer(toyTop)}
      <View style={box(0, S.WORD_TOP, S.TOP_W, WORD_BOX.h, { flexDir: 1, align: 1, gap: S.ROW_GAP })}>
        <For each={ROWS}>
          {(row, r) => (
            <View style={{ flexDir: 0, gap: S.LETTER_GAP, height: ROW_H }}>
              <For each={row}>
                {(l, k) => {
                  const i = r() * S.ROW_SPLIT + k();
                  const left = (l.w - S.LETTER_SPRITE) / 2, top = (ROW_H - S.LETTER_SPRITE) / 2 + S.HOME_Y[i] * FS;
                  return (
                    <View style={{ width: l.w, height: ROW_H }}>
                      <View ref={(el) => (shadow[i] = el)} style={box(left, top, S.LETTER_SPRITE, S.LETTER_SPRITE, { opacity: shown()[i] ? 1 : 0 })}>
                        <Image class={BOB[i]} src={l.shadow} style={box(0, 0, S.LETTER_SPRITE, S.LETTER_SPRITE, { opacity: 0.9 })} />
                      </View>
                      <View ref={(el) => (sticker[i] = el)} style={box(left, top, S.LETTER_SPRITE, S.LETTER_SPRITE, { opacity: shown()[i] ? 1 : 0 })}>
                        <Image class={BOB[i]} src={i === O_INDEX ? oFace() : l.src} style={box(0, 0, S.LETTER_SPRITE, S.LETTER_SPRITE)} />
                      </View>
                    </View>
                  );
                }}
              </For>
            </View>
          )}
        </For>
      </View>
      <Image ref={(el) => (lede = el)} src={LEDE_ART} style={box(LEDE_LEFT, LEDE_TOP, 512, 64, { opacity: 0 })} />
      {pool(burstTop, 24, PARTICLE_ART.burst[0])}
      <Image ref={(el) => (copy = el)} src={COPY_ART} style={box(10, S.TOP_H - 20, 128, 16, { opacity: 0 })} />

      <AuxiliarySurface>
        <View style={box(0, 0, S.BOTTOM_W, S.BOTTOM_H)}>
          <Image src={BACKDROP_ART.bottom} style={box(0, 0, 512, 256)} />
          <Image ref={(el) => (glow = el)} src={BACKDROP_ART.glow} style={box(S.POCKET_CX - 128, S.POCKET_TOP_Y - 64, 256, 128, { opacity: 0 })} />
          {pool(twinkles, 12, PARTICLE_ART.star[0])}
          <View ref={(el) => (backWrap = el)} style={box(POCKET_LEFT, POCKET_TOP, S.POCKET_SPRITE, S.POCKET_SPRITE)}>
            <Image ref={(el) => (mouth = el)} src={POCKET_ART.mouth} style={box(0, MOUTH_Y - 16, 128, 32, { scaleY: MOUTH_REST })} />
          </View>
          <For each={LETTER_ART}>
            {(l, i) => (
              <View ref={(el) => (ghost[i()] = el)} style={box(0, 0, S.LETTER_SPRITE, S.LETTER_SPRITE, { opacity: shown()[i()] ? 1 : 0 })}>
                <Image src={i() === O_INDEX ? oFace() : l.src} style={box(0, 0, S.LETTER_SPRITE, S.LETTER_SPRITE)} />
              </View>
            )}
          </For>
          <View ref={(el) => (eyesWrap = el)} style={box(POCKET_LEFT, POCKET_TOP, S.POCKET_SPRITE, S.POCKET_SPRITE)}>
            <Image ref={(el) => (eyes = el)} src={eyeArt()} style={box(32, EYES_SHOWN_Y - 16, 64, 32, { translateY: EYES_HIDDEN })} />
          </View>
          {toyLayer(toyBottom)}
          <View ref={(el) => (frontWrap = el)} style={box(POCKET_LEFT, POCKET_TOP, S.POCKET_SPRITE, S.POCKET_SPRITE)}>
            <Image class="animate-breathe" src={POCKET_ART.front} style={box(0, 0, S.POCKET_SPRITE, S.POCKET_SPRITE, { originY: POCKET_PIVOT / S.POCKET_SPRITE })} />
          </View>
          {pool(burstBottom, 32, PARTICLE_ART.star[0])}
          <View style={box(S.POCKET_CX - 34, S.POCKET_TOP_Y - 70, 128, 64)}>
            <Image ref={(el) => (hint = el)} class="animate-nudge" src={HINT_ART} style={box(0, 0, 128, 64)} />
          </View>
          <AfterMount run={setup} />
        </View>
      </AuxiliarySurface>
    </View>
  );
}
