// Castle Defense's gameplay over the playset kernels, ported from GameBlocks'
// castle-defense demo (https://gb-castle-defense.vercel.app/, MIT, xt4d/GameBlocks).
//
// What runs where:
//   native, every step — the attackers' march (linear kernel, headed at
//     their wall or the gate), the bolts and the shells in flight (linear and
//     ballistic kernels), bolt hits (a rule), shells meeting an attacker or
//     the ground (events), the flashes, the fixed camera;
//   here, at event rate — firing (the demo's launch maths: straight bolts,
//     shells on the arc that lands in the demo's travel time), the shells'
//     splash, gold, buying, upgrades, repairs, traps, the wave queue;
//   here, every 2nd frame — attackers reaching the castle, traps springing,
//     the flyers' bob and the banners' sway (a few dozen slots);
//   here, on a budget — the autopilot, every 0.14 s as in the demo.
//
// Coordinates: the demo's (right, up, forward) is playset (x, y, -z); the
// camera sits on the attackers' side looking at the castle, as in the demo.
//
// Deviations: the demo aims with the mouse and fires on a click; here a ring
// on the field follows the Circle Pad and A fires at it (held, it fires as
// the weapon reloads); L and R choose the weapon, X upgrades, B repairs,
// D-Pad Down sets a trap. Bolt hits are spheres of a fixed size (the demo's
// grew with 0.35 of the attacker's radius); the weapon mounts turn their front
// to the shot (the demo's lookAt turned their back to it); the trees outside
// the fixed camera's view are not built.

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
import * as THREE from "@pocketjs/framework/playset/three";
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";
import { mulberry, type Random } from "../kit/random.ts";
import { Autopilot } from "./ai.ts";
import * as V from "./visuals.ts";
import { WaveDirector } from "./waves.ts";

export const WEAPON_ORDER = ["ballista", "cannon", "catapult", "arrows"] as const;
export type WeaponKey = V.WeaponKey;

export const WEAPONS: Record<WeaponKey, { label: string; cost: number; upgradeCost: number; cooldown: number; damage: number; speed: number; range: number; splash: number }> = {
  ballista: { label: "Ballista", cost: 0, upgradeCost: 70, cooldown: 0.55, damage: 32, speed: 82, range: 68, splash: 0 },
  cannon: { label: "Cannon", cost: 120, upgradeCost: 110, cooldown: 1.05, damage: 52, speed: 52, range: 62, splash: 4.6 },
  catapult: { label: "Catapult", cost: 170, upgradeCost: 130, cooldown: 1.55, damage: 76, speed: 37, range: 74, splash: 6.2 },
  arrows: { label: "Arrow Tower", cost: 210, upgradeCost: 160, cooldown: 0.19, damage: 14, speed: 96, range: 56, splash: 0 },
};

/** the mounts at demo (right, up, forward), here in playset axes */
export const WEAPON_MOUNTS: Record<WeaponKey, readonly [number, number, number]> = {
  ballista: [-18, 12.5, 27],
  cannon: [-6, 12.5, 27],
  catapult: [7, 12.5, 27],
  arrows: [19, 12.5, 27],
};

export const ENEMY_TYPES = ["soldier", "shield", "ram", "tower", "flyer", "boss"] as const;
export const ENEMY_STATS: Record<V.EnemyType, { label: string; hp: number; speed: number; damage: number; reward: number; radius: number; attackRange: number; flying?: boolean }> = {
  soldier: { label: "Foot Soldier", hp: 54, speed: 7.3, damage: 6, reward: 18, radius: 1.2, attackRange: 1.8 },
  shield: { label: "Shield Bearer", hp: 92, speed: 5.5, damage: 8, reward: 28, radius: 1.35, attackRange: 1.9 },
  ram: { label: "Ram", hp: 165, speed: 3.9, damage: 20, reward: 48, radius: 2.1, attackRange: 2.9 },
  tower: { label: "Siege Tower", hp: 250, speed: 3.0, damage: 26, reward: 70, radius: 2.5, attackRange: 3.4 },
  flyer: { label: "Flying Enemy", hp: 74, speed: 9.1, damage: 10, reward: 40, radius: 1.4, attackRange: 2.4, flying: true },
  boss: { label: "Boss", hp: 640, speed: 2.55, damage: 42, reward: 190, radius: 3.7, attackRange: 4.6 },
};

/** wallLeft, wallRight, gate */
export const CASTLE_TARGETS: readonly (readonly [number, number, number])[] = [
  [-16, 3, 31.8],
  [16, 3, 31.8],
  [0, 2, 31.1],
];

const TRAP_COST = 65;
const REPAIR_COST = 80;
const GRAVITY = 28;
const WAVE_LIMIT = 10;
const CAMERA_EYE = [0, 42, -70] as const;
const CAMERA_LOOK = [0, 5, 18] as const;
const CAMERA_FOV = 48;

export const L = layers("enemy", "bolt", "shell");

export type Mode = "title" | "playing" | "victory" | "defeat";

