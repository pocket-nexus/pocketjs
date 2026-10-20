// apps/nexus/app.tsx — the pocket.nexus homepage on the Nintendo 3DS.
//
// The scene lives on the touch screen; the top screen belongs to the system
// (the agent's stage). One physics world is that screen (scene.ts): the
// pocket sits on the floor line and the stylus pops, grabs and flings its
// toys. The first tap opens the pocket and it spits POCKET NEXUS up to the
// top of the screen, where the letters land in their layout slots as jelly
// bodies, with the lede under them. Toys popped high enough knock the letters.
//
// The app declares bodies and issues commands at interaction edges; the core
// integrates every tick and writes the poses into the nodes
// (@pocketjs/framework/physics). Per-frame JS is the event drain, the stylus
// drag target while a toy is held, and the d-pad tilt.

import { createSignal, For, onCleanup } from "solid-js";
import { AuxiliarySurface, Image, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate } from "@pocketjs/framework/animation";
import { after, virtualNow } from "@pocketjs/framework/clock";
import { createGesture } from "@pocketjs/framework/gesture";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { createWorld, type Body, type Emitter, type World } from "@pocketjs/framework/physics";
import * as S from "./scene.ts";
import {
  BACKDROP_ART, COPY_ART, HINT_ART, LEDE_ART, LEDE_BOX, LETTER_ART, O_FACE, PARTICLE_ART, POCKET_ART, TOY_ART, WORD_BOX,
} from "./art.ts";
import {
  BOB, DEG, HOME_Y, POCKET_OUTLINE, ROW_SPLIT, SPIT_AT, SPIT_TF, burstEmitter, clamp, landing, letterBody, letterHalf, pocketBodies,
  seededRandom, sparkEmitter, spillFlight, textShelf, twinkleEmitter, type ToyType,
} from "./homepage.ts";
import { createToyBox, type Toy, type ToyBox } from "./toys.ts";
import { AfterMount, box } from "./view.ts";

// ---- the scene's numbers -------------------------------------------------------

const U = S.U;
const G = S.G;
const FS = S.FS;
const ROW_H = WORD_BOX.rowH;
const LEDE_TOP = S.WORD_TOP + WORD_BOX.h + S.LEDE_GAP;
const LEDE_LEFT = (S.W - S.LEDE_SPRITE_W) / 2;
/** Toy node slots, and the live toys kept before the oldest fades out. */
const TOY_CAP = 12;
const LIVE_TOYS = 10;
const LAND = landing(FS);
const O_INDEX = LETTER_ART.findIndex((l) => l.ch === "O");

/** Pocket landmarks in world px; the world is the touch screen. */
const PX = S.POCKET_CX;
const PTOP = S.POCKET_TOP_Y;
const FLOOR = S.FLOOR_Y;
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

/** The wordmark: two flex rows whose slots are the letters' anchors. */
const ROWS = [LETTER_ART.slice(0, ROW_SPLIT), LETTER_ART.slice(ROW_SPLIT)];

