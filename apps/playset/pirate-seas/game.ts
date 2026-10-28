// Pirate Seas' gameplay over the playset kernels, ported from GameBlocks'
// pirate-seas demo (https://gb-pirate-seas.vercel.app/, MIT, xt4d/GameBlocks).
//
// What runs where:
//   native, every step — every hull on the swell (boat kernel: throttle,
//     rudder, roll and pitch from the wave normal), cannonball flight
//     (ballistic, splashing on the water), shell hits on hulls and the
//     damage they deal (rule table), ships pushing apart, pickups riding the
//     waves and their collection, islands and rocks as static colliders and
//     baked scenery, smoke/fire/splash particles, the chase camera, the hull
//     hum that follows the camera target's speed;
//   here, at event rate — broadsides (three shells from the muzzles of one
//     side, spawned with their velocity), sinking, gold, the wanted level,
//     loot and pickup respawns, enemy spawns, island and boundary damage,
//     ship-ship ramming damage, the wind;
//   here, on a budget — each raider's AI (every 3rd step, staggered by
//     slot), the player's reef ring, wind top speed and island bounce (per
//     frame, a few floats), and the autopilot (every 4th step).
//
// Deviations from the demo: cannonballs fly a shallow arc and splash where
// they land (the demo's fly level until their lifetime ends); a sunk ship
// goes down as a sinking hulk (the demo removes a raider at once and leaves
// the player's hull afloat); a raider's loot stops at twelve pickups afloat;
// reef damage repeats at most four times a second; the tactical overhead
// camera and the minimap are gone (the touch screen shows the nearest
// raider's range and side).
//
// Coordinates: the demo's right is +X and its forward -Z; yaw keeps the
// demo's sign (positive turns left).