export interface Hud {
  mode: Mode;
  demo: boolean;
  gold: number;
  castleHp: number;
  castleMaxHp: number;
  wave: number;
  selected: WeaponKey;
  levels: Record<WeaponKey, number>;
  cooldowns: Record<WeaponKey, number>;
  traps: number;
}

export function weaponPower(levels: Record<WeaponKey, number>, key: WeaponKey) {
  const level = levels[key];
  const base = WEAPONS[key];
  return {
    damage: base.damage * (1 + (level - 1) * 0.38),
    cooldown: Math.max(base.cooldown * (1 - (level - 1) * 0.09), 0.16),
    speed: base.speed,
    splash: base.splash * (1 + (level - 1) * 0.16),
    range: base.range,
  };
}

export function upgradeCost(levels: Record<WeaponKey, number>, key: WeaponKey): number {
  return Math.floor(WEAPONS[key].upgradeCost * Math.pow(1.55, levels[key] - 1));
}

interface Trap {
  slot: number;
  x: number;
  z: number;
}

export class CastleDefense {
  readonly play: Playset;
  readonly hud: Hud = {
    mode: "title",
    demo: true,
    gold: 150,
    castleHp: 100,
    castleMaxHp: 100,
    wave: 1,
    selected: "ballista",
    levels: { ballista: 1, cannon: 0, catapult: 0, arrows: 0 },
    cooldowns: { ballista: 0, cannon: 0, catapult: 0, arrows: 0 },
    traps: 0,
  };
  message = "";
  private messageFrames = 0;
  /** the game's seeded generator (lanes, spawns, traps, the wave mix) */
  random: Random = mulberry(20260617);
  private waves!: WaveDirector<V.EnemyType>;
  private readonly queue: V.EnemyType[] = [];
  private queueAt = 0;
  private spawnTimer = 0;
  private time = 0;
  /** attackers alive on the field */
  alive = 0;
  readonly traps: Trap[] = [];
  /** the aiming ring on the field */
  reticle = -1;
  reticleX = 0;
  reticleZ = -10;
  private aiTimer = 0;
  private readonly ai = new Autopilot();
  readonly enemy: Record<V.EnemyType, Archetype>;
  /** archetype id -> enemy type index, -1 else */
  readonly enemyIndex = new Int8Array(64).fill(-1);
  private readonly bolts: Record<"ballista" | "arrows", Archetype>;
  private readonly shells: Record<"cannon" | "catapult", Archetype>;
  private readonly shellIds = new Int8Array(64).fill(-1);
  private readonly mountArch: Record<WeaponKey, Archetype>;
  readonly mounts: Record<WeaponKey, number> = { ballista: -1, cannon: -1, catapult: -1, arrows: -1 };
  private readonly trapArch: Archetype;
  private readonly reticleArch: Archetype;
  private readonly bannerArch: Archetype;
  private readonly banners: number[] = [];
  private readonly splashBurst: Emitter[];
  private readonly trapBurst: Emitter;
  private readonly gateBurst: Emitter;
  private readonly muzzle: Record<WeaponKey, Emitter>;
  private readonly fireSound: Record<WeaponKey, Sound>;
  private readonly boomSound: Sound;
  private readonly trapSound: Sound;
  private readonly wallSound: Sound;
  private readonly coin: Sound;
  private readonly upgrade: Sound;
  private readonly repair: Sound;
  private readonly denied: Sound;
  private readonly placeSound: Sound;
  private readonly waveSound: Sound;
  private readonly win: Sound;
  private readonly lose: Sound;
  private readonly select: Sound;
  private readonly at3: [number, number, number] = [0, 0, 0];

