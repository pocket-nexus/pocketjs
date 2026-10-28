// Jet Dogfight's gameplay over the playset kernels, ported from GameBlocks'
// jet-dogfight demo (https://gb-jet-dogfight.vercel.app/, MIT, xt4d/GameBlocks).
//
// What runs where:
//   native, every step — every aircraft (the plane kernel's banked mode:
//     GameBlocks' AirplaneMotionController, bank-to-turn, throttle and boost,
//     the floor over the heightfield), the fighters' steering and gun fire
//     (pursue brain on banked planes: yaw/pitch errors, breakaway inside 700 m,
//     throttle by range, the pitch weave), every gun round and homing missile
//     (linear kernel), every hit (rules), explosions and missile smoke
//     (emitters), the chase camera on the jet's full attitude, the jet hum;
//   here, at event rate — CombatPlay (the player's armour absorbing 45 % of a
//     hit, the heal on a kill), scoring, the WaveSpawnDirector, messages;
//   here, every frame — the pad, the missile lock (0.75 s inside the 0.955 cone
//     within 4.2 km), the floor warning damage;
//   here, on a budget — the fighters' missiles and the 500 m spacing rule
//     (every 2nd frame), the demo autopilot (player-ai.js, every 3rd frame).
//
// Deviations: one unit is 10 m (visuals.ts SCALE); the player's floor is the
// demo's 70 m and also 20 m over the heightfield (the demo's player flies
// through its mountains); fighters fire their gun on a fixed 0.58 s cooldown
// (the demo draws 0.43-0.73 s); gun rounds take 55 % of the shooter's
// cruise speed at launch rather than its speed of the moment; the radar is
// a nearest-bandit readout (distance and bearing) and there is no cockpit
// camera.

import {
  ENT,
  EVENT,
  brain,
  createPlayset,
  layers,
  motion,
  sfx,
  type Archetype,
  type Playset,
  type Sound,
} from "@pocketjs/framework/playset";
import { BTN } from "@pocketjs/framework/input";
import * as V from "./visuals.ts";
import { mulberry } from "../kit/random.ts";
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";

const S = V.SCALE;
const L = layers("player", "enemy", "pshot", "eshot");

/** ENEMY_BALANCE, distances in units */
const E = {
  baseWaveSize: 2,
  growthPerWave: 1.125,
  maxWaveSize: 9,
  maxSpawnsPerStep: 2,
  aceUnlockWave: 3,
  aceWeight: 0.27,
  fighterHealth: 105,
  aceHealth: 123,
  aceRadius: 39 * S,
  minSpeed: 88 * S,
  maxSpeed: 225 * S,
  pitchRate: 1.0,
  bankTurnRate: 0.52,
  fighterAggression: 1.02,
  aceAggression: 1.29,
  spawnMin: 2000 * S,
  spawnMax: 3100 * S,
  gunAimDot: 0.979,
  gunRange: 2625 * S,
  gunSpeed: 1950 * S,
  gunDamage: 5.25,
  missileMinRange: 700 * S,
  missileSpeed: 645 * S,
  missileDamage: 21,
  minPlayerDistance: 500 * S,
  breakaway: 700 * S,
  terrainClearance: 240 * S,
};
const RADIUS = 30 * S;
const PLAYER_MIN_SPEED = 88 * S;
const PLAYER_MAX_SPEED = 260 * S;
const PLAYER_FLOOR = 70 * S;
const PLAYER_CLEARANCE = 20 * S;
const GUN_SPEED = 1650 * S;
const MISSILE_SPEED = 620 * S;
const MISSILE_AMMO = 6;
const LOCK_SECONDS = 0.75;
const LOCK_DOT = 0.955;
const LOCK_RANGE = 4200 * S;
const MAX_HEALTH = 100;
const MAX_ARMOR = 30;
const ARMOR_ABSORPTION = 0.45;

export type Status = "title" | "playing" | "gameover";
export type Lock = "none" | "locking" | "locked";

