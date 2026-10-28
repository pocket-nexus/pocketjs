// Mech Arena's gameplay over the playset kernels, ported from GameBlocks'
// mech-arena demo (https://gb-mech-arena.vercel.app/, MIT, xt4d/GameBlocks).
//
// What runs where:
//   native, every step — the mech (character kernel: walk, jump, gravity),
//     the drones (planar kernel with the strafe brain: close in from afar,
//     circle at mid range, back off when close, switching sides), their
//     fire and aim, the homing missiles, every contact (rules), the pillars
//     as static colliders that stop movers and shots, the camera;
//   here, at event rate — score, credits, ammo (one FIRE event per missile),
//     the missiles' splash (the drones near an impact), the wave director
//     and its automatic upgrade between waves;
//   here, per frame — the mech's intents from the stick (or the autopilot's
//     move target), turning to face the locked drone, ammo regeneration;
//   here, on a budget — the drones' hover bob (a script every 3rd step) and
//     the autopilot (every 20th frame, the demo's own 1/3 s decision rate).
//
// Coordinates: the demo's (right, up, forward) is playset (x, y, -z).
//
// Deviations: the demo is played by clicking the ground and the drones; here
// the Circle Pad moves the mech (screen-relative, the camera is fixed at the
// demo's 45 degrees) and A fires at the nearest drone. The drones aim at an
// invisible point 1.7 m above the mech (the demo's aim point), which rides
// on the mech; their fire interval is the demo's mean ((rate + 0.225) x 2.8)
// without its jitter; hits are spheres; the pillar collider (the demo's
// mover radius) also stops shots, 0.45 m before the demo's body radius.

import {
  ENT,
  EVENT,
  STATE,
  brain,
  createPlayset,
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
import { Autopilot } from "./ai.ts";
import * as V from "./visuals.ts";
import { WaveDirector } from "./waves.ts";

export const WORLD_SIZE = 112;
export const HALF_WORLD = WORLD_SIZE / 2;
const MISSILE_SPEED = 42;
const MISSILE_DAMAGE = 52;
const MISSILE_SPLASH = 3.4;
const FIRE_INTERVAL_MULTIPLIER = 2.8;
export const PLAYER_RADIUS = 1.25;
const START_HEALTH = 150;
const MAX_AMMO = 100;

export const DRONE_TYPES = ["scout", "striker", "bulwark"] as const;
export const DRONES: Record<V.DroneType, { hp: number; speed: number; color: number; damage: number; fireRate: number; radius: number; score: number }> = {
  scout: { hp: 35, speed: 7.2, color: 0xff4f6d, damage: 7, fireRate: 1.15, radius: 1.3, score: 120 },
  striker: { hp: 55, speed: 5.8, color: 0xffb547, damage: 12, fireRate: 0.88, radius: 1.65, score: 190 },
  bulwark: { hp: 115, speed: 3.9, color: 0xb36dff, damage: 17, fireRate: 1.35, radius: 1.95, score: 330 },
};

/** The demo's three rings of pillars, in playset coordinates. */
export const PILLARS = (() => {
  const rings = [
    { count: 20, radius: 42, bodyRadius: 0.9, colliderRadius: 1.35, height: 5.2 },
    { count: 12, radius: 24, bodyRadius: 1.0, colliderRadius: 1.45, height: 5.5 },
    { count: 6, radius: 14, bodyRadius: 0.82, colliderRadius: 1.22, height: 4.8 },
  ];
  const out: { x: number; z: number; bodyRadius: number; radius: number; height: number }[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.count; i++) {
      const angle = (i / ring.count) * Math.PI * 2 + Math.PI / ring.count;
      out.push({ x: Math.cos(angle) * ring.radius, z: -Math.sin(angle) * ring.radius, bodyRadius: ring.bodyRadius, radius: ring.colliderRadius, height: ring.height });
    }
  }
  return out;
})();

export const L = layers("player", "aim", "drone", "missile", "shot");

export type Status = "title" | "playing" | "gameover";

export interface Hud {
  status: Status;
  demo: boolean;
  score: number;
  credits: number;
  wave: number;
  health: number;
  maxHealth: number;
  ammo: number;
  hostiles: number;
  upgradeLevel: number;
  lastUpgrade: string;
}

function darken(color: number, k: number): number {
  return (Math.round(((color >> 16) & 255) * k) << 16) | (Math.round(((color >> 8) & 255) * k) << 8) | Math.round((color & 255) * k);
}

