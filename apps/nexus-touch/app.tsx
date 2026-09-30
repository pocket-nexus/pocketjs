// apps/nexus-touch/app.tsx — the pocket.nexus homepage on a 320x480 touch screen.
//
// The homepage's one interactive screen, laid out by the homepage itself
// (gen-art.ts measures the page at each screen's size and writes that
// layout's art module; an entry passes it in) and moved by its springs at
// its phone scale U, from the shared Pocket Nexus bodies and toys
// (apps/nexus/homepage.ts, apps/nexus/toys.ts). On launch the pocket wakes
// and spills POCKET NEXUS into the wordmark. Then: tap the pocket for toys;
// grab, fling and tap the toys; tap a letter and it hops and talks; drag a
// letter away and it springs home, or drop it in the pocket's mouth and the
// pocket chews and spits it back; double-tap the sky for a wave.
//
// The app declares bodies and issues commands at interaction edges; the core
// integrates every tick and writes the poses into the nodes. Per-frame JS
// moves the eyes toward the finger (positions the app already knows) and
// keeps the bubbles on the toys that carry them: the one pose read per
// bubble per frame, for at most two bubbles, because a bubble stays upright
// and on screen while its toy turns and reaches the walls.

import { createSignal, For, onCleanup } from "solid-js";
import { Image, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, jump } from "@pocketjs/framework/animation";
import { after, virtualNow } from "@pocketjs/framework/clock";
import { createGesture, type GestureContact } from "@pocketjs/framework/gesture";
import { reportAppAction } from "@pocketjs/framework/host";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createWorld, type Body, type Emitter, type Vec, type World } from "@pocketjs/framework/physics";
import { touchScene } from "./scene.ts";
import {
  BOB, DEG, HOME_R, LINES, O_LINES, POCKET_OUTLINE, ROW_SPLIT, SAYS, SPIT_AT, SPIT_TF, TOYS, burstEmitter, clamp,
  landing, letterBody, letterHalf, pocketBodies, seededRandom, sparkEmitter, spillFlight, textShelf, twinkleEmitter,
  type ToyType,
} from "../nexus/homepage.ts";
import { createToyBox, type Toy, type ToyBox } from "../nexus/toys.ts";
import { AfterMount, box } from "../nexus/view.ts";

// ---- the art a layout bakes (gen-art.ts writes one art.ts per screen) ----------------
// Each art.ts imports these types, so tsc checks every layout against this shape.

export interface Tile { src: string; x: number; y: number; w: number; h: number }
export interface TagArt { src: string; w: number; h: number; px: number; py: number }
export interface LetterArt { ch: string; src: string; shadow: string; w: number; ih: number; rcK: number; home: readonly [number, number] }
type Line = (typeof LINES)[number] | (typeof O_LINES)[number] | (typeof SAYS)[number];
export interface TouchArt {
  VIEWPORT: readonly [number, number];
  FS: number;
  LETTER_ART: readonly LetterArt[];
  O_FACE: Readonly<Record<"look" | "talk" | "happy" | "wince" | "shut", string>>;
  O_EYE: string;
  O_EYES: { ex: number; ey: number };
  TOY_ART: Readonly<Record<ToyType, string>>;
  PARTICLE_ART: { readonly [kind in "burst" | "bdot" | "star" | "dot"]: readonly string[] };
  POCKET_ART: Readonly<Record<"front" | "mouth" | "whites" | "pupils" | "happy", string>>;
  SKY_TILES: readonly Tile[];
  HAZE_ART: string;
  HAZE_BOX: { x: number; y: number; w: number; h: number };
  GLOW_ART: string;
  LEDE: { x: number; y: number; w: number; h: number; ink: { l: number; t: number; r: number; b: number }; tiles: readonly Tile[] };
  COPY: Tile;
  HINT: { text: Tile; arrow: Tile };
  TAG_ART: { pjs: TagArt } & { readonly [side in "say" | "perchR" | "perchL"]: Readonly<Record<Line, TagArt>> };
}

/** The spill starts once the pocket has woken up (the homepage's base). */
const SPILL_AT = 0.74;
/** Toy node slots, and the live toys kept before the oldest fades out. */
const TOY_CAP = 16;
const LIVE_TOYS = 14;
/** Speech-bubble node slots: the PocketJS tag and two bubbles. */
const TAG_SLOTS = 3;