  constructor() {
    const play = createPlayset({ capacity: 192, particles: 600, seed: 20260617 });
    this.play = play;
    // the demo's dome writes its colours unencoded, so on screen its sky is
    // the deeper blue of #639dcf above the castle; the camera looks down, so
    // that sky lies below the horizon line of the playset's gradient
    play.sky(0x4a8fd0, 0x639dcf, 0x4c7a99);
    play.fog(0xb2d4dc, 84, 190, 1);
    play.light({ sun: [-28, 58, -34], sunColor: 0xfff0c4, sunIntensity: 0.95, sky: 0xdaf0ff, ground: 0x52633c, ambient: 0.62 });
    play.gravity(GRAVITY);
    // the bolts end where they would sink into the field
    play.bounds(-140, 140, -120, 120, -0.5, 200);
    this.buildWorld();

    const burst = (color: number, count: number, size: number, speed: number, life = 0.68) =>
      play.emitter({ count, life, speed, spread: Math.PI * 0.6, dir: [0, 1, 0], size: [size, size * 0.3], color: [color, color], alpha: [1, 0.1], blend: "alpha", drag: 1.5, gravity: 0.32 });
    this.splashBurst = [burst(0xff8c3a, 24, 0.75, 7), burst(0xff8c3a, 32, 0.9, 9)];
    this.trapBurst = burst(0xffbd52, 22, 0.8, 8);
    this.gateBurst = burst(0xffd08a, 9, 0.5, 4);
    const flash = (color: number, size: number) => play.emitter({ count: 6, life: 0.22, speed: 3, spread: Math.PI, size: [size, size * 2], color: [color, color], alpha: [0.82, 0], blend: "add", drag: 3 });
    this.muzzle = { ballista: flash(0xffd987, 0.6), arrows: flash(0xffd987, 0.5), cannon: flash(0xff8c3a, 0.8), catapult: flash(0xff8c3a, 1.0) };

    this.fireSound = {
      ballista: play.sound({ ...sfx.bow(), volume: 0.4 }),
      arrows: play.sound({ ...sfx.bow(), freq: 620, to: 260, volume: 0.22 }),
      cannon: play.sound({ ...sfx.cannon(), volume: 0.5 }),
      catapult: play.sound({ ...sfx.whoosh(), freq: 200, to: 900, decay: 0.2, volume: 0.42 }),
    };
    this.boomSound = play.sound(sfx.explosion());
    this.trapSound = play.sound({ ...sfx.smallExplosion(), volume: 0.55 });
    this.wallSound = play.sound({ ...sfx.crumble(), volume: 0.5 });
    this.coin = play.sound(sfx.coin());
    this.upgrade = play.sound(sfx.powerup());
    this.repair = play.sound(sfx.heal());
    this.denied = play.sound({ ...sfx.select(), freq: 220, volume: 0.25 });
    this.placeSound = play.sound(sfx.place());
    this.waveSound = play.sound(sfx.wave());
    this.win = play.sound(sfx.win());
    this.lose = play.sound(sfx.lose());
    this.select = play.sound(sfx.select());
    const hitSound = play.sound({ ...sfx.hit(), volume: 0.25 });
    const deathSound = play.sound({ ...sfx.hurt(), freq: 300, to: 90, volume: 0.32 });

    const boltHit = (color: number) => play.emitter({ count: 8, life: 0.5, speed: 5, spread: Math.PI * 0.7, dir: [0, 1, 0], size: [0.35, 0.1], color: [color, color], alpha: [1, 0], blend: "alpha", drag: 1.5, gravity: 0.32 });
    this.bolts = {
      ballista: play.archetype({
        model: play.model(V.bolt("ballista")), motion: motion.linear({ speed: 82 }), layer: L.bolt, hits: L.enemy, radius: 1.1,
        damage: WEAPONS.ballista.damage, lifetime: 2.1, projectile: true, team: 1, bounds: "kill", death: boltHit(0xffd38a),
      }),
      arrows: play.archetype({
        model: play.model(V.bolt("arrows")), motion: motion.linear({ speed: 96 }), layer: L.bolt, hits: L.enemy, radius: 0.55,
        damage: WEAPONS.arrows.damage, lifetime: 2.1, projectile: true, team: 1, bounds: "kill", death: boltHit(0xff7c45),
      }),
    };
    const shell = (kind: "cannon" | "catapult") => {
      const m = play.model(V.shell(kind));
      return play.archetype({
        model: m, motion: motion.ballistic({ gravity: 1, align: false }), layer: L.shell, hits: L.enemy, radius: 1.2,
        lifetime: 3.2, expireEvent: true, projectile: true, team: 1, bounds: "kill", joints: [joint.spin("spin", "x", 8)],
      });
    };
    this.shells = { cannon: shell("cannon"), catapult: shell("catapult") };
    this.shellIds[this.shells.cannon.id] = 0;
    this.shellIds[this.shells.catapult.id] = 1;

    this.enemy = {} as Record<V.EnemyType, Archetype>;
    ENEMY_TYPES.forEach((type, i) => {
      const s = ENEMY_STATS[type];
      const arch = play.archetype({
        model: play.model(V.enemy(type, s)), motion: motion.linear({ speed: s.speed }), layer: L.enemy, team: 2, radius: s.radius,
        hp: s.hp, value: s.reward, flash: 0.12, shadow: s.flying ? 0 : s.radius * 1.2,
        death: play.emitter({ count: 16, life: 0.68, speed: 6, spread: Math.PI * 0.6, dir: [0, 1, 0], size: [0.4, 0.12], color: [0xffd475, 0xffd475], alpha: [1, 0], blend: "alpha", drag: 1, gravity: 0.32, radius: s.radius * 0.5 }),
        sounds: { hit: hitSound, death: deathSound },
      });
      this.enemy[type] = arch;
      this.enemyIndex[arch.id] = i;
    });

    this.mountArch = {} as Record<WeaponKey, Archetype>;
    for (const key of WEAPON_ORDER) this.mountArch[key] = play.archetype({ model: play.model(V.mount(key)), motion: motion.none() });
    this.trapArch = play.archetype({ model: play.model(V.trap()), motion: motion.none() });
    this.reticleArch = play.archetype({ model: play.model(V.reticle()), motion: motion.none() });
    const bannerModel = play.model(V.banner());
    this.bannerArch = play.archetype({ model: bannerModel, motion: motion.none(), joints: [joint.script("flag", "y")] });

    play.rule(L.bolt, L.enemy, { damage: "b", kill: "a" });
    play.rule(L.shell, L.enemy, { kill: "a", event: true });
    play.on(EVENT.HIT, (a, b, _rule, x, y, z) => this.explode(a, x, y, z, b));
    play.on(EVENT.GROUND, (a, _owner, arch, x, y, z) => {
      if (this.shellIds[arch] >= 0) this.explode(a, x, Math.max(y, 0.2), z, -1);
    });
    play.on(EVENT.EXPIRE, (a, _b, arch, x, y, z) => {
      if (this.shellIds[arch] >= 0) this.explode(a, x, y, z, -1);
    });
    play.on(EVENT.DEATH, (_slot, _killer, arch, _x, _y, _z, value) => {
      if (this.enemyIndex[arch] < 0) return;
      this.hud.gold += value;
      this.alive -= 1;
    });
    this.reset(true);
  }