/** the screen's right and up on the ground plane (the camera sits at the demo's -45 degree azimuth) */
const SCREEN_RX = Math.SQRT1_2, SCREEN_RZ = -Math.SQRT1_2;
const SCREEN_UX = -Math.SQRT1_2, SCREEN_UZ = -Math.SQRT1_2;

export class MechArena {
  readonly play: Playset;
  readonly hud: Hud = {
    status: "title", demo: true, score: 0, credits: 0, wave: 1, health: START_HEALTH, maxHealth: START_HEALTH, ammo: MAX_AMMO, hostiles: 0, upgradeLevel: 0, lastUpgrade: "",
  };
  player = -1;
  aim = -1;
  message = "";
  private messageFrames = 0;
  moveSpeed = 12;
  private fireRateScale = 1;
  private damageScale = 1;
  /** the demo's generator, reseeded at every start as the demo does */
  private random = mulberry(20260617);
  private waves!: WaveDirector<V.DroneType>;
  private readonly plans: V.DroneType[] = ["scout", "scout"];
  private waveAwarded = false;
  private aiTick = 0;
  private wasGrounded = true;
  /** the drone the mech locks: its slot, or -1 */
  target = -1;
  /** the autopilot's (or the stick's) wishes, read each frame */
  moveToX = 0;
  moveToZ = 0;
  moving = false;
  firing = false;
  jumping = false;
  readonly ai = new Autopilot();
  readonly playerArch: Archetype;
  private readonly aimArch: Archetype;
  readonly missileArch: Archetype;
  readonly drone: Record<V.DroneType, Archetype>;
  /** archetype id -> drone type index, -1 else */
  readonly droneIndex = new Int8Array(64).fill(-1);
  /** archetype id -> drone shot type index, -1 else */
  readonly shotIndex = new Int8Array(64).fill(-1);
  private readonly shotBursts: Emitter[];
  private readonly impact: Emitter;
  private readonly hitPuff: Emitter;
  private readonly boom: Emitter;
  private readonly impactSound: Sound;
  private readonly jumpSound: Sound;
  private readonly landSound: Sound;
  private readonly waveSound: Sound;
  private readonly upgradeSound: Sound;
  private readonly lose: Sound;
  private readonly missileSound: Sound;
  private readonly at3: [number, number, number] = [0, 0, 0];

