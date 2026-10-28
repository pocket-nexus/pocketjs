// Desert Shooter's gameplay over the playset kernels, ported from GameBlocks'
// desert-shooter demo (https://gb-desert-shooter.vercel.app/, MIT, xt4d/GameBlocks).
//
// What runs where:
//   native, every step — the rover (car kernel, snapped to the dunes and
//     tilted with them), the dinosaurs (planar kernel, seek brain with the
//     demo's charge and stand-off speeds), the spitters' and the boss's
//     shots (aimed straight at the rover), the gun's fire, every contact
//     (rules), the props as static colliders that stop movers and shots,
//     the chase camera, the engine hum;
//   here, at event rate — score, ammo (one FIRE event per shot), pickups,
//     the wave director, hit puffs;
//   here, per frame — the rover's intents, the demo's drift (a yaw and a
//     sideways nudge), the turret angle, and the dinosaurs' bite (the demo
//     hurts the rover while one stands within its reach, damage per second);
//   here, on a budget — the autopilot, every 3rd frame.
//
// Coordinates: the demo's (right, up, forward) is playset (x, y, -z).
//
// Deviations: hits are 3D spheres at the gun's height where the demo tests
// circles on the ground plane; the enemy radius is one number for props,
// shots and bites (0.72 r + 1.8, which is the demo's shot reach), the bite
// keeps the demo's reach; the first spit comes without the demo's random
// 0.2-1.2 s delay; the dune colours follow height only (the demo also
// striped them); a wave start shows "WAVE n" in the corner line.

