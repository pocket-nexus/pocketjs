// Space Shooter's gameplay over the playset kernels, ported from GameBlocks'
// space-shooter demo (https://gb-space-shooter.vercel.app/, MIT, xt4d/GameBlocks).
//
// What runs where:
//   native, every step — ship, enemy and asteroid motion (planar and homing
//     linear kernels), enemy aim and fire (seek brain), shots, every contact
//     (rule table), explosions (death emitters), the chase camera;
//   here, at event rate — score, the wave director, power-ups (a shield is a
//     layer change, rapid fire a weapon retune), pickups' spawn timers;
//   here, on a budget — the arena clamp and the bank of the ship (per frame,
//     a dozen floats), the enemies' sideways drift (script, every 2nd step),
//     and the autopilot (every 3rd step).
//
// Coordinates: right is +X, forward is -Z. The demo's "forward" component f
// sits at z = -f, so its player line f = -18 is z = 18 and enemies come from
// z < -34.

import {
  ENT,
  EVENT,
  brain,
  createPlayset,
  joint,
  layers,
  motion,
  sfx,
  type Sound,
  type Archetype,
  type Playset,
} from "@pocketjs/framework/playset";
import * as V from "./visuals.ts";
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";

export const ARENA = { halfRight: 18, minForward: -26, maxForward: 34, playerForward: -18 };
export const PLAYER_RADIUS = 1.15;
const ENEMY_RADIUS = 1.2;

export const L = layers("player", "shielded", "enemy", "rock", "shot", "eshot", "pickup");

export type Status = "title" | "playing" | "gameover";

export interface Hud {
  status: Status;
  demo: boolean;
  score: number;
  wave: number;
  health: number;
  shield: number;
  rapid: number;
}

const ENEMY_STATS: Record<V.EnemyType, { hp: number; speed: number; value: number }> = {
  grunt: { hp: 45, speed: 8.4, value: 120 },
  dart: { hp: 28, speed: 12.8, value: 120 },
  heavy: { hp: 74, speed: 6.2, value: 120 },
};

/** GameBlocks' WaveSpawnDirector, with the demo's settings. */
class Waves {
  wave = 1;
  inProgress = false;
  toSpawn = 0;
  spawned = 0;
  constructor(private readonly random: () => number) {}
  reset(): void {
    this.wave = 1;
    this.start();
  }
  start(): void {
    this.toSpawn = Math.max(1, Math.min(18, Math.floor(4 + (this.wave - 1) * 1.6)));
    this.spawned = 0;
    this.inProgress = true;
  }
  /** Spawn plans for this step: at most two. */
  step(active: number, out: V.EnemyType[]): number {
    if (this.inProgress && this.spawned >= this.toSpawn && active <= 0) {
      this.inProgress = false;
      this.wave += 1;
    }
    if (!this.inProgress) this.start();
    let n = 0;
    while (this.spawned < this.toSpawn && n < 2) {
      out[n++] = this.pick();
      this.spawned += 1;
    }
    return n;
  }
  private pick(): V.EnemyType {
    const w = this.wave;
    const grunt = 5;
    const dart = w >= 3 ? 1 + w * 0.4 : 0;
    const heavy = w >= 5 ? Math.max(0, w - 3) : 0;
    let r = this.random() * (grunt + dart + heavy);
    if ((r -= grunt) <= 0) return "grunt";
    if ((r -= dart) <= 0) return "dart";
    return "heavy";
  }
}

export class SpaceShooter {
  readonly play: Playset;
  readonly hud: Hud = { status: "title", demo: true, score: 0, wave: 1, health: 100, shield: 0, rapid: 0 };
  player = -1;
  private shieldSlot = -1;
  private readonly random = V.mulberry(20260616);
  private readonly waves = new Waves(this.random);
  private readonly plans: V.EnemyType[] = ["grunt", "grunt"];
  private active = 0;
  private asteroidTimer = 1.1;
  private powerTimer = 6;
  private shieldSeconds = 0;
  private rapidSeconds = 0;
  private elapsed = 0;
  private aiTick = 0;
  private aiX = 0;
  private aiFwd = 0;
  private readonly enemy: Record<V.EnemyType, Archetype>;
  private readonly rocks: Archetype[];
  private readonly pickups: Record<V.PickupType, Archetype>;
  private readonly shipArch: Archetype;
  private readonly shieldArch: Archetype;
  private readonly shot: Archetype;
  private readonly enemyShot: Archetype;
  private readonly ram = new Set<number>();
  private readonly backdrop: { node: number; k: number }[] = [];
  private readonly boom: { id: number };
  private readonly laser: Sound;
  private readonly waveSound: Sound;