  constructor() {
    const play = createPlayset({ capacity: 192, particles: 500, seed: 20260617 });
    this.play = play;
    play.sky(0xc9b27c, 0xc9b27c, 0xc9b27c);
    play.fog(0xc9b27c, 30, 170, 1);
    // three's physical lights over the gamma-2 shader: the sun at 2.5 / pi,
    // the hemisphere at 1.15 / pi with the demo's dim ambient light folded in
    play.light({ sun: [24, 42, 18], sunColor: 0xffe2ab, sunIntensity: 0.85, sky: 0xffdf9f, ground: 0x4d4d62, ambient: 0.5 });
    play.gravity(24);
    const lim = HALF_WORLD - 1.5;
    play.bounds(-lim, lim, -lim, lim, -0.05, 60);
    this.buildArena();

    const puff = (color: number, count: number, size: number, speed = 5) =>
      play.emitter({ count, life: 0.42, speed, spread: Math.PI, size: [size, size * 2.4], color: [color, color], alpha: [0.72, 0], blend: "alpha", drag: 4 });
    this.impact = puff(0x5abdf4, 12, 0.9, 6);
    this.hitPuff = puff(0x5abdf4, 7, 0.6);
    this.boom = play.emitter({ count: 50, life: 0.9, speed: 9, spread: Math.PI, size: [1.2, 0.3], color: [0x9ff3ff, 0x2f6c88], alpha: [1, 0], blend: "add", drag: 2 });

    this.missileSound = play.sound({ ...sfx.missile(), volume: 0.4 });
    this.impactSound = play.sound(sfx.smallExplosion());
    const droneHit = play.sound({ ...sfx.hit(), volume: 0.22 });
    const droneBoom = play.sound(sfx.explosion());
    const shotSplat = play.sound({ ...sfx.thud(), volume: 0.25 });
    const hurt = play.sound(sfx.hurt());
    const bigBoom = play.sound(sfx.bigExplosion());
    this.jumpSound = play.sound(sfx.jump());
    this.landSound = play.sound({ ...sfx.land(), volume: 0.4 });
    this.waveSound = play.sound(sfx.wave());
    this.upgradeSound = play.sound(sfx.powerup());
    this.lose = play.sound(sfx.lose());
    const servo = play.sound({ ...sfx.servo(), volume: 0.16 });

    this.missileArch = play.archetype({
      model: play.model(V.missile()), motion: motion.linear({ speed: MISSILE_SPEED, homing: 5 }), layer: L.missile, hits: L.drone,
      radius: 0.45, damage: MISSILE_DAMAGE, lifetime: 4.5, projectile: true, team: 1, bounds: "kill",
      death: this.impact, sounds: { death: this.impactSound },
    });
    const shots: Archetype[] = [];
    this.shotBursts = [];
    for (const type of DRONE_TYPES) {
      const d = DRONES[type];
      const color = darken(d.color, 0.54);
      const burst = puff(color, 8, 0.6);
      this.shotBursts.push(burst);
      const arch = play.archetype({
        model: play.model(V.shot(color)), motion: motion.ballistic({ gravity: 0, align: false }), layer: L.shot, hits: L.player,
        radius: 0.1, damage: d.damage, lifetime: 2.4, projectile: true, team: 2, bounds: "kill", death: burst, sounds: { death: shotSplat },
      });
      this.shotIndex[arch.id] = shots.length;
      shots.push(arch);
    }

    this.playerArch = play.archetype({
      model: play.model(V.mech()),
      motion: motion.character({ walk: this.moveSpeed, run: 1, accel: 220, airControl: 0.42, jump: 9.5, gravity: 1, turnRate: 16, frame: "world", face: "move" }),
      layer: L.player, team: 1, radius: PLAYER_RADIUS, height: 2.8, hp: START_HEALTH, keepOnDeath: true, flash: 0.25, invulnerable: 0.05,
      ground: "gravity", bounds: "clamp", shadow: 1.9,
      weapons: [this.weapon()],
      sounds: { hit: hurt, death: bigBoom }, hum: { sound: servo, speed: 12, pitch: 1.5 },
    });
    // the point the drones aim at, riding 1.7 m above the mech
    this.aimArch = play.archetype({ motion: motion.attached(), layer: L.aim, team: 1, radius: 0.1, hidden: true });

    this.drone = {} as Record<V.DroneType, Archetype>;
    DRONE_TYPES.forEach((type, i) => {
      const d = DRONES[type];
      const arch = play.archetype({
        model: play.model(V.drone(d.color, d.radius)),
        motion: motion.planar({ accel: d.speed * 3.2, maxSpeed: d.speed, damping: 2.8, frame: "world", face: "target", turnRate: 8 }),
        brain: brain.strafe({ target: { nearest: L.aim, every: 0.5 }, distance: 14.5, every: 1.12, fireRange: 30, fireCone: Math.PI }),
        layer: L.drone, team: 2, radius: d.radius, hp: d.hp, value: d.score, bounds: "clamp", shadow: d.radius * 0.95, flash: 0.12,
        death: play.emitter({ count: 26, life: 0.6, speed: 7, spread: Math.PI, size: [0.8, 0.15], color: [d.color, 0x3a2a1a], alpha: [1, 0], blend: "alpha", drag: 2.5, radius: d.radius * 0.4 }),
        weapons: [{ projectile: shots[i], cooldown: (d.fireRate + 0.225) * FIRE_INTERVAL_MULTIPLIER, speed: 18, muzzle: [0, 0, -1.2], aim: "arc", sound: play.sound({ ...sfx.blaster(), freq: 820 - i * 180, to: 200 - i * 40, volume: 0.24 }) }],
        sounds: { hit: droneHit, death: droneBoom },
      });
      this.drone[type] = arch;
      this.droneIndex[arch.id] = i;
      // the demo's hover: 2.7 m, bobbing with time and its x
      play.script(arch, (s) => this.bob(s), 3, i);
    });

    play.rule(L.missile, L.drone, { damage: "b", kill: "a", event: true });
    play.rule(L.shot, L.player, { damage: "b", kill: "a", event: true });

    play.on(EVENT.FIRE, () => {
      this.hud.ammo -= 10;
    });
    play.on(EVENT.HIT, (_a, b, _rule, x, y, z) => {
      if (b === this.player) {
        play.shake(0.35);
        return;
      }
      play.burst(this.hitPuff, x, y, z);
      this.splash(x, y, z, b);
    });
    // a pillar stopped a shot (the statics report GROUND with value -1)
    play.on(EVENT.GROUND, (_slot, _owner, arch, x, y, z, value) => {
      if (value < 0 && arch === this.missileArch.id) this.splash(x, y, z, -1);
    });
    // the floor or the arena's edge took it
    play.on(EVENT.BOUNDS, (_slot, _b, arch, x, y, z) => {
      if (arch === this.missileArch.id) {
        play.burst(this.impact, x, y, z);
        this.playAt(this.impactSound, x, y, z);
        this.splash(x, y, z, -1);
      } else if (this.shotIndex[arch] >= 0) play.burst(this.shotBursts[this.shotIndex[arch]], x, Math.max(y, 0.1), z);
    });
    play.on(EVENT.DEATH, (slot, _killer, arch, x, y, z, value) => {
      if (slot === this.player) this.onPlayerDeath(x, y, z);
      else if (this.droneIndex[arch] >= 0) this.onDroneDeath(value);
    });

    this.reset(true);
  }