/** The core's launch parabola: from `from`, landing on `to` `tf` s later
 *  moving down at `arrive` px/s. */
function parabola(from: Vec, to: Vec, tf: number, arrive: number) {
  const dy = to[1] - from[1], g = (2 * (arrive - dy / tf)) / tf;
  return { vx: (to[0] - from[0]) / tf, vy: dy / tf - (g * tf) / 2, g };
}

type LetterState = "hidden" | "flight" | "home" | "carry" | "swallow" | "inside";
type OMood = "look" | "talk" | "happy" | "wince" | "shut";

export default function Nexus(props: { art: TouchArt }) {
  // -- the layout ---------------------------------------------------------------
  const {
    COPY, FS, GLOW_ART, HAZE_ART, HAZE_BOX, HINT, LEDE, LETTER_ART, O_EYE, O_EYES, O_FACE, PARTICLE_ART, POCKET_ART,
    SKY_TILES, TAG_ART, TOY_ART,
  } = props.art;
  const S = touchScene(props.art.VIEWPORT[0], props.art.VIEWPORT[1], FS);
  const U = S.U;
  const G = S.G;
  const SIZE = FS / 100;
  const LS = S.LETTER_SPRITE;
  const LAND = landing(FS);
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
  const MOUTH_REST = S.mouthScale(0.16);
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

  /** A letter's collision half extents (the homepage's hw/hh). */
  const halfW = (i: number) => letterHalf(LETTER_ART[i], FS)[0];
  const halfH = (i: number) => letterHalf(LETTER_ART[i], FS)[1];

  /** Seconds after take-off at which a flight from the mouth clears the
   *  pocket's rim (the homepage's `emerging`), while the letter is drawn behind
   *  the pocket's front. */
  function emergeAfter(from: Vec, vy: number, g: number, hh: number): number {
    const c = from[1] + hh * 0.55 - PTOP;
    if (c <= 0) return 0;
    const disc = vy * vy - 2 * g * c;
    if (disc < 0 || g <= 0) return 0.4;
    return clamp((-vy - Math.sqrt(disc)) / g, 0, 0.4);
  }

  // -- nodes ---------------------------------------------------------------------
  const sticker: NodeMirror[] = [];
  const shadow: NodeMirror[] = [];
  const shadowArt: NodeMirror[] = [];
  const ghost: NodeMirror[] = [];
  const toyNode: NodeMirror[] = [];
  const bursts: NodeMirror[] = [];
  const sparks: NodeMirror[] = [];
  const twinkles: NodeMirror[] = [];
  const tagNode: NodeMirror[] = [];
  const tagArtNode: NodeMirror[] = [];
  let backWrap: NodeMirror | undefined, eyesWrap: NodeMirror | undefined, frontWrap: NodeMirror | undefined;
  let mouth: NodeMirror | undefined, eyes: NodeMirror | undefined, pupils: NodeMirror | undefined, glow: NodeMirror | undefined;
  let haze: NodeMirror | undefined, ledeWrap: NodeMirror | undefined, copy: NodeMirror | undefined, hint: NodeMirror | undefined;
  let oEyes: NodeMirror | undefined;

  // -- reactive bits (only at edges) ---------------------------------------------------
  const [oFace, setOFace] = createSignal<string>(O_FACE.shut);
  const [eyeHappy, setEyeHappy] = createSignal(false);
  // one signal per slot, so dressing a slot re-applies only that slot's style
  const toyArt = Array.from({ length: TOY_CAP }, () => createSignal<{ src: string; size: number }>({ src: TOY_ART.star, size: S.TOY_SPRITE }));
  const tagArt = Array.from({ length: TAG_SLOTS }, () => createSignal<TagArt>(TAG_ART.pjs));

  // -- the world -------------------------------------------------------------------
  const random = seededRandom(0x5eed2026);
  let world: World | undefined;
  let pocket: Body;
  let toys: ToyBox;
  const letters: Body[] = [];
  const state: LetterState[] = LETTER_ART.map(() => "hidden");
  /** Each letter's flight from the mouth, for the O to watch during the spill. */
  const flights: ({ t0: number; from: Vec; vx: number; vy: number; g: number } | undefined)[] = LETTER_ART.map(() => undefined);
  /** A swallowed letter's rest, restored when the pocket spits it back. */
  const homes: (Vec | undefined)[] = LETTER_ART.map(() => undefined);
  let burstFx: Emitter, sparkFx: Emitter, ambient: Emitter;
  let phase: "intro" | "play" = "intro";
  let lastPop = -1, lastInteract = 0, landed = 0, userPopped = false, actions = 0;
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
    const bodies = pocketBodies(w, [backWrap!, eyesWrap!, frontWrap!], POCKET_OUTLINE.map(([x, y]) => S.pocketPoint(x, y)), PAD, POCKET_PIVOT, U);
    pocket = bodies.pocket;
    bodies.inside.onEnter((body) => toys.enter(body));
    // the lede is a shelf the toys bonk
    textShelf(w, ledeWrap!, LEDE.ink, U);

    // letters: parked in the pocket until the spill
    LETTER_ART.forEach((l, i) => {
      const body = w.body({
        ...letterBody(l, i, FS),
        views: [sticker[i], { node: shadow[i], offset: [5 * SIZE, 7 * SIZE] }, ghost[i]],
        pickable: true, asleep: true, position: [PX, PTOP + 40],
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

    burstFx = burstEmitter(w, bursts, [...PARTICLE_ART.burst, ...PARTICLE_ART.bdot], FS);
    sparkFx = sparkEmitter(w, sparks, [...PARTICLE_ART.star, ...PARTICLE_ART.dot], U);
    ambient = twinkleEmitter(w, twinkles, [PARTICLE_ART.star[0], PARTICLE_ART.star[1], PARTICLE_ART.star[2]], U);
    ambient.stream(3.2, PX - PW * 0.38, PTOP - 6, PW * 0.76, 6);

    toys = createToyBox({
      world: w, slots: TOY_CAP, live: LIVE_TOYS,
      views: (slot) => [toyNode[slot]],
      show(slot, type, scale) {
        toyArt[slot][1]({ src: TOY_ART[type], size: S.TOY_SPRITE * scale });
        // an animation, so it replaces a fade still running on a reused slot
        animate(toyNode[slot], "opacity", 1, { dur: 1 });
      },
      hide: (slot, fade) => { animate(toyNode[slot], "opacity", 0, { dur: fade ? 600 : 1 }); },
      pocket, pocketWall: bodies.wall,
      px: PX, ptop: PTOP, pw: PW, pad: PAD, floor: FLOOR,
      halfWidth: S.W / 2, radius: S.TOY_R, u: U, g: G,
      // most arcs pass under the text; now and then one bonks it
      apex(r, def, flat) {
        const room = PTOP - TEXT_BOTTOM - r * 0.8, lo = def.col * r + PAD + r * 0.3 + 8;
        return !flat && random() < 0.28 ? Math.max(lo, room) * random.range(1.15, 1.6) : clamp(random.range(0.55, 0.95) * room, lo, Math.max(lo, PTOP - 30));
      },
      random, later, sparks: sparkFx, twinkles: ambient,
      flash, happy: happyFor,
      isHeld: (toy) => holdOf(toy) !== undefined,
      made: (toy) => { if (toy.type === "pjs") later(0.3, () => { if (!toy.gone) showTag(TAG_ART.pjs, toy, 0); }); },
      left(toy) {
        killTagsOf(toy);
        const hold = holdOf(toy);
        if (hold) hold.toy = undefined;
        toy.body.release();
      },
    });
    wakeUp();
    toys.tend();
    scheduleIdle();
    schedulePocketIdle();
    scheduleBlink();
    schedulePocketBlink();
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
    for (let i = 0; i < n; i++) sparkFx.burst(PX + random.range(-0.3, 0.3) * PW, PTOP - 2, 1, { angle: -90 + random.range(-60, 60), spread: 0 });
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
    toys.pop();
    pocketBurst(14);
    act();
    if (!userPopped) {
      userPopped = true;
      if (hint) animate(hint, "opacity", 0, { dur: 350 });
    }
  }
  function popSpecial(type: ToyType, aim: number) {
    toys.plop(type, aim);
    pocketBurst(8);
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
    const home = homes[i] ?? LETTER_ART[i].home;
    const flight = spillFlight(home, halfH(i), { cx: PX, top: PTOP, pw: PW }, FS, tf, random);
    const arc = parabola(flight.from, home, tf, flight.arrive);
    state[i] = "flight";
    flights[i] = { t0: virtualNow(), from: flight.from, ...arc };
    // drawn behind the pocket's front until it clears the rim
    showGhost(i, true);
    later(emergeAfter(flight.from, arc.vy, arc.g, halfH(i)), () => { if (state[i] === "flight") showGhost(i, false); });
    letters[i].launch(flight);
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
      letters[i].setAnchor(PX, S.H + 200, HOME_R[i]);
      letters[i].teleport(PX, S.H + 200);
      return;
    }
    const kick = clamp(speed * LAND.gain, LAND.min, LAND.max);
    for (const n of [i - 1, i + 1]) {
      if (n < 0 || n >= letters.length || (i < ROW_SPLIT) !== (n < ROW_SPLIT) || state[n] !== "home") continue;
      letters[n].kick({ squash: kick * 0.38 });
      letters[n].impulse(0, FS * kick * 0.09);
    }
    if (state[i] !== "flight") return;
    state[i] = "home";
    flights[i] = undefined;
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
  // The eyes are nodes over the face layer; they follow what the finger is
  // doing, watch the spill, look around when idle, and blink.
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
    if (state[O_INDEX] !== "home") return;
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
    later(random.range(2.2, 5.2), () => {
      blinkO();
      if (random() < 0.25) later(0.26, blinkO);
      scheduleBlink();
    });
  }
  function blinkPocket() {
    if (!eyes || eyeHappy()) return;
    jump(eyes, "scaleY", 0.12);
    later(0.13, () => eyes && jump(eyes, "scaleY", 1));
  }
  function schedulePocketBlink() {
    later(random.range(2.2, 4.8), () => {
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
    later(random.range(4.2, 7.6), () => {
      if (phase === "play" && virtualNow() - lastInteract > 3.5 && holds.size === 0) {
        const roll = random();
        if (roll < 0.45) hop(Math.floor(random() * letters.length), 0.45);
        else if (roll < 0.85) { oIdleX = random.range(-3.2, 3.2); oIdleY = random.range(-2.4, 2.4); oIdleUntil = virtualNow() + 1.4; }
      }
      scheduleIdle();
    });
  }
  function schedulePocketIdle() {
    later(random.range(4.5, 8.5), () => {
      if (phase === "play") {
        if (random() < 0.6) peekFor(random.range(1.3, 2.3), random.pick([-0.9, 0.9, -0.5, 0.5]));
        else pocket.kick({ spin: random.pick([-1, 1]) * random.range(0.9, 1.4) * DEG, squash: 3 });
      }
      schedulePocketIdle();
    });
  }

  // -- letters under the finger ----------------------------------------------------------------
  let tapCount = 0, lastLine = "";
  function nextLine(pool: readonly Line[]): Line {
    let line: Line;
    do line = random.pick(pool); while (line === lastLine && pool.length > 1);
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
      sayLetter(i, nextLine(O_LINES));
    } else if (tapCount % 3 === 1 || random() < 0.3) sayLetter(i, nextLine(LINES));
    act();
  }
  /** Over the mouth: the homepage's overMouth for a letter centred at (x, y). */
  const overMouth = (i: number, x: number, y: number) =>
    Math.abs(x - PX) < PW * 0.5 && y > PTOP - Math.max(halfH(i) * 1.3, PH * 0.45) && y < PTOP + PH * 0.6;
  // hand a letter back to the pocket: gulp, chew with a happy face, spit it home
  function swallowLetter(i: number, x: number, y: number) {
    const b = letters[i];
    killTagsOf(i);
    // the layout rest, to restore once the letter has been parked inside
    homes[i] = b.home;
    state[i] = "swallow";
    showGhost(i, true);
    const to: Vec = [PX, PTOP + PH * 0.3];
    b.launch({ from: [x, y], to, duration: 0.36, turn: 2.4 * DEG, arrive: Math.max(0, (2 * (to[1] - y)) / 0.36), endScale: 0.2 });
    pocket.kick({ squash: 6 });
    happyFor(2.1);
    flash();
    for (let k = 0; k < 6; k++) ambient.burst(PX + random.range(-0.25, 0.25) * PW, PTOP - 6, 1, { angle: -90, spread: 50, speed: random.range(3, 5) });
    later(0.5, () => pocket.kick({ squash: 5, spin: 0.6 * DEG }));
    later(0.7, () => pocket.kick({ squash: 5, spin: -0.6 * DEG }));
    later(1.0, () => {
      const home = homes[i] ?? LETTER_ART[i].home;
      b.setAnchor(home[0], home[1], HOME_R[i]);
      launch(i, 0.62);
      happyFor(0.9);
    });
    lastInteract = virtualNow();
    act();
  }

  // -- toys ----------------------------------------------------------------------------------
  let sayIx = 0;
  function tapToy(toy: Toy) {
    toys.tap(toy);
    if (toy.type === "mystery") showTag(TAG_ART.say[SAYS[sayIx++ % SAYS.length]], toy, 1.9);
    else if (toy.type === "pjs") showTag(TAG_ART.pjs, toy, 0);
  }

  // -- speech bubbles ------------------------------------------------------------------------
  // Slot 0 is the PocketJS tag; the others take the letters' and the mystery
  // box's lines. A slot is a box the app moves and fades, holding the bubble
  // art that scales about the point its tail marks.
  interface Tag { art: TagArt; owner: Toy | number; until: number; x: number; y: number }
  const tags: (Tag | undefined)[] = Array.from({ length: TAG_SLOTS }, () => undefined);
  const toyTagAt = (toy: Toy, art: TagArt): Vec => {
    const b = toy.body;
    return [clamp(b.x, art.w / 2 - 8, S.W - art.w / 2 + 8), Math.max(40, b.y - toy.r * TOYS[toy.type].top - 10)];
  };
  function showTag(art: TagArt, owner: Toy | number, life: number) {
    let slot = art === TAG_ART.pjs ? 0 : tags.findIndex((t, s) => s > 0 && t?.owner === owner);
    if (slot < 0) slot = tags.findIndex((t, s) => s > 0 && !t);
    if (slot < 0) slot = tags.reduce((best, t, s) => (s > 0 && t && (best < 1 || t.until < tags[best]!.until) ? s : best), -1);
    const [x, y] = typeof owner === "number" ? letterTagAt(owner, art) : toyTagAt(owner, art);
    tags[slot] = { art, owner, until: life ? virtualNow() + life : Infinity, x, y };
    tagArt[slot][1](art);
    jump(tagNode[slot], "translateX", x - art.px);
    jump(tagNode[slot], "translateY", y - art.py);
    jump(tagArtNode[slot], "scale", 0.3);
    animate(tagArtNode[slot], "scale", 1, { dur: 380, easing: "out-back" });
    animate(tagNode[slot], "opacity", 1, { dur: 200, easing: "out" });
    if (life) later(life, () => { const t = tags[slot]; if (t && t.owner === owner && virtualNow() >= t.until - 1e-6) hideTag(slot); });
  }
  function hideTag(slot: number) {
    if (!tags[slot]) return;
    tags[slot] = undefined;
    animate(tagArtNode[slot], "scale", 0.3, { dur: 280, easing: "in" });
    animate(tagNode[slot], "opacity", 0, { dur: 200, easing: "in" });
  }
  function killTagsOf(owner: Toy | number) {
    tags.forEach((t, slot) => { if (t && t.owner === owner) hideTag(slot); });
  }
  /** The homepage's placeTag for a letter: above it, or perched on the
   *  shoulder facing the middle when there is no headroom. */
  function letterTagAt(i: number, art: TagArt): Vec {
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
  // Each contact owns what it landed on. At most one letter is under a finger
  // at a time, as on the homepage; toys can be held one per finger.
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
  /** The contact holding a letter, if any; it is carrying once the letter is in `carry`. */
  let letterHold: Hold | undefined;
  let lastTap = { t: -1, x: 0, y: 0 };
  let fingerAt = -10, fingerX = 0, fingerY = 0;
  function holdOf(toy: Toy): Hold | undefined {
    for (const hold of holds.values()) if (hold.toy === toy) return hold;
    return undefined;
  }
  function heldToy(): Hold | undefined {
    for (const hold of holds.values()) if (hold.toy) return hold;
    return undefined;
  }
  const onPocket = (x: number, y: number) =>
    Math.abs(x - PX) < PW / 2 + S.POCKET_LW && y > PTOP - 14 && y < S.POCKET_TIP_Y + 6;
  function endLetter(hold: Hold, drop: boolean) {
    const i = hold.letter!;
    letterHold = undefined;
    const b = letters[i];
    b.press(0);
    if (state[i] !== "carry") return;
    const x = hold.x + hold.offX, y = hold.y + hold.offY;
    b.release();
    animate(shadowArt[i], "translateX", 0, { dur: 200, easing: "out" });
    animate(shadowArt[i], "translateY", 0, { dur: 200, easing: "out" });
    setHungry(false);
    if (drop && overMouth(i, x, y)) {
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
      const hold: Hold = { kind: "sky", t0: now, moved: 0, x: c.x, y: c.y, offX: 0, offY: 0 };
      holds.set(c.id, hold);
      if (!world) return;
      const body = phase === "play" ? world.pick(c.x, c.y, "primary", 12) : undefined;
      const toy = toys.find(body);
      if (toy && !holdOf(toy)) {
        hold.kind = "toy";
        hold.toy = toy;
        toy.touched = true;
        toy.body.grab(c.x, c.y);
        act();
        return;
      }
      const i = body ? letters.indexOf(body) : -1;
      if (i >= 0 && state[i] === "home" && !letterHold) {
        hold.kind = "letter";
        hold.letter = i;
        letterHold = hold;
        letters[i].press(0.14, 1.02);
        return;
      }
      if (onPocket(c.x, c.y)) {
        hold.kind = "pocket";
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
      const hold = holds.get(c.id);
      fingerAt = virtualNow(); fingerX = c.x; fingerY = c.y;
      if (!hold) return;
      hold.x = c.x; hold.y = c.y;
      hold.moved = Math.max(hold.moved, Math.hypot(c.x - c.startX, c.y - c.startY));
      if (hold.toy) hold.toy.body.drag(c.x, c.y);
      if (hold.kind !== "letter") return;
      const i = hold.letter!;
      if (state[i] === "home" && hold.moved > 6) {
        // lift it: the letter follows the finger, its shadow drops away
        const b = letters[i];
        state[i] = "carry";
        hold.offX = b.x - c.startX;
        hold.offY = b.y - c.startY;
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
        setHungry(overMouth(i, c.x + hold.offX, c.y + hold.offY));
      }
    },
    onUp(c: GestureContact) {
      const hold = holds.get(c.id);
      holds.delete(c.id);
      if (!hold) return;
      if (hold.toy) {
        const toy = hold.toy;
        toy.body.release();
        if (hold.moved < 8 && virtualNow() - hold.t0 < 0.4) tapToy(toy);
      } else if (hold.kind === "letter") {
        const i = hold.letter!;
        const carried = state[i] === "carry";
        endLetter(hold, true);
        if (!carried && hold.moved < 8) tapLetter(i);
      } else if (hold.kind === "pocket") {
        pocket.press(0);
        if (phase === "play") pop();
      }
    },
    onCancel(c: GestureContact) {
      const hold = holds.get(c.id);
      holds.delete(c.id);
      if (!hold) return;
      if (hold.toy) hold.toy.body.release();
      else if (hold.kind === "letter") endLetter(hold, false);
      else if (hold.kind === "pocket") pocket.press(0);
    },
  });

  // -- every frame: the eyes, and the bubbles on toys ---------------------------------------------
  let pupilX = 0, pupilY = 0, oEyeX = 0, oEyeY = 0;
  const DT = 1 / 60;
  onFrame(() => {
    if (!world) return;
    const now = virtualNow();
    // what the finger is doing is what everyone looks at: a carried letter,
    // a held toy (the tether keeps it at the finger), or the finger itself
    const carrying = letterHold && state[letterHold.letter!] === "carry" ? letterHold : undefined;
    const holding = heldToy();
    let tx = fingerX, ty = fingerY, target = now - fingerAt < 4;
    if (carrying) { tx = carrying.x + carrying.offX; ty = carrying.y + carrying.offY; target = true; }
    else if (holding) { tx = holding.x; ty = holding.y; target = true; }
    // the pocket's pupils: a unit vector toward the target, or the idle look
    let lx = idleLook, ly = -0.35;
    if (target) {
      const dx = tx - EYE_X, dy = ty - EYE_Y, d = Math.hypot(dx, dy) || 1;
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
    // the O's eyes, in its glyph units: a script, the target, the letter
    // flying nearest during the spill, or an idle glance
    if (state[O_INDEX] === "home" && oEyes) {
      const [ox, oy] = LETTER_ART[O_INDEX].home;
      let fx = 0, fy = 0, focus = (carrying && carrying.letter !== O_INDEX) || !!holding || now - fingerAt < 1.2;
      if (focus) { fx = tx; fy = ty; }
      else if (phase === "intro") {
        let best = Infinity;
        for (const f of flights) {
          if (!f) continue;
          const t = now - f.t0, x = f.from[0] + f.vx * t, y = f.from[1] + f.vy * t + 0.5 * f.g * t * t;
          const d = (x - ox) ** 2 + (y - oy) ** 2;
          if (d < best) { best = d; fx = x; fy = y; focus = true; }
        }
      }
      let ex = 0, ey = 0;
      if (oScript) [ex, ey] = oScript;
      else if (focus) {
        const dx = fx - ox, dy = fy - (oy - FS * 0.08), d = Math.hypot(dx, dy) || 1, f = Math.min(1, d / (FS * 0.8));
        ex = (dx / d) * 3.4 * f; ey = (dy / d) * 2.8 * f;
      } else if (now < oIdleUntil) { ex = oIdleX; ey = oIdleY; }
      oLookX += (ex - oLookX) * Math.min(1, DT * 16);
      oLookY += (ey - oLookY) * Math.min(1, DT * 16);
      const nx = oLookX * SIZE, ny = oLookY * SIZE;
      if (Math.abs(nx - oEyeX) > 0.03 || Math.abs(ny - oEyeY) > 0.03) {
        oEyeX = nx; oEyeY = ny;
        jump(oEyes, "translateX", nx);
        jump(oEyes, "translateY", ny);
      }
    }
    // bubbles riding on toys
    for (let slot = 0; slot < TAG_SLOTS; slot++) {
      const t = tags[slot];
      if (!t || typeof t.owner === "number" || t.owner.gone) continue;
      const [x, y] = toyTagAt(t.owner, t.art);
      if (Math.abs(x - t.x) < 0.25 && Math.abs(y - t.y) < 0.25) continue;
      t.x = x; t.y = y;
      jump(tagNode[slot], "translateX", x - t.art.px);
      jump(tagNode[slot], "translateY", y - t.art.py);
    }
  });

  // -- the view --------------------------------------------------------------------------
  const count = (n: number) => Array.from({ length: n }, (_, i) => i);
  const pool = (list: NodeMirror[], n: number, src: string) =>
    <For each={count(n)}>
      {(i) => <Image ref={(el) => (list[i] = el)} src={src} style={box(0, 0, S.PARTICLE_SPRITE, S.PARTICLE_SPRITE, { opacity: 0 })} />}
    </For>;
  const tiles = (list: readonly { src: string; x: number; y: number; w: number; h: number }[]) =>
    <For each={list}>{(t) => <Image src={t.src} style={box(t.x, t.y, t.w, t.h)} />}</For>;
  const pocketBox = () => box(POCKET_LEFT, POCKET_TOP, S.POCKET_SPRITE_W, S.POCKET_SPRITE_H);

  return (
    <View style={box(0, 0, S.W, S.H)}>
      {tiles(SKY_TILES)}
      <Image ref={(el) => (haze = el)} src={HAZE_ART} style={box(HAZE_BOX.x, HAZE_BOX.y, HAZE_BOX.w, HAZE_BOX.h, { opacity: 0 })} />
      <Image ref={(el) => (glow = el)} src={GLOW_ART} style={box(PX - 128, PTOP - 64, 256, 128, { opacity: 0 })} />
      {pool(twinkles, 12, PARTICLE_ART.star[0])}
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
      {/* a toy slot is a sprite-sized view the body poses, holding the art at the toy's size */}
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
          <View ref={(el) => (tagNode[i] = el)} style={box(0, 0, 128, 64, { opacity: 0 })}>
            <Image
              ref={(el) => (tagArtNode[i] = el)}
              src={tagArt[i][0]().src}
              style={box(0, 0, tagArt[i][0]().w, tagArt[i][0]().h, { originX: tagArt[i][0]().px / tagArt[i][0]().w - 0.5, originY: tagArt[i][0]().py / tagArt[i][0]().h - 0.5 })}
            />
          </View>
        )}
      </For>
      <AfterMount run={setup} />
    </View>
  );
}
