// Submarine Exploration's gameplay over the playset kernels, ported from
// GameBlocks' submarine-exploration (https://gb-submarine-exploration.vercel.app/,
// MIT, xt4d/GameBlocks).
//
// What runs where:
//   native, every step — the submarine (hover kernel: thrust, yaw, rise and
//     dive, the seabed and the ceiling under the surface), every pickup and
//     artifact collection (a collector slot riding the hull, PICKUP rule),
//     the predators' bites (a HIT rule), fish (hover kernel + wander brain),
//     the schools (path kernel), every spinning part (joint drivers), the
//     collection bursts, bubbles and marine snow (emitters), the chase camera,
//     sounds where they happen and the drive's hum;
//   here, at event rate — scoring, resources, the artifacts, the station's
//     refill and upgrade, the sonar pulse and what it reveals, the messages;
//   here, on a budget — oxygen, battery, pressure and hull (a dozen floats a
//     frame), the seabed scrape and the boundary current, the predators'
//     patrol and chase (two of four per frame), the autopilot (every 4th
//     frame), the heading marker (every 6th) and the fish's recycling around
//     the player (every 30th).
//
// Deviations: coordinates are the demo's (right, up, forward) as
// (x, y - 60, -z), so the seabed sits near y = 0 and the surface at y = 72;
// the demo has no ceiling, here the hull stops 1.5 m under the surface. The
// radar became a heading marker over the hull plus the target's distance on
// the top line, and a scan brightens the pickups it reveals. Yaw steering
// keeps 35 % authority at rest (the demo's is zero). Messages show on the top
// line. The demo is silent; the port adds the sounds below.

import { ENT, EVENT, brain, createPlayset, joint, layers, motion, sfx, type Archetype, type Emitter, type Playset, type Sound } from "@pocketjs/framework/playset";
import { BTN } from "@pocketjs/framework/input";
import { mulberry, type Random } from "../kit/random.ts";
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";
import { SubAutopilot } from "./ai.ts";
import * as V from "./visuals.ts";

export const MAP_SCALE = 4;
/** the demo's up component + OFFSET = y */
export const OFFSET = 60;
export const SURFACE = 12 + OFFSET;
export const CEILING = SURFACE - 1.5;
export const WORLD_RADIUS = 155 * MAP_SCALE;
export const FLOOR_CLEARANCE = 2.2;
export const SCAN_REVEAL_DURATION = 5;
export const SCAN_REVEAL_RADIUS = 86;
const MAX_SPEED = 24;
const UPGRADED_SPEED = 30;
const STATION_REFILL_RADIUS = 12;
const STATION_DOCK_RADIUS = 16;

/** The demo's floorHeightAt(right, forward), in playset coordinates. */
export function floorAt(x: number, z: number): number {
  const r = x / MAP_SCALE;
  const f = -z / MAP_SCALE;
  const ridge = Math.sin(r * 0.045) * 4.5 + Math.cos(f * 0.038) * 3.8;
  const tr = r + 44;
  const tf = f - 30;
  const trench = -8 * Math.exp(-(tr * tr + tf * tf) / 2600);
  const mounds = Math.sin((r + f) * 0.085) * 1.6;
  return -46 + OFFSET + ridge + trench + mounds;
}

export const ARTIFACTS = [
  { name: "Obelisk Fragment", right: -58, forward: -22, height: 7 },
  { name: "Sunken Archive", right: 48, forward: -72, height: 6 },
  { name: "Pearl Engine", right: 74, forward: 52, height: 6 },
  { name: "Tide Compass", right: -94, forward: 66, height: 5 },
] as const;

/** the predators' patrol centres (right, up, forward) */
const CREATURES = [
  [-28, -22, -72],
  [84, -27, -6],
  [-98, -18, 82],
  [30, -40, 70],
] as const;

export const L = layers("player", "collector", "pickup", "artifact", "creature");

export type Status = "title" | "playing" | "gameover";