  private makeWaves(): WaveDirector<V.DroneType> {
    return new WaveDirector<V.DroneType>({
      baseWaveSize: 4,
      growthPerWave: 2,
      maxWaveSize: 24,
      maxSpawnsPerStep: 2,
      unlock: [[1, "scout"], [2, "striker"], [4, "bulwark"]],
      weights: { scout: 5, striker: (w) => 1 + w, bulwark: (w) => Math.max(1, w - 3) },
      autoStart: false,
      random: this.random,
    });
  }

  private weapon() {
    return { projectile: this.missileArch, cooldown: 0.55 / this.fireRateScale, speed: MISSILE_SPEED, muzzle: [0, 1.55, -1.55] as [number, number, number], aim: "lead" as const, event: true, sound: this.missileSound };
  }

  private buildArena(): void {
    const play = this.play;
    play.ground({ size: WORLD_SIZE, color: V.COLORS.ground, cell: 7 });
    play.place(play.model(V.walls(WORLD_SIZE)), [0, 0, 0], { static: true });
    const models = new Map<string, ReturnType<Playset["model"]>>();
    for (const p of PILLARS) {
      const key = `${p.bodyRadius}:${p.height}`;
      let m = models.get(key);
      if (!m) models.set(key, (m = play.model(V.pillar(p.bodyRadius, p.height))));
      play.place(m, [p.x, 0, p.z], { static: true });
      play.colliderCylinder([p.x, p.height / 2, p.z], p.radius, p.height / 2);
    }
  }

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    const hud = this.hud;
    hud.status = demo ? "title" : "playing";
    hud.demo = demo;
    hud.score = 0;
    hud.credits = 0;
    hud.wave = 1;
    hud.health = START_HEALTH;
    hud.maxHealth = START_HEALTH;
    hud.ammo = MAX_AMMO;
    hud.hostiles = 0;
    hud.upgradeLevel = 0;
    hud.lastUpgrade = "";
    this.moveSpeed = 12;
    this.fireRateScale = 1;
    this.damageScale = 1;
    this.waveAwarded = false;
    this.target = -1;
    this.moving = this.firing = this.jumping = false;
    this.wasGrounded = true;
    this.ai.reset();
    play.retune(this.playerArch, { weapons: [this.weapon()], motion: this.walk() });
    play.retune(this.missileArch, { damage: MISSILE_DAMAGE });
    this.random = mulberry(20260617);
    this.waves = this.makeWaves();
    this.waves.startWave(1);
    this.say("Wave 1", 90);
    this.player = play.spawn(this.playerArch, 0, 0, -10, 0);
    this.aim = play.spawn(this.aimArch, 0, 1.7, -10, 0);
    play.attach(this.aim, this.player, [0, 1.7, 0], 0, false);
    play.followCamera(this.player, { offset: [12.73, 17, 12.73], lookAhead: 0, lookUp: 0.8, heading: false, smooth: 8.3, smoothLook: 12.5, fov: 62, far: 150 });
  }

  private walk() {
    return motion.character({ walk: this.moveSpeed, run: 1, accel: 220, airControl: 0.42, jump: 9.5, gravity: 1, turnRate: 16, frame: "world", face: "move" });
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

  private bob(s: number): void {
    const ent = this.play.ent;
    const o = s * 16;
    ent[o + 1] = 2.7 + Math.sin(this.play.tick * (2.2 / 60) + ent[o]) * 0.35;
  }

  /** The demo's applyMissileSplash: the drones within 3.4 m of an impact
   *  lose 70% of the missile's damage, falling off with distance. */
  private splash(x: number, y: number, z: number, except: number): void {
    const play = this.play;
    const ent = play.ent;
    const list = play.list;
    const n = play.near(L.drone, x, z, MISSILE_SPLASH);
    const damage = MISSILE_DAMAGE * this.damageScale * 0.7;
    for (let i = 0; i < n; i++) {
      const s = list[i];
      if (s === except || !play.alive(s)) continue;
      const o = s * 16;
      const dx = ent[o] - x, dy = ent[o + 1] - y, dz = ent[o + 2] - z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > MISSILE_SPLASH) continue;
      const hp = ent[o + ENT.HP] - damage * (1 - d / MISSILE_SPLASH);
      ent[o + ENT.HP] = hp;
      play.burst(this.hitPuff, ent[o], ent[o + 1], ent[o + 2]);
      if (hp <= 0) {
        const t = this.droneIndex[ent[o + ENT.ARCH] - 1];
        // a guest kill is buried at once, before a step could report it
        play.kill(s, "effects");
        if (t >= 0) this.onDroneDeath(DRONES[DRONE_TYPES[t]].score);
      }
    }
  }

  private onDroneDeath(score: number): void {
    const hud = this.hud;
    hud.hostiles -= 1;
    if (hud.status === "playing" || hud.demo) {
      hud.score += score;
      hud.credits += 1;
    }
  }

  private onPlayerDeath(x: number, y: number, z: number): void {
    const play = this.play;
    this.hud.status = "gameover";
    this.hud.health = 0;
    play.burst(this.boom, x, y + 2, z);
    play.shake(1);
    play.play(this.lose, 0.7);
    this.say(`Final score: ${this.hud.score}`, 1e9);
  }

  /** The demo's applyAutoUpgradeAndStartNextWave. */
  private upgradeAndStartNextWave(): void {
    const play = this.play;
    const hud = this.hud;
    const o = this.player * 16;
    const ratio = play.ent[o + ENT.HP] / hud.maxHealth;
    const index = ratio < 0.45 ? 0 : hud.upgradeLevel % 3 === 0 ? 2 : hud.upgradeLevel % 3 === 1 ? 1 : 0;
    if (index === 0) {
      hud.maxHealth += 35;
      play.ent[o + ENT.HP] = hud.maxHealth;
      play.ent[o + ENT.HP_MAX] = hud.maxHealth;
      hud.lastUpgrade = "Reinforced Hull";
    } else if (index === 1) {
      this.moveSpeed *= 1.12;
      this.fireRateScale *= 1.12;
      play.retune(this.playerArch, { weapons: [this.weapon()], motion: this.walk() });
      hud.lastUpgrade = "Servo Overdrive";
    } else {
      this.damageScale *= 1.18;
      hud.ammo = MAX_AMMO;
      play.retune(this.missileArch, { damage: MISSILE_DAMAGE * this.damageScale });
      hud.lastUpgrade = "Amplified Weapons";
    }
    hud.upgradeLevel += 1;
    this.waves.startWave(this.waves.waveNumber);
    hud.wave = this.waves.waveNumber;
    play.play(this.upgradeSound, 0.8);
    play.play(this.waveSound, 0.6);
    this.say(`${hud.lastUpgrade} · Wave ${hud.wave}`, 120);
  }

  /** The demo's sampleSpawn: anywhere 20 m from the mech, clear of the pillars. */
  private spawnDrone(type: V.DroneType): void {
    const play = this.play;
    const r = this.random;
    const px = play.x(this.player), pz = play.z(this.player);
    const limit = HALF_WORLD - 8;
    let x = limit * 0.75, z = limit * 0.75;
    for (let i = 0; i < 40; i++) {
      const cx = r.uniform(-limit, limit);
      const cz = -r.uniform(-limit, limit);
      if ((cx - px) ** 2 + (cz - pz) ** 2 < 400) continue;
      let blocked = false;
      for (let k = 0; k < PILLARS.length; k++) {
        const p = PILLARS[k];
        const min = p.radius + 2.1;
        if ((cx - p.x) ** 2 + (cz - p.z) ** 2 < min * min) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      x = cx;
      z = cz;
      break;
    }
    if (play.spawn(this.drone[type], x, 2.5, z, 0) >= 0) this.hud.hostiles += 1;
  }

  /** One frame: the mech's intents, the waves, the native step. */
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
      hud.ammo = Math.min(MAX_AMMO, hud.ammo + 5 * dt);
      let mx = 0, mz = 0;
      if (hud.demo) {
        if (this.aiTick++ % 20 === 0) this.ai.decide(this, 1 / 3);
        if (this.moving) {
          const dx = this.moveToX - ent[o], dz = this.moveToZ - ent[o + 2];
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d > 0.85) {
            mx = dx / d;
            mz = dz / d;
          }
        }
      } else {
        mx = SCREEN_RX * pad.x + SCREEN_UX * pad.y;
        mz = SCREEN_RZ * pad.x + SCREEN_UZ * pad.y;
        const m = Math.sqrt(mx * mx + mz * mz);
        if (m > 1) {
          mx /= m;
          mz /= m;
        }
        this.firing = (pad.held & BTN_A) !== 0;
        this.jumping = (pad.held & BTN_B) !== 0;
        // lock the nearest drone, retargeting a few times a second
        if ((play.tick & 7) === 0 || !play.alive(this.target)) this.target = play.nearest(L.drone, p);
      }
      play.steer(p, mx, -mz);
      const t = this.target;
      const locked = t >= 0 && play.alive(t);
      ent[o + ENT.TARGET] = locked ? t : -1;
      // standing still, the mech turns to the locked drone (the demo's faceTarget)
      if (locked && mx === 0 && mz === 0) {
        const want = Math.atan2(-(ent[t * 16] - ent[o]), -(ent[t * 16 + 2] - ent[o + 2]));
        let d = want - ent[o + ENT.YAW];
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const step = 16 * dt;
        ent[o + ENT.YAW] += d > step ? step : d < -step ? -step : d;
      }
      play.buttons(p, this.firing && locked && hud.ammo >= 10 ? 1 : 0, 0, this.jumping ? 1 : 0);
      const n = this.waves.step(hud.hostiles, this.plans);
      for (let i = 0; i < n; i++) this.spawnDrone(this.plans[i]);
      if (!this.waves.inProgress && hud.hostiles <= 0 && !this.waveAwarded) {
        this.waveAwarded = true;
        this.upgradeAndStartNextWave();
      }
      if (this.waves.inProgress) this.waveAwarded = false;
    } else {
      play.steer(p, 0, 0);
      play.buttons(p, 0);
    }
    const grounded = (ent[o + ENT.STATE] & STATE.GROUNDED) !== 0;
    play.frame(dt);
    const now = (ent[o + ENT.STATE] & STATE.GROUNDED) !== 0;
    if (grounded && !now && ent[o + ENT.VY] > 0) play.playAt(this.jumpSound, p, 0.7);
    if (!this.wasGrounded && now) play.playAt(this.landSound, p);
    this.wasGrounded = now;
    hud.health = Math.max(0, Math.ceil(ent[o + ENT.HP]));
  }
}

