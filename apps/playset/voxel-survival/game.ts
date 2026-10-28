// Voxel Survival's gameplay over the playset voxel module, ported from
// GameBlocks' voxel-survival demo (https://gb-voxel-survival.vercel.app/,
// MIT, xt4d/GameBlocks).
//
// What runs where:
//   native, every step — the block world (modules/voxel.rs): chunk meshes
//     with culled faces and baked corner occlusion, rebuilt for the chunks
//     an edit touches; the player's collision with the blocks (a body, moved
//     axis by axis like the demo's movePlayer); the first-person camera;
//   here, once at load — the terrain heights, trees and goal crystals
//     (the demo's generator), handed to the module in three calls;
//   here, every frame — the demo's movement (velocity blend, jump, gravity
//     written into the slot; the `none` kernel integrates it), look, the
//     crosshair, footsteps and landings;
//   here, at event rate — mining and placing (a native raycast and a set),
//     the inventory, the ten goal crystals, the timer, day and night;
//   here, every third frame — the autopilot (ai.ts).
//
// Coordinates: the demo's right/up/forward basis maps to x, y and -z, so its
// yaw and pitch carry over unchanged; its block (x, y, z) is world block
// (x, y, -z - 1).
//
// Deviations: the world is a fixed 176 x 32 x 160 box around the demo's
// sites instead of chunks generated around the player (its edge is walled);
// the view reaches 40 m under fog (the demo: fog from 38 m to 155 m); the
// block border lines are not drawn; held stick input keeps its magnitude
// instead of being normalised; on the console the sprint starts after a
// moment of full forward tilt.

import { BTN } from "@pocketjs/framework/input";
import { ENT, STATE, createPlayset, motion, sfx, type Archetype, type Playset, type Sound } from "@pocketjs/framework/playset";
import { VoxelWorld } from "@pocketjs/framework/playset/voxel";
import { mulberry } from "../kit/random.ts";
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";
import { AI_MODE, EYE, VoxelAi, type VoxelAiHost } from "./ai.ts";
import * as V from "./visuals.ts";

const B = V.BLOCK;
export const CRYSTAL_GOAL = 10;
export const TIME_LIMIT = 180;
const PLACEABLE = [B.dirt, B.stone, B.wood, B.crystal] as const;
const RADIUS = 0.34;
const HEIGHT = 1.78;
const REACH = 6;
const DT = 1 / 60;
const BLEND = 1 - Math.exp(-DT * 13);

/** The box: world blocks x -82..93, y 0..31, z -88..71 (the demo's z 87..-72). */
const ORIGIN = [-82, 0, -88] as const;
const SIZE = [176, 32, 160] as const;

/** The demo's goal sites in its own (x, z): seven on the surface, three in trees. */
const SITES: readonly (readonly [kind: "surface" | "tree", x: number, z: number])[] = [
  ["surface", 2, 12],
  ["surface", 31, -29],
  ["surface", 54, 18],
  ["surface", 29, 47],
  ["surface", -26, 43],
  ["surface", -43, 2],
  ["surface", -20, -32],
  ["tree", 13, -17],
  ["tree", 46, -7],
  ["tree", 0, 47],
];

/** The demo's terrain, in its own (x, z). */
export function terrainHeight(x: number, z: number): number {
  const rolling = Math.sin(x * 0.16) * 1.9 + Math.cos(z * 0.13) * 1.6;
  const ridges = Math.sin((x + z) * 0.055) * 2.5;
  return Math.floor(7 + rolling + ridges);
}

function chanceNoise(x: number, z: number, salt: number): number {
  const value = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453;
  return value - Math.floor(value);
}

export type Status = "title" | "playing" | "gameover";