export interface Hud {
  status: Status;
  demo: boolean;
  won: boolean;
  oxygen: number;
  hull: number;
  battery: number;
  resources: number;
  score: number;
  artifactsFound: number;
  upgraded: boolean;
  depth: number;
  pressure: number;
  scanCooldown: number;
  scanReveal: number;
  /** the heading marker's target and its distance */
  target: string;
  targetDistance: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class SubmarineExploration {
  readonly play: Playset;
  readonly hud: Hud = {
    status: "title", demo: true, won: false, oxygen: 100, hull: 100, battery: 100, resources: 0, score: 0, artifactsFound: 0,
    upgraded: false, depth: 0, pressure: 0, scanCooldown: 0, scanReveal: 0, target: "", targetDistance: 0,
  };
  player = -1;
  private collector = -1;
  private marker = -1;
  private ring = -1;
  private ringAge = 0;
  private readonly random: Random;
  private readonly sceneryRandom: Random;
  private readonly ai = new SubAutopilot();
  private aiTick = 0;
  private elapsed = 0;
  private sinceStart = 0;
  private lastDamageAt = -1e9;
  private lastBoundaryAt = -1e9;
  private lastWarnAt = -1e9;
  private lastAlertAt = -1e9;
  private inStation = false;
  private prevY = 0;
  private message = "";
  private messageUntil = 0;

  // archetypes
  private readonly subArch: Archetype;
  private readonly collectorArch: Archetype;
  private readonly markerArch: Archetype;
  private readonly ringArch: Archetype;
  readonly crystalArch: Archetype;
  readonly salvageArch: Archetype;
  private readonly artifactArch: Archetype;
  private readonly creatureArch: Archetype;
  private readonly stationArch: Archetype;
  private readonly fishArch: Archetype;
  private readonly schoolArchs: Archetype[] = [];
  private readonly shaftArch: Archetype;

  // the artifacts and the station
  readonly artifactX = new Float32Array(4);
  readonly artifactY = new Float32Array(4);
  readonly artifactZ = new Float32Array(4);
  readonly artifactFound = new Uint8Array(4);
  private readonly artifactSlot = new Int16Array(4);
  readonly stationX = 0;
  readonly stationZ = -88 * MAP_SCALE;
  readonly stationY = floorAt(0, -88 * MAP_SCALE) + 8;

  // the predators: slots, patrol centres, patrol angles, alert flags, bite cooldowns
  readonly creatureSlot = new Int16Array(4);
  private readonly creatureCX = new Float32Array(4);
  private readonly creatureCY = new Float32Array(4);
  private readonly creatureCZ = new Float32Array(4);
  private readonly creatureAngle = new Float32Array(4);
  readonly creatureAlert = new Uint8Array(4);
  private readonly creatureBite = new Float32Array(4);

  // ambient fish recycled around the player
  private readonly fishSlot = new Int16Array(20);
  // pickups the last scan revealed
  private readonly pinged = new Int16Array(64);
  private pingedCount = 0;

  private readonly bubbles: Emitter;
  private readonly snow: Emitter;
  private readonly scrapePuff: Emitter;
  private readonly biteBurst: Emitter;
  private readonly ping: Sound;
  private readonly growl: Sound;
  private readonly hurt: Sound;
  private readonly crumble: Sound;
  private readonly whoosh: Sound;
  private readonly alarm: Sound;
  private readonly heal: Sound;
  private readonly powerup: Sound;
  private readonly winSound: Sound;
  private readonly loseSound: Sound;
  private readonly artifactSound: Sound;

  constructor() {
    const play = createPlayset({ capacity: 256, particles: 600, seed: 20261029 });
    this.play = play;
    this.random = mulberry(20261029);
    this.sceneryRandom = mulberry(7341);
    // the demo's daylight blue above; below the horizon the sky is the fog
    // colour, so the seabed past the far plane (215 m) reads as fog. FogExp2
    // 0.0075 (0.53 at 115 m, 0.76 at 160 m, 0.9 at 200 m) as a linear fog
    // that is complete well inside the far plane.
    play.sky(V.PALETTE.sky, V.PALETTE.fog, V.PALETTE.fog);
    play.fog(V.PALETTE.fog, 20, 180, 1);
    play.light({ sun: [-140, 70, 40], sunColor: 0xfff4d5, sunIntensity: 1.0, sky: 0xe6fbff, ground: 0x6ca6b8, ambient: 0.6 });
    play.gravity(24);
    play.terrain({
      size: 1600,
      resolution: 64,
      height: floorAt,
      // the dark teal seabed of the demo's texture, lighter on the ridges
      bands: [
        [-10, 0x0f2527],
        [8, 0x173230],
        [17, 0x21413b],
        [24, 0x2d5047],
      ],
    });

    // sounds: rendered once, played natively where they happen
    this.ping = play.sound(sfx.sonar());
    this.growl = play.sound({ wave: "saw", freq: 95, to: 55, sustain: 0.22, decay: 0.45, vibrato: 70, vibratoRate: 9, lowpass: 0.55, noise: 0.15, volume: 0.42 });
    this.hurt = play.sound(sfx.hurt());
    this.crumble = play.sound({ ...sfx.crumble(), volume: 0.4 });
    this.whoosh = play.sound(sfx.whoosh());
    this.alarm = play.sound({ ...sfx.alarm(), volume: 0.2 });
    this.heal = play.sound(sfx.heal());
    this.powerup = play.sound(sfx.powerup());
    this.winSound = play.sound(sfx.win());
    this.loseSound = play.sound(sfx.lose());
    this.artifactSound = play.sound({ ...sfx.wave(), volume: 0.5 });
    const motor = play.sound({ ...sfx.motor(), volume: 0.22 });
    // the deep-water rumble under everything
    play.loop(play.sound({ ...sfx.hull(), volume: 0.28 }), 0.8);

    // particles
    const burst = (color: number, count: number, speed: number, blend: "add" | "alpha" = "add") =>
      play.emitter({ count, life: 0.8, speed, spread: Math.PI, size: [0.34, 0.06], color: [color, color], alpha: [1, 0], blend, drag: 1.6 });
    const crystalBurst = burst(V.pickupColor("crystal"), 18, 4.5);
    const salvageBurst = burst(V.pickupColor("salvage"), 16, 4);
    const artifactBurst = play.emitter({ count: 46, life: 1.2, speed: 7, spread: Math.PI, size: [0.5, 0.08], color: [0xbaffff, 0x68ddff], alpha: [1, 0], blend: "add", drag: 1.2 });
    this.biteBurst = burst(0xff405f, 14, 5);
    this.scrapePuff = play.emitter({ count: 12, life: 1.4, speed: 2.2, spread: 1.2, dir: [0, 1, 0], size: [0.5, 1.1], color: [0x7f9483, 0x5c7870], alpha: [0.55, 0], blend: "alpha", drag: 1.4 });
    this.bubbles = play.emitter({ count: 4, life: 6, speed: 1.4, spread: 0.35, dir: [0, 1, 0], gravity: -0.05, drag: 0.25, size: [0.1, 0.15], color: [0xc6fbff, 0xe6ffff], alpha: [0.5, 0], blend: "alpha", radius: 1.2 });
    this.snow = play.emitter({ count: 2, life: 4.5, speed: 0.25, spread: Math.PI, gravity: 0, drag: 0.2, size: [0.09, 0.06], color: [0x9df4ff, 0x5df0bc], alpha: [0.35, 0], blend: "alpha", radius: 16 });

    // the submarine, its collector, its heading marker, the scan ring
    this.subArch = play.archetype({
      model: play.model(V.submarine()),
      motion: this.subMotion(MAX_SPEED),
      layer: L.player, radius: 1.5,
      joints: [joint.spin("rotor", "z", 22)],
      hum: { sound: motor, speed: MAX_SPEED, pitch: 1.6 },
    });
    this.collectorArch = play.archetype({ motion: motion.attached(), layer: L.collector, hits: L.pickup | L.artifact, radius: 10, hidden: true });
    this.markerArch = play.archetype({ model: play.model(V.headingMarker()), motion: motion.attached() });
    this.ringArch = play.archetype({ model: play.model(V.pulseRing()), motion: motion.attached() });

    // pickups and artifacts: still, spinning; the collector's rule takes them
    const pickupSpec = (type: V.PickupType, death: Emitter, sound: Sound) => ({
      model: play.model(V.pickup(type)),
      layer: L.pickup, radius: type === "crystal" ? 2.2 * 0.9 : 2.2,
      death, sounds: { death: sound },
      joints: [joint.spin("spin", "y", 1.8)],
    });
    this.crystalArch = play.archetype(pickupSpec("crystal", crystalBurst, play.sound(sfx.pickup())));
    this.salvageArch = play.archetype(pickupSpec("salvage", salvageBurst, play.sound(sfx.coin())));
    this.artifactArch = play.archetype({
      model: play.model(V.artifact()), layer: L.artifact, radius: 0.01, death: artifactBurst,
      joints: [joint.spin("spin", "y", 0.8)],
    });
    this.creatureArch = play.archetype({ model: play.model(V.creature()), layer: L.creature, hits: L.player, radius: 2.9 });
    this.stationArch = play.archetype({ model: play.model(V.station()), joints: [joint.spin("spin", "y", 0.6)] });

    // ambient life
    this.fishArch = play.archetype({
      model: play.model(V.fish(0xffffff)),
      motion: motion.hover({ accel: 5, maxSpeed: 4, damping: 1.2, vertical: 2, maxVertical: 1, turnRate: 1.4, tilt: 0, minY: 4, maxY: CEILING - 4 }),
      brain: brain.wander({ every: 2.6, turn: 1.1 }),
    });
    const schoolModel = play.model(V.school(this.sceneryRandom, 12));
    const schools: readonly (readonly [number, number, number])[] = [
      [-38, -16, 22],
      [72, -24, -36],
      [24, -8, 78],
    ];
    for (const [r, u, f] of schools) {
      const cx = r * MAP_SCALE, cy = u + OFFSET, cz = -f * MAP_SCALE;
      const points: [number, number, number][] = [];
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        points.push([cx + Math.cos(a) * 18, cy + Math.sin(a * 1.3) * 2.5, cz - Math.sin(a) * 14]);
      }
      this.schoolArchs.push(play.archetype({ model: schoolModel, motion: motion.path({ path: play.path(points), speed: 5.5, loop: true, turnRate: 3 }) }));
    }
    this.shaftArch = play.archetype({ model: play.model(V.lightShaft(22, 0.06)), joints: [joint.spin("spin", "y", 0.3)] });

    // what contacts do
    play.rule(L.collector, L.pickup | L.artifact, { pickup: true });
    play.rule(L.creature, L.player, { event: true });
    play.on(EVENT.PICKUP, (_a, b, arch, x, y, z) => this.onPickup(b, arch, x, y, z));
    play.on(EVENT.HIT, (a, _b, _rule, x, y, z) => this.onBite(a, x, y, z));

    this.placeScenery();
    this.reset(true);
  }