export interface Hud {
  status: Status;
  demo: boolean;
  score: number;
  wave: number;
  bandits: number;
  health: number;
  armor: number;
  speed: number;
  altitude: number;
  missiles: number;
  lock: Lock;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class JetDogfight {
  readonly play: Playset;
  readonly hud: Hud = { status: "title", demo: true, score: 0, wave: 1, bandits: 0, health: 100, armor: 16, speed: 15, altitude: 52, missiles: MISSILE_AMMO, lock: "none" };
  player = -1;
  private readonly heights: Float32Array;
  private readonly random = mulberry(20260616);
  private readonly playerArch: Archetype;
  private readonly fighter: Archetype;
  private readonly ace: Archetype;
  // CombatPlay for the player
  private armor = 16;
  // the WaveSpawnDirector
  private wave = 1;
  private inProgress = false;
  private toSpawn = 0;
  private spawned = 0;
  private active = 0;
  // the weapon system
  private missileSelected = false;
  private lockTarget = -1;
  private lockTime = 0;
  private missileCooldown = 0;
  private lastLock: Lock = "none";
  // the autopilot's intents and state
  private aiTick = 0;
  private aiTarget = -1;
  private aiDistance = 0;
  private aiTargetDot = 0;
  private aiTurn = 0;
  private aiRise = 0;
  private aiYaw = 0;
  private aiThrottle = 0;
  private aiBoost = 0;
  private aiGun = 0;
  private aiMissile = 0;
  private elapsed = 0;
  private note = "";
  private noteTime = 0;
  private hurtCooldown = 0;
  private overAt = -1;
  private readonly sounds: Record<"missile" | "hurt" | "wave" | "lock" | "locked" | "splash" | "lose", Sound>;

  constructor() {
    const play = createPlayset({ capacity: 192, particles: 600, seed: 20260616, lod: [10, 6, 12] });
    this.play = play;
    play.sky(0x6fb2e6, V.COLORS.sky, V.COLORS.sky);
    // FogExp2(0.00042) is about half at 2.4 km and nearly whole at 4.2 km
    play.fog(V.COLORS.sky, 60, 420, 1);
    play.light({ sun: [1300, 2200, -900], sunColor: 0xfff5d0, sunIntensity: 1.9, sky: 0xbfe8ff, ground: 0x2e4d64, ambient: 0.9 });
    play.gravity(9.8 * S * 10);
    this.heights = V.terrainHeights();
    play.terrain({ size: V.TERRAIN_SIZE, resolution: V.TERRAIN_SAMPLES, height: this.heights, bands: V.TERRAIN_BANDS });
    const puff = play.model(V.cloudPuff());
    const m = new Float32Array(12);
    for (const p of V.cloudPuffs()) {
      m.set([p.rx, 0, 0, p.x, 0, p.ry, 0, p.y, 0, 0, p.rz, p.z]);
      play.native.nodeMatrix(-1, puff.id, m, 1);
    }

    // effects: the demo's HIT_BURST colours, counts and speeds
    const burst = (color: number, count: number, speed: number, life: number, size = 1.4) =>
      play.emitter({ count, life, speed, spread: Math.PI, size: [size, size * 0.25], color: [color, 0x553322], alpha: [1, 0], blend: "add", drag: 1.2 });
    const gunHit = burst(0xffe08a, 12, 5, 0.65, 0.9);
    const missileHit = burst(0xff6b2a, 42, 13, 0.65, 1.8);
    const boom = burst(0xff5a22, 48, 12, 0.9, 2.4);
    this.boom = boom;
    const smoke = play.emitter({ count: 1, life: 0.9, speed: 0.6, spread: Math.PI, size: [0.5, 1.6], color: [0xfff0d0, 0x9aa0a8], alpha: [0.7, 0], blend: "alpha", drag: 0.8 });

    this.sounds = {
      missile: play.sound(sfx.missile()),
      hurt: play.sound({ ...sfx.hurt(), volume: 0.4 }),
      wave: play.sound(sfx.wave()),
      lock: play.sound({ ...sfx.select(), freq: 1320, volume: 0.18 }),
      locked: play.sound({ ...sfx.alarm(), freq: 1760, arp: 1, sustain: 0.18, volume: 0.22 }),
      // the kill's explosion is the fighter's own death sound; this is the score
      splash: play.sound({ ...sfx.coin(), volume: 0.26 }),
      lose: play.sound(sfx.lose()),
    };
    const gunSound = play.sound({ ...sfx.gun(), volume: 0.22 });
    const enemyGun = play.sound({ ...sfx.gun(), freq: 1700, volume: 0.16 });
    const hitTick = play.sound({ ...sfx.hit(), volume: 0.22 });
    const explosion = play.sound(sfx.explosion());
    const jet = play.sound(sfx.jet());

    // the four projectiles: guns are tracers, missiles home at 1.8/s
    const round = (layer: number, hits: number, team: number, damage: number, color: number) =>
      play.archetype({
        model: play.model(V.tracer(color, 6)), motion: motion.linear({ speed: GUN_SPEED }), layer, hits, team,
        radius: RADIUS, damage, lifetime: 1.05, projectile: true, death: gunHit,
      });
    const pRound = round(L.pshot, L.enemy, 1, 10, 0xfff0a0);
    const eRound = round(L.eshot, L.player, 2, E.gunDamage, 0xffb070);
    const missileModel = play.model(V.missile());
    const rocket = (layer: number, hits: number, team: number, damage: number, speed: number) =>
      play.archetype({
        model: missileModel, motion: motion.linear({ speed, homing: 1.8 }), layer, hits, team,
        radius: 55 * S, damage, lifetime: 8, projectile: true, death: missileHit, trail: smoke, trailRate: 30,
        sounds: { death: explosion },
      });
    const pMissile = rocket(L.pshot, L.enemy, 1, 62, MISSILE_SPEED);
    const eMissile = rocket(L.eshot, L.player, 2, E.missileDamage, E.missileSpeed);

    const banked = (o: { min: number; max: number; pitch: number; bank: number; yaw: number; throttle: number; floor: number; floorPitch: number; clearance: number }) =>
      motion.plane({
        minSpeed: o.min, maxSpeed: o.max, pitchRate: o.pitch, yawRate: o.yaw, bankTurn: o.bank, minAltitude: o.clearance, gravity: 0,
        banked: { throttleRate: 0.55, throttle: o.throttle, floor: o.floor, floorPitch: o.floorPitch },
      });
    this.playerArch = play.archetype({
      model: play.model(V.airplane(V.PLAYER_LOOK)),
      motion: banked({ min: PLAYER_MIN_SPEED, max: PLAYER_MAX_SPEED, pitch: 1.35, bank: 0.56, yaw: 0.78, throttle: 0.55, floor: PLAYER_FLOOR, floorPitch: 0.08, clearance: PLAYER_CLEARANCE }),
      layer: L.player, hits: 0, team: 1, radius: RADIUS, hp: MAX_HEALTH, keepOnDeath: true, flash: 0.15, targetable: true,
      death: boom, sounds: { death: play.sound(sfx.bigExplosion()) },
      weapons: [
        { projectile: pRound, cooldown: 0.055, speed: GUN_SPEED + 0.55 * 15, muzzle: [0, -0.12, -1.8], sound: gunSound },
        { projectile: pMissile, cooldown: 0.9, speed: MISSILE_SPEED, muzzle: [0.6, -0.23, -1.2], sound: this.sounds.missile },
      ],
      hum: { sound: jet, speed: PLAYER_MAX_SPEED, pitch: 1.7 },
    });
    const enemy = (look: V.AirplaneLook, hp: number, radius: number, aggression: number) =>
      play.archetype({
        model: play.model(V.airplane(look)),
        motion: banked({ min: E.minSpeed, max: E.maxSpeed, pitch: E.pitchRate, bank: E.bankTurnRate, yaw: 0.85 * 0.42 * aggression, throttle: 0.45, floor: 120 * S, floorPitch: 0.28, clearance: E.terrainClearance }),
        brain: brain.pursue({ target: { nearest: L.player, every: 1 }, fireRange: E.gunRange, fireCone: Math.acos(E.gunAimDot), distance: E.breakaway, throttleDistance: 900 * S }),
        layer: L.enemy, hits: 0, team: 2, radius, hp, value: 100, flash: 0.12,
        death: boom, sounds: { death: explosion, hit: hitTick },
        weapons: [
          { projectile: eRound, cooldown: 0.58, speed: E.gunSpeed + 0.55 * 13.5, muzzle: [0, 0, -1.8], sound: enemyGun },
          { projectile: eMissile, cooldown: 8, speed: E.missileSpeed, muzzle: [0, 0, -2.6] },
        ],
      });
    this.fighter = enemy(V.FIGHTER_LOOK, E.fighterHealth, RADIUS, E.fighterAggression);
    this.ace = enemy(V.ACE_LOOK, E.aceHealth, E.aceRadius, E.aceAggression);

    // the player's rounds damage what they hit; hits on the player go
    // through CombatPlay's armour here
    play.rule(L.pshot, L.enemy, { damage: "b", kill: "a" });
    play.rule(L.eshot, L.player, { kill: "a", event: true });
    play.on(EVENT.HIT, (_a, _b, _rule, _x, _y, _z, damage) => this.hurt(damage));
    play.on(EVENT.DEATH, (slot) => this.onDeath(slot));
    for (const a of [this.fighter, this.ace]) play.script(a, (s) => this.fighterScript(s), 2);
    this.reset(true);
  }
  private readonly boom: { id: number };

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    const hud = this.hud;
    hud.status = demo ? "title" : "playing";
    hud.demo = demo;
    hud.score = 0;
    hud.health = MAX_HEALTH;
    this.armor = 16;
    hud.missiles = MISSILE_AMMO;
    hud.lock = "none";
    this.lastLock = "none";
    this.lockTarget = -1;
    this.lockTime = 0;
    this.missileCooldown = 0;
    this.missileSelected = false;
    this.aiTarget = -1;
    this.elapsed = 0;
    this.active = 0;
    this.wave = 1;
    this.startWave();
    this.overAt = -1;
    this.player = play.spawn(this.playerArch, 0, 520 * S, 0, 0);
    play.ent[this.player * 16 + ENT.SPEED] = 150 * S;
    // PoseFollowCameraRig: 52 m behind and 16 m up in the jet's frame,
    // looking 100 m ahead
    play.followCamera(this.player, { offset: [0, 1.75, 5.95], lookAhead: 10, lookUp: 0.8, attitude: true, fov: 68, near: 0.3, far: 430, smooth: 12, smoothLook: 22 });
    this.say("WAVE 1 INBOUND", 2);
  }