export class VoxelSurvival implements VoxelAiHost {
  readonly play: Playset;
  readonly voxel: VoxelWorld;
  status: Status = "title";
  demo = true;
  player = -1;
  px = 0;
  py = 0;
  pz = 0;
  yaw = 0;
  pitch = 0;
  grounded = false;
  /** 0 running, 1 every crystal, 2 out of time */
  outcome = 0;
  readonly inventory = new Int32Array(8);
  selected = 0;
  elapsed = 0;
  dayTime = 0.24;
  message = "Collect 10 crystals within 3 minutes";
  messageTimer = 2.2;
  readonly sites = new Int32Array(SITES.length * 3);
  readonly siteAlive = new Uint8Array(SITES.length);
  readonly ai: VoxelAi;
  private readonly random = mulberry(20260616);
  private readonly arch: Archetype;
  private readonly cross: number;
  private aiTick = 0;
  private framesInRun = 0;
  private outcomeAt = -1;
  private forwardHeld = 0;
  private stepDistance = 0;
  private daylightWas = 1;
  private warned = 0;
  private lightTick = 0;
  private readonly sounds: Record<string, Sound>;
  private readonly digSounds: Sound[];

  get finished(): boolean {
    return this.outcome !== 0;
  }

  constructor() {
    const play = createPlayset({ capacity: 32, particles: 300, seed: 20260616 });
    this.play = play;
    play.gravity(22);
    this.voxel = new VoxelWorld(play, { size: SIZE, origin: ORIGIN });
    // leaves take no corner occlusion: their many small faces merge instead
    for (let t = 1; t < V.BLOCKS.length; t++) this.voxel.palette(t, V.BLOCKS[t].color, { glow: t === B.crystal ? 0.18 : 0, flat: t === B.leaf });
    // the demo's face shades: tops 1.16, bottoms 0.62, x sides 0.9, z sides 0.78
    this.voxel.shade({ px: 0.9, nx: 0.9, py: 1.16, ny: 0.62, pz: 0.78, nz: 0.78, ao: 1 });
    this.generate();
    this.voxel.build();
    this.voxel.snapshot();

    this.arch = play.archetype({ motion: motion.none(), hidden: true, radius: RADIUS, height: HEIGHT });
    this.cross = play.place(play.model(V.crosshair()), [0, -50, 0], { static: false });
    this.ai = new VoxelAi(this.random);

    const s = (spec: Parameters<Playset["sound"]>[0]) => play.sound(spec);
    this.sounds = {
      place: s(sfx.place()),
      deny: s({ ...sfx.hit(), freq: 180, to: 120, volume: 0.16 }),
      jump: s({ ...sfx.jump(), volume: 0.18 }),
      land: s(sfx.land()),
      step: s({ ...sfx.step(), volume: 0.2 }),
      hurt: s(sfx.hurt()),
      crystal: s(sfx.pickup()),
      win: s(sfx.win()),
      lose: s(sfx.lose()),
      alarm: s(sfx.alarm()),
      dusk: s({ wave: "triangle", freq: 660, to: 330, exp: true, sustain: 0.35, decay: 0.7, vibrato: 25, vibratoRate: 4, echo: 0.2, echoFeedback: 0.35, volume: 0.32 }),
      dawn: s({ wave: "triangle", freq: 392, arp: 1.5, arpTime: 0.18, sustain: 0.35, decay: 0.6, vibrato: 20, vibratoRate: 5, volume: 0.32 }),
      select: s(sfx.select()),
    };
    // per type: dirt, stone, wood, crystal, leaves
    this.digSounds = [
      this.sounds.deny,
      s(sfx.dig()),
      s({ ...sfx.dig(), freq: 1300, to: 600, crush: 0.7, volume: 0.3 }),
      s({ ...sfx.thud(), freq: 260, to: 120, noise: 0.3, volume: 0.42 }),
      s({ wave: "triangle", freq: 1760, to: 2640, sustain: 0.03, decay: 0.22, echo: 0.06, echoFeedback: 0.3, volume: 0.3 }),
      s({ wave: "noise", freq: 2600, to: 900, sustain: 0.02, decay: 0.12, lowpass: 0.5, volume: 0.22 }),
    ];
    this.reset(true);
  }