import {
  ENT,
  EVENT,
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
import { mulberry } from "../kit/random.ts";
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";
import { PirateAutopilot, type PirateControls, type PirateWorld } from "./ai.ts";
import * as V from "./visuals.ts";

const WORLD_LIMIT = 210;
const BIG_ROCK_COUNT = 11;
const ROCK_RING_MIN = 140;
const ROCK_RING_MAX = 205;
const ROCK_RING_CLEARANCE = 46;
const ROCK_ISLAND_CLEARANCE = 22;
const MAIN_ISLAND_COUNT = 3;
const MAIN_ISLAND_RING_MIN = 155;
const MAIN_ISLAND_RING_MAX = 190;
const CANNON_Z = [-2.4, 0, 2.4];
const CANNON_MUZZLE_X = 3.05;
const CANNON_MUZZLE_Y = 1;
const CANNON_COOLDOWN = 0.78;
const PLAYER_CANNON_SPEED = 48;
const ENEMY_CANNON_SPEED = 38;
const PLAYER_CANNON_DAMAGE = 32;
const PLAYER_MAX_SPEED = 20;
const SHIP_CONTACT_DAMAGE_COOLDOWN = 0.72;
const SHIP_CONTACT_DAMAGE_MIN_SPEED = 4.5;
const AI_ROCK_STUCK_GAP = 3.2;
const AI_ROCK_STUCK_SPEED = 4.6;
const AI_ROCK_REVERSE_SECONDS = 0.9;
const INITIAL_PICKUP_COUNT = 5;
const MAX_ACTIVE_PICKUPS = 8;
const PICKUP_RESPAWN_RATE = 0.22;
/** loot from a sunk raider stops at this many pickups afloat (the demo has no cap) */
const MAX_LOOT_AFLOAT = 12;
/** the demo's ship radius against islands, rocks and the reef ring */
const PLAYER_REACH = 11.2;
const ENEMY_REACH = 10;
/** the playset hull radius: a cannonball within 7.45 m of the hull centre hits */
const SHIP_RADIUS = 7;
const BALL_RADIUS = 0.45;
/** shells leave the muzzle this fast upward and fall under 0.35 g */
const BALL_LIFT = 3.2;
const BALL_GRAVITY = 0.35;
/** the hull sits this deep in the swell */
const WATERLINE = -0.5;
const DT = 1 / 60;

export const L = layers("player", "enemy", "pshot", "eshot", "pickup");

export type Status = "title" | "playing" | "gameover";

/** enemy per-slot floats in the USER view */
const U_CONTACT = 0;
const U_FIRE_AT = 1;
const U_MODE = 2;
const U_REVERSE = 3;
const U_AWAY_X = 4;
const U_AWAY_Z = 5;
const U_GOLD = 6;
const U_ISLAND = 7;

export interface Hud {
  status: Status;
  demo: boolean;
  health: number;
  gold: number;
  ammo: number;
  sunk: number;
  wanted: number;
  windDeg: number;
  windAssist: number;
  enemyRange: number;
  enemySide: number;
}

export class PirateSeas {
  readonly play: Playset;
  readonly hud: Hud = { status: "title", demo: true, health: 100, gold: 0, ammo: 40, sunk: 0, wanted: 1, windDeg: 0, windAssist: 0, enemyRange: -1, enemySide: 0 };
  player = -1;
  private readonly random = mulberry(20261029);
  private readonly ai = new PirateAutopilot();
  private readonly controls: PirateControls = { forward: 0, backward: 0, steer: 0, brake: false, firePort: false, fireStarboard: false };
  private readonly world: PirateWorld;
  private aiTick = 0;
  private wave = 1;
  private spawnTimer = 2;
  private activeEnemies = 0;
  private activePickups = 0;
  private coolPort = 0;
  private coolStarboard = 0;
  private reefCooldown = 0;
  private islandCooldown = 0;
  private windPhase = 0;
  private windX = 0;
  private windZ = -1;
  private elapsed = 0;
  private message = "";
  private messageUntil = 0;
  private hudTick = 0;
  private windVoice = 0;
  private live = false;

  private readonly shipArch: Archetype;
  private readonly enemyArch: Archetype;
  private readonly wreckArch: Archetype;
  private readonly playerWreckArch: Archetype;
  private readonly pshot: Archetype;
  private readonly eshot: Archetype;
  private readonly pickups: Record<V.PickupType, Archetype>;
  private readonly pickupKind = new Map<number, number>();
  private readonly shotRule: number;
  private readonly eshotRule: number;
  private readonly shipRule: number;
  private readonly fx: { sparks: Emitter; smoke: Emitter; splinters: Emitter; fire: Emitter; muzzle: Emitter; splash: Emitter };
  private readonly snd: { cannon: Sound; splash: Sound; thud: Sound; alarm: Sound; wave: Sound; lose: Sound; wind: Sound };

  // obstacles: islands then rocks, with the demo's radii
  private readonly obsX = new Float32Array(16);
  private readonly obsZ = new Float32Array(16);
  private readonly obsR = new Float32Array(16);
  private readonly obsRock = new Uint8Array(16);
  private obstacles = 0;
  /** inside this distance from the middle no hull can touch an obstacle */
  private clearRadius = 0;

  constructor() {
    const play = createPlayset({ capacity: 160, particles: 700, seed: 20261029 });
    this.play = play;
    const sky = 0x9fd5df;
    play.sky(0x4ca6d1, sky, sky);
    play.fog(sky, 70, 300, 1);
    play.light({ sun: [-95, 120, -72], sunColor: 0xffe3ad, sunIntensity: 1.6, sky: 0xc6f7ff, ground: 0x324f3c, ambient: 0.75 });
    play.gravity(9.8);
    play.water({ level: 0, amplitude: 0.7, wavelength: 48, speed: 5, size: 460, cells: 32, color: 0x1e8fa3, deep: 0x0a4f68 });

    const materials = V.createMaterials();
    this.buildWorld(materials);

    // effects: GameBlocks' spawnShellHitEffect, spawnExplosion, spawnMuzzleSmoke
    const fx = {
      sparks: play.emitter({ count: 18, life: 0.5, speed: 9, spread: 1.3, dir: [0, 1, 0], gravity: 1.2, drag: 1.5, size: [0.42, 0.1], color: [0xffd36e, 0xff6438], alpha: [0.95, 0], blend: "add" }),
      smoke: play.emitter({ count: 9, life: 1.1, speed: 2.2, spread: 1, dir: [0, 1, 0], drag: 1.5, size: [0.9, 3.2], color: [0x3f4442, 0x6e7473], alpha: [0.58, 0], blend: "alpha", radius: 0.6 }),
      splinters: play.emitter({ count: 10, life: 0.75, speed: 6.5, spread: 1.4, dir: [0, 1, 0], gravity: 1.2, drag: 1, size: [0.45, 0.3], color: [0x6a3f27, 0x3b2117], alpha: [0.86, 0], blend: "alpha" }),
      fire: play.emitter({ count: 16, life: 0.65, speed: 5, spread: Math.PI, gravity: -0.2, drag: 1.5, size: [0.9, 0.3], color: [0xffd166, 0xf3722c], alpha: [0.82, 0], blend: "add", radius: 1.2 }),
      muzzle: play.emitter({ count: 9, life: 0.85, speed: 2.4, spread: 1.1, dir: [0, 1, 0], drag: 1.5, size: [0.6, 1.7], color: [0xb8b1a6, 0xd8d2c8], alpha: [0.42, 0], blend: "alpha", radius: 2.6 }),
      splash: play.emitter({ count: 12, life: 0.8, speed: 7, spread: 0.45, dir: [0, 1, 0], gravity: 1.4, drag: 0.5, size: [0.55, 0.9], color: [0xe6ffff, 0xbfefff], alpha: [0.85, 0], blend: "alpha", radius: 0.5 }),
    };
    this.fx = fx;
    const shellSmoke = play.emitter({ count: 1, life: 0.45, speed: 0.3, spread: Math.PI, drag: 2, size: [0.35, 0.9], color: [0x6e7473, 0x9aa09f], alpha: [0.35, 0], blend: "alpha" });
    const wreckSmoke = play.emitter({ count: 1, life: 1.6, speed: 1.6, spread: 0.5, dir: [0, 1, 0], drag: 1, size: [1.2, 4], color: [0x42312a, 0x6e7473], alpha: [0.6, 0], blend: "alpha", radius: 2 });

    // sounds: rendered once, played natively where they happen
    this.snd = {
      cannon: play.sound(sfx.cannon()),
      splash: play.sound({ ...sfx.splash(), volume: 0.3 }),
      thud: play.sound(sfx.thud()),
      alarm: play.sound({ ...sfx.alarm(), volume: 0.22 }),
      wave: play.sound(sfx.wave()),
      lose: play.sound(sfx.lose()),
      wind: play.sound(sfx.wind()),
    };
    const crack = play.sound({ ...sfx.crumble(), volume: 0.5 });
    const hurt = play.sound(sfx.hurt());
    const timber = play.sound({ ...sfx.thud(), volume: 0.45 });
    const sink = play.sound(sfx.explosion());
    const bigSink = play.sound(sfx.bigExplosion());
    const hull = play.sound(sfx.hull());

    const ball = (enemy: boolean) =>
      play.archetype({
        model: play.model(V.cannonball(materials, enemy)),
        motion: motion.ballistic({ gravity: BALL_GRAVITY, dieOnGround: true }),
        layer: enemy ? L.eshot : L.pshot,
        hits: enemy ? L.player : L.enemy,
        team: enemy ? 2 : 1,
        radius: BALL_RADIUS,
        damage: enemy ? 14 + 2 : PLAYER_CANNON_DAMAGE,
        lifetime: 2.9,
        projectile: true,
        ghost: true,
        death: fx.sparks,
        trail: shellSmoke,
        trailRate: 9,
        sounds: { death: crack },
      });
    this.pshot = ball(false);
    this.eshot = ball(true);

    const boat = (enemy: boolean) =>
      motion.boat({
        accel: enemy ? 9 : 11,
        maxSpeed: enemy ? 15 : PLAYER_MAX_SPEED + 4,
        turnRate: enemy ? 1.25 : 1.45,
        drag: 0.16,
        lateralDrag: 1.4,
        bob: 0.18,
        roll: 0.12,
        pitch: 0.9,
      });
    const shipModel = play.model(V.shipMesh(materials, false));
    this.shipArch = play.archetype({
      model: shipModel,
      motion: boat(false),
      layer: L.player,
      hits: L.pickup | L.enemy,
      team: 1,
      radius: SHIP_RADIUS,
      height: 3,
      hp: 100,
      groundOffset: WATERLINE,
      keepOnDeath: true,
      flash: 0.15,
      sounds: { hit: hurt, death: bigSink },
      hum: { sound: hull, speed: 20, pitch: 1.6 },
    });
    const enemyModel = play.model(V.shipMesh(materials, true));
    this.enemyArch = play.archetype({
      model: enemyModel,
      motion: boat(true),
      layer: L.enemy,
      hits: L.player | L.enemy,
      team: 2,
      radius: SHIP_RADIUS * V.ENEMY_SHIP_SCALE,
      height: 3,
      hp: 95,
      groundOffset: WATERLINE * V.ENEMY_SHIP_SCALE,
      flash: 0.12,
      sounds: { hit: timber, death: sink },
    });
    // sunk hulls go down in place: a dead slot is not drawn, so the hulk is its own slot
    this.wreckArch = play.archetype({ model: enemyModel, motion: motion.none(), lifetime: 6, trail: wreckSmoke, trailRate: 6 });
    this.playerWreckArch = play.archetype({ model: shipModel, motion: motion.none(), lifetime: 12, trail: wreckSmoke, trailRate: 6 });

    this.pickups = {} as Record<V.PickupType, Archetype>;
    const pickupSounds = { treasure: play.sound(sfx.coin()), repair: play.sound(sfx.heal()), ammo: play.sound(sfx.pickup()) };
    const kinds: V.PickupType[] = ["treasure", "repair", "ammo"];
    kinds.forEach((t, k) => {
      const visual = V.pickupMesh(materials, t);
      const scale = t === "treasure" ? 1 : 0.9;
      const arch = play.archetype({
        model: play.model(visual.mesh),
        scale,
        motion: motion.boat({ accel: 0, maxSpeed: 0, bob: 0.12, roll: 0, pitch: 0.6 }),
        layer: L.pickup,
        // the demo's reach is pickup radius + 11.2; the hull brings 7 of it
        radius: visual.radius * scale + PLAYER_REACH - SHIP_RADIUS,
        groundOffset: 0.8,
        death: fx.splash,
        joints: [joint.spin("spin", "y", 1.8)],
        sounds: { death: pickupSounds[t] },
      });
      this.pickups[t] = arch;
      this.pickupKind.set(arch.id, k);
    });

    // what contacts do: the native step applies these to every pair
    this.shotRule = play.rule(L.pshot, L.enemy, { damage: "b", kill: "a", event: true });
    this.eshotRule = play.rule(L.eshot, L.player, { damage: "b", kill: "a", event: true });
    this.shipRule = play.rule(L.player | L.enemy, L.player | L.enemy, { push: true, event: true });
    play.rule(L.player, L.pickup, { pickup: true });

    play.on(EVENT.HIT, (a, b, rule, x, y, z) => this.onHit(a, b, rule, x, y, z));
    play.on(EVENT.DEATH, (slot, _killer, arch, x, y, z) => this.onDeath(slot, arch, x, y, z));
    play.on(EVENT.GROUND, (_slot, _owner, arch, x, y, z) => {
      if (arch === this.pshot.id || arch === this.eshot.id) {
        play.burst(fx.splash, x, y, z);
        play.play(this.snd.splash, 1, 1, [x, y, z]);
      }
    });
    play.on(EVENT.PICKUP, (_a, _b, arch) => this.onPickup(arch));
    // each raider thinks every third step, staggered by slot
    play.script(this.enemyArch, (s) => {
      if ((s + play.tick) % 3 === 0) this.enemyAi(s);
    });

    this.world = {
      px: 0, pz: 0, yaw: 0, speed: 0, hp: 100, maxHp: 100, ammo: 40, coolPort: 0, coolStarboard: 0,
      enemyX: new Float32Array(16), enemyZ: new Float32Array(16), enemySlot: new Float32Array(16), enemies: 0,
      pickX: new Float32Array(24), pickZ: new Float32Array(24), pickKind: new Float32Array(24), pickups: 0,
      obsX: this.obsX, obsZ: this.obsZ, obsR: this.obsR, obsRock: this.obsRock, obstacles: this.obstacles,
    };
    this.windVoice = play.loop(this.snd.wind, 0.2);
    this.reset(true);
  }

  /** buildWorld: three islands on a ring, eleven rocks between them, clouds. */
  private buildWorld(materials: V.Materials): void {
    const play = this.play;
    const r = this.random;
    const angleOffset = r.uniform(-Math.PI, Math.PI);
    for (let i = 0; i < MAIN_ISLAND_COUNT; i++) {
      const angle = angleOffset + (i / MAIN_ISLAND_COUNT) * Math.PI * 2 + r.uniform(-0.08, 0.08);
      const ring = r.uniform(MAIN_ISLAND_RING_MIN, MAIN_ISLAND_RING_MAX);
      const radius = r.uniform(17, 22) * V.ISLAND_SIZE_SCALE;
      const x = Math.cos(angle) * ring;
      const z = -Math.sin(angle) * ring;
      play.place(play.model(V.island(materials, r, radius)), [x, 0, z]);
      this.addObstacle(x, z, radius * 1.1, false);
    }
    const rockModels = [0, 1, 2].map(() => {
      const radius = 1;
      return play.model(V.rock(materials, r, radius), { seed: Math.floor(r() * 1000) });
    });
    for (let i = 0; i < BIG_ROCK_COUNT; i++) {
      const radius = r.uniform(2.8, 4.8);
      const slotAngle = angleOffset + ((i + 0.5) / BIG_ROCK_COUNT) * Math.PI * 2;
      const step = Math.PI / BIG_ROCK_COUNT / 4;
      let x = Math.cos(slotAngle) * ROCK_RING_MAX;
      let z = -Math.sin(slotAngle) * ROCK_RING_MAX;
      for (let attempt = 0; attempt < 28; attempt++) {
        const nudge = attempt === 0 ? 0 : (attempt % 2 === 0 ? -1 : 1) * Math.ceil(attempt / 2) * step;
        const angle = slotAngle + nudge + r.uniform(-0.06, 0.06);
        const ring = r.uniform(ROCK_RING_MIN, ROCK_RING_MAX);
        const cx = Math.cos(angle) * ring;
        const cz = -Math.sin(angle) * ring;
        if (this.rockClear(cx, cz, radius)) {
          x = cx;
          z = cz;
          break;
        }
      }
      play.place(rockModels[i % 3], [x, 0, z], { yaw: r.uniform(-Math.PI, Math.PI), scale: radius });
      this.addObstacle(x, z, radius + 1.5, true);
    }
    for (let i = 0; i < 9; i++) {
      play.place(play.model(V.cloud(materials, r)), [r.uniform(-230, 230), r.uniform(46, 78), r.uniform(-230, 230)]);
    }
  }

  private addObstacle(x: number, z: number, radius: number, rock: boolean): void {
    const i = this.obstacles++;
    this.obsX[i] = x;
    this.obsZ[i] = z;
    this.obsR[i] = radius;
    this.obsRock[i] = rock ? 1 : 0;
    const near = Math.sqrt(x * x + z * z) - radius - PLAYER_REACH - 2;
    this.clearRadius = i === 0 ? near : Math.min(this.clearRadius, near);
    // the native collider holds a playset hull (7 m) where the demo held its own (11.2 m)
    this.play.colliderCylinder([x, 0, z], radius + PLAYER_REACH - SHIP_RADIUS, 8);
  }

  private rockClear(x: number, z: number, radius: number): boolean {
    for (let i = 0; i < this.obstacles; i++) {
      const clearance = this.obsRock[i] ? ROCK_RING_CLEARANCE : ROCK_ISLAND_CLEARANCE;
      const min = radius + 1.5 + this.obsR[i] + clearance;
      const dx = x - this.obsX[i];
      const dz = z - this.obsZ[i];
      if (dx * dx + dz * dz < min * min) return false;
    }
    return true;
  }

  private randomPosition(min: number, max: number): [number, number] {
    const angle = this.random.uniform(-Math.PI, Math.PI);
    const radius = this.random.uniform(min, max);
    return [Math.cos(angle) * radius, -Math.sin(angle) * radius];
  }

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    this.ai.reset();
    this.hud.status = demo ? "title" : "playing";
    this.hud.demo = demo;
    this.hud.gold = 0;
    this.hud.ammo = 40;
    this.hud.health = 100;
    this.hud.sunk = 0;
    this.hud.wanted = 1;
    this.wave = 1;
    this.spawnTimer = 2;
    this.activeEnemies = 0;
    this.activePickups = 0;
    this.coolPort = 0;
    this.coolStarboard = 0;
    this.reefCooldown = 0;
    this.islandCooldown = 0;
    this.elapsed = 0;
    this.message = "";
    this.retuneShots();
    this.player = play.spawn(this.shipArch, 0, 0, 0, 0);
    play.followCamera(this.player, { offset: [0, 16, 30], lookAhead: 18, lookUp: 4.4, heading: true, fov: 55, far: 330, smooth: 7, smoothLook: 10 });
    for (let i = 0; i < 3; i++) {
      const [x, z] = this.randomPosition(80, 150);
      this.spawnEnemy(x, z, this.random.uniform(-Math.PI, Math.PI));
    }
    for (let i = 0; i < INITIAL_PICKUP_COUNT; i++) {
      const [x, z] = this.randomPosition(25, 190);
      this.spawnPickup(this.random() < 0.75 ? "treasure" : "ammo", x, z);
    }
    this.notify("Gold run started. Take the wind and fire broadsides.");
  }

  private retuneShots(): void {
    this.play.retune(this.eshot, { damage: 14 + this.wave * 2 });
  }

  private notify(text: string): void {
    this.message = text;
    this.messageUntil = this.elapsed + 2.6;
  }

  private spawnEnemy(x: number, z: number, yaw: number): void {
    const play = this.play;
    const s = play.spawn(this.enemyArch, x, 0, z, yaw);
    if (s < 0) return;
    const hp = 85 + this.wave * 10;
    play.ent[s * 16 + ENT.HP] = hp;
    play.ent[s * 16 + ENT.HP_MAX] = hp;
    const u = s * 8;
    play.user[u + U_FIRE_AT] = this.random.uniform(0.6, 1.6);
    play.user[u + U_GOLD] = Math.round(180 + this.wave * 30);
    this.activeEnemies += 1;
  }

  private spawnPickup(type: V.PickupType, x: number, z: number): void {
    if (this.play.spawn(this.pickups[type], x, 0, z, this.random.uniform(-Math.PI, Math.PI)) >= 0) this.activePickups += 1;
  }

  /** fireCannons: three shells from one side's muzzles. */
  private broadside(slot: number, side: number, enemy: boolean): void {
    const play = this.play;
    const ent = play.ent;
    const o = slot * 16;
    const yaw = ent[o + ENT.YAW];
    const s = (enemy ? V.ENEMY_SHIP_SCALE : 1) * V.SHIP_SIZE_SCALE;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const x0 = ent[o], y0 = ent[o + 1], z0 = ent[o + 2];
    const arch = enemy ? this.eshot : this.pshot;
    const speed = enemy ? ENEMY_CANNON_SPEED : PLAYER_CANNON_SPEED;
    const out = side * CANNON_MUZZLE_X * s;
    const my = y0 + CANNON_MUZZLE_Y * s;
    for (let i = 0; i < 3; i++) {
      // local -Z is the bow
      const along = -CANNON_Z[i] * s;
      const mx = x0 + rx * out + fx * along;
      const mz = z0 + rz * out + fz * along;
      const jitter = this.random.uniform(-0.08, 0.08);
      let dx = rx * side + fx * jitter;
      let dz = rz * side + fz * jitter;
      const l = 1 / Math.sqrt(dx * dx + dz * dz);
      dx *= l;
      dz *= l;
      const p = play.spawn(arch, mx, my, mz, Math.atan2(-dx, -dz));
      if (p < 0) break;
      const q = p * 16;
      ent[q + 3] = dx * speed;
      ent[q + 4] = BALL_LIFT;
      ent[q + 5] = dz * speed;
    }
    const cx = x0 + rx * out, cz = z0 + rz * out;
    play.burst(this.fx.muzzle, cx + rx * side * 1.2, my, cz + rz * side * 1.2);
    play.play(this.snd.cannon, enemy ? 0.75 : 1, 1, [cx, my, cz]);
  }

  /** damageShip, for damage the guest deals (islands, reefs, rams). */
  private damage(slot: number, amount: number): void {
    const play = this.play;
    if (!play.alive(slot)) return;
    const o = slot * 16;
    const hp = Math.max(0, play.ent[o + ENT.HP] - amount);
    play.ent[o + ENT.HP] = hp;
    play.burst(this.fx.fire, play.ent[o], play.ent[o + 1] + 2, play.ent[o + 2], Math.min(1.4, 0.45 + amount / 35));
    if (hp > 0) return;
    if (slot === this.player) this.playerSunk(play.ent[o], play.ent[o + 1], play.ent[o + 2]);
    else this.enemySunk(slot, play.ent[o], play.ent[o + 1], play.ent[o + 2]);
    play.kill(slot, "effects");
  }

  private onHit(a: number, b: number, rule: number, x: number, y: number, z: number): void {
    const play = this.play;
    if (rule === this.shotRule || rule === this.eshotRule) {
      // spawnShellHitEffect: sparks come from the shell's death emitter
      play.burst(this.fx.splinters, x, y, z);
      play.burst(this.fx.smoke, x, y, z);
      play.burst(this.fx.fire, x, y, z, 0.5);
      if (b === this.player) play.shake(0.35);
      return;
    }
    if (rule !== this.shipRule) return;
    // resolveShipContacts: ramming damage on a closing speed of 4.5 m/s
    const ent = play.ent;
    const user = play.user;
    if (user[a * 8 + U_CONTACT] > 0 || user[b * 8 + U_CONTACT] > 0) return;
    const oa = a * 16, ob = b * 16;
    let nx = ent[oa] - ent[ob];
    let nz = ent[oa + 2] - ent[ob + 2];
    const d = Math.sqrt(nx * nx + nz * nz) || 1;
    nx /= d;
    nz /= d;
    const closing = -((ent[oa + 3] - ent[ob + 3]) * nx + (ent[oa + 5] - ent[ob + 5]) * nz);
    if (closing < SHIP_CONTACT_DAMAGE_MIN_SPEED || !this.live) return;
    user[a * 8 + U_CONTACT] = SHIP_CONTACT_DAMAGE_COOLDOWN;
    user[b * 8 + U_CONTACT] = SHIP_CONTACT_DAMAGE_COOLDOWN;
    // both hulls bounce off
    ent[oa + 3] += nx * closing * 0.6;
    ent[oa + 5] += nz * closing * 0.6;
    ent[ob + 3] -= nx * closing * 0.6;
    ent[ob + 5] -= nz * closing * 0.6;
    play.burst(this.fx.muzzle, x, y + 1, z);
    play.play(this.snd.thud, 1, 0.8, [x, y, z]);
    const dmg = Math.min(16, 4 + closing * 0.85);
    if (a === this.player || b === this.player) this.notify("Ship collision damaged the hull.");
    this.damage(a, dmg);
    this.damage(b, dmg * 0.8);
  }

  private onDeath(slot: number, arch: number, x: number, y: number, z: number): void {
    if (slot === this.player) this.playerSunk(x, y, z);
    else if (arch === this.enemyArch.id) this.enemySunk(slot, x, y, z);
  }

  private playerSunk(x: number, y: number, z: number): void {
    if (this.hud.status === "gameover") return;
    const play = this.play;
    this.hud.status = "gameover";
    this.hud.health = 0;
    play.burst(this.fx.fire, x, y + 1, z, 2.2);
    play.burst(this.fx.smoke, x, y + 1, z, 2);
    play.shake(1);
    if (!this.hud.demo) play.play(this.snd.lose, 0.8);
    // the camera stays on the dead slot and watches the hull go down
    this.hulk(this.playerWreckArch, x, y, z, play.ent[this.player * 16 + ENT.YAW], -1.1);
  }

  /** A sunk hull settling into the sea with a list. */
  private hulk(arch: Archetype, x: number, y: number, z: number, yaw: number, sink: number): void {
    const play = this.play;
    const w = play.spawn(arch, x, y, z, yaw);
    if (w < 0) return;
    const o = w * 16;
    play.ent[o + 4] = sink;
    play.ent[o + ENT.ROLL] = this.random() < 0.5 ? 0.35 : -0.35;
    play.ent[o + ENT.PITCH] = 0.12;
  }

  /** sinkShip for a raider: gold, the wanted level, loot, a sinking hulk. */
  private enemySunk(slot: number, x: number, y: number, z: number): void {
    const play = this.play;
    this.activeEnemies -= 1;
    const gold = play.user[slot * 8 + U_GOLD];
    if (this.live) {
      this.hud.sunk += 1;
      this.hud.gold += gold;
      const wanted = Math.min(5, 1 + Math.floor(this.hud.sunk / 2));
      if (wanted !== this.hud.wanted) play.play(this.snd.wave, 0.7);
      this.hud.wanted = wanted;
      this.notify(`Enemy ship sunk: ${gold} gold.`);
    }
    play.burst(this.fx.fire, x, y + 1, z, 2.2);
    play.burst(this.fx.smoke, x, y + 1, z, 1.5);
    this.hulk(this.wreckArch, x, y, z, play.ent[slot * 16 + ENT.YAW], -2.4);
    for (let i = 0; i < 2 && this.activePickups < MAX_LOOT_AFLOAT; i++) {
      this.spawnPickup(i === 0 ? "repair" : "treasure", x + this.random.uniform(-5, 5), z + this.random.uniform(-5, 5));
    }
  }

  private onPickup(arch: number): void {
    this.activePickups -= 1;
    const kind = this.pickupKind.get(arch);
    const o = this.player * 16 + ENT.HP;
    if (kind === 0) {
      const value = 80 + Math.floor(this.random() * 60);
      this.hud.gold += value;
      this.notify(`Treasure collected: ${value} gold.`);
    } else if (kind === 1) {
      this.play.ent[o] = Math.min(100, this.play.ent[o] + 28);
      this.notify("Repair kit patched the hull.");
    } else {
      this.hud.ammo += 12;
      this.notify("Cannonballs restocked.");
    }
  }

  /** updateEnemy, every third step for each raider. */
  private enemyAi(s: number): void {
    const play = this.play;
    const ent = play.ent;
    const user = play.user;
    const intent = play.intent;
    const o = s * 16, u = s * 8, i8 = s * 8;
    const dt = 3 * DT;
    user[u + U_CONTACT] = Math.max(0, user[u + U_CONTACT] - dt);
    user[u + U_ISLAND] = Math.max(0, user[u + U_ISLAND] - dt);
    if (!this.live) {
      intent[i8 + 1] = 0;
      intent[i8 + 2] = 0;
      return;
    }
    const x = ent[o], z = ent[o + 2];
    const vx = ent[o + 3], vz = ent[o + 5];
    const yaw = ent[o + ENT.YAW];
    const speed = Math.sqrt(vx * vx + vz * vz);
    // islands bounce and damage, rocks only bounce; the reef ring holds
    const obsX = this.obsX, obsZ = this.obsZ, obsR = this.obsR, obsRock = this.obsRock;
    let stuck = false, sax = 0, saz = 0, stuckGap = 1e9;
    const c = Math.sqrt(x * x + z * z);
    const n = c > this.clearRadius ? this.obstacles : 0;
    for (let k = 0; k < n; k++) {
      const ax = x - obsX[k], az = z - obsZ[k];
      const d = Math.sqrt(ax * ax + az * az) || 1e-3;
      const gap = d - (obsR[k] + ENEMY_REACH);
      if (obsRock[k]) {
        if (gap <= AI_ROCK_STUCK_GAP && speed <= AI_ROCK_STUCK_SPEED && gap < stuckGap) {
          stuck = true;
          stuckGap = gap;
          sax = ax / d;
          saz = az / d;
        }
      } else if (gap < 0.6 && user[u + U_ISLAND] <= 0) {
        user[u + U_ISLAND] = SHIP_CONTACT_DAMAGE_COOLDOWN;
        ent[o + 3] = -vx * 0.18;
        ent[o + 5] = -vz * 0.18;
        this.damage(s, 18);
        if (!play.alive(s)) return;
      }
    }
    if (c > WORLD_LIMIT) {
      ent[o] = (x * WORLD_LIMIT) / c;
      ent[o + 2] = (z * WORLD_LIMIT) / c;
      ent[o + 3] = vx * 0.45;
      ent[o + 5] = vz * 0.45;
    }
    let reverse = Math.max(0, user[u + U_REVERSE] - dt);
    if (stuck) {
      if (reverse <= 0) reverse = AI_ROCK_REVERSE_SECONDS;
      user[u + U_AWAY_X] = sax;
      user[u + U_AWAY_Z] = saz;
    }
    user[u + U_REVERSE] = reverse;
    const p = this.player * 16;
    const tx = ent[p] - x, tz = ent[p + 2] - z;
    const distance = Math.sqrt(tx * tx + tz * tz);
    const dirX = distance > 0.01 ? tx / distance : -Math.sin(yaw);
    const dirZ = distance > 0.01 ? tz / distance : -Math.cos(yaw);
    const targetYaw = Math.atan2(-dirX, -dirZ);
    let mode = user[u + U_MODE];
    if (ent[o + ENT.HP] < ent[o + ENT.HP_MAX] * 0.35 && distance < 80) mode = 2;
    else if (distance < 34) mode = 1;
    else if (distance > 110) mode = 0;
    user[u + U_MODE] = mode;
    let err = targetYaw - yaw;
    let forward = 0.8;
    if (mode === 2) {
      err = targetYaw + Math.PI - yaw;
      forward = 1;
    } else if (mode === 1) {
      err = targetYaw + Math.PI * 0.5 * (user[u + U_GOLD] % 2 ? 1 : -1) - yaw;
      forward = 0.68;
    }
    err = Math.atan2(Math.sin(err), Math.cos(err));
    let fwd = forward;
    let brake = distance < 18;
    if (reverse > 0) {
      const back = Math.atan2(user[u + U_AWAY_X], user[u + U_AWAY_Z]) - yaw;
      const e = Math.atan2(Math.sin(back), Math.cos(back));
      const turn = Math.min(1, Math.abs(e) / 0.8);
      err = e > 0.05 ? 0.8 * turn : e < -0.05 ? -0.8 * turn : 0;
      fwd = -0.9;
      brake = false;
    }
    intent[i8 + 1] = fwd;
    intent[i8 + 2] = err > 0.05 ? -Math.min(1, err / 0.8) : err < -0.05 ? Math.min(1, -err / 0.8) : 0;
    if (brake) {
      const k = Math.exp(-2.24 * dt);
      ent[o + 3] *= k;
      ent[o + 5] *= k;
    }
    // fire the side that faces the player
    let fireAt = user[u + U_FIRE_AT] - dt;
    const sideDot = Math.cos(yaw) * dirX - Math.sin(yaw) * dirZ;
    if (distance < 72 && Math.abs(sideDot) > 0.65 && fireAt <= 0 && play.alive(this.player)) {
      this.broadside(s, sideDot > 0 ? 1 : -1, true);
      fireAt = this.random.uniform(1.5, 2.8) / Math.sqrt(this.hud.wanted);
    }
    user[u + U_FIRE_AT] = fireAt;
  }

  /** Feed the autopilot's view of the world (one native query). */
  private observe(): void {
    const play = this.play;
    const ent = play.ent;
    const list = play.list;
    const w = this.world;
    const p = this.player * 16;
    w.px = ent[p];
    w.pz = ent[p + 2];
    w.yaw = ent[p + ENT.YAW];
    w.speed = Math.sqrt(ent[p + 3] * ent[p + 3] + ent[p + 5] * ent[p + 5]);
    w.hp = ent[p + ENT.HP];
    w.ammo = this.hud.ammo;
    w.coolPort = this.coolPort;
    w.coolStarboard = this.coolStarboard;
    const n = play.near(L.enemy | L.pickup, w.px, w.pz, 600);
    const enemy = this.enemyArch.id;
    const kinds = this.pickupKind;
    let e = 0, k = 0;
    for (let i = 0; i < n; i++) {
      const s = list[i];
      const o = s * 16;
      const arch = ent[o + ENT.ARCH] - 1;
      if (arch === enemy) {
        if (e < 16) {
          w.enemyX[e] = ent[o];
          w.enemyZ[e] = ent[o + 2];
          w.enemySlot[e] = s;
          e++;
        }
      } else if (k < 24) {
        w.pickX[k] = ent[o];
        w.pickZ[k] = ent[o + 2];
        w.pickKind[k] = kinds.get(arch) ?? 0;
        k++;
      }
    }
    w.enemies = e;
    w.pickups = k;
    w.obstacles = this.obstacles;
  }

  /** One frame: controls (pad or autopilot), timers, the native step, the
   *  player's reef ring, islands and wind. */
  frame(pad: Pad): void {
    const play = this.play;
    const ent = play.ent;
    const p = this.player * 16;
    this.live = this.hud.status === "playing" || (this.hud.status === "title" && this.hud.demo);
    // updateWater: the wind swings slowly around -0.85 rad
    this.windPhase += DT * 0.08;
    const windYaw = -0.85 + Math.sin(this.windPhase) * 0.45;
    this.windX = -Math.sin(windYaw);
    this.windZ = -Math.cos(windYaw);
    const yaw = ent[p + ENT.YAW];
    const windAssist = Math.max(-0.65, Math.min(1, -Math.sin(yaw) * this.windX - Math.cos(yaw) * this.windZ));
    let brake = false;
    if (this.live) {
      this.elapsed += DT;
      const c = this.controls;
      if (this.hud.demo) {
        if (this.aiTick++ % 4 === 0) {
          this.observe();
          this.ai.decide(this.world, 4 * DT, c);
        }
      } else {
        c.forward = pad.y > 0 ? pad.y : 0;
        c.backward = pad.y < 0 ? -pad.y * 0.55 : 0;
        c.steer = pad.x;
        c.brake = (pad.held & 0x4000) !== 0;
        c.firePort = (pad.held & 0x0100) !== 0;
        c.fireStarboard = (pad.held & 0x0200) !== 0;
      }
      const fwd = c.forward * (0.75 + windAssist * 0.25) - c.backward;
      play.steer(this.player, 0, fwd, c.steer, 0);
      brake = c.brake;
      this.coolPort = Math.max(0, this.coolPort - DT);
      this.coolStarboard = Math.max(0, this.coolStarboard - DT);
      if (c.firePort && this.coolPort <= 0 && this.hud.ammo > 0) {
        this.broadside(this.player, -1, false);
        this.hud.ammo -= 1;
        this.coolPort = CANNON_COOLDOWN;
      }
      if (c.fireStarboard && this.coolStarboard <= 0 && this.hud.ammo > 0) {
        this.broadside(this.player, 1, false);
        this.hud.ammo -= 1;
        this.coolStarboard = CANNON_COOLDOWN;
      }
      // spawnEnemies
      this.spawnTimer -= DT;
      if (this.activeEnemies < Math.min(2 + this.hud.wanted, 6) && this.spawnTimer <= 0) {
        const [x, z] = this.randomPosition(95, WORLD_LIMIT - 20);
        this.spawnEnemy(x, z, this.random.uniform(-Math.PI, Math.PI));
        this.spawnTimer = this.random.uniform(4, 8) / this.hud.wanted;
        this.wave += 0.15;
        this.retuneShots();
        this.notify("Enemy sails spotted.");
        play.play(this.snd.alarm);
      }
      // pickup respawns
      if (this.activePickups < MAX_ACTIVE_PICKUPS && this.random() < DT * PICKUP_RESPAWN_RATE) {
        const r = this.random();
        const [x, z] = this.randomPosition(40, 200);
        this.spawnPickup(r < 0.7 ? "treasure" : this.random() < 0.5 ? "repair" : "ammo", x, z);
      }
    } else {
      play.steer(this.player, 0, 0, 0, 0);
    }
    const u = this.player * 8;
    play.user[u + U_CONTACT] = Math.max(0, play.user[u + U_CONTACT] - DT);
    this.reefCooldown = Math.max(0, this.reefCooldown - DT);
    this.islandCooldown = Math.max(0, this.islandCooldown - DT);

    play.frame(DT);

    // after the step: the player's top speed follows the wind, the brake,
    // the reef ring, island strikes
    if (this.live && play.alive(this.player)) {
      let vx = ent[p + 3], vz = ent[p + 5];
      if (brake) {
        const k = Math.exp(-2.24 * DT);
        vx *= k;
        vz *= k;
      }
      const top = PLAYER_MAX_SPEED + windAssist * 4;
      const v2 = vx * vx + vz * vz;
      if (v2 > top * top) {
        const k = top / Math.sqrt(v2);
        vx *= k;
        vz *= k;
      }
      const x = ent[p], z = ent[p + 2];
      const c = Math.sqrt(x * x + z * z);
      if (c > WORLD_LIMIT) {
        ent[p] = (x * WORLD_LIMIT) / c;
        ent[p + 2] = (z * WORLD_LIMIT) / c;
        vx *= 0.45;
        vz *= 0.45;
        if (this.reefCooldown <= 0) {
          this.reefCooldown = 0.25;
          this.notify("Boundary reefs tore the hull.");
          this.damage(this.player, 4);
        }
      }
      const obsX = this.obsX, obsZ = this.obsZ, obsR = this.obsR, obsRock = this.obsRock;
      const n = c > this.clearRadius ? this.obstacles : 0;
      for (let k = 0; k < n; k++) {
        const ax = x - obsX[k], az = z - obsZ[k];
        const reach = obsR[k] + PLAYER_REACH + 0.6;
        if (ax * ax + az * az < reach * reach && this.islandCooldown <= 0) {
          this.islandCooldown = SHIP_CONTACT_DAMAGE_COOLDOWN;
          vx *= -0.18;
          vz *= -0.18;
          if (!obsRock[k]) {
            this.notify("Impact damage.");
            this.damage(this.player, 18);
          }
        }
      }
      ent[p + 3] = vx;
      ent[p + 5] = vz;
    }
    // readouts at ten a second
    if (this.hudTick++ % 6 === 0) this.sampleHud(windYaw, windAssist);
  }

  private sampleHud(windYaw: number, windAssist: number): void {
    const play = this.play;
    const ent = play.ent;
    const p = this.player * 16;
    this.hud.health = Math.max(0, Math.ceil(ent[p + ENT.HP]));
    this.hud.windAssist = windAssist;
    this.hud.windDeg = Math.round(((windYaw * 180) / Math.PI + 720) % 360);
    const px = ent[p], pz = ent[p + 2], yaw = ent[p + ENT.YAW];
    const n = play.near(L.enemy, px, pz, 600);
    let best = 1e9, bx = 0, bz = 0;
    for (let i = 0; i < n; i++) {
      const o = play.list[i] * 16;
      const dx = ent[o] - px, dz = ent[o + 2] - pz;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bx = dx;
        bz = dz;
      }
    }
    if (best > 1e8) {
      this.hud.enemyRange = -1;
    } else {
      const d = Math.sqrt(best);
      this.hud.enemyRange = Math.round(d);
      // + starboard, - port, 2 ahead, -2 astern
      const side = (Math.cos(yaw) * bx - Math.sin(yaw) * bz) / d;
      const ahead = (-Math.sin(yaw) * bx - Math.cos(yaw) * bz) / d;
      this.hud.enemySide = Math.abs(side) > 0.62 ? Math.sign(side) : ahead > 0 ? 2 : -2;
    }
    if (this.windVoice > 0) play.setLoop(this.windVoice, 0.12 + 0.14 * Math.max(0, windAssist));
  }

  topLine(): string {
    if (this.message && this.elapsed < this.messageUntil) return this.message;
    const h = this.hud;
    return `GOLD ${h.gold}    SHOT ${h.ammo}    HULL ${h.health}    SUNK ${h.sunk}`;
  }
}

