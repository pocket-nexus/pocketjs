// ported from GameBlocks' archery-hunting (https://gb-archery-hunting.vercel.app/, MIT, xt4d/GameBlocks)
//
// Archery Hunting's gameplay over the playset kernels.
//
// What runs where:
//   native, every step — the hunter's first-person walk (character kernel,
//     fps frame) and the camera on it, gravity on every arrow (ballistic
//     kernel), the animals' wandering and bolting (herd brain on character
//     kernels, leg swing joints), arrow contacts with targets (one rule),
//     arrows stopping at trunks and rocks (static colliders), particles,
//     blob shadows, the bow string's joints;
//   here, at event rate — loosing an arrow (aim ray, charge to speed),
//     scoring a hit and its weak spot, the challenge timer, quota and
//     ammunition, the three challenges;
//   here, on a budget — the bow and the nocked arrow placed in the camera
//     frame (per frame, a dozen floats), wind on arrows in flight and the
//     ring targets' figure-eight paths (every 2nd step), stealth: the noise
//     and visibility meters, the rings' alertness and the animals' hearing
//     radius (every 6th step), and the demo autopilot (ai.ts).
//
// Deviations from the demo: the view is 58 degrees and closes to 38 at full
// draw (the demo keeps 72, which leaves a target 40 m out a few pixels tall
// on 240 lines); the hunter starts facing the target zones (the demo starts
// facing away and turns); 78 of the demo's 155 trees, 18 of its
// 36 rocks and 130 of its 260 grass blades are placed, from the same seeded
// sequence, so the rest of the forest stands where it stood; arrows stop at
// trunks and rocks (the demo's pass through); animals and the warden wander
// and bolt on the herd brain instead of tracing figure-eights, so they
// face where they walk; the stealth check for being seen ignores which way
// an animal faces; a challenge cleared leads to the next after a short
// pause instead of a results screen.
//
// Coordinates: right is +X, up +Y, forward -Z. The demo's (right r,
// forward f) is (r, -f) here.

import {
  ENT,
  EVENT,
  brain,
  createPlayset,
  joint,
  layers,
  motion,
  sfx,
  type Archetype,
  type Emitter,
  type Playset,
  type Sound,
} from "@pocketjs/framework/playset";
import { BTN } from "../../../contracts/spec/spec.ts";
import { mulberry, type Random } from "../kit/random.ts";
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";
import * as THREE from "@pocketjs/framework/playset/three";
import * as V from "./visuals.ts";
import { EYE, T_ANIMAL, T_CREATURE, T_RING, TARGET_SHAPE } from "./visuals.ts";
import { Autopilot } from "./ai.ts";

export const L = layers("player", "target", "arrow");

export const FOOT = 0.1;
/** the view at rest and at full draw: the demo's 72 degrees would leave a
 *  target 40 m out a few pixels tall on 240 lines, so the view is narrower
 *  and closes further as the bow comes to full draw */
const FOV = 58;
const FOV_DRAWN = 38;
const FAR = 106;
const DT = 1 / 60;
const BOUND = 88;

export interface Challenge {
  readonly name: string;
  readonly seconds: number;
  readonly ammo: number;
  readonly needed: number;
  readonly objective: string;
  readonly targetCount: number;
  readonly animals: number;
  readonly creature: boolean;
  readonly wind: number;
}

export const CHALLENGES: readonly Challenge[] = [
  { name: "Trail Range", seconds: 105, ammo: 16, needed: 9, objective: "Hit 9 marked targets", targetCount: 10, animals: 2, creature: false, wind: 0.9 },
  { name: "Silent Stalk", seconds: 120, ammo: 15, needed: 8, objective: "Score 8 quiet hits", targetCount: 4, animals: 8, creature: false, wind: 1.4 },
  { name: "Moonlit Warden", seconds: 130, ammo: 17, needed: 10, objective: "Track the forest warden", targetCount: 5, animals: 5, creature: true, wind: 2.0 },
];

/** Target zones in the demo's (right, forward) and radius. */
export const ZONES: readonly { readonly x: number; readonly f: number; readonly r: number }[] = [
  { x: -34, f: -22, r: 14 },
  { x: 28, f: -30, r: 16 },
  { x: -18, f: -58, r: 14 },
  { x: 42, f: 10, r: 13 },
];

export const MAX_TARGETS = 16;

export type Mode = "title" | "playing" | "interlude" | "gameover";

export interface Hud {
  mode: Mode;
  demo: boolean;
  challenge: number;
  score: number;
  hits: number;
  needed: number;
  timer: number;
  ammo: number;
  draw: number;
  noise: number;
  visibility: number;
  cleared: boolean;
}

const PAD_DIRECTIONS = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT;
const DRAW_BUTTONS = BTN.CIRCLE | BTN.CROSS;

export class ArcheryHunting {
  readonly play: Playset;
  readonly hud: Hud = {
    mode: "title", demo: true, challenge: 0, score: 0, hits: 0, needed: 9, timer: 105, ammo: 16, draw: 0, noise: 0, visibility: 0, cleared: false,
  };
  readonly random: Random = mulberry(20260616);
  /** footsteps and bird calls, apart from the forest and target draws */
  private readonly noise = mulberry(7);
  player = -1;
  private bowSlot = -1;
  private nocked = -1;
  private crosshair = -1;
  private readonly markers: number[] = [];

  // targets: flat tables indexed 0..targetCount
  targetCount = 0;
  readonly tSlot = new Int16Array(MAX_TARGETS);
  readonly tType = new Uint8Array(MAX_TARGETS);
  readonly tZone = new Uint8Array(MAX_TARGETS);
  readonly tPhase = new Float32Array(MAX_TARGETS);
  readonly tSpeed = new Float32Array(MAX_TARGETS);
  readonly tAlert = new Float32Array(MAX_TARGETS);
  readonly tAlive = new Uint8Array(MAX_TARGETS);
  private readonly tBolting = new Uint8Array(MAX_TARGETS);
  private readonly slotTarget: Int16Array;