  constructor() {
    const play = createPlayset({ capacity: 256, particles: 600, seed: 20260616 });
    this.play = play;
    play.sky(V.PALETTE.spaceDeep, V.PALETTE.spaceDeep, V.PALETTE.spaceDeep);
    play.fog(V.PALETTE.spaceFog, 30, 150, 0.85);
    play.light({ sun: [8, 16, 10], sunColor: 0xe8f6ff, sunIntensity: 1.7, sky: 0x9fcaff, ground: 0x2a1840, ambient: 0.55 });
    play.gravity(0);
    play.bounds(-40, 40, -75, 36, -20, 30);
    this.buildBackdrop();

    const burst = (color: number, count = 18, speed = 5) =>
      play.emitter({ count, life: 0.7, speed, spread: Math.PI, size: [0.32, 0.06], color: [color, color], alpha: [1, 0], blend: "add", drag: 1.5 });
    const hitCyan = burst(0x74f7ff);
    const hitOrange = burst(0xff764f, 12);
    const ramRed = burst(0xff6c4b, 22, 7);
    const rockAmber = burst(0xffb65d, 16, 5);
    const pickupTeal = burst(0x79fff2, 18, 4);
    this.boom = burst(0xffdf74, 60, 9);
    const exhaust = play.emitter({
      count: 1, life: 0.28, speed: 3, spread: 0.25, dir: [0, 0, 1], size: [0.28, 0.05], color: [0xffa060, 0xff3a20], alpha: [0.9, 0], blend: "add", drag: 0,
    });

    // sounds: rendered once here, played natively where they happen
    this.laser = play.sound(sfx.laser());
    const blaster = play.sound({ ...sfx.blaster(), volume: 0.18 });
    const tick = play.sound({ ...sfx.hit(), volume: 0.14 });
    const boomSound = play.sound(sfx.explosion());
    const crumble = play.sound(sfx.crumble());
    const hurt = play.sound(sfx.hurt());
    const bigBoom = play.sound(sfx.bigExplosion());
    this.waveSound = play.sound(sfx.wave());
    const jet = play.sound(sfx.jet());

    const shotModel = play.model(V.bolt(0x6df4ff, 0.07, 0.82));
    this.shot = play.archetype({
      model: shotModel, motion: motion.linear({ speed: 54 }), layer: L.shot, hits: L.enemy | L.rock,
      radius: 1.75, damage: 22, lifetime: 1.45, projectile: true, bounds: "kill", death: hitCyan,
      sounds: { death: tick },
    });
    const eshotModel = play.model(V.bolt(0xff5d38, 0.085, 0.7));
    this.enemyShot = play.archetype({
      model: eshotModel, motion: motion.linear({ speed: 28 }), layer: L.eshot, hits: L.player | L.shielded,
      radius: 1.0, damage: 13, lifetime: 2.2, projectile: true, team: 2, bounds: "kill", death: hitOrange,
    });

    const ship = play.model(V.playerShip());
    this.shipArch = play.archetype({
      model: ship, motion: motion.planar({ accel: 95, maxSpeed: 28, damping: 7, frame: "world", face: "none", bank: 0.42 }),
      layer: L.player, hits: L.pickup, team: 1, radius: PLAYER_RADIUS, hp: 100, keepOnDeath: true, flash: 0.2, invulnerable: 0.05,
      trail: exhaust, trailRate: 40, weapons: [this.weapon(false, -1)],
      sounds: { hit: hurt, death: bigBoom }, hum: { sound: jet, speed: 28, pitch: 1.6 },
    });
    this.shieldArch = play.archetype({ model: play.model(V.shieldBubble()), motion: motion.attached() });

    const types: V.EnemyType[] = ["grunt", "dart", "heavy"];
    this.enemy = {} as Record<V.EnemyType, Archetype>;
    for (const t of types) {
      const s = ENEMY_STATS[t];
      this.enemy[t] = play.archetype({
        model: play.model(V.enemyShip(t)),
        motion: motion.linear({ speed: s.speed, homing: 2.2 }),
        brain: brain.seek({ target: { nearest: L.player | L.shielded, every: 1 }, fireRange: 70, fireCone: 0.5 }),
        layer: L.enemy, hits: L.player | L.shielded, team: 2, radius: ENEMY_RADIUS, hp: s.hp, value: s.value,
        bounds: "kill", death: ramRed, flash: 0.1, sounds: { death: boomSound },
        weapons: [{ projectile: this.enemyShot, cooldown: 1.8, speed: 28, muzzle: [0, 0, -1], aim: "lead", sound: blaster }],
      });
    }
    const rockModel = play.model(V.asteroid(), { seed: 7 });
    this.rocks = (["x", "y", "z"] as const).map((axis, i) =>
      play.archetype({
        model: rockModel, scale: V.OBJECT_VISUAL_SCALE, motion: motion.linear({ speed: 10 }),
        layer: L.rock, hits: L.player | L.shielded, radius: 1, hp: 1, value: 35, bounds: "kill", death: rockAmber,
        sounds: { death: crumble },
        joints: [joint.spin("rock", axis, [1.6, -1.2, 2.1][i])],
      }),
    );
    this.pickups = {} as Record<V.PickupType, Archetype>;
    const pickupSounds = { rapid: play.sound(sfx.powerup()), shield: play.sound(sfx.pickup()), health: play.sound(sfx.heal()) };
    for (const t of ["rapid", "shield", "health"] as const) {
      // bounds kills are silent; only a collection plays the sound
      this.pickups[t] = play.archetype({
        model: play.model(V.pickup(t)), motion: motion.linear({ speed: 4 }), layer: L.pickup, radius: 0.9,
        bounds: "kill", death: pickupTeal, joints: [joint.spin("spin", "y", 2.4)], sounds: { death: pickupSounds[t] },
      });
    }

    // what contacts do: the native step applies these to every pair
    play.rule(L.shot, L.enemy | L.rock, { damage: "b", kill: "a" });
    play.rule(L.eshot, L.player, { damage: "b", kill: "a" });
    play.rule(L.eshot, L.shielded, { damage: "b", kill: "a", value: 13 * 0.25 });
    // the four rules with events are the rams: their victims score nothing
    play.rule(L.enemy, L.player, { damage: "b", kill: "a", value: 26, event: true });
    play.rule(L.enemy, L.shielded, { damage: "b", kill: "a", value: 26 * 0.25, event: true });
    play.rule(L.rock, L.player, { damage: "b", kill: "a", value: 22, event: true });
    play.rule(L.rock, L.shielded, { damage: "b", kill: "a", value: 22 * 0.25, event: true });
    play.rule(L.player | L.shielded, L.pickup, { pickup: true });

    play.on(EVENT.HIT, (a) => this.ram.add(a));
    play.on(EVENT.DEATH, (slot, _killer, arch, x, y, z, value) => this.onDeath(slot, arch, x, y, z, value));
    play.on(EVENT.BOUNDS, (_slot, _b, arch) => {
      if (this.isEnemy(arch)) this.active -= 1;
    });
    play.on(EVENT.PICKUP, (_a, _b, arch) => this.onPickup(arch));
    // the demo's sideways weave, as a script on a budget
    for (const t of types) play.script(this.enemy[t], (s) => this.weave(s), 2, types.indexOf(t));

    this.reset(true);
  }

