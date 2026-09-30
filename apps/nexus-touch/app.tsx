// apps/nexus-touch/app.tsx — the pocket.nexus homepage on a 320x480 touch screen.
//
// The homepage's one interactive screen, laid out by the homepage itself
// (gen-art.ts measures the page at this size) and moved by its springs at
// its phone scale U, expressed as @pocketjs/framework/physics bodies. On
// launch the pocket wakes and spills POCKET NEXUS into the wordmark. Then:
// tap the pocket for toys; grab, fling and tap the toys; tap a letter and it
// hops and talks; drag a letter away and it springs home, or drop it in the
// pocket's mouth and the pocket chews and spits it back; double-tap the sky
// for a wave through the word.
//
// The app declares bodies and issues commands at interaction edges; the core
// integrates every tick and writes the poses into the nodes. Per-frame JS is
// the eyes (the O and the pocket watch what the finger is doing) and the
// speech bubbles that ride on toys.

import { createSignal, For, onCleanup, onMount } from "solid-js";
import { Image, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, createJumpBatch, jump, type JumpBatch } from "@pocketjs/framework/animation";
import { after, virtualNow } from "@pocketjs/framework/clock";
import { createGesture, type GestureContact } from "@pocketjs/framework/gesture";
import { getOps, reportAppAction } from "@pocketjs/framework/host";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createWorld, type Body, type Collider, type Emitter, type World } from "@pocketjs/framework/physics";
import * as S from "./scene.ts";
import {
  COPY, FS, GLOW_ART, HAZE_ART, HAZE_BOX, HINT, LEDE, LETTER_ART, O_EYE, O_EYES, O_FACE, PARTICLE_ART, POCKET_ART,
  SKY_TILES, TAG_ART, TOY_ART, TOY_SHADOW, type TagArt,
} from "./art.ts";

// ---- numbers from the homepage ---------------------------------------------------------

const U = S.U;
const G = S.G;
const DEG = 180 / Math.PI;
const SIZE = FS / 100;
const LS = S.LETTER_SPRITE;
const SPIT_AT = [0, 0.25, 0.47, 0.66, 0.83, 0.98, 1.16, 1.28, 1.39, 1.49, 1.58];
const SPIT_TF = [0.66, 0.64, 0.62, 0.6, 0.58, 0.56, 0.56, 0.54, 0.52, 0.5, 0.5];
/** The spill starts once the pocket has woken up (the homepage's base). */
const SPILL_AT = 0.74;
const BOB = ["animate-bob-0", "animate-bob-1", "animate-bob-2", "animate-bob-3", "animate-bob-4", "animate-bob-5",
  "animate-bob-6", "animate-bob-7", "animate-bob-8", "animate-bob-9", "animate-bob-10"];
/** Toy node slots, and the live toys kept before the oldest fades out. */
const TOY_CAP = 16;
const LIVE_TOYS = 14;
/** Speech-bubble node slots: the PocketJS tag and two bubbles, each in a
 *  box as large as the largest bubble sprite. */
const TAG_SLOTS = 3;
const TAG_BOX_W = 128;
const TAG_BOX_H = 64;
/** A letter's landing squash: velocity per px/s, clamped, with a spin kick (°/s per unit). */
const LAND = { gain: 1.55 / FS, min: 1.4, max: 6.4, spin: 9 };
const O_INDEX = LETTER_ART.findIndex((l) => l.ch === "O");

/** Pocket landmarks in screen px. */
const PX = S.POCKET_CX;
const PTOP = S.POCKET_TOP_Y;
const FLOOR = S.FLOOR_Y;
const PW = S.POCKET_PW;
const PH = S.POCKET_PH;
const K = S.POCKET_K;
const PAD = S.POCKET_PAD;
/** The pocket's sprite frame, placed so its tip lands on the floor line. */
const POCKET_LEFT = PX - S.POCKET_SPRITE_W / 2;
const POCKET_TOP = S.POCKET_TIP_Y - S.POCKET_TIP_IN_SPRITE;
const POCKET_PIVOT = S.POCKET_TIP_IN_SPRITE - S.POCKET_SPRITE_H / 2;
/** The mouth line in sprite px; the mouth is drawn open and squashed with scaleY. */
const MOUTH_Y = S.POCKET_TIP_IN_SPRITE - 15 * K;
const MOUTH_REST = S.MOUTH_REST;
const MOUTH_FLASH = S.mouthScale(1.06);
const MOUTH_HUNGRY = S.mouthScale(0.91);
/** The eyes peek over the rim; hidden, they sit behind the pocket's front. */
const ERY = 1.5 * K;
const EYES_Y = MOUTH_Y - ERY * 0.62 - 0.3 * 0.24 * K;
const EYES_HIDDEN = ERY * 1.62 + S.POCKET_LW + 0.3 * 0.24 * K;
/** Where the pocket's eyes look from, screen px. */
const EYE_X = PX;
const EYE_Y = PTOP - 1.2 * K;
/** The top of the text the toys arc under (the homepage's textBottom). */
const TEXT_BOTTOM = LEDE.ink.b + 6;