  /** The demo's generator over the whole box: terrain columns (stone with
   *  four layers of dirt), its scattered trees, then the goal crystals. */
  private generate(): void {
    const [w, , d] = SIZE;
    const heights = new Float32Array(w * d);
    const trees: number[] = [];
    const set = (x: number, y: number, zl: number, t: number) => trees.push(x, y, -zl - 1, t);
    const tree = (x: number, y: number, zl: number) => {
      for (let i = 0; i < 4; i++) set(x, y + i, zl, B.wood);
      const top = y + 3;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const distance = Math.abs(dx) + Math.abs(dz);
          if (distance <= 3 && (dx || dz)) set(x + dx, top, zl + dz, B.leaf);
          if (distance <= 2) set(x + dx, top + 1, zl + dz, B.leaf);
        }
      }
    };
    for (let j = 0; j < d; j++) {
      const zl = -(ORIGIN[2] + j) - 1;
      for (let k = 0; k < w; k++) {
        const x = ORIGIN[0] + k;
        const h = terrainHeight(x, zl);
        heights[j * w + k] = h;
        // keep trees two blocks inside the box so no leaf is cut off
        if (k > 2 && k < w - 3 && j > 2 && j < d - 3 && chanceNoise(x, zl, 1) > 0.982) tree(x, h + 1, zl);
      }
    }
    this.voxel.columns(ORIGIN[0], ORIGIN[2], w, d, heights, { base: B.stone, top: B.dirt, depth: 4 });
    for (let i = 0; i < SITES.length; i++) {
      const [kind, x, zl] = SITES[i];
      const ground = terrainHeight(x, zl);
      if (kind === "tree") tree(x, ground + 1, zl);
      const y = kind === "tree" ? ground + 5 : ground + 1;
      set(x, y, zl, B.crystal);
      this.sites[i * 3] = x;
      this.sites[i * 3 + 1] = y;
      this.sites[i * 3 + 2] = -zl - 1;
    }
    this.voxel.setMany(new Float32Array(trees));
  }

  surfaceAt(x: number, z: number): number {
    return terrainHeight(Math.floor(x), -Math.floor(z) - 1) + 1;
  }

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    // the world as generated; the chunks that changed mesh now, not over frames
    this.voxel.restore();
    this.voxel.build();
    this.status = demo ? "title" : "playing";
    this.demo = demo;
    this.outcome = 0;
    this.outcomeAt = -1;
    this.inventory.fill(0);
    this.selected = 0;
    this.elapsed = 0;
    this.dayTime = 0.24;
    this.daylightWas = 1;
    this.warned = 0;
    this.framesInRun = 0;
    this.siteAlive.fill(1);
    this.say("Collect 10 crystals within 3 minutes");
    // the demo's start: x 0, forward 8, 18 up, facing forward
    this.player = play.spawn(this.arch, 0.5, 18, -8.5, 0);
    this.voxel.body(this.player, RADIUS, HEIGHT, 28);
    this.yaw = 0;
    this.pitch = 0;
    this.px = 0.5;
    this.py = 18;
    this.pz = -8.5;
    this.grounded = false;
    this.ai.reset(this.px, this.pz);
    play.firstPersonCamera(this.player, EYE, 62, 32);
    this.applySky(true);
  }

  private say(text: string): void {
    this.message = text;
    this.messageTimer = 2.2;
  }

  /** The ray from the eye along the view: the type hit, `voxel.hit` filled. */
  private trace(): number {
    const cp = Math.cos(this.pitch);
    return this.voxel.raycast(this.px, this.py + EYE, this.pz, -Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp, REACH);
  }

  private siteAt(x: number, y: number, z: number): number {
    const s = this.sites;
    for (let i = 0; i < this.siteAlive.length; i++) if (s[i * 3] === x && s[i * 3 + 1] === y && s[i * 3 + 2] === z) return i;
    return -1;
  }

  private breakBlock(): void {
    const type = this.trace();
    if (type <= 0) {
      this.say("No block in reach");
      this.play.play(this.sounds.deny);
      return;
    }
    const h = this.voxel.hit;
    const x = h[0], y = h[1], z = h[2];
    this.voxel.set(x, y, z, B.air);
    this.play.play(this.digSounds[type] ?? this.digSounds[1], 1, 0.94 + this.random() * 0.12, [x + 0.5, y + 0.5, z + 0.5]);
    if (type === B.leaf) {
      this.say("Cleared leaves");
      return;
    }
    this.inventory[type] += 1;
    if (type === B.crystal) {
      const site = this.siteAt(x, y, z);
      if (site >= 0) this.siteAlive[site] = 0;
      this.play.play(this.sounds.crystal, 0.9);
      if (this.inventory[B.crystal] >= CRYSTAL_GOAL) this.finish(1);
      else this.say(`Crystal collected ${this.inventory[B.crystal]}/${CRYSTAL_GOAL}`);
    } else {
      this.say(`Collected ${V.BLOCKS[type].name}`);
    }
  }

  private placeBlock(): void {
    if (this.trace() <= 0) {
      this.say("Aim at a block to place");
      this.play.play(this.sounds.deny);
      return;
    }
    const type = PLACEABLE[this.selected];
    if (this.inventory[type] <= 0) {
      this.say(`No ${V.BLOCKS[type].name.toLowerCase()} blocks`);
      this.play.play(this.sounds.deny);
      return;
    }
    const h = this.voxel.hit;
    const x = h[0] + h[3], y = h[1] + h[4], z = h[2] + h[5];
    if (this.voxel.get(x, y, z) !== B.air) return;
    // the player's box, as the module collides it
    const inside =
      x >= Math.floor(this.px - RADIUS) && x <= Math.floor(this.px + RADIUS) &&
      y >= Math.floor(this.py) && y <= Math.floor(this.py + HEIGHT) &&
      z >= Math.floor(this.pz - RADIUS) && z <= Math.floor(this.pz + RADIUS);
    if (inside) {
      this.say("Too close to place");
      this.play.play(this.sounds.deny);
      return;
    }
    this.voxel.set(x, y, z, type);
    this.inventory[type] -= 1;
    if (type === B.crystal) {
      const site = this.siteAt(x, y, z);
      if (site >= 0) this.siteAlive[site] = 1;
    }
    this.play.play(this.sounds.place, 1, 0.94 + this.random() * 0.12, [x + 0.5, y + 0.5, z + 0.5]);
  }

  private finish(outcome: number): void {
    if (this.outcome) return;
    this.outcome = outcome;
    this.outcomeAt = this.play.tick;
    if (outcome === 1) {
      this.say("All 10 crystals collected. Objective complete.");
      this.play.play(this.sounds.win);
    } else {
      this.say(`Time expired. Collected ${this.inventory[B.crystal]}/${CRYSTAL_GOAL} crystals.`);
      this.play.play(this.sounds.lose);
    }
  }

  daylight(): number {
    const a = this.dayTime * Math.PI * 2;
    return Math.max(0.06, Math.min(1, Math.sin(a - Math.PI * 0.08) * 0.5 + 0.5));
  }

  /** The demo's updateDayNight: sun angle, intensity, sky and fog colour. */
  private applySky(force: boolean): void {
    if (!force && this.lightTick++ % 15 !== 0) return;
    const daylight = this.daylight();
    const a = this.dayTime * Math.PI * 2;
    const off = Math.abs(this.dayTime - 0.5);
    const warm = off > 0.28 && off < 0.38;
    const sky = mix(V.SKY.night, warm ? V.SKY.dusk : V.SKY.day, daylight);
    const play = this.play;
    play.sky(sky, sky, sky);
    play.fog(sky, 14, 31, 1);
    // three.js r161 lights in physical units: a Lambert surface takes 1/pi
    // of the demo's intensities (sun 0.25 + 1.65 * daylight, hemisphere 0.75)
    play.light({
      sun: [Math.cos(a) * 55, Math.sin(a) * 70, 32],
      sunColor: 0xfff1c0,
      sunIntensity: (0.25 + daylight * 1.65) / Math.PI,
      sky: 0xcfe9ff,
      ground: 0x2b241f,
      ambient: 0.75 / Math.PI,
    });
    if (daylight < 0.5 && this.daylightWas >= 0.5) play.play(this.sounds.dusk);
    if (daylight >= 0.5 && this.daylightWas < 0.5) play.play(this.sounds.dawn);
    this.daylightWas = daylight;
  }

  frame(pad: Pad): void {
    const play = this.play;
    const ent = play.ent;
    const o = this.player * 16;
    const live = this.status === "playing" || (this.status === "title" && this.demo);
    this.framesInRun++;
    let vx = ent[o + ENT.VX];
    let vy = ent[o + ENT.VY];
    let vz = ent[o + ENT.VZ];
    if (live && !this.outcome) {
      let forward = 0;
      let right = 0;
      let sprint = false;
      let jump = false;
      let primary = false;
      let secondary = false;
      let dyaw = 0;
      let dpitch = 0;
      if (this.demo) {
        const ai = this.ai;
        if (this.aiTick++ % 3 === 0) ai.think(this, 3);
        forward = ai.forward;
        right = ai.right;
        sprint = ai.sprint;
        jump = ai.jump;
        primary = ai.primary;
        ai.jump = false;
        ai.primary = false;
        dyaw = ai.yawStep;
        dpitch = ai.pitchStep;
      } else {
        const held = pad.held;
        const pressed = this.framesInRun > 2 ? pad.pressed : 0;
        if (held & BTN.LTRIGGER) {
          // look mode: up and down tilt the view, left and right strafe
          dpitch = pad.y * 1.6 * DT;
          right = pad.x;
        } else {
          forward = pad.y;
          dyaw = -pad.x * 2.2 * DT;
        }
        dyaw -= pad.rx * 2.4 * DT;
        dpitch += pad.ry * 1.8 * DT;
        this.forwardHeld = forward > 0.9 ? this.forwardHeld + DT : 0;
        sprint = this.forwardHeld > 0.6;
        jump = (held & BTN.CROSS) !== 0;
        primary = (pressed & BTN.CIRCLE) !== 0;
        secondary = (pressed & BTN.TRIANGLE) !== 0;
        if (pressed & BTN.RTRIGGER) {
          this.selected = (this.selected + 1) % PLACEABLE.length;
          play.play(this.sounds.select, 0.7);
          this.say(`${V.BLOCKS[PLACEABLE[this.selected]].name}: ${this.inventory[PLACEABLE[this.selected]]}`);
        }
      }
      this.yaw += dyaw;
      this.pitch = Math.max(-1.42, Math.min(1.42, this.pitch + dpitch));
      // the demo's movePlayer: blend toward the wish velocity, jump, gravity
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      const len = Math.sqrt(right * right + forward * forward);
      const scale = len > 1 ? 1 / len : 1;
      const speed = sprint ? 7.4 : 5.4;
      const wx = (cy * right - sy * forward) * scale;
      const wz = (-sy * right - cy * forward) * scale;
      vx += (wx * speed - vx) * BLEND;
      vz += (wz * speed - vz) * BLEND;
      if (jump && this.grounded) {
        const pit = Math.max(0, this.surfaceAt(this.px, this.pz) - this.py);
        vy = this.demo && pit > 1.05 ? Math.max(7.1, Math.min(11.4, 7.1 + pit * 1.75)) : 7.1;
        play.play(this.sounds.jump, 0.8);
      }
      vy -= 22 * DT;
      if (vy < -28) vy = -28;
      if (primary) this.breakBlock();
      if (secondary) this.placeBlock();
      // the objective timer, day and night
      this.elapsed = Math.min(TIME_LIMIT, this.elapsed + DT);
      const left = TIME_LIMIT - this.elapsed;
      if (left <= 30 && this.warned === 0) {
        this.warned = 1;
        play.play(this.sounds.alarm, 0.7);
      } else if (left <= 10 && this.warned === 1) {
        this.warned = 2;
        play.play(this.sounds.alarm, 0.9, 1.25);
      }
      if (left <= 0) this.finish(this.inventory[B.crystal] >= CRYSTAL_GOAL ? 1 : 2);
      this.dayTime = (this.dayTime + DT / 260) % 1;
      this.applySky(false);
    } else {
      vx = 0;
      vz = 0;
      vy = 0;
    }
    this.messageTimer = Math.max(0, this.messageTimer - DT);
    ent[o + ENT.VX] = vx;
    ent[o + ENT.VY] = vy;
    ent[o + ENT.VZ] = vz;
    ent[o + ENT.YAW] = this.yaw;
    ent[o + ENT.PITCH] = this.pitch;
    const wasGrounded = this.grounded;
    const ox = this.px, oz = this.pz;
    play.frame(DT);
    // what the module resolved
    this.px = ent[o];
    this.py = ent[o + 1];
    this.pz = ent[o + 2];
    this.grounded = (ent[o + ENT.STATE] & STATE.GROUNDED) !== 0;
    if (this.grounded && !wasGrounded && vy < -6) {
      if (vy < -15) {
        play.play(this.sounds.hurt, 0.8);
        play.shake(0.35);
      } else play.play(this.sounds.land, Math.min(1, -vy / 14));
    }
    if (this.grounded) {
      this.stepDistance += Math.hypot(this.px - ox, this.pz - oz);
      if (this.stepDistance > 1.9) {
        this.stepDistance = 0;
        play.play(this.sounds.step, 0.7, 0.9 + this.random() * 0.2);
      }
    }
    if (this.py < -20) {
      // the demo's fall-out guard: back to the starting ridge
      ent[o] = 0.5;
      ent[o + 1] = 22;
      ent[o + 2] = -8.5;
      ent[o + ENT.VX] = ent[o + ENT.VY] = ent[o + ENT.VZ] = 0;
      this.say("Returned to the starting ridge");
      play.play(this.sounds.hurt);
    }
    // the crosshair, 0.3 m along the view
    const cp = Math.cos(this.pitch);
    const ey = this.py + EYE;
    play.move(this.cross, this.px - Math.sin(this.yaw) * cp * 0.3, ey + Math.sin(this.pitch) * 0.3, this.pz - Math.cos(this.yaw) * cp * 0.3, this.yaw, this.pitch, 0, 1, !live);
    if (this.outcome && this.status === "playing" && play.tick - this.outcomeAt > 150) this.status = "gameover";
    if (this.outcome && this.status === "title" && play.tick - this.outcomeAt > 150) this.reset(true);
  }

  remaining(): number {
    return Math.max(0, TIME_LIMIT - this.elapsed);
  }
}