  private subMotion(maxSpeed: number) {
    // GameBlocks' GeneralVehicleMotionController tuning: acceleration 26,
    // max speed 24 (30 upgraded), damping 0.45, yaw rate 2.1
    return motion.hover({ accel: 26, maxSpeed, damping: 0.45, vertical: 14, maxVertical: 9, turnRate: 2.1, tilt: 0.12, gravity: 0, minY: FLOOR_CLEARANCE, maxY: CEILING });
  }

  /** The reef: seeded variants of the demo's scenery as static batches. */
  private placeScenery(): void {
    const play = this.play;
    const r = this.sceneryRandom;
    const on = (model: { id: number; joints: readonly string[] }, x: number, z: number, scale = 1, sink = 0.15) =>
      play.place(model, [x, floorAt(x, z) - sink, z], { yaw: r.uniform(0, Math.PI * 2), scale });
    const corals = [0, 1, 2, 3, 4].map((v) => play.model(V.coral(r, v)));
    const rocks = [0, 1, 2, 3].map(() => play.model(V.rockOutcrop(r)));
    const anemones = [0, 1, 2].map(() => play.model(V.anemone(r)));
    const spacing = 34;
    const meadows = [0, 1, 2, 3].map(() => play.model(V.seaGrassMeadow(r, spacing)));
    const lim = 145 * MAP_SCALE;
    for (let i = 0; i < 150; i++) on(corals[i % corals.length], r.uniform(-lim, lim), r.uniform(-lim, lim), r.uniform(0.85, 1.25));
    for (let i = 0; i < 90; i++) on(rocks[i % rocks.length], r.uniform(-lim, lim), r.uniform(-lim, lim), r.uniform(0.6, 1.5), 0.3);
    for (let i = 0; i < 64; i++) on(anemones[i % anemones.length], r.uniform(-136 * MAP_SCALE, 136 * MAP_SCALE), r.uniform(-136 * MAP_SCALE, 136 * MAP_SCALE), r.uniform(0.7, 1.4));
    // addSeaGrassField: the demo's jittered grid of clumps, four to a node;
    // a meadow sits on the lowest floor under its corners
    const step = spacing * 2;
    const extent = WORLD_RADIUS + 110;
    const half = spacing * 0.5;
    for (let z = -extent; z <= extent; z += step) {
      for (let x = -extent; x <= extent; x += step) {
        if (x * x + z * z > extent * extent) continue;
        let y = floorAt(x, z);
        for (let k = 0; k < 4; k++) y = Math.min(y, floorAt(x + (k & 1 ? half : -half), z + (k & 2 ? half : -half)));
        play.place(meadows[Math.floor(r() * meadows.length)], [x, y - 0.35, z], { yaw: Math.floor(r() * 4) * (Math.PI / 2) });
      }
    }
    const pedestal = play.model(V.pedestal());
    for (let i = 0; i < 4; i++) {
      const a = ARTIFACTS[i];
      const x = a.right * MAP_SCALE;
      const z = -a.forward * MAP_SCALE;
      const y = floorAt(x, z);
      this.artifactX[i] = x;
      this.artifactY[i] = y + a.height;
      this.artifactZ[i] = z;
      play.place(pedestal, [x, y + 0.5, z]);
    }
  }

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    const hud = this.hud;
    hud.status = demo ? "title" : "playing";
    hud.demo = demo;
    hud.won = false;
    hud.oxygen = 100;
    hud.hull = 100;
    hud.battery = 100;
    hud.resources = 0;
    hud.score = 0;
    hud.artifactsFound = 0;
    hud.upgraded = false;
    hud.scanCooldown = 0;
    hud.scanReveal = 0;
    this.elapsed = 0;
    this.sinceStart = 0;
    this.lastDamageAt = -1e9;
    this.lastBoundaryAt = -1e9;
    this.lastWarnAt = -1e9;
    this.inStation = false;
    this.ring = -1;
    this.pingedCount = 0;
    this.message = "";
    this.ai.reset();
    play.retune(this.subArch, { motion: this.subMotion(MAX_SPEED) });