  private say(text: string, seconds = 2): void {
    this.note = text;
    this.noteTime = seconds;
  }

  // --- WaveSpawnDirector ---------------------------------------------------------

  private startWave(): void {
    this.toSpawn = clamp(Math.floor(E.baseWaveSize + (this.wave - 1) * E.growthPerWave), 1, E.maxWaveSize);
    this.spawned = 0;
    this.inProgress = true;
    this.hud.wave = this.wave;
  }

  private waveStep(): void {
    if (this.inProgress && this.spawned >= this.toSpawn && this.active <= 0) {
      this.inProgress = false;
      this.wave += 1;
      this.play.play(this.sounds.wave, 0.8);
      this.say(`WAVE ${this.wave} INBOUND`, 2);
    }
    if (!this.inProgress) this.startWave();
    let guard = E.maxSpawnsPerStep;
    while (this.spawned < this.toSpawn && guard-- > 0) {
      const aceWeight = this.wave >= E.aceUnlockWave ? Math.max(0, this.wave - E.aceUnlockWave + 1) * E.aceWeight : 0;
      const ace = this.random() * (1 + aceWeight) > 1;
      this.spawnEnemy(ace);
      this.spawned += 1;
    }
  }

  private spawnEnemy(ace: boolean): void {
    const play = this.play;
    const r = this.random;
    const o = this.player * 16;
    const angle = r.uniform(0, Math.PI * 2);
    const distance = r.uniform(E.spawnMin, E.spawnMax);
    const x = Math.cos(angle) * distance + play.ent[o];
    const z = -(Math.sin(angle) * distance) + play.ent[o + 2];
    const y = r.uniform(430, 980) * S;
    const s = play.spawn(ace ? this.ace : this.fighter, x, y, z, Math.atan2(-(play.ent[o] - x), -(play.ent[o + 2] - z)));
    if (s < 0) return;
    this.active += 1;
    play.ent[s * 16 + ENT.SPEED] = 135 * S;
    // the missile cooldown, drawn like the demo's
    play.user[s * 8] = r.uniform(6.7, 10);
  }