export default function Nexus() {
  // -- nodes ---------------------------------------------------------------------
  const sticker: NodeMirror[] = [];
  const shadow: NodeMirror[] = [];
  const toyNodes: NodeMirror[] = [];
  const wordSparks: NodeMirror[] = [];
  const pocketSparks: NodeMirror[] = [];
  const twinkles: NodeMirror[] = [];
  let backWrap: NodeMirror | undefined, eyesWrap: NodeMirror | undefined, frontWrap: NodeMirror | undefined;
  let mouth: NodeMirror | undefined, eyes: NodeMirror | undefined, glow: NodeMirror | undefined;
  let haze: NodeMirror | undefined, lede: NodeMirror | undefined, copy: NodeMirror | undefined, hint: NodeMirror | undefined;

  // -- reactive bits (only at edges) ---------------------------------------------------
  const [shown, setShown] = createSignal<readonly boolean[]>(LETTER_ART.map(() => false));
  const [oFace, setOFace] = createSignal<string>(O_FACE.shut);
  const [eyeArt, setEyeArt] = createSignal<string>(POCKET_ART.eyes);
  // one signal per toy slot, so dressing one slot re-applies only its own style
  const toyArt = Array.from({ length: TOY_CAP }, () => createSignal<{ src: string; size: number }>({ src: TOY_ART.star, size: S.TOY_SPRITE }));
  const setAt = <T,>(get: () => readonly T[], set: (v: readonly T[]) => void, i: number, v: T) => {
    const next = get().slice();
    next[i] = v;
    set(next);
  };

  // -- the world -------------------------------------------------------------------
  const random = seededRandom(0x5eed2026);
  let world: World | undefined;
  let pocket: Body;
  let toys: ToyBox;
  const letters: Body[] = [];
  let burstsWord: Emitter, burstsPocket: Emitter, ambient: Emitter;
  let phase: "sleep" | "spill" | "play" = "sleep";
  let lastPop = -1, lastInteract = 0, landed = 0, userPopped = false;
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
      surfaces: { auxiliary: [0, 0] },
      maxSpeed: 4200 * U,
    });
    world = w;
    // the room: the screen's walls and the floor line; the top edge is a
    // ceiling, as on the homepage
    w.collider({
      shape: { chain: [[0, 0], [0, FLOOR], [S.W, FLOOR], [S.W, 0]], radius: 4, closed: true },
      layer: 4, restitution: 1, friction: 0.75,
    });
    const outline = POCKET_OUTLINE.map(([x, y]) => w.toWorld(...S.pocketPoint(x, y), "auxiliary"));
    const bodies = pocketBodies(w, [backWrap!, eyesWrap!, frontWrap!], outline, PAD, POCKET_PIVOT, U);
    pocket = bodies.pocket;
    bodies.inside.onEnter((body) => toys.enter(body));
    // the lede is a shelf the toys bonk
    textShelf(w, lede!, { l: LEDE_LEFT + LEDE_BOX.l, t: LEDE_TOP + LEDE_BOX.t, r: LEDE_LEFT + LEDE_BOX.r, b: LEDE_TOP + LEDE_BOX.b }, U);

    // letters: parked in the pocket until the spill
    LETTER_ART.forEach((l, i) => {
      const body = w.body({
        ...letterBody(l, i, FS),
        views: [sticker[i], { node: shadow[i], offset: [(5 * FS) / 100, (7 * FS) / 100] }],
        asleep: true, position: [PX, PTOP + 40],
      });
      body.onLand((speed) => letterLanded(i, speed));
      body.onHit((hit) => {
        if (hit.speed > 520 * U) {
          // sparks fly off the letter, back toward the toy
          burstsWord.burst(hit.x, hit.y, 4, { angle: Math.atan2(-hit.ny, -hit.nx) * DEG, spread: 120, speed: 0.6 });
          if (i === O_INDEX && hit.speed > 850 * U) faceFor("wince", 0.6);
        }
      });
      letters.push(body);
    });

    burstsWord = burstEmitter(w, wordSparks, [...PARTICLE_ART.burst, ...PARTICLE_ART.bdot], FS);
    burstsPocket = sparkEmitter(w, pocketSparks, [...PARTICLE_ART.star, ...PARTICLE_ART.dot], U);
    ambient = twinkleEmitter(w, twinkles, [PARTICLE_ART.star[0], PARTICLE_ART.star[1], PARTICLE_ART.star[2]], U);
    ambient.stream(3.2, PX - PW * 0.38, PTOP - 6, PW * 0.76, 6);

    toys = createToyBox({
      world: w, slots: TOY_CAP, live: LIVE_TOYS,
      views: (slot) => [toyNodes[slot]],
      show(slot, type, scale) {
        toyArt[slot][1]({ src: TOY_ART[type], size: S.TOY_SPRITE * scale });
        // an animation, so it replaces a fade still running on a reused slot
        animate(toyNodes[slot], "opacity", 1, { dur: 1 });
      },
      hide(slot, fade) {
        animate(toyNodes[slot], "opacity", 0, { dur: fade ? 600 : 1 });
      },
      pocket, pocketWall: bodies.wall,
      px: PX, ptop: PTOP, pw: PW, pad: PAD, floor: FLOOR,
      halfWidth: S.W / 2, radius: S.TOY_R, u: U, g: G,
      // up to the ceiling; the higher ones knock the lede and the letters
      apex(r, _def, flat) {
        const room = S.POCKET_TOP_Y - r * 0.8, lo = r + PAD + 8;
        return clamp(random.range(flat ? 0.4 : 0.5, flat ? 0.75 : 1) * room, lo, room);
      },
      random, later, sparks: burstsPocket, twinkles: ambient,
      flash, happy: (seconds) => peek(seconds, true),
      isHeld: (toy) => toy === grabbed,
      left: (toy) => { if (toy === grabbed) release(); },
    });
    toys.tend();
    scheduleIdle();
    scheduleBlink();
    peekSoon(1.2);
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
        peek(random.range(1.2, 2), false);
        pocket.kick({ spin: random.pick([-1, 1]) * random.range(50, 80), squash: 3 });
      }
      peekSoon(random.range(3.5, 6));
    });
  }
  function pocketBurst(n: number) {
    for (let i = 0; i < n; i++) burstsPocket.burst(PX + random.range(-0.3, 0.3) * PW, PTOP - 2, 1, { angle: -90 + random.range(-60, 60), spread: 0 });
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
    toys.pop();
    pocketBurst(14);
    if (!userPopped && phase === "play") {
      userPopped = true;
      if (hint) animate(hint, "opacity", 0, { dur: 350 });
    }
  }
  function popSpecial(type: ToyType, aim: number) {
    toys.plop(type, aim);
    pocketBurst(8);
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
    // the hint stays down: the lede now fills the space it used
    later(end + 0.04, () => { phase = "play"; });
  }
  function launch(i: number, tf: number) {
    // the core reads the slot from layout; the flight starts beneath it
    const home = letters[i].home ?? [PX, 0];
    setAt(shown, setShown, i, true);
    letters[i].launch(spillFlight(home, letterHalf(LETTER_ART[i], FS)[1], { cx: PX, top: PTOP, pw: PW }, FS, tf, random));
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
      if (n < 0 || n >= letters.length || (i < ROW_SPLIT) !== (n < ROW_SPLIT) || !shown()[n]) continue;
      letters[n].kick({ squash: kick * 0.38 });
      letters[n].impulse(0, FS * kick * 0.09);
    }
    if (phase === "spill") {
      const [x, y] = letters[i].home ?? [letters[i].x, letters[i].y];
      burstsWord.burst(x, y + LETTER_ART[i].ih * 0.4, 5, { angle: -90, spread: 150, speed: 0.45 });
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
    later(random.range(2.2, 5.2), () => {
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
    later(random.range(4.2, 7.6), () => {
      if (phase === "play" && virtualNow() - lastInteract > 3.5 && !held) {
        const roll = random();
        if (roll < 0.45) hop(Math.floor(random() * letters.length), 0.45);
        else if (roll < 0.8) faceFor(random.pick(["left", "right"] as const), 1.1);
        else peek(random.range(1.3, 2.3), false);
      }
      scheduleIdle();
    });
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
      const toy = toys.find(body);
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
      burstsPocket.burst(...world.toWorld(c.x, c.y, "auxiliary"), 6, { angle: 0, spread: 360, speed: 0.28 });
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
        if (moved < 8 && virtualNow() - downAt < 0.4) toys.tap(toy);
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
  // a toy slot is a sprite-sized view the body poses, holding the art at the toy's size
  const toyLayer = (list: NodeMirror[]) =>
    <For each={Array.from({ length: TOY_CAP }, (_, i) => i)}>
      {(i) => (
        <View ref={(el) => (list[i] = el)} style={box(0, 0, S.TOY_SPRITE, S.TOY_SPRITE, { opacity: 0 })}>
          <Image
            src={toyArt[i][0]().src}
            style={box((S.TOY_SPRITE - toyArt[i][0]().size) / 2, (S.TOY_SPRITE - toyArt[i][0]().size) / 2, toyArt[i][0]().size, toyArt[i][0]().size)}
          />
        </View>
      )}
    </For>;

  return (
    <AuxiliarySurface>
      <View style={box(0, 0, S.W, S.H)}>
        <Image src={BACKDROP_ART.bottom} style={box(0, 0, 512, 256)} />
        <Image ref={(el) => (haze = el)} src={BACKDROP_ART.haze} style={box(S.W / 2 - 256, S.WORD_TOP + WORD_BOX.h / 2 - 128, 512, 256, { opacity: 0 })} />
        <Image ref={(el) => (glow = el)} src={BACKDROP_ART.glow} style={box(S.POCKET_CX - 128, S.POCKET_TOP_Y - 64, 256, 128, { opacity: 0 })} />
        {pool(twinkles, 12, PARTICLE_ART.star[0])}
        <Image ref={(el) => (lede = el)} src={LEDE_ART} style={box(LEDE_LEFT, LEDE_TOP, S.LEDE_SPRITE_W, S.LEDE_SPRITE_H, { opacity: 0 })} />
        <Image ref={(el) => (copy = el)} src={COPY_ART} style={box(8, S.H - 17, 128, 16, { opacity: 0 })} />
        <View ref={(el) => (backWrap = el)} style={box(POCKET_LEFT, POCKET_TOP, S.POCKET_SPRITE, S.POCKET_SPRITE)}>
          <Image ref={(el) => (mouth = el)} src={POCKET_ART.mouth} style={box(0, MOUTH_Y - 16, 128, 32, { scaleY: MOUTH_REST })} />
        </View>
        {/* the wordmark sits between the pocket's mouth and its front, so a letter rises out of it */}
        <View style={box(0, S.WORD_TOP, S.W, WORD_BOX.h, { flexDir: 1, align: 1, gap: S.ROW_GAP })}>
          <For each={ROWS}>
            {(row, r) => (
              <View style={{ flexDir: 0, gap: S.LETTER_GAP, height: ROW_H }}>
                <For each={row}>
                  {(l, k) => {
                    const i = r() * ROW_SPLIT + k();
                    const left = (l.w - S.LETTER_SPRITE) / 2, top = (ROW_H - S.LETTER_SPRITE) / 2 + HOME_Y[i] * FS;
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
        {pool(wordSparks, 24, PARTICLE_ART.burst[0])}
        <View ref={(el) => (eyesWrap = el)} style={box(POCKET_LEFT, POCKET_TOP, S.POCKET_SPRITE, S.POCKET_SPRITE)}>
          <Image ref={(el) => (eyes = el)} src={eyeArt()} style={box(32, EYES_SHOWN_Y - 16, 64, 32, { translateY: EYES_HIDDEN })} />
        </View>
        {toyLayer(toyNodes)}
        <View ref={(el) => (frontWrap = el)} style={box(POCKET_LEFT, POCKET_TOP, S.POCKET_SPRITE, S.POCKET_SPRITE)}>
          <Image class="animate-breathe" src={POCKET_ART.front} style={box(0, 0, S.POCKET_SPRITE, S.POCKET_SPRITE, { originY: POCKET_PIVOT / S.POCKET_SPRITE })} />
        </View>
        {pool(pocketSparks, 32, PARTICLE_ART.star[0])}
        <View style={box(S.POCKET_CX - 34, S.POCKET_TOP_Y - 70, 128, 64)}>
          <Image ref={(el) => (hint = el)} class="animate-nudge" src={HINT_ART} style={box(0, 0, 128, 64)} />
        </View>
        <AfterMount run={setup} />
      </View>
    </AuxiliarySurface>
  );
}