import {
  ENT,
  EVENT,
  INTENT,
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
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";
import { mulberry } from "../kit/random.ts";
import { Autopilot, type Controls } from "./ai.ts";
import * as V from "./visuals.ts";
import { WaveDirector } from "./waves.ts";
import { DesertWorld, WORLD_BOUNDS, duneHeight } from "./world.ts";

export const PLAYER_RADIUS = 2.75;
const RIDE_HEIGHT = 0.13;
const MAX_HEALTH = 100;
const START_AMMO = 160;
const TURRET_TURN_RATE = 1.2;
/** the gun's height above the rover's base, and the body's collision height */
const GUN_UP = 1.55;
const BODY_HEIGHT = 3.4;

export const ENEMY_TYPES = ["chase", "charge", "spit", "boss"] as const;
export const ENEMY_STATS: Record<V.EnemyType, { hp: number; hpPerWave: number; speed: number; radius: number; score: number; damage: number }> = {
  chase: { hp: 48, hpPerWave: 6, speed: 4.2, radius: 3.0, score: 120, damage: 13 },
  charge: { hp: 72, hpPerWave: 8, speed: 3.8, radius: 3.8, score: 180, damage: 16 },
  spit: { hp: 54, hpPerWave: 7, speed: 3.2, radius: 3.2, score: 160, damage: 10 },
  boss: { hp: 420, hpPerWave: 42, speed: 2.8, radius: 7.2, score: 950, damage: 25 },
};
/** the demo's speed factors: [inside metres, factor] */
const NEAR_SPEED: Record<V.EnemyType, [number, number]> = { chase: [0, 1], charge: [44, 1.45], spit: [38, 0.28], boss: [36, 0.55] };

export const L = layers("player", "enemy", "shot", "eshot", "pickup");

export type Status = "title" | "playing" | "gameover";

export interface Hud {
  status: Status;
  demo: boolean;
  score: number;
  wave: number;
  health: number;
  ammo: number;
  maxAmmo: number;
  fireRate: number;
}

export class DesertShooter {
  readonly play: Playset;
  readonly world = new DesertWorld();
  readonly hud: Hud = { status: "title", demo: true, score: 0, wave: 1, health: MAX_HEALTH, ammo: START_AMMO, maxAmmo: START_AMMO, fireRate: 0.075 };
  player = -1;
  gun = -1;
  /** the turret's angle from the rover's heading (the demo's gunRelativeYaw) */
  gunRelative = 0;
  message = "";
  private messageFrames = 0;
  /** the demo's generator, reseeded at every start as the demo does */
  private random = mulberry(48133);
  private waves!: WaveDirector<V.EnemyType>;
  private readonly plans: V.EnemyType[] = ["chase", "chase", "chase"];
  private active = 0;
  private aiTick = 0;
  private biteFrames = 0;
  private readonly ai = new Autopilot();
  readonly controls: Controls = { forward: 0, reverse: 0, left: 0, right: 0, turretLeft: 0, turretRight: 0, drift: false, fire: false };
  readonly roverArch: Archetype;
  private readonly gunArch: Archetype;
  readonly shotArch: Archetype;
  readonly enemy: Record<V.EnemyType, Archetype>;
  /** archetype id -> enemy type index (0..3), -1 for anything else */
  readonly enemyIndex = new Int8Array(64).fill(-1);
  /** archetype id -> pickup type index (0 repair, 1 ammo, 2 upgrade), -1 else */
  readonly pickupIndex = new Int8Array(64).fill(-1);
  private readonly pickups: Archetype[];
  private readonly spitShots: Archetype[];
  private readonly puffHit: Emitter;
  private readonly puffBlocked: Emitter;
  private readonly puffSpit: Emitter;
  private readonly puffSpitBlocked: Emitter;
  private readonly boom: Emitter;
  private readonly hurt: Sound;
  private readonly waveSound: Sound;
  private readonly lose: Sound;
  private readonly thud: Sound;
  private readonly gunSound: Sound;
  private readonly at3: [number, number, number] = [0, 0, 0];

  constructor() {
    const play = createPlayset({ capacity: 256, particles: 600, seed: 48133 });
    this.play = play;
    // the demo's canvas sky: blue overhead, sand at the horizon
    play.sky(0x76b7d6, 0xe8c178, 0xd69a4c);
    play.fog(0xd8a565, 40, 230, 1);
    // three's physical lights over the playset's gamma-2 shader (the sun at
    // 3.4 / pi, the hemisphere and the ambient light at (2.25 + 0.32) / pi),
    // scaled by 0.72 to the demo's on-screen sand (#d66f23 near the rover)
    play.light({ sun: [-55, 88, -34], sunColor: 0xffe4a3, sunIntensity: 0.78, sky: 0xfff3cf, ground: 0x62402d, ambient: 0.6 });
    play.gravity(24);
    const clamp = WORLD_BOUNDS - 9;
    play.bounds(-clamp, clamp, -clamp, clamp, -50, 80);
    this.buildWorld();

    const puff = (color: number, count: number, blend: "alpha" | "add" = "alpha") =>
      play.emitter({ count, life: 0.42, speed: 7, spread: Math.PI, size: [1.1, 2.6], color: [color, color], alpha: [0.75, 0], blend, drag: 4 });
    this.puffHit = puff(0xffd06a, 9);
    this.puffBlocked = puff(0x262626, 8);
    this.puffSpit = puff(0x9cff65, 8);
    this.puffSpitBlocked = puff(0x6f9f3f, 7);
    this.boom = play.emitter({ count: 50, life: 0.9, speed: 11, spread: Math.PI, size: [1.6, 0.4], color: [0xffd06a, 0xb64832], alpha: [1, 0], blend: "add", drag: 2 });

    // sounds: rendered once, played natively where they happen
    const gunSound = play.sound({ ...sfx.gun(), volume: 0.22 });
    const spitSound = play.sound({ ...sfx.blaster(), freq: 520, to: 160, noise: 0.35, volume: 0.32 });
    const bossSpit = play.sound({ ...sfx.blaster(), freq: 300, to: 80, noise: 0.4, decay: 0.24, volume: 0.42 });
    const dinoHit = play.sound({ ...sfx.hit(), volume: 0.18 });
    const roar = play.sound({ ...sfx.hurt(), freq: 210, to: 55, sustain: 0.06, decay: 0.42, noise: 0.4, volume: 0.5 });
    const bigBoom = play.sound(sfx.bigExplosion());
    this.hurt = play.sound(sfx.hurt());
    this.waveSound = play.sound(sfx.wave());
    this.lose = play.sound(sfx.lose());
    this.thud = play.sound({ ...sfx.thud(), volume: 0.3 });
    const engine = play.sound(sfx.engine());

    this.shotArch = play.archetype({
      model: play.model(V.projectile("player")), motion: motion.linear({ speed: 112 }), layer: L.shot, hits: L.enemy,
      radius: 0.35, damage: 26, lifetime: 3, projectile: true, team: 1, bounds: "kill",
    });
    const spitShot = (damage: number) =>
      play.archetype({
        model: play.model(V.projectile("enemy")), motion: motion.ballistic({ gravity: 0, align: false }), layer: L.eshot, hits: L.player,
        radius: 1.7, damage, lifetime: 3.4, projectile: true, team: 2, bounds: "kill",
      });
    this.spitShots = [spitShot(11), spitShot(17)];

    this.roverArch = play.archetype({
      model: play.model(V.rover()),
      motion: motion.car({ accel: 34, maxSpeed: 30, reverse: 9, brake: 22, steer: 0.44, steerRate: 2.2, grip: 40, drag: 1.18, wheelbase: 5.4, gravity: 0 }),
      layer: L.player, hits: L.pickup, team: 1, radius: PLAYER_RADIUS, height: BODY_HEIGHT, hp: MAX_HEALTH, keepOnDeath: true, flash: 0.12,
      ground: "snap", groundOffset: RIDE_HEIGHT, alignGround: true, bounds: "clamp", shadow: 3.2,
      joints: [joint.script("turret", "y")],
      sounds: { hit: this.hurt, death: bigBoom }, hum: { sound: engine, speed: 30, pitch: 2.2 },
    });
    this.gunArch = play.archetype({ motion: motion.attached(), team: 1, hidden: true, weapons: [this.weapon(0.075, gunSound)] });
    this.gunSound = gunSound;

    this.enemy = {} as Record<V.EnemyType, Archetype>;
    for (const type of ENEMY_TYPES) {
      const s = ENEMY_STATS[type];
      const [near, factor] = NEAR_SPEED[type];
      // a factor above 1 needs headroom in the kernel's top speed
      const top = Math.max(1, factor);
      const shoots = type === "spit" || type === "boss";
      const arch = play.archetype({
        model: play.model(V.dinosaur(type, s.radius)),
        motion: motion.planar({ accel: 80, maxSpeed: s.speed * top, damping: 10, frame: "world", face: "move", turnRate: 10 }),
        brain: brain.seek({ target: { nearest: L.player, every: 0.5 }, speed: 1 / top, near, nearSpeed: factor, fireRange: shoots ? 70 : 0, fireCone: Math.PI }),
        layer: L.enemy, team: 2, radius: s.radius * 0.72 + 1.8, height: BODY_HEIGHT, hp: s.hp, value: s.score,
        ground: "snap", bounds: "clamp", shadow: s.radius * 1.05, flash: 0.12,
        death: play.emitter({ count: type === "boss" ? 40 : 18, life: 0.7, speed: 6, spread: Math.PI, size: [0.9, 0.2], color: [V.ENEMY_COLOR[type] + 0x202020, 0x5a3a22], alpha: [1, 0], blend: "alpha", drag: 2, gravity: 1, radius: s.radius * 0.4 }),
        weapons: shoots
          ? [{ projectile: this.spitShots[type === "boss" ? 1 : 0], cooldown: type === "boss" ? 0.8 : 1.7, speed: type === "boss" ? 42 : 34, muzzle: [0, s.radius * 1.3, 0], aim: "arc", sound: type === "boss" ? bossSpit : spitSound }]
          : [],
        sounds: { hit: dinoHit, death: type === "boss" ? bigBoom : roar },
      });
      this.enemy[type] = arch;
      this.enemyIndex[arch.id] = ENEMY_TYPES.indexOf(type);
    }

    const pickupSounds = [play.sound(sfx.heal()), play.sound(sfx.pickup()), play.sound(sfx.powerup())];
    this.pickups = (["repair", "ammo", "upgrade"] as const).map((type, i) => {
      const arch = play.archetype({
        model: play.model(V.pickup(type)), motion: motion.none(), layer: L.pickup, radius: 1.8, height: BODY_HEIGHT, ground: "snap",
        joints: [joint.spin("spin", "y", 2.5)], sounds: { death: pickupSounds[i] },
        death: play.emitter({ count: 14, life: 0.5, speed: 5, spread: Math.PI, size: [0.5, 0.1], color: [V.pickupColor(type), 0xffffff], alpha: [1, 0], blend: "add", drag: 2 }),
      });
      this.pickupIndex[arch.id] = i;
      return arch;
    });

    // what contacts do: the native step applies these to every pair
    play.rule(L.shot, L.enemy, { damage: "b", kill: "a", event: true });
    play.rule(L.eshot, L.player, { damage: "b", kill: "a", event: true });
    play.rule(L.player, L.pickup, { pickup: true });

    play.on(EVENT.FIRE, () => this.onFire());
    // the shot is gone by now; the victim says which rule it was
    play.on(EVENT.HIT, (_a, b, _rule, x, y, z) => play.burst(b === this.player ? this.puffSpit : this.puffHit, x, y, z));
    // a shot a prop stopped (the native statics report it as GROUND, value -1)
    play.on(EVENT.GROUND, (_slot, _owner, arch, x, y, z, value) => {
      if (value >= 0) return;
      const mine = arch === this.shotArch.id;
      play.burst(mine ? this.puffBlocked : this.puffSpitBlocked, x, y, z);
      if (mine) this.playAt(this.thud, x, y, z, 0.6);
    });
    play.on(EVENT.DEATH, (slot, _killer, arch, x, _y, z, value) => this.onDeath(slot, arch, x, z, value));
    play.on(EVENT.PICKUP, (_a, _b, arch) => this.onPickup(arch));

    this.reset(true);
  }

  private makeWaves(): WaveDirector<V.EnemyType> {
    return new WaveDirector<V.EnemyType>({
      baseWaveSize: 5,
      growthPerWave: 2,
      maxWaveSize: 34,
      maxSpawnsPerStep: 3,
      unlock: [[1, "chase"], [2, "charge"], [3, "spit"], [5, "boss"]],
      weights: { chase: 5, charge: (w) => 1.4 + w * 0.15, spit: (w) => 1 + w * 0.12, boss: (w) => (w % 5 === 0 ? 1 : 0) },
      autoStart: true,
      random: this.random,
    });
  }

  private weapon(cooldown: number, sound: Sound) {
    return { projectile: this.shotArch, cooldown, speed: 112, muzzle: [0, 0, -2.75] as [number, number, number], event: true, sound };
  }

  private buildWorld(): void {
    const play = this.play;
    const world = this.world;
    // the dunes, coloured by height (the demo's low/mid/high thresholds); the
    // demo's material colour multiplies its vertex colours
    const sand = (c: number) => multiply(c, 0xd69a45);
    play.terrain({
      size: WORLD_BOUNDS * 2,
      resolution: 41,
      height: (x, z) => duneHeight(x, -z),
      bands: [[-9, sand(0xb87332)], [-0.7, sand(0xc27f37)], [-0.5, sand(0xd89b43)], [0.65, sand(0xdca34a)], [0.85, sand(0xf0c36b)]],
    });
    const models: Record<string, ReturnType<Playset["model"]>> = {
      mesa: play.model(V.mesa()),
      cactus: play.model(V.cactus()),
      rocks: play.model(V.rocks()),
      cliff: play.model(V.cliff()),
      scrub: play.model(V.scrub()),
      bones: play.model(V.bones()),
    };
    for (const p of world.props) {
      // a mesa scales by its scale, a cliff by its radius
      const scale = p.type === "mesa" ? p.scale : p.type === "cliff" ? p.radius : 1;
      play.place(models[p.type], [p.x, p.y, p.z], { yaw: p.yaw, scale, static: true });
      // the demo keeps actors 0.35 m clear of a prop's disc
      play.colliderCylinder([p.x, p.y, p.z], p.radius + 0.35, 40);
    }
    // the sun disc faces the arena from low in the sky
    const sun = [-135, 92, -205] as const;
    const dx = 0 - sun[0], dy = 18 - sun[1], dz = 0 - sun[2];
    const flat = Math.hypot(dx, dz);
    play.place(play.model(V.sunDisk()), sun, { yaw: Math.atan2(dx, dz), pitch: Math.atan2(-dy, flat), static: false });
  }

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    this.hud.status = demo ? "title" : "playing";
    this.hud.demo = demo;
    this.hud.score = 0;
    this.hud.wave = 1;
    this.hud.health = MAX_HEALTH;
    this.hud.ammo = START_AMMO;
    this.hud.maxAmmo = START_AMMO;
    this.hud.fireRate = 0.075;
    this.active = 0;
    this.gunRelative = 0;
    this.biteFrames = 0;
    this.ai.reset();
    this.random = mulberry(48133);
    this.waves = this.makeWaves();
    this.waves.startWave(1);
    this.say("Wave 1 incoming", 84);
    play.retune(this.gunArch, { weapons: [this.weapon(this.hud.fireRate, this.gunSound)] });
    this.player = play.spawn(this.roverArch, 0, 0, 0, 0);
    this.gun = play.spawn(this.gunArch, 0, GUN_UP, 0, 0);
    play.attach(this.gun, this.player, [0, GUN_UP, 0], 0, false);
    play.followCamera(this.player, { offset: [0, 6.2, 12], lookAhead: 9, lookUp: 1.8, heading: true, smooth: 12.5, smoothLook: 16.7, fov: 62, far: 240 });
  }

  say(text: string, frames: number): void {
    this.message = text;
    this.messageFrames = frames;
  }

  private playAt(s: Sound, x: number, y: number, z: number, volume = 1): void {
    const at = this.at3;
    at[0] = x;
    at[1] = y;
    at[2] = z;
    this.play.play(s, volume, 1, at);
  }

  private onFire(): void {
    if (this.hud.ammo > 0) this.hud.ammo -= 1;
  }

  private onDeath(slot: number, arch: number, x: number, z: number, value: number): void {
    const play = this.play;
    if (slot === this.player) {
      this.hud.status = "gameover";
      this.hud.health = 0;
      play.burst(this.boom, x, play.y(slot) + 1.5, z);
      play.shake(1);
      play.play(this.lose, 0.7);
      this.say(`Final score: ${this.hud.score}`, 1e9);
      return;
    }
    if (this.enemyIndex[arch] >= 0) {
      this.active -= 1;
      if (this.hud.status === "playing" || this.hud.demo) this.hud.score += value;
      if (this.random() < 0.38) this.spawnPickup(x, z);
    }
  }

  private spawnPickup(x: number, z: number): void {
    const roll = this.random();
    const i = roll < 0.42 ? 0 : roll < 0.82 ? 1 : 2;
    this.play.spawn(this.pickups[i], x, 0, z, this.random() * Math.PI * 2);
  }

  private onPickup(arch: number): void {
    const hud = this.hud;
    const play = this.play;
    const i = this.pickupIndex[arch];
    if (i === 0) {
      const o = this.player * 16 + ENT.HP;
      play.ent[o] = Math.min(MAX_HEALTH, play.ent[o] + 28);
      this.say("Repair kit collected", 78);
    } else if (i === 1) {
      hud.ammo = Math.min(hud.maxAmmo, hud.ammo + 65);
      this.say("Ammo restocked", 78);
    } else if (i === 2) {
      hud.maxAmmo += 45;
      hud.ammo = hud.maxAmmo;
      hud.fireRate = Math.max(0.045, hud.fireRate * 0.86);
      play.retune(this.gunArch, { weapons: [this.weapon(hud.fireRate, this.gunSound)] });
      this.say("Weapon upgraded", 78);
    }
  }

  private spawnEnemy(type: V.EnemyType, wave: number): void {
    const play = this.play;
    const s = ENEMY_STATS[type];
    const angle = this.random.uniform(0, Math.PI * 2);
    const dist = this.random.uniform(58, 134);
    const px = play.x(this.player);
    const pf = -play.z(this.player);
    const lim = WORLD_BOUNDS - 12;
    const right = Math.max(-lim, Math.min(lim, px + Math.cos(angle) * dist));
    const forward = Math.max(-lim, Math.min(lim, pf + Math.sin(angle) * dist));
    const slot = play.spawn(this.enemy[type], right, 0, -forward, 0);
    if (slot < 0) return;
    const hp = s.hp + wave * s.hpPerWave;
    play.ent[slot * 16 + ENT.HP] = hp;
    play.ent[slot * 16 + ENT.HP_MAX] = hp;
    this.active += 1;
  }

  /** One frame: controls (pad or autopilot), the wave director, the native step. */
  frame(pad: Pad): void {
    const play = this.play;
    const dt = 1 / 60;
    const ent = play.ent;
    const hud = this.hud;
    const live = hud.status === "playing" || (hud.status === "title" && hud.demo);
    const p = this.player;
    const o = p * 16;
    if (this.messageFrames > 0 && --this.messageFrames === 0) this.message = "";
    if (live) {
      const c = this.controls;
      let fwd: number;
      let turn: number;
      if (hud.demo) {
        if (this.aiTick++ % 3 === 0) this.ai.plan(this, 3 / 60, c);
        fwd = c.forward - c.reverse;
        turn = c.right - c.left;
      } else {
        fwd = pad.y;
        turn = pad.x;
        c.turretLeft = pad.held & BTN_L ? 1 : 0;
        c.turretRight = pad.held & BTN_R ? 1 : 0;
        c.drift = (pad.held & BTN_B) !== 0;
        c.fire = (pad.held & BTN_A) !== 0;
      }
      play.steer(p, 0, fwd, turn);
      // the demo's drift: the body swings against the steer and slides along it
      if (c.drift && turn !== 0) {
        const yaw = ent[o + ENT.YAW] + turn * dt * 0.8;
        ent[o + ENT.YAW] = yaw;
        ent[o] += Math.cos(yaw) * turn * dt * 5.5;
        ent[o + 2] -= Math.sin(yaw) * turn * dt * 5.5;
      }
      // the turret turns relative to the rover; the gun slot fires along it
      let rel = this.gunRelative + (c.turretLeft - c.turretRight) * TURRET_TURN_RATE * dt;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      this.gunRelative = rel;
      play.joints[p * 4] = rel;
      const g = this.gun * 16;
      ent[g + ENT.YAW] = ent[o + ENT.YAW] + rel;
      ent[g + ENT.PITCH] = 0;
      ent[g + ENT.ROLL] = 0;
      play.intent[this.gun * 8 + INTENT.FIRE] = c.fire && hud.ammo > 0 ? 1 : 0;
      const n = this.waves.step(this.active, this.plans);
      for (let i = 0; i < n; i++) this.spawnEnemy(this.plans[i], this.waves.waveNumber);
      if (this.waves.waveNumber !== hud.wave) {
        hud.wave = this.waves.waveNumber;
        play.play(this.waveSound, 0.8);
        this.say(`WAVE ${hud.wave}`, 90);
      }
    } else {
      play.steer(p, 0, 0, 0);
      if (this.gun >= 0) play.intent[this.gun * 8 + INTENT.FIRE] = 0;
    }
    play.frame(dt);
    if (live && hud.status !== "gameover" && (play.tick & 1) === 0) this.bite(2 * dt);
    hud.health = Math.max(0, Math.ceil(ent[o + ENT.HP]));
  }

  /** The demo's contact damage: within (radius + 2.75 + 1.32 r) of a
   *  dinosaur the rover loses its damage per second. */
  private bite(dt: number): void {
    const play = this.play;
    const ent = play.ent;
    const list = play.list;
    const o = this.player * 16;
    const px = ent[o];
    const pz = ent[o + 2];
    const n = play.near(L.enemy, px, pz, 24);
    const index = this.enemyIndex;
    let damage = 0;
    for (let i = 0; i < n; i++) {
      const e = list[i] * 16;
      const t = index[ent[e + ENT.ARCH] - 1];
      if (t < 0) continue;
      const r = RADII[t];
      const reach = r * 2.64 + PLAYER_RADIUS;
      const dx = ent[e] - px;
      const dz = ent[e + 2] - pz;
      if (dx * dx + dz * dz < reach * reach) damage += DAMAGES[t] * dt;
    }
    if (damage <= 0) {
      this.biteFrames = 0;
      return;
    }
    const hp = ent[o + ENT.HP] - damage;
    ent[o + ENT.HP] = hp;
    if (this.biteFrames <= 0) {
      play.playAt(this.hurt, this.player, 0.7);
      play.shake(0.25);
      this.biteFrames = 14;
    } else this.biteFrames -= 1;
    if (hp <= 0) {
      // a guest kill is buried at once, before a step could report it
      play.kill(this.player, "effects");
      this.onDeath(this.player, this.roverArch.id, px, pz, 0);
    }
  }
}