/** sRGB hex lerp. */
function mix(a: number, b: number, t: number): number {
  const ch = (s: number) => {
    const x = (a >> s) & 255;
    const y = (b >> s) & 255;
    return Math.round(x + (y - x) * t) << s;
  };
  return ch(16) | ch(8) | ch(0);
}

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new VoxelSurvival();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  const holding = () => {
    const t = PLACEABLE[game.selected];
    return `${V.BLOCKS[t].name} ${game.inventory[t]}`;
  };
  return {
    title: "Voxel Survival",
    tagline: "Collect all 10 crystals within 3 minutes:\n7 across the ground, 3 up in the trees.",
    accent: "#3f8f3c",
    controls: [
      ["Circle Pad", "Walk and turn"],
      ["L + Circle Pad", "Look up and down, strafe"],
      ["A / X", "Mine / place"],
      ["B / R", "Jump / next block"],
      ["START", "Pause"],
    ],
    readouts: [
      { label: "Crystals", value: () => `${game.inventory[B.crystal]}/${CRYSTAL_GOAL}`, bar: () => game.inventory[B.crystal] / CRYSTAL_GOAL, color: "#69d7ff" },
      { label: "Time", value: () => `${Math.ceil(game.remaining())} s`, bar: () => game.remaining() / TIME_LIMIT, color: "#ffd166" },
      { label: "Holding", value: holding },
      { label: "Dirt", value: () => game.inventory[B.dirt] },
      { label: "Stone", value: () => game.inventory[B.stone] },
      { label: "Wood", value: () => game.inventory[B.wood] },
    ],
    play: game.play,
    status(): GameStatus {
      if (game.status === "title") return "title";
      if (game.status === "gameover") return "gameover";
      return paused ? "paused" : "playing";
    },
    start(demo: boolean) {
      paused = false;
      game.reset(demo);
      if (!demo) game.status = "playing";
    },
    pause(p: boolean) {
      paused = p;
    },
    frame(pad: Pad) {
      if (paused) return;
      game.frame(pad);
    },
    topLine: () =>
      game.messageTimer > 0
        ? game.message
        : `CRYSTALS ${game.inventory[B.crystal]}/${CRYSTAL_GOAL}    TIME ${Math.ceil(game.remaining())}s    ${holding().toUpperCase()}`,
    result: () =>
      game.outcome === 1
        ? `All 10 crystals in ${Math.floor(game.elapsed / 60)}:${String(Math.floor(game.elapsed % 60)).padStart(2, "0")}`
        : `Collected ${game.inventory[B.crystal]}/${CRYSTAL_GOAL} crystals before the time ran out`,
  };
}

export { AI_MODE };