  // the trees and rocks as sight blockers for the autopilot, bucketed on a grid
  readonly blockX: number[] = [];
  readonly blockZ: number[] = [];
  readonly blockR: number[] = [];
  readonly blockBase: number[] = [];
  readonly blockTop: number[] = [];
  blockCells: Int32Array = new Int32Array(0);
  blockItems: Int16Array = new Int16Array(0);

  elapsed = 0;
  windPhase = 0;
  windStrength = 0;
  arrowsInFlight = 0;
  private message = "";
  private messageTimer = 0;
  private interlude = 0;
  private tick = 0;
  private drawHeld = false;
  /** A must come up once after the press that started the run */
  private latched = true;
  private crouch = false;
  private sprint = false;
  private speedRatio = 0;
  private stepDistance = 0;
  private chirpTimer = 3;
  private lastTick = -1;
  private sightBucket = -1;
  private sightRetuned = -100;
  private lastArrow = -1;
  private windVoice = 0;
  private fov = FOV;
  readonly ai: Autopilot;

  readonly playerArch: Archetype;
  readonly arrowArch: Archetype;
  private readonly bowArch: Archetype;
  private readonly nockArch: Archetype;
  readonly ringArch: Archetype;
  readonly animalArch: Archetype;
  readonly creatureArch: Archetype;
  private readonly crosshairModel: { id: number; joints: readonly string[] };
  private readonly dust: Emitter;
  private readonly gold: Emitter;
  private readonly s: Record<string, Sound>;