/** a * b per channel (three's material colour times a vertex colour, in gamma-2) */
function multiply(a: number, b: number): number {
  const ch = (s: number) => Math.round((((a >> s) & 255) * ((b >> s) & 255)) / 255);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

const BTN_A = 0x2000;
const BTN_B = 0x4000;
const BTN_L = 0x0100;
const BTN_R = 0x0200;
const RADII = ENEMY_TYPES.map((t) => ENEMY_STATS[t].radius);
const DAMAGES = ENEMY_TYPES.map((t) => ENEMY_STATS[t].damage);

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new DesertShooter();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  let overAt = -1;
  return {
    title: "Desert Shooter",
    tagline: "Survive the dinosaur waves and keep the rover intact.\nRepairs, ammo and gun upgrades drop from the fallen.",
    accent: "#c4562f",
    controls: [
      ["Circle Pad / D-Pad", "Drive"],
      ["L / R", "Turn the turret"],
      ["A  (hold)", "Fire"],
      ["B  (hold)", "Drift"],
      ["START", "Pause"],
    ],
    readouts: [
      { label: "Health", value: () => game.hud.health, bar: () => game.hud.health / MAX_HEALTH, color: "#ff6f6f" },
      { label: "Ammo", value: () => `${game.hud.ammo} / ${game.hud.maxAmmo}`, bar: () => game.hud.ammo / game.hud.maxAmmo, color: "#e6c044" },
      { label: "Wave", value: () => game.hud.wave },
      { label: "Score", value: () => game.hud.score },
      { label: "Fire rate", value: () => `${Math.round(1 / game.hud.fireRate)} / s` },
    ],
    play: game.play,
    status(): GameStatus {
      if (game.hud.status === "title") return "title";
      if (game.hud.status === "gameover") return game.hud.demo ? "title" : "gameover";
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
      // the attract loop restarts itself two seconds after a demo ends
      if (game.hud.demo && game.hud.status === "gameover") {
        if (overAt < 0) overAt = game.play.tick;
        else if (game.play.tick - overAt > 120) {
          overAt = -1;
          game.reset(true);
        }
      }
      if (paused) return;
      game.frame(pad);
    },
    topLine: () => game.message || `SCORE ${game.hud.score}    WAVE ${game.hud.wave}    HEALTH ${game.hud.health}    AMMO ${game.hud.ammo}`,
    result: () => `Score ${game.hud.score} · reached wave ${game.hud.wave}`,
  };
}