  private buildWorld(): void {
    const play = this.play;
    // the trees the fixed camera can see; the ones deep in the fog lighter
    const cam = cullFrustum(CAMERA_EYE, CAMERA_LOOK, CAMERA_FOV, 400 / 240, 196);
    const s = V.scenery((x, z, scale) => {
      if (!cam(x, 4 * scale, z, 5.5 * scale)) return 0;
      const dx = x - CAMERA_EYE[0], dy = 4 * scale - CAMERA_EYE[1], dz = z - CAMERA_EYE[2];
      return dx * dx + dy * dy + dz * dz > 130 * 130 ? 2 : 1;
    });
    play.place(play.model(s.ground), [0, 0, 0], { static: true });
    play.place(play.model(s.castle), [0, 0, 0], { static: true });
    play.place(play.model(s.mountains), [0, 0, 0], { static: true });
    play.place(play.model(s.torches), [0, 0, 0], { static: true });
    const flame = play.model(V.flame());
    for (const f of s.flames) play.place(flame, [f.x, f.y, f.z], { static: false });
    this.bannerSpots = s.banners;
    // the trees, merged into forests of 3,000 vertices or more: a model that
    // small is stored once, not copied for instancing, and the fixed camera
    // sees every one of these trees, so cells would cull nothing
    let forest = new THREE.Group();
    let inForest = 0;
    let fx = 0, fz = 0;
    const flush = () => {
      if (inForest === 0) return;
      // the forest's node sits at its trees' centre, which picks its cell
      const cx = fx / inForest, cz = fz / inForest;
      for (const child of forest.children) {
        child.position.x -= cx;
        child.position.z -= cz;
      }
      play.place(play.model(forest), [cx, 0, cz], { static: true });
      forest = new THREE.Group();
      inForest = 0;
      fx = fz = 0;
    };
    const trees = s.trees;
    for (const t of trees) {
      if (inForest >= 60) flush();
      t.model.position.set(t.x, 0, t.z);
      forest.add(t.model);
      inForest++;
      fx += t.x;
      fz += t.z;
    }
    flush();
    this.treeCount = trees.length;
  }