  constructor() {
    const play = createPlayset({ capacity: 160, particles: 500, seed: 20260616 });
    this.play = play;
    this.slotTarget = new Int16Array(play.capacity).fill(-1);
    play.sky(V.PALETTE.skyTop, V.PALETTE.skyHorizon, V.PALETTE.skyLower);
    play.fog(V.PALETTE.fog, 24, 104, 0.94);
    // the demo's hemisphere (2.1) and sun (3.0) from (-45, 70, 30) in its basis
    play.light({ sun: [-45, 70, -30], sunColor: 0xffdf9a, sunIntensity: 1.45, sky: 0xd7f3ff, ground: 0x3b4e35, ambient: 0.62 });
    play.gravity(9.8);
    play.bounds(-BOUND, BOUND, -BOUND, BOUND, -20, 200);
    play.terrain({
      size: V.TERRAIN_SIZE,
      resolution: 48,
      height: V.terrainHeight,
      // TerrainSampler.colorAt: two greens split at 2.1 m
      bands: [[-10, V.PALETTE.grassLow], [1.95, V.PALETTE.grassLow], [2.25, V.PALETTE.grassHigh]],
    });
    this.buildForest();

    // sounds: rendered once, played natively where they happen or from here
    this.s = {
      bow: play.sound(sfx.bow()),
      creak: play.sound({ wave: "saw", freq: 70, to: 125, attack: 0.06, sustain: 0.32, decay: 0.2, noise: 0.25, lowpass: 0.75, crush: 0.2, volume: 0.2 }),
      whoosh: play.sound({ ...sfx.whoosh(), volume: 0.16 }),
      thunk: play.sound({ wave: "noise", freq: 420, to: 90, exp: true, sustain: 0.01, decay: 0.12, lowpass: 0.55, volume: 0.36 }),
      tick: play.sound({ wave: "square", freq: 520, to: 260, exp: true, sustain: 0.005, decay: 0.07, noise: 0.35, lowpass: 0.4, volume: 0.3 }),
      board: play.sound({ wave: "square", freq: 190, to: 95, exp: true, sustain: 0.015, decay: 0.2, noise: 0.25, lowpass: 0.5, harmonic: 1.5, harmonicMix: 0.3, volume: 0.5 }),
      bleat: play.sound({ wave: "saw", freq: 520, to: 330, sustain: 0.18, decay: 0.22, vibrato: 90, vibratoRate: 9, lowpass: 0.35, volume: 0.36 }),
      chime: play.sound({ ...sfx.powerup(), freq: 520, to: 1560, echo: 0.12, echoFeedback: 0.4 }),
      weak: play.sound(sfx.coin()),
      hooves: play.sound({ wave: "noise", freq: 260, to: 110, sustain: 0.02, decay: 0.08, lowpass: 0.6, echo: 0.09, echoFeedback: 0.55, volume: 0.42 }),
      step: play.sound({ ...sfx.step(), volume: 0.14 }),
      chirp: play.sound({ wave: "sine", freq: 2600, to: 3400, sustain: 0.03, decay: 0.07, arp: 1.18, arpTime: 0.05, vibrato: 60, vibratoRate: 28, echo: 0.11, echoFeedback: 0.3, volume: 0.1 }),
      wind: play.sound(sfx.wind()),
      start: play.sound(sfx.wave()),
      win: play.sound(sfx.win()),
      lose: play.sound(sfx.lose()),
      clock: play.sound({ ...sfx.select(), volume: 0.18 }),
      empty: play.sound(sfx.grab()),
    };

    const trail = play.emitter({ count: 1, life: 0.22, lifeJitter: 0.05, speed: 0.15, size: [0.07, 0.01], color: [0xfff6d8, 0xfff6d8], alpha: [0.5, 0], blend: "add", drag: 0 });
    const chips = play.emitter({ count: 14, life: 0.6, speed: 4, size: [0.12, 0.04], color: [0xf7f2d2, 0x6b4328], alpha: [1, 0], blend: "alpha", drag: 1.2, gravity: 1 });
    const fur = play.emitter({ count: 22, life: 0.8, speed: 3, size: [0.2, 0.05], color: [0x93633e, 0x3b281e], alpha: [0.95, 0], blend: "alpha", drag: 2, gravity: 0.3 });
    const sparkle = play.emitter({ count: 40, life: 1.0, speed: 4, size: [0.22, 0.04], color: [0xaee8ff, 0x56cfff], alpha: [1, 0], blend: "add", drag: 1.5 });
    this.dust = play.emitter({ count: 9, life: 0.5, speed: 1.8, spread: 0.9, dir: [0, 1, 0], size: [0.2, 0.06], color: [0xb9a77a, 0x8f8160], alpha: [0.8, 0], blend: "alpha", drag: 2.5, gravity: 0.2 });
    this.gold = play.emitter({ count: 26, life: 0.7, speed: 3.5, size: [0.18, 0.03], color: [0xfff1a8, 0xf1d172], alpha: [1, 0], blend: "add", drag: 1.5 });

    this.playerArch = play.archetype({
      model: null,
      // updatePlayer: walk 5.4, sprint 8.2, crouch 2.8 (the stick scaled)
      motion: motion.character({ walk: 5.4, run: 8.2 / 5.4, accel: 38, jump: 0, turnRate: 2.3, frame: "fps", pitchRate: 1.25, pitchMax: 1.1 }),
      layer: L.player, team: 1, radius: 0.55, height: 1.7, ground: "gravity", groundOffset: FOOT, bounds: "clamp", keepOnDeath: true, immortal: true,
    });
    const bowModel = play.model(V.bow());
    this.bowArch = play.archetype({ model: bowModel, motion: motion.none(), joints: [joint.script("stringTop", "x"), joint.script("stringBottom", "x")] });
    this.nockArch = play.archetype({ model: play.model(V.heldArrow()), motion: motion.none() });
    this.arrowArch = play.archetype({
      model: play.model(V.arrow()),
      motion: motion.ballistic({ gravity: 1, drag: 0, dieOnGround: true, align: true }),
      layer: L.arrow, hits: L.target, team: 1, radius: 0.12, projectile: true, lifetime: 6.5, bounds: "kill",
      trail, trailRate: 40, death: chips, sounds: { death: this.s.tick },
    });
    this.ringArch = play.archetype({
      model: play.model(V.ringTarget()), motion: motion.none(), layer: L.target, radius: TARGET_SHAPE[0].radius, height: TARGET_SHAPE[0].body * 2,
      ground: "snap", ghost: true, shadow: 0.55, death: chips, sounds: { death: this.s.board },
    });
    const animalModel = play.model(V.animalTarget());
    const herd = (sight: number) =>
      brain.herd({ target: { nearest: L.player, sight, every: 0.4 }, panic: 2.6, every: 2.5, turn: 1.2, leash: 9 });
    this.animalArch = play.archetype({
      model: animalModel,
      motion: motion.character({ walk: 3.0, run: 2.3, accel: 14, jump: 0, turnRate: 3, frame: "world", face: "move" }),
      brain: herd(14), layer: L.target, radius: TARGET_SHAPE[1].radius, height: TARGET_SHAPE[1].body * 2, ground: "gravity", bounds: "clamp",
      shadow: 0.8, death: fur, sounds: { death: this.s.bleat },
      joints: [joint.swing("front", 0.5), joint.swing("back", -0.5)],
    });
    this.creatureArch = play.archetype({
      model: play.model(V.creatureTarget()),
      motion: motion.character({ walk: 3.2, run: 2.4, accel: 12, jump: 0, turnRate: 2.4, frame: "world", face: "move" }),
      brain: herd(14), layer: L.target, radius: TARGET_SHAPE[2].radius, height: TARGET_SHAPE[2].body * 2, ground: "gravity", bounds: "clamp",
      shadow: 1.1, death: sparkle, sounds: { death: this.s.chime },
    });
    this.crosshairModel = play.model(V.crosshair());

    for (const z of ZONES) this.markers.push(play.place(play.model(V.zoneMarker(z.x, -z.f, z.r)), [z.x, 0, -z.f], { static: false, hidden: true }));
    this.crosshair = play.place(this.crosshairModel, [0, -50, 0], { static: false });

    play.rule(L.arrow, L.target, { kill: "both", event: true });
    play.on(EVENT.HIT, (a, b, _rule, x, y, z) => this.onHit(a, b, x, y, z));
    play.on(EVENT.GROUND, (_slot, _owner, arch, x, y, z, value) => {
      // an arrow into the turf; a trunk or a rock (value -1) plays its own effects
      if (arch === this.arrowArch.id && value >= 0) {
        play.burst(this.dust, x, y, z);
        play.play(this.s.thunk, 0.8, 1, [x, y, z]);
      }
    });

    this.ai = new Autopilot(this);
    this.reset(true);
  }

  // --- the world ------------------------------------------------------------