const SIDES: Record<number, string> = { 1: "starboard", [-1]: "port", 2: "ahead", [-2]: "astern" };

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new PirateSeas();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  let overAt = -1;
  return {
    title: "Pirate Seas",
    tagline: "Ride the swell and sink raiders with broadsides.\nHaul treasure, repairs and powder home.",
    accent: "#c98a2e",
    controls: [
      ["Circle Pad / D-Pad", "Sail and steer"],
      ["L / R", "Port / starboard cannons"],
      ["B", "Brake"],
      ["START", "Pause"],
      ["SELECT", "Home"],
    ],
    readouts: [
      { label: "Hull", value: () => game.hud.health, bar: () => game.hud.health / 100, color: "#ff6f6f" },
      { label: "Gold", value: () => game.hud.gold },
      { label: "Cannonballs", value: () => game.hud.ammo, bar: () => game.hud.ammo / 40, color: "#c9d4e0" },
      { label: "Ships sunk", value: () => `${game.hud.sunk}   wanted ${game.hud.wanted}/5` },
      {
        label: "Wind",
        value: () => `${game.hud.windAssist > 0.5 ? "tailwind" : game.hud.windAssist < -0.3 ? "headwind" : "crosswind"} ${game.hud.windDeg} deg`,
        bar: () => (game.hud.windAssist + 0.65) / 1.65,
        color: "#4ab0ff",
      },
      { label: "Nearest raider", value: () => (game.hud.enemyRange < 0 ? "-" : `${game.hud.enemyRange} m ${SIDES[game.hud.enemySide] ?? ""}`) },
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
    topLine: () => game.topLine(),
    result: () => `Sank ${game.hud.sunk} ships · ${game.hud.gold} gold`,
  };
}