    const startZ = -42 * MAP_SCALE;
    this.player = play.spawn(this.subArch, 0, -18 + OFFSET, startZ, Math.PI);
    this.prevY = -18 + OFFSET;
    this.collector = play.spawn(this.collectorArch, 0, -18 + OFFSET, startZ);
    play.attach(this.collector, this.player, [0, 0, 0]);
    this.marker = play.spawn(this.markerArch, 0, -18 + OFFSET + 4, startZ);
    play.attach(this.marker, this.player, [0, 3.7, -0.6], 0, false);
    play.followCamera(this.player, { offset: [0, 5.4, 15], lookAhead: 10, lookUp: 1.2, heading: true, fov: 64, near: 0.5, far: 215, smooth: 7.5, smoothLook: 12 });

    // createPickups: a third salvage, the rest energy crystals
    const r = this.random;
    const lim = 130 * MAP_SCALE;
    for (let i = 0; i < 28 * MAP_SCALE; i++) {
      const salvage = i % 3 === 0;
      const x = r.uniform(-lim, lim);
      const z = r.uniform(-lim, lim);
      play.spawn(salvage ? this.salvageArch : this.crystalArch, x, floorAt(x, z) + 2.5, z, r.uniform(0, Math.PI * 2));
    }
    for (let i = 0; i < 4; i++) {
      this.artifactFound[i] = 0;
      this.artifactSlot[i] = play.spawn(this.artifactArch, this.artifactX[i], this.artifactY[i], this.artifactZ[i]);
    }
    play.spawn(this.stationArch, this.stationX, this.stationY, this.stationZ);
    for (let i = 0; i < 4; i++) {
      const c = CREATURES[i];
      const x = c[0] * MAP_SCALE, y = c[1] + OFFSET, z = -c[2] * MAP_SCALE;
      this.creatureCX[i] = x;
      this.creatureCY[i] = y;
      this.creatureCZ[i] = z;
      this.creatureAngle[i] = r.uniform(0, Math.PI * 2);
      this.creatureAlert[i] = 0;
      this.creatureBite[i] = 0;
      this.creatureSlot[i] = play.spawn(this.creatureArch, x, y, z);
    }
    const schoolTint = [0xb8f6ff, 0x9ff4c8, 0xffd08a];
    for (let i = 0; i < this.schoolArchs.length; i++) {
      const s = play.spawn(this.schoolArchs[i], 0, 0, 0);
      this.tint(s, schoolTint[i]);
    }
    const shafts = [
      [-92, -42, 20],
      [62, -70, 26],
      [18, 52, 22],
      [-118, 92, 18],
    ];
    for (const [sr, sf, radius] of shafts) {
      const s = play.spawn(this.shaftArch, sr * MAP_SCALE, SURFACE, -sf * MAP_SCALE, r.uniform(0, Math.PI * 2));
      if (s >= 0) play.look[s * 4] = radius / 22;
    }
    const fishColors = [0x78d8ff, 0x9df4ff, 0x7ff0c8, 0xffcf8a];
    for (let i = 0; i < this.fishSlot.length; i++) {
      const a = r.uniform(0, Math.PI * 2);
      const d = r.uniform(25, 140);
      const x = Math.cos(a) * d;
      const z = startZ + Math.sin(a) * d;
      const s = play.spawn(this.fishArch, x, Math.min(CEILING - 6, floorAt(x, z) + r.uniform(5, 34)), z, r.uniform(0, Math.PI * 2));
      this.fishSlot[i] = s;
      this.tint(s, fishColors[i % fishColors.length]);
    }
    this.updateMarker();
  }

  private tint(slot: number, hex: number): void {
    if (slot < 0) return;
    const look = this.play.look;
    look[slot * 4 + 1] = ((hex >> 16) & 255) / 255;
    look[slot * 4 + 2] = ((hex >> 8) & 255) / 255;
    look[slot * 4 + 3] = (hex & 255) / 255;
  }

  private say(text: string, seconds = 2.6): void {
    this.message = text;
    this.messageUntil = this.elapsed + seconds;
  }

  // --- events ---------------------------------------------------------------

  private onPickup(item: number, arch: number, x: number, y: number, z: number): void {
    const hud = this.hud;
    if (arch === this.crystalArch.id) {
      hud.battery = Math.min(100, hud.battery + 18);
      hud.resources += 1;
      hud.score += 90;
      this.say("Energy crystal collected");
    } else if (arch === this.salvageArch.id) {
      hud.resources += 2;
      hud.score += 130;
      this.say("Salvage recovered");
    } else if (arch === this.artifactArch.id) {
      for (let i = 0; i < 4; i++) {
        if (this.artifactSlot[i] !== item || this.artifactFound[i]) continue;
        this.artifactFound[i] = 1;
        hud.artifactsFound += 1;
        hud.score += 400;
        this.play.play(this.artifactSound, 1, 1, [x, y, z]);
        this.say(`Artifact collected: ${ARTIFACTS[i].name}`, 3.6);
        this.updateMarker();
      }
    }
  }

  private onBite(slot: number, x: number, y: number, z: number): void {
    const cs = this.creatureSlot;
    for (let i = 0; i < 4; i++) {
      if (cs[i] !== slot || this.creatureBite[i] > 0) continue;
      this.creatureBite[i] = 1.15;
      this.hud.hull = Math.max(0, this.hud.hull - 13);
      this.play.play(this.hurt, 1, 1, [x, y, z]);
      this.play.burst(this.biteBurst, x, y, z);
      this.play.shake(0.6);
      this.say("Hull impact from hostile creature", 1.8);
    }
  }

  private scan(): void {
    const hud = this.hud;
    if (hud.scanCooldown > 0 || hud.battery < 4 || hud.status === "gameover") return;
    const play = this.play;
    hud.scanCooldown = 3.2;
    hud.scanReveal = SCAN_REVEAL_DURATION;
    hud.battery = Math.max(0, hud.battery - 4);
    const p = this.player * 16;
    const ent = play.ent;
    // pickups inside the pulse glow until the reveal ends
    this.unping();
    const n = play.near(L.pickup, ent[p], ent[p + 2], SCAN_REVEAL_RADIUS);
    const list = play.list;
    const look = play.look;
    for (let i = 0; i < n && this.pingedCount < this.pinged.length; i++) {
      const s = list[i];
      this.pinged[this.pingedCount++] = s;
      look[s * 4 + 1] = 2.1;
      look[s * 4 + 2] = 2.1;
      look[s * 4 + 3] = 2.1;
    }
    play.playAt(this.ping, this.player);
    if (this.ring >= 0) play.kill(this.ring);
    this.ring = play.spawn(this.ringArch, ent[p], ent[p + 1], ent[p + 2]);
    if (this.ring >= 0) play.attach(this.ring, this.player, [0, 0, 0], 0, false);
    this.ringAge = 0;
    this.say("Scan pulse sent", 1.2);
  }

  private unping(): void {
    const play = this.play;
    const look = play.look;
    const ent = play.ent;
    const c = this.crystalArch.id + 1;
    const sv = this.salvageArch.id + 1;
    for (let i = 0; i < this.pingedCount; i++) {
      const s = this.pinged[i];
      const a = ent[s * 16 + ENT.ARCH];
      if (a !== c && a !== sv) continue;
      look[s * 4 + 1] = 1;
      look[s * 4 + 2] = 1;
      look[s * 4 + 3] = 1;
    }
    this.pingedCount = 0;
  }

  // --- the frame -------------------------------------------------------------

  frame(pad: Pad): void {
    const play = this.play;
    const hud = this.hud;
    const dt = 1 / 60;
    const live = hud.status === "playing" || (hud.status === "title" && hud.demo);
    const ent = play.ent;
    const p = this.player * 16;
    let fwd = 0;
    let side = 0;
    let rise = 0;
    let turn = 0;
    let brake = false;
    if (live) {
      this.elapsed += dt;
      this.sinceStart += dt;
      if (hud.demo) {
        if (this.aiTick++ % 4 === 0) this.ai.decide(this);
        fwd = this.ai.fwd;
        side = this.ai.side;
        rise = this.ai.rise;
        turn = this.ai.turn;
        brake = this.ai.brake;
        if (this.ai.scan) this.scan();
      } else {
        const bs = hud.battery <= 0 ? 0.28 : 1;
        fwd = (pad.y >= 0 ? pad.y : pad.y * 0.7) * bs;
        turn = pad.x * bs;
        rise = ((pad.held & BTN.RTRIGGER ? 1 : 0) - (pad.held & BTN.LTRIGGER ? 1 : 0) + pad.ry) * bs;
        brake = (pad.held & BTN.CROSS) !== 0;
        if (pad.pressed & BTN.CIRCLE && this.sinceStart > 0.25) this.scan();
      }
      // the demo's steering scales with speed; a little authority stays at rest
      const vx = ent[p + 3], vz = ent[p + 5];
      const authority = Math.max(0.35, Math.min(1, Math.sqrt(vx * vx + vz * vz) / (hud.upgraded ? UPGRADED_SPEED : MAX_SPEED)));
      play.steer(this.player, side, fwd, turn * authority, rise > 1 ? 1 : rise < -1 ? -1 : rise);
      if ((this.aiTick & 1) === 0) {
        this.creatures(0, 2 * dt);
        this.creatures(1, 2 * dt);
      } else {
        this.creatures(2, 2 * dt);
        this.creatures(3, 2 * dt);
      }
    } else {
      play.steer(this.player, 0, 0, 0, 0);
    }
    if (!hud.demo) this.aiTick++;
    play.frame(dt);
    if (live) this.systems(dt, brake);
    this.effects(dt);
  }

  /** The predators: patrol a circle round their centre, chase inside 48 m
   *  (76 m just after a scan), bite at 4.4 m through the HIT rule. */
  private creatures(i: number, dt: number): void {
    const ent = this.play.ent;
    const s = this.creatureSlot[i];
    if (s < 0) return;
    const o = s * 16;
    const p = this.player * 16;
    const cx = ent[o], cy = ent[o + 1], cz = ent[o + 2];
    const tx = ent[p] - cx, ty = ent[p + 1] - cy, tz = ent[p + 2] - cz;
    const distance = Math.sqrt(tx * tx + ty * ty + tz * tz);
    const alert = distance < 48 || (distance < 76 && this.hud.scanCooldown > 2.2);
    if (alert && !this.creatureAlert[i] && this.elapsed - this.lastAlertAt > 2.5) {
      this.lastAlertAt = this.elapsed;
      this.play.playAt(this.growl, s);
    }
    this.creatureAlert[i] = alert ? 1 : 0;
    let dx: number, dy: number, dz: number, speed: number;
    if (alert) {
      dx = tx;
      dy = ty;
      dz = tz;
      speed = 16;
    } else {
      const a = (this.creatureAngle[i] += dt * 0.45);
      dx = this.creatureCX[i] + Math.cos(a) * 24 - cx;
      dy = this.creatureCY[i] + Math.sin(this.elapsed * 0.5 + a) * 4 - cy;
      dz = this.creatureCZ[i] - Math.sin(a) * 24 - cz;
      speed = 7;
    }
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const k = 1 - Math.exp(-dt * 1.8);
    const k2 = (speed / dl) * k;
    const vx = ent[o + 3] * (1 - k) + dx * k2;
    const vy = ent[o + 4] * (1 - k) + dy * k2;
    const vz = ent[o + 5] * (1 - k) + dz * k2;
    ent[o + 3] = vx;
    ent[o + 4] = vy;
    ent[o + 5] = vz;
    const floor = floorAt(cx, cz) + 4;
    if (cy < floor) ent[o + 1] = floor;
    else if (cy > 2 + OFFSET) ent[o + 1] = 2 + OFFSET;
    const vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (vl > 0.03) {
      ent[o + ENT.YAW] = Math.atan2(-vx, -vz);
      ent[o + ENT.PITCH] = Math.asin(clamp(vy / vl, -0.85, 0.85));
    }
    if (this.creatureBite[i] > 0) this.creatureBite[i] -= dt;
  }

  /** Oxygen, battery, pressure, the hull, the seabed, the boundary, the station. */
  private systems(dt: number, brake: boolean): void {
    const play = this.play;
    const hud = this.hud;
    const ent = play.ent;
    const p = this.player * 16;
    let vx = ent[p + 3], vy = ent[p + 4], vz = ent[p + 5];
    const x = ent[p], y = ent[p + 1], z = ent[p + 2];
    if (brake) {
      // brakeDamping 4.8 instead of damping 0.45
      const k = Math.exp(-4.35 * dt);
      vx *= k;
      vy *= k;
      vz *= k;
      ent[p + 3] = vx;
      ent[p + 4] = vy;
      ent[p + 5] = vz;
    }
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (hud.scanCooldown > 0) hud.scanCooldown = Math.max(0, hud.scanCooldown - dt);
    if (hud.scanReveal > 0) {
      hud.scanReveal -= dt;
      if (hud.scanReveal <= 0) {
        hud.scanReveal = 0;
        this.unping();
      }
    }
    const depth = Math.max(0, SURFACE - y);
    const pressure = clamp((depth - (hud.upgraded ? 58 : 44)) / 32, 0, 1);
    hud.depth = depth;
    hud.pressure = pressure;
    hud.oxygen = Math.max(0, hud.oxygen - dt * (0.42 + pressure * 0.4));
    hud.battery = Math.max(0, hud.battery - dt * (0.18 + speed * 0.025));
    if (pressure > 0) hud.hull = Math.max(0, hud.hull - pressure * dt * 6);
    // the hover kernel lifted the hull off the seabed: a scrape
    if (y - (this.prevY + vy * dt) > 0.02 && y < floorAt(x, z) + FLOOR_CLEARANCE + 0.6) {
      ent[p + 3] = vx * 0.45;
      ent[p + 4] = vy * 0.45;
      ent[p + 5] = vz * 0.45;
      if (this.elapsed - this.lastDamageAt > 1.6 && speed > 5) {
        hud.hull = Math.max(0, hud.hull - speed * 0.18);
        this.lastDamageAt = this.elapsed;
        play.playAt(this.crumble, this.player);
        play.burst(this.scrapePuff, x, y - 1.6, z);
        this.say("Seafloor scrape detected", 1.3);
      }
    }
    this.prevY = ent[p + 1];
    // the boundary current
    const planar = Math.sqrt(x * x + z * z);
    if (planar > WORLD_RADIUS) {
      const k = WORLD_RADIUS / planar;
      ent[p] = x * k;
      ent[p + 2] = z * k;
      ent[p + 3] *= 0.55;
      ent[p + 4] *= 0.55;
      ent[p + 5] *= 0.55;
      if (this.elapsed - this.lastBoundaryAt > 1.1) {
        this.lastBoundaryAt = this.elapsed;
        play.playAt(this.whoosh, this.player, 0.6);
        this.say("Boundary current pushing submarine back", 1.1);
      }
    }
    if (hud.oxygen <= 0) hud.hull = Math.max(0, hud.hull - dt * 10);
    // the upgrade station
    const sx = this.stationX - x, sy = this.stationY - y, sz = this.stationZ - z;
    const station = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (station < STATION_REFILL_RADIUS) {
      if (!this.inStation) play.playAt(this.heal, this.player, 0.8);
      this.inStation = true;
      hud.oxygen = Math.min(100, hud.oxygen + 18 * dt);
      hud.hull = Math.min(100, hud.hull + 14 * dt);
      hud.battery = Math.min(100, hud.battery + 22 * dt);
      if (hud.resources >= 8 && !hud.upgraded) {
        hud.resources -= 8;
        hud.upgraded = true;
        hud.score += 550;
        play.retune(this.subArch, { motion: this.subMotion(UPGRADED_SPEED) });
        play.playAt(this.powerup, this.player);
        this.say("Upgrade installed: reinforced drive and pressure seals", 3.8);
        this.updateMarker();
      }
    } else this.inStation = false;
    hud.score += dt * (0.8 + speed * 0.08);
    if ((hud.oxygen < 20 || hud.hull < 25) && this.elapsed - this.lastWarnAt > 2.5) {
      this.lastWarnAt = this.elapsed;
      play.play(this.alarm, 0.7);
    }
    if (hud.upgraded && hud.artifactsFound === 4 && station < STATION_DOCK_RADIUS) this.end(true);
    else if (hud.hull <= 0) this.end(false);
  }

  private end(success: boolean): void {
    const hud = this.hud;
    hud.status = "gameover";
    hud.won = success;
    this.play.steer(this.player, 0, 0, 0, 0);
    this.play.play(success ? this.winSound : this.loseSound, 0.9);
    if (!success) this.play.shake(0.8);
  }

  /** The scan ring, the heading marker, the fish, bubbles and marine snow. */
  private effects(dt: number): void {
    const play = this.play;
    const tick = play.tick;
    if (this.ring >= 0) {
      this.ringAge += dt;
      const t = this.ringAge / 1.8;
      const look = play.look;
      const o = this.ring * 4;
      if (t >= 1) {
        play.kill(this.ring);
        this.ring = -1;
      } else {
        look[o] = 1 + SCAN_REVEAL_RADIUS * t;
        const fade = 0.5 * (1 - t);
        look[o + 1] = fade;
        look[o + 2] = fade;
        look[o + 3] = fade;
      }
    }
    if (tick % 6 === 0) this.updateMarker();
    if (tick % 30 === 15) this.recycleFish();
    const cam = play.cameraView;
    const r = this.random;
    if (tick % 4 === 0) {
      // marine snow drifting in front of the lens
      play.burst(this.snow, cam[0] + cam[3] * 16 + r.uniform(-8, 8), cam[1] + cam[4] * 16 + r.uniform(-5, 5), cam[2] + cam[5] * 16 + r.uniform(-8, 8));
    }
    if (tick % 20 === 0) {
      const ent = play.ent;
      const p = this.player * 16;
      const bx = ent[p] + r.uniform(-34, 34);
      const bz = ent[p + 2] + r.uniform(-34, 34);
      play.burst(this.bubbles, bx, floorAt(bx, bz) + 1, bz);
    }
  }

  /** Point the marker at the nearest artifact still on the seabed, or at the
   *  station once they are all aboard (the demo's radar crosses). */
  private updateMarker(): void {
    const play = this.play;
    const ent = play.ent;
    if (this.player < 0) return;
    const p = this.player * 16;
    const px = ent[p], py = ent[p + 1], pz = ent[p + 2];
    let best = -1;
    let bestD = 1e12;
    for (let i = 0; i < 4; i++) {
      if (this.artifactFound[i]) continue;
      const dx = this.artifactX[i] - px, dy = this.artifactY[i] - py, dz = this.artifactZ[i] - pz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    let tx: number, tz: number;
    if (best >= 0) {
      tx = this.artifactX[best];
      tz = this.artifactZ[best];
      this.hud.target = ARTIFACTS[best].name;
      this.hud.targetDistance = Math.sqrt(bestD);
    } else {
      tx = this.stationX;
      tz = this.stationZ;
      const dy = this.stationY - py;
      this.hud.target = "Upgrade Station";
      this.hud.targetDistance = Math.sqrt((tx - px) * (tx - px) + dy * dy + (tz - pz) * (tz - pz));
    }
    if (this.marker >= 0) ent[this.marker * 16 + ENT.YAW] = Math.atan2(-(tx - px), -(tz - pz));
  }

  /** Fish that fell far behind swim in again ahead, inside the fog. */
  private recycleFish(): void {
    const play = this.play;
    const ent = play.ent;
    const p = this.player * 16;
    const px = ent[p], pz = ent[p + 2];
    const yaw = ent[p + ENT.YAW];
    const r = this.random;
    for (let i = 0; i < this.fishSlot.length; i++) {
      const o = this.fishSlot[i] * 16;
      const dx = ent[o] - px, dz = ent[o + 2] - pz;
      if (dx * dx + dz * dz < 165 * 165) continue;
      const a = yaw + r.uniform(-1.2, 1.2);
      const d = r.uniform(110, 150);
      const x = px - Math.sin(a) * d;
      const z = pz - Math.cos(a) * d;
      ent[o] = x;
      ent[o + 1] = Math.min(CEILING - 6, floorAt(x, z) + r.uniform(5, 34));
      ent[o + 2] = z;
    }
  }

  /** the top line: a message while it lasts, else score and the next target */
  topLine(): string {
    const hud = this.hud;
    if (this.message && this.elapsed < this.messageUntil) return this.message.toUpperCase();
    return `SCORE ${Math.round(hud.score)}    ${hud.target.toUpperCase()} ${Math.round(hud.targetDistance)} M`;
  }
}

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new SubmarineExploration();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  let overAt = -1;
  const hud = game.hud;
  const pct = (v: number) => `${Math.round(v)}%`;
  return {
    title: "Submarine Exploration",
    tagline: "Recover four lost artifacts and gather salvage.\nReturn to the station before the hull gives out.",
    accent: "#1f9fb0",
    controls: [
      ["Circle Pad / D-Pad", "Thrust and turn"],
      ["R / L", "Rise / dive"],
      ["A", "Scan pulse"],
      ["B", "Brake"],
      ["START", "Pause"],
    ],
    readouts: [
      { label: "O2", value: () => pct(hud.oxygen), bar: () => hud.oxygen / 100, color: "#5fd4ff" },
      { label: "Hull", value: () => pct(hud.hull), bar: () => hud.hull / 100, color: "#ff7a8a" },
      { label: "Battery", value: () => pct(hud.battery), bar: () => hud.battery / 100, color: "#8bff7a" },
      { label: "Depth · pressure", value: () => `${Math.round(hud.depth)} m · ${pct(hud.pressure * 100)}`, bar: () => hud.pressure, color: "#ffb15e" },
      { label: "Artifacts · cargo", value: () => (hud.upgraded ? `${hud.artifactsFound}/4 · upgraded` : `${hud.artifactsFound}/4 · ${hud.resources}/8`) },
      {
        label: "Scan",
        value: () => (hud.scanReveal > 0 ? `reveal ${hud.scanReveal.toFixed(1)} s` : hud.scanCooldown > 0 ? `${hud.scanCooldown.toFixed(1)} s` : "ready"),
        bar: () => 1 - hud.scanCooldown / 3.2,
        color: "#baffff",
      },
    ],
    play: game.play,
    status(): GameStatus {
      if (hud.status === "title") return "title";
      if (hud.status === "gameover") return hud.demo ? "title" : "gameover";
      return paused ? "paused" : "playing";
    },
    start(demo: boolean) {
      paused = false;
      overAt = -1;
      game.reset(demo);
      if (!demo) hud.status = "playing";
    },
    pause(p: boolean) {
      paused = p;
    },
    frame(pad: Pad) {
      // the attract loop restarts itself two seconds after a demo dive ends
      if (hud.demo && hud.status === "gameover") {
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
      hud.won
        ? `Mission complete · score ${Math.round(hud.score)}`
        : `Hull lost · score ${Math.round(hud.score)} · artifacts ${hud.artifactsFound}/4`,
  };
}