  treeCount = 0;
  private bannerSpots: { x: number; y: number; z: number }[] = [];

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    const hud = this.hud;
    hud.mode = demo ? "title" : "playing";
    hud.demo = demo;
    hud.gold = 150;
    hud.castleHp = 100;
    hud.wave = 1;
    hud.selected = "ballista";
    hud.levels = { ballista: 1, cannon: 0, catapult: 0, arrows: 0 };
    hud.cooldowns = { ballista: 0, cannon: 0, catapult: 0, arrows: 0 };
    hud.traps = 0;
    this.traps.length = 0;
    this.queue.length = 0;
    this.queueAt = 0;
    this.time = 0;
    this.alive = 0;
    this.aiTimer = 0;
    this.ai.reset();
    this.random = mulberry(20260617);
    this.waves = new WaveDirector<V.EnemyType>({
      baseWaveSize: 2,
      growthPerWave: 3.2,
      maxWaveSize: 42,
      maxSpawnsPerStep: 50,
      unlock: [[1, "soldier"], [2, "shield"], [3, "ram"], [4, "flyer"], [5, "tower"], [8, "boss"]],
      weights: {
        soldier: (w) => Math.max(2, 12 - w),
        shield: 4,
        ram: (w) => 1.5 + w * 0.25,
        flyer: 2.5,
        tower: (w) => (w >= 5 ? 1.1 + w * 0.15 : 0),
        boss: (w) => (w === 8 ? 0.8 : w >= 10 ? 1.5 : 0),
      },
      autoStart: false,
      random: this.random,
    });
    this.retuneBolts();
    for (const key of WEAPON_ORDER) {
      const m = WEAPON_MOUNTS[key];
      this.mounts[key] = play.spawn(this.mountArch[key], m[0], m[1], m[2], 0);
    }
    this.banners.length = 0;
    for (const b of this.bannerSpots) this.banners.push(play.spawn(this.bannerArch, b.x, b.y, b.z, 0));
    this.reticleX = 0;
    this.reticleZ = -10;
    this.reticle = play.spawn(this.reticleArch, this.reticleX, 0, this.reticleZ, 0);
    play.fixedCamera(CAMERA_EYE, CAMERA_LOOK, CAMERA_FOV, 260);
    this.startWave();
  }

  say(text: string, frames = 144): void {
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

  private retuneBolts(): void {
    this.play.retune(this.bolts.ballista, { damage: weaponPower(this.hud.levels, "ballista").damage });
    if (this.hud.levels.arrows > 0) this.play.retune(this.bolts.arrows, { damage: weaponPower(this.hud.levels, "arrows").damage });
  }

  // --- the demo's actions -------------------------------------------------------

  has(key: WeaponKey): boolean {
    return this.hud.levels[key] > 0;
  }

  chooseWeapon(key: WeaponKey): void {
    if (this.has(key)) this.selectWeapon(key);
    else this.buyWeapon(key);
  }

  selectWeapon(key: WeaponKey): void {
    if (!this.has(key)) return;
    if (this.hud.selected !== key && !this.hud.demo) this.play.play(this.select, 0.5);
    this.hud.selected = key;
  }

  buyWeapon(key: WeaponKey): void {
    const weapon = WEAPONS[key];
    if (this.hud.gold < weapon.cost) return this.refuse(`${weapon.label} costs ${weapon.cost} gold`);
    this.hud.gold -= weapon.cost;
    this.hud.levels[key] = 1;
    this.hud.selected = key;
    this.retuneBolts();
    this.play.play(this.coin, 0.8);
    this.say(`${weapon.label} ready`);
  }

  upgradeSelected(): void {
    const key = this.hud.selected;
    if (!this.has(key)) return this.buyWeapon(key);
    const cost = upgradeCost(this.hud.levels, key);
    if (this.hud.gold < cost) return this.refuse(`Upgrade costs ${cost} gold`);
    this.hud.gold -= cost;
    this.hud.levels[key] += 1;
    this.retuneBolts();
    this.play.play(this.upgrade, 0.7);
    this.say(`${WEAPONS[key].label} upgraded to level ${this.hud.levels[key]}`);
  }

  repairCastle(): void {
    const hud = this.hud;
    if (hud.gold < REPAIR_COST) return this.refuse(`Repairs cost ${REPAIR_COST} gold`);
    if (hud.castleHp >= hud.castleMaxHp) return this.refuse("Castle is already repaired");
    hud.gold -= REPAIR_COST;
    hud.castleHp = Math.min(hud.castleMaxHp, hud.castleHp + 210);
    this.play.play(this.repair, 0.7);
    this.say("Masons repaired the castle");
  }

  placeTrap(): void {
    const hud = this.hud;
    if (hud.gold < TRAP_COST) return this.refuse(`Trap costs ${TRAP_COST} gold`);
    hud.gold -= TRAP_COST;
    const right = this.random.pick([-12, -6, 0, 6, 12]);
    const forward = this.random.uniform(2, 18);
    const slot = this.play.spawn(this.trapArch, right, 0.12, -forward, 0);
    this.traps.push({ slot, x: right, z: -forward });
    hud.traps = this.traps.length;
    this.playAt(this.placeSound, right, 0.2, -forward);
    this.say("Trap placed on the approach");
  }

  private refuse(text: string): void {
    if (!this.hud.demo) this.play.play(this.denied);
    this.say(text);
  }

  /** The demo's fireWeapon at a point on (or over) the field. */
  fire(key: WeaponKey, tx: number, ty: number, tz: number): boolean {
    const hud = this.hud;
    if (!this.has(key)) {
      this.buyWeapon(key);
      return false;
    }
    if (hud.cooldowns[key] > 0) return false;
    const spec = weaponPower(hud.levels, key);
    const m = WEAPON_MOUNTS[key];
    const lx = m[0], ly = m[1] + 1.1, lz = m[2];
    const dx = tx - lx, dz = tz - lz;
    if (dx * dx + dz * dz > spec.range * spec.range) {
      this.say("Target is out of range", 90);
      return false;
    }
    hud.cooldowns[key] = spec.cooldown;
    if (hud.demo) {
      // in the attract loop the ring shows where the autopilot aims
      this.reticleX = tx;
      this.reticleZ = tz;
    }
    const play = this.play;
    const ent = play.ent;
    play.burst(this.muzzle[key], lx, ly, lz);
    this.playAt(this.fireSound[key], lx, ly, lz);
    const dy = ty - ly;
    let vx: number, vy: number, vz: number;
    if (key === "ballista" || key === "arrows") {
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      vx = (dx / l) * spec.speed;
      vy = (dy / l) * spec.speed;
      vz = (dz / l) * spec.speed;
      const s = play.spawn(this.bolts[key], lx, ly, lz, Math.atan2(-dx, -dz));
      if (s >= 0) {
        ent[s * 16 + ENT.PITCH] = Math.asin(dy / l);
        ent[s * 16 + ENT.SPEED] = spec.speed;
      }
    } else {
      // createArcProjectile: the arc that lands in the demo's travel time
      const planar = Math.max(Math.sqrt(dx * dx + dz * dz), 1);
      const travel = Math.max(key === "catapult" ? 1.0 : 0.65, Math.min(key === "catapult" ? 2.25 : 1.45, planar / spec.speed));
      vx = dx / travel;
      vz = dz / travel;
      vy = (dy + 0.5 * GRAVITY * travel * travel) / travel;
      const s = play.spawn(this.shells[key], lx, ly, lz, 0);
      if (s >= 0) {
        const o = s * 16;
        ent[o + ENT.VX] = vx;
        ent[o + ENT.VY] = vy;
        ent[o + ENT.VZ] = vz;
        // the splash it carries, read back where it lands
        play.user[s * 8] = spec.damage;
        play.user[s * 8 + 1] = spec.splash;
      }
    }
    // the mount turns its front along the shot
    const o = this.mounts[key] * 16;
    ent[o + ENT.YAW] = Math.atan2(-vx, -vz);
    ent[o + ENT.PITCH] = Math.atan2(vy, Math.sqrt(vx * vx + vz * vz)) * 0.5;
    return true;
  }

  /** A shell's end: the demo's applySplash around the point. */
  private explode(shellSlot: number, x: number, y: number, z: number, direct: number): void {
    const play = this.play;
    const ent = play.ent;
    const list = play.list;
    const damage = play.user[shellSlot * 8];
    const splash = play.user[shellSlot * 8 + 1];
    const n = play.near(L.enemy, x, z, splash + 4);
    for (let i = 0; i < n; i++) {
      const s = list[i];
      if (!play.alive(s)) continue;
      const o = s * 16;
      const t = this.enemyIndex[ent[o + ENT.ARCH] - 1];
      if (t < 0) continue;
      const reach = splash + RADII[t];
      const dx = ent[o] - x, dy = ent[o + 1] - y, dz = ent[o + 2] - z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > reach) continue;
      const falloff = Math.max(0.25, Math.min(1, 1 - d / reach));
      this.damageEnemy(s, t, damage * falloff * (s === direct ? 1 : 0.82));
    }
    play.burst(this.splashBurst[splash > 5.5 ? 1 : 0], x, y, z);
    this.playAt(this.boomSound, x, y, z, 0.8);
  }

  private damageEnemy(slot: number, type: number, damage: number): void {
    const play = this.play;
    const o = slot * 16;
    const hp = play.ent[o + ENT.HP] - damage;
    play.ent[o + ENT.HP] = hp;
    if (hp <= 0) {
      // a guest kill is buried at once, before a step could report it
      play.kill(slot, "effects");
      this.hud.gold += REWARDS[type];
      this.alive -= 1;
    }
  }

  // --- the waves ------------------------------------------------------------------

  private startWave(): void {
    const w = this.waves;
    w.startWave(w.waveNumber);
    this.queue.length = 0;
    this.queueAt = 0;
    w.planSpawns(this.queue);
    this.spawnTimer = 0.25;
    this.hud.wave = w.waveNumber;
    if (w.waveNumber > 1) this.play.play(this.waveSound, 0.7);
    this.say(`Wave ${w.waveNumber}: ${w.unitsToSpawn} attackers incoming`);
  }

  private spawnFromQueue(dt: number): void {
    if (this.queueAt >= this.queue.length) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.createEnemy(this.queue[this.queueAt++], this.waves.waveNumber);
    this.spawnTimer = Math.max(0.32, Math.min(1.0, 1.0 - this.waves.waveNumber * 0.045));
  }

  private createEnemy(type: V.EnemyType, wave: number): void {
    const play = this.play;
    const stat = ENEMY_STATS[type];
    const lane = this.random.uniform(-22, 22);
    const forward = this.random.uniform(44, 56);
    const height = stat.flying ? this.random.uniform(8, 13) : stat.radius;
    const target = Math.abs(lane) < 6 ? 2 : lane < 0 ? 0 : 1;
    const t = CASTLE_TARGETS[target];
    const z = -forward;
    const slot = play.spawn(this.enemy[type], lane, height, z, Math.atan2(-(t[0] - lane), -(t[2] - z)));
    if (slot < 0) return;
    const o = slot * 16;
    const hp = stat.hp * (1 + (wave - 1) * 0.16);
    play.ent[o + ENT.HP] = hp;
    play.ent[o + ENT.HP_MAX] = hp;
    play.ent[o + ENT.SPEED] = stat.speed * (1 + Math.min(wave, 8) * 0.025);
    play.user[slot * 8] = target;
    this.alive += 1;
  }

  /** Every 2nd frame: arrivals at the castle, traps, the flyers' bob. */
  private march(): void {
    const play = this.play;
    const ent = play.ent;
    const list = play.list;
    const user = play.user;
    const index = this.enemyIndex;
    const traps = this.traps;
    const t4 = this.time * 4;
    const n = play.near(L.enemy, 0, 0, 400);
    for (let i = 0; i < n; i++) {
      const s = list[i];
      const o = s * 16;
      const type = index[ent[o + ENT.ARCH] - 1];
      if (type < 0) continue;
      const x = ent[o], z = ent[o + 2];
      const target = CASTLE_TARGETS[user[s * 8]];
      const dx = target[0] - x, dz = target[2] - z;
      if (dx * dx + dz * dz <= RADII[type] * RADII[type]) {
        this.damageCastle(DAMAGES[type]);
        play.burst(this.gateBurst, x, ent[o + 1], z);
        this.playAt(this.wallSound, x, ent[o + 1], z);
        play.kill(s, "silent");
        this.alive -= 1;
        continue;
      }
      if (type === FLYER) ent[o + 1] = 10 + Math.sin(t4 + ent[o + ENT.HP]) * 1.1;
      for (let k = 0; k < traps.length; k++) {
        const tr = traps[k];
        const ex = x - tr.x, ez = z - tr.z;
        if (ex * ex + ez * ez <= 3.2 * 3.2) {
          this.spring(k);
          break;
        }
      }
    }
    // the banners sway
    for (let i = 0; i < this.banners.length; i++) play.joints[this.banners[i] * 4] = Math.sin(this.time * 3.1 + i * 1.7) * 0.09;
  }

  /** A trap goes off: 115 to everything within 5 m on the ground plane. */
  private spring(k: number): void {
    const play = this.play;
    const ent = play.ent;
    const list = play.list;
    const trap = this.traps[k];
    this.traps.splice(k, 1);
    this.hud.traps = this.traps.length;
    play.kill(trap.slot, "silent");
    const n = play.near(L.enemy, trap.x, trap.z, 5);
    for (let i = 0; i < n; i++) {
      const s = list[i];
      if (!play.alive(s)) continue;
      const t = this.enemyIndex[ent[s * 16 + ENT.ARCH] - 1];
      if (t >= 0) this.damageEnemy(s, t, 115);
    }
    play.burst(this.trapBurst, trap.x, 0.3, trap.z);
    this.playAt(this.trapSound, trap.x, 0.3, trap.z);
  }

  private damageCastle(amount: number): void {
    const hud = this.hud;
    hud.castleHp = Math.max(0, hud.castleHp - amount);
    this.play.shake(0.25);
    if (hud.castleHp <= 0) this.end(false);
  }

  private end(victory: boolean): void {
    const hud = this.hud;
    if (hud.mode === "victory" || hud.mode === "defeat") return;
    hud.mode = victory ? "victory" : "defeat";
    this.play.play(victory ? this.win : this.lose, 0.8);
    this.say(victory ? "Victory. The castle survived the siege." : "Defeat. The castle defenses fell.", 1e9);
  }

  /** The demo's updateWaveProgress. */
  private waveProgress(alive: number): void {
    const w = this.waves;
    if (this.queueAt < this.queue.length || alive > 0 || !w.inProgress) return;
    w.completeIfDone(0);
    if (w.waveNumber > WAVE_LIMIT) {
      this.end(true);
      return;
    }
    this.hud.gold += 45 + w.waveNumber * 12;
    this.startWave();
  }

  /** One frame: the player's (or the autopilot's) actions, the field, the step. */
  frame(pad: Pad): void {
    const play = this.play;
    const dt = 1 / 60;
    const hud = this.hud;
    const live = hud.mode === "playing" || (hud.mode === "title" && hud.demo);
    if (this.messageFrames > 0 && --this.messageFrames === 0) this.message = "";
    if (live) {
      this.time += dt;
      for (let i = 0; i < WEAPON_ORDER.length; i++) {
        const k = WEAPON_ORDER[i];
        if (hud.cooldowns[k] > 0) hud.cooldowns[k] = Math.max(0, hud.cooldowns[k] - dt);
      }
      if (hud.demo) {
        this.aiTimer -= dt;
        if (this.aiTimer <= 0) {
          this.aiTimer = 0.14;
          this.ai.act(this);
        } else this.ai.step(this);
      } else this.input(pad, dt);
      this.spawnFromQueue(dt);
    }
    play.frame(dt);
    if (live && (play.tick & 1) === 0) this.march();
    // the march may have ended the siege
    if (hud.mode === "playing" || hud.mode === "title") this.waveProgress(this.alive);
    // the ring: where A will land, red when the selected weapon cannot reach
    const ent = play.ent;
    const r = this.reticle * 16;
    ent[r] = this.reticleX;
    ent[r + 2] = this.reticleZ;
    const m = WEAPON_MOUNTS[hud.selected];
    const dx = this.reticleX - m[0], dz = this.reticleZ - m[2];
    const range = WEAPONS[hud.selected].range;
    const ok = dx * dx + dz * dz <= range * range;
    const look = play.look;
    look[this.reticle * 4 + 2] = ok ? 1 : 0.25;
    look[this.reticle * 4 + 3] = ok ? 1 : 0.25;
  }

  private input(pad: Pad, dt: number): void {
    const held = pad.held;
    const pressed = pad.pressed;
    // the ring follows the Circle Pad; the D-Pad is for traps (screen right is -x)
    if ((held & DPAD) === 0) {
      this.reticleX = Math.max(-70, Math.min(70, this.reticleX - pad.x * 36 * dt));
      this.reticleZ = Math.max(-64, Math.min(30, this.reticleZ + pad.y * 36 * dt));
    }
    if (pressed & BTN_L) this.cycle(-1);
    if (pressed & BTN_R) this.cycle(1);
    if (pressed & BTN_X) this.upgradeSelected();
    if (pressed & BTN_B) this.repairCastle();
    if (pressed & BTN_DOWN) this.placeTrap();
    if (held & BTN_A) {
      const key = this.hud.selected;
      if (this.hud.cooldowns[key] <= 0) {
        const fired = this.fire(key, this.reticleX, 0, this.reticleZ);
        if (!fired && pressed & BTN_A) this.play.play(this.denied);
      }
    }
  }

  private cycle(step: number): void {
    const i = WEAPON_ORDER.indexOf(this.hud.selected);
    this.chooseWeapon(WEAPON_ORDER[(i + step + WEAPON_ORDER.length) % WEAPON_ORDER.length]);
  }

}