interface ToyDef { size: number; col: number; e: number; box?: readonly [number, number, number]; special?: boolean; top: number }
const TOYS: Record<keyof typeof TOY_ART, ToyDef> = {
  star: { size: 1.0, col: 0.9, e: 0.5, top: 1 },
  spark: { size: 0.88, col: 0.66, e: 0.55, top: 1 },
  heart: { size: 0.84, col: 0.9, e: 0.42, top: 1 },
  cursor: { size: 0.86, col: 0.78, e: 0.38, top: 1 },
  gear: { size: 0.95, col: 0.95, e: 0.3, top: 1 },
  bolt: { size: 0.9, col: 0.72, e: 0.45, top: 1 },
  cart: { size: 0.95, col: 0.9, e: 0.22, box: [0.8, 0.96, 0.16], top: 0.96 },
  planet: { size: 1.08, col: 0.8, e: 0.42, top: 1 },
  bubble: { size: 0.95, col: 0.9, e: 0.3, box: [0.96, 0.8, 0.3], top: 0.8 },
  dpad: { size: 0.9, col: 0.92, e: 0.36, top: 1 },
  ghost: { size: 0.92, col: 0.92, e: 0.3, box: [0.95, 0.95, 0.24], top: 0.95 },
  ball: { size: 0.64, col: 1.0, e: 0.8, top: 1 },
  pjs: { size: 1.28, col: 0.86, e: 0.22, box: [1, 0.72, 0.4], special: true, top: 0.98 },
  mystery: { size: 1.0, col: 0.95, e: 0.2, box: [0.86, 0.86, 0.2], special: true, top: 0.86 },
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

/** Runs `run` once the nodes before it exist. */
function AfterMount(props: { run: () => void }) {
  onMount(() => props.run());
  return null;
}

/** Style object for an absolutely placed box. */
function box(x: number, y: number, w: number, h: number, extra: Record<string, number> = {}) {
  return { posType: 1, insetL: x, insetT: y, width: w, height: h, ...extra };
}

/** spec PROP.originX / originY: set directly, they are not animatable. */
const PROP_ORIGIN_X = 134;
const PROP_ORIGIN_Y = 135;

/** A letter's collision half-extents (the homepage's hw/hh). */
const halfW = (i: number) => LETTER_ART[i].w / 2 + 5 * SIZE;
const halfH = (i: number) => LETTER_ART[i].ih / 2 + 5 * SIZE;

/**
 * Seconds after take-off at which a flight from the mouth clears the
 * pocket's rim: the homepage's `emerging`, while the letter is drawn behind
 * the pocket's front. The flight is the core's launch parabola, which
 * arrives `tf` s later moving down at `arrive` px/s.
 */
function emergeAfter(y0: number, y1: number, tf: number, arrive: number, hh: number): number {
  const dy = y1 - y0, g = (2 * (arrive - dy / tf)) / tf, vy = dy / tf - (g * tf) / 2;
  const c = y0 + hh * 0.55 - PTOP;
  if (c <= 0) return 0;
  const disc = vy * vy - 2 * g * c;
  if (disc < 0 || g <= 0) return 0.4;
  return clamp((-vy - Math.sqrt(disc)) / g, 0, 0.4);
}

type LetterState = "hidden" | "flight" | "home" | "carry" | "swallow" | "inside";
type OMood = "look" | "talk" | "happy" | "wince" | "shut";

export default function Nexus() {
  // -- nodes ---------------------------------------------------------------------
  const sticker: NodeMirror[] = [];
  const shadow: NodeMirror[] = [];
  const shadowArt: NodeMirror[] = [];
  const ghost: NodeMirror[] = [];
  const toyNode: NodeMirror[] = [];
  const toyShadow: NodeMirror[] = [];
  const bursts: NodeMirror[] = [];
  const sparks: NodeMirror[] = [];
  const twinkles: NodeMirror[] = [];
  const tagNode: NodeMirror[] = [];
  let backWrap: NodeMirror | undefined, eyesWrap: NodeMirror | undefined, frontWrap: NodeMirror | undefined;
  let mouth: NodeMirror | undefined, eyes: NodeMirror | undefined, pupils: NodeMirror | undefined, glow: NodeMirror | undefined;
  let haze: NodeMirror | undefined, ledeWrap: NodeMirror | undefined, copy: NodeMirror | undefined, hint: NodeMirror | undefined;
  let oEyes: NodeMirror | undefined;

  // -- reactive bits (only at edges) ---------------------------------------------------
  const [oFace, setOFace] = createSignal<string>(O_FACE.shut);
  const [eyeHappy, setEyeHappy] = createSignal(false);
  // one signal per slot, so a change re-applies only that node's style
  const toyArt = Array.from({ length: TOY_CAP }, () => createSignal<{ src: string; size: number }>({ src: TOY_ART.star, size: S.TOY_SPRITE }));
  const tagArt = Array.from({ length: TAG_SLOTS }, () => createSignal<TagArt>(TAG_ART.pjs));

  // -- the world -------------------------------------------------------------------
  let world: World | undefined;
  let pocket: Body;
  let pocketWall: Collider;
  const letters: Body[] = [];
  const state: LetterState[] = LETTER_ART.map(() => "hidden");
  let burstFx: Emitter, sparkFx: Emitter, ambient: Emitter;
  interface Toy {
    slot: number; type: ToyType; body: Body; r: number; born: number;
    touched: boolean; cleared: boolean; gone: boolean;
    /** The side a special was aimed at; spitOut sends it back there. */
    side: number;
    /** Seconds a special has rested tilted. */
    tilted: number;
  }
  const toys: (Toy | undefined)[] = Array.from({ length: TOY_CAP }, () => undefined);
  let phase: "intro" | "play" = "intro";
  let lastPop = -1, lastInteract = 0, landed = 0, userPopped = false, spawnCount = 0, sideFlip = 1, mysteryHopAt = 0;
  let actions = 0;
  let bag: ToyType[] = [];
  const act = () => reportAppAction("nexus_play", ++actions);
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
    const w = createWorld({ gravity: [0, G], substeps: 2, seed: 20260930, maxSpeed: 4200 * U });
    world = w;
    // the room: walls 4 px in from the screen's sides, the top edge, the floor line
    w.collider({
      shape: { chain: [[0, -4], [0, FLOOR + 4], [S.W, FLOOR + 4], [S.W, -4]], radius: 4, closed: true },
      layer: 4, restitution: 1, friction: 0.75,
    });
    pocket = w.body({
      views: [backWrap!, eyesWrap!, frontWrap!],
      mass: 0,
      anchor: { to: "layout", spin: { stiffness: 170, damping: 5 } },
      jelly: { squash: { stiffness: 560, damping: 15, limit: 2, across: 0.12, along: 0.15 }, pulse: { stiffness: 340, damping: 20 }, pivot: POCKET_PIVOT },
    });
    const outline = S.POCKET_OUTLINE.map(([x, y]) => S.pocketPoint(x, y));
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
      views: [ledeWrap!],
      mass: 0,
      anchor: { to: "layout", spin: { stiffness: 230, damping: 13 } },
      jelly: { squash: { stiffness: 540, damping: 12, limit: 0.2, across: 0.75, along: 1 } },
    });
    const ink = LEDE.ink;
    w.collider({
      shape: { box: [(ink.r - ink.l) / 2 + 4, (ink.b - ink.t) / 2 + 1], at: [(ink.l + ink.r) / 2, (ink.t + ink.b) / 2 + 1], corner: 4 },
      layer: 4, restitution: 1, friction: 0.75,
      owner: { body: ledeBody, squash: 1 / 1400, squashLimit: 1, spin: 0.03, spinLimit: 40, minSpeed: 260 * U },
    });

    // letters: parked in the pocket until the spill
    LETTER_ART.forEach((l, i) => {
      const hw = halfW(i), hh = halfH(i);
      const body = w.body({
        views: [sticker[i], { node: shadow[i], offset: [5 * SIZE, 7 * SIZE] }, ghost[i]],
        shape: { box: [hw, hh], corner: Math.min(hw, hh) * l.rcK },
        density: 0.2, inertia: 1.4, restitution: 1, friction: 0.55,
        layer: 2, mask: 1, hitSpeed: 300, pickable: true,
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
          burstFx.burst(hit.x, hit.y, 4, { angle: Math.atan2(-hit.ny, -hit.nx) * DEG, spread: 120, speed: 0.6 });
          if (i === O_INDEX && hit.speed > 850 * U && state[i] === "home") { faceMood("wince", 0.6); openMouth(0.5); }
        }
      });
      letters.push(body);
    });

    burstFx = w.emitter({
      views: bursts,
      textures: [...PARTICLE_ART.burst, ...PARTICLE_ART.bdot],
      life: [0.62, 0.82], speed: [170, 315], size: [0.75, 1.25], spin: [0, 420], drag: 6, gravity: [0, 240],
      scale: "pop", alpha: "constant",
    });
    sparkFx = w.emitter({
      views: sparks,
      textures: [...PARTICLE_ART.star, ...PARTICLE_ART.dot],
      life: [0.45, 0.85], speed: [260 * U, 760 * U], size: [0.45, 0.8], spin: [0, 500], gravity: [0, 1100 * U],
      scale: "constant", alpha: "fade",
    });
    ambient = w.emitter({
      views: twinkles,
      textures: [PARTICLE_ART.star[0], PARTICLE_ART.star[1], PARTICLE_ART.star[2]],
      life: [1.6, 2.8], speed: [30 * U, 70 * U], size: [0.25, 0.45], gravity: [0, -10 * U],
      scale: "constant", alpha: "twinkle", stream: { angle: -90, spread: 40 },
    });
    ambient.stream(3.2, PX - PW * 0.38, PTOP - 6, PW * 0.76, 6);
    for (let i = 0; i < TAG_SLOTS; i++) jump(tagNode[i], "scale", 0.3);
    shadowBatch = createJumpBatch(toyShadow.flatMap((node) => [[node, "translateX"], [node, "scaleX"], [node, "scaleY"], [node, "opacity"]] as const));
    wakeUp();
    scheduleIdle();
    schedulePocketIdle();
    scheduleBlink();
    schedulePocketBlink();
    tendSpecials();
  }

  // -- the pocket ------------------------------------------------------------------------
  function flash() {
    if (mouth) {
      animate(mouth, "scaleY", MOUTH_FLASH, { dur: 60, easing: "out" });
      later(0.08, () => mouth && !hungry && animate(mouth, "scaleY", MOUTH_REST, { dur: 650, easing: "out" }));
    }
    if (glow) {
      animate(glow, "opacity", 1, { dur: 60, easing: "out" });
      later(0.1, () => glow && animate(glow, "opacity", 0, { dur: 800, easing: "out" }));
    }
  }
  // The eyes peek while the pocket is happy (arcs), hungry or idly curious.
  let happyUntil = 0, peekUntil = 0, hungry = false, eyesUp = false;
  let lookX = 0, lookY = -0.4, idleLook = 0;
  function updateEyes() {
    if (!eyes) return;
    const now = virtualNow();
    const happy = now < happyUntil;
    if (happy !== eyeHappy()) setEyeHappy(happy);
    const want = happy || hungry || now < peekUntil;
    if (want === eyesUp) return;
    eyesUp = want;
    animate(eyes, "translateY", want ? 0 : EYES_HIDDEN, want ? { easing: "spring-bouncy" } : { dur: 260, easing: "in" });
  }
  function happyFor(seconds: number) {
    happyUntil = Math.max(happyUntil, virtualNow() + seconds);
    updateEyes();
    later(seconds + 0.01, updateEyes);
  }
  function peekFor(seconds: number, look: number) {
    peekUntil = Math.max(peekUntil, virtualNow() + seconds);
    idleLook = look;
    updateEyes();
    later(seconds + 0.01, updateEyes);
  }
  function setHungry(on: boolean) {
    if (on === hungry) return;
    hungry = on;
    pocket.press(0, on ? 1.045 : 1);
    if (mouth) animate(mouth, "scaleY", on ? MOUTH_HUNGRY : MOUTH_REST, { dur: on ? 160 : 300, easing: "out" });
    if (eyes) animate(eyes, "scale", on ? 1.18 : 1, { dur: 160, easing: "out" });
    updateEyes();
  }
  function pocketBurst(n: number) {
    for (let i = 0; i < n; i++) sparkFx.burst(PX + rand(-0.3, 0.3) * PW, PTOP - 2, 1, { angle: -90 + rand(-60, 60), spread: 0 });
  }
  function pop() {
    const now = virtualNow();
    if (now - lastPop < 0.1) return;
    lastPop = now;
    lastInteract = now;
    pocket.press(0);
    pocket.kick({ squash: -13 });
    flash();
    happyFor(0.45);
    spawn(nextType());
    pocketBurst(14);
    act();
    if (!userPopped) {
      userPopped = true;
      if (hint) animate(hint, "opacity", 0, { dur: 350 });
    }
  }

  // -- the intro: the pocket wakes up and spills the word ----------------------------------
  function wakeUp() {
    later(0.1, () => pocket.kick({ squash: 7 }));
    later(0.2, () => peekFor(0.62, -0.9));
    later(0.46, () => { idleLook = 0.9; });
    // the pocket shivers, stretches up, then lets go
    later(SPILL_AT - 0.26, () => {
      pocket.press(-0.22);
      [70, -140, 140, -120, 90].forEach((spin, k) => later(k * 0.05, () => pocket.kick({ spin })));
    });
    later(SPILL_AT - 0.02, () => pocket.press(0));
    LETTER_ART.forEach((_, i) => later(SPILL_AT + SPIT_AT[i], () => launch(i, SPIT_TF[i])));
    const end = SPILL_AT + SPIT_AT[10] + SPIT_TF[10];
    later(end - 0.38, () => popSpecial("pjs", 0.5));
    later(end - 0.28, () => {
      if (ledeWrap) animate(ledeWrap, "opacity", 1, { dur: 700, easing: "out" });
      if (copy) animate(copy, "opacity", 1, { dur: 700, easing: "out" });
    });
    later(end - 0.24, () => popSpecial("mystery", -0.44));
    later(end + 0.04, () => { phase = "play"; });
    later(end + 0.37, () => { if (!userPopped && hint) animate(hint, "opacity", 1, { dur: 500 }); });
  }
  /** Out of the mouth on the homepage's arc into the letter's slot. */
  function launch(i: number, tf: number) {
    const [hx, hy] = LETTER_ART[i].home;
    const hh = halfH(i);
    const x0 = PX + clamp((hx - PX) * 0.12, -PW * 0.2, PW * 0.2);
    const y0 = PTOP + hh * 0.25;
    const dir = hx >= x0 ? 1 : -1;
    const arrive = FS * rand(3.9, 4.5);
    state[i] = "flight";
    // drawn behind the pocket's front until it clears the rim
    showGhost(i, true);
    later(emergeAfter(y0, hy, tf, arrive, hh), () => { if (state[i] === "flight") showGhost(i, false); });
    letters[i].launch({ from: [x0, y0], duration: tf, turn: dir * 360, endOffset: dir * rand(8, 15), arrive, grow: 0.3 });
    if (i === O_INDEX) setMood("wince");
    pocket.press(0);
    pocket.kick({ squash: -13 });
    flash();
    happyFor(0.55);
    pocketBurst(9);
  }
  function showGhost(i: number, on: boolean) {
    jump(ghost[i], "opacity", on ? 1 : 0);
    jump(sticker[i], "opacity", on ? 0 : 1);
    jump(shadow[i], "opacity", on ? 0 : 1);
  }
  // every landing nudges the row neighbours; arrivals from the pocket throw sparks
  function letterLanded(i: number, speed: number) {
    if (state[i] === "swallow") {
      // inside: park the letter out of sight until the pocket spits it back
      state[i] = "inside";
      jump(ghost[i], "opacity", 0);
      letters[i].setAnchor(PX, S.H + 200, S.HOME_R[i]);
      letters[i].teleport(PX, S.H + 200);
      return;
    }
    const kick = clamp(speed * LAND.gain, LAND.min, LAND.max);
    for (const n of [i - 1, i + 1]) {
      if (n < 0 || n >= letters.length || (i < S.ROW_SPLIT) !== (n < S.ROW_SPLIT) || state[n] !== "home") continue;
      letters[n].kick({ squash: kick * 0.38 });
      letters[n].impulse(0, FS * kick * 0.09);
    }
    if (state[i] !== "flight") return;
    state[i] = "home";
    showGhost(i, false);
    const [x, y] = LETTER_ART[i].home;
    burstFx.burst(x, y + LETTER_ART[i].ih * 0.4, 5, { angle: -90, spread: 150, speed: 0.45 });
    if (landed < LETTER_ART.length) {
      landed++;
      if (haze) animate(haze, "opacity", landed / LETTER_ART.length, { dur: 400, easing: "out" });
    }
    if (i === O_INDEX) wake();
  }

  // -- the O's face ------------------------------------------------------------------------------
  // The eyes are nodes over the face layer; they follow whatever the finger
  // is doing, look around when idle, and blink.
  let mood: OMood = "shut";
  let moodUntil = 0, mouthUntil = 0;
  let oLookX = 0, oLookY = 0, oScript: readonly [number, number] | null = null;
  let oIdleX = 0, oIdleY = 0, oIdleUntil = 0;
  function setMood(next: OMood) {
    mood = next;
    setOFace(O_FACE[next]);
    if (oEyes) jump(oEyes, "opacity", next === "look" || next === "talk" ? 1 : 0);
  }
  /** Back to open eyes, with the mouth open while it is talking. */
  function settleMood() {
    if (state[O_INDEX] === "carry" || state[O_INDEX] === "swallow" || state[O_INDEX] === "flight") return;
    const now = virtualNow();
    if (now < moodUntil - 1e-6) return;
    setMood(now < mouthUntil - 1e-6 ? "talk" : "look");
  }
  function faceMood(next: "happy" | "wince", seconds: number) {
    if (state[O_INDEX] !== "home") return;
    setMood(next);
    moodUntil = virtualNow() + seconds;
    later(seconds, settleMood);
  }
  function openMouth(seconds: number) {
    mouthUntil = Math.max(mouthUntil, virtualNow() + seconds);
    if (mood === "look") setMood("talk");
    later(seconds, settleMood);
  }
  // the O lands with its eyes shut, opens them, looks around and blinks
  function wake() {
    setMood("shut");
    oScript = null;
    later(0.22, () => setMood("look"));
    later(0.44, () => { oScript = [-3.2, -0.9]; });
    later(0.8, () => { oScript = [3.2, -0.6]; });
    later(1.12, () => { oScript = [0, 0.4]; blinkO(); });
    later(1.4, () => { oScript = null; });
  }
  function blinkO() {
    if (!oEyes || (mood !== "look" && mood !== "talk")) return;
    jump(oEyes, "scaleY", 0.12);
    later(0.13, () => oEyes && jump(oEyes, "scaleY", 1));
  }
  function scheduleBlink() {
    later(rand(2.2, 5.2), () => {
      blinkO();
      if (random() < 0.25) later(0.26, blinkO);
      scheduleBlink();
    });
  }
  function blinkPocket() {
    if (!pupils || !eyes || eyeHappy()) return;
    jump(eyes, "scaleY", 0.12);
    later(0.13, () => eyes && jump(eyes, "scaleY", 1));
  }
  function schedulePocketBlink() {
    later(rand(2.2, 4.8), () => {
      blinkPocket();
      schedulePocketBlink();
    });
  }

  function hop(i: number, power: number) {
    if (state[i] !== "home") return;
    letters[i].hop(FS * 2.8 * power, 4 * power, 80 * power);
  }
  function wave() {
    if (phase !== "play") return;
    lastInteract = virtualNow();
    // a ripple along the word, spins alternating letter to letter
    letters.forEach((body, j) => {
      later(j * 0.055, () => { if (state[j] === "home") body.kick({ squash: 3 }); });
      later(j * 0.055 + 0.09, () => {
        if (state[j] !== "home") return;
        body.hop(FS * 2.5, 5);
        body.kick({ spin: (j % 2 ? 1 : -1) * 70 });
      });
    });
    faceMood("happy", 0.9);
    act();
  }
  function scheduleIdle() {
    later(rand(4.2, 7.6), () => {
      if (phase === "play" && virtualNow() - lastInteract > 3.5 && holds.size === 0) {
        const roll = random();
        if (roll < 0.45) hop(Math.floor(random() * letters.length), 0.45);
        else if (roll < 0.85) { oIdleX = rand(-3.2, 3.2); oIdleY = rand(-2.4, 2.4); oIdleUntil = virtualNow() + 1.4; }
      }
      scheduleIdle();
    });
  }
  function schedulePocketIdle() {
    later(rand(4.5, 8.5), () => {
      if (phase === "play") {
        if (random() < 0.6) peekFor(rand(1.3, 2.3), pick([-0.9, 0.9, -0.5, 0.5]));
        else pocket.kick({ spin: pick([-1, 1]) * rand(0.9, 1.4) * DEG, squash: 3 });
      }
      schedulePocketIdle();
    });
  }

  // -- letters under the finger ----------------------------------------------------------------
  type Line = keyof typeof TAG_ART.say;
  let tapCount = 0, lastLine = "";
  function nextLine(pool: readonly Line[]): Line {
    let line: Line;
    do line = pick(pool); while (line === lastLine && pool.length > 1);
    lastLine = line;
    return line;
  }
  function tapLetter(i: number) {
    lastInteract = virtualNow();
    hop(i, 1);
    const [x, y] = LETTER_ART[i].home;
    burstFx.burst(x, y - halfH(i) * 0.1, 9, { spread: 360 });
    tapCount++;
    if (i === O_INDEX) {
      faceMood("happy", 0.9);
      openMouth(0.65);
      sayLetter(i, nextLine(S.O_LINES));
    } else if (tapCount % 3 === 1 || random() < 0.3) sayLetter(i, nextLine(S.LINES));
    act();
  }
  /** Over the mouth: the homepage's overMouth for a letter centred at (x, y). */
  const overMouth = (i: number, x: number, y: number) =>
    Math.abs(x - PX) < PW * 0.5 && y > PTOP - Math.max(halfH(i) * 1.3, PH * 0.45) && y < PTOP + PH * 0.6;
  // hand a letter back to the pocket: gulp, chew with a happy face, spit it home
  function swallowLetter(i: number, x: number, y: number) {
    const b = letters[i];
    killTagsOf(i);
    state[i] = "swallow";
    showGhost(i, true);
    const to: [number, number] = [PX, PTOP + PH * 0.3];
    b.launch({ from: [x, y], to, duration: 0.36, turn: 2.4 * DEG, arrive: Math.max(0, (2 * (to[1] - y)) / 0.36), endScale: 0.2 });
    pocket.kick({ squash: 6 });
    happyFor(2.1);
    flash();
    for (let k = 0; k < 6; k++) ambient.burst(PX + rand(-0.25, 0.25) * PW, PTOP - 6, 1, { angle: -90, spread: 50, speed: rand(3, 5) });
    later(0.5, () => pocket.kick({ squash: 5, spin: 0.6 * DEG }));
    later(0.7, () => pocket.kick({ squash: 5, spin: -0.6 * DEG }));
    later(1.0, () => {
      const [hx, hy] = LETTER_ART[i].home;
      b.setAnchor(hx, hy, S.HOME_R[i]);
      launch(i, 0.62);
      happyFor(0.9);
    });
    lastInteract = virtualNow();
    act();
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
    releaseToy(toy);
    killTagsOf(toy);
    if (toys[toy.slot] !== toy) return;
    toys[toy.slot] = undefined;
    animate(toyNode[toy.slot], "opacity", 0, { dur: 1 });
  }
  function fadeOut(toy: Toy) {
    toy.gone = true;
    killTagsOf(toy);
    animate(toyNode[toy.slot], "opacity", 0, { dur: 600 });
    later(0.6, () => discard(toy));
  }
  /** Past LIVE_TOYS, the oldest ordinary toy that is not held fades out. */
  function enforceCap() {
    const live = toys.filter((t): t is Toy => !!t && !t.gone).sort((a, b) => a.born - b.born);
    let excess = live.length - LIVE_TOYS;
    for (const toy of live) {
      if (excess <= 0) break;
      if (TOYS[toy.type].special || heldToys().includes(toy)) continue;
      fadeOut(toy);
      excess--;
    }
  }
  function makeToy(type: ToyType, x: number, y: number, vx: number, vy: number, spin: number): Toy {
    const def = TOYS[type];
    const slot = freeSlot();
    const r = S.TOY_R * def.size * rand(0.94, 1.06);
    const scale = r / S.TOY_R;
    toyArt[slot][1]({ src: TOY_ART[type], size: S.TOY_SPRITE * scale });
    // an animation, so it replaces a fade still running on a reused slot
    animate(toyNode[slot], "opacity", 1, { dur: 1 });
    const inertia = def.box ? (0.42 * 3) / (def.box[0] ** 2 + def.box[1] ** 2) : 0.5 / (0.5 * def.col * def.col);
    const body = world!.body({
      views: [toyNode[slot]],
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
    if (type === "pjs") later(0.3, () => { if (!toy.gone) showTag(TAG_ART.pjs, toy, 0); });
    body.onClear(() => { toy.cleared = true; });
    body.onHit((hit) => {
      if (hit.speed > 1100 * U && hit.ny < -0.7) sparkFx.burst(hit.x, hit.y, 3, { angle: -90, spread: 90, speed: 0.35 });
    });
    toys[slot] = toy;
    enforceCap();
    return toy;
  }
  /** Out of the mouth on an arc that lands beside the pocket, mostly under the
   *  text; now and then one bonks it. `aim` in [-1, 1] picks the side and distance. */
  function spawn(type: ToyType, aim = 0, flat = false, spinScale = 1): Toy {
    const def = TOYS[type];
    const r = S.TOY_R * def.size;
    const x = PX + rand(-0.1, 0.1) * PW, y = PTOP + r * 0.25;
    sideFlip = random() < 0.8 ? -sideFlip : sideFlip;
    const side = aim ? Math.sign(aim) : sideFlip;
    const room = PTOP - TEXT_BOTTOM - r * 0.8, lo = def.col * r + PAD + r * 0.3 + 8;
    const apex = !flat && random() < 0.28 ? Math.max(lo, room) * rand(1.15, 1.6) : clamp(rand(0.55, 0.95) * room, lo, Math.max(lo, PTOP - 30));
    const vy = -Math.sqrt(2 * G * apex);
    const half = S.W / 2 - r - 10, minD = Math.min(half, PW / 2 + r + 18);
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
    happyFor(0.5);
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
    happyFor(0.35);
    flash();
  }
  // into the mouth over 0.38 s: x eases in, y falls as t², the toy turns 6 rad/s and shrinks to half
  function swallow(toy: Toy) {
    releaseToy(toy);
    killTagsOf(toy);
    toy.gone = true;
    const x = toy.body.x, y = toy.body.y;
    const to: [number, number] = [PX + (x - PX) * 0.3, PTOP + toy.r * 1.4];
    toy.body.launch({ from: [x, y], to, duration: 0.38, turn: 6 * 0.38 * DEG, arrive: (2 * (to[1] - y)) / 0.38, endScale: 0.5 });
    toy.body.onLand(() => discard(toy));
    pocket.kick({ squash: 5 });
    happyFor(0.8);
    for (let i = 0; i < 5; i++) ambient.burst(PX + rand(-0.2, 0.2) * PW, PTOP - 6, 1, { angle: -90, spread: 50, speed: rand(3, 5) });
  }
  // a special resting tilted past 0.45 rad for 0.8 s hops and turns upright
  // over its flight; the mystery box also hops now and then
  function tendSpecials() {
    const step = 0.2;
    later(step, () => {
      for (const toy of toys) {
        if (!toy || toy.gone || heldToys().includes(toy) || !TOYS[toy.type].special) continue;
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
  let sayIx = 0;
  function tapToy(toy: Toy) {
    const b = toy.body;
    if (toy.type === "mystery") {
      b.setVelocity(b.vx, Math.min(b.vy, -330 * U), b.spin + rand(-120, 120));
      b.kick({ spin: pick([-1, 1]) * 400 });
      showTag(TAG_ART.say[S.SAYS[sayIx++ % S.SAYS.length]], toy, 1.9);
      return;
    }
    if (toy.type === "pjs") {
      // the homepage opens PocketJS here; the device has it running already
      b.setVelocity(b.vx, Math.min(b.vy, -320 * U), b.spin);
      b.kick({ squash: 8 });
      showTag(TAG_ART.pjs, toy, 0);
      return;
    }
    b.setVelocity(b.vx, Math.min(b.vy, -620 * U), b.spin + rand(-570, 570));
    b.kick({ squash: 8 });
  }

  // -- speech bubbles ------------------------------------------------------------------------
  // Slot 0 is the PocketJS tag; the others take the letters' and the mystery
  // box's lines. A bubble on a toy follows it every frame.
  interface Tag { art: TagArt; owner: Toy | number; until: number; shown: boolean; x: number; y: number }
  const tags: (Tag | undefined)[] = Array.from({ length: TAG_SLOTS }, () => undefined);
  const toyTagAt = (toy: Toy, art: TagArt): [number, number] => {
    const b = toy.body;
    return [clamp(b.x, art.w / 2 - 8, S.W - art.w / 2 + 8), Math.max(40, b.y - toy.r * TOYS[toy.type].top - 10)];
  };
  function showTag(art: TagArt, owner: Toy | number, life: number) {
    const pjs = art === TAG_ART.pjs;
    let slot = pjs ? 0 : tags.findIndex((t, s) => s > 0 && t?.owner === owner);
    if (slot < 0) slot = tags.findIndex((t, s) => s > 0 && !t);
    if (slot < 0) slot = tags.reduce((best, t, s) => (s > 0 && t && (best < 1 || t.until < tags[best]!.until) ? s : best), -1);
    const node = tagNode[slot];
    const [x, y] = typeof owner === "number" ? letterTagAt(owner, art) : toyTagAt(owner, art);
    tags[slot] = { art, owner, until: life ? virtualNow() + life : Infinity, shown: true, x, y };
    tagArt[slot][1](art);
    const ops = getOps();
    ops.setProp(node.id, PROP_ORIGIN_X, art.px / TAG_BOX_W - 0.5);
    ops.setProp(node.id, PROP_ORIGIN_Y, art.py / TAG_BOX_H - 0.5);
    jump(node, "translateX", x - art.px);
    jump(node, "translateY", y - art.py);
    jump(node, "scale", 0.3);
    animate(node, "scale", 1, { dur: 380, easing: "out-back" });
    animate(node, "opacity", 1, { dur: 200, easing: "out" });
    if (life) later(life, () => { const t = tags[slot]; if (t && t.owner === owner && virtualNow() >= t.until - 1e-6) hideTag(slot); });
  }
  function hideTag(slot: number) {
    const t = tags[slot];
    if (!t) return;
    tags[slot] = undefined;
    animate(tagNode[slot], "scale", 0.3, { dur: 280, easing: "in" });
    animate(tagNode[slot], "opacity", 0, { dur: 200, easing: "in" });
  }
  function killTagsOf(owner: Toy | number) {
    tags.forEach((t, slot) => { if (t && t.owner === owner) hideTag(slot); });
  }
  /** The homepage's placeTag for a letter: above it, or perched on the
   *  shoulder facing the middle when there is no headroom. */
  function letterTagAt(i: number, art: TagArt): [number, number] {
    const [hx, hy] = LETTER_ART[i].home;
    if (art.px < art.w / 4) return [hx + halfW(i) * 0.92 + 8, hy - halfH(i) * 0.2];
    if (art.px > (art.w * 3) / 4) return [hx - halfW(i) * 0.92 - 8, hy - halfH(i) * 0.2];
    return [clamp(hx, 60, S.W - 60), hy - halfH(i) - FS * 0.38];
  }
  function sayLetter(i: number, text: Line) {
    const [hx, hy] = LETTER_ART[i].home;
    const perch = hy - halfH(i) - FS * 0.38 < 56 ? (hx < S.W * 0.62 ? 1 : -1) : 0;
    const art = perch > 0 ? TAG_ART.perchR[text] : perch < 0 ? TAG_ART.perchL[text] : TAG_ART.say[text];
    showTag(art, i, 1.5 + text.length * 0.04);
  }

  // -- the finger ---------------------------------------------------------------------------
  interface Hold {
    kind: "toy" | "letter" | "pocket" | "sky";
    toy?: Toy;
    letter?: number;
    t0: number;
    moved: number;
    x: number;
    y: number;
    /** Letter centre minus finger while carried. */
    offX: number;
    offY: number;
  }
  const holds = new Map<number, Hold>();
  let lastTap = { t: -1, x: 0, y: 0 };
  let fingerAt = -10, fingerX = 0, fingerY = 0;
  const heldToys = () => [...holds.values()].flatMap((h) => (h.toy ? [h.toy] : []));
  const carried = () => [...holds.values()].find((h) => h.kind === "letter" && state[h.letter!] === "carry");
  const onPocket = (x: number, y: number) =>
    Math.abs(x - PX) < PW / 2 + S.POCKET_LW && y > PTOP - 14 && y < S.POCKET_TIP_Y + 6;
  function releaseToy(toy: Toy) {
    for (const [id, h] of holds) {
      if (h.toy !== toy) continue;
      holds.delete(id);
      if (!toy.gone) toy.body.release();
    }
  }
  function dropLetter(h: Hold, fling: boolean) {
    const i = h.letter!;
    const b = letters[i];
    if (state[i] !== "carry") {
      b.press(0);
      return;
    }
    const x = h.x + h.offX, y = h.y + h.offY;
    b.release();
    b.press(0);
    animate(shadowArt[i], "translateX", 0, { dur: 200, easing: "out" });
    animate(shadowArt[i], "translateY", 0, { dur: 200, easing: "out" });
    setHungry(false);
    if (fling && overMouth(i, x, y)) {
      swallowLetter(i, x, y);
      return;
    }
    state[i] = "home";
    if (i === O_INDEX) { moodUntil = 0; settleMood(); openMouth(0.26); }
  }
  createGesture({
    onDown(c: GestureContact) {
      const now = virtualNow();
      lastInteract = now;
      fingerAt = now; fingerX = c.x; fingerY = c.y;
      const h: Hold = { kind: "sky", t0: now, moved: 0, x: c.x, y: c.y, offX: 0, offY: 0 };
      holds.set(c.id, h);
      if (!world) return;
      const body = phase === "play" ? world.pick(c.x, c.y, "primary", 12) : undefined;
      const toy = body && toys.find((t) => t?.body === body && !t.gone);
      if (toy && !heldToys().includes(toy)) {
        h.kind = "toy";
        h.toy = toy;
        toy.touched = true;
        toy.body.grab(c.x, c.y);
        act();
        return;
      }
      const i = body ? letters.indexOf(body) : -1;
      if (i >= 0 && state[i] === "home" && !carried()) {
        h.kind = "letter";
        h.letter = i;
        letters[i].press(0.14, 1.02);
        return;
      }
      if (onPocket(c.x, c.y)) {
        h.kind = "pocket";
        pocket.press(0.75);
        return;
      }
      sparkFx.burst(c.x, c.y, 6, { angle: 0, spread: 360, speed: 0.28 });
      if (now - lastTap.t < 0.34 && Math.hypot(c.x - lastTap.x, c.y - lastTap.y) < 40) {
        wave();
        burstFx.burst(c.x, c.y, 6, { spread: 360, speed: 0.7 });
        lastTap = { t: -1, x: 0, y: 0 };
      } else lastTap = { t: now, x: c.x, y: c.y };
    },
    onMove(c: GestureContact) {
      const h = holds.get(c.id);
      fingerAt = virtualNow(); fingerX = c.x; fingerY = c.y;
      if (!h) return;
      h.x = c.x; h.y = c.y;
      h.moved = Math.max(h.moved, Math.hypot(c.x - c.startX, c.y - c.startY));
      if (h.toy && !h.toy.gone) h.toy.body.drag(c.x, c.y);
      if (h.kind !== "letter") return;
      const i = h.letter!;
      if (state[i] === "home" && h.moved > 6) {
        // lift it: the letter follows the finger, its shadow drops away
        const b = letters[i];
        state[i] = "carry";
        h.offX = b.x - c.startX;
        h.offY = b.y - c.startY;
        b.press(0, 1.1);
        b.grab(c.startX, c.startY, { mode: "carry" });
        jump(shadowArt[i], "translateX", 4.5 * SIZE);
        jump(shadowArt[i], "translateY", 6.3 * SIZE);
        killTagsOf(i);
        if (i === O_INDEX) setMood("wince");
        lastInteract = virtualNow();
      }
      if (state[i] === "carry") {
        letters[i].drag(c.x, c.y);
        setHungry(overMouth(i, c.x + h.offX, c.y + h.offY));
      }
    },
    onUp(c: GestureContact) {
      const h = holds.get(c.id);
      holds.delete(c.id);
      if (!h) return;
      const quick = h.moved < 8 && virtualNow() - h.t0 < 0.4;
      if (h.kind === "toy" && h.toy && !h.toy.gone) {
        h.toy.body.release();
        if (quick) tapToy(h.toy);
      } else if (h.kind === "letter") {
        const i = h.letter!;
        if (state[i] === "carry") dropLetter(h, true);
        else {
          letters[i].press(0);
          if (h.moved < 8) tapLetter(i);
        }
      } else if (h.kind === "pocket") {
        pocket.press(0);
        if (phase === "play") pop();
      }
    },
    onCancel(c: GestureContact) {
      const h = holds.get(c.id);
      holds.delete(c.id);
      if (!h) return;
      if (h.kind === "toy" && h.toy && !h.toy.gone) h.toy.body.release();
      else if (h.kind === "letter") dropLetter(h, false);
      else if (h.kind === "pocket") pocket.press(0);
    },
  });

  // -- every frame: toy shadows, the eyes, and the bubbles on toys --------------------------------
  let pupilX = 0, pupilY = 0, oEyeX = 0, oEyeY = 0;
  let shadowBatch: JumpBatch | undefined, shadowsOn = false;
  const DT = 1 / 60;
  /** The homepage's drawFloor shadow: an ellipse on the floor under each toy
   *  that grows and darkens as the toy comes down to it. */
  function updateShadows() {
    if (!shadowBatch) return;
    let any = false;
    const span = 280 * U;
    for (let slot = 0; slot < TOY_CAP; slot++) {
      const toy = toys[slot];
      let alpha = 0, x = 0, sx = 1, sy = 1;
      if (toy && !toy.gone) {
        const def = TOYS[toy.type], b = toy.body;
        const h = FLOOR - (b.y + toy.r * (def.box ? def.box[1] : def.col));
        if (h <= span) {
          const k = 1 - clamp(h / span, 0, 1);
          x = b.x;
          sx = (toy.r * (0.45 + 0.45 * k)) / S.SHADOW_RX;
          sy = Math.max(1, toy.r * 0.13 * (0.4 + 0.6 * k)) / S.SHADOW_RY;
          alpha = 0.5 * k;
        }
      }
      any ||= alpha > 0;
      shadowBatch.set(slot * 4, x - S.SHADOW_W / 2);
      shadowBatch.set(slot * 4 + 1, sx);
      shadowBatch.set(slot * 4 + 2, sy);
      shadowBatch.set(slot * 4 + 3, alpha);
    }
    if (any || shadowsOn) shadowBatch.commit();
    shadowsOn = any;
  }
  onFrame(() => {
    if (!world) return;
    const now = virtualNow();
    updateShadows();
    // what the finger is doing is what everyone looks at
    const carry = carried();
    const held = [...holds.values()].find((h) => h.toy && !h.toy.gone);
    let target: [number, number] | null = null;
    if (carry) target = [carry.x + carry.offX, carry.y + carry.offY];
    else if (held) target = [held.toy!.body.x, held.toy!.body.y];
    else if (now - fingerAt < 4) target = [fingerX, fingerY];
    // the pocket's pupils: a unit vector toward the target, or the idle look
    let lx = idleLook, ly = -0.35;
    if (target) {
      const dx = target[0] - EYE_X, dy = target[1] - EYE_Y, d = Math.hypot(dx, dy) || 1;
      lx = dx / d; ly = dy / d;
    }
    lookX += (lx - lookX) * Math.min(1, DT * 8);
    lookY += (ly - lookY) * Math.min(1, DT * 8);
    const px = lookX * 0.42 * K, py = lookY * 0.55 * K;
    if (pupils && (Math.abs(px - pupilX) > 0.05 || Math.abs(py - pupilY) > 0.05)) {
      pupilX = px; pupilY = py;
      jump(pupils, "translateX", px);
      jump(pupils, "translateY", py);
    }
    // the O's eyes, in its glyph units: a script, the target, a flying letter, or an idle glance
    if (state[O_INDEX] === "home" && oEyes) {
      let tx = 0, ty = 0;
      const [ox, oy] = LETTER_ART[O_INDEX].home;
      let focus: [number, number] | null = carry && carry.letter !== O_INDEX ? target : held || now - fingerAt < 1.2 ? target : null;
      if (!oScript && !focus && phase === "intro") {
        let best = Infinity;
        letters.forEach((b, j) => {
          if (state[j] !== "flight" || j === O_INDEX) return;
          const x = b.x, y = b.y, d = (x - ox) ** 2 + (y - oy) ** 2;
          if (d < best) { best = d; focus = [x, y]; }
        });
      }
      if (oScript) [tx, ty] = oScript;
      else if (focus) {
        const dx = focus[0] - ox, dy = focus[1] - (oy - FS * 0.08), d = Math.hypot(dx, dy) || 1, f = Math.min(1, d / (FS * 0.8));
        tx = (dx / d) * 3.4 * f; ty = (dy / d) * 2.8 * f;
      } else if (now < oIdleUntil) { tx = oIdleX; ty = oIdleY; }
      oLookX += (tx - oLookX) * Math.min(1, DT * 16);
      oLookY += (ty - oLookY) * Math.min(1, DT * 16);
      const ex = oLookX * SIZE, ey = oLookY * SIZE;
      if (Math.abs(ex - oEyeX) > 0.03 || Math.abs(ey - oEyeY) > 0.03) {
        oEyeX = ex; oEyeY = ey;
        jump(oEyes, "translateX", ex);
        jump(oEyes, "translateY", ey);
      }
    }
    // bubbles riding on toys
    tags.forEach((t, slot) => {
      if (!t || typeof t.owner === "number" || t.owner.gone) return;
      const [x, y] = toyTagAt(t.owner, t.art);
      if (Math.abs(x - t.x) < 0.25 && Math.abs(y - t.y) < 0.25) return;
      t.x = x; t.y = y;
      jump(tagNode[slot], "translateX", x - t.art.px);
      jump(tagNode[slot], "translateY", y - t.art.py);
    });
  });

  // -- the view --------------------------------------------------------------------------
  const count = (n: number) => Array.from({ length: n }, (_, i) => i);
  const pool = (list: NodeMirror[], n: number, src: string) =>
    <For each={count(n)}>
      {(i) => <Image ref={(el) => (list[i] = el)} src={src} style={box(0, 0, S.PARTICLE_SPRITE, S.PARTICLE_SPRITE, { opacity: 0 })} />}
    </For>;
  const tiles = (list: readonly { src: string; x: number; y: number; w: number; h: number }[], x = 0, y = 0) =>
    <For each={list}>{(t) => <Image src={t.src} style={box(x + t.x, y + t.y, t.w, t.h)} />}</For>;
  const pocketBox = () => box(POCKET_LEFT, POCKET_TOP, S.POCKET_SPRITE_W, S.POCKET_SPRITE_H);

  return (
    <View style={box(0, 0, S.W, S.H)}>
      {tiles(SKY_TILES)}
      <Image ref={(el) => (haze = el)} src={HAZE_ART} style={box(HAZE_BOX.x, HAZE_BOX.y, HAZE_BOX.w, HAZE_BOX.h, { opacity: 0 })} />
      <Image ref={(el) => (glow = el)} src={GLOW_ART} style={box(PX - 128, PTOP - 64, 256, 128, { opacity: 0 })} />
      {pool(twinkles, 12, PARTICLE_ART.star[0])}
      <For each={count(TOY_CAP)}>
        {(i) => <Image ref={(el) => (toyShadow[i] = el)} src={TOY_SHADOW} style={box(0, FLOOR + 2 - S.SHADOW_H / 2, S.SHADOW_W, S.SHADOW_H, { opacity: 0 })} />}
      </For>
      <View ref={(el) => (backWrap = el)} style={pocketBox()}>
        <Image ref={(el) => (mouth = el)} src={POCKET_ART.mouth} style={box((S.POCKET_SPRITE_W - S.MOUTH_W) / 2, MOUTH_Y - S.MOUTH_H / 2, S.MOUTH_W, S.MOUTH_H, { scaleY: MOUTH_REST })} />
      </View>
      <For each={LETTER_ART}>
        {(l, i) => (
          <View ref={(el) => (ghost[i()] = el)} style={box(0, 0, LS, LS, { opacity: 0 })}>
            <Image src={l.src} style={box(0, 0, LS, LS)} />
            {i() === O_INDEX ? <Image src={O_FACE.wince} style={box(0, 0, LS, LS)} /> : null}
          </View>
        )}
      </For>
      <View ref={(el) => (eyesWrap = el)} style={pocketBox()}>
        <View ref={(el) => (eyes = el)} style={box((S.POCKET_SPRITE_W - S.EYES_W) / 2, EYES_Y - S.EYES_H / 2, S.EYES_W, S.EYES_H, { translateY: EYES_HIDDEN })}>
          <Image src={POCKET_ART.whites} style={box(0, 0, S.EYES_W, S.EYES_H, { opacity: eyeHappy() ? 0 : 1 })} />
          <Image ref={(el) => (pupils = el)} src={POCKET_ART.pupils} style={box(0, 0, S.EYES_W, S.EYES_H, { opacity: eyeHappy() ? 0 : 1 })} />
          <Image src={POCKET_ART.happy} style={box(0, 0, S.EYES_W, S.EYES_H, { opacity: eyeHappy() ? 1 : 0 })} />
        </View>
      </View>
      <For each={count(TOY_CAP)}>
        {(i) => (
          <View ref={(el) => (toyNode[i] = el)} style={box(0, 0, S.TOY_SPRITE, S.TOY_SPRITE, { opacity: 0 })}>
            <Image src={toyArt[i][0]().src} style={box((S.TOY_SPRITE - toyArt[i][0]().size) / 2, (S.TOY_SPRITE - toyArt[i][0]().size) / 2, toyArt[i][0]().size, toyArt[i][0]().size)} />
          </View>
        )}
      </For>
      <View ref={(el) => (frontWrap = el)} style={pocketBox()}>
        <Image class="animate-breathe" src={POCKET_ART.front} style={box(0, 0, S.POCKET_SPRITE_W, S.POCKET_SPRITE_H, { originY: POCKET_PIVOT / S.POCKET_SPRITE_H })} />
      </View>
      <For each={LETTER_ART}>
        {(l, i) => (
          <View ref={(el) => (shadow[i()] = el)} style={box(l.home[0] - LS / 2, l.home[1] - LS / 2, LS, LS, { opacity: 0 })}>
            <Image ref={(el) => (shadowArt[i()] = el)} class={BOB[i()]} src={l.shadow} style={box(0, 0, LS, LS)} />
          </View>
        )}
      </For>
      <For each={LETTER_ART}>
        {(l, i) => (
          <View ref={(el) => (sticker[i()] = el)} style={box(l.home[0] - LS / 2, l.home[1] - LS / 2, LS, LS, { opacity: 0 })}>
            <View class={BOB[i()]} style={box(0, 0, LS, LS)}>
              <Image src={l.src} style={box(0, 0, LS, LS)} />
              {i() === O_INDEX ? <Image src={oFace()} style={box(0, 0, LS, LS)} /> : null}
              {i() === O_INDEX ? (
                <View ref={(el) => (oEyes = el)} style={box(0, 0, LS, LS, { opacity: 0, originY: O_EYES.ey / LS })}>
                  <Image src={O_EYE} style={box(LS / 2 - O_EYES.ex - S.O_EYE_SPRITE / 2, LS / 2 + O_EYES.ey - S.O_EYE_SPRITE / 2, S.O_EYE_SPRITE, S.O_EYE_SPRITE)} />
                  <Image src={O_EYE} style={box(LS / 2 + O_EYES.ex - S.O_EYE_SPRITE / 2, LS / 2 + O_EYES.ey - S.O_EYE_SPRITE / 2, S.O_EYE_SPRITE, S.O_EYE_SPRITE)} />
                </View>
              ) : null}
            </View>
          </View>
        )}
      </For>
      {pool(sparks, 32, PARTICLE_ART.star[0])}
      {pool(bursts, 32, PARTICLE_ART.burst[0])}
      <View ref={(el) => (ledeWrap = el)} style={box(LEDE.x, LEDE.y, LEDE.w, LEDE.h, { opacity: 0 })}>
        {tiles(LEDE.tiles)}
      </View>
      <Image ref={(el) => (copy = el)} src={COPY.src} style={box(COPY.x, COPY.y, COPY.w, COPY.h, { opacity: 0 })} />
      <View ref={(el) => (hint = el)} style={box(0, 0, S.W, S.H, { opacity: 0 })}>
        <Image src={HINT.text.src} style={box(HINT.text.x, HINT.text.y, HINT.text.w, HINT.text.h)} />
        <Image class="animate-nudge" src={HINT.arrow.src} style={box(HINT.arrow.x, HINT.arrow.y, HINT.arrow.w, HINT.arrow.h)} />
      </View>
      <For each={count(TAG_SLOTS)}>
        {(i) => (
          <View ref={(el) => (tagNode[i] = el)} style={box(0, 0, TAG_BOX_W, TAG_BOX_H, { opacity: 0 })}>
            <Image src={tagArt[i][0]().src} style={box(0, 0, tagArt[i][0]().w, tagArt[i][0]().h)} />
          </View>
        )}
      </For>
      <AfterMount run={setup} />
    </View>
  );
}