  private weapon(rapid: boolean, side: number) {
    return {
      projectile: this.shot, cooldown: rapid ? 0.105 : 0.22, speed: 54, muzzle: [rapid ? side * 0.45 : 0, 0, -1.25] as [number, number, number],
      sound: side > 0 && rapid ? undefined : this.laser,
    };
  }

  private buildBackdrop(): void {
    const play = this.play;
    const far = play.model(
      V.starLayer(this.random, { count: 900, right: 96, upMin: -38, upMax: 58, forwardMin: -105, forwardMax: 90, size: 0.28, colors: [0xe8f4ff, 0x92d8ff, 0xffc3df] }),
    );
    const dust = play.model(
      V.starLayer(this.random, { count: 240, right: 82, upMin: -24, upMax: 46, forwardMin: -88, forwardMax: 82, size: 0.5, colors: [V.PALETTE.cyan, V.PALETTE.violet, V.PALETTE.magenta] }),
    );
    const planetA = play.model(V.distantPlanet({ color: 0x5aa9ff, accent: 0xb7e7ff, radius: 4.2, ring: true }));
    const planetB = play.model(V.distantPlanet({ color: 0x493b86, accent: V.PALETTE.magenta, radius: 2.7, ring: false }));
    this.backdrop.push({ node: play.place(far, [0, 0, 0], { static: false }), k: 0.1 });
    this.backdrop.push({ node: play.place(dust, [0, 0, 0], { static: false }), k: 0.075 });
    // the planets keep their places in the cluster and drift together
    const a = play.place(planetA, [34, 17, -45], { static: false });
    const b = play.place(planetB, [-38, 22, -58], { static: false });
    this.planets = [
      { node: a, at: [34, 17, -45] },
      { node: b, at: [-38, 22, -58] },
    ];
  }
  private planets: { node: number; at: [number, number, number] }[] = [];