  // --- combat --------------------------------------------------------------------

  /** CombatPlay.damage for the player: armour takes 45 % until it is gone. */
  private hurt(amount: number): void {
    const play = this.play;
    if (!play.alive(this.player) || amount <= 0) return;
    const armorDamage = Math.min(this.armor, amount * ARMOR_ABSORPTION);
    this.armor -= armorDamage;
    const o = this.player * 16 + ENT.HP;
    play.ent[o] = Math.max(0, play.ent[o] - (amount - armorDamage));
    if (this.hurtCooldown <= 0) {
      this.hurtCooldown = 0.25;
      play.play(this.sounds.hurt, 0.9);
      play.shake(0.35);
    }
    if (play.ent[o] <= 0) {
      play.kill(this.player, "event");
      play.shake(1);
      play.play(this.sounds.lose, 0.9);
      this.say("YOU WERE SHOT DOWN", 4);
      if (!this.hud.demo) this.hud.status = "gameover";
      this.overAt = play.tick;
    }
  }

  private onDeath(slot: number): void {
    if (slot === this.player) return;
    const play = this.play;
    this.active -= 1;
    if (slot === this.lockTarget) this.lockTarget = -1;
    if (slot === this.aiTarget) this.aiTarget = -1;
    if (!play.alive(this.player)) return;
    this.hud.score += 100;
    const o = this.player * 16 + ENT.HP;
    play.ent[o] = Math.min(MAX_HEALTH, play.ent[o] + 10);
    play.play(this.sounds.splash, 0.8);
    this.say("SPLASH ONE", 2);
  }