/** the readout's short names for the demo's upgrades */
const SHORT: Record<string, string> = { "Reinforced Hull": "Hull", "Servo Overdrive": "Servos", "Amplified Weapons": "Weapons" };

const BTN_A = 0x2000;
const BTN_B = 0x4000;

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new MechArena();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  let overAt = -1;
  return {
    title: "Mech Arena",
    tagline: "Destroy the drone waves and keep the mech online.\nEvery cleared wave upgrades hull, servos or weapons.",
    accent: "#2a9bbf",
    controls: [
      ["Circle Pad / D-Pad", "Move"],
      ["A  (hold)", "Fire missiles"],
      ["B", "Jump"],
      ["START", "Pause"],
      ["SELECT", "Home"],
    ],
    readouts: [
      { label: "Hull", value: () => `${game.hud.health} / ${game.hud.maxHealth}`, bar: () => game.hud.health / game.hud.maxHealth, color: "#7dff68" },
      { label: "Ammo", value: () => `${Math.floor(game.hud.ammo)} / ${MAX_AMMO}`, bar: () => game.hud.ammo / MAX_AMMO, color: "#ffbd68" },
      { label: "Wave", value: () => game.hud.wave },
      { label: "Hostiles", value: () => game.hud.hostiles },
      { label: "Score", value: () => game.hud.score },
      { label: "Upgrades", value: () => (game.hud.upgradeLevel > 0 ? `${SHORT[game.hud.lastUpgrade] ?? ""} · ${game.hud.upgradeLevel}` : "-") },
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
    topLine: () => game.message || `SCORE ${game.hud.score}    WAVE ${game.hud.wave}    HULL ${game.hud.health}    AMMO ${Math.floor(game.hud.ammo)}`,
    result: () => `Score ${game.hud.score} · reached wave ${game.hud.wave}`,
  };
}