/** A sphere test against the fixed camera's frustum, for culling scenery at load. */
function cullFrustum(eye: readonly number[], look: readonly number[], fov: number, aspect: number, far: number) {
  const f = new THREE.Vector3(look[0] - eye[0], look[1] - eye[1], look[2] - eye[2]).normalize();
  const r = new THREE.Vector3(-f.z, 0, f.x).normalize();
  const u = new THREE.Vector3(r.y * f.z - r.z * f.y, r.z * f.x - r.x * f.z, r.x * f.y - r.y * f.x);
  const ty = Math.tan((fov * Math.PI) / 360);
  const tx = ty * aspect;
  const kx = Math.sqrt(1 + tx * tx);
  const ky = Math.sqrt(1 + ty * ty);
  return (x: number, y: number, z: number, radius: number): boolean => {
    const dx = x - eye[0], dy = y - eye[1], dz = z - eye[2];
    const depth = dx * f.x + dy * f.y + dz * f.z;
    if (depth + radius < 0.5 || depth - radius > far) return false;
    if (Math.abs(dx * r.x + dy * r.y + dz * r.z) - radius * kx > depth * tx) return false;
    return Math.abs(dx * u.x + dy * u.y + dz * u.z) - radius * ky <= depth * ty;
  };
}

const BTN_A = 0x2000;
const BTN_B = 0x4000;
const BTN_X = 0x1000;
const BTN_L = 0x0100;
const BTN_R = 0x0200;
const BTN_DOWN = 0x0040;
const DPAD = 0x00f0;
const RADII = ENEMY_TYPES.map((t) => ENEMY_STATS[t].radius);
const DAMAGES = ENEMY_TYPES.map((t) => ENEMY_STATS[t].damage);
const REWARDS = ENEMY_TYPES.map((t) => ENEMY_STATS[t].reward);
const FLYER = ENEMY_TYPES.indexOf("flyer");

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new CastleDefense();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  let overAt = -1;
  const ended = () => game.hud.mode === "victory" || game.hud.mode === "defeat";
  return {
    title: "Castle Defense",
    tagline: "Hold the castle through ten waves of invaders.\nShoot, upgrade weapons, repair walls and set traps.",
    accent: "#b8862f",
    controls: [
      ["Circle Pad", "Aim"],
      ["A  (hold)", "Fire the weapon"],
      ["L / R", "Choose weapon (buys it)"],
      ["X  /  B", "Upgrade  /  Repair"],
      ["D-Pad Down  ·  START", "Trap  ·  Pause"],
    ],
    readouts: [
      { label: "Castle", value: () => `${Math.round((game.hud.castleHp / game.hud.castleMaxHp) * 100)}%`, bar: () => game.hud.castleHp / game.hud.castleMaxHp, color: "#ff8a6a" },
      { label: "Wave", value: () => `${Math.min(game.hud.wave, WAVE_LIMIT)} / ${WAVE_LIMIT}` },
      { label: "Gold", value: () => Math.floor(game.hud.gold) },
      {
        label: "Weapon",
        value: () => `${WEAPONS[game.hud.selected].label} L${game.hud.levels[game.hud.selected]}`,
        bar: () => 1 - game.hud.cooldowns[game.hud.selected] / weaponPower(game.hud.levels, game.hud.selected).cooldown,
        color: "#f6c863",
      },
      { label: "Upgrade", value: () => `${upgradeCost(game.hud.levels, game.hud.selected)}g` },
      { label: "Traps set", value: () => game.hud.traps },
    ],
    play: game.play,
    status(): GameStatus {
      if (game.hud.mode === "title") return "title";
      if (ended()) return game.hud.demo ? "title" : "gameover";
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
      if (game.hud.demo && ended()) {
        if (overAt < 0) overAt = game.play.tick;
        else if (game.play.tick - overAt > 180) {
          overAt = -1;
          game.reset(true);
        }
      }
      if (paused) return;
      game.frame(pad);
    },
    topLine: () =>
      game.message ||
      `CASTLE ${Math.round((game.hud.castleHp / game.hud.castleMaxHp) * 100)}%    WAVE ${Math.min(game.hud.wave, WAVE_LIMIT)}/${WAVE_LIMIT}    GOLD ${Math.floor(game.hud.gold)}    ${WEAPONS[game.hud.selected].label.toUpperCase()}`,
    result: () =>
      game.hud.mode === "victory"
        ? `Victory: the castle held all ten waves · ${Math.floor(game.hud.gold)} gold left`
        : `Defeat: the invaders broke through at wave ${Math.min(game.hud.wave, WAVE_LIMIT)}`,
  };
}