  /** NaturalEnvironment.create with the demo's counts and draws; every
   *  other tree, rock and blade is placed. */
  private buildForest(): void {
    const play = this.play;
    const prng = this.random;
    const half = 0.48 * V.TERRAIN_SIZE;
    // SpawnAreaSampler: the bounds less a circle of 10 m around the start
    const sample = (radius: number): [number, number] | null => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const r = prng.uniform(-half, half);
        const f = prng.uniform(-half, half);
        const dr = r, df = f - 18, keep = 10 + radius;
        if (dr * dr + df * df > keep * keep) return [r, f];
      }
      return null;
    };
    const materials = V.treeMaterials();
    for (let i = 0; i < 155; i++) {
      const height = prng.uniform(5, 10.5);
      const radius = prng.uniform(0.24, 0.55);
      const point = sample(radius + 0.35);
      if (!point) continue;
      const group = V.tree(height, radius, materials, prng);
      const yaw = prng.uniform(0, Math.PI * 2);
      const pitch = prng.uniform(-0.025, 0.025);
      const roll = prng.uniform(-0.035, 0.035);
      if (i % 2 === 1) continue;
      const x = point[0], z = -point[1];
      const y = V.terrainHeight(x, z);
      play.place(play.model(group), [x, y, z], { yaw, pitch, roll });
      play.colliderCylinder([x, y + height * 0.5, z], radius + 0.15, height * 0.5);
      this.addBlocker(x, z, Math.max(radius + 0.75, height * 0.22), y, height * 1.22);
    }
    const stone = new THREE.MeshStandardMaterial({ color: 0x7b827a });
    for (let i = 0; i < 36; i++) {
      const point = sample(1.2);
      if (!point) continue;
      const rock = V.groundRock(stone, prng);
      if (i % 2 === 1) continue;
      const x = point[0], z = -point[1];
      const y = V.terrainHeight(x, z) + 0.35;
      play.place(play.model(rock), [x, y, z]);
      play.colliderCylinder([x, y, z], 1.0, 0.6);
      this.addBlocker(x, z, 1.35, y - 0.35, 1.25);
    }
    // the blades come in six heights, so six models serve them all
    const grass = new THREE.MeshStandardMaterial({ color: 0xa2b86a });
    const blades: { id: number; joints: readonly string[] }[] = [];
    for (let i = 0; i < 260; i++) {
      const point = sample(0.1);
      if (!point) continue;
      const h = prng.uniform(0.45, 1.2);
      const yaw = prng.uniform(0, Math.PI * 2);
      if (i % 2 === 1) continue;
      const k = Math.min(5, Math.floor(((h - 0.45) / 0.75) * 6));
      if (!blades[k]) blades[k] = play.model(V.grassBlade(grass, 0.45 + (k + 0.5) * 0.125));
      const x = point[0], z = -point[1];
      play.place(blades[k], [x, V.terrainHeight(x, z) + 0.25, z], { yaw });
    }
    this.bucketBlockers();
  }

  private addBlocker(x: number, z: number, r: number, base: number, height: number): void {
    this.blockX.push(x);
    this.blockZ.push(z);
    this.blockR.push(r);
    this.blockBase.push(base - 0.08);
    this.blockTop.push(base - 0.08 + height);
  }

  /** 15 x 15 cells of 12 m over the map; a blocker sits in every cell its
   *  circle touches. blockCells[c]..blockCells[c + 1] index blockItems. */
  private bucketBlockers(): void {
    const n = 15;
    const lists: number[][] = Array.from({ length: n * n }, () => []);
    for (let i = 0; i < this.blockX.length; i++) {
      const r = this.blockR[i];
      const x0 = cellOf(this.blockX[i] - r), x1 = cellOf(this.blockX[i] + r);
      const z0 = cellOf(this.blockZ[i] - r), z1 = cellOf(this.blockZ[i] + r);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) lists[cz * n + cx].push(i);
    }
    this.blockCells = new Int32Array(n * n + 1);
    const items: number[] = [];
    for (let c = 0; c < n * n; c++) {
      this.blockCells[c] = items.length;
      items.push(...lists[c]);
    }
    this.blockCells[n * n] = items.length;
    this.blockItems = Int16Array.from(items);
  }

  // --- runs and challenges ------------------------------------------------------

  reset(demo: boolean): void {
    const hud = this.hud;
    hud.demo = demo;
    hud.score = 0;
    hud.cleared = false;
    this.latched = true;
    if (this.windVoice === 0) this.windVoice = this.play.loop(this.s.wind, 0.15);
    this.startChallenge(0);
    hud.mode = demo ? "title" : "playing";
  }

  startChallenge(index: number): void {
    const play = this.play;
    const hud = this.hud;
    const c = CHALLENGES[index];
    play.clear();
    this.slotTarget.fill(-1);
    hud.challenge = index;
    hud.hits = 0;
    hud.needed = c.needed;
    hud.timer = c.seconds;
    hud.ammo = c.ammo;
    hud.draw = 0;
    this.windStrength = c.wind;
    this.windPhase = this.random.uniform(0, Math.PI * 2);
    this.arrowsInFlight = 0;
    this.nocked = -1;
    this.drawHeld = false;
    this.lastTick = -1;
    this.interlude = 0;
    // the hunter at the demo's start, turned toward the zones
    this.player = play.spawn(this.playerArch, 0, V.terrainHeight(0, -18) + FOOT, -18, Math.PI);
    play.ent[this.player * 16 + ENT.PITCH] = -0.04;
    this.bowSlot = play.spawn(this.bowArch, 0, 0, 0);
    this.fov = FOV;
    play.firstPersonCamera(this.player, EYE, FOV, FAR);
    this.spawnTargets(c);
    for (let i = 0; i < this.markers.length; i++) {
      const z = ZONES[i];
      play.move(this.markers[i], z.x, 0, -z.f, 0, 0, 0, 1, i >= 3 + (c.creature ? 1 : 0));
    }
    this.ai.reset();
    this.say(c.name, 2.4);
    play.play(this.s.start, 0.7);
  }

  private spawnTargets(c: Challenge): void {
    this.targetCount = 0;
    for (let i = 0; i < c.targetCount; i++) this.spawnTarget(T_RING, i % ZONES.length, i);
    for (let i = 0; i < c.animals; i++) this.spawnTarget(T_ANIMAL, (i + 1) % ZONES.length, i);
    if (c.creature) this.spawnTarget(T_CREATURE, 3, 0);
  }

  private spawnTarget(type: number, zone: number, index: number): void {
    const play = this.play;
    const r = this.random;
    const z = ZONES[zone];
    const angle = r.uniform(0, Math.PI * 2);
    const radius = r.uniform(3, z.r - 2);
    const phase = r.uniform(0, Math.PI * 2);
    const speed = type === T_RING ? r.uniform(0.65, 1.15) : r.uniform(0.38, 0.85);
    const t = this.targetCount;
    if (t >= MAX_TARGETS) return;
    let slot: number;
    if (type === T_RING) {
      // updateTargetTransform at spawn: on its path already
      const time = this.elapsed + index * 0.3;
      const x = z.x + Math.sin(time * speed + phase) * 4.5;
      const wz = -(z.f + Math.cos(time * speed * 0.7 + phase) * 2.7);
      slot = play.spawn(this.ringArch, x, V.terrainHeight(x, wz), wz, 0);
    } else {
      const x = z.x + Math.cos(angle) * radius;
      const wz = -(z.f + Math.sin(angle) * radius);
      slot = play.spawn(type === T_ANIMAL ? this.animalArch : this.creatureArch, x, V.terrainHeight(x, wz), wz, phase);
    }
    if (slot < 0) return;
    this.tSlot[t] = slot;
    this.tType[t] = type;
    this.tZone[t] = zone;
    this.tPhase[t] = phase;
    this.tSpeed[t] = speed;
    this.tAlert[t] = 0;
    this.tAlive[t] = 1;
    this.tBolting[t] = 0;
    this.slotTarget[slot] = t;
    this.targetCount = t + 1;
  }

  /** A ring's place on its figure-eight at `time` (updateTargetTransform). */
  ringX(t: number, time: number): number {
    const z = ZONES[this.tZone[t]];
    return z.x + Math.sin(time * this.tSpeed[t] + this.tPhase[t]) * 4.5 + Math.sin(this.tPhase[t]) * this.tAlert[t] * 5;
  }
  ringZ(t: number, time: number): number {
    const z = ZONES[this.tZone[t]];
    return -(z.f + Math.cos(time * this.tSpeed[t] * 0.7 + this.tPhase[t]) * 2.7 + Math.cos(this.tPhase[t]) * this.tAlert[t] * 5);
  }

  currentWind(): number {
    return Math.sin(this.windPhase) * this.windStrength;
  }

  private say(text: string, seconds = 2.2): void {
    this.message = text;
    this.messageTimer = seconds;
  }

  private finish(success: boolean): void {
    const hud = this.hud;
    if (hud.mode !== "playing" && hud.mode !== "title") return;
    if (this.nocked >= 0) this.play.kill(this.nocked);
    this.nocked = -1;
    if (success && hud.challenge < CHALLENGES.length - 1) {
      this.say(`${CHALLENGES[hud.challenge].name} cleared  ·  next: ${CHALLENGES[hud.challenge + 1].name}`, 3);
      this.interlude = 2.6;
      hud.mode = hud.demo ? "title" : "interlude";
      this.play.play(this.s.win, 0.8);
      return;
    }
    hud.cleared = success;
    hud.mode = "gameover";
    this.play.play(success ? this.s.win : this.s.lose, 0.8);
  }

  // --- shots ------------------------------------------------------------------

  /** The muzzle and the aim ray for the camera's yaw and pitch
   *  (sampleArrowShotFrame): writes eye, forward and muzzle into `out`. */
  shotFrame(out: Float32Array): void {
    const ent = this.play.ent;
    const o = this.player * 16;
    const yaw = ent[o + 6], pitch = ent[o + 7];
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
    const ex = ent[o], ey = ent[o + 1] + EYE, ez = ent[o + 2];
    const fx = -sy * cp, fy = sp, fz = -cy * cp;
    out[0] = ex;
    out[1] = ey;
    out[2] = ez;
    out[3] = fx;
    out[4] = fy;
    out[5] = fz;
    // eye + right * 0.34 - up * 0.26 + forward * 0.62
    out[6] = ex + cy * 0.34 - sy * sp * 0.26 + fx * 0.62;
    out[7] = ey - cp * 0.26 + fy * 0.62;
    out[8] = ez - sy * 0.34 - cy * sp * 0.26 + fz * 0.62;
  }
  private readonly frameScratch = new Float32Array(9);

  /** The player's release (fireArrow): the aim ray from the eye meets a
   *  target's body or runs 150 m, and the arrow leaves the muzzle for that
   *  point at 24 + 44 * draw m/s. */
  private releaseManual(): void {
    const hud = this.hud;
    if (hud.ammo <= 0 || hud.draw < 0.12) {
      hud.draw = 0;
      return;
    }
    const f = this.frameScratch;
    this.shotFrame(f);
    const ex = f[0], ey = f[1], ez = f[2], dx = f[3], dy = f[4], dz = f[5];
    let reach = 150 + 0.75;
    const ent = this.play.ent;
    for (let t = 0; t < this.targetCount; t++) {
      if (!this.tAlive[t]) continue;
      const o = this.tSlot[t] * 16;
      const shape = TARGET_SHAPE[this.tType[t]];
      const cx = ent[o] - ex, cy = ent[o + 1] + shape.body - ey, cz = ent[o + 2] - ez;
      const along = cx * dx + cy * dy + cz * dz;
      if (along <= 0 || along >= reach) continue;
      const miss = cx * cx + cy * cy + cz * cz - along * along;
      const r = shape.radius;
      if (miss > r * r) continue;
      reach = along - Math.sqrt(r * r - miss);
    }
    const ax = ex + dx * reach - f[6], ay = ey + dy * reach - f[7], az = ez + dz * reach - f[8];
    const l = Math.hypot(ax, ay, az) || 1;
    this.launch(ax / l, ay / l, az / l, 24 + hud.draw * 44);
  }

  /** launchArrow: one arrow from the muzzle along (dx, dy, dz). */
  launch(dx: number, dy: number, dz: number, speed: number): boolean {
    const play = this.play;
    const hud = this.hud;
    const f = this.frameScratch;
    this.shotFrame(f);
    const s = play.spawn(this.arrowArch, f[6], f[7], f[8], Math.atan2(-dx, -dz));
    hud.draw = 0;
    if (this.nocked >= 0) play.kill(this.nocked);
    this.nocked = -1;
    if (s < 0) return false;
    hud.ammo -= 1;
    const o = s * 16;
    play.ent[o + 3] = dx * speed;
    play.ent[o + 4] = dy * speed;
    play.ent[o + 5] = dz * speed;
    play.ent[o + 7] = Math.asin(dy);
    play.user[s * 8] = speed;
    this.arrowsInFlight += 1;
    play.play(this.s.bow, 0.9);
    play.play(this.s.whoosh, 0.7, 0.9 + speed / 120);
    return true;
  }

  /** scoreHit: the arrow (slot a) met target slot b at (x, y, z). */
  private onHit(a: number, b: number, x: number, y: number, z: number): void {
    const t = this.slotTarget[b];
    if (t < 0 || !this.tAlive[t] || a === this.lastArrow) return;
    this.lastArrow = a;
    const play = this.play;
    const hud = this.hud;
    const ent = play.ent;
    this.tAlive[t] = 0;
    this.slotTarget[b] = -1;
    hud.hits += 1;
    // the weak spot: the arrow's path over this step and the next against it
    const shape = TARGET_SHAPE[this.tType[t]];
    const o = a * 16, ob = b * 16;
    const wx = ent[ob], wy = ent[ob + 1] + shape.weak, wz = ent[ob + 2];
    const vx = ent[o + 3] * DT, vy = ent[o + 4] * DT, vz = ent[o + 5] * DT;
    const px = ent[o] - vx, py = ent[o + 1] - vy, pz = ent[o + 2] - vz;
    const k = Math.max(0, Math.min(2, ((wx - px) * vx + (wy - py) * vy + (wz - pz) * vz) / Math.max(vx * vx + vy * vy + vz * vz, 1e-6)));
    const mx = px + vx * k - wx, my = py + vy * k - wy, mz = pz + vz * k - wz;
    const weak = mx * mx + my * my + mz * mz < (shape.radius * 0.26) ** 2;
    const po = this.player * 16;
    const distance = Math.hypot(x - ent[po], y - ent[po + 1], z - ent[po + 2]);
    const distanceBonus = Math.round(Math.min(95, distance * 1.4));
    const timingBonus = Math.round(Math.max(0, hud.timer) * 1.5);
    const power = Math.max(0, 1 - Math.abs(play.user[a * 8] - 58) / 50);
    const total = Math.round(shape.value + distanceBonus + timingBonus + power * 60 + (weak ? 140 : 0));
    hud.score += total;
    this.say(`${weak ? "Weak spot" : "Hit"} +${total}`);
    if (weak) {
      play.burst(this.gold, wx, wy, wz);
      play.play(this.s.weak, 0.8);
    }
    if (hud.hits >= hud.needed) this.finish(true);
  }

  // --- the frame -----------------------------------------------------------------

  frame(pad: Pad): void {
    const play = this.play;
    const hud = this.hud;
    const ent = play.ent;
    const p = this.player * 16;
    this.tick++;
    this.lastArrow = -1;
    if (this.messageTimer > 0) this.messageTimer -= DT;
    const live = hud.mode === "playing" || (hud.mode === "title" && this.interlude <= 0);
    if (this.interlude > 0) {
      this.interlude -= DT;
      if (this.interlude <= 0) {
        this.startChallenge(hud.challenge + 1);
        hud.mode = hud.demo ? "title" : "playing";
      }
    }
    const mx = 0;
    let mf = 0, turn = 0, rise = 0;
    let drawing = false;
    if (live) {
      this.elapsed += DT;
      hud.timer -= DT;
      this.windPhase += DT * 0.55;
      if (hud.demo) {
        this.ai.step();
        mf = this.ai.forward;
        this.crouch = this.ai.crouch;
        this.sprint = this.ai.sprint;
        drawing = this.ai.drawing;
      } else {
        const held = pad.held;
        if (this.latched && (held & DRAW_BUTTONS) === 0) this.latched = false;
        drawing = !this.latched && (held & DRAW_BUTTONS) !== 0;
        if (held & PAD_DIRECTIONS) {
          // the d-pad looks around
          turn = pad.x;
          rise = pad.y * 0.8;
        } else if (drawing) {
          // drawn: the circle pad aims, finer
          turn = pad.x * 0.4;
          rise = pad.y * 0.55;
        } else {
          mf = pad.y;
          turn = pad.x;
        }
        // the New 3DS C-stick looks as well
        turn += pad.rx;
        rise += pad.ry * 0.8;
        this.crouch = (held & BTN.LTRIGGER) !== 0;
        this.sprint = !this.crouch && (held & BTN.RTRIGGER) !== 0 && mf > 0.2;
        if (this.drawHeld && !drawing) this.releaseManual();
      }
      if (this.crouch) mf *= 2.8 / 5.4;
      this.bow(drawing);
      const fov = Math.round((FOV + (FOV_DRAWN - FOV) * hud.draw * hud.draw) * 2) / 2;
      if (fov !== this.fov) {
        this.fov = fov;
        play.firstPersonCamera(this.player, EYE, fov, FAR);
      }
      // updatePlayer's meters
      const speed = Math.hypot(ent[p + 3], ent[p + 5]);
      this.speedRatio = Math.min(1, speed / 8.2);
      hud.noise += (this.speedRatio * (this.sprint ? 1 : this.crouch ? 0.24 : 0.55) - hud.noise) * 0.08;
      hud.visibility += ((this.crouch ? 0.28 : 0.62) - hud.visibility) * 0.08;
      this.footsteps(speed);
      if ((this.tick & 1) === 0) this.moveRingsAndArrows();
      if (this.tick % 6 === 3) this.stealth();
      this.ambience();
      if (hud.timer <= 0 && hud.hits < hud.needed) this.finish(false);
      else if (hud.ammo <= 0 && this.arrowsInFlight === 0 && hud.hits < hud.needed && this.nocked < 0) this.finish(false);
      const second = Math.ceil(hud.timer);
      if (second <= 10 && second !== this.lastTick && second > 0) {
        this.lastTick = second;
        play.play(this.s.clock, 0.8);
      }
    } else {
      this.bow(false);
    }
    play.steer(this.player, mx, mf, turn, rise);
    play.buttons(this.player, 0, 0, 0, this.sprint && live ? 1 : 0);
    play.frame(DT);
    this.placeBow();
  }

  /** updateBow: the draw builds over 1.05 s while held and eases off at 4/s;
   *  the first pull creaks and nocks an arrow. */
  private bow(drawing: boolean): void {
    const hud = this.hud;
    const can = drawing && hud.ammo > 0;
    if (drawing && !this.drawHeld) {
      if (hud.ammo > 0) this.play.play(this.s.creak, 0.9);
      else this.play.play(this.s.empty, 0.8);
    }
    this.drawHeld = drawing;
    if (can) hud.draw = Math.min(1, hud.draw + DT / 1.05);
    else hud.draw = Math.max(0, hud.draw - DT * 4);
    const show = hud.mode !== "gameover" && (can || hud.draw > 0.03);
    if (show && this.nocked < 0) this.nocked = this.play.spawn(this.nockArch, 0, 0, 0);
    else if (!show && this.nocked >= 0) {
      this.play.kill(this.nocked);
      this.nocked = -1;
    }
  }

  /** The bow in the camera frame, its string pulled back by the draw, and
   *  the nocked arrow on the string; then the crosshair. */
  private placeBow(): void {
    const play = this.play;
    const ent = play.ent;
    const o = this.player * 16;
    const yaw = ent[o + 6], pitch = ent[o + 7];
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
    const ex = ent[o], ey = ent[o + 1] + EYE, ez = ent[o + 2];
    const draw = this.hud.draw;
    const b = this.bowSlot * 16;
    // bowGroup.position.z = -1.18 - draw * 0.025: along the view
    const pushed = -draw * 0.025;
    ent[b] = ex - sy * cp * -pushed;
    ent[b + 1] = ey + sp * -pushed;
    ent[b + 2] = ez - cy * cp * -pushed;
    ent[b + 6] = yaw;
    ent[b + 7] = pitch;
    const angle = Math.atan2(V.PULL * draw, V.STRING.top);
    play.joints[this.bowSlot * 4] = -angle;
    play.joints[this.bowSlot * 4 + 1] = angle;
    if (this.nocked >= 0) {
      // the nock in the camera frame: bowGroup's offset + scale * (yawed nock)
      const k = V.BOW.scale;
      const nx = V.STRING.x, ny = draw * 0.01, nz = V.STRING.z + draw * V.PULL;
      const c = Math.cos(V.BOW.yaw), s = Math.sin(V.BOW.yaw);
      const lx = V.BOW.x + k * (c * nx + s * nz);
      const ly = V.BOW.y + k * ny;
      const lz = V.BOW.z + pushed + k * (-s * nx + c * nz);
      const a = this.nocked * 16;
      // eye + right * lx + up * ly + back * lz
      ent[a] = ex + cy * lx + sy * sp * ly + sy * cp * lz;
      ent[a + 1] = ey + cp * ly - sp * lz;
      ent[a + 2] = ez - sy * lx + cy * sp * ly + cy * cp * lz;
      ent[a + 6] = yaw;
      ent[a + 7] = pitch;
    }
    play.move(this.crosshair, ex, ey, ez, yaw, pitch, 0, 1, this.hud.mode === "gameover");
  }

  /** Every 2nd step: rings toward their figure-eight places, facing the
   *  hunter; wind on the arrows in flight (updateArrows' 0.38 * wind). */
  private moveRingsAndArrows(): void {
    const play = this.play;
    const ent = play.ent;
    const p = this.player * 16;
    const px = ent[p], pz = ent[p + 2];
    const time = this.elapsed + DT * 2;
    const inv = 1 / (DT * 2);
    for (let t = 0; t < this.targetCount; t++) {
      if (!this.tAlive[t] || this.tType[t] !== T_RING) continue;
      const o = this.tSlot[t] * 16;
      const x = this.ringX(t, time), z = this.ringZ(t, time);
      ent[o + 3] = (x - ent[o]) * inv;
      ent[o + 4] = 0;
      ent[o + 5] = (z - ent[o + 2]) * inv;
      ent[o + 6] = Math.atan2(-(px - ent[o]), -(pz - ent[o + 2]));
    }
    const n = play.ofArchetype(this.arrowArch);
    this.arrowsInFlight = n;
    const push = this.currentWind() * 0.38 * DT * 2;
    const list = play.list;
    for (let i = 0; i < n; i++) ent[list[i] * 16 + 3] += push;
  }

  /** updateStealthAndTargets every 6th step: a ring grows alert when it hears
   *  or sees the hunter; an animal's hearing is the herd brain's sight. */
  private stealth(): void {
    const play = this.play;
    const hud = this.hud;
    const ent = play.ent;
    const p = this.player * 16;
    const px = ent[p], py = ent[p + 1], pz = ent[p + 2];
    const dt = DT * 6;
    const hear = hud.noise * 34;
    const see = hud.visibility * 46;
    for (let t = 0; t < this.targetCount; t++) {
      if (!this.tAlive[t]) continue;
      const slot = this.tSlot[t];
      const o = slot * 16;
      if (this.tType[t] === T_RING) {
        const d = Math.hypot(ent[o] - px, ent[o + 1] - py, ent[o + 2] - pz);
        const a = this.tAlert[t] + (hear > d || see > d ? dt : -dt * 0.45);
        this.tAlert[t] = a < 0 ? 0 : a > 1 ? 1 : a;
      } else {
        const running = ent[o + 9] > 4.2;
        this.tAlert[t] = running ? 1 : Math.max(0, this.tAlert[t] - dt * 0.45);
        if (running && !this.tBolting[t]) {
          this.tBolting[t] = 1;
          play.playAt(this.s.hooves, slot, 0.9);
        } else if (!running && ent[o + 9] < 2) this.tBolting[t] = 0;
      }
    }
    // the herd hears within noise * 34 m and sees an upright hunter at half
    // the demo's sight; retuned in 2 m steps, at most every 20 steps
    const bucket = Math.round(Math.max(hear, see * 0.5) / 2);
    if (bucket !== this.sightBucket && this.tick - this.sightRetuned >= 20) {
      this.sightBucket = bucket;
      this.sightRetuned = this.tick;
      const sight = Math.max(1, bucket * 2);
      const b = brain.herd({ target: { nearest: L.player, sight, every: 0.4 }, panic: 2.6, every: 2.5, turn: 1.2, leash: 9 });
      play.retune(this.animalArch, { brain: b });
      play.retune(this.creatureArch, { brain: b });
    }
  }

  private footsteps(speed: number): void {
    this.stepDistance += speed * DT;
    if (this.stepDistance > (this.sprint ? 2.2 : 1.6)) {
      this.stepDistance = 0;
      this.play.play(this.s.step, this.sprint ? 1 : this.crouch ? 0.35 : 0.7, 0.9 + this.noise() * 0.2);
    }
  }

  private ambience(): void {
    this.chirpTimer -= DT;
    if (this.chirpTimer <= 0) {
      this.chirpTimer = 2.5 + this.noise() * 5;
      const pitch = 0.8 + this.noise() * 0.45;
      this.play.play(this.s.chirp, 0.6 + this.noise() * 0.4, pitch);
    }
    if (this.tick % 30 === 0) this.play.setLoop(this.windVoice, 0.1 + Math.abs(this.currentWind()) * 0.07, 0.9 + Math.abs(this.currentWind()) * 0.08);
  }

  topLine(): string {
    if (this.messageTimer > 0) return this.message;
    const w = this.currentWind();
    return `${CHALLENGES[this.hud.challenge].name}   HITS ${this.hud.hits}/${this.hud.needed}   WIND ${w >= 0 ? "+" : ""}${w.toFixed(1)} m/s`;
  }

  stealthLabel(): string {
    if (this.sprint && this.speedRatio > 0.3) return "Sprinting";
    if (this.crouch) return "Crouched";
    return this.speedRatio > 0.15 ? "Walking" : "Still";
  }
}