  private isEnemy(arch: number): boolean {
    return arch === this.enemy.grunt.id || arch === this.enemy.dart.id || arch === this.enemy.heavy.id;
  }

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    this.ram.clear();
    this.hud.status = demo ? "title" : "playing";
    this.hud.demo = demo;
    this.hud.score = 0;
    this.active = 0;
    this.asteroidTimer = 1.1;
    this.powerTimer = 6;
    this.shieldSeconds = 0;
    this.rapidSeconds = 0;
    this.elapsed = 0;
    this.shieldSlot = -1;
    this.waves.reset();
    this.retuneEnemies();
    play.retune(this.shipArch, { weapons: [this.weapon(false, -1)] });
    this.player = play.spawn(this.shipArch, 0, 0, -ARENA.playerForward);
    play.followCamera(this.player, { offset: [0, 13.5, 23], lookAhead: 9, lookUp: 2.4, heading: false, fov: 46, far: 220, smooth: 5, smoothLook: 8 });
  }

  private retuneEnemies(): void {
    const cooldown = Math.max(0.72, 1.8 - this.waves.wave * 0.07);
    for (const t of ["grunt", "dart", "heavy"] as const) {
      this.play.retune(this.enemy[t], { weapons: [{ projectile: this.enemyShot, cooldown, speed: 28, muzzle: [0, 0, -1], aim: "lead" }] });
    }
  }

  private weave(s: number): void {
    // drift = sin(t * 1.7 + x) * 0.9 along +X, applied for the two steps
    const ent = this.play.ent;
    const o = s * 16;
    ent[o] += Math.sin(this.elapsed * 1.7 + ent[o]) * 0.9 * (2 / 60);
  }

  private onDeath(slot: number, arch: number, x: number, y: number, z: number, value: number): void {
    const play = this.play;
    if (slot === this.player) {
      this.hud.status = "gameover";
      play.burst(this.boom, x, y, z);
      play.shake(1);
      if (this.shieldSlot >= 0) play.kill(this.shieldSlot);
      return;
    }
    const rammed = this.ram.delete(slot);
    if (this.isEnemy(arch)) this.active -= 1;
    if (rammed) {
      play.shake(0.5);
      return;
    }
    if (this.hud.status === "playing" || this.hud.demo) this.hud.score += value;
    if (this.random() < 0.14) this.spawnPickup(x, z);
  }

  private onPickup(arch: number): void {
    const play = this.play;
    if (arch === this.pickups.health.id) {
      const o = this.player * 16 + ENT.HP;
      play.ent[o] = Math.min(100, play.ent[o] + 32);
    } else if (arch === this.pickups.shield.id) {
      if (this.shieldSeconds <= 0) {
        play.setLayer(this.player, L.shielded, L.pickup, 1);
        this.shieldSlot = play.spawn(this.shieldArch, play.x(this.player), 0, play.z(this.player));
        play.attach(this.shieldSlot, this.player, [0, 0, 0]);
      }
      this.shieldSeconds = 8;
    } else {
      if (this.rapidSeconds <= 0) play.retune(this.shipArch, { weapons: [this.weapon(true, -1), this.weapon(true, 1)] });
      this.rapidSeconds = 7;
    }
  }

  private spawnPickup(x?: number, z?: number): void {
    const types = ["rapid", "shield", "health"] as const;
    const t = types[Math.floor(this.random() * 3)];
    const px = x ?? -14 + this.random() * 28;
    const pz = z ?? -(-8 + this.random() * 26);
    this.play.spawn(this.pickups[t], px, 0, pz, Math.PI);
  }

  private spawnEnemy(type: V.EnemyType, index: number): void {
    const r = this.random;
    const x = -ARENA.halfRight + 2 + r() * (ARENA.halfRight * 2 - 4);
    const forward = ARENA.maxForward + 2 + r() * 8 + index * 1.2;
    const s = this.play.spawn(this.enemy[type], x, -2 + r() * 5, -forward, Math.PI);
    if (s >= 0) this.active += 1;
  }

  private spawnAsteroid(): void {
    const r = this.random;
    const radius = 0.8 + r() * 1.2;
    const arch = this.rocks[Math.floor(r() * 3)];
    const s = this.play.spawn(arch, -ARENA.halfRight + r() * ARENA.halfRight * 2, -2.5 + r() * 6, -(ARENA.maxForward + 6), Math.PI);
    if (s < 0) return;
    this.play.look[s * 4] = radius * V.OBJECT_VISUAL_SCALE;
    this.play.ent[s * 16 + ENT.SPEED] = 7 + r() * 8;
  }

  /** One frame: the player's stick (or the autopilot), timers, the native step. */
  frame(stickX: number, stickFwd: number): void {
    const play = this.play;
    const dt = 1 / 60;
    const live = this.hud.status === "playing" || (this.hud.status === "title" && this.hud.demo);
    if (live) {
      this.elapsed += dt;
      let mx = stickX;
      let mf = stickFwd;
      if (this.hud.demo) {
        if (this.aiTick++ % 6 === 0) this.autopilot();
        mx = this.aiX;
        mf = this.aiFwd;
      }
      play.steer(this.player, mx, mf);
      play.buttons(this.player, 1, this.rapidSeconds > 0 ? 1 : 0);
      play.ent[this.player * 16 + ENT.PITCH] = mf * 0.18;
      const n = this.waves.step(this.active, this.plans);
      for (let i = 0; i < n; i++) this.spawnEnemy(this.plans[i], this.waves.spawned - n + i);
      if (this.waves.wave !== this.hud.wave) {
        this.hud.wave = this.waves.wave;
        this.retuneEnemies();
        play.play(this.waveSound, 0.8);
      }
      this.asteroidTimer -= dt;
      if (this.asteroidTimer <= 0) {
        this.asteroidTimer = Math.max(0.46, 1.55 - this.waves.wave * 0.05) + this.random() * 0.65;
        this.spawnAsteroid();
      }
      this.powerTimer -= dt;
      if (this.powerTimer <= 0) {
        this.powerTimer = 9 + this.random() * 5;
        this.spawnPickup();
      }
      if (this.shieldSeconds > 0) {
        this.shieldSeconds -= dt;
        if (this.shieldSeconds <= 0) {
          play.setLayer(this.player, L.player, L.pickup, 1);
          if (this.shieldSlot >= 0) play.kill(this.shieldSlot);
          this.shieldSlot = -1;
        }
      }
      if (this.rapidSeconds > 0) {
        this.rapidSeconds -= dt;
        if (this.rapidSeconds <= 0) play.retune(this.shipArch, { weapons: [this.weapon(false, -1)] });
      }
    } else {
      play.steer(this.player, 0, 0);
      play.buttons(this.player, 0);
    }
    play.frame(dt);
    // the arena: right within ±18, forward between -26 and -10
    const o = this.player * 16;
    const ent = play.ent;
    if (ent[o] < -ARENA.halfRight) ent[o] = -ARENA.halfRight;
    else if (ent[o] > ARENA.halfRight) ent[o] = ARENA.halfRight;
    const zMin = -(ARENA.playerForward + 8);
    const zMax = -ARENA.minForward;
    if (ent[o + 2] < zMin) ent[o + 2] = zMin;
    else if (ent[o + 2] > zMax) ent[o + 2] = zMax;
    // parallax: background layers follow the eye
    const cam = play.cameraView;
    for (let i = 0; i < this.backdrop.length; i++) {
      const b = this.backdrop[i];
      play.move(b.node, cam[0] * b.k, cam[1] * b.k, cam[2] * b.k);
    }
    for (let i = 0; i < this.planets.length; i++) {
      const p = this.planets[i];
      play.move(p.node, p.at[0] + cam[0] * 0.06, p.at[1] + cam[1] * 0.06, p.at[2] + cam[2] * 0.06);
    }
    this.hud.health = Math.max(0, Math.ceil(ent[o + ENT.HP]));
    this.hud.shield = Math.max(0, this.shieldSeconds);
    this.hud.rapid = Math.max(0, this.rapidSeconds);
  }

  /** The demo's PlayerAi: pick a target and a lane, dodge what is coming.
   *  Written for the 3DS interpreter: one pass over the nearby slots into
   *  flat arrays, then nine lanes against the threats alone, with every
   *  constant and view in a local. */
  private readonly threatX = new Float32Array(64);
  private readonly threatT = new Float32Array(64);
  private readonly threatW = new Float32Array(64);
  private readonly threatK = new Float32Array(64);
  private autopilot(): void {
    const play = this.play;
    const ent = play.ent;
    const look = play.look;
    const list = play.list;
    const p = this.player * 16;
    const px = ent[p];
    const pf = -ent[p + 2];
    const n = play.near(L.enemy | L.rock | L.pickup | L.eshot, px, -pf, 70);
    const eshot = this.enemyShot.id;
    const g0 = this.enemy.grunt.id, g1 = this.enemy.dart.id, g2 = this.enemy.heavy.id;
    const r0 = this.rocks[0].id, r1 = this.rocks[1].id, r2 = this.rocks[2].id;
    const ph = this.pickups.health.id, pr = this.pickups.rapid.id, psh = this.pickups.shield.id;
    const hp = ent[p + 10];
    const tx = this.threatX, tt = this.threatT, tw = this.threatW, tk = this.threatK;
    let threats = 0;
    let bestX = 0, bestScore = -1e9, haveBest = false;
    let pickX = 0, pickF = 0, pickScore = -1e9, havePick = false;
    for (let i = 0; i < n; i++) {
      const o = list[i] * 16;
      const arch = ent[o + 13] - 1;
      const sx = ent[o];
      const gap = -ent[o + 2] - pf;
      const enemy = arch === g0 || arch === g1 || arch === g2;
      const rock = arch === r0 || arch === r1 || arch === r2;
      if (enemy || rock) {
        if (gap >= 1.8 && gap <= 62) {
          const score = (enemy ? 16 : 9) - Math.abs(sx - px) * 0.42 - gap * 0.055;
          if (score > bestScore) {
            bestScore = score;
            bestX = sx;
            haveBest = true;
          }
        }
        if (gap >= -3 && threats < 64) {
          const t = gap / Math.max(Math.abs(ent[o + 9]), 1);
          if (t <= 2.8) {
            tx[threats] = sx;
            tt[threats] = t;
            tw[threats] = (rock ? look[list[i] * 4] / 2 : ENEMY_RADIUS) + PLAYER_RADIUS + 1.25;
            tk[threats] = rock ? 1.25 * 4.5 : 1.05 * 4.5;
            threats++;
          }
        }
      } else if (arch === eshot) {
        const vf = -ent[o + 5];
        if (gap >= -3 && vf < -0.1 && threats < 64) {
          const t = gap / -vf;
          if (t >= 0 && t <= 1.6) {
            // a shot is a threat at its predicted crossing, scored like the demo's
            tx[threats] = sx + ent[o + 3] * t;
            tt[threats] = t;
            tw[threats] = 2.9;
            tk[threats] = -9;
            threats++;
          }
        }
      } else if (arch === ph || arch === pr || arch === psh) {
        if (gap >= -4 && gap <= 18) {
          const value = arch === ph ? (hp < 72 ? 12 : 3) : arch === pr ? (this.rapidSeconds <= 1 ? 8 : 2) : this.shieldSeconds <= 1 ? 7 : 2;
          const score = value - Math.abs(sx - px) * 0.2 - Math.abs(gap) * 0.12;
          if (score > pickScore) {
            pickScore = score;
            pickX = sx;
            pickF = -ent[o + 2];
            havePick = true;
          }
        }
      }
    }
    let bestLane = px;
    let laneScore = -1e9;
    for (let lane = -16; lane <= 16; lane += 4) {
      let score = -Math.abs(lane - px) * 0.08 - Math.abs(lane) * 0.025;
      if (haveBest) score -= Math.abs(lane - bestX) * 0.62;
      if (havePick) score += Math.max(0, 5 - Math.abs(lane - pickX)) * 0.9;
      for (let k = 0; k < threats; k++) {
        const overlap = tw[k] - Math.abs(lane - tx[k]);
        if (overlap <= 0) continue;
        const kind = tk[k];
        score -= kind < 0 ? overlap * (2 - tt[k]) * 9 : overlap * (3 - tt[k]) * kind;
      }
      if (score > laneScore) {
        laneScore = score;
        bestLane = lane;
      }
    }
    const want = havePick ? Math.min(Math.max(pickF, ARENA.minForward + 3), ARENA.playerForward + 6) : ARENA.playerForward - 2;
    this.aiX = Math.max(-1, Math.min(1, (bestLane - px) * 0.28));
    this.aiFwd = Math.max(-1, Math.min(1, (want - pf) * 0.24));
  }

  private isRock(arch: number): boolean {
    return arch === this.rocks[0].id || arch === this.rocks[1].id || arch === this.rocks[2].id;
  }
}

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new SpaceShooter();
  // read by the dev wire for profiling
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  let overAt = -1;
  return {
    title: "Space Shooter",
    tagline: "Hold the line against raiders and asteroids.\nGrab rapid fire, shields and repairs.",
    accent: "#2f8fd8",
    controls: [
      ["Circle Pad / D-Pad", "Fly"],
      ["Fire", "Automatic"],
      ["START", "Pause"],
      ["Y", "Developer stats"],
      ["SELECT", "Home"],
    ],
    readouts: [
      { label: "Hull", value: () => game.hud.health, bar: () => game.hud.health / 100, color: "#ff6f8f" },
      { label: "Score", value: () => game.hud.score },
      { label: "Wave", value: () => game.hud.wave },
      { label: "Shield", value: () => (game.hud.shield > 0 ? game.hud.shield.toFixed(1) + " s" : "-"), bar: () => game.hud.shield / 8, color: "#58a6ff" },
      { label: "Rapid fire", value: () => (game.hud.rapid > 0 ? game.hud.rapid.toFixed(1) + " s" : "-"), bar: () => game.hud.rapid / 7, color: "#8bff7a" },
    ],
    play: game.play,
    status(): GameStatus {
      if (game.hud.status === "title") return "title";
      if (game.hud.status === "gameover") return game.hud.demo ? "title" : "gameover";
      return paused ? "paused" : "playing";
    },
    start(demo: boolean) {
      paused = false;
      game.reset(demo);
      if (!demo) game.hud.status = "playing";
    },
    pause(p: boolean) {
      paused = p;
    },
    frame(pad: Pad) {
      // the attract loop restarts itself two seconds after a demo ends
      if (game.hud.demo && game.hud.status === "gameover") {
        if (overAt < 0) overAt = game.play.tick;
        else if (game.play.tick - overAt > 120) {
          overAt = -1;
          game.reset(true);
        }
      }
      if (paused) return;
      game.frame(pad.x, pad.y);
    },
    topLine: () => `SCORE ${game.hud.score}    WAVE ${game.hud.wave}    HULL ${game.hud.health}`,
    result: () => `Score ${game.hud.score} · reached wave ${game.hud.wave}`,
  };
}