  /** The fighters' missiles and the 500 m spacing, every 2nd step. */
  private fighterScript(s: number): void {
    const play = this.play;
    const ent = play.ent;
    const o = s * 16;
    const p = this.player * 16;
    if (!play.alive(this.player)) return;
    let dx = ent[o] - ent[p], dy = ent[o + 1] - ent[p + 1], dz = ent[o + 2] - ent[p + 2];
    let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < E.minPlayerDistance) {
      if (d < 1e-4) {
        dx = 0;
        dy = 0;
        dz = 1;
        d = 1;
      }
      const k = E.minPlayerDistance / d;
      ent[o] = ent[p] + dx * k;
      ent[o + 1] = ent[p + 1] + dy * k;
      ent[o + 2] = ent[p + 2] + dz * k;
      d = E.minPlayerDistance;
    }
    const u = s * 8;
    play.user[u] -= 2 / 60;
    if (play.user[u] > 0 || d <= E.missileMinRange || d > E.gunRange) return;
    // the gun's condition: the nose on the player
    const yaw = ent[o + ENT.YAW], pitch = ent[o + ENT.PITCH];
    const cp = Math.cos(pitch);
    const aim = (-Math.sin(yaw) * cp * -dx + Math.sin(pitch) * -dy + -Math.cos(yaw) * cp * -dz) / d;
    if (aim < E.gunAimDot) return;
    play.fire(s, 1);
    play.user[u] = this.random.uniform(8, 12);
  }

  // --- the frame -------------------------------------------------------------------

  frame(pad: Pad): void {
    const play = this.play;
    const dt = 1 / 60;
    const hud = this.hud;
    const live = hud.status === "playing" || (hud.status === "title" && hud.demo);
    const alive = play.alive(this.player);
    const ent = play.ent;
    const p = this.player * 16;
    if (live && alive) {
      this.elapsed += dt;
      this.waveStep();
      let gun = 0, wantMissile = 0;
      if (hud.demo) {
        if (this.aiTick++ % 3 === 0) this.autopilot();
        play.steer(this.player, this.aiYaw, this.aiThrottle, this.aiTurn, this.aiRise);
        gun = this.aiGun;
        wantMissile = this.aiMissile;
        // updatePlayerAiWeaponSelection
        this.missileSelected = this.aiTarget >= 0 && hud.missiles > 0 && this.aiDistance > 850 * S && this.aiDistance < 3900 * S && this.aiTargetDot > 0.935;
        play.buttons(this.player, gun, 0, 0, this.aiBoost);
      } else {
        const held = pad.held;
        const throttle = (held & BTN.RTRIGGER ? 1 : 0) - (held & BTN.LTRIGGER ? 1 : 0);
        play.steer(this.player, 0, throttle, pad.x, pad.y);
        gun = held & BTN.CIRCLE ? 1 : 0;
        wantMissile = held & BTN.CROSS ? 1 : 0;
        if (pad.pressed & BTN.CROSS) this.missileSelected = true;
        if (gun) this.missileSelected = false;
        play.buttons(this.player, gun, 0, 0, held & BTN.TRIANGLE ? 1 : 0);
      }
      this.stepLock(dt);
      this.missileCooldown -= dt;
      if (wantMissile && hud.lock === "locked" && hud.missiles > 0 && this.missileCooldown <= 0 && play.alive(this.lockTarget)) {
        ent[p + ENT.TARGET] = this.lockTarget;
        play.fire(this.player, 1);
        hud.missiles -= 1;
        this.missileCooldown = 0.9;
        this.say("FOX TWO", 1.2);
      }
    } else {
      play.steer(this.player, 0, 0, 0, 0);
      play.buttons(this.player, 0);
    }
    this.hurtCooldown -= dt;
    play.frame(dt);
    if (alive) {
      // the floor warning: 14 per second while held at the floor
      const x = ent[p], y = ent[p + 1], z = ent[p + 2];
      const floor = Math.max(PLAYER_FLOOR, V.sampleHeights(this.heights, x, z) + PLAYER_CLEARANCE);
      if (y <= floor + 0.01 && live) this.hurt(14 * dt);
      hud.altitude = y / S;
      hud.speed = ent[p + ENT.SPEED] / S;
    }
    hud.health = Math.max(0, ent[p + ENT.HP]);
    hud.armor = this.armor;
    hud.bandits = this.active;
    if (this.noteTime > 0) this.noteTime -= dt;
  }

  /** ProjectileWeaponSystem._stepMissileLock, while the missile is selected. */
  private stepLock(dt: number): void {
    const play = this.play;
    const hud = this.hud;
    let state: Lock = "none";
    if (this.missileSelected) {
      const ent = play.ent;
      const p = this.player * 16;
      const yaw = ent[p + ENT.YAW], pitch = ent[p + ENT.PITCH];
      const cp = Math.cos(pitch);
      const fx = -Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp;
      const px = ent[p], py = ent[p + 1], pz = ent[p + 2];
      let best = -1;
      let bestDot = LOCK_DOT;
      const n = play.near(L.enemy, px, pz, LOCK_RANGE);
      const list = play.list;
      for (let i = 0; i < n; i++) {
        const o = list[i] * 16;
        const dx = ent[o] - px, dy = ent[o + 1] - py, dz = ent[o + 2] - pz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d <= 0 || d >= LOCK_RANGE) continue;
        const dot = (fx * dx + fy * dy + fz * dz) / d;
        if (dot <= bestDot) continue;
        best = list[i];
        bestDot = dot;
      }
      if (best < 0) {
        this.lockTarget = -1;
        this.lockTime = 0;
      } else if (best !== this.lockTarget) {
        this.lockTarget = best;
        this.lockTime = 0;
        state = "locking";
      } else {
        this.lockTime += dt;
        state = this.lockTime >= LOCK_SECONDS ? "locked" : "locking";
      }
    } else {
      this.lockTarget = -1;
      this.lockTime = 0;
    }
    hud.lock = state;
    if (state !== this.lastLock) {
      if (state === "locking") play.play(this.sounds.lock, 0.8);
      else if (state === "locked") play.play(this.sounds.locked, 0.8);
      this.lastLock = state;
    }
  }

  // --- the demo's player-ai.js ------------------------------------------------------

  /** computePlayerAiIntent: pick a target, fly at its lead point, fire. */
  private autopilot(): void {
    const play = this.play;
    const ent = play.ent;
    const p = this.player * 16;
    const px = ent[p], py = ent[p + 1], pz = ent[p + 2];
    const yaw = ent[p + ENT.YAW], pitch = ent[p + ENT.PITCH];
    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp;
    // selectPlayerAiTarget: distance against the nose, the current and aces first
    let target = -1;
    let bestScore = Infinity;
    const n = play.near(L.enemy, px, pz, 1e5);
    const list = play.list;
    const ace = this.ace.id + 1;
    for (let i = 0; i < n; i++) {
      const s = list[i];
      const o = s * 16;
      const dx = ent[o] - px, dy = ent[o + 1] - py, dz = ent[o + 2] - pz;
      const d = Math.max(1 * S, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const dot = (fx * dx + fy * dy + fz * dz) / d;
      const score = d - dot * 850 * S + (s === this.aiTarget ? -420 * S : 0) + (ent[o + ENT.ARCH] === ace ? -140 * S : 0);
      if (score >= bestScore) continue;
      target = s;
      bestScore = score;
    }
    this.aiTarget = target;
    let tx: number, ty: number, tz: number;
    if (target < 0) {
      // getPlayerAiPatrolPoint
      const altitude = py / S;
      const want = altitude < 360 ? 760 : altitude > 1300 ? 760 : 620 + Math.sin(this.elapsed * 0.34) * 140;
      tx = px + fx * 950 * S;
      ty = py + fy * 950 * S + (want - altitude) * S;
      tz = pz + fz * 950 * S;
    } else {
      // getPlayerAiLeadPoint
      const o = target * 16;
      const d = Math.sqrt((ent[o] - px) ** 2 + (ent[o + 1] - py) ** 2 + (ent[o + 2] - pz) ** 2);
      const lead = clamp(d / (1450 * S), 0.18, 1.05);
      const ty0 = ent[o + ENT.YAW], tp0 = ent[o + ENT.PITCH], tc = Math.cos(tp0);
      const speed = ent[o + ENT.SPEED] * lead;
      tx = ent[o] - Math.sin(ty0) * tc * speed;
      ty = ent[o + 1] + Math.sin(tp0) * speed;
      tz = ent[o + 2] - Math.cos(ty0) * tc * speed;
    }
    // steerPlayerAiToward
    const dx = tx - px, dy = ty - py, dz = tz - pz;
    const distance = Math.max(1 * S, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const yawError = wrap(Math.atan2(-dx, -dz) - yaw);
    const desiredPitch = Math.asin(clamp(dy / distance, -0.82, 0.82));
    const pitchError = clamp(desiredPitch - pitch, -1.2, 1.2);
    const aimDot = (fx * dx + fy * dy + fz * dz) / distance;
    // intent.yaw turns the heading at 0.78 rad/s; X is the rudder, + right
    this.aiYaw = -clamp(yawError / 0.85, -1, 1) * 0.62;
    this.aiTurn = clamp(-yawError / 0.62, 0, 1) - clamp(yawError / 0.62, 0, 1);
    let up = clamp(pitchError / 0.24, 0, 1);
    let down = clamp(-pitchError / 0.24, 0, 1);
    this.aiThrottle = distance > 1200 * S ? 1 : distance < 420 * S ? -1 : 0.35;
    this.aiBoost = distance > 2200 * S && Math.abs(yawError) < 0.45 && Math.abs(pitchError) < 0.32 ? 1 : 0;
    // altitude over the floor the jet can fly to (the demo: over sea level)
    const ground = Math.max(0, V.sampleHeights(this.heights, px, pz));
    const altitude = (py - ground) / S;
    if (altitude < 170) {
      up = 1;
      down = 0;
      this.aiThrottle = 1;
      this.aiBoost = 1;
    } else if (altitude < 320 && pitchError < 0) {
      up = Math.max(up, 0.65);
      down = 0;
    } else if (altitude > 1550 && pitchError > 0) {
      down = Math.max(down, 0.45);
    }
    this.aiRise = up - down;
    this.aiGun = 0;
    this.aiMissile = 0;
    if (target >= 0) {
      const o = target * 16;
      const ex = ent[o] - px, ey = ent[o + 1] - py, ez = ent[o + 2] - pz;
      const td = Math.max(1 * S, Math.sqrt(ex * ex + ey * ey + ez * ez));
      const targetDot = (fx * ex + fy * ey + fz * ez) / td;
      const missileCandidate = this.hud.missiles > 0 && td > 850 * S && td < 3900 * S && targetDot > 0.935;
      const gunCandidate = td < 2300 * S && aimDot > 0.978;
      this.aiMissile = missileCandidate && this.hud.lock === "locked" ? 1 : 0;
      this.aiGun = gunCandidate && (!missileCandidate || td < 1250 * S) ? 1 : 0;
      if (td < 280 * S && targetDot > 0.2) {
        const breakTurn = Math.sign(yawError || Math.sin(this.elapsed)) || 1;
        this.aiTurn = breakTurn > 0 ? -1 : 1;
        this.aiRise = 1;
        this.aiThrottle = 1;
        this.aiBoost = 1;
        this.aiGun = 0;
      }
      this.aiDistance = td;
      this.aiTargetDot = targetDot;
    }
  }

  get noteText(): string {
    return this.noteTime > 0 ? this.note : "";
  }

  /** HeadingRelativeRadar's nearest contact as text: kilometres and the
   *  bearing off the nose (sampled by the shell, not per frame). */
  nearestContact(): string {
    const play = this.play;
    if (!play.alive(this.player)) return "-";
    const ent = play.ent;
    const p = this.player * 16;
    const n = play.near(L.enemy, ent[p], ent[p + 2], 1e5);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const o = play.list[i] * 16;
      const d = Math.hypot(ent[o] - ent[p], ent[o + 1] - ent[p + 1], ent[o + 2] - ent[p + 2]);
      if (d < bestD) {
        bestD = d;
        best = play.list[i];
      }
    }
    if (best < 0) return "-";
    const o = best * 16;
    const bearing = wrap(Math.atan2(-(ent[o] - ent[p]), -(ent[o + 2] - ent[p + 2])) - ent[p + ENT.YAW]);
    const deg = Math.round((Math.abs(bearing) * 180) / Math.PI);
    return `${(bestD / S / 1000).toFixed(1)} km · ${deg < 8 ? "ahead" : `${deg}° ${bearing > 0 ? "left" : "right"}`}`;
  }

  /** the tick the run ended on, -1 while it runs */
  get endedAt(): number {
    return this.overAt;
  }
}

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new JetDogfight();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  return {
    title: "Jet Dogfight",
    tagline: "Shoot down the waves of enemy fighters.\nLock missiles, work the guns, keep flying.",
    accent: "#2f7fd0",
    controls: [
      ["Circle Pad / D-Pad", "Bank and pitch"],
      ["A / B", "Guns / hold to lock a missile"],
      ["R / L", "Throttle up / down"],
      ["X", "Boost"],
      ["START", "Pause"],
    ],
    readouts: [
      { label: "Hull", value: () => `${Math.round(game.hud.health)} · armour ${Math.round(game.hud.armor)}`, bar: () => game.hud.health / MAX_HEALTH, color: "#ff6f8f" },
      { label: "Speed · altitude", value: () => `${Math.round(game.hud.speed)} m/s · ${Math.max(0, Math.round(game.hud.altitude))} m`, bar: () => game.hud.speed / (PLAYER_MAX_SPEED / S * 1.28), color: "#8bff7a" },
      { label: "Nearest bandit", value: () => game.nearestContact() },
      { label: "Missiles", value: () => `${game.hud.missiles} · ${game.hud.lock === "locked" ? "LOCKED" : game.hud.lock === "locking" ? "locking" : "no lock"}`, bar: () => game.hud.missiles / MISSILE_AMMO, color: "#ffc65a" },
      { label: "Wave", value: () => `${game.hud.wave} · ${game.hud.bandits} bandit${game.hud.bandits === 1 ? "" : "s"}` },
      { label: "Score", value: () => game.hud.score },
    ],
    play: game.play,
    status(): GameStatus {
      if (game.hud.status === "title") return "title";
      if (game.hud.status === "gameover") return "gameover";
      return paused ? "paused" : "playing";
    },
    start(demo: boolean) {
      paused = false;
      game.reset(demo);
    },
    pause(p: boolean) {
      paused = p;
    },
    frame(pad: Pad) {
      // the attract loop flies again three seconds after the demo is shot down
      if (game.hud.demo && game.endedAt >= 0 && game.play.tick - game.endedAt > 180) game.reset(true);
      if (paused) return;
      game.frame(pad);
    },
    topLine: () => {
      const h = game.hud;
      const note = game.noteText;
      return `WAVE ${h.wave}   BANDITS ${h.bandits}   SCORE ${h.score}   HULL ${Math.round(h.health)}   ${note || (h.lock === "locked" ? "LOCKED" : h.lock === "locking" ? "LOCKING" : "")}`;
    },
    result: () => `Score ${game.hud.score} · reached wave ${game.hud.wave}`,
  };
}