function cellOf(v: number): number {
  return Math.max(0, Math.min(14, Math.floor((v + 90) / 12)));
}

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new ArcheryHunting();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  let overAt = -1;
  const hud = game.hud;
  return {
    title: "Archery Hunting",
    tagline: "Hit the quota before time or arrows run out.\nCrouch to stalk; draw long for a flat shot.",
    accent: "#5f9e4f",
    controls: [
      ["Circle Pad", "Walk, turn; aim while drawn"],
      ["D-Pad / C-Stick", "Look around"],
      ["A (hold, release)", "Draw, loose an arrow"],
      ["L / R", "Crouch / Sprint"],
      ["START", "Pause"],
    ],
    readouts: [
      { label: "Hits", value: () => `${hud.hits}/${hud.needed}`, bar: () => hud.hits / hud.needed, color: "#f1d172" },
      { label: "Time", value: () => `${Math.max(0, hud.timer).toFixed(1)} s`, bar: () => hud.timer / CHALLENGES[hud.challenge].seconds, color: "#8bd3ff" },
      { label: "Score", value: () => hud.score },
      { label: "Arrows", value: () => hud.ammo, bar: () => hud.ammo / CHALLENGES[hud.challenge].ammo, color: "#c58b4f" },
      { label: "Draw", value: () => `${Math.round(hud.draw * 100)}%`, bar: () => hud.draw, color: "#ffd27a" },
      { label: "Noise", value: () => game.stealthLabel(), bar: () => hud.noise, color: "#ff8f6f" },
    ],
    play: game.play,
    status(): GameStatus {
      if (hud.mode === "title") return "title";
      if (hud.mode === "gameover") return hud.demo ? "title" : "gameover";
      return paused ? "paused" : "playing";
    },
    start(demo: boolean) {
      paused = false;
      overAt = -1;
      game.reset(demo);
    },
    pause(p: boolean) {
      paused = p;
    },
    frame(pad: Pad) {
      // the attract loop starts over two seconds after a demo run ends
      if (hud.demo && hud.mode === "gameover") {
        if (overAt < 0) overAt = game.play.tick;
        else if (game.play.tick - overAt > 120) {
          overAt = -1;
          game.reset(true);
        }
      }
      if (paused) return;
      game.frame(pad);
    },
    topLine: () => game.topLine(),
    result: () =>
      hud.cleared
        ? `All three challenges cleared · score ${hud.score}`
        : `Score ${hud.score} · ${CHALLENGES[hud.challenge].name} ${hud.hits}/${hud.needed}`,
  };
}
